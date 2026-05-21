// /api/coach/plan-today — Vercel serverless function
// Returns the most recent coach_plan, or null if none exists yet.
// Pure read endpoint — does NOT trigger the agent. The agent runs nightly
// via /api/coach/run; this endpoint just exposes whatever the agent last
// produced so the frontend can render it.
//
// GET /api/coach/plan-today
//   → { ok: true, plan: <row> | null }
//
// Safe to call from the frontend on every Plan-tab open. The "Today's Plan"
// card uses this — if plan is null, the card shows an empty state without
// breaking anything else.

const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_plans?select=*&order=plan_date.desc&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ ok: false, error: 'supabase_read_failed', status: r.status, detail: detail.slice(0, 200) });
      return;
    }
    const rows = await r.json();
    const plan = Array.isArray(rows) && rows[0] ? rows[0] : null;
    res.status(200).json({ ok: true, plan });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
