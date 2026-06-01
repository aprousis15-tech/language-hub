// /api/vocab/daily-run — Vercel serverless function
// Generates the day's 5 new vocab picks. Cron-fired at 4am ET; safe to call
// manually with ?force=1. Idempotent — if today's picks exist and ?force=1
// is NOT passed, returns the cached row without burning tokens.
//
// Strategy:
//   1. Read recent vocab from Supabase to build a duplicate-avoidance list.
//   2. Read recent mistakes from public.mistakes for weakness signal.
//   3. Read recent speak_observations for spoken-pattern signal.
//   4. Call Groq Llama 3.3 70B (free tier) to pick 5 fresh, A2-level Greek
//      words with a STRONG intuition hook for each (etymology, cognates,
//      sound-alikes, visuals).
//   5. Insert each new word into public.vocab.
//   6. Record the picks in public.daily_vocab_picks for the dashboard card.
//
// Env vars:
//   GROQ_API_KEY — required, already set in Vercel (originally for Whisper).
//
// Cost: $0/mo on Groq free tier. Llama 3.3 70B: 30 RPM / 14,400 RPD free
// quota — one daily call uses ~0.007% of daily budget. Structured JSON via
// response_format. Quality is strong for vocabulary curation + memory hooks;
// the only thing Sonnet was meaningfully better at on this task was occasional
// wittier mnemonics — not worth the $/mo.

const MODEL = 'llama-3.3-70b-versatile';
const MAX_TOKENS = 3000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

const SYSTEM_PROMPT = `You are a Greek-language vocabulary curator picking 5 fresh A2-level words each day for an English-speaking learner preparing for a Greece trip. The learner already has hundreds of words logged; your job is to add 5 NEW, useful ones with an unusually memorable hook for each.

You will receive a JSON payload:
{
  "date":              "YYYY-MM-DD",
  "existing_words":    [ "word", ... ],     // Greek words already in their vocab — DO NOT duplicate
  "recent_mistakes":   [ { drill_type, prompt, correct, picked } ],
  "recent_weaknesses": [ { type, description, expected, heard } ]
}

PICK CRITERIA (in priority order):
1. NOT already in existing_words — strict deduplication.
2. A2 level — common everyday words a learner would actually USE in Greece (food, travel, daily routine, family, health, weather, emotions, social phrases). Avoid literary, scientific, or super-rare words.
3. Fill GAPS suggested by recent_mistakes / recent_weaknesses — if they keep missing a verb form or noun gender, pick a related word.
4. VARIETY across the 5 picks — don't pick 5 nouns; mix verbs, nouns, adjectives, common phrases. Vary topics (not all "food").

FOR EACH WORD provide the strongest possible memory hook. Hierarchy:
  a) Etymology / English cognate (best)  — e.g., "βιβλίο" → "same root as English bibliography"
  b) Sound-alike mnemonic                — e.g., "πόρτα" sounds like English "porter" — the door-keeper
  c) Visual association
  d) Connection to a word the learner already knows
Pick whichever lands hardest. The hook should make the word stick after one read.

Respond with VALID JSON ONLY. No markdown fences, no prose outside the JSON. Schema:
{
  "why_picked": "<2-3 sentences explaining why these 5 specifically, citing patterns from the mistakes data if relevant>",
  "picks": [
    {
      "word":          "<Greek word>",
      "translation":   "<English meaning>",
      "phonetic":      "<simple latin-letter pronunciation, e.g. THEH-lo>",
      "part_of_speech":"verb | noun | adjective | adverb | phrase | preposition | pronoun",
      "topic":         "Restaurant | Transport | Greetings | Survival | Small Talk | Directions | Health | Family | Weather | Emotions | Time | Other",
      "intuition":     "<the killer memory hook — 1-3 sentences, specific and vivid. NO generic 'this means X' filler>"
    }
  ]
}

EXACTLY 5 picks. No more, no fewer.`;

