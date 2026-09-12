// Background Service Worker - GMeet Attendance Tracker

importScripts('gmail.js', 'emailTemplate.js');

const BACKEND_URL = 'http://localhost:3000';
const PARTICIPANT_LEAVE_GRACE_MS = 10000;
const ACTIVE_SESSIONS_KEY = 'activeSessions';
const HEARTBEAT_ALARM = 'gmeet-heartbeat';

// Must match EXTENSION_TOKEN in backend/.env - see backend/.env.example.
const EXTENSION_TOKEN = '8c518c6b3e57ff8f42e9c18de6729260043b9a13a842b320';

function backendFetch(path, options = {}) {
  return fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Extension-Token': EXTENSION_TOKEN
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const isPopup = sender.url?.includes('popup.html');

  console.log('[Background] Message received:', {
    type: message.type,
    tabId,
    isPopup,
    senderUrl: sender.url
  });

  switch (message.type) {
    case 'MEET_JOINED':
      handleMeetJoined(tabId, message.data).then(() => sendResponse({ status: 'ok' }));
      return true;

    case 'MEET_LEFT':
      handleMeetLeft(tabId).then(() => sendResponse({ status: 'ok' }));
      return true;

    case 'PARTICIPANT_UPDATE':
      handleParticipantUpdate(tabId, message.data).then(() => sendResponse({ status: 'ok' }));
      return true;

    case 'TRANSCRIPT_CHUNK':
      handleTranscriptChunk(tabId, message.data).then(() => sendResponse({ status: 'ok' }));
      return true;

    case 'CAPTIONS_UNAVAILABLE':
      handleCaptionsUnavailable(tabId).then(() => sendResponse({ status: 'ok' }));
      return true;

    case 'GET_SESSIONS':
      getSessions(sendResponse);
      return true;

    case 'GET_ACTIVE_SESSION':
      getActiveSession(tabId, sendResponse);
      return true;

    case 'CLEAR_SESSIONS':
      clearSessions(sendResponse);
      return true;

    case 'EXPORT_DATA':
      exportData(sendResponse);
      return true;

    case 'GET_ROSTER_FOR_MEET':
      getRosterForMeet(message.data, sendResponse);
      return true;

    case 'GET_ROSTERS':
      getRosters(sendResponse);
      return true;

    case 'SAVE_ROSTER':
      saveRoster(message.data, sendResponse);
      return true;

    case 'DELETE_ROSTER':
      deleteRoster(message.data, sendResponse);
      return true;

    case 'ASSIGN_ALIAS':
      assignAlias(message.data, sendResponse);
      return true;

    case 'GET_REPORT':
      getReport(message.data, sendResponse);
      return true;

    case 'GENERATE_MINUTES':
      generateMinutes(message.data, sendResponse);
      return true;

    case 'SAVE_MINUTES':
      saveMinutesEdits(message.data, sendResponse);
      return true;

    case 'SEND_MINUTES':
      sendMinutesEmail(message.data, sendResponse);
      return true;

    default:
      sendResponse({ status: 'ignored' });
      break;
  }
});

// --- chrome.storage.session helpers (survive within a browser session, not SW eviction) ---

async function readActiveSessions() {
  const result = await chrome.storage.session.get(ACTIVE_SESSIONS_KEY);
  return result[ACTIVE_SESSIONS_KEY] || {};
}

async function writeActiveSessions(activeSessions) {
  await chrome.storage.session.set({ [ACTIVE_SESSIONS_KEY]: activeSessions });
}

