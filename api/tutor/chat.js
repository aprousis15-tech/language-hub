// /api/tutor/chat — Vercel serverless function
// Proxies a voice-tutor conversation turn to Google Gemini 2.5 Flash via the
// free-tier API. Multi-provider AI: Anthropic stays on the existing Sonnet/Opus
// endpoints for senior planning + grading; Gemini handles the new high-volume
// conversation feature so cost stays at $0/mo within the free tier.
//
// Free-tier limits: ~1,500 requests/day on Gemini 2.5 Flash. At ~10 turns per
// conversation that's headroom for ~150 conversations/day — well beyond any
// personal-use rate.
//
// Env vars used:
//   GEMINI_API_KEY  — required, free at https://aistudio.google.com
//
// Request: POST /api/tutor/chat
//   {
//     scenario:      "cafe" | "taverna" | "taxi" | "hotel" | "market" |
//                    "dad"  | "doctor"  | "free",
//     history:       [{ role: "user" | "model", text: "..." }],
//     user_text:     "what the learner just said (transcribed from Whisper)",
//     learner_name:  "Anthony"        // optional, personalizes the AI's tone
//   }
//
// Response:
//   {
//     ok: true,
//     reply_greek:   "AI's Greek response — what gets spoken via TTS",
//     reply_english: "English gloss so the learner can verify meaning",
//     correction:    "<optional gentle correction of the user's last turn>",
//     scenario_status: "ongoing" | "resolved",
//     usage: { ... }
//   }

const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SCENARIOS = {
  cafe: {
    label: '☕ Café',
    setup: "You are Παναγιώτης, a friendly Greek barista at a kafenio in Athens. The learner walks in and you greet them. Your goal: take their order (coffee, water, snack), make a little small-talk about their day, and bring it to them.",
    persona: "warm, casual, uses Athens slang like λέμε, βέβαια, εντάξει. Slightly older neighborhood barista who's seen everyone."
  },
  taverna: {
    label: '🍽️ Taverna',
    setup: "You are Μαρία, a server at a family taverna in Plaka. The learner has just sat down. You greet them, hand them a (mental) menu, recommend the day's special, take their order, and chat briefly about Greek food.",
    persona: "warm, motherly, proud of the food, gently corrective when they mispronounce dish names. Will suggest moussaka if they're hesitating."
  },
  taxi: {
    label: '🚕 Taxi',
    setup: "You are Νίκος, an Athens taxi driver. The learner has just gotten in. You ask where they're headed, comment on the route, ask if they're a tourist, and chat about Athens.",
    persona: "talkative, opinionated about traffic and politics, peppers in some 'ρε φίλε'. Slightly impatient with English — pushes the learner to keep going in Greek."
  },
  hotel: {
    label: '🏨 Hotel',
    setup: "You are Δήμητρα, a hotel front-desk clerk. The learner is checking in. You greet them, ask for their reservation name, walk them through breakfast/wifi/checkout, and answer any practical questions.",
    persona: "polite, formal (uses εσείς), efficient. Professional Greek with clear enunciation. Helpful with practical tourist questions."
  },
  market: {
    label: '🛒 Market',
    setup: "You are Γιάννης, a vendor at the Athens central market (laiki). The learner approaches your stall (produce, cheese, or olives — your choice). You greet them, describe what you have, suggest something seasonal, and haggle a little.",
    persona: "loud, enthusiastic, uses lots of imperatives (έλα, δες, δοκίμασε). Proud of his goods. Knows everyone."
  },
  dad: {
    label: '👨 Your Dad',
    setup: "You are the learner's Greek father, calling them on the phone. You are warm, slightly worried, and want to hear about their day. You ask about their work, what they ate, whether they slept well, and slip in some Greek life advice.",
    persona: "warm, classic Greek dad — caring, opinionated, gives unsolicited advice (πρέπει να..., μη ξεχάσεις...), uses παιδί μου and γιε μου. Switches topics quickly."
  },
  doctor: {
    label: '🏥 Doctor',
    setup: "You are Δρ Παπαδόπουλος, a general practitioner in Athens. The learner has come in with a minor complaint. You greet them, ask what's wrong, follow up with clarifying questions, and propose a simple treatment.",
    persona: "professional, calm, uses εσείς. Asks one question at a time. Clear A2-friendly Greek with the medical vocab spelled out."
  },
  free: {
    label: '💬 Free talk',
    setup: "You are a friendly Greek conversation partner. The learner just wants to chat — about their day, their family, Greece, music, food, anything. You take an active role: ask follow-up questions, share your own brief opinions, and keep them talking.",
    persona: "warm, curious, encouraging. Adjusts topics based on what the learner brings up. Like texting with a Greek friend who has unlimited patience."
  }
};

