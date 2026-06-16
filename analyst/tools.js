// analyst/tools.js — the agent's toolbox (read-only) + a deterministic cost model.
//
// DESIGN DECISIONS worth defending in an interview:
//
// 1. LEAST PRIVILEGE. The agent gets a small set of PURPOSE-BUILT read tools,
//    never raw SQL. Bounded blast radius (it physically cannot write or delete),
//    predictable cost, and the tool names/descriptions double as guardrails.
//
// 2. PRE-DIGESTED OUTPUTS. Each tool returns a compact, decision-ready summary
//    (tallies, rates, samples) — not a raw row dump. The model pays for every
//    token it reads, so we do the counting in code and hand it the answer.
//    This is the single biggest lever on cost and reliability.
//
// 3. DON'T MAKE THE MODEL DO ARITHMETIC. Cost estimation is pure JS math with
//    explicit, labeled assumptions. LLMs are unreliable calculators; a function
//    is exact and auditable.
//
// Tool schemas are in OpenAI "function" format so the loop is provider-portable
// (Groq today, swappable for OpenAI/Claude tomorrow).

const { httpJson } = require('./http');

// Public publishable (anon) key — same one the browser already ships. Read-only
// RLS-safe usage. Override via env if you ever rotate it.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';
const supaHeaders = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` };

const REST = (pathAndQuery) => `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
const isoSince = (days) => new Date(Date.now() - Math.max(1, Number(days) || 30) * 86400000).toISOString();

async function supaGet(pathAndQuery, extraHeaders = {}) {
  const r = await httpJson('GET', REST(pathAndQuery), { headers: { ...supaHeaders, ...extraHeaders } });
  if (r.status >= 400) throw new Error(`supabase ${r.status}: ${(r.text || '').slice(0, 200)}`);
  return r;
}

// ── Cost model ──────────────────────────────────────────────────────────────
// Your app has NO persisted token usage yet (coach_plans.agent_metadata is
// empty), so we ESTIMATE: per-generation token profiles × published list
// prices. The numbers are assumptions, returned alongside the result so the
// estimate is auditable, not a black box. "Persist real usage" is the obvious
// next step — and a good thing to name as future work.
const PRICING_USD_PER_MTOK = {        // list prices; update as they change
  'llama-3.3-70b-versatile': { in: 0, out: 0 },   // Groq free tier → $0
  'claude-sonnet-4-6':       { in: 3, out: 15 },
  'claude-opus-4-7':         { in: 5, out: 25 },
};
// What each nightly generation roughly consumes. Rough on purpose — the method
// is the point, and every number here is labeled and swappable.
const GEN_PROFILES = {
  coach_plan:  { label: 'Coach agent (multi-turn plan)', model: 'claude-sonnet-4-6', in_tokens: 28000, out_tokens: 2500 },
  daily_story: { label: 'Daily story generation',        model: 'claude-sonnet-4-6', in_tokens: 1500,  out_tokens: 2200 },
  daily_vocab: { label: 'Daily vocab pick',              model: 'claude-sonnet-4-6', in_tokens: 2500,  out_tokens: 1200 },
};
function costOf(profile) {
  const p = PRICING_USD_PER_MTOK[profile.model] || { in: 0, out: 0 };
  return (profile.in_tokens / 1e6) * p.in + (profile.out_tokens / 1e6) * p.out;
}

