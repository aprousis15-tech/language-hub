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

// Sonnet 4.6 — story generation is routine content work, not planning or
// roadmap-level reasoning. Sonnet's quality is indistinguishable from Opus
// for "write a 5-sentence A2 Greek story with vocab notes and questions",
// and it's 5x cheaper (~$3/month vs $15/month at daily runs).
// Senior-level planning (coach agent, session plan/analysis) stays on Opus.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

const STORY_SYSTEM_PROMPT = `You write daily Greek-learning short stories for an English-speaking adult learner preparing for a Greece trip. Target proficiency: A2 (intermediate-beginner). Read time: under 60 seconds.

You will receive a JSON payload:
{ "date": "YYYY-MM-DD", "level": "A2" }

Generate a FRESH original story (not a famous tale, not a translation of a famous English story). Pick a relatable everyday topic: a coffee at a café, a walk through a neighborhood, ordering food at a taverna, missing a bus, meeting a neighbor, finding a small shop, getting directions, a quick phone call. Vary topics across dates so the learner doesn't see the same scene twice in a week — use the date input to seed variety.

Constraints:
- EXACTLY 5 sentences.
- Mostly PRESENT tense and SIMPLE PAST (aorist). Minimize subjunctive.
- Each sentence 6-14 words.
- A2 vocabulary only: common everyday words. No literary forms.
- Clear narrative arc: setup → small event → resolution. Don't end mid-scene.
- Use first-person ("I") or third-person ("Maria / a woman / the waiter") — pick one and stay consistent.

Vocabulary notes (5 entries):
- Pull words FROM the story that an A2 learner might not know, OR words with notable grammar (gender markers, irregular plural/aorist, common phrase idioms).
- Each note short and useful — ≤ 14 words.

Comprehension questions (3):
- Test LITERAL reading comprehension. No inference, no opinion.
- Question text in English. Answer in Greek + English gloss.

Respond with VALID JSON ONLY. No markdown fences. No prose outside the JSON. Schema:

{
  "title_greek": "<short Greek title — 2-5 words>",
  "title_english": "<English gloss of title>",
  "level": "A2",
  "topic": "<one-word topic descriptor: 'cafe' | 'market' | 'bus' | 'phone' | 'directions' | 'meal' | 'shop' | 'neighbor' | 'walk' | 'beach' | ...>",
  "sentences": [
    { "greek": "<sentence in Greek>", "english": "<faithful English translation>" }
  ],
  "vocab_notes": [
    { "greek": "<word as it appears in the story>", "english": "<meaning>", "note": "<short grammar/usage note>" }
  ],
  "questions": [
    { "q": "<English question>", "a_greek": "<one-sentence Greek answer>", "a_english": "<English gloss>", "hint": "<one key Greek word from the story>" }
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
    level:         story.level || 'A2',
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

async function generateStoryViaClaude(date) {
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
      messages: [{ role: 'user', content: JSON.stringify({ date, level: 'A2' }) }],
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
  return parsed;
}

module.exports = async function handler(req, res) {
  const date = todayET();
  const force = req.method === 'POST' || (req.url && req.url.includes('regenerate=1'));

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

    const generated = await generateStoryViaClaude(date);
    const inserted = await insertStory(date, generated);
    res.status(200).json({ ok: true, story: inserted, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
