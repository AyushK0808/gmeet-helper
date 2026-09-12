// Builds the transcript-to-minutes prompt. Kept separate from llm.js so the
// prompt text can be iterated on without touching provider wiring.

function formatTranscript(lines) {
  if (!lines || lines.length === 0) {
    return '(no transcript captured for this meeting)';
  }
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
}

function buildMinutesPrompt({ session, transcript, rosterMemberNames }) {
  const memberList = (rosterMemberNames || []).length
    ? rosterMemberNames.join(', ')
    : '(no roster provided - use names as they appear in the transcript)';

  return [
    `You are producing minutes for a Google Meet meeting titled "${session.title || session.meetCode}".`,
    `Known attendees on the roster: ${memberList}.`,
    'When assigning an owner to an action item, use one of the known attendees whenever the transcript makes the owner clear. Do not invent a person who is not in the transcript or roster.',
    '',
    'Transcript:',
    formatTranscript(transcript),
    '',
    'Produce structured meeting minutes from this transcript: a short overall summary, the topics discussed with a brief note on each, any decisions made, action items (with an owner and, if mentioned, a due date), and any open questions left unresolved. If the transcript is empty or too short to summarize, say so plainly in the summary field rather than inventing content.'
  ].join('\n');
}

module.exports = { buildMinutesPrompt };
