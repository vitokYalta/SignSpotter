const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE INITIALIZATION ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TABLE IF NOT EXISTS project (
                id TEXT PRIMARY KEY,
                plan_data_url TEXT,
                plan_corners JSONB,
                point_schema JSONB,
                opacity REAL DEFAULT 0.7
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS points (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES project(id),
                properties JSONB,
                geometry JSONB
            );
        `);
        const columns = await client.query(`
            SELECT column_name FROM information_schema.columns WHERE table_name = 'project';
        `);
        const colNames = columns.rows.map(r => r.column_name);
        if (!colNames.includes('opacity')) {
            await client.query('ALTER TABLE project ADD COLUMN opacity REAL DEFAULT 0.7;');
        }
        const res = await client.query("SELECT id FROM project WHERE id = 'default'");
        if (res.rowCount === 0) {
            await client.query("INSERT INTO project (id, point_schema) VALUES ('default', '[]'::jsonb)");
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error initializing database:', err);
        throw err;
    } finally {
        client.release();
    }
}

initializeDatabase().catch(e => console.error(e.stack));

// --- PAGE ROUTING ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});

app.get('/plan-editor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'plan_editor.html'));
});

app.get('/map-positioner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'map_positioner.html'));
});

// --- WEBSOCKET BROADCASTING ---
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// --- API ENDPOINTS ---

app.get('/api/project', async (req, res) => {
    const client = await pool.connect();
    try {
        const projectRes = await client.query("SELECT * FROM project WHERE id = 'default'");
        const pointsRes = await client.query("SELECT id, properties, geometry FROM points WHERE project_id = 'default'");
        
        const projectData = projectRes.rows[0] || { id: 'default', point_schema: [] };
        const geojsonData = {
            type: "FeatureCollection",
            features: pointsRes.rows.map(p => ({
                type: "Feature",
                properties: { ...p.properties, id: p.id },
                geometry: p.geometry
            }))
        };
        res.json({ project: projectData, geojsonData });
    } catch (err) {
        console.error('Error fetching project:', err);
        res.status(500).json({ message: "Error fetching project data." });
    } finally {
        client.release();
    }
});

app.post('/api/project/settings', async (req, res) => {
    const { point_schema, plan_corners, opacity } = req.body;
    const client = await pool.connect();
    try {
        let query = 'UPDATE project SET';
        const values = [];
        let valueIndex = 1;

        if (point_schema) {
            query += ` point_schema = $${valueIndex++}`;
            values.push(JSON.stringify(point_schema));
        }
        if (plan_corners) {
            if (values.length > 0) query += ',';
            query += ` plan_corners = $${valueIndex++}`;
            values.push(JSON.stringify(plan_corners));
        }
        if (opacity !== undefined) {
             if (values.length > 0) query += ',';
            query += ` opacity = $${valueIndex++}`;
            values.push(opacity);
        }
        query += " WHERE id = 'default'";
        if (values.length > 0) {
            await client.query(query, values);
        }
        res.sendStatus(200);
        broadcast({ type: 'settings_update' });
    } catch (err) {
        console.error('Error saving settings:', err);
        res.status(500).json({ message: "Error saving project settings." });
    } finally {
        client.release();
    }
});

app.post('/api/project/plan', async (req, res) => {
    const { planDataUrl } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM points WHERE project_id = 'default'");
        await client.query(
            "UPDATE project SET plan_data_url = $1, plan_corners = NULL WHERE id = 'default'",
            [planDataUrl]
        );
        await client.query('COMMIT');
        res.sendStatus(200);
        broadcast({ type: 'plan_update' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error processing plan:', err);
        res.status(500).json({ message: 'Server failed to process the plan.', error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/points', async (req, res) => {
    const { properties, geometry } = req.body;
    const { id, ...otherProps } = properties;
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO points (id, project_id, properties, geometry)
            VALUES ($1, 'default', $2, $3)
            ON CONFLICT (id) DO UPDATE SET
                properties = $2,
                geometry = $3;
        `;
        await client.query(query, [id, otherProps, geometry]);
        res.status(201).json(req.body);
        broadcast({ type: 'point_update', payload: req.body });
    } catch (err) {
        console.error('Error saving point:', err);
        res.status(500).json({ message: "Error saving point." });
    } finally {
        client.release();
    }
});

app.delete('/api/points/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query("DELETE FROM points WHERE id = $1 AND project_id = 'default'", [id]);
        res.sendStatus(204);
        broadcast({ type: 'point_delete', payload: { id } });
    } catch(err) {
        console.error('Error deleting point:', err);
        res.status(500).json({ message: "Error deleting point." });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

