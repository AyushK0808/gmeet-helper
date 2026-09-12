// LLM provider abstraction for generating meeting minutes. Selected by
// LLM_PROVIDER in backend/.env - 'anthropic' (default) or 'groq'.
const { z } = require('zod');
const { buildMinutesPrompt } = require('./prompt');

const MinutesSchema = z.object({
  summary: z.string(),
  topics: z.array(z.object({ title: z.string(), discussion: z.string() })),
  decisions: z.array(z.string()),
  actionItems: z.array(z.object({
    owner: z.string(),
    task: z.string(),
    dueDate: z.string().nullable()
  })),
  openQuestions: z.array(z.string())
});

async function generateMinutesAnthropic({ session, transcript, rosterMemberNames }) {
  // Lazy require so a missing/unused dependency doesn't break the groq path.
  const Anthropic = require('@anthropic-ai/sdk');
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  const prompt = buildMinutesPrompt({ session, transcript, rosterMemberNames });

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: zodOutputFormat(MinutesSchema) }
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Anthropic refused the request: ${response.stop_details?.category || 'unknown reason'}`);
  }

  if (!response.parsed_output) {
    throw new Error('Anthropic returned no parsed output');
  }

  return response.parsed_output;
}

async function generateMinutesGroq({ session, transcript, rosterMemberNames }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const prompt = buildMinutesPrompt({ session, transcript, rosterMemberNames });
  const schemaHint = JSON.stringify({
    summary: 'string',
    topics: [{ title: 'string', discussion: 'string' }],
    decisions: ['string'],
    actionItems: [{ owner: 'string', task: 'string', dueDate: 'string|null' }],
    openQuestions: ['string']
  }, null, 2);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Respond with ONLY a JSON object matching this shape:\n${schemaHint}` },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Groq request failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error('Groq returned no content');
  }

  const parsed = JSON.parse(raw);
  const result = MinutesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Groq output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Generate structured meeting minutes from a transcript.
 * @param {{session: object, transcript: Array, rosterMemberNames: string[]}} input
 * @returns {Promise<{summary, topics, decisions, actionItems, openQuestions}>}
 */
function emptyMinutes(summary) {
  return {
    summary,
    topics: [],
    decisions: [],
    actionItems: [],
    openQuestions: []
  };
}

// True once a usable API key is present for the configured provider - lets
// callers show the transcript instead of a hard error when nothing is set up.
function isMinutesGenerationEnabled() {
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  if (provider === 'groq') return !!process.env.GROQ_API_KEY;
  return !!process.env.ANTHROPIC_API_KEY;
}

async function generateMinutes(input) {
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

  if (!input.transcript || input.transcript.length === 0) {
    return {
      ...emptyMinutes('No transcript was captured for this meeting, so minutes could not be generated.'),
      disabled: false
    };
  }

  if (!isMinutesGenerationEnabled()) {
    return {
      ...emptyMinutes('Minutes generation is disabled (no LLM API key configured). See the transcript below for the raw meeting record.'),
      disabled: true
    };
  }

  if (provider === 'groq') {
    return generateMinutesGroq(input);
  }
  return generateMinutesAnthropic(input);
}

module.exports = { generateMinutes, MinutesSchema, isMinutesGenerationEnabled };
