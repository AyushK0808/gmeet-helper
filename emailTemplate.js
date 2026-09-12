// Renders the /api/sessions/:id/report payload into an email. Classic
// script, loaded into the service worker via importScripts() in
// background.js. Exposes buildMinutesEmail() on the global scope.
//
// Expected `report` shape (see backend/server.js GET /api/sessions/:id/report):
// {
//   session: { meetCode, title, joinTime, leaveTime },
//   roster: { name, members: [{ name, email }] },
//   attendance: { present: [...], partial: [...], absent: [...], unknown: [...] },
//   minutes: { summary, topics, decisions, actionItems, openQuestions } | null,
//   transcript: [{ speaker, text, tStart, tEnd }]
// }

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function attendanceRowsHtml(attendance) {
  const rows = [];
  const section = (label, list, color) => {
    (list || []).forEach((entry) => {
      rows.push(
        `<tr>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(entry.name)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:${color};font-weight:600;">${label}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${entry.timeInCallMs != null ? formatDuration(entry.timeInCallMs) : '—'}</td>` +
        `</tr>`
      );
    });
  };

  section('Present', attendance.present, '#16a34a');
  section('Partial', attendance.partial, '#d97706');
  section('Absent', attendance.absent, '#dc2626');

  if (rows.length === 0) {
    return `<tr><td colspan="3" style="padding:10px;color:#6b7280;">No roster attendance data.</td></tr>`;
  }
  return rows.join('');
}

function attendanceRowsText(attendance) {
  const lines = [];
  const section = (label, list) => {
    (list || []).forEach((entry) => {
      const time = entry.timeInCallMs != null ? formatDuration(entry.timeInCallMs) : '-';
      lines.push(`  - ${entry.name}: ${label} (${time})`);
    });
  };
  section('Present', attendance.present);
  section('Partial', attendance.partial);
  section('Absent', attendance.absent);
  return lines.join('\n') || '  (no roster attendance data)';
}

function minutesHtml(minutes) {
  if (!minutes) {
    return '<p style="color:#6b7280;">Minutes were not generated for this session.</p>';
  }

  const topics = (minutes.topics || [])
    .map((t) => `<li><strong>${escapeHtml(t.title)}</strong> — ${escapeHtml(t.discussion)}</li>`)
    .join('');
  const decisions = (minutes.decisions || []).map((d) => `<li>${escapeHtml(d)}</li>`).join('');
  const actionItems = (minutes.actionItems || [])
    .map((a) => `<tr>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(a.owner)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(a.task)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(a.dueDate || '—')}</td>` +
      `</tr>`)
    .join('');
  const openQuestions = (minutes.openQuestions || []).map((q) => `<li>${escapeHtml(q)}</li>`).join('');

  return `
    <p>${escapeHtml(minutes.summary)}</p>
    ${topics ? `<h3 style="margin:16px 0 6px;">Topics discussed</h3><ul>${topics}</ul>` : ''}
    ${decisions ? `<h3 style="margin:16px 0 6px;">Decisions</h3><ul>${decisions}</ul>` : ''}
    ${actionItems ? `<h3 style="margin:16px 0 6px;">Action items</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <thead><tr>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #d1d5db;">Owner</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #d1d5db;">Task</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #d1d5db;">Due</th>
        </tr></thead>
        <tbody>${actionItems}</tbody>
      </table>` : ''}
    ${openQuestions ? `<h3 style="margin:16px 0 6px;">Open questions</h3><ul>${openQuestions}</ul>` : ''}
  `;
}

function minutesText(minutes) {
  if (!minutes) return 'Minutes were not generated for this session.';
  const parts = [minutes.summary, ''];
  if (minutes.topics?.length) {
    parts.push('Topics discussed:');
    minutes.topics.forEach((t) => parts.push(`  - ${t.title}: ${t.discussion}`));
    parts.push('');
  }
  if (minutes.decisions?.length) {
    parts.push('Decisions:');
    minutes.decisions.forEach((d) => parts.push(`  - ${d}`));
    parts.push('');
  }
  if (minutes.actionItems?.length) {
    parts.push('Action items:');
    minutes.actionItems.forEach((a) => parts.push(`  - [${a.owner}] ${a.task}${a.dueDate ? ` (due ${a.dueDate})` : ''}`));
    parts.push('');
  }
  if (minutes.openQuestions?.length) {
    parts.push('Open questions:');
    minutes.openQuestions.forEach((q) => parts.push(`  - ${q}`));
  }
  return parts.join('\n');
}

function transcriptHtml(transcript) {
  if (!transcript || transcript.length === 0) {
    return '<p style="color:#6b7280;">No transcript captured.</p>';
  }
  const lines = transcript
    .map((l) => `<div style="margin-bottom:4px;"><strong>${escapeHtml(l.speaker)}:</strong> ${escapeHtml(l.text)}</div>`)
    .join('');
  return `<details><summary style="cursor:pointer;color:#2563eb;">Show full transcript (${transcript.length} lines)</summary><div style="margin-top:8px;font-size:12px;color:#374151;">${lines}</div></details>`;
}

function buildMinutesEmail(report) {
  const { session, roster, attendance, minutes, transcript } = report;
  const dateStr = new Date(session.joinTime).toLocaleString();
  const duration = session.leaveTime ? formatDuration(session.leaveTime - session.joinTime) : 'in progress';
  const subject = `Meeting minutes: ${session.title || session.meetCode} — ${new Date(session.joinTime).toLocaleDateString()}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px;">
      <h2 style="margin:0 0 4px;">${escapeHtml(session.title || 'Google Meet')}</h2>
      <p style="color:#6b7280;margin:0 0 20px;">${escapeHtml(roster?.name || session.meetCode)} · ${escapeHtml(dateStr)} · ${escapeHtml(duration)}</p>

      <h3 style="margin:0 0 8px;">Attendance</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px;">
        <thead><tr>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #d1d5db;">Name</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #d1d5db;">Status</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #d1d5db;">Time in call</th>
        </tr></thead>
        <tbody>${attendanceRowsHtml(attendance || {})}</tbody>
      </table>

      <h3 style="margin:0 0 8px;">Summary &amp; minutes</h3>
      ${minutesHtml(minutes)}

      <h3 style="margin:20px 0 8px;">Transcript</h3>
      ${transcriptHtml(transcript)}

      <p style="color:#9ca3af;font-size:11px;margin-top:24px;">Generated automatically by GMeet Attendance Tracker.</p>
    </div>
  `;

  const text = [
    session.title || 'Google Meet',
    `${roster?.name || session.meetCode} · ${dateStr} · ${duration}`,
    '',
    'ATTENDANCE',
    attendanceRowsText(attendance || {}),
    '',
    'SUMMARY & MINUTES',
    minutesText(minutes),
    '',
    `TRANSCRIPT: ${transcript?.length || 0} lines captured (see HTML version for full text).`
  ].join('\n');

  return { subject, text, html };
}
