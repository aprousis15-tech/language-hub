// coach/agent.js — Autonomous Greek-learning study coach.
//
// Runs a custom tool-use loop against Claude. Each iteration:
//   1. Send messages + tool defs to Claude (Messages API)
//   2. Claude returns either:
//        - tool_use blocks  → we execute, push tool_result, loop
//        - end_turn         → done
//
// Why custom loop instead of @anthropic-ai/claude-agent-sdk:
//   The official Agent SDK requires the Claude Code CLI subprocess, which
//   isn't available in Vercel serverless functions. Implementing the loop
//   directly gives full control and is ~30 lines.
//
// Cost: ~$0.20–0.40 per run on Opus 4.7 (≈8-12 tool turns, ~30K context).

const Anthropic = require('@anthropic-ai/sdk');
const { tools, toolImplementations } = require('./tools');

// Opus 4.7 — the coach is the senior-level planning brain of the site, so
// it gets the strongest model. Cost is bounded by the new idempotency check
// in /api/coach/run (one run per day max, ~$0.70/run on Opus → ~$21/month).
// The smaller default mistakes query (50 rows vs 200) keeps per-run input
// tokens manageable and gives Opus comfortable headroom under Vercel Hobby's
// 60s function cap — first Opus run at the old 200-row default took 68s
// curl; 50-row default should land closer to 40s.
const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4096;
const MAX_TURNS = 20;
const TOOL_RESULT_CAP = 50_000; // chars — trim huge query results to keep context lean

const SYSTEM_PROMPT = `You are an autonomous Greek-learning study coach for one specific user — Anthony, an English-speaking adult preparing for a trip to Greece. He's at A2 level (intermediate-beginner). Your job is to produce a personalized study plan for one day.

THE PROCESS — follow this every time:

1. Read recent SPEAK observations via query_speak_observations(days=7). This is your PRIMARY signal — every speak attempt is logged here with severity ("fail" | "note" | "clean") and a structured weaknesses_observed array (type: pronunciation, stress, vowel, consonant, case, tense, person, number, gender, vocab, word_order, article, preposition).

2. Read recent non-speak mistakes via query_recent_mistakes(days=14) for cross-drill weakness signal.

3. Read recent sessions via query_recent_sessions(limit=5) for scenario context.

4. ANALYZE: identify the learner's TOP 2-3 weakest patterns. Be SPECIFIC — not "verbs" but "aorist of irregular -ω verbs (έδωσα, είπα, έφαγα)". Quote stats when you can: "12 of last 18 attempts on aorist had wrong stem".

5. GENERATE 5 fresh speak prompts targeting those patterns. Tie EACH prompt explicitly to a focus area. Keep them at A2 — common everyday situations the learner will hit in Greece.

6. WRITE a short grammar mini-lesson (2-3 short paragraphs) on the #1 focus area. Include 2-3 example sentences.

7. Optionally compile a vocab_focus list (3-7 words) from recent missed words or words from the grammar lesson.

8. WHY_PICKED: 2-4 sentences explaining your picks, citing observation counts and patterns. This goes in front of the plan.

9. Call save_plan with the full structured output. ONCE. Use the plan_date provided in the user message verbatim.

GUIDELINES:
- If there's barely any data (cold start), pick beginner-friendly focus areas (greetings, present-tense -ω verbs, basic articles, accusative for direct objects) and say so honestly in why_picked.
- Avoid generating speak prompts that look identical to ones in the recent observations — vary the surface even when the target grammar is the same.
- The learner's name is Anthony — you may address him by name in why_picked.
- After save_plan succeeds, respond with a short summary message (no more tool calls).
- DO NOT call save_plan more than once. If your first call fails, you may retry with corrected input — but only after fixing the issue.

OUTPUT after save_plan: a 1-2 sentence text summary for the logs. Don't restate the whole plan.`;

async function runCoachAgent({ date }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('server_missing_anthropic_key');

  const client = new Anthropic({ apiKey });

  const userTask = `Today is ${date}. Generate today's plan. Read observations, analyze, author, and save. Use plan_date="${date}" exactly.`;
  const messages = [{ role: 'user', content: userTask }];

  const startedAt = Date.now();
  const toolCalls = [];
  let stopReason = '';
  let finalSummary = '';
  let savedPlanId = null;
  let turn = 0;

  for (; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      messages
    });

    stopReason = response.stop_reason;

    if (stopReason === 'end_turn') {
      finalSummary = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      break;
    }

    if (stopReason !== 'tool_use') {
      finalSummary = `Stopped unexpectedly: ${stopReason}`;
      break;
    }

    // Append assistant turn verbatim (Anthropic requires the tool_use blocks
    // to be present before the matching tool_result blocks).
    messages.push({ role: 'assistant', content: response.content });

    // Execute every tool_use block in this turn, in order.
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const impl = toolImplementations[block.name];
      let result;
      try {
        result = impl
          ? await impl(block.input || {})
          : { error: `unknown_tool: ${block.name}` };
      } catch (e) {
        result = { error: String(e && e.message || e) };
      }
      // Track save_plan success so the run endpoint can report the saved id.
      if (block.name === 'save_plan' && result && result.ok) {
        savedPlanId = result.id;
      }
      const resultStr = JSON.stringify(result);
      toolCalls.push({
        name:      block.name,
        input:     block.input,
        result_len: resultStr.length,
        ok:        !result?.error
      });
      toolResults.push({
        type:         'tool_result',
        tool_use_id:  block.id,
        content:      resultStr.length > TOOL_RESULT_CAP
                        ? resultStr.slice(0, TOOL_RESULT_CAP) + '\n…[truncated]'
                        : resultStr
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    summary: finalSummary,
    saved_plan_id: savedPlanId,
    tool_calls: toolCalls,
    turns: turn + 1,
    stop_reason: stopReason,
    duration_ms: Date.now() - startedAt
  };
}

module.exports = { runCoachAgent };