async function handleMeetJoined(tabId, data) {
  if (typeof tabId !== 'number' || !data?.meetCode) {
    return;
  }

  const activeSessions = await readActiveSessions();
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
  await writeActiveSessions(activeSessions);

  chrome.action.setBadgeText({ text: 'ON', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#00c853', tabId });

  await saveSession(session);
  console.log('[Attendance] Meet joined:', session);
}

async function handleMeetLeft(tabId) {
  const activeSessions = await readActiveSessions();
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

  await saveSession(session);

  delete activeSessions[tabId];
  await writeActiveSessions(activeSessions);

  chrome.action.setBadgeText({ text: '', tabId });
  console.log('[Attendance] Meet left:', session);
}

async function handleParticipantUpdate(tabId, data) {
  const activeSessions = await readActiveSessions();
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

  await writeActiveSessions(activeSessions);
  await saveSession(session);
}

// --- Transcript capture (from captions.js) ---

async function handleTranscriptChunk(tabId, data) {
  const activeSessions = await readActiveSessions();
  const session = activeSessions[tabId];
  if (!session || !Array.isArray(data?.lines) || data.lines.length === 0) {
    return;
  }

  const key = `transcript:${session.id}`;
  const result = await chrome.storage.local.get(key);
  const existing = result[key] || [];
  const seenSeq = new Set(existing.map((l) => l.seq));

  const newLines = data.lines.filter((l) => !seenSeq.has(l.seq));
  const merged = existing.concat(newLines);
  await chrome.storage.local.set({ [key]: merged });

  try {
    await backendFetch(`/api/sessions/${session.id}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: newLines })
    });
  } catch (error) {
    console.warn('[Background] Transcript sync failed, kept locally:', error.message);
  }
}

async function handleCaptionsUnavailable(tabId) {
  const activeSessions = await readActiveSessions();
  const session = activeSessions[tabId];
  if (!session) return;

  session.captionsUnavailable = true;
  await writeActiveSessions(activeSessions);
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

async function getActiveSession(tabId, sendResponse) {
  const activeSessions = await readActiveSessions();
  let session = activeSessions[tabId];
  if (!session) {
    session = Object.values(activeSessions)[0] || null;
  }
  console.log('[Background] GET_ACTIVE_SESSION response:', { session: session?.id || null });
  sendResponse({ session });
}

async function getSessions(sendResponse) {
  try {
    const response = await backendFetch('/api/sessions');
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
    await backendFetch('/api/sessions', { method: 'DELETE' });
  } catch (error) {
    console.warn('[Background] MongoDB clear failed:', error.message);
  }

  await chrome.storage.local.set({ sessions: [] });
  await writeActiveSessions({});
  sendResponse({ status: 'ok' });
}

async function exportData(sendResponse) {
  try {
    const response = await backendFetch('/api/export');
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
    const response = await backendFetch('/api/sessions', {
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

// --- Rosters (backend-managed) ---

async function getRosterForMeet(data, sendResponse) {
  try {
    const response = await backendFetch(`/api/rosters/by-meet/${encodeURIComponent(data?.meetCode || '')}`);
    if (response.ok) {
      const result = await response.json();
      sendResponse({ roster: result.roster });
      return;
    }
  } catch (error) {
    console.warn('[Background] GET_ROSTER_FOR_MEET failed:', error.message);
  }
  sendResponse({ roster: null });
}

async function getRosters(sendResponse) {
  try {
    const response = await backendFetch('/api/rosters');
    if (response.ok) {
      const data = await response.json();
      sendResponse({ rosters: data.rosters || [] });
      return;
    }
  } catch (error) {
    console.warn('[Background] GET_ROSTERS failed:', error.message);
  }
  sendResponse({ rosters: [] });
}

async function saveRoster(data, sendResponse) {
  try {
    const isUpdate = !!data?.roster?._id;
    const response = await backendFetch(
      isUpdate ? `/api/rosters/${data.roster._id}` : '/api/rosters',
      {
        method: isUpdate ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.roster)
      }
    );
    const result = await response.json();
    sendResponse({ status: response.ok ? 'ok' : 'error', roster: result.roster, error: result.error });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function deleteRoster(data, sendResponse) {
  try {
    const response = await backendFetch(`/api/rosters/${data.id}`, { method: 'DELETE' });
    sendResponse({ status: response.ok ? 'ok' : 'error' });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function assignAlias(data, sendResponse) {
  try {
    const response = await backendFetch(`/api/rosters/${data.rosterId}/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberIndex: data.memberIndex, alias: data.alias })
    });
    const result = await response.json();
    sendResponse({ status: response.ok ? 'ok' : 'error', roster: result.roster, error: result.error });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

// --- Report, minutes, and email send ---

async function getReport(data, sendResponse) {
  try {
    const response = await backendFetch(`/api/sessions/${data.sessionId}/report`);
    const result = await response.json();
    sendResponse({ status: response.ok ? 'ok' : 'error', report: result.report, error: result.error });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function generateMinutes(data, sendResponse) {
  try {
    const qs = data?.regenerate ? '?regenerate=true' : '';
    const response = await backendFetch(`/api/sessions/${data.sessionId}/minutes${qs}`, {
      method: 'POST'
    });
    const result = await response.json();
    sendResponse({ status: response.ok ? 'ok' : 'error', minutes: result.minutes, error: result.error });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function saveMinutesEdits(data, sendResponse) {
  try {
    const response = await backendFetch(`/api/sessions/${data.sessionId}/minutes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: data.minutes })
    });
    const result = await response.json();
    sendResponse({ status: response.ok ? 'ok' : 'error', minutes: result.minutes, error: result.error });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function sendMinutesEmail(data, sendResponse) {
  try {
    // 1. Gather the assembled report (attendance + minutes + transcript) from the backend.
    const reportRes = await backendFetch(`/api/sessions/${data.sessionId}/report`);
    const reportResult = await reportRes.json();
    if (!reportRes.ok || !reportResult.report) {
      sendResponse({ status: 'error', error: reportResult.error || 'Report not available' });
      return;
    }
    const report = reportResult.report;

    const recipients = (report.roster?.members || [])
      .map((m) => m.email)
      .filter(Boolean);

    if (recipients.length === 0) {
      sendResponse({ status: 'error', error: 'No recipient emails on the roster' });
      return;
    }

    // 2. Get a Gmail OAuth token (interactive - must be called from a user gesture in the popup).
    const token = await gmailGetToken({ interactive: true });

    // 3. Build and send the MIME message.
    const { subject, text, html } = buildMinutesEmail(report);
    const gmailMessageId = await gmailSend({ token, to: recipients, subject, text, html });

    // 4. Record the send server-side so a repeat click is refused without ?force=true.
    const recordRes = await backendFetch(`/api/sessions/${data.sessionId}/email-sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients, gmailMessageId })
    });

    if (!recordRes.ok) {
      const recordResult = await recordRes.json().catch(() => ({}));
      sendResponse({ status: 'error', error: recordResult.error || 'Send recorded rejected (already sent?)' });
      return;
    }

    sendResponse({ status: 'ok', recipients, gmailMessageId });
  } catch (error) {
    console.error('[Background] sendMinutesEmail failed:', error);
    sendResponse({ status: 'error', error: error.message });
  }
}

// --- MV3 lifecycle: rehydrate badges + heartbeat flush across service worker restarts ---

async function rehydrateBadges() {
  const activeSessions = await readActiveSessions();
  Object.entries(activeSessions).forEach(([tabId, session]) => {
    if (!session.leaveTime) {
      chrome.action.setBadgeText({ text: 'ON', tabId: Number(tabId) });
      chrome.action.setBadgeBackgroundColor({ color: '#00c853', tabId: Number(tabId) });
    }
  });
}

async function flushActiveSessions() {
  const activeSessions = await readActiveSessions();
  await Promise.all(Object.values(activeSessions).map((session) => saveSession(session)));
}

chrome.runtime.onStartup.addListener(() => {
  rehydrateBadges();
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    flushActiveSessions();
  }
});
