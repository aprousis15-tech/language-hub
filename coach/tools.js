// coach/tools.js — Tool definitions + implementations for the study-coach agent.
//
// The agent operates with these tools:
//   query_speak_observations  → reads speak_observations (every speak attempt)
//   query_recent_mistakes     → reads mistakes (cross-drill weakness signal)
//   query_recent_sessions     → reads sessions (italki/dad/self-practice notes)
//   save_plan                 → writes a row to coach_plans
//
// Supabase access uses the publishable anon key (same key the browser uses).
// All RLS policies on these tables are permissive — fine for a single-user
// personal app. Lock down with service-role + RLS in multi-user world.

const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

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

// ── Tool schemas (passed to Claude). Names must match toolImplementations keys.

const tools = [
  {
    name: 'query_speak_observations',
    description: 'Read recent Speak-drill observations. Every speak attempt is logged here with severity (fail/note/clean) and a structured weaknesses_observed array. Use this as the PRIMARY signal for what to drill — it has fine-grained pronunciation, case, tense, and other micro-issue data per attempt.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look back this many days. Default 7.' },
        severity: { type: 'string', enum: ['fail', 'note', 'clean'], description: 'Optional filter by severity.' },
        limit:    { type: 'number', description: 'Max rows. Default 200.' }
      }
    }
  },
  {
    name: 'query_recent_mistakes',
    description: 'Read recent mistakes from non-Speak drills (articles, verbs, etc.). Use this for cross-drill weakness signal — a learner who keeps getting accusative wrong in the article drill probably also fails accusative in speak.',
    input_schema: {
      type: 'object',
      properties: {
        days:       { type: 'number', description: 'Look back this many days. Default 14.' },
        drill_type: { type: 'string', description: 'Optional filter (e.g., "articles", "verbs"). Default: all non-speak drills.' },
        limit:      { type: 'number', description: 'Max rows. Default 200.' }
      }
    }
  },
  {
    name: 'query_recent_sessions',
    description: 'Read recent practice sessions (italki, dad, self-practice). Use this for context on what scenarios the learner has covered, what their fluency_score is, and what weaknesses were noted.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows. Default 5.' }
      }
    }
  },
  {
    name: 'save_plan',
    description: 'Save the day\'s plan to public.coach_plans. Call this LAST, exactly once, with the full plan you authored. The frontend reads from this table to render Today\'s Plan.',
    input_schema: {
      type: 'object',
      properties: {
        plan_date:     { type: 'string', description: 'YYYY-MM-DD. Provided in your initial task message — use that exact value.' },
        focus_areas:   {
          type: 'array',
          description: '2-3 weak patterns picked from observations. Each item is a string describing the pattern (e.g. "aorist of irregular -ω verbs", "accusative after σε", "stress placement on -άω verbs").',
          items: { type: 'string' }
        },
        speak_prompts: {
          type: 'array',
          description: 'Exactly 5 fresh speak prompts targeting the focus_areas.',
          items: {
            type: 'object',
            properties: {
              en:     { type: 'string', description: 'The English prompt the learner reads.' },
              model:  { type: 'string', description: 'The target Greek model answer.' },
              target: { type: 'string', description: 'Short grammar tag (e.g. "aorist of αγοράζω (1sg)").' },
              hint:   { type: 'string', description: 'Short building-blocks hint (verb form, key noun, time word). May contain <b>tags</b> for emphasis.' }
            },
            required: ['en', 'model', 'target']
          }
        },
        grammar_lesson: {
          type: 'object',
          description: 'Short grammar mini-lesson on the #1 focus area.',
          properties: {
            title:    { type: 'string' },
            body:     { type: 'string', description: '2-3 short paragraphs of plain text.' },
            examples: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  greek:   { type: 'string' },
                  english: { type: 'string' }
                }
              }
            }
          },
          required: ['title', 'body']
        },
        vocab_focus: {
          type: 'array',
          description: 'Optional. 3-7 vocab items to focus on today (often pulled from missed words).',
          items: {
            type: 'object',
            properties: {
              greek:   { type: 'string' },
              english: { type: 'string' },
              note:    { type: 'string' }
            }
          }
        },
        why_picked: { type: 'string', description: 'Plain-English rationale (2-4 sentences): why these focus areas, citing observation stats where possible.' }
      },
      required: ['plan_date', 'focus_areas', 'speak_prompts', 'grammar_lesson', 'why_picked']
    }
  }
];

