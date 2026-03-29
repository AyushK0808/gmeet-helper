# GMeet Attendance Tracker - Setup Guide

## Quick Start

### 1. Set Up MongoDB Backend

**Option A: Local MongoDB**
```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env and ensure:
# MONGODB_URI=mongodb://localhost:27017/gmeet-attendance
# PORT=3000

# Run the server
npm start
```

Server will be available at: `http://localhost:3000`

**Option B: MongoDB Atlas (Cloud)**
1. Go to https://www.mongodb.com/cloud/atlas
2. Create a free account and cluster
3. Get your connection string (looks like: `mongodb+srv://user:pass@cluster.mongodb.net/...`)
4. Paste it in `backend/.env`:
```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/gmeet-attendance
```

### 2. Configure Chrome Extension

The extension already points to `http://localhost:3000` by default.

If you're running the backend on a different machine, edit `background.js`:
```javascript
const BACKEND_URL = 'http://your-server-ip:3000';
```

### 3. Reload Extension

1. Go to `chrome://extensions`
2. Find "GMeet Attendance Tracker"
3. Click the 🔄 reload button

### 4. Test It

1. Join a Google Meet
2. Click the extension icon
3. You should see the active meeting
4. Click "History" tab - it should now load from MongoDB

## File Structure

```
gmeet-helper/
├── background.js          (Extension service worker)
├── content.js            (Meet page detector)
├── popup.js              (Popup UI logic)
├── popup.html            (Popup interface)
├── manifest.json         (Extension config)
├── icons/                (Extension icons)
└── backend/              (Node.js/MongoDB server)
    ├── server.js         (Main backend file)
    ├── package.json      (Dependencies)
    ├── .env              (Configuration)
    ├── .env.example      (Example config)
    └── README.md         (Backend setup guide)
```

## Data Flow

```
Google Meet Page
      ↓ (content.js detects join/leave)
Extension Service Worker (background.js)
      ↓ (saves session to)
MongoDB Backend (server.js)
      ↓ (stores in)
MongoDB Database
      ↓ (popup.js fetches from)
Popup UI
```

## Troubleshooting

### History tab shows "No History Yet"
1. Make sure backend is running: `npm start` in `/backend`
2. Check backend is accessible: Visit `http://localhost:3000/health` in browser
3. Check browser DevTools (F12) for console errors

### "Extension context invalidated" errors
1. Reload extension at `chrome://extensions`
2. Check browser console for network errors
3. Ensure backend server is running

### MongoDB connection fails
1. Check `MONGODB_URI` in `backend/.env`
2. For local: Ensure `mongod` is running
3. For Atlas: Check username/password and IP whitelist

### Data not persisting
1. Verify MongoDB is running
2. Check extension storage: `chrome://extensions` → GMeet Tracker → Details → Storage
3. Check backend server is responding to POST requests

## Support

- Extension logs: Extension popup Developer Tools (F12)
- Backend logs: Terminal where `npm start` is running
- MongoDB: Use MongoDB Compass to inspect database

Happy tracking! 📊
