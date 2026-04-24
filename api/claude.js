// /api/claude — Vercel serverless function
// Proxies plan-generation and session-analysis calls to the Anthropic API so
// the API key never touches the browser. Called by the Sessions tab in
// index.html via POST /api/claude with body { action, payload }.

// Verified via web search on 2026-04-22:
// - Opus 4.7 released 2026-04-16 (https://www.anthropic.com/claude/opus)
// - Pricing ~$15/$75 per M tokens (https://claude.com/pricing)
const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 8192; // rule #4 floor

const PLAN_GEN_SYSTEM_PROMPT = `You orchestrate a Greek learning sprint for a user preparing for a Greece trip. Target capability: transactional Greek plus small-talk initiation.

Given the user's last 3 sessions (with fluency scores and weaknesses) and their target scenario for the next 30-minute session, build a focused plan.

Respond with VALID JSON ONLY. No markdown fences. No prose outside the JSON. The schema:

{
  "target_scenario": "<scenario_id from input>",
  "duration_minutes": 30,
  "vocab": [
    {"greek": "<Greek script>", "english": "<meaning>", "translit": "<latin-letter transliteration>", "example": "<short Greek sentence using it>"}
  ],
  "grammar": [
    {"point": "<grammar pattern>", "example": "<Greek example>"}
  ],
  "roleplay": {
    "setup": "<one-sentence scene setting>",
    "exchanges": [
      {"speaker": "waiter|local|you|tutor", "greek": "<Greek line>", "english": "<translation>"}
    ]
  }
}

Constraints: exactly 10 vocab items, exactly 2 grammar points, exactly 6 roleplay exchanges. Use informal singular "you" unless the scenario is formal (doctor, hotel complaint). Prioritize vocab and patterns that address the user's recent weaknesses.`;

const ANALYZE_SYSTEM_PROMPT = `You analyze Greek practice-session transcripts and extract structured feedback.

Respond with VALID JSON ONLY. No markdown fences. No prose outside the JSON. The schema:

{
  "fluency_score": <integer 1-10>,
  "weaknesses": {
    "vocab_gaps": ["<english description of word needed but missing>"],
    "grammar_errors": [{"pattern": "<what went wrong>", "example": "<quote or paraphrase>"}],
    "pronunciation_issues": ["<sound or pattern>"],
    "english_switches": [{"context": "<why they switched>", "count": <integer>}],
    "summary": "<2-3 sentence recap of the session>"
  },
  "new_vocab": [
    {"greek": "<Greek script>", "english": "<meaning>", "topic": "Restaurant|Transport|Greetings|Survival|Small Talk|Directions|Other", "source_quote": "<quote from transcript showing the word>"}
  ],
  "next_scenario": "<one of the 20 scenario ids provided in input>"
}

Scoring anchors: 1-3 beginner struggle and mostly English. 4-6 transactional with gaps and frequent switches. 7-8 confident transactional, rare switches. 9-10 relational, initiates topics in Greek. Extract 5-15 new vocab items — words the learner stumbled on OR heard from the tutor/partner and would benefit from.`;

function stripJsonFences(text) {
  let s = (text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  return s.trim();
}

function validatePlan(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  if (!Array.isArray(obj.vocab)) return 'vocab missing or not array';
  if (!Array.isArray(obj.grammar)) return 'grammar missing or not array';
  if (!obj.roleplay || !Array.isArray(obj.roleplay.exchanges)) return 'roleplay.exchanges missing';
  return null;
}

function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  if (typeof obj.fluency_score !== 'number') return 'fluency_score missing or not number';
  if (!obj.weaknesses || typeof obj.weaknesses !== 'object') return 'weaknesses missing';
  if (!Array.isArray(obj.new_vocab)) return 'new_vocab missing or not array';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // rule #4: handle undefined req.body
  const body = req.body || {};
  const { action, payload } = body;
  if (!action || !payload) {
    res.status(400).json({ error: 'missing_action_or_payload' });
    return;
  }
  if (action !== 'generate_plan' && action !== 'analyze_session') {
    res.status(400).json({ error: 'unknown_action', action });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_missing_api_key', hint: 'Set ANTHROPIC_API_KEY in Vercel project env vars.' });
    return;
  }

  const systemPrompt = action === 'generate_plan' ? PLAN_GEN_SYSTEM_PROMPT : ANALYZE_SYSTEM_PROMPT;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      }),
    });
  } catch (e) {
    res.status(502).json({ error: 'fetch_failed', message: String(e && e.message || e) });
    return;
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    res.status(502).json({ error: 'upstream_error', status: upstream.status, detail: errText.slice(0, 500) });
    return;
  }

  const apiData = await upstream.json();
  const textBlock = (apiData.content || []).find(c => c && c.type === 'text');
  const raw = textBlock ? textBlock.text : '';

  const cleaned = stripJsonFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    res.status(200).json({ error: 'invalid_json', raw: cleaned.slice(0, 2000) });
    return;
  }

  const validator = action === 'generate_plan' ? validatePlan : validateAnalysis;
  const schemaErr = validator(parsed);
  if (schemaErr) {
    res.status(200).json({ error: 'schema_mismatch', detail: schemaErr, data: parsed });
    return;
  }

  res.status(200).json({ ok: true, data: parsed, usage: apiData.usage || null });
};
