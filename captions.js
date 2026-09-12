// Content Script - Live caption capture for Google Meet transcripts.
// Runs alongside content.js as a separate content script so the participant
// scraper stays untouched. Everything here is self-contained.

(function () {
  'use strict';

  const FLUSH_INTERVAL_MS = 10000;
  const FLUSH_LINE_THRESHOLD = 20;
  const FINALIZE_IDLE_MS = 2500;

  // Ordered candidate selectors for the caption region. Meet's class names are
  // obfuscated and churn across releases - try the stable ARIA selector first,
  // then known jsnames/classes as fallbacks.
  const CAPTION_REGION_SELECTORS = [
    '[role="region"][aria-label*="aption" i]',
    'div[jsname="dsyhDe"]',
    '.a4cQT'
  ];

  const SPEAKER_SELECTORS = ['.zs7s8d', '.NWpY1d'];
  const TEXT_SELECTORS = ['.bh44bd', '.ygicle', '.iTTPOb'];

  let regionEl = null;
  let regionObserver = null;
  let resolvedTier = null;

  // element -> { speaker, text, tStart, lastMutation, seq, finalizeTimer }
  const blockState = new WeakMap();
  // Elements with unfinalized state, tracked separately since WeakMap isn't
  // iterable - needed to force-finalize everything when capture stops.
  const pendingBlocks = new Set();
  let seqCounter = 0;

  let outboundBuffer = [];
  let flushTimer = null;
  let captureActive = false;

  // ─── Region resolution ────────────────────────────────────────────────────

  function resolveCaptionRegion() {
    for (let i = 0; i < CAPTION_REGION_SELECTORS.length; i++) {
      const el = document.querySelector(CAPTION_REGION_SELECTORS[i]);
      if (el) {
        resolvedTier = i;
        return el;
      }
    }
    return null;
  }

  window.__gmeetHelperSelfTest = function () {
    const region = resolveCaptionRegion();
    const report = {
      regionFound: !!region,
      tier: resolvedTier,
      tierSelector: resolvedTier != null ? CAPTION_REGION_SELECTORS[resolvedTier] : null,
      captureActive
    };
    console.log('[Captions] Self-test:', report);
    return report;
  };

  // ─── Text extraction ──────────────────────────────────────────────────────

  function firstMatch(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && el.textContent && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return null;
  }

  function extractBlock(blockEl) {
    let speaker = firstMatch(blockEl, SPEAKER_SELECTORS);
    let text = firstMatch(blockEl, TEXT_SELECTORS);

    if (speaker && text) {
      return { speaker, text };
    }

    // Positional fallback: first non-empty text node/child is the speaker,
    // remaining text is the utterance.
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });

    const chunks = [];
    let node;
    while ((node = walker.nextNode())) {
      chunks.push(node.textContent.trim());
    }

    if (chunks.length === 0) return null;
    if (chunks.length === 1) {
      return { speaker: speaker || 'Unknown', text: chunks[0] };
    }
    return { speaker: speaker || chunks[0], text: text || chunks.slice(1).join(' ') };
  }

  // ─── Rolling de-duplication ───────────────────────────────────────────────

  function handleBlockUpdate(blockEl) {
    const extracted = extractBlock(blockEl);
    if (!extracted || !extracted.text) return;

    const now = Date.now();
    let state = blockState.get(blockEl);

    if (!state) {
      state = {
        speaker: extracted.speaker,
        text: extracted.text,
        tStart: now,
        lastMutation: now,
        seq: seqCounter++,
        finalizeTimer: null
      };
      blockState.set(blockEl, state);
      pendingBlocks.add(blockEl);
    } else {
      const oldText = state.text;
      const newText = extracted.text;

      if (newText.startsWith(oldText)) {
        // Growth - append the new tail.
        state.text = newText;
      } else if (oldText.startsWith(newText)) {
        // Shrink (rare) - ASR retracted trailing words. Keep the longer text
        // seen so far; do nothing.
      } else {
        // ASR revision - replace wholesale, do not append.
        state.text = newText;
      }

      state.speaker = extracted.speaker || state.speaker;
      state.lastMutation = now;
    }

    scheduleFinalize(blockEl, state);
  }

  function scheduleFinalize(blockEl, state) {
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
    }
    state.finalizeTimer = setTimeout(() => {
      finalizeBlock(blockEl);
    }, FINALIZE_IDLE_MS);
  }

  function finalizeBlock(blockEl) {
    const state = blockState.get(blockEl);
    if (!state || state.finalized) return;

    state.finalized = true;
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = null;
    }
    pendingBlocks.delete(blockEl);

    pushLine({
      speaker: state.speaker,
      text: state.text,
      tStart: state.tStart,
      tEnd: Date.now(),
      seq: state.seq
    });
  }

  function pushLine(line) {
    outboundBuffer.push(line);
    if (outboundBuffer.length >= FLUSH_LINE_THRESHOLD) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (outboundBuffer.length === 0) return;

    const lines = outboundBuffer;
    outboundBuffer = [];

    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_CHUNK',
      data: { lines }
    });
  }

  function finalizeAllPending() {
    // Force-finalize anything still tracked (e.g. capture stopping mid-utterance).
    Array.from(pendingBlocks).forEach((blockEl) => finalizeBlock(blockEl));
  }

  // ─── Auto-enable captions ─────────────────────────────────────────────────

  function tryEnableCaptions() {
    const ccButton = document.querySelector('button[aria-label*="captions" i][aria-pressed="false"]');
    if (ccButton) {
      ccButton.click();
      console.log('[Captions] Auto-enabled captions');
      return true;
    }
    // Already on, or button not found yet.
    const alreadyOn = document.querySelector('button[aria-label*="captions" i][aria-pressed="true"]');
    return !!alreadyOn;
  }

  // ─── Consent banner ───────────────────────────────────────────────────────

  function showConsentBanner() {
    if (document.getElementById('gmeet-helper-consent-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'gmeet-helper-consent-banner';
    banner.textContent = 'This meeting is being transcribed for automated minutes.';
    banner.style.cssText = [
      'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'background:#202124', 'color:#fff',
      'font-family:Google Sans,Roboto,Arial,sans-serif', 'font-size:13px',
      'padding:8px 16px', 'border-radius:8px', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
      'display:flex', 'align-items:center', 'gap:12px'
    ].join(';');

    const dismiss = document.createElement('span');
    dismiss.textContent = '✕';
    dismiss.style.cssText = 'cursor:pointer;opacity:0.7;';
    dismiss.addEventListener('click', () => banner.remove());
    banner.appendChild(dismiss);

    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 15000);
  }

  // ─── Capture lifecycle, driven by settings + meet join/leave ─────────────

  function startCapture() {
    if (captureActive) return;

    chrome.storage.local.get(
      { autoEnableCaptions: true, showConsentBanner: true },
      (settings) => {
        if (settings.autoEnableCaptions) {
          let attempts = 0;
          const tryInterval = setInterval(() => {
            attempts++;
            if (tryEnableCaptions() || attempts > 10) {
              clearInterval(tryInterval);
            }
          }, 1000);
        }

        if (settings.showConsentBanner) {
          showConsentBanner();
        }
      }
    );

    regionEl = resolveCaptionRegion();
    if (!regionEl) {
      // Region not present yet (captions not on / not rendered). Poll for it.
      const waitInterval = setInterval(() => {
        regionEl = resolveCaptionRegion();
        if (regionEl) {
          clearInterval(waitInterval);
          attachObserver();
        }
      }, 1500);

      setTimeout(() => {
        clearInterval(waitInterval);
        if (!regionEl) {
          chrome.runtime.sendMessage({ type: 'CAPTIONS_UNAVAILABLE', data: {} });
        }
      }, 20000);
      captureActive = true;
      return;
    }

    captureActive = true;
    attachObserver();
  }

  function attachObserver() {
    if (!regionEl || regionObserver) return;

    regionObserver = new MutationObserver((mutations) => {
      const touchedBlocks = new Set();
      mutations.forEach((m) => {
        let node = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
        if (node && regionEl.contains(node)) {
          // Walk up to the direct child of the region (one caption block).
          while (node.parentElement && node.parentElement !== regionEl) {
            node = node.parentElement;
          }
          if (node !== regionEl) touchedBlocks.add(node);
        }
        m.addedNodes.forEach((added) => {
          if (added.nodeType === Node.ELEMENT_NODE && regionEl.contains(added)) {
            let n = added;
            while (n.parentElement && n.parentElement !== regionEl) {
              n = n.parentElement;
            }
            if (n !== regionEl) touchedBlocks.add(n);
          }
        });
        m.removedNodes.forEach((removed) => {
          if (removed.nodeType === Node.ELEMENT_NODE && blockState.has(removed)) {
            finalizeBlock(removed);
          }
        });
      });

      touchedBlocks.forEach((block) => handleBlockUpdate(block));
    });

    regionObserver.observe(regionEl, { childList: true, subtree: true, characterData: true });

    // Capture whatever is already on screen.
    Array.from(regionEl.children).forEach((child) => handleBlockUpdate(child));
  }

  function stopCapture() {
    if (!captureActive) return;
    captureActive = false;

    if (regionObserver) {
      regionObserver.disconnect();
      regionObserver = null;
    }

    finalizeAllPending();
    flush();
  }

  window.addEventListener('beforeunload', () => {
    stopCapture();
  });

  // Coordinate with content.js's lifecycle via runtime messages it broadcasts.
  // content.js doesn't currently broadcast internally, so caption capture
  // uses its own lightweight in-call detection to start/stop independently.
  function detectInCall() {
    const hasMeetCode = /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(location.pathname);
    if (!hasMeetCode) return false;
    return !!document.querySelector('[aria-label="Leave call"], [data-tooltip="Leave call"], [role="button"][aria-label*="Leave"]');
  }

  let wasInCall = false;
  setInterval(() => {
    const inCall = detectInCall();
    if (inCall && !wasInCall) {
      startCapture();
    } else if (!inCall && wasInCall) {
      stopCapture();
    }
    wasInCall = inCall;
  }, 2000);
})();
