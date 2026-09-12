// Canonical name normalization + roster<->participant matching.
// Pure and deterministic on purpose - this is the piece most worth unit
// testing (see backend/lib/match.test.js).

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Normalize a display name for matching: lowercase, strip diacritics, drop
 * parenthetical suffixes like "(You)" or "(Guest)", collapse whitespace.
 * Supersedes the old normalizeName() in background.js, which only lowercased
 * and underscored spaces (too weak for cross-session alias matching).
 */
function normalize(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/\s*\([^)]*\)\s*/g, ' ') // drop "(You)", "(Guest)", etc.
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenSet(name) {
  return new Set(normalize(name).split(' ').filter(Boolean));
}

/**
 * Token-set similarity (Jaccard index over word sets). Order-independent,
 * so "kumar ayush" still matches "ayush kumar".
 */
function similarity(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  setA.forEach((tok) => { if (setB.has(tok)) intersection++; });

  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Match one observed participant display name against a roster's members.
 * Tries exact normalized name, then alias, then token-set similarity.
 * Returns the matching member object (with its index) or null.
 */
function matchParticipantToMember(participantName, members) {
  const normalizedObserved = normalize(participantName);
  if (!normalizedObserved) return null;

  for (let i = 0; i < members.length; i++) {
    if (normalize(members[i].name) === normalizedObserved) {
      return { member: members[i], index: i, method: 'exact' };
    }
  }

  for (let i = 0; i < members.length; i++) {
    const aliases = members[i].aliases || [];
    if (aliases.some((alias) => normalize(alias) === normalizedObserved)) {
      return { member: members[i], index: i, method: 'alias' };
    }
  }

  let best = null;
  for (let i = 0; i < members.length; i++) {
    const score = similarity(participantName, members[i].name);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { member: members[i], index: i, method: 'fuzzy', score };
    }
  }
  return best;
}

/**
 * Compute attendance for a roster against one session's participants object
 * ({ [key]: { name, totalTime, leaveTime, joinTime, sessions } }).
 *
 * Verdict: present / partial / absent, based on totalTime vs
 * attendanceThresholdPct% of the session's total duration.
 */
function computeAttendance(roster, session) {
  const members = roster?.members || [];
  const thresholdPct = roster?.attendanceThresholdPct ?? 50;
  const sessionDuration = (session.leaveTime || Date.now()) - session.joinTime;
  const thresholdMs = sessionDuration * (thresholdPct / 100);

  const participants = Object.values(session.participants || {});
  const timeByMemberIndex = new Map();
  const namesByMemberIndex = new Map();
  const unknown = [];

  participants.forEach((p) => {
    const match = matchParticipantToMember(p.name, members);
    if (match) {
      timeByMemberIndex.set(match.index, (timeByMemberIndex.get(match.index) || 0) + (p.totalTime || 0));
      const names = namesByMemberIndex.get(match.index) || [];
      names.push(p.name);
      namesByMemberIndex.set(match.index, names);
    } else {
      unknown.push({ name: p.name, timeInCallMs: p.totalTime || 0 });
    }
  });

  const memberResults = members.map((member, memberIndex) => {
    const timeInCallMs = timeByMemberIndex.get(memberIndex) || 0;

    let verdict = 'absent';
    if (thresholdMs > 0 && timeInCallMs >= thresholdMs) verdict = 'present';
    else if (timeInCallMs > 0) verdict = 'partial';

    return {
      name: member.name,
      email: member.email,
      timeInCallMs,
      matchedNames: namesByMemberIndex.get(memberIndex) || [],
      verdict
    };
  });

  return {
    present: memberResults.filter((m) => m.verdict === 'present'),
    partial: memberResults.filter((m) => m.verdict === 'partial'),
    absent: memberResults.filter((m) => m.verdict === 'absent'),
    unknown
  };
}

module.exports = { normalize, similarity, matchParticipantToMember, computeAttendance };
