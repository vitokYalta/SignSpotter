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
// Render provides a DATABASE_URL environment variable.
// We use it to connect to our PostgreSQL database.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Render's database connections
  }
});

// --- MIDDLEWARE ---
// Serve static files (our index.html, css, etc.) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// Parse JSON bodies for POST/PUT requests
app.use(express.json({ limit: '10mb' })); // Increased limit for base64 images

// --- DATABASE SETUP ---
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS points (
        id VARCHAR(255) PRIMARY KEY,
        properties JSONB,
        geometry JSONB
      );
    `);
    console.log('Database table "points" is ready.');
  } catch (err) {
    console.error('Error initializing database table', err.stack);
  } finally {
    client.release();
  }
}

// --- API ENDPOINTS ---

// GET /api/points - Fetch all points from the database
app.get('/api/points', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT id, properties, geometry FROM points');
    client.release();
    // Format the data into a GeoJSON FeatureCollection
    const geoJson = {
      type: "FeatureCollection",
      features: result.rows.map(row => ({
        type: "Feature",
        properties: { ...row.properties, id: row.id },
        geometry: row.geometry
      }))
    };
    res.json(geoJson);
  } catch (err) {
    console.error('Error fetching points', err.stack);
    res.status(500).send('Server Error');
  }
});

// POST /api/points - Create or update a point
app.post('/api/points', async (req, res) => {
  const { id, properties, geometry } = req.body;
  // Don't store the ID inside the properties JSONB
  const propertiesToStore = { ...properties };
  delete propertiesToStore.id;

  const query = `
    INSERT INTO points (id, properties, geometry)
    VALUES($1, $2, $3)
    ON CONFLICT (id) 
    DO UPDATE SET properties = $2, geometry = $3;
  `;
  
  try {
    const client = await pool.connect();
    await client.query(query, [id, propertiesToStore, geometry]);
    client.release();
    
    // Broadcast the change to all connected clients
    broadcast({ type: 'update', payload: req.body });
    
    res.status(200).json({ message: 'Point saved successfully' });
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

        // Broadcast the deletion to all connected clients
        broadcast({ type: 'delete', payload: { id } });

        res.status(200).json({ message: 'Point deleted successfully' });
    } catch (err) {
        console.error('Error deleting point', err.stack);
        res.status(500).send('Server Error');
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
