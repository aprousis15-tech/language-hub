// /api/vocab/today — Vercel serverless function
// Returns today's 5 vocab picks (or the most recent ones if today's haven't
// been generated yet). Pure read — no Claude calls, safe to hit on every tab
// open. The picks_snapshot column has the full word data, so the frontend
// doesn't need a separate join to public.vocab.
//
// GET /api/vocab/today
//   → { ok: true, picks: [...], pick_date, why_picked, is_today, generated_at }
//
// Returns `is_today=false` if the most recent pick row is from a prior day
// (which can happen if the cron hasn't fired yet today). The frontend can
// show "yesterday's picks" with a friendly note in that case.

const SUPABASE_URL = 'https://bdfjddzwvudqictvuvtr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_vocab_picks?select=*&order=pick_date.desc&limit=1`,
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
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) {
      res.status(200).json({ ok: true, picks: [], pick_date: null, why_picked: null, is_today: false });
      return;
    }
    const today = todayET();
    res.status(200).json({
      ok: true,
      pick_date:    row.pick_date,
      is_today:     row.pick_date === today,
      picks:        row.picks_snapshot || [],
      why_picked:   row.why_picked || null,
      generated_at: row.generated_at,
      daily_pick_id: row.id
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