// ── Implementations. Each receives the parsed `input` object from Claude.

const toolImplementations = {
  async query_speak_observations({ days, severity, limit } = {}) {
    const lookback = Math.max(1, Math.min(60, Number(days) || 7));
    const cap = Math.max(1, Math.min(500, Number(limit) || 200));
    const since = new Date(Date.now() - lookback * 86400000).toISOString();
    let path = `speak_observations?select=*&created_at=gte.${encodeURIComponent(since)}` +
               `&order=created_at.desc&limit=${cap}`;
    if (severity && ['fail', 'note', 'clean'].includes(severity)) {
      path += `&severity=eq.${severity}`;
    }
    const r = await supaFetch(path);
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return { error: `supabase_read_failed`, status: r.status, detail: detail.slice(0, 300) };
    }
    const rows = await r.json();
    return {
      count: Array.isArray(rows) ? rows.length : 0,
      lookback_days: lookback,
      rows
    };
  },

  async query_recent_mistakes({ days, drill_type, limit } = {}) {
    const lookback = Math.max(1, Math.min(60, Number(days) || 14));
    const cap = Math.max(1, Math.min(500, Number(limit) || 200));
    const since = new Date(Date.now() - lookback * 86400000).toISOString();
    let path = `mistakes?select=*&created_at=gte.${encodeURIComponent(since)}` +
               `&order=created_at.desc&limit=${cap}`;
    if (drill_type) {
      path += `&drill_type=eq.${encodeURIComponent(drill_type)}`;
    } else {
      // Default: exclude speak (we have richer signal in speak_observations).
      path += `&drill_type=not.like.speak*`;
    }
    const r = await supaFetch(path);
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return { error: `supabase_read_failed`, status: r.status, detail: detail.slice(0, 300) };
    }
    const rows = await r.json();
    return {
      count: Array.isArray(rows) ? rows.length : 0,
      lookback_days: lookback,
      rows
    };
  },

  async query_recent_sessions({ limit } = {}) {
    const cap = Math.max(1, Math.min(20, Number(limit) || 5));
    const r = await supaFetch(`sessions?select=*&order=date.desc&limit=${cap}`);
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return { error: `supabase_read_failed`, status: r.status, detail: detail.slice(0, 300) };
    }
    const rows = await r.json();
    return {
      count: Array.isArray(rows) ? rows.length : 0,
      rows
    };
  },

  async save_plan(input = {}) {
    const { plan_date, focus_areas, speak_prompts, grammar_lesson, vocab_focus, why_picked } = input;
    if (!plan_date) return { error: 'missing plan_date' };
    if (!Array.isArray(focus_areas)) return { error: 'focus_areas must be array' };
    if (!Array.isArray(speak_prompts)) return { error: 'speak_prompts must be array' };
    if (!grammar_lesson || typeof grammar_lesson !== 'object') return { error: 'grammar_lesson must be object' };

    const row = {
      plan_date,
      focus_areas,
      speak_prompts,
      grammar_lesson,
      vocab_focus: Array.isArray(vocab_focus) ? vocab_focus : [],
      why_picked: why_picked || '',
      generated_at: new Date().toISOString()
    };

    // Upsert by plan_date — Postgres UNIQUE constraint covers it. Delete-then-insert
    // is simpler than crafting on_conflict via REST.
    await supaFetch(`coach_plans?plan_date=eq.${encodeURIComponent(plan_date)}`, { method: 'DELETE' });
    const r = await supaFetch('coach_plans', {
      method: 'POST',
      headers: { 'prefer': 'return=representation' },
      body: JSON.stringify(row)
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return { error: 'supabase_insert_failed', status: r.status, detail: detail.slice(0, 300) };
    }
    const rows = await r.json();
    const inserted = Array.isArray(rows) ? rows[0] : rows;
    return { ok: true, id: inserted && inserted.id, plan_date };
  }
};

module.exports = { tools, toolImplementations };