function buildSystemPrompt(scenarioKey, learnerName) {
  const sc = SCENARIOS[scenarioKey] || SCENARIOS.free;
  const name = learnerName || 'the learner';
  return `You are an interactive Greek-language conversation tutor playing a specific role for an English-speaking learner named ${name}. The learner is at A2 (intermediate-beginner) level, preparing for a trip to Greece.

ROLE: ${sc.setup}

PERSONA: ${sc.persona}

CONVERSATION RULES:
1. Speak in GREEK by default. ${name} needs the practice.
2. Keep your Greek at A2 level — common everyday words, present + simple past tense mostly. Avoid literary forms.
3. Each of your turns is 1-3 short sentences max. This is a CONVERSATION, not a monologue.
4. Ask follow-up questions to keep the learner producing language.
5. If the learner makes a grammar mistake, do NOT correct it inline — keep the conversation natural. Instead, populate the "correction" field (see schema below) with a short, kind correction the UI will show on the side.
6. If the learner says something in English or is clearly stuck, gently nudge them back to Greek with a hint (e.g., "Πες το στα ελληνικά — try: …").
7. Stay in character. Don't break the fourth wall.

SCENARIO PROGRESSION:
- Move the scenario forward — order taken, room booked, ride completed, story heard.
- After 6-10 user turns, naturally wrap up the scene (e.g., "Καλή απόλαυση!" "Καλό σας ταξίδι!") and set scenario_status to "resolved".
- Until then, keep scenario_status as "ongoing".

OUTPUT — respond with VALID JSON ONLY. No markdown fences, no prose outside the JSON:
{
  "reply_greek":     "<your Greek line(s), 1-3 short sentences>",
  "reply_english":   "<faithful English translation of reply_greek>",
  "correction":      "<short kind correction of the learner's last Greek turn, or null if no correction is needed. Format: 'Heard: <what they said>. Try: <fix>.'>",
  "scenario_status": "ongoing" | "resolved"
}`;
}

function safeJsonExtract(text) {
  // Gemini may wrap in markdown fences or add a stray newline. Strip and try.
  let s = (text || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const firstBrace = s.indexOf('{');
  const lastBrace  = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      ok: false,
      error: 'missing_gemini_key',
      hint: 'Set GEMINI_API_KEY in Vercel env vars. Free key at https://aistudio.google.com.'
    });
    return;
  }

  const body = req.body || {};
  const scenario    = typeof body.scenario === 'string' ? body.scenario : 'free';
  const history     = Array.isArray(body.history) ? body.history : [];
  const userText    = (body.user_text || '').toString().trim();
  const learnerName = body.learner_name || 'Anthony';

  if (!SCENARIOS[scenario]) {
    res.status(400).json({ ok: false, error: 'unknown_scenario', valid: Object.keys(SCENARIOS) });
    return;
  }

  // Build Gemini contents: scenario history + current user turn. Gemini's
  // multi-turn format uses role "user" and "model" entries with "parts".
  const contents = [];
  history.forEach(h => {
    if (!h || !h.text) return;
    const role = (h.role === 'model' || h.role === 'assistant') ? 'model' : 'user';
    contents.push({ role, parts: [{ text: String(h.text) }] });
  });
  if (userText) contents.push({ role: 'user', parts: [{ text: userText }] });
  if (contents.length === 0) {
    // Cold start — the user opened the tab and hit Start before saying anything.
    // Send an empty user turn so the agent opens the scenario.
    contents.push({ role: 'user', parts: [{ text: '(Conversation begins — greet the learner and open the scene.)' }] });
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(scenario, learnerName) }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 600,
      responseMimeType: 'application/json'
    },
    // Gemini safety settings — relaxed for conversational roleplay. Defaults
    // are aggressive enough to block ordinary Greek conversation about food
    // (the word "πιοτά" / drinks sometimes triggers). These settings are
    // recommended by Google for conversational agents.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',      threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  let upstream;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'fetch_failed', message: String(e && e.message || e) });
    return;
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    res.status(502).json({
      ok: false,
      error: 'gemini_upstream_error',
      status: upstream.status,
      detail: rawText.slice(0, 500)
    });
    return;
  }

  let apiData;
  try { apiData = JSON.parse(rawText); }
  catch (e) {
    res.status(502).json({ ok: false, error: 'gemini_invalid_response', detail: rawText.slice(0, 500) });
    return;
  }

  const candidate = apiData.candidates && apiData.candidates[0];
  if (!candidate) {
    res.status(502).json({ ok: false, error: 'no_candidate', detail: apiData });
    return;
  }
  // Safety blocks return finishReason without content
  if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
    res.status(502).json({
      ok: false,
      error: 'gemini_blocked',
      finishReason: candidate.finishReason,
      safetyRatings: candidate.safetyRatings || null
    });
    return;
  }

  const replyText = (candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) || '';
  let parsed;
  try { parsed = safeJsonExtract(replyText); }
  catch (e) {
    res.status(200).json({
      ok: false,
      error: 'parse_failed',
      raw: replyText.slice(0, 800)
    });
    return;
  }

  res.status(200).json({
    ok: true,
    reply_greek:     parsed.reply_greek || '',
    reply_english:   parsed.reply_english || '',
    correction:      parsed.correction || null,
    scenario_status: parsed.scenario_status === 'resolved' ? 'resolved' : 'ongoing',
    usage: apiData.usageMetadata || null
  });
};
