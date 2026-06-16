# Personal AI Analyst — a tool-use loop you own

A small autonomous agent that reads your Greek-app data, decides which queries
it needs, and writes a weekly operations brief (cost, engagement, weaknesses,
vocab). Built from scratch — no agent framework — so every decision is yours to
explain.

## Run it ($0)

```powershell
# 1. Get a FREE Groq key (one time): https://console.groq.com
$env:GROQ_API_KEY = "gsk_...your key..."

# 2. Run
node analyst/run.js                    # last 30 days
node analyst/run.js --days 14          # custom window
node analyst/run.js --trip 2026-08-15  # add progress-vs-trip framing
```

The brief prints to your terminal and saves to `analyst/briefs/brief-<date>.md`.
**Cost: $0** — Groq's free tier drives the loop; Supabase reads are free; it runs
locally (no deploy).

## How it works

```
run.js   → builds the task + system prompt, runs the loop, prints/saves the brief
agent.js → the tool-use loop (the core artifact)
tools.js → 5 read-only tools + a deterministic cost model
http.js  → zero-dependency HTTPS helper (works on Node 17+, nothing to install)
```

The loop, in one breath: *send conversation + tools to the model → if it asks
for tools, run them and append results → repeat → when it stops asking, its last
message is the brief.*

## What to say in an interview

This is deliberately a *production-shaped* loop, not a toy. The talking points:

| Concept | Where it lives | The line |
|---|---|---|
| **Least privilege** | `tools.js` — 5 purpose-built read tools, no raw SQL | "The agent physically can't write or delete. Bounded blast radius." |
| **Token-cost control** | tools return *pre-digested* tallies, not raw rows | "I do the counting in code and hand the model the answer — the model pays per token it reads." |
| **Don't let the LLM do math** | `estimate_ai_cost` is pure JS with labeled assumptions | "Cost is computed by a function and auditable, not hallucinated by a model." |
| **Stop conditions** | `MAX_TURNS` + `finish_reason` handling in `agent.js` | "It can never loop forever; I handle the normal stop and the runaway case." |
| **Error handling** | a throwing tool returns `{error}`, not a crash | "A failed tool becomes data the model can recover from." |
| **Observability** | telemetry footer: turns, tool calls, tokens, latency | "Every run is auditable — I can tell you what it did and what it cost." |
| **Intellectual honesty** | `reliable:false` gate in `analyze_speak` | "With 5 data points it refuses to report a pass-rate as fact." |
| **Provider portability** | OpenAI-compatible wire format | "Free Llama on Groq today; one config line swaps in Claude or GPT." |

## Known limitations / next steps (also good interview fodder)

- **Cost is estimated**, not measured — no token usage is persisted yet.
  *Next:* write real `usage` into `coach_plans.agent_metadata` and have the tool
  read actuals.
- **Speaking sample is tiny** (5 rows) — the brief says so rather than overclaim.
- Single-user; the Supabase key is the public anon key. Multi-user would need
  auth + per-user RLS.
