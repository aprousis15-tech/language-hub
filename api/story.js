// /api/story — Vercel serverless function
// Returns today's Greek learning story. If one isn't cached for today's date
// in public.daily_stories, generates one via Claude and inserts it. "Today"
// is computed in America/New_York so the story rolls over at midnight ET.
//
// GET  /api/story          → returns today's story (generates if missing)
// POST /api/story          → force-regenerates today's story (replaces cache)
//
// Env vars used:
//   ANTHROPIC_API_KEY — required, calls Claude
//
// Supabase access goes through the public REST API with the publishable
// anon key (same key the browser uses). The daily_stories table has a
// permissive RLS policy. No service-role key needed.
//
// LEVEL: B1 (upgraded from A2 on 2026-06-01).
// TYPES: cycle through 6 styles so every day brings a different shape of
// Greek (narrative, anecdote, dialogue, scenario, reflection, cultural).
// SETTINGS: each day also gets a rotating scene/topic hint, on a longer
// cycle than the type rotation, so the type×setting pairing keeps shifting
// and stories don't cluster around cafes and tavernas. Helps the learner
// adapt to varied input rather than the same handful of scenes.

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

// The full set of distinct styles. The daily type advances by date so
// consecutive days always differ and all six get equal airtime (the old
// day-of-week mapping locked each weekday to one type and gave narrative
// twice as often).
const ALL_TYPES = ['narrative', 'anecdote', 'dialogue', 'scenario', 'reflection', 'cultural'];

// A broad pool of scenes/topics to steer each day's piece somewhere fresh.
// Length is coprime-ish with ALL_TYPES (29 vs 6) so the type×setting combo
// effectively never repeats across a sensible span of days.
const SETTINGS = [
  'a ferry crossing to an island', 'a mountain village in summer',
  'a λαϊκή (open-air street market)', 'a pharmacy with a minor problem',
  'a bakery at dawn', 'a football match on TV with friends',
  'a name-day (γιορτή) celebration', 'a summer power cut in the heat',
  'an early bus to the airport', "a grandmother's kitchen",
  'a second-hand bookshop', 'a swim at a rocky beach',
  'a taxi stuck in Athens traffic', 'a περίπτερο (street kiosk)',
  'an olive harvest in the countryside', 'a rooftop on a hot night',
  'a wedding in the χωριό (village)', 'a long hospital waiting room',
  'a hike up a gorge', 'a phone call with a parent',
  'a rainy afternoon in Thessaloniki', 'a flea market full of junk and treasure',
  'learning to cook a family dish', 'a dispute with a noisy neighbour',
  'a missed train and a change of plans', 'an archaeological museum visit',
  'a fishing trip at sunrise', 'a school reunion after many years',
  'a cat that adopts the narrator',
];

function epochDay(date) {
  // date is YYYY-MM-DD; anchor at noon UTC to avoid DST edge cases.
  return Math.floor(Date.parse(date + 'T12:00:00Z') / 86400000);
}
function mod(n, m) { return ((n % m) + m) % m; }

function pickTypeForDate(date) {
  return ALL_TYPES[mod(epochDay(date), ALL_TYPES.length)];
}
function pickSettingForDate(date) {
  return SETTINGS[mod(epochDay(date), SETTINGS.length)];
}

function pickRandomType(avoid) {
  const pool = avoid ? ALL_TYPES.filter(t => t !== avoid) : ALL_TYPES;
  return pool[Math.floor(Math.random() * pool.length)];
}
function pickRandomSetting(avoid) {
  const pool = avoid ? SETTINGS.filter(s => s !== avoid) : SETTINGS;
  return pool[Math.floor(Math.random() * pool.length)];
}

