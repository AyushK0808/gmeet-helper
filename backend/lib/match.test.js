// Minimal dependency-free test for match.js. Run with: node backend/lib/match.test.js
const assert = require('assert');
const { normalize, similarity, matchParticipantToMember, computeAttendance } = require('./match');

// --- normalize ---
assert.strictEqual(normalize('Ayush Kumar (You)'), 'ayush kumar');
assert.strictEqual(normalize('  AYUSH   Kumar  '), 'ayush kumar');
assert.strictEqual(normalize('José García'), 'jose garcia');
assert.strictEqual(normalize(''), '');
assert.strictEqual(normalize(undefined), '');

// --- similarity ---
assert.ok(similarity('Ayush Kumar', 'Kumar Ayush') > 0.99, 'word order should not matter');
assert.ok(similarity('Ayush Kumar', 'ayush k') > 0.3);
assert.strictEqual(similarity('', 'Ayush'), 0);

// --- matchParticipantToMember ---
const members = [
  { name: 'Ayush Kumar', email: 'ayush@example.com', aliases: [] },
  { name: 'Priya Singh', email: 'priya@example.com', aliases: ['P Singh'] }
];

assert.strictEqual(matchParticipantToMember('Ayush Kumar', members).method, 'exact');
assert.strictEqual(matchParticipantToMember('P Singh', members).method, 'alias');
assert.strictEqual(matchParticipantToMember('Kumar Ayush', members).method, 'fuzzy'); // reordered words
// A short/partial name like "Ayush K" deliberately falls below the fuzzy
// threshold - this is by design: it lands in the "unknown" bucket so a human
// assigns it to a member once, which the roster then remembers as an alias.
assert.strictEqual(matchParticipantToMember('Ayush K', members), null);
assert.strictEqual(matchParticipantToMember('Totally Unknown Person', members), null);

// --- computeAttendance ---
const roster = {
  attendanceThresholdPct: 50,
  members: [
    { name: 'Ayush Kumar', email: 'ayush@example.com', aliases: [] },
    { name: 'Priya Singh', email: 'priya@example.com', aliases: [] }
  ]
};

const session = {
  joinTime: 0,
  leaveTime: 100000, // 100s session
  participants: {
    p1: { name: 'Kumar Ayush', totalTime: 60000 }, // 60%, reordered words -> present
    p2: { name: 'Priya Singh', totalTime: 20000 }, // 20% -> partial
    p3: { name: 'Random Guest', totalTime: 5000 }  // unmatched -> unknown
  }
};

const attendance = computeAttendance(roster, session);
assert.strictEqual(attendance.present.length, 1);
assert.strictEqual(attendance.present[0].name, 'Ayush Kumar');
assert.strictEqual(attendance.partial.length, 1);
assert.strictEqual(attendance.partial[0].name, 'Priya Singh');
assert.strictEqual(attendance.absent.length, 0);
assert.strictEqual(attendance.unknown.length, 1);
assert.strictEqual(attendance.unknown[0].name, 'Random Guest');

console.log('match.test.js: all assertions passed');