// ── Tool schemas (what the model sees) ───────────────────────────────────────
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_data_summary',
      description: 'Orient yourself first. Returns row counts and date ranges for every data table (mistakes, speak_observations, coach_plans, daily_stories, daily_vocab_picks, vocab, story_attempts). Call this ONCE at the start to see what data exists and how recent it is.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'estimate_ai_cost',
      description: 'Estimate what the app spent on AI generations in a recent window. Counts coach plans, daily stories, and daily vocab picks, then multiplies by per-generation token profiles and published model prices. Returns a full breakdown plus the assumptions used. Use for the Cost section.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Look-back window in days. Default 30.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_mistakes',
      description: 'Summarize drill mistakes in a window: total, a tally by drill_type, and a sample of recent mistakes (prompt / correct / picked). This is the richest behavioral signal. Use for the Top weaknesses section.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look-back window in days. Default 30.' },
          drill_type: { type: 'string', description: 'Optional filter, e.g. "articles" or "verbs".' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_speak',
      description: 'Summarize spoken-attempt observations in a window: counts by severity (fail/note/clean) and score (pass/fix), a first-try pass rate, and a tally of weakness types. IMPORTANT: if the total is small (<10), treat the pass rate as NOT yet reliable and say so. Use for the Speaking pass-rate section.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Look-back window in days. Default 30.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vocab_stats',
      description: 'Snapshot of the vocabulary corpus: total words, top topics, how many SRS cards are due now, and how many words were added in the last 30 days. Use for the Vocab section.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Tool implementations (what actually runs) ────────────────────────────────
const toolImplementations = {
  async get_data_summary() {
    const specs = [
      ['mistakes', 'created_at'], ['speak_observations', 'created_at'],
      ['coach_plans', 'plan_date'], ['daily_stories', 'story_date'],
      ['daily_vocab_picks', 'pick_date'], ['vocab', 'created_at'],
      ['story_attempts', 'created_at'],
    ];
    const out = {};
    for (const [table, dateCol] of specs) {
      // count via PostgREST: Prefer count=exact puts the total in content-range
      const c = await supaGet(`${table}?select=${dateCol}`, { Prefer: 'count=exact', Range: '0-0' });
      const cr = c.headers['content-range'] || '';        // e.g. "0-0/155"
      const total = cr.includes('/') ? (cr.split('/')[1] === '*' ? 0 : Number(cr.split('/')[1])) : null;
      const first = await supaGet(`${table}?select=${dateCol}&order=${dateCol}.asc&limit=1`);
      const last = await supaGet(`${table}?select=${dateCol}&order=${dateCol}.desc&limit=1`);
      out[table] = {
        rows: total,
        first: first.json?.[0]?.[dateCol] ?? null,
        last: last.json?.[0]?.[dateCol] ?? null,
      };
    }
    return out;
  },

  async estimate_ai_cost({ days } = {}) {
    const sinceDate = isoSince(days).slice(0, 10); // date-typed columns compare on YYYY-MM-DD
    const win = Math.max(1, Number(days) || 30);

    async function datesIn(table, dateCol) {
      const r = await supaGet(`${table}?select=${dateCol}&${dateCol}=gte.${sinceDate}&order=${dateCol}.desc&limit=500`);
      return (r.json || []).map((row) => String(row[dateCol]).slice(0, 10));
    }
    const coachDates = await datesIn('coach_plans', 'plan_date');
    const storyDates = await datesIn('daily_stories', 'story_date');
    const vocabDates = await datesIn('daily_vocab_picks', 'pick_date');

    const counts = { coach_plan: coachDates.length, daily_story: storyDates.length, daily_vocab: vocabDates.length };
    const breakdown = {};
    let total = 0;
    for (const key of Object.keys(GEN_PROFILES)) {
      const unit = costOf(GEN_PROFILES[key]);
      const sub = unit * counts[key];
      total += sub;
      breakdown[key] = {
        label: GEN_PROFILES[key].label,
        count: counts[key],
        unit_cost_usd: Number(unit.toFixed(4)),
        subtotal_usd: Number(sub.toFixed(4)),
      };
    }
    const activeDays = new Set([...coachDates, ...storyDates, ...vocabDates]).size;
    return {
      window_days: win,
      generations: counts,
      cost_breakdown: breakdown,
      total_usd: Number(total.toFixed(4)),
      active_days: activeDays,
      cost_per_active_day_usd: activeDays ? Number((total / activeDays).toFixed(4)) : 0,
      assumptions: {
        note: 'No token usage is persisted yet, so cost is ESTIMATED from per-generation token profiles × list prices. Persisting real usage is the obvious next step.',
        token_profiles: GEN_PROFILES,
        prices_usd_per_million_tokens: PRICING_USD_PER_MTOK,
      },
    };
  },

  async analyze_mistakes({ days, drill_type } = {}) {
    const since = isoSince(days);
    const win = Math.max(1, Number(days) || 30);
    let path = `mistakes?select=drill_type,prompt,correct,picked,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=500`;
    if (drill_type) path += `&drill_type=eq.${encodeURIComponent(drill_type)}`;
    const rows = (await supaGet(path)).json || [];
    const byType = {};
    for (const r of rows) byType[r.drill_type || 'unknown'] = (byType[r.drill_type || 'unknown'] || 0) + 1;
    const by_drill_type = Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]));
    return {
      window_days: win,
      total: rows.length,
      by_drill_type,
      recent_samples: rows.slice(0, 25).map((r) => ({
        drill: r.drill_type, prompt: r.prompt, correct: r.correct, picked: r.picked,
      })),
    };
  },

  async analyze_speak({ days } = {}) {
    const since = isoSince(days);
    const win = Math.max(1, Number(days) || 30);
    const rows = (await supaGet(
      `speak_observations?select=severity,score,target_grammar,headline,weaknesses_observed,created_at` +
      `&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=500`
    )).json || [];

    const bySeverity = { fail: 0, note: 0, clean: 0 };
    const byScore = { pass: 0, fix: 0 };
    const weaknessTally = {};
    for (const r of rows) {
      if (r.severity in bySeverity) bySeverity[r.severity]++;
      if (r.score in byScore) byScore[r.score]++;
      for (const w of Array.isArray(r.weaknesses_observed) ? r.weaknesses_observed : []) {
        if (w && w.type) weaknessTally[w.type] = (weaknessTally[w.type] || 0) + 1;
      }
    }
    const scored = byScore.pass + byScore.fix;
    return {
      window_days: win,
      total: rows.length,
      reliable: rows.length >= 10, // honesty gate — below this, don't trust the rate
      by_severity: bySeverity,
      by_score: byScore,
      first_try_pass_rate: scored ? Number((byScore.pass / scored).toFixed(2)) : null,
      weakness_type_tally: Object.fromEntries(Object.entries(weaknessTally).sort((a, b) => b[1] - a[1])),
      samples: rows.slice(0, 10).map((r) => ({ severity: r.severity, score: r.score, target: r.target_grammar, headline: r.headline })),
    };
  },

  async vocab_stats() {
    const rows = (await supaGet('vocab?select=topic,srs_due_at,created_at&limit=2000')).json || [];
    const nowIso = new Date().toISOString();
    const since30 = isoSince(30);
    const byTopic = {};
    let dueNow = 0, added30 = 0;
    for (const r of rows) {
      const t = r.topic || 'untagged';
      byTopic[t] = (byTopic[t] || 0) + 1;
      if (r.srs_due_at && r.srs_due_at <= nowIso) dueNow++;
      if (r.created_at && r.created_at >= since30) added30++;
    }
    const top = Object.fromEntries(Object.entries(byTopic).sort((a, b) => b[1] - a[1]).slice(0, 8));
    return { total: rows.length, top_topics: top, srs_due_now: dueNow, added_last_30_days: added30 };
  },
};

module.exports = { tools, toolImplementations };
