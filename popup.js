// Popup JS - GMeet Attendance Tracker

let currentTab = 'live';
let activeSession = null;
let timerInterval = null;
let allSessions = [];
let liveRoster = null;
let minutesSessionId = null;
let minutesRoster = null;
let minutesData = null;
let minutesTranscript = [];

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Tab switching
    const tabLiveBtn = document.getElementById('tab-btn-live');
    const tabHistoryBtn = document.getElementById('tab-btn-history');
    const tabMinutesBtn = document.getElementById('tab-btn-minutes');
    if (tabLiveBtn) tabLiveBtn.addEventListener('click', () => switchTab('live'));
    if (tabHistoryBtn) tabHistoryBtn.addEventListener('click', () => switchTab('history'));
    if (tabMinutesBtn) tabMinutesBtn.addEventListener('click', () => switchTab('minutes'));

    // Back button in detail view
    const backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.addEventListener('click', showHistoryList);

    // Actions
    const clearBtn = document.getElementById('clear-data-btn');
    const exportBtn = document.getElementById('export-csv-btn');
    const optionsBtn = document.getElementById('options-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearData);
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);
    if (optionsBtn) optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

    // Minutes tab controls
    const sessionSelect = document.getElementById('minutes-session-select');
    const generateBtn = document.getElementById('generate-minutes-btn');
    const saveMinutesBtn = document.getElementById('save-minutes-btn');
    const sendMinutesBtn = document.getElementById('send-minutes-btn');
    if (sessionSelect) sessionSelect.addEventListener('change', (e) => loadMinutesForSession(e.target.value));
    if (generateBtn) generateBtn.addEventListener('click', () => generateMinutes(false));
    if (saveMinutesBtn) saveMinutesBtn.addEventListener('click', saveMinutesEdits);
    if (sendMinutesBtn) sendMinutesBtn.addEventListener('click', sendMinutes);

    // Delegate history item clicks
    const historyList = document.getElementById('history-list');
    if (historyList) {
      historyList.addEventListener('click', function(e) {
        const item = e.target.closest('.history-item');
        if (item && item.hasAttribute('data-session-id')) {
          showDetail(item.getAttribute('data-session-id'));
        }
      });
    }
    
    await loadSessions();
    await loadActiveSession();
    renderHistoryList();
    startPolling();
  } catch (error) {
    console.error('[Popup] Initialization error:', error);
  }
});

function startPolling() {
  setInterval(async () => {
    await loadActiveSession();
    if (currentTab === 'history') renderHistoryList();
  }, 3000);
}

// ─── Data Loading ────────────────────────────────────────────────────────────
async function loadSessions() {
  const res = await sendMessage({ type: 'GET_SESSIONS' });
  allSessions = res?.sessions || [];
}

async function loadActiveSession() {
  console.log('[Popup] Checking for active session...');
  
  try {
    // First, try to get from background via sendMessage
    let found = null;
    const res = await sendMessage({ type: 'GET_ACTIVE_SESSION' });
    if (res?.session) {
      found = res.session;
      console.log('[Popup] Found active session via background:', found);
    } else {
      console.log('[Popup] No session found via background');
    }

    const wasActive = !!activeSession;
    activeSession = found;

    if (activeSession) {
      showActiveSession();
    } else {
      showNoMeet();
      if (wasActive) {
        await loadSessions();
        if (currentTab === 'history') renderHistoryList();
      }
    }
  } catch (error) {
    console.error('[Popup] Error loading session:', error);
    showNoMeet();
  }
}

// ─── Live View ───────────────────────────────────────────────────────────────
function showActiveSession() {
  document.getElementById('no-meet-msg').style.display = 'none';
  document.getElementById('active-session-view').style.display = 'block';

  // Badge
  const badge = document.getElementById('status-badge');
  badge.className = 'live-badge';
  badge.innerHTML = `<div class="live-dot"></div> LIVE`;

  // Meet code
  document.getElementById('current-code').textContent =
    (activeSession.meetCode || 'Unknown').toUpperCase();

  // Timer
  updateTimer();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);

  // Participants
  renderParticipants();
  loadLiveAttendance();
}

