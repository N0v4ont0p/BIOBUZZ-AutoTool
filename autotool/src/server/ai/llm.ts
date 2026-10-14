// One question to the strongest model, answered as a JSON object: the house-style analysis and the
// auto writer. Works through the Claude account (claude -p) or an API key. No tools: everything the
// model needs is in the message.

import Anthropic from "@anthropic-ai/sdk";
import { baseArgs, runClaude } from "./claudecli.ts";
import type { Ledger } from "./ledger.ts";

export const STRONG_MODEL = "claude-opus-5-5";
const OPUS_RATES = { input: 4, output: 20 }; // USD per million tokens (cached 2026-10-06)

export interface Creds {
  mode: "claude" | "api";
  token?: string | null; // Claude account
  key?: string | null; // API key
  workspaceId?: string | null;
  configDir: string;
}

export interface AskResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  ms: number;
}

function parseJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("the answer has no JSON object");
  return JSON.parse(m[0]);
}

export async function askJson<T>(req: { system: string; user: string; schema: Record<string, unknown>; effort: "medium" | "high" | "xhigh"; task: string }, creds: Creds, ledger: Ledger): Promise<AskResult<T>> {
  const t0 = Date.now();
  if (creds.mode === "claude") {
    if (!creds.token) return { ok: false, error: "connect your Claude account first", ms: 0 };
    const r = await runClaude([...baseArgs(req.system, req.effort, STRONG_MODEL), "--json-schema", JSON.stringify(req.schema), req.user], creds.token, creds.configDir, 900_000);
    ledger.record(req.task, `${STRONG_MODEL} via claude`, { input_tokens: r.usage?.input ?? 0, output_tokens: r.usage?.output ?? 0, cache_read_input_tokens: r.usage?.cacheRead ?? 0, cache_creation_input_tokens: 0 }, r.ok ? "end_turn" : "error", r.usage?.costUsd);
    return r.ok ? { ok: true, data: r.output as T, ms: r.ms } : { ok: false, error: r.error ?? "claude failed", ms: r.ms };
  }
  if (!creds.key) return { ok: false, error: "add an API key or connect your Claude account first", ms: 0 };
  const client = new Anthropic({ apiKey: creds.key, ...(creds.workspaceId ? { defaultHeaders: { "anthropic-workspace-id": creds.workspaceId } } : {}) });
  try {
    // long answers: stream, then take the final message
    const stream = client.beta.messages.stream({
      model: STRONG_MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort },
      // a refused request is re-run on the fallback model the API picks for that refusal
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: `${req.system}\n\nAnswer with one JSON object matching this schema, and nothing else:\n${JSON.stringify(req.schema)}`,
      messages: [{ role: "user", content: req.user }],
    } as unknown as Anthropic.Beta.MessageCreateParamsStreaming);
    const msg = await stream.finalMessage();
    const u = msg.usage;
    const usd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0)) * OPUS_RATES.input + (u.cache_read_input_tokens ?? 0) * OPUS_RATES.input * 0.05 + u.output_tokens * OPUS_RATES.output) / 1_000_000;
    ledger.record(req.task, STRONG_MODEL, { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 }, msg.stop_reason ?? "", usd);
    if (msg.stop_reason === "refusal") return { ok: false, error: "the model declined this request", ms: Date.now() - t0 };
    if (msg.stop_reason === "max_tokens") return { ok: false, error: "the answer was cut off (too long)", ms: Date.now() - t0 };
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { ok: true, data: parseJson(text) as T, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: "the API key was rejected", ms: Date.now() - t0 };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, error: "rate limited: try again in a minute", ms: Date.now() - t0 };
    if (e instanceof Anthropic.APIError) return { ok: false, error: `API error ${e.status}: ${e.message}`, ms: Date.now() - t0 };
    return { ok: false, error: (e as Error).message, ms: Date.now() - t0 };
  }
}
