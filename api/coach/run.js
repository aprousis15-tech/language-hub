// /api/coach/run — Vercel serverless function
// Triggers the autonomous study-coach agent. Reads recent observations,
// generates a plan, and writes it to public.coach_plans.
//
// GET  → cron-friendly trigger (Vercel cron sends GET)
// POST → manual trigger (curl, browser, etc.)
//
// Env vars used:
//   ANTHROPIC_API_KEY  — required, agent's Claude calls
//   COACH_ENABLED      — Phase C safety gate. Set to "true" in Vercel to allow
//                        the agent to actually run. Anything else returns a
//                        no-op so cron/manual triggers don't burn tokens until
//                        you're ready.
//
// vercel.json sets maxDuration: 60 for this route — agent typically finishes
// in 20-40s with ~8-12 tool turns on Opus.

const { runCoachAgent } = require('../../coach/agent');

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

  // Phase C safety gate: only run when explicitly enabled. Returns 200 so
  // cron doesn't retry-loop — the no-op is intentional.
  if (process.env.COACH_ENABLED !== 'true') {
    res.status(200).json({
      ok: false,
      skipped: true,
      reason: 'COACH_ENABLED env var is not "true". Set it in Vercel to activate the agent.'
    });
    return;
  }

  const date = todayET();

  try {
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
