// /api/claude — Vercel serverless function
// Proxies plan-generation and session-analysis calls to the Anthropic API so
// the API key never touches the browser. Called by the Sessions tab in
// index.html via POST /api/claude with body { action, payload }.

// Model choice by action — keeps Opus for senior-level planning/analysis,
// drops Sonnet on routine per-attempt grading.
// - Opus 4.7  ($15/$75 per M): generate_plan + analyze_session — both require
//   strategic reasoning across multiple data points.
// - Sonnet 4.6 ($3/$15 per M): grade_speaking — single-sentence pass/fix call,
//   runs many times per session, doesn't need Opus's depth. ~5x cost savings
//   at typical usage with no observable quality change in grading.
const MODEL_PLANNING = 'claude-opus-4-7';
const MODEL_GRADING  = 'claude-sonnet-4-6';
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

// grade_speaking: grade ONE Greek sentence produced from an English prompt.
// Input payload: { english_prompt, model_answer, target_grammar, transcript }
// transcript is what the browser's SpeechRecognition heard.
// Output: tight feedback — one correction max, echo the model so the learner
// can compare. Keep the prose short; the drill is fast-pace.
const GRADE_SPEAKING_SYSTEM_PROMPT = `You grade a single Greek sentence a learner spoke from an English prompt.

You will receive a JSON payload:
{
  "english_prompt": "<the English sentence the learner saw>",
  "model_answer":   "<the target Greek sentence>",
  "target_grammar": "<the specific grammar move being tested, e.g. 'aorist of διαβάζω' or 'σε + accusative plural'>",
  "transcript":     "<what the speech-to-text heard the learner say>"
}

GRADING PHILOSOPHY: The goal is REAL-LIFE INTELLIGIBILITY. The question you are answering is: "If the learner said this in a café in Athens, would a native Greek speaker understand them and NOT correct them?" If yes → pass. If no → fix. That's the bar. Not orthographic exactness. Not perfect pronunciation. Just: would they be understood.

Be GENEROUSLY FORGIVING. This is a mobile speaking drill where the STT regularly mangles audio AND the learner is mid-acquisition. Default heavily to "pass" — mark "fix" only when the target grammar move was demonstrably attempted with the WRONG structure (wrong tense, wrong case, wrong person, wrong verb root), OR the meaning is fundamentally different from the prompt.

PHONETIC PROXIMITY RULE (the most important one): If a word the learner produced SOUNDS CLOSE to the target word — close enough that a Greek speaker would understand it in conversation — count it as correct. The bar is "would a Greek person understand this and not correct me?", not "does the transcript match character-for-character?".

Words sound CLOSE when they differ by:
- One vowel (θέλο vs θέλω, καφές vs καφέ, νερώ vs νερό)
- One consonant (θέλω vs δέλω, μπορώ vs μπορό)
- Misplaced stress (καφέ vs κάφε — the wrong syllable is stressed but it's recognizable)
- Slight mispronunciation that the STT captured literally (θέλο, ξέρω vs ξέρο, αγαπό vs αγαπάω, παρακαλό vs παρακαλώ)
- Dropped final syllable (παρακαλώ → παρακαλ, ευχαριστώ → ευχαρι)
- A verb ending that's the wrong person but only by one letter and the meaning is unambiguous from context (θέλει for θέλω — only fix if the person error materially changes meaning)

All of the above → PASS. The learner is being understood. Real-world Greeks fill in the rest.

Transcription artifacts to SILENTLY IGNORE (treat as if the learner said it correctly):
1. **Latin/English transliteration.** "Tello Cafe" → reconstruct as "Θέλω καφέ". "thelo nero parakalo" → "Θέλω νερό παρακαλώ". "kalimera" → "Καλημέρα". If you can phonetically map the Latin chars back to the Greek target, do so and grade the reconstruction. Common mappings: th/d→θ/δ, ch/h→χ, ps→ψ, x→ξ, ou→ου, ai→αι, ei→ει, oi→οι.
2. **English homophone/near-homophone substitution.** Whisper sometimes substitutes English words that SOUND like the Greek. "I love" for "αγαπάω", "telo" for "θέλω", "boro" for "μπορώ", "yes" for "ναι", "nay" for "ναι". If the English word phonetically matches a Greek word in the target, count it as the Greek word.
3. **Missing/wrong accents and diacritics.** πού/που, ή/η, ώ/ω — never penalize.
4. **Final σ/ς confusion** — transcription artifact.
5. **Greek homophones** that the STT can't disambiguate without context (σε/σαι, η/ή/οι, μη/μην).
6. **Joined or split words, missing punctuation, capitalization.**
7. **Extra filler at edges** ("um", "uh", "okay", repeated word at the start while the mic warmed up).
8. **Partial transcript** where the last word is cut off but the target grammar already happened earlier in the sentence.

When in doubt: PASS. Always pass. The learner is practicing speaking, not typing or pronouncing perfectly. If a reasonable Greek-speaking listener in a café would understand them, pass.

Mark "fix" ONLY when:
- The learner used the WRONG grammatical structure (e.g., present tense when prompt required aorist, nominative when accusative was required, masculine when feminine was required) — and the structural error is unambiguous, not a one-letter sound-alike.
- OR the sentence conveys a fundamentally different meaning that no STT artifact or phonetic slip could explain.

If you pass a sentence that contained a near-miss pronunciation (sound-alike that worked), include a SHORT pronunciation note in `grammar_note` so the learner improves over time — e.g., "Heard 'kafés' — that's καφές (nominative). In 'I want coffee' use accusative καφέ. Understood in conversation, but worth tightening." Keep it gentle and encouraging.

Give ONE specific correction at most. Tie it to target_grammar. Don't pile on stylistic nitpicks.
Echo the model_answer back so the learner sees the ideal form even when correct.

If you reconstructed Latin transcript into Greek to grade, mention this briefly in the headline so the learner knows it counted ("Heard as Latin — read as Θέλω καφέ. Pass.").

OBSERVATIONS — capture every notable thing, even on a pass:
For every grading, also produce a `weaknesses_observed` array of structured micro-observations. This data feeds a long-term learning agent — be specific and consistent.

Every entry has the shape:
{
  "type": "pronunciation" | "stress" | "vowel" | "consonant" | "case" | "tense" | "person" | "number" | "gender" | "vocab" | "word_order" | "article" | "preposition",
  "description": "<one-line description of the issue>",
  "expected": "<the Greek form/sound that should have been produced>",
  "heard": "<what the learner actually produced>"
}

- On a clean pass with no notable issues → empty array `[]`.
- On a near-miss pass (you applied the phonetic proximity rule) → 1-3 observations describing the slips (pronunciation/stress/vowel/etc).
- On a fix → 1-3 observations focused on the structural error that caused the fail.

SEVERITY — assign exactly one:
- "fail"  → score is "fix" (structural error, not understood by a native speaker)
- "note"  → score is "pass" BUT there were 1+ observed weaknesses worth noting (near-miss pronunciation, wrong case but understood, stress slip, etc.)
- "clean" → score is "pass" AND weaknesses_observed is empty (clean, natural-sounding production)

Respond with VALID JSON ONLY. No markdown fences. No prose outside the JSON. Schema:

{
  "score": "pass" | "fix",
  "severity": "fail" | "note" | "clean",
  "headline": "<one short sentence — what they did right OR the single thing to fix>",
  "correction": "<the specific correction if score=fix, otherwise null. Quote the wrong fragment and give the right one.>",
  "model_echo": "<model_answer verbatim>",
  "grammar_note": "<one-line reminder of the rule for target_grammar — always present, helps reinforce>",
  "weaknesses_observed": [
    { "type": "<one of the enum values above>", "description": "<...>", "expected": "<...>", "heard": "<...>" }
  ]
}`;

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

