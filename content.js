// Content Script - Injected into Google Meet pages

(function () {
  'use strict';

  let inMeet = false;
  let meetCode = '';
  let participantPollInterval = null;
  let observerActive = false;

  const participantRootSelectors = [
    '[data-participant-id]',
    '[data-requested-participant-id]',
    '[data-self-name]',
    '[data-ssrc]'
  ];

  const blockedNames = new Set([
    'you',
    'people',
    'everyone',
    'present now',
    'meeting details',
    'host controls',
    'search for people',
    'leave call',
    'microphone',
    'camera',
    'more options',
    'captions',
    'chat with everyone',
    'raise hand',
    'backgrounds and effects',
    'devices',
    'frame_person',
    'reframe',
    'more_vert',
    'visual_effects',
    'others might still see your full video.',
    'turn on captions',
    'turn off captions',
    'presenting',
    'stop presenting',
    'mute',
    'unmute',
    'turn on camera',
    'turn off camera',
    'activities',
    'chat',
    'show everyone',
    'meeting details',
    'host controls',
    'more options',
    'hand raised',
    'lower hand',
    'whiteboard',
    'breakout rooms',
    'polls',
    'q&a',
    'recording',
    'transcripts',
    'attendance',
    'video'
  ]);

  function getMeetCode() {
    const match = location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return match ? match[1] : location.pathname.replace('/', '');
  }

  function getParticipants() {
    const participants = new Set();

    // 1. Primary: Use data attributes that are specifically for participants
    const roots = document.querySelectorAll(participantRootSelectors.join(','));
    roots.forEach((root) => {
      // Check for self-name
      const selfName = root.getAttribute('data-self-name');
      if (selfName) {
        addCandidate(selfName, participants);
      }

      // In tiles, names are usually in a dir="auto" element
      // We exclude buttons to avoid picking up "Mute Name" or "More options"
      root.querySelectorAll('[dir="auto"]').forEach(el => {
        if (!el.closest('button') && !el.closest('[role="button"]')) {
          addCandidate(el.textContent, participants);
        }
      });
    });

    // 2. People list in side panel
    document.querySelectorAll('[role="listitem"]').forEach(item => {
      // In the people list, the name is typically the first dir="auto"
      // that isn't part of a button's label
      const nameEl = item.querySelector('[dir="auto"]');
      if (nameEl && !nameEl.closest('button')) {
        addCandidate(nameEl.textContent, participants);
      }
    });

    // 3. Special case: Presenters
    document.querySelectorAll('[aria-label*=" is presenting"]').forEach((node) => {
      const label = node.getAttribute('aria-label');
      if (label) {
        const name = label.split(' is presenting')[0].trim();
        addCandidate(name, participants);
      }
    });

    return [...participants];
  }

  function addCandidate(rawValue, set) {
    const name = sanitizeParticipantName(rawValue);
    if (name) {
      set.add(name);
    }
  }

  function sanitizeParticipantName(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') {
      return '';
    }

    let name = rawValue
      .replace(/\s+/g, ' ')
      .replace(/\s+\(.*you.*\)$/i, '')
      .trim();

    // Check for doubled names (e.g., "NameName")
    if (name.length > 6) {
      const half = name.length / 2;
      if (Number.isInteger(half)) {
        const firstHalf = name.substring(0, half);
        const secondHalf = name.substring(half);
        if (firstHalf === secondHalf) {
          name = firstHalf;
        }
      }
    }

    // Filter out common UI prefixes/suffixes that might leak through
    const badPrefixes = ['mute ', 'stop ', 'pin ', 'remove ', 'more options for '];
    for (const p of badPrefixes) {
      if (name.toLowerCase().startsWith(p)) {
        name = name.substring(p.length).trim();
      }
    }

    // Basic length and character checks
    if (!name || name.length < 2 || name.length > 40 || !/[a-z]/i.test(name)) {
      return '';
    }

    // Reject sentences or long UI labels
    const words = name.split(' ');
    if (words.length > 4 || (words.length > 3 && name.includes('.'))) {
      return '';
    }

    const lower = name.toLowerCase();

    // Blocked list check
    if (blockedNames.has(lower)) {
      return '';
    }

    // Common UI patterns that are definitely not names
    const uiPatterns = [
      /^[a-z0-9_]+$/i,      // internal_names
      /^[a-z]{1,2}$/i,      // Initials (case-insensitive)
      /^(un)?mute(d)?$/i,
      /^camera (on|off)$/i,
      /^[0-9]+$/            // Just numbers
    ];

    if (uiPatterns.some(pattern => pattern.test(name))) {
      return '';
    }

    // Time patterns: "1m 09s", "49s", "1:20"
    if (/[0-9]+(s|m|h)/i.test(name) || /[0-9]:[0-9]/.test(name)) {
      return '';
    }

    // Blacklist of UI keywords
    const uiKeywords = [
      'options', 'settings', 'effects', 'backgrounds', 'presenting',
      'present now', 'details', 'controls', 'people', 'chat',
      'activities', 'microphone', 'camera', 'unmute', 'actions', 'your ',
      'you can\'t', 'hand', 'pin', 'remove', 'everyone', 'indicator'
    ];

    if (uiKeywords.some(kw => lower.includes(kw))) {
      return '';
    }

    // Names usually start with a letter and don't end with punctuation
    if (!/^[a-z]/i.test(name) || /[.!?,]$/.test(name)) {
      return '';
    }

    return name;
  }

  function detectMeetState() {
    const hasMeetCode = /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(location.pathname);
    if (!hasMeetCode) {
      return false;
    }

    const inCallIndicators = [
      '[aria-label="Leave call"]',
      '[data-tooltip="Leave call"]',
      '[role="button"][aria-label*="Leave"]',
      'button[aria-label*="microphone"]',
      'button[aria-label*="camera"]',
      '[class*="crqnQb"]',
      '[class*="NzPR9b"]',
      'div[data-is-presenter]'
    ];

    const isInCall = inCallIndicators.some((selector) => {
      try {
        return document.querySelector(selector) !== null;
      } catch {
        return false;
      }
    });

    console.log('[Attendance] Meet detection:', { hasMeetCode, isInCall });
    return hasMeetCode && isInCall;
  }

  function sendParticipantSnapshot() {
    const participants = getParticipants();
    chrome.runtime.sendMessage({
      type: 'PARTICIPANT_UPDATE',
      data: { participants }
    });
  }

  function startTracking() {
    if (inMeet) {
      return;
    }

    inMeet = true;
    meetCode = getMeetCode();

    chrome.runtime.sendMessage({
      type: 'MEET_JOINED',
      data: {
        meetCode,
        meetUrl: location.href,
        title: document.title || 'Google Meet'
      }
    });

    console.log('[Attendance] Tracking started for', meetCode);
    sendParticipantSnapshot();

    participantPollInterval = setInterval(() => {
      sendParticipantSnapshot();
    }, 3000);
  }

  function stopTracking() {
    if (!inMeet) {
      return;
    }

    inMeet = false;

    if (participantPollInterval) {
      clearInterval(participantPollInterval);
      participantPollInterval = null;
    }

    chrome.runtime.sendMessage({
      type: 'MEET_LEFT',
      data: { meetCode }
    });

    console.log('[Attendance] Tracking stopped for', meetCode);
  }

  function startObserver() {
    if (observerActive || !document.body) {
      return;
    }

    observerActive = true;

    const observer = new MutationObserver(() => {
      const nowInMeet = detectMeetState();
      if (nowInMeet && !inMeet) {
        startTracking();
      } else if (!nowInMeet && inMeet) {
        stopTracking();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'data-call-ended']
    });
  }

  window.addEventListener('beforeunload', () => {
    if (inMeet) {
      stopTracking();
    }
  });

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (inMeet && !detectMeetState()) {
        stopTracking();
      }
    }
  }).observe(document, { subtree: true, childList: true });

  if (detectMeetState()) {
    startTracking();
    startObserver();
  } else {
    setTimeout(() => {
      if (detectMeetState()) {
        startTracking();
      }
      startObserver();
    }, 1000);
  }
})();
