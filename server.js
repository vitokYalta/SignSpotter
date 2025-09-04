// --- IMPORTS ---
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

// --- INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, 'public')));
// Increased limit to 50mb to handle large SVG/PDF data in JSON payloads
app.use(express.json({ limit: '50mb' })); 

// --- DATABASE SETUP ---
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // 1. Create project table with new columns for schema and plan transformation
    await client.query(`
      CREATE TABLE IF NOT EXISTS project (
        id VARCHAR(50) PRIMARY KEY,
        plan_data_url TEXT,
        plan_width NUMERIC,
        plan_height NUMERIC,
        point_schema JSONB,
        plan_corners JSONB
      );
    `);

    // 2. Create points table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS points (
        id VARCHAR(255) PRIMARY KEY,
        properties JSONB,
        geometry JSONB
      );
    `);

    // 3. **MIGRATION**: Check and add 'project_id' column to 'points' table if needed
    const columnCheck = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='points' AND column_name='project_id'
    `);
    if (columnCheck.rowCount === 0) {
        console.log('Column "project_id" not found. Adding it...');
        await client.query(`
            ALTER TABLE points 
            ADD COLUMN project_id VARCHAR(50) REFERENCES project(id) ON DELETE CASCADE;
        `);
        console.log('Column "project_id" added.');
    }
    
    // 4. **MIGRATION**: Check and add new columns to 'project' table
    const projectColumns = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='project' AND column_name IN ('point_schema', 'plan_corners')
    `);
    if (projectColumns.rowCount < 2) {
        console.log('Project table is outdated. Adding new columns...');
        await client.query(`ALTER TABLE project ADD COLUMN IF NOT EXISTS point_schema JSONB;`);
        await client.query(`ALTER TABLE project ADD COLUMN IF NOT EXISTS plan_corners JSONB;`);
        console.log('Project table updated.');
    }


    // 5. Ensure our single default project exists
    await client.query(`
        INSERT INTO project (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
    `);
    
    console.log('Database tables are ready.');
  } catch (err) {
    console.error('Error initializing database tables', err.stack);
  } finally {
    client.release();
  }
}

// --- API ENDPOINTS ---

// GET /api/project - Fetch all project data
app.get('/api/project', async (req, res) => {
  try {
    const client = await pool.connect();
    const projectRes = await client.query("SELECT * FROM project WHERE id = 'default'");
    const project = projectRes.rows[0];
    const pointsRes = await client.query("SELECT id, properties, geometry FROM points WHERE project_id = 'default'");
    client.release();
    
    const geoJson = {
      type: "FeatureCollection",
      features: pointsRes.rows.map(row => ({
        type: "Feature",
        properties: { ...row.properties, id: row.id },
        geometry: row.geometry
      }))
    };
    
    res.json({ project, geojsonData: geoJson });
  } catch (err) {
    console.error('Error fetching project', err.stack);
    res.status(500).send('Server Error');
  }
});

// POST /api/project/plan - Upload a new plan image, resets points
app.post('/api/project/plan', async (req, res) => {
    const { planDataUrl, width, height } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Reset plan image, dimensions, and corners, but keep the schema
        await client.query(
            'UPDATE project SET plan_data_url = $1, plan_width = $2, plan_height = $3, plan_corners = NULL WHERE id = $4',
            [planDataUrl, width, height, 'default']
        );
        await client.query("DELETE FROM points WHERE project_id = 'default'");
        await client.query('COMMIT');
        
        const updatedProject = { plan_data_url: planDataUrl, plan_width: width, plan_height: height, plan_corners: null };
        broadcast({ type: 'plan_update', payload: { project: updatedProject, geojsonData: { type: 'FeatureCollection', features: [] } } });
        res.status(200).json({ message: 'Plan updated' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating plan', err.stack);
        res.status(500).send('Server Error: ' + err.message);
    } finally {
        client.release();
    }
});

// POST /api/project/settings - Update project settings like schema and plan position
app.post('/api/project/settings', async (req, res) => {
    const { point_schema, plan_corners } = req.body;
    
    // Build query dynamically based on what's provided
    let updates = [];
    let values = [];
    let counter = 1;

    if (point_schema) {
        updates.push(`point_schema = $${counter++}`);
        values.push(point_schema);
    }
    if (plan_corners) {
        updates.push(`plan_corners = $${counter++}`);
        values.push(plan_corners);
    }

    if (updates.length === 0) {
        return res.status(400).send("No settings provided to update.");
    }
    
    values.push('default'); // for WHERE id = ...

    const query = `UPDATE project SET ${updates.join(', ')} WHERE id = $${counter}`;

    try {
        const client = await pool.connect();
        await client.query(query, values);
        client.release();

        broadcast({ type: 'settings_update', payload: req.body });
        res.status(200).json({ message: "Settings updated" });
    } catch (err) {
        console.error('Error updating settings', err.stack);
        res.status(500).send('Server Error: ' + err.message);
    }
});


// POST /api/points - Create or update a point
app.post('/api/points', async (req, res) => {
  const featureId = req.body.properties.id;
  const propertiesToStore = { ...req.body.properties };
  delete propertiesToStore.id;

  const query = `
    INSERT INTO points (id, project_id, properties, geometry)
    VALUES($1, 'default', $2, $3)
    ON CONFLICT (id) 
    DO UPDATE SET properties = $2, geometry = $3;
  `;
  
  try {
    const client = await pool.connect();
    await client.query(query, [featureId, propertiesToStore, req.body.geometry]);
    client.release();
    
    broadcast({ type: 'point_update', payload: req.body });
    res.status(200).json({ message: 'Point saved' });
  } catch (err) {
    console.error('Error saving point', err.stack);
    res.status(500).send('Server Error: ' + err.message);
  }
});

// DELETE /api/points/:id - Delete a point
app.delete('/api/points/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const client = await pool.connect();
        await client.query('DELETE FROM points WHERE id = $1', [id]);
        client.release();
        broadcast({ type: 'point_delete', payload: { id } });
        res.status(200).json({ message: 'Point deleted' });
    } catch (err) {
        console.error('Error deleting point', err.stack);
        res.status(500).send('Server Error: ' + err.message);
    }
});

// POST /api/project/import - Overwrite project with imported data
app.post('/api/project/import', async (req, res) => {
    const { project, geojsonData } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'UPDATE project SET plan_data_url = $1, plan_width = $2, plan_height = $3, point_schema = $4, plan_corners = $5 WHERE id = $6',
            [project.plan_data_url, project.plan_width, project.plan_height, project.point_schema, project.plan_corners, 'default']
        );
        await client.query("DELETE FROM points WHERE project_id = 'default'");
        if (geojsonData && geojsonData.features) {
            for (const feature of geojsonData.features) {
                const { id, ...properties } = feature.properties;
                await client.query(
                    'INSERT INTO points (id, project_id, properties, geometry) VALUES ($1, $2, $3, $4)',
                    [id, 'default', properties, feature.geometry]
                );
            }
        }
        await client.query('COMMIT');
        broadcast({ type: 'project_import', payload: req.body });
        res.status(200).json({ message: 'Project imported successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error importing project', err.stack);
        res.status(500).send('Server Error: ' + err.message);
    } finally {
        client.release();
    }
});


// --- WEBSOCKET REAL-TIME COMMUNICATION ---
wss.on('connection', ws => {
  console.log('Client connected');
  ws.on('close', () => console.log('Client disconnected'));
});

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

// --- SERVER START ---
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
  initializeDatabase();
});