function validateGrading(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  if (obj.score !== 'pass' && obj.score !== 'fix') return 'score must be "pass" or "fix"';
  if (typeof obj.headline !== 'string') return 'headline missing';
  if (typeof obj.model_echo !== 'string') return 'model_echo missing';
  // Backfill new fields if the model omitted them (e.g., transient prompt drift)
  // so older clients don't break and the logger always has something to write.
  if (obj.severity !== 'fail' && obj.severity !== 'note' && obj.severity !== 'clean') {
    obj.severity = obj.score === 'fix' ? 'fail' : 'clean';
  }
  if (!Array.isArray(obj.weaknesses_observed)) obj.weaknesses_observed = [];
  // If pass + non-empty observations, upgrade clean → note
  if (obj.severity === 'clean' && obj.weaknesses_observed.length > 0) obj.severity = 'note';
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
  if (action !== 'generate_plan' && action !== 'analyze_session' && action !== 'grade_speaking') {
    res.status(400).json({ error: 'unknown_action', action });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_missing_api_key', hint: 'Set ANTHROPIC_API_KEY in Vercel project env vars.' });
    return;
  }

  const systemPrompt =
    action === 'generate_plan'   ? PLAN_GEN_SYSTEM_PROMPT :
    action === 'grade_speaking'  ? GRADE_SPEAKING_SYSTEM_PROMPT :
    ANALYZE_SYSTEM_PROMPT;

  // grade_speaking is the routine per-attempt call → Sonnet. Everything else
  // is strategic (plan generation, session analysis) → Opus.
  const model = action === 'grade_speaking' ? MODEL_GRADING : MODEL_PLANNING;

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
        model,
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

  const validator =
    action === 'generate_plan'   ? validatePlan :
    action === 'grade_speaking'  ? validateGrading :
    validateAnalysis;
  const schemaErr = validator(parsed);
  if (schemaErr) {
    res.status(200).json({ error: 'schema_mismatch', detail: schemaErr, data: parsed });
    return;
  }

  res.status(200).json({ ok: true, data: parsed, usage: apiData.usage || null });
};
