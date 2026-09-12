// Gmail send helper - classic script, loaded into the service worker via
// importScripts() in background.js. Exposes gmailGetToken() and gmailSend()
// on the global scope.

/**
 * Get (or refresh) an OAuth token with the gmail.send scope.
 * Only pass interactive:true from a user-initiated action (e.g. a popup
 * button click) - Chrome will otherwise silently fail or, worse, prompt
 * unexpectedly from a background timer.
 */
function gmailGetToken({ interactive } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'No token returned'));
        return;
      }
      resolve(token);
    });
  });
}

function gmailRemoveCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/**
 * Base64url-encode a UTF-8 string (Gmail's `raw` field requires this, not
 * plain base64 - '+' -> '-', '/' -> '_', and no padding).
 */
function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 2047 encoded-word for a subject that may contain non-ASCII characters.
 */
function encodeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) {
    return subject;
  }
  const b64 = base64UrlEncode(subject).replace(/-/g, '+').replace(/_/g, '/');
  // Re-pad since base64UrlEncode strips padding, and RFC 2047 wants standard base64.
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return `=?UTF-8?B?${padded}?=`;
}

function buildMimeMessage({ to, subject, text, html }) {
  const boundary = `gmeet_helper_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toHeader = Array.isArray(to) ? to.join(', ') : to;

  const lines = [
    `To: ${toHeader}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundary}--`
  ];

  return lines.join('\r\n');
}

/**
 * Send an email via the Gmail API as the signed-in user. Retries once on a
 * 401 after clearing the cached token (the token may have expired/been
 * revoked between acquisition and send).
 */
async function gmailSend({ token, to, subject, text, html }) {
  const raw = base64UrlEncode(buildMimeMessage({ to, subject, text, html }));

  const doSend = (authToken) =>
    fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw })
    });

  let response = await doSend(token);

  if (response.status === 401) {
    await gmailRemoveCachedToken(token);
    const freshToken = await gmailGetToken({ interactive: true });
    response = await doSend(freshToken);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gmail send failed (${response.status}): ${errBody}`);
  }

  const result = await response.json();
  return result.id;
}
