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
    // A table for the main project/map plan
    await client.query(`
      CREATE TABLE IF NOT EXISTS project (
        id VARCHAR(50) PRIMARY KEY,
        plan_data_url TEXT,
        plan_width NUMERIC,
        plan_height NUMERIC
      );
    `);
    // The table for points, linked to a project
    await client.query(`
      CREATE TABLE IF NOT EXISTS points (
        id VARCHAR(255) PRIMARY KEY,
        project_id VARCHAR(50) REFERENCES project(id),
        properties JSONB,
        geometry JSONB
      );
    `);
    // Ensure our single default project exists
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

// GET /api/project - Fetch the project plan and all its points
app.get('/api/project', async (req, res) => {
  try {
    const client = await pool.connect();
    // Get project plan
    const projectRes = await client.query("SELECT * FROM project WHERE id = 'default'");
    const project = projectRes.rows[0];

    // Get all points for the project
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

// POST /api/project/plan - Update the project's plan
app.post('/api/project/plan', async (req, res) => {
    const { planDataUrl, width, height } = req.body;
    try {
        const client = await pool.connect();
        await client.query(
            'UPDATE project SET plan_data_url = $1, plan_width = $2, plan_height = $3 WHERE id = $4',
            [planDataUrl, width, height, 'default']
        );
        // Also delete all old points when a new plan is uploaded
        await client.query("DELETE FROM points WHERE project_id = 'default'");
        client.release();
        broadcast({ type: 'plan_update', payload: { project: { id: 'default', plan_data_url: planDataUrl, plan_width: width, plan_height: height }, geojsonData: { type: 'FeatureCollection', features: [] } } });
        res.status(200).json({ message: 'Plan updated' });
    } catch (err) {
        console.error('Error updating plan', err.stack);
        res.status(500).send('Server Error');
    }
});


// POST /api/points - Create or update a point
app.post('/api/points', async (req, res) => {
  const { id, properties, geometry } = req.body;
  const propertiesToStore = { ...properties };
  delete propertiesToStore.id;

  const query = `
    INSERT INTO points (id, project_id, properties, geometry)
    VALUES($1, 'default', $2, $3)
    ON CONFLICT (id) 
    DO UPDATE SET properties = $2, geometry = $3;
  `;
  
  try {
    const client = await pool.connect();
    await client.query(query, [id, propertiesToStore, geometry]);
    client.release();
    
    broadcast({ type: 'point_update', payload: req.body });
    res.status(200).json({ message: 'Point saved' });
  } catch (err) {
    console.error('Error saving point', err.stack);
    res.status(500).send('Server Error');
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
        res.status(500).send('Server Error');
    }
});

// POST /api/project/import - Overwrite project with imported data
app.post('/api/project/import', async (req, res) => {
    const { project, geojsonData } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction
        // Update plan
        await client.query(
            'UPDATE project SET plan_data_url = $1, plan_width = $2, plan_height = $3 WHERE id = $4',
            [project.plan_data_url, project.plan_width, project.plan_height, 'default']
        );
        // Clear old points
        await client.query("DELETE FROM points WHERE project_id = 'default'");
        // Insert new points
        for (const feature of geojsonData.features) {
            const { id, ...properties } = feature.properties;
            await client.query(
                'INSERT INTO points (id, project_id, properties, geometry) VALUES ($1, $2, $3, $4)',
                [id, 'default', properties, feature.geometry]
            );
        }
        await client.query('COMMIT'); // Commit transaction
        broadcast({ type: 'project_import', payload: req.body });
        res.status(200).json({ message: 'Project imported successfully' });
    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
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