const STORY_SYSTEM_PROMPT = `You write daily Greek-learning short pieces for an English-speaking adult learner preparing for a Greece trip. Target proficiency: B1 (intermediate). Read time: 60-90 seconds.

You will receive a JSON payload:
{ "date": "YYYY-MM-DD", "level": "B1", "type": "<one of: narrative | anecdote | dialogue | scenario | reflection | cultural>", "setting": "<a scene/topic hint, e.g. 'a ferry crossing to an island'>" }

VARIETY (important — the learner reads one of these every day):
- Build the piece around the "setting" hint when one is given. Don't drift back to the default cafe/taverna/ordering-coffee scene unless the setting actually calls for it.
- Rotate names and characters widely. Draw on the full range of Greek names (Νίκος, Ελένη, Θανάσης, Δέσποινα, Κωστής, Αγγελική, Σταύρος, Φωτεινή, Μανώλης, Βάσω, ο παππούς, η γιαγιά, ένας ξένος…), not always Μαρία and Γιάννης.
- Vary the emotional register and outcome: not every piece is pleasant — some can be awkward, funny, frustrating, bittersweet, or surprising.

Generate a FRESH original piece matching the specified TYPE:

📖 narrative  — Third-person mini-story with a clear arc (setup → event → resolution). Named character (Μαρία, Γιάννης, ο σερβιτόρος). Flash-fiction vignette.

💬 anecdote   — First-person personal anecdote ("I", "we"). A small recent experience: a missed bus, a kind stranger, an unexpected meal, a misunderstanding. Conversational tone.

🎭 dialogue   — Short 2-person exchange in a scene (taverna, taxi, hotel, market, phone call). 1 short opening sentence setting the scene (no speaker), then 5-7 lines of dialogue. Each dialogue line MUST have a speaker field "Α" or "Β" (Greek capital alpha/beta — two letters representing the two characters).

🎯 scenario   — Second-person situational ("Είσαι στο καφέ. Η σερβιτόρα σε ρωτάει..."). Puts the learner inside the scene. Use second-person singular informal verb forms (-εις, -άς).

💭 reflection — First-person musing on a topic: a memory of summer, what a Greek word means to me, a small life observation. Personal, slightly thoughtful tone.

🏛️ cultural   — Short non-fiction piece about a Greek tradition, place, food, holiday, or saying. Informative tone. Examples: "Why Greeks eat lamb at Easter", "The story of Mastiha from Chios", "Greek table customs for a first-time visitor".

B1 LEVEL CONSTRAINTS (all types):
- 6-8 sentences (dialogue: 1 setup + 5-7 turns = 6-8 lines total).
- Each sentence 8-18 words.
- Use a VARIED mix of tenses: present, simple past (aorist), imperfect, future (θα), perfect (έχω + perfective). Subjunctive (να) is encouraged where natural.
- Subordinate clauses (που, όταν, επειδή, αν, παρόλο που, ενώ) encouraged where they fit.
- Some idiomatic expressions where natural ("να σου πω", "δεν πειράζει", "πάει καλά", "με τίποτα").
- Vocabulary: B1-level common words (e.g., παρόλο, σχεδόν, ξαφνικά, χάρηκα, στενοχωρήθηκα, ψυχραιμία). Avoid literary or scientific terms.
- Clear arc, ends naturally — don't trail off mid-thought.

Vocabulary notes (5 entries):
- Pull words FROM the piece. Prioritize B1-flagging items: idioms, irregular aorists, subjunctive uses, less-common everyday words, words with notable grammar.
- Each note short and useful (≤ 18 words).

Comprehension questions (3):
- For narrative/anecdote/dialogue/scenario: LITERAL reading comprehension.
- For reflection/cultural: mix — 2 literal + 1 "what is the main point" question.
- Question text in English. Answer in Greek + English gloss.

Respond with VALID JSON ONLY. No markdown fences. No prose outside the JSON. Schema:

{
  "title_greek":  "<short Greek title — 2-5 words>",
  "title_english":"<English gloss of title>",
  "level":        "B1",
  "type":         "<matches the input type verbatim>",
  "topic":        "<one-word topic descriptor: 'cafe' | 'market' | 'bus' | 'phone' | 'directions' | 'meal' | 'shop' | 'neighbor' | 'walk' | 'beach' | 'easter' | 'name-day' | 'family' | ...>",
  "sentences": [
    {
      "greek":   "<sentence in Greek>",
      "english": "<faithful English translation>",
      "speaker": "<for dialogue type ONLY: 'Α' or 'Β'; for the opening setup line, omit or null; for all other types, omit or null>"
    }
  ],
  "vocab_notes": [
    { "greek": "<word as it appears>", "english": "<meaning>", "note": "<short grammar/usage note>" }
  ],
  "questions": [
    { "q": "<English question>", "a_greek": "<one-sentence Greek answer>", "a_english": "<English gloss>", "hint": "<one key Greek word from the piece>" }
  ]
}`;

