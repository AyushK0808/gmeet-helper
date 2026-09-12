// Options page - roster CRUD + capture settings.

let rosters = [];
let editingRosterId = null; // null = new roster

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadRosters();

  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('newRosterBtn').addEventListener('click', () => openEditor(null));
  document.getElementById('addMemberBtn').addEventListener('click', () => addMemberRow());
  document.getElementById('saveRosterBtn').addEventListener('click', saveRoster);
  document.getElementById('deleteRosterBtn').addEventListener('click', deleteRoster);
  document.getElementById('cancelEditBtn').addEventListener('click', closeEditor);
});

// ─── Settings ───────────────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await new Promise((resolve) =>
    chrome.storage.local.get({ autoEnableCaptions: true, showConsentBanner: true }, resolve)
  );
  document.getElementById('autoEnableCaptions').checked = settings.autoEnableCaptions;
  document.getElementById('showConsentBanner').checked = settings.showConsentBanner;
}

async function saveSettings() {
  const autoEnableCaptions = document.getElementById('autoEnableCaptions').checked;
  const showConsentBanner = document.getElementById('showConsentBanner').checked;
  await new Promise((resolve) => chrome.storage.local.set({ autoEnableCaptions, showConsentBanner }, resolve));
  showToast('Settings saved');
}

// ─── Rosters ────────────────────────────────────────────────────────────────

async function loadRosters() {
  const res = await sendMessage({ type: 'GET_ROSTERS' });
  rosters = res?.rosters || [];
  renderRosterList();
}

function renderRosterList() {
  const list = document.getElementById('rosterList');
  if (rosters.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px 0;">No rosters yet. Create one below.</div>`;
    return;
  }

  list.innerHTML = rosters.map((r) => `
    <div class="roster-list-item" data-id="${r._id}">
      <div>
        <div>${escHtml(r.name)}</div>
        <div class="meta">${(r.members || []).length} members · bound to: ${(r.meetCodes || []).join(', ') || 'none'}</div>
      </div>
      <div class="meta">${r.autoSend ? 'auto-send on' : ''}</div>
    </div>
  `).join('');

  list.querySelectorAll('.roster-list-item').forEach((el) => {
    el.addEventListener('click', () => openEditor(el.getAttribute('data-id')));
  });
}

function openEditor(rosterId) {
  editingRosterId = rosterId;
  const editor = document.getElementById('rosterEditor');
  editor.style.display = 'block';

  const roster = rosterId ? rosters.find((r) => r._id === rosterId) : null;

  document.getElementById('rosterName').value = roster?.name || '';
  document.getElementById('rosterMeetCodes').value = (roster?.meetCodes || []).join(', ');
  document.getElementById('rosterThreshold').value = roster?.attendanceThresholdPct ?? 50;
  document.getElementById('rosterAutoSend').checked = !!roster?.autoSend;
  document.getElementById('deleteRosterBtn').style.display = rosterId ? 'inline-block' : 'none';

  const memberRows = document.getElementById('memberRows');
  memberRows.innerHTML = '';
  (roster?.members || []).forEach((m) => addMemberRow(m));
  if (!roster || (roster.members || []).length === 0) addMemberRow();

  editor.scrollIntoView({ behavior: 'smooth' });
}

function closeEditor() {
  document.getElementById('rosterEditor').style.display = 'none';
  editingRosterId = null;
}

function addMemberRow(member) {
  const row = document.createElement('div');
  row.className = 'member-row';
  row.innerHTML = `
    <input type="text" class="member-name" placeholder="Name" value="${escAttr(member?.name || '')}" />
    <input type="email" class="member-email" placeholder="Email" value="${escAttr(member?.email || '')}" />
    <input type="text" class="member-aliases" placeholder="Aliases (comma-separated)" value="${escAttr((member?.aliases || []).join(', '))}" />
    <button class="ghost small remove-member">✕</button>
  `;
  row.querySelector('.remove-member').addEventListener('click', () => row.remove());
  document.getElementById('memberRows').appendChild(row);
}

async function saveRoster() {
  const name = document.getElementById('rosterName').value.trim();
  if (!name) {
    showToast('Roster name is required');
    return;
  }

  const meetCodes = document.getElementById('rosterMeetCodes').value
    .split(',').map((s) => s.trim()).filter(Boolean);

  const members = Array.from(document.querySelectorAll('.member-row')).map((row) => ({
    name: row.querySelector('.member-name').value.trim(),
    email: row.querySelector('.member-email').value.trim(),
    aliases: row.querySelector('.member-aliases').value.split(',').map((s) => s.trim()).filter(Boolean)
  })).filter((m) => m.name);

  const roster = {
    name,
    meetCodes,
    members,
    attendanceThresholdPct: Number(document.getElementById('rosterThreshold').value) || 50,
    autoSend: document.getElementById('rosterAutoSend').checked
  };

  if (editingRosterId) {
    roster._id = editingRosterId;
  }

  const res = await sendMessage({ type: 'SAVE_ROSTER', data: { roster } });
  if (res?.status === 'ok') {
    showToast('Roster saved');
    closeEditor();
    await loadRosters();
  } else {
    showToast(`Error: ${res?.error || 'could not save roster'}`);
  }
}

async function deleteRoster() {
  if (!editingRosterId) return;
  if (!confirm('Delete this roster? This cannot be undone.')) return;

  const res = await sendMessage({ type: 'DELETE_ROSTER', data: { id: editingRosterId } });
  if (res?.status === 'ok') {
    showToast('Roster deleted');
    closeEditor();
    await loadRosters();
  } else {
    showToast(`Error: ${res?.error || 'could not delete roster'}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return escHtml(str).replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}
