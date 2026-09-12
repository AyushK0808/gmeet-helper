const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const { computeAttendance } = require('./lib/match');
const { generateMinutes } = require('./lib/llm');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const EXTENSION_TOKEN = process.env.EXTENSION_TOKEN;
const EXTENSION_ORIGIN = process.env.EXTENSION_ORIGIN;

let db;
let sessionsCollection;
let rostersCollection;
let transcriptsCollection;
let minutesCollection;

if (!EXTENSION_TOKEN) {
  console.warn('⚠ EXTENSION_TOKEN is not set - /api/* routes are unauthenticated. Set it in backend/.env.');
}

// Middleware
app.use(cors({
  origin: EXTENSION_ORIGIN || false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'X-Extension-Token']
}));
app.use(express.json());

// Shared-secret auth for every /api/* route. /health stays open for uptime checks.
app.use('/api', (req, res, next) => {
  if (!EXTENSION_TOKEN) {
    // No token configured yet (fresh dev setup) - allow through but warn above.
    return next();
  }
  if (req.get('X-Extension-Token') !== EXTENSION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// MongoDB Connection
async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('gmeet-attendance');
    sessionsCollection = db.collection('sessions');
    rostersCollection = db.collection('rosters');
    transcriptsCollection = db.collection('transcripts');
    minutesCollection = db.collection('minutes');

    // Create indexes
    await sessionsCollection.createIndex({ tabId: 1 });
    await sessionsCollection.createIndex({ leaveTime: 1 });
    await rostersCollection.createIndex({ meetCodes: 1 });
    await transcriptsCollection.createIndex({ sessionId: 1 }, { unique: true });
    await minutesCollection.createIndex({ sessionId: 1 }, { unique: true });

    console.log('✓ Connected to MongoDB');
  } catch (error) {
    console.error('✗ MongoDB connection error:', error);
    process.exit(1);
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────────

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

// ─── Rosters ──────────────────────────────────────────────────────────────

function normalizeRosterBody(body) {
  return {
    name: body.name || 'Untitled roster',
    meetCodes: Array.isArray(body.meetCodes) ? body.meetCodes : [],
    members: Array.isArray(body.members)
      ? body.members.map((m) => ({
          name: m.name || '',
          email: m.email || '',
          aliases: Array.isArray(m.aliases) ? m.aliases : []
        }))
      : [],
    attendanceThresholdPct: typeof body.attendanceThresholdPct === 'number' ? body.attendanceThresholdPct : 50,
    autoSend: !!body.autoSend
  };
}

app.get('/api/rosters', async (req, res) => {
  try {
    const rosters = await rostersCollection.find({}).sort({ name: 1 }).toArray();
    res.json({ rosters });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/rosters/by-meet/:meetCode', async (req, res) => {
  try {
    const roster = await rostersCollection.findOne({ meetCodes: req.params.meetCode });
    res.json({ roster: roster || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rosters', async (req, res) => {
  try {
    const doc = {
      ...normalizeRosterBody(req.body),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const result = await rostersCollection.insertOne(doc);
    res.json({ status: 'ok', roster: { ...doc, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/rosters/:id', async (req, res) => {
  try {
    const update = { ...normalizeRosterBody(req.body), updatedAt: Date.now() };
    await rostersCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: update }
    );
    const roster = await rostersCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.json({ status: 'ok', roster });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/rosters/:id', async (req, res) => {
  try {
    await rostersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign an observed "unknown" participant name as an alias of a roster
// member, so future sessions match them automatically.
app.post('/api/rosters/:id/aliases', async (req, res) => {
  try {
    const { memberIndex, alias } = req.body;
    if (typeof memberIndex !== 'number' || !alias) {
      return res.status(400).json({ error: 'memberIndex and alias are required' });
    }

    const roster = await rostersCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!roster) {
      return res.status(404).json({ error: 'Roster not found' });
    }
    if (!roster.members[memberIndex]) {
      return res.status(400).json({ error: 'Invalid memberIndex' });
    }

    roster.members[memberIndex].aliases = roster.members[memberIndex].aliases || [];
    if (!roster.members[memberIndex].aliases.includes(alias)) {
      roster.members[memberIndex].aliases.push(alias);
    }

    await rostersCollection.updateOne(
      { _id: roster._id },
      { $set: { members: roster.members, updatedAt: Date.now() } }
    );

    res.json({ status: 'ok', roster });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Transcript ───────────────────────────────────────────────────────────

// Append transcript lines for a session, de-duplicated by seq so a retried
// chunk from the extension is harmless.
app.post('/api/sessions/:id/transcript', async (req, res) => {
  try {
    const { lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.json({ status: 'ok', added: 0 });
    }

    const existing = await transcriptsCollection.findOne({ sessionId: req.params.id });
    const existingSeqs = new Set((existing?.lines || []).map((l) => l.seq));
    const newLines = lines.filter((l) => !existingSeqs.has(l.seq));

    await transcriptsCollection.updateOne(
      { sessionId: req.params.id },
      {
        $push: { lines: { $each: newLines } },
        $setOnInsert: { sessionId: req.params.id }
      },
      { upsert: true }
    );

    res.json({ status: 'ok', added: newLines.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/transcript', async (req, res) => {
  try {
    const doc = await transcriptsCollection.findOne({ sessionId: req.params.id });
    const lines = (doc?.lines || []).sort((a, b) => a.seq - b.seq);
    res.json({ lines });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Report (session + roster + attendance + minutes + transcript) ────────

app.get('/api/sessions/:id/report', async (req, res) => {
  try {
    const session = await sessionsCollection.findOne({ id: req.params.id });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const [roster, transcriptDoc, minutesDoc] = await Promise.all([
      rostersCollection.findOne({ meetCodes: session.meetCode }),
      transcriptsCollection.findOne({ sessionId: session.id }),
      minutesCollection.findOne({ sessionId: session.id })
    ]);

    const transcript = (transcriptDoc?.lines || []).sort((a, b) => a.seq - b.seq);
    const attendance = roster ? computeAttendance(roster, session) : null;

    res.json({
      report: {
        session,
        roster: roster || null,
        attendance,
        transcript,
        minutes: minutesDoc || null
      }
    });
  } catch (error) {
    console.error('Error building report:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Minutes ──────────────────────────────────────────────────────────────

app.post('/api/sessions/:id/minutes', async (req, res) => {
  try {
    const regenerate = req.query.regenerate === 'true';

    if (!regenerate) {
      const existing = await minutesCollection.findOne({ sessionId: req.params.id });
      if (existing) {
        return res.json({ status: 'ok', minutes: existing });
      }
    }

    const session = await sessionsCollection.findOne({ id: req.params.id });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const [roster, transcriptDoc] = await Promise.all([
      rostersCollection.findOne({ meetCodes: session.meetCode }),
      transcriptsCollection.findOne({ sessionId: session.id })
    ]);

    const transcript = (transcriptDoc?.lines || []).sort((a, b) => a.seq - b.seq);
    const rosterMemberNames = (roster?.members || []).map((m) => m.name);

    const generated = await generateMinutes({ session, transcript, rosterMemberNames });

    const doc = {
      sessionId: req.params.id,
      ...generated,
      generatedAt: Date.now()
    };

    await minutesCollection.updateOne(
      { sessionId: req.params.id },
      { $set: doc },
      { upsert: true }
    );

    res.json({ status: 'ok', minutes: doc });
  } catch (error) {
    console.error('Error generating minutes:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/minutes', async (req, res) => {
  try {
    const minutes = await minutesCollection.findOne({ sessionId: req.params.id });
    if (!minutes) {
      return res.status(404).json({ error: 'Minutes not generated yet' });
    }
    res.json({ minutes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Persist human edits made in the popup before sending.
app.patch('/api/sessions/:id/minutes', async (req, res) => {
  try {
    const { minutes } = req.body;
    if (!minutes) {
      return res.status(400).json({ error: 'minutes is required' });
    }

    await minutesCollection.updateOne(
      { sessionId: req.params.id },
      { $set: { ...minutes, sessionId: req.params.id, editedAt: Date.now() } },
      { upsert: true }
    );

    const updated = await minutesCollection.findOne({ sessionId: req.params.id });
    res.json({ status: 'ok', minutes: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Email send record (duplicate-send guard) ──────────────────────────────

app.post('/api/sessions/:id/email-sent', async (req, res) => {
  try {
    const session = await sessionsCollection.findOne({ id: req.params.id });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.emailSentAt && req.query.force !== 'true') {
      return res.status(409).json({
        error: 'Minutes were already emailed for this session. Pass ?force=true to resend.',
        emailSentAt: session.emailSentAt
      });
    }

    const { recipients, gmailMessageId } = req.body;
    await sessionsCollection.updateOne(
      { id: req.params.id },
      { $set: { emailSentAt: Date.now(), emailRecipients: recipients || [], gmailMessageId: gmailMessageId || null } }
    );

    res.json({ status: 'ok' });
  } catch (error) {
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
    console.log('✓ Database connected');
  });
}

start().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