function todayET() {
  // en-CA locale formats as YYYY-MM-DD, which matches Postgres DATE input.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function stripJsonFences(text) {
  let s = (text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  // Embedded fenced JSON inside prose — extract first fenced block that parses.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const candidate = fenced[1].trim();
    try { JSON.parse(candidate); return candidate; } catch {}
  }
  // Last-resort: first { to last } slice.
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const candidate = s.slice(first, last + 1);
    try { JSON.parse(candidate); return candidate; } catch {}
  }
  return s.trim();
}

function validateStory(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  if (!Array.isArray(obj.sentences) || obj.sentences.length === 0) return 'sentences missing';
  if (!Array.isArray(obj.vocab_notes)) return 'vocab_notes missing';
  if (!Array.isArray(obj.questions)) return 'questions missing';
  return null;
}

async function supabaseFetch(path, init = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function readCachedStory(date) {
  const r = await supabaseFetch(`daily_stories?story_date=eq.${date}&select=*&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function deleteCachedStory(date) {
  await supabaseFetch(`daily_stories?story_date=eq.${date}`, { method: 'DELETE' });
}

async function insertStory(date, story) {
  const row = {
    story_date:    date,
    level:         story.level || 'B1',
    type:          story.type || null,
    title_greek:   story.title_greek || null,
    title_english: story.title_english || null,
    topic:         story.topic || null,
    sentences:     story.sentences,
    vocab_notes:   story.vocab_notes || [],
    questions:     story.questions || []
  };
  const r = await supabaseFetch('daily_stories', {
    method: 'POST',
    headers: { 'prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`supabase_insert_failed: ${r.status} ${detail.slice(0, 200)}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function generateStoryViaClaude(date, type, setting) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('server_missing_api_key');
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: STORY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify({ date, level: 'B1', type, setting }) }],
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`anthropic_upstream_error: ${upstream.status} ${detail.slice(0, 300)}`);
  }
  const apiData = await upstream.json();
  const textBlock = (apiData.content || []).find(c => c && c.type === 'text');
  const raw = textBlock ? textBlock.text : '';
  const parsed = JSON.parse(stripJsonFences(raw));
  const schemaErr = validateStory(parsed);
  if (schemaErr) throw new Error(`schema_mismatch: ${schemaErr}`);
  // Guarantee level + type are correct on the persisted row even if the
  // model omitted or modified them.
  parsed.level = 'B1';
  parsed.type = type;
  return parsed;
}

module.exports = async function handler(req, res) {
  const date = todayET();
  const force = req.method === 'POST' || (req.url && req.url.includes('regenerate=1'));
  // "fresh" = an extra on-demand story the user pulled via the "🔀 Another
  // story" button. We generate it but DON'T touch the daily cache, so the
  // learner can read as many fresh stories as they like without losing (or
  // having to regenerate) today's canonical story. No DB schema change needed.
  const fresh = !!(req.url && /[?&]fresh=1/.test(req.url));

  // Allow explicit ?type=dialogue to override the rotation (useful for
  // manual testing or "I want a dialogue today" requests).
  const urlTypeMatch = (req.url || '').match(/[?&]type=([a-z]+)/i);
  const overrideType = urlTypeMatch && ALL_TYPES.includes(urlTypeMatch[1].toLowerCase())
    ? urlTypeMatch[1].toLowerCase() : null;

  try {
    // Fresh path: random style (avoid repeating today's rotation type so it
    // feels different), generate, return ephemeral — never cached.
    if (fresh) {
      const type = overrideType || pickRandomType(pickTypeForDate(date));
      const setting = pickRandomSetting(pickSettingForDate(date));
      const generated = await generateStoryViaClaude(date, type, setting);
      res.status(200).json({ ok: true, story: { ...generated, story_date: date }, cached: false, fresh: true, type });
      return;
    }

    const type = overrideType || pickTypeForDate(date);
    const setting = pickSettingForDate(date);
    if (!force) {
      const cached = await readCachedStory(date);
      if (cached) {
        res.status(200).json({ ok: true, story: cached, cached: true });
        return;
      }
    } else {
      await deleteCachedStory(date);
    }

    const generated = await generateStoryViaClaude(date, type, setting);
    const inserted = await insertStory(date, generated);
    res.status(200).json({ ok: true, story: inserted, cached: false, type });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
