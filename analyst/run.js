#!/usr/bin/env node
// analyst/run.js — CLI entry point. Run it from your terminal:
//
//   node analyst/run.js                       # last 30 days
//   node analyst/run.js --days 14             # custom window
//   node analyst/run.js --trip 2026-08-15     # add progress-vs-trip-date framing
//
// It builds the task, runs the loop, prints the brief, saves it to
// analyst/briefs/, and prints an observability footer so every run is auditable.

const fs = require('fs');
const path = require('path');
const { runAnalyst, MODEL } = require('./agent');

// ── tiny arg parser (no deps) ────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { days: 30, trip: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') out.days = Number(argv[++i]) || 30;
    else if (argv[i] === '--trip') out.trip = argv[++i] || null;
  }
  return out;
}

const SYSTEM = `You are a data analyst for "Anthony", who is building a Greek-learning app and preparing for a trip to Greece. You write a concise WEEKLY BRIEF for a finance/operations-minded reader.

RULES:
- Get every number from the tools. NEVER invent or estimate a figure yourself.
- Start by calling get_data_summary to see what data exists and how fresh it is.
- Then call the tools you need: estimate_ai_cost, analyze_mistakes, analyze_speak, vocab_stats.
- If a metric is based on very little data (e.g. analyze_speak reports reliable=false), explicitly say it is NOT yet reliable rather than reporting it as fact. Intellectual honesty over false precision.
- Cost figures are ESTIMATES (no token usage is persisted yet) — say so once.

OUTPUT — when you have what you need, stop calling tools and write the brief as your final message, in markdown, under ~400 words, with these sections:
## 📊 Weekly Brief (<window>)
## 💸 Cost
## 📈 Engagement
## 🎯 Top weaknesses
## 🗣️ Speaking pass-rate
## 📚 Vocab
## ✅ Recommendation  (exactly one concrete, prioritized action)

Quote each number with its time window. Be specific and operator-minded.`;

function buildTask({ days, trip }) {
  const today = new Date().toISOString().slice(0, 10);
  let t = `Today is ${today}. Produce the weekly brief for the last ${days} days.`;
  if (trip) t += ` The Greece trip is ${trip} — include a short progress-vs-trip-date note in the Recommendation.`;
  return t;
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);

  if (!process.env.GROQ_API_KEY) {
    console.error('\n✖ GROQ_API_KEY is not set.\n');
    console.error('  Get a FREE key at https://console.groq.com, then in PowerShell:');
    console.error('    $env:GROQ_API_KEY = "gsk_...your key..."');
    console.error('    node analyst/run.js\n');
    process.exit(1);
  }

  console.log(`\n⏳ Running analyst agent (model: ${MODEL}, window: ${args.days}d)…\n`);

  let result;
  try {
    result = await runAnalyst({
      system: SYSTEM,
      task: buildTask(args),
      // live progress so you can watch the loop think
      onEvent: (e) => {
        if (e.type === 'tool') console.log(`   🔧 ${e.ok ? '✓' : '✗'} ${e.name}`);
        if (e.type === 'turn' && e.finishReason === 'stop') console.log('   🧠 writing brief…');
      },
    });
  } catch (e) {
    console.error(`\n✖ Run failed: ${e.message}\n`);
    process.exit(1);
  }

  // ── the brief ──
  console.log('\n' + '─'.repeat(64) + '\n');
  console.log(result.finalText || '(no brief produced)');
  console.log('\n' + '─'.repeat(64));

  // ── OBSERVABILITY FOOTER: this is the "I instrument my agents" flex ──
  const toolNames = result.toolCalls.map((t) => t.name).join(', ') || 'none';
  console.log('\n📟 Run telemetry');
  console.log(`   turns:        ${result.turns}`);
  console.log(`   tool calls:   ${result.toolCalls.length} (${toolNames})`);
  console.log(`   tokens:       ${result.usage.prompt_tokens} in / ${result.usage.completion_tokens} out`);
  console.log(`   latency:      ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`   cost:         $0.00 (Groq free tier)`);
  console.log(`   finish:       ${result.finishReason}`);

  // ── save the brief ──
  const dir = path.join(__dirname, 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `brief-${today}.md`);
  const front = `<!-- generated ${new Date().toISOString()} | model ${MODEL} | ${args.days}d | ` +
    `${result.toolCalls.length} tool calls | ${result.usage.prompt_tokens}+${result.usage.completion_tokens} tok -->\n\n`;
  fs.writeFileSync(file, front + (result.finalText || ''), 'utf8');
  console.log(`\n💾 saved → analyst/briefs/brief-${today}.md\n`);
})();
