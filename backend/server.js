const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

let db;
let sessionsCollection;
let participantsCollection;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// MongoDB Connection
async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('gmeet-attendance');
    sessionsCollection = db.collection('sessions');
    participantsCollection = db.collection('participants');
    
    // Create indexes
    await sessionsCollection.createIndex({ tabId: 1 });
    await sessionsCollection.createIndex({ leaveTime: 1 });
    
    console.log('✓ Connected to MongoDB');
  } catch (error) {
    console.error('✗ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Routes

// Save or update session
app.post('/api/sessions', async (req, res) => {
  try {
    const session = req.body;
    const result = await sessionsCollection.updateOne(
      { id: session.id },
      { $set: session },
      { upsert: true }
    );
    res.json({ status: 'ok', result });
  } catch (error) {
    console.error('Error saving session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get active sessions (not ended)
app.get('/api/sessions/active', async (req, res) => {
  try {
    const sessions = await sessionsCollection
      .find({ leaveTime: null })
      .toArray();
    res.json({ sessions });
  } catch (error) {
    console.error('Error fetching active sessions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all sessions (with pagination)
app.get('/api/sessions', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const sessions = await sessionsCollection
      .find({})
      .sort({ joinTime: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await sessionsCollection.countDocuments();

    res.json({
      sessions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single session
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await sessionsCollection.findOne({ id: req.params.id });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ session });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear all sessions
app.delete('/api/sessions', async (req, res) => {
  try {
    const result = await sessionsCollection.deleteMany({});
    res.json({ status: 'ok', deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error clearing sessions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export sessions as JSON
app.get('/api/export', async (req, res) => {
  try {
    const sessions = await sessionsCollection.find({}).toArray();
    res.json({ data: sessions });
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
async function start() {
  await connectDB();
  
  app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ Database: ${MONGODB_URI}`);
  });
}

start().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