function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function stripJsonFences(text) {
  let s = (text || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  return s.trim();
}

async function supaFetch(path, init = {}) {
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

async function readCachedPicks(date) {
  const r = await supaFetch(`daily_vocab_picks?pick_date=eq.${date}&select=*&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function deleteCachedPicks(date) {
  await supaFetch(`daily_vocab_picks?pick_date=eq.${date}`, { method: 'DELETE' });
}

async function fetchExistingWords() {
  // Pull just the `word` column to keep the prompt lean. 719+ rows total.
  const r = await supaFetch('vocab?select=word&lang=eq.greek&limit=2000');
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows.map(r => r.word).filter(Boolean) : [];
}

async function fetchRecentMistakes(days = 14, limit = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const r = await supaFetch(
    `mistakes?select=drill_type,prompt,correct,picked&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=${limit}`
  );
  if (!r.ok) return [];
  return await r.json();
}

async function fetchRecentWeaknesses(days = 7, limit = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const r = await supaFetch(
    `speak_observations?select=weaknesses_observed&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=${limit}`
  );
  if (!r.ok) return [];
  const rows = await r.json();
  // Flatten all the per-row weaknesses_observed arrays
  const flat = [];
  rows.forEach(row => {
    if (Array.isArray(row.weaknesses_observed)) flat.push(...row.weaknesses_observed);
  });
  return flat.slice(0, limit);
}

async function callGenerator(date, existing, mistakes, weaknesses) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('server_missing_groq_key');

  const payload = {
    date,
    existing_words: existing,
    recent_mistakes: mistakes,
    recent_weaknesses: weaknesses
  };

  // Groq uses the OpenAI chat-completions schema: system + user messages,
  // model + max_tokens at top level. response_format: { type: 'json_object' }
  // enforces clean JSON output so we never need to strip markdown fences.
  const upstream = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: JSON.stringify(payload) }
      ]
    })
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`groq_upstream_error: ${upstream.status} ${detail.slice(0, 300)}`);
  }
  const apiData = await upstream.json();
  const raw = apiData.choices && apiData.choices[0] &&
              apiData.choices[0].message && apiData.choices[0].message.content;
  if (!raw) throw new Error('groq_empty_response');
  const parsed = JSON.parse(stripJsonFences(raw));
  if (!parsed || !Array.isArray(parsed.picks) || parsed.picks.length === 0) {
    throw new Error('schema_mismatch: picks missing or empty');
  }
  return parsed;
}

async function insertVocabRow(pick) {
  // Insert into vocab; return the id so we can record it in daily_vocab_picks.
  const row = {
    word:           pick.word,
    translation:    pick.translation,
    phonetic:       pick.phonetic || null,
    intuition:      pick.intuition || null,
    part_of_speech: pick.part_of_speech || null,
    topic:          pick.topic || null,
    lang:           'greek'
  };
  const r = await supaFetch('vocab', {
    method: 'POST',
    headers: { 'prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`vocab_insert_failed: ${r.status} ${detail.slice(0, 200)}`);
  }
  const rows = await r.json();
  const inserted = Array.isArray(rows) ? rows[0] : rows;
  return inserted && inserted.id;
}

async function recordDailyPick(date, ids, picks, whyPicked) {
  const row = {
    pick_date:     date,
    vocab_ids:     ids,
    picks_snapshot: picks,
    why_picked:    whyPicked || null
  };
  const r = await supaFetch('daily_vocab_picks', {
    method: 'POST',
    headers: { 'prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`daily_pick_insert_failed: ${r.status} ${detail.slice(0, 200)}`);
  }
  return (await r.json())[0];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Opt-out kill-switch — symmetric with the coach
  if (process.env.DAILY_VOCAB_DISABLED === 'true') {
    res.status(200).json({ ok: false, skipped: true, reason: 'DAILY_VOCAB_DISABLED env var is true.' });
    return;
  }

  const date = todayET();
  const force = (req.url && req.url.includes('force=1')) || (req.query && req.query.force === '1');

  try {
    // Idempotency: skip if today's picks exist unless ?force=1
    if (!force) {
      const cached = await readCachedPicks(date);
      if (cached) {
        res.status(200).json({
          ok: true, date, cached: true,
          picks: cached.picks_snapshot,
          why_picked: cached.why_picked,
          note: 'Today\'s picks already exist. Pass ?force=1 to regenerate.'
        });
        return;
      }
    } else {
      await deleteCachedPicks(date);
    }

    // Build context for the picker
    const [existing, mistakes, weaknesses] = await Promise.all([
      fetchExistingWords(),
      fetchRecentMistakes(),
      fetchRecentWeaknesses()
    ]);

    // Generate
    const startedAt = Date.now();
    const result = await callGenerator(date, existing, mistakes, weaknesses);

    // Insert each pick into vocab; collect ids
    const ids = [];
    for (const pick of result.picks) {
      try {
        const id = await insertVocabRow(pick);
        if (id) ids.push(id);
      } catch (e) {
        // Don't blow up the whole run on one bad insert; log and continue.
        console.warn('vocab insert failed for', pick && pick.word, e && e.message);
      }
    }

    // Record the daily pick row
    const dailyRow = await recordDailyPick(date, ids, result.picks, result.why_picked);

    res.status(200).json({
      ok: true,
      date,
      cached: false,
      inserted_count: ids.length,
      picks: result.picks,
      why_picked: result.why_picked,
      daily_pick_id: dailyRow && dailyRow.id,
      duration_ms: Date.now() - startedAt
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      date,
      error: String(e && e.message || e)
    });
  }
};

// Vercel function config: bump duration past 10s default; Sonnet call usually
// finishes in 5-15s but Supabase reads add a few hundred ms.
module.exports.config = { maxDuration: 60 };
