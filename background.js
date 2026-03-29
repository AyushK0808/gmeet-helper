// Background Service Worker - GMeet Attendance Tracker

let activeSessions = {};

const BACKEND_URL = 'http://localhost:3000';
const PARTICIPANT_LEAVE_GRACE_MS = 10000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const isPopup = sender.url?.includes('popup.html');

  console.log('[Background] Message received:', {
    type: message.type,
    tabId,
    isPopup,
    activeSessions: Object.keys(activeSessions),
    senderUrl: sender.url
  });

  switch (message.type) {
    case 'MEET_JOINED':
      handleMeetJoined(tabId, message.data);
      sendResponse({ status: 'ok' });
      break;

    case 'MEET_LEFT':
      handleMeetLeft(tabId);
      sendResponse({ status: 'ok' });
      break;

    case 'PARTICIPANT_UPDATE':
      handleParticipantUpdate(tabId, message.data);
      sendResponse({ status: 'ok' });
      break;

    case 'GET_SESSIONS':
      getSessions(sendResponse);
      return true;

    case 'GET_ACTIVE_SESSION': {
      let session = activeSessions[tabId];
      if (!session) {
        session = Object.values(activeSessions)[0] || null;
      }
      console.log('[Background] GET_ACTIVE_SESSION response:', { session: session?.id || null });
      sendResponse({ session });
      break;
    }

    case 'CLEAR_SESSIONS':
      clearSessions(sendResponse);
      return true;

    case 'EXPORT_DATA':
      exportData(sendResponse);
      return true;

    default:
      sendResponse({ status: 'ignored' });
      break;
  }
});

function handleMeetJoined(tabId, data) {
  if (typeof tabId !== 'number' || !data?.meetCode) {
    return;
  }

  const existing = activeSessions[tabId];
  if (existing && existing.meetCode === data.meetCode && !existing.leaveTime) {
    return;
  }

  const session = {
    id: generateId(),
    meetCode: data.meetCode,
    meetUrl: data.meetUrl,
    title: data.title || 'Google Meet',
    joinTime: Date.now(),
    leaveTime: null,
    duration: 0,
    participants: {},
    tabId
  };

  activeSessions[tabId] = session;

  chrome.action.setBadgeText({ text: 'ON', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#00c853', tabId });

  saveSession(session);
  console.log('[Attendance] Meet joined:', session);
}

function handleMeetLeft(tabId) {
  const session = activeSessions[tabId];
  if (!session) {
    return;
  }

  const endTime = Date.now();
  session.leaveTime = endTime;
  session.duration = endTime - session.joinTime;

  Object.values(session.participants).forEach((participant) => {
    if (participant.leaveTime) {
      return;
    }

    participant.leaveTime = endTime;
    participant.totalTime += endTime - participant.joinTime;

    const lastSession = participant.sessions[participant.sessions.length - 1];
    if (lastSession && !lastSession.leave) {
      lastSession.leave = endTime;
    }
  });

  saveSession(session);
  delete activeSessions[tabId];

  chrome.action.setBadgeText({ text: '', tabId });
  console.log('[Attendance] Meet left:', session);
}

function handleParticipantUpdate(tabId, data) {
  const session = activeSessions[tabId];
  if (!session) {
    return;
  }

  const now = Date.now();
  const incoming = normalizeIncomingParticipants(data?.participants);

  incoming.forEach((name) => {
    const key = normalizeName(name);
    const existing = session.participants[key];

    if (!existing) {
      session.participants[key] = {
        name,
        joinTime: now,
        leaveTime: null,
        totalTime: 0,
        lastSeen: now,
        sessions: [{ join: now, leave: null }]
      };
      return;
    }

    existing.name = name;
    existing.lastSeen = now;

    if (existing.leaveTime) {
      existing.joinTime = now;
      existing.leaveTime = null;
      existing.sessions.push({ join: now, leave: null });
    }
  });

  const incomingKeys = new Set(incoming.map(normalizeName));
  Object.entries(session.participants).forEach(([key, participant]) => {
    if (participant.leaveTime || incomingKeys.has(key)) {
      return;
    }

    const lastSeen = participant.lastSeen || participant.joinTime;
    if (now - lastSeen < PARTICIPANT_LEAVE_GRACE_MS) {
      return;
    }

    participant.leaveTime = now;
    participant.totalTime += now - participant.joinTime;

    const lastSession = participant.sessions[participant.sessions.length - 1];
    if (lastSession && !lastSession.leave) {
      lastSession.leave = now;
    }
  });

  saveSession(session);
}

function normalizeIncomingParticipants(participants) {
  if (!Array.isArray(participants)) {
    return [];
  }

  const deduped = new Map();
  participants.forEach((name) => {
    if (typeof name !== 'string') {
      return;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    deduped.set(normalizeName(trimmed), trimmed);
  });

  return [...deduped.values()];
}

async function getSessions(sendResponse) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/sessions`);
    if (response.ok) {
      const data = await response.json();
      await chrome.storage.local.set({ sessions: data.sessions });
      sendResponse({ sessions: data.sessions });
      return;
    }
  } catch (error) {
    console.warn('[Background] MongoDB fetch failed, using localStorage:', error.message);
  }

  const result = await chrome.storage.local.get('sessions');
  sendResponse({ sessions: result.sessions || [] });
}

async function clearSessions(sendResponse) {
  try {
    await fetch(`${BACKEND_URL}/api/sessions`, { method: 'DELETE' });
  } catch (error) {
    console.warn('[Background] MongoDB clear failed:', error.message);
  }

  await chrome.storage.local.set({ sessions: [] });
  activeSessions = {};
  sendResponse({ status: 'ok' });
}

async function exportData(sendResponse) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/export`);
    if (response.ok) {
      const data = await response.json();
      sendResponse({ data: data.data || [] });
      return;
    }
  } catch (error) {
    console.warn('[Background] MongoDB export failed, using localStorage:', error.message);
  }

  const result = await chrome.storage.local.get('sessions');
  sendResponse({ data: result.sessions || [] });
}

async function saveSession(session) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session)
    });
    if (response.ok) {
      console.log('[Background] Session saved to MongoDB:', session.id);
    }
  } catch (error) {
    console.warn('[Background] MongoDB save failed, using localStorage:', error.message);
  }

  const result = await chrome.storage.local.get('sessions');
  const sessions = result.sessions || [];
  const idx = sessions.findIndex((stored) => stored.id === session.id);

  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.unshift(session);
  }

  if (sessions.length > 100) {
    sessions.splice(100);
  }

  await chrome.storage.local.set({ sessions });
}

function normalizeName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '_');
}

function generateId() {
  return `meet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