// ─── Live roster attendance ───────────────────────────────────────────────
async function loadLiveAttendance() {
  if (!activeSession) return;

  const rosterRes = await sendMessage({ type: 'GET_ROSTER_FOR_MEET', data: { meetCode: activeSession.meetCode } });
  liveRoster = rosterRes?.roster || null;

  const label = document.getElementById('roster-name-label');
  const grid = document.getElementById('attendance-grid');
  if (!liveRoster) {
    if (label) label.textContent = 'no roster bound';
    if (grid) grid.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:6px 0;">No roster is bound to this meet code. Set one up in Rosters.</div>`;
    return;
  }
  if (label) label.textContent = liveRoster.name;

  const reportRes = await sendMessage({ type: 'GET_REPORT', data: { sessionId: activeSession.id } });
  const attendance = reportRes?.report?.attendance;
  renderAttendanceGrid(grid, attendance, liveRoster);
}

function renderAttendanceGrid(container, attendance, roster) {
  if (!container) return;
  if (!attendance) {
    container.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:6px 0;">No attendance data yet.</div>`;
    return;
  }

  const rows = [];
  const addRows = (list, badgeClass, label) => {
    (list || []).forEach((entry) => {
      const time = entry.timeInCallMs != null ? formatTime(Math.floor(entry.timeInCallMs / 1000)) : '—';
      rows.push(`
        <div class="attendance-row">
          <div class="attendance-name">${escHtml(entry.name)}</div>
          <div class="attendance-time">${time}</div>
          <div class="attendance-badge ${badgeClass}">${label}</div>
        </div>
      `);
    });
  };

  addRows(attendance.present, 'badge-present', 'Present');
  addRows(attendance.partial, 'badge-partial', 'Partial');
  addRows(attendance.absent, 'badge-absent', 'Absent');

  (attendance.unknown || []).forEach((entry, idx) => {
    const time = formatTime(Math.floor((entry.timeInCallMs || 0) / 1000));
    const options = (roster.members || [])
      .map((m, i) => `<option value="${i}">${escHtml(m.name)}</option>`)
      .join('');
    rows.push(`
      <div class="attendance-row">
        <div class="attendance-name">${escHtml(entry.name)}</div>
        <div class="attendance-time">${time}</div>
        <div class="attendance-badge badge-unknown">Unknown</div>
        <select class="assign-select" data-unknown-name="${escAttr(entry.name)}">
          <option value="">Assign to…</option>
          ${options}
        </select>
      </div>
    `);
  });

  container.innerHTML = rows.join('') || `<div style="color:var(--muted);font-size:11px;padding:6px 0;">No attendance data yet.</div>`;

  container.querySelectorAll('.assign-select').forEach((select) => {
    select.addEventListener('change', async (e) => {
      const memberIndex = Number(e.target.value);
      if (Number.isNaN(memberIndex)) return;
      const name = e.target.getAttribute('data-unknown-name');
      await sendMessage({
        type: 'ASSIGN_ALIAS',
        data: { rosterId: roster._id, memberIndex, alias: name }
      });
      loadLiveAttendance();
    });
  });
}

