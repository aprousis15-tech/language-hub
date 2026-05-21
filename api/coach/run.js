// /api/coach/run — Vercel serverless function
// Triggers the autonomous study-coach agent. Reads recent observations,
// generates a plan, and writes it to public.coach_plans.
//
// GET  → cron-friendly trigger (Vercel cron sends GET)
// POST → manual trigger (curl, browser, etc.)
//
// Idempotency: if a plan for today already exists, returns it WITHOUT
// re-invoking the agent. Pass ?force=1 to regenerate (e.g., for testing).
// This bounds cost to a single agent run per day regardless of how many
// times the endpoint is hit (cron + button clicks + curl).
//
// Env vars used:
//   ANTHROPIC_API_KEY  — required, agent's Claude calls
//   COACH_DISABLED     — optional opt-out kill-switch. Set to "true" in Vercel
//                        to pause the agent (cron + manual triggers both no-op).
//                        Default behavior: enabled — agent runs whenever hit.

const { runCoachAgent } = require('../../coach/agent');

const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

async function readCachedPlan(date) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_plans?plan_date=eq.${encodeURIComponent(date)}&select=*&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Opt-out kill-switch: default is run. Set COACH_DISABLED=true in Vercel
  // env vars to pause cron + manual triggers without redeploying code.
  if (process.env.COACH_DISABLED === 'true') {
    res.status(200).json({
      ok: false,
      skipped: true,
      reason: 'COACH_DISABLED env var is "true". Unset it (or set to anything else) to re-enable.'
    });
    return;
  }

  const date = todayET();
  const force = (req.url && req.url.includes('force=1')) ||
                (req.query && req.query.force === '1');

  try {
    // Idempotency: skip the agent if today's plan already exists, unless
    // ?force=1. Bounds cost to one agent run per day regardless of how
    // many times we get triggered (cron + button + curl).
    if (!force) {
      const cached = await readCachedPlan(date);
      if (cached) {
        res.status(200).json({
          ok: true,
          date,
          cached: true,
          saved_plan_id: cached.id,
          note: "Plan for today already exists. Pass ?force=1 to regenerate."
        });
        return;
      }
    }
    const result = await runCoachAgent({ date });
    res.status(200).json({
      ok: true,
      date,
      saved_plan_id: result.saved_plan_id,
      summary:       result.summary,
      turns:         result.turns,
      tool_calls:    result.tool_calls,
      stop_reason:   result.stop_reason,
      duration_ms:   result.duration_ms
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      date,
      error: String(e && e.message || e),
      stack: process.env.NODE_ENV === 'development' ? (e && e.stack) : undefined
    });
  }
};

// Vercel function config: bump max duration so the agent loop (~20-40s)
// doesn't get killed at the 10s Hobby default. 60s is the Hobby ceiling.
module.exports.config = { maxDuration: 60 };
