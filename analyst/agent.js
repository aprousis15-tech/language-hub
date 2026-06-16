// analyst/agent.js — the tool-use loop. THIS is the core artifact.
//
// A "tool-use loop" (a.k.a. an agent) is, mechanically, just this:
//
//   loop:
//     1. send the conversation + the list of tools to the model
//     2. the model replies with EITHER:
//          (a) tool calls  -> we run them, append the results, go to 1
//          (b) a final answer (finish_reason "stop") -> we're done
//     3. stop early if we hit a turn cap (runaway guard)
//
// The mechanics are ~40 lines. What makes it *production* rather than a toy is
// the judgment around it, all of which is labeled below:
//   • STOP CONDITIONS  — MAX_TURNS guard + explicit finish_reason handling
//   • COST CONTROL     — cheap model, token cap, truncate fat tool results
//   • ERROR HANDLING   — a throwing tool returns an error object, not a crash;
//                        the model sees it and can recover
//   • OBSERVABILITY    — we record every turn, tool call, and token so the run
//                        is auditable and you can *talk about what it did*
//
// Provider: Groq's OpenAI-compatible Chat Completions API. Free tier. Because
// we speak the OpenAI dialect, swapping to OpenAI or Anthropic is a config change.

const { httpJson } = require('./http');
const { tools, toolImplementations } = require('./tools');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.ANALYST_MODEL || 'llama-3.3-70b-versatile'; // free, tool-calling capable
const MAX_TURNS = 12;            // runaway guard: the loop can never run forever
const MAX_TOKENS = 1500;         // cap output per call
const TOOL_RESULT_CAP = 40_000;  // trim a huge tool result so context stays lean

/**
 * Run the agent to completion.
 * @param {{system:string, task:string, onEvent?:(e:object)=>void}} cfg
 * @returns {Promise<{finalText, usage, toolCalls, turns, finishReason, durationMs}>}
 */
async function runAnalyst({ system, task, onEvent = () => {} }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Missing GROQ_API_KEY. Get a free key at https://console.groq.com and set it in your env.');

  // The conversation. We append to this every turn; the growing array IS the
  // agent's memory for this run.
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ];

  const startedAt = Date.now();
  const toolCalls = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let finalText = '';
  let finishReason = '';
  let turn = 0;

  for (; turn < MAX_TURNS; turn++) {
    // 1. Ask the model what to do next.
    const res = await httpJson('POST', GROQ_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: MAX_TOKENS },
    });
    if (res.status >= 400) {
      throw new Error(`Groq ${res.status}: ${(res.text || '').slice(0, 300)}`);
    }

    // OBSERVABILITY: accumulate token usage across every turn so we can report
    // the true cost/size of the whole run (not just the last call).
    if (res.json?.usage) {
      usage.prompt_tokens += res.json.usage.prompt_tokens || 0;
      usage.completion_tokens += res.json.usage.completion_tokens || 0;
    }

    const choice = res.json?.choices?.[0];
    const msg = choice?.message;
    finishReason = choice?.finish_reason || '';
    onEvent({ type: 'turn', turn: turn + 1, finishReason });

    // 2b. No tool calls -> the model gave its final answer. Done.
    if (!msg?.tool_calls || msg.tool_calls.length === 0) {
      finalText = (msg?.content || '').trim();
      break;
    }

    // 2a. The model wants to call tools. Append its turn verbatim FIRST — the
    // API requires the assistant's tool_calls to precede the tool results.
    messages.push(msg);

    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* bad JSON -> {} */ }

      // ERROR HANDLING: never let a tool throw kill the run. On failure we hand
      // the model a structured { error } so it can adapt or report it.
      const impl = toolImplementations[name];
      let result;
      try {
        result = impl ? await impl(args) : { error: `unknown_tool: ${name}` };
      } catch (e) {
        result = { error: String((e && e.message) || e) };
      }

      let resultStr = JSON.stringify(result);
      if (resultStr.length > TOOL_RESULT_CAP) resultStr = resultStr.slice(0, TOOL_RESULT_CAP) + '\n…[truncated]';

      toolCalls.push({ name, args, ok: !result?.error, result_len: resultStr.length });
      onEvent({ type: 'tool', name, ok: !result?.error });

      // Append the tool result, linked back to the call by id (OpenAI format).
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultStr });
    }
    // ...loop back to step 1 so the model can read the results and continue.
  }

  return {
    finalText,
    usage,
    toolCalls,
    turns: turn + 1,
    finishReason,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = { runAnalyst, MODEL };
