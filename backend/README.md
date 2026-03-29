# GMeet Attendance Tracker - Backend Setup

This backend server stores Google Meet attendance data in MongoDB.

## Prerequisites

- **Node.js** (v14 or higher)
- **MongoDB** (local or cloud instance like MongoDB Atlas)
- **npm** (comes with Node.js)

## Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**

Create a `.env` file in this directory:

```bash
cp .env.example .env
```

Then edit `.env` and add your MongoDB URI:

```
MONGODB_URI=mongodb://localhost:27017/gmeet-attendance
PORT=3000
```

### MongoDB URI Examples

**Local MongoDB:**
```
mongodb://localhost:27017/gmeet-attendance
```

**MongoDB Atlas (Cloud):**
```
mongodb+srv://username:password@cluster.mongodb.net/gmeet-attendance?retryWrites=true&w=majority
```

## Running the Server

### Development (with auto-reload):
```bash
npm run dev
```

### Production:
```bash
npm start
```

The server will start on `http://localhost:3000`

## API Endpoints

### Get all sessions
```
GET /api/sessions?page=1&limit=50
```

### Get active sessions (not ended)
```
GET /api/sessions/active
```

### Get single session
```
GET /api/sessions/:id
```

### Save/Update session
```
POST /api/sessions
Content-Type: application/json

{
  "id": "meet_...",
  "meetCode": "abc-defg-hij",
  "meetUrl": "https://...",
  "title": "Some Meeting",
  "joinTime": 1234567890,
  "leaveTime": null,
  "participants": {...}
}
```

### Clear all sessions
```
DELETE /api/sessions
```

### Export all data
```
GET /api/export
```

### Health check
```
GET /health
```

## Extension Configuration

In the Chrome extension (`background.js`), update the `BACKEND_URL`:

```javascript
const BACKEND_URL = 'http://localhost:3000';
```

If running the backend on a different machine, use its IP/hostname instead:
```javascript
const BACKEND_URL = 'http://192.168.1.100:3000';
```

## Troubleshooting

### "Cannot connect to MongoDB"
- Ensure MongoDB is running (`mongod` command or MongoDB service)
- Check your `MONGODB_URI` in `.env`
- Verify database credentials if using MongoDB Atlas

### "Extension context invalidated"
- Reload the extension in Chrome (`chrome://extensions`)
- Make sure the backend is running
- Check network connectivity between extension and backend

### History page not showing
- Open browser DevTools (F12) → Extensions tab
- Check Service Worker console for errors
- Look at Network tab to see if requests to `/api/sessions` are succeeding
- Verify the backend is responding at `http://localhost:3000/health`

## Development Tips

- Frontend logs are in the extension popup console (F12)
- Backend logs are in the terminal where you ran `npm start`
- Use MongoDB Compass to view data: `mongodb://localhost:27017`
- Clear extension storage: Settings → Extensions → GMeet Tracker → Storage → Clear data

## Docker (Optional)

To run MongoDB in Docker:
```bash
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

Then use:
```
MONGODB_URI=mongodb://localhost:27017/gmeet-attendance
```
