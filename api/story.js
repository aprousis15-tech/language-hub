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
// TYPES: rotate weekly through 6 styles so every day brings a different
// shape of Greek (narrative, anecdote, dialogue, scenario, reflection,
// cultural). Helps the learner adapt to varied input rather than only
// flat-narrative prose.

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

// Weekly type rotation. Day-of-week (UTC of noon-of-date) → type.
//   Sun=narrative · Mon=anecdote · Tue=dialogue · Wed=scenario
//   Thu=reflection · Fri=cultural · Sat=narrative
// Same day-of-week always gives the same type, so the user can build
// expectations ("Wednesday means a scenario prompt").
const TYPE_ROTATION = ['narrative', 'anecdote', 'dialogue', 'scenario', 'reflection', 'cultural', 'narrative'];

function pickTypeForDate(date) {
  // date is YYYY-MM-DD. Anchor at noon UTC to avoid DST edge cases.
  const d = new Date(date + 'T12:00:00Z');
  return TYPE_ROTATION[d.getUTCDay()];
}

const STORY_SYSTEM_PROMPT = `You write daily Greek-learning short pieces for an English-speaking adult learner preparing for a Greece trip. Target proficiency: B1 (intermediate). Read time: 60-90 seconds.

You will receive a JSON payload:
{ "date": "YYYY-MM-DD", "level": "B1", "type": "<one of: narrative | anecdote | dialogue | scenario | reflection | cultural>" }

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

async function generateStoryViaClaude(date, type) {
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
      messages: [{ role: 'user', content: JSON.stringify({ date, level: 'B1', type }) }],
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

  // Allow explicit ?type=dialogue to override the rotation (useful for
  // manual testing or "I want a dialogue today" requests).
  const urlTypeMatch = (req.url || '').match(/[?&]type=([a-z]+)/i);
  const overrideType = urlTypeMatch && TYPE_ROTATION.includes(urlTypeMatch[1].toLowerCase())
    ? urlTypeMatch[1].toLowerCase() : null;
  const type = overrideType || pickTypeForDate(date);

  try {
    if (!force) {
      const cached = await readCachedStory(date);
      if (cached) {
        res.status(200).json({ ok: true, story: cached, cached: true });
        return;
      }
    } else {
      await deleteCachedStory(date);
    }

    const generated = await generateStoryViaClaude(date, type);
    const inserted = await insertStory(date, generated);
    res.status(200).json({ ok: true, story: inserted, cached: false, type });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