function showNoMeet() {
  document.getElementById('no-meet-msg').style.display = 'block';
  document.getElementById('active-session-view').style.display = 'none';

  const badge = document.getElementById('status-badge');
  badge.className = 'idle-badge';
  badge.innerHTML = `<div style="width:6px;height:6px;background:var(--muted);border-radius:50%;"></div> IDLE`;

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimer() {
  if (!activeSession) return;
  const elapsed = Math.floor((Date.now() - activeSession.joinTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  document.getElementById('session-timer').innerHTML =
    `${pad(h)}<span>h</span> ${pad(m)}<span>m</span> ${pad(s)}<span>s</span>`;
}

function renderParticipants() {
  if (!activeSession) return;
  const participants = Object.values(activeSession.participants || {});
  const inCall = participants.filter(p => !p.leaveTime);

  document.getElementById('participant-count').textContent = inCall.length;
  document.getElementById('total-participant-count').textContent =
    `${participants.length} total`;

  const list = document.getElementById('participant-list');
  if (participants.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-family:DM Mono,monospace;font-size:11px;">Waiting for participants...</div>`;
    return;
  }

  // Sort: in-call first, then by join time
  participants.sort((a, b) => {
    if (!a.leaveTime && b.leaveTime) return -1;
    if (a.leaveTime && !b.leaveTime) return 1;
    return a.joinTime - b.joinTime;
  });

  list.innerHTML = participants.map(p => {
    const isIn = !p.leaveTime;
    const elapsed = isIn
      ? Math.floor((Date.now() - p.joinTime) / 1000)
      : Math.floor(p.totalTime / 1000);
    const initials = getInitials(p.name);
    return `
      <div class="participant-item">
        <div class="participant-avatar">${initials}</div>
        <div class="participant-name">${escHtml(p.name)}</div>
        <div class="participant-time">${formatTime(elapsed)}</div>
        <div class="participant-status ${isIn ? 'status-in' : 'status-out'}"></div>
      </div>
    `;
  }).join('');
}

// ─── History View ─────────────────────────────────────────────────────────────
function renderHistoryList() {
  const completedSessions = allSessions.filter(s => s.leaveTime);
  document.getElementById('session-count').textContent =
    `${completedSessions.length} sessions`;

  const list = document.getElementById('history-list');
  if (completedSessions.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗂️</div>
        <div class="empty-title">No History Yet</div>
        <div class="empty-sub">Your past sessions will appear here</div>
      </div>`;
    return;
  }

  list.innerHTML = completedSessions.map((s, idx) => {
    const durationSec = Math.floor((s.leaveTime - s.joinTime) / 1000);
    const participantCount = Object.keys(s.participants || {}).length;
    const dateStr = new Date(s.joinTime).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    return `
      <div class="history-item" data-session-id="${s.id}">
        <div class="history-item-header">
          <div class="history-meet-code">${(s.meetCode || 'Unknown').toUpperCase()}</div>
          <div class="history-duration">${formatTime(durationSec)}</div>
        </div>
        <div class="history-date">${dateStr}</div>
        <div class="history-stats">
          <div class="history-stat"><strong>${participantCount}</strong> participants</div>
        </div>
      </div>
    `;
  }).join('');
}

function showDetail(sessionId) {
  const session = allSessions.find(s => s.id === sessionId);
  if (!session) return;

  document.getElementById('history-list-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  document.getElementById('detail-title').textContent =
    (session.meetCode || 'Unknown').toUpperCase();

  const participants = Object.values(session.participants || {});
  const list = document.getElementById('detail-participant-list');

  if (participants.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-family:DM Mono,monospace;font-size:11px;">No participant data</div>`;
    return;
  }

  participants.sort((a, b) => b.totalTime - a.totalTime);

  list.innerHTML = participants.map(p => {
    const initials = getInitials(p.name);
    const total = Math.floor((p.totalTime || (p.leaveTime - p.joinTime) || 0) / 1000);
    return `
      <div class="participant-item">
        <div class="participant-avatar">${initials}</div>
        <div class="participant-name">${escHtml(p.name)}</div>
        <div class="participant-time">${formatTime(total)}</div>
        <div class="participant-status status-out"></div>
      </div>
    `;
  }).join('');
}

function showHistoryList() {
  document.getElementById('history-list-view').style.display = 'block';
  document.getElementById('detail-view').style.display = 'none';
}

// ─── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  try {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    
    const activeTab = document.querySelector(`[data-tab="${tab}"]`);
    if (activeTab) {
      activeTab.classList.add('active');
    }
    
    document.getElementById('tab-live').style.display = tab === 'live' ? 'block' : 'none';
    document.getElementById('tab-history').style.display = tab === 'history' ? 'block' : 'none';
    document.getElementById('tab-minutes').style.display = tab === 'minutes' ? 'block' : 'none';

    if (tab === 'history') {
      loadSessions()
        .then(() => renderHistoryList())
        .then(() => showHistoryList())
        .catch(error => {
          console.error('[Popup] Error switching to history tab:', error);
          showHistoryList(); // Still show the view even if there's an error
        });
    }

    if (tab === 'minutes') {
      initMinutesTab().catch((error) => console.error('[Popup] Error loading minutes tab:', error));
    }
    console.log('[Popup] Switched to tab:', tab);
  } catch (error) {
    console.error('[Popup] Error in switchTab:', error);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function clearData() {
  try {
    if (!confirm('Clear all session history?')) return;
    await sendMessage({ type: 'CLEAR_SESSIONS' });
    allSessions = [];
    renderHistoryList();
    console.log('[Popup] Data cleared');
  } catch (error) {
    console.error('[Popup] Error clearing data:', error);
  }
}

async function exportCSV() {
  try {
    await loadSessions();
    const sessions = allSessions.filter(s => s.leaveTime);
    if (sessions.length === 0) { alert('No completed sessions to export.'); return; }

    const rows = [['Session ID', 'Meet Code', 'Date', 'Start Time', 'End Time', 'Duration (min)', 'Participant', 'Time in Call (min)', 'Join Time', 'Leave Time']];

    sessions.forEach(s => {
      const dateStr = new Date(s.joinTime).toLocaleDateString('en-IN');
      const startStr = new Date(s.joinTime).toLocaleTimeString('en-IN');
      const endStr = new Date(s.leaveTime).toLocaleTimeString('en-IN');
      const durationMin = ((s.leaveTime - s.joinTime) / 60000).toFixed(1);

      const participants = Object.values(s.participants || {});
      if (participants.length === 0) {
        rows.push([s.id, s.meetCode || '', dateStr, startStr, endStr, durationMin, '—', '—', '', '']);
      } else {
        participants.forEach(p => {
          const total = (p.totalTime || (p.leaveTime - p.joinTime) || 0);
          rows.push([
            s.id, s.meetCode || '', dateStr, startStr, endStr, durationMin,
            p.name,
            (total / 60000).toFixed(1),
            new Date(p.joinTime).toLocaleTimeString('en-IN'),
            p.leaveTime ? new Date(p.leaveTime).toLocaleTimeString('en-IN') : 'Still in'
          ]);
        });
      }
    });

    const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gmeet-attendance-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    console.log('[Popup] CSV exported successfully');
  } catch (error) {
    console.error('[Popup] Error exporting CSV:', error);
    alert('Error exporting CSV');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function formatTime(totalSec) {
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s)}s`;
}

function getInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');
}

function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return escHtml(str).replace(/"/g, '&quot;');
}

// ─── Minutes tab ──────────────────────────────────────────────────────────

async function initMinutesTab() {
  await loadSessions();
  const select = document.getElementById('minutes-session-select');
  if (!select) return;

  const candidates = [];
  if (activeSession) candidates.push({ id: activeSession.id, label: `${(activeSession.meetCode || 'live').toUpperCase()} (in progress)` });
  allSessions.filter((s) => s.leaveTime).forEach((s) => {
    candidates.push({ id: s.id, label: `${(s.meetCode || 'unknown').toUpperCase()} — ${new Date(s.joinTime).toLocaleDateString()}` });
  });

  if (candidates.length === 0) {
    select.innerHTML = '';
    document.getElementById('minutes-empty').style.display = 'block';
    document.getElementById('minutes-body').style.display = 'none';
    return;
  }

  select.innerHTML = candidates.map((c) => `<option value="${c.id}">${escHtml(c.label)}</option>`).join('');
  const toSelect = minutesSessionId && candidates.some((c) => c.id === minutesSessionId)
    ? minutesSessionId
    : candidates[0].id;
  select.value = toSelect;
  await loadMinutesForSession(toSelect);
}

async function loadMinutesForSession(sessionId) {
  minutesSessionId = sessionId;
  document.getElementById('minutes-empty').style.display = 'none';
  document.getElementById('minutes-body').style.display = 'block';

  const reportRes = await sendMessage({ type: 'GET_REPORT', data: { sessionId } });
  const report = reportRes?.report;

  minutesRoster = report?.roster || null;
  renderAttendanceGrid(document.getElementById('minutes-attendance-grid'), report?.attendance, minutesRoster);

  minutesData = report?.minutes || null;
  minutesTranscript = report?.transcript || [];
  renderMinutesEditor();
  renderTranscript();
}

function renderTranscript() {
  const container = document.getElementById('transcript-list');
  const count = document.getElementById('transcript-count');
  if (!container) return;

  if (count) count.textContent = minutesTranscript.length ? `${minutesTranscript.length} lines` : '';

  if (!minutesTranscript.length) {
    container.innerHTML = `<div class="transcript-empty">No transcript captured for this meeting.</div>`;
    return;
  }

  container.innerHTML = minutesTranscript.map((line) => `
    <div class="transcript-line">
      <span class="transcript-speaker">${escHtml(line.speaker || 'Unknown')}</span>
      <span class="transcript-text">${escHtml(line.text || '')}</span>
    </div>
  `).join('');
}

function renderMinutesEditor() {
  const editor = document.getElementById('minutes-editor');
  const status = document.getElementById('minutes-status');
  const saveBtn = document.getElementById('save-minutes-btn');
  const sendBtn = document.getElementById('send-minutes-btn');
  const generateBtn = document.getElementById('generate-minutes-btn');

  if (!minutesData) {
    editor.style.display = 'none';
    saveBtn.style.display = 'none';
    sendBtn.style.display = 'none';
    status.textContent = 'not generated';
    status.style.color = 'var(--accent2)';
    generateBtn.textContent = 'Generate';
    return;
  }

  editor.style.display = 'block';
  saveBtn.style.display = 'inline-block';
  sendBtn.style.display = 'inline-block';
  status.textContent = minutesData.editedAt ? 'edited' : (minutesData.disabled ? 'generation disabled — see transcript' : 'generated');
  status.style.color = minutesData.disabled ? 'var(--warn)' : 'var(--accent2)';
  generateBtn.textContent = 'Regenerate';

  document.getElementById('minutes-summary').value = minutesData.summary || '';
  document.getElementById('minutes-decisions').value = (minutesData.decisions || []).join('\n');
  document.getElementById('minutes-actions').value = (minutesData.actionItems || [])
    .map((a) => `${a.owner} | ${a.task} | ${a.dueDate || ''}`).join('\n');
  document.getElementById('minutes-questions').value = (minutesData.openQuestions || []).join('\n');
}

function readMinutesFromEditor() {
  const decisions = document.getElementById('minutes-decisions').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const openQuestions = document.getElementById('minutes-questions').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const actionItems = document.getElementById('minutes-actions').value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [owner, task, dueDate] = line.split('|').map((s) => (s || '').trim());
      return { owner: owner || 'Unassigned', task: task || '', dueDate: dueDate || null };
    });

  return {
    summary: document.getElementById('minutes-summary').value.trim(),
    topics: minutesData?.topics || [],
    decisions,
    actionItems,
    openQuestions
  };
}

async function generateMinutes(regenerate) {
  if (!minutesSessionId) return;
  const btn = document.getElementById('generate-minutes-btn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const res = await sendMessage({ type: 'GENERATE_MINUTES', data: { sessionId: minutesSessionId, regenerate: !!regenerate || !!minutesData } });
    if (res?.status === 'ok') {
      minutesData = res.minutes;
      renderMinutesEditor();
    } else {
      alert(`Error generating minutes: ${res?.error || 'unknown error'}`);
    }
  } finally {
    btn.disabled = false;
    renderMinutesEditor();
  }
}

async function saveMinutesEdits() {
  if (!minutesSessionId) return;
  const minutes = readMinutesFromEditor();
  const res = await sendMessage({ type: 'SAVE_MINUTES', data: { sessionId: minutesSessionId, minutes } });
  if (res?.status === 'ok') {
    minutesData = res.minutes;
    renderMinutesEditor();
  } else {
    alert(`Error saving minutes: ${res?.error || 'unknown error'}`);
  }
}

async function sendMinutes() {
  if (!minutesSessionId) return;
  if (!minutesRoster || (minutesRoster.members || []).filter((m) => m.email).length === 0) {
    alert('This session has no roster with member emails bound to it.');
    return;
  }
  if (!confirm(`Send minutes to ${minutesRoster.members.filter((m) => m.email).length} recipient(s)?`)) return;

  // Persist any unsaved edits first so the sent email matches what's on screen.
  await saveMinutesEdits();

  const btn = document.getElementById('send-minutes-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await sendMessage({ type: 'SEND_MINUTES', data: { sessionId: minutesSessionId } });
    if (res?.status === 'ok') {
      alert(`Sent to: ${res.recipients.join(', ')}`);
    } else {
      alert(`Error sending: ${res?.error || 'unknown error'}`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to roster';
  }
}

function sendMessage(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Popup] Message error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      console.error('[Popup] Send message exception:', error.message);
      resolve(null);
    }
  });
}
