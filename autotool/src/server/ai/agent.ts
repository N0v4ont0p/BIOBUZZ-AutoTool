// The agent loop (Claude Haiku 5.5). Rules from the API guidance (PLAN section 11):
// - the conversation is append-only; earlier turns are never edited;
// - response blocks are read by type (a response can start with thinking blocks), and the whole
//   assistant content, thinking blocks included, goes back unmodified with the tool results;
// - effort is set explicitly; thinking counts toward max_tokens, so max_tokens leaves room;
// - tools on auto (forced tool choice would skip thinking); the answer is the submit_patch call;
// - no prefill, no temperature/top_p/top_k;
// - stop_reason "refusal" gets a clear message (Haiku 5.5 has no fallback model);
// - rate limits and overloads back off and retry, and the UI is told;
// - the spend cap is checked before every call.

import Anthropic from "@anthropic-ai/sdk";
import type { Patch } from "../../shared/patch.ts";
import type { AutoSpec } from "../../shared/spec.ts";
import type { ClaimResult } from "../../shared/patch.ts";
import { type Ledger, MODEL } from "./ledger.ts";
import type { BuiltPrompt } from "./prompt.ts";
import { TOOL_DEFS, type ToolContext, errorSummary, runTool } from "./tools.ts";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "claims"; tool: string; ok: boolean; mismatches: number; unverified: number }
  | { type: "usage"; usd: number; session: number; cacheRead: number; promptTokens: number }
  | { type: "result"; patch: Patch; spec: AutoSpec; claims: ClaimResult; repairs: number }
  | { type: "paused"; reason: string }
  | { type: "error"; message: string; kind: "refusal" | "auth" | "offline" | "limit" | "model" | "other" };

export interface MessageClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

function headers(workspaceId: string | null | undefined): Record<string, string> | undefined {
  return workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined;
}

export function sdkClient(apiKey: string, workspaceId?: string | null): MessageClient {
  const c = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000, defaultHeaders: headers(workspaceId) });
  return { create: (p) => c.messages.create(p) };
}

export interface Conversation {
  messages: Anthropic.MessageParam[];
  // The last assistant turn ended with submit_patch. Its tool_result (the team's decision) and the
  // results of any other tools called in that same turn go first in the next user turn.
  pending: { submitId: string; otherResults: Anthropic.ToolResultBlockParam[] } | null;
}

export interface RunOptions {
  task: string; // e.g. "annotate" or "chat"
  userText: string; // the turn's text (task + current spec as data)
  decision?: string; // the team's answer to the previous submit_patch
  effort: "low" | "medium" | "high";
  maxIterations?: number;
  maxRepairs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorKind(e: unknown): AgentEvent & { type: "error" } {
  if (e instanceof Anthropic.AuthenticationError) return { type: "error", kind: "auth", message: "The API key was rejected. Update it in Settings." };
  if (e instanceof Anthropic.PermissionDeniedError) return { type: "error", kind: "auth", message: `This key cannot use ${MODEL} (permission denied).` };
  if (e instanceof Anthropic.NotFoundError) return { type: "error", kind: "model", message: `${MODEL} is not available to this account.` };
  if (e instanceof Anthropic.BadRequestError) return { type: "error", kind: "other", message: `The request was rejected: ${e.message}` };
  if (e instanceof Anthropic.APIConnectionError) return { type: "error", kind: "offline", message: "No connection to the Anthropic API. Viewing and editing still work; AI is off until the internet is back." };
  if (e instanceof Anthropic.APIError) return { type: "error", kind: "other", message: `API error ${e.status ?? ""}: ${e.message}` };
  return { type: "error", kind: "other", message: (e as Error).message ?? String(e) };
}

function retryable(e: unknown): number | null {
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 503))) {
    const h = (e as InstanceType<typeof Anthropic.APIError>).headers as unknown as { get?: (k: string) => string | null } | undefined;
    const ra = Number(h?.get?.("retry-after"));
    return Number.isFinite(ra) && ra > 0 ? ra * 1000 : -1;
  }
  return null;
}

export class Agent {
  private client: MessageClient;
  private ledger: Ledger;
  constructor(client: MessageClient, ledger: Ledger) {
    this.client = client;
    this.ledger = ledger;
  }

  // Runs one team turn. Appends to `conv` (never rewrites it). Emits events as it goes.
  async run(conv: Conversation, prompt: BuiltPrompt, ctx: ToolContext, opts: RunOptions, emit: (e: AgentEvent) => void): Promise<"done" | "paused" | "failed"> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (conv.pending) {
      content.push(...conv.pending.otherResults);
      content.push({ type: "tool_result", tool_use_id: conv.pending.submitId, content: opts.decision ?? "The team moved on without answering." });
      conv.pending = null;
    }
    content.push({ type: "text", text: opts.userText });
    conv.messages.push({ role: "user", content });
    return this.loop(conv, prompt, ctx, opts, emit);
  }

  // Continues a paused turn: the last message is a user turn waiting for the model.
  async resume(conv: Conversation, prompt: BuiltPrompt, ctx: ToolContext, opts: RunOptions, emit: (e: AgentEvent) => void): Promise<"done" | "paused" | "failed"> {
    return this.loop(conv, prompt, ctx, opts, emit);
  }

  private async call(prompt: BuiltPrompt, conv: Conversation, opts: RunOptions, emit: (e: AgentEvent) => void): Promise<Anthropic.Message> {
    let wait = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.create({
          model: MODEL,
          max_tokens: 16000,
          system: prompt.system,
          tools: TOOL_DEFS,
          tool_choice: { type: "auto" },
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort },
          messages: conv.messages,
        } as Anthropic.MessageCreateParamsNonStreaming);
      } catch (e) {
        const r = retryable(e);
        if (r === null || attempt >= 3) throw e;
        const ms = r > 0 ? r : wait;
        emit({ type: "status", text: `The API is busy (${(e as InstanceType<typeof Anthropic.APIError>).status ?? "rate limit"}). Retrying in ${Math.round(ms / 1000)} s.` });
        await sleep(ms);
        wait *= 2;
      }
    }
  }

  // After a failed turn the last assistant message may hold tool_use blocks with no results; answer
  // them so the conversation stays valid for the next turn (append-only, nothing is removed).
  private seal(conv: Conversation, why: string): void {
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
    const ids = (last.content as Anthropic.ContentBlockParam[]).filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use").map((b) => b.id);
    if (ids.length) conv.messages.push({ role: "user", content: ids.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: `Not run: ${why}`, is_error: true })) });
  }

  private async loop(conv: Conversation, prompt: BuiltPrompt, ctx: ToolContext, opts: RunOptions, emit: (e: AgentEvent) => void): Promise<"done" | "paused" | "failed"> {
    const r = await this.loopInner(conv, prompt, ctx, opts, emit);
    if (r === "failed") this.seal(conv, "the turn ended with an error");
    return r;
  }

  private async loopInner(conv: Conversation, prompt: BuiltPrompt, ctx: ToolContext, opts: RunOptions, emit: (e: AgentEvent) => void): Promise<"done" | "paused" | "failed"> {
    const maxIter = opts.maxIterations ?? 12;
    const maxRepairs = opts.maxRepairs ?? 2;
    let repairs = 0;
    for (let i = 0; i < maxIter; i++) {
      if (!this.ledger.canSpend()) {
        emit({ type: "paused", reason: `Session spend reached the $${this.ledger.cap.toFixed(0)} cap.` });
        return "paused";
      }
      let msg: Anthropic.Message;
      try {
        emit({ type: "status", text: i === 0 ? "Thinking" : "Checking" });
        msg = await this.call(prompt, conv, opts, emit);
      } catch (e) {
        emit(errorKind(e));
        return "failed";
      }
      const entry = this.ledger.record(opts.task, MODEL, msg.usage as never, msg.stop_reason ?? "");
      emit({ type: "usage", usd: entry.usd, session: this.ledger.spentThisSession(), cacheRead: entry.cacheRead, promptTokens: entry.promptTokens });
      // keep the whole content, thinking blocks included, unmodified
      conv.messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });

      if (msg.stop_reason === "refusal") {
        const details = (msg as unknown as { stop_details?: { category?: string | null } }).stop_details;
        emit({ type: "error", kind: "refusal", message: `The model declined this request${details?.category ? ` (${details.category})` : ""}. Rephrase it; Haiku 5.5 has no fallback model.` });
        return "failed";
      }
      if (msg.stop_reason === "max_tokens") {
        emit({ type: "error", kind: "limit", message: "The answer ran past max_tokens. Try a smaller request (fewer junctions at once)." });
        return "failed";
      }
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        if (repairs >= maxRepairs) {
          emit({ type: "error", kind: "other", message: "The model stopped without calling submit_patch." });
          return "failed";
        }
        repairs++;
        conv.messages.push({ role: "user", content: [{ type: "text", text: "Call submit_patch with your answer now. Every leg in the task needs during and end." }] });
        continue;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      let submitted: { patch: Patch; spec: AutoSpec; claims: ClaimResult } | null = null;
      let submitId: string | null = null;
      for (const u of uses) {
        const out = await runTool(u.name, (u.input ?? {}) as Record<string, unknown>, ctx);
        emit({ type: "tool", name: u.name, summary: out.isError ? `error: ${errorSummary(out.content)}` : out.content.split("\n")[0].slice(0, 140) });
        if (out.claims) emit({ type: "claims", tool: u.name, ok: out.claims.ok, mismatches: out.claims.mismatches.length, unverified: out.claims.unverifiedNumbers.length });
        if (u.name === "submit_patch") {
          if (out.submitted && !submitted) {
            submitted = out.submitted;
            submitId = u.id;
            continue; // answered later with the team's decision
          }
          if (out.isError) repairs++;
        }
        results.push({ type: "tool_result", tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      if (submitted && submitId) {
        conv.pending = { submitId, otherResults: results };
        emit({ type: "result", patch: submitted.patch, spec: submitted.spec, claims: submitted.claims, repairs });
        return "done";
      }
      if (repairs > maxRepairs) {
        conv.messages.push({ role: "user", content: results });
        emit({ type: "error", kind: "other", message: `The answer still failed its checks after ${maxRepairs} repair attempts.` });
        return "failed";
      }
      conv.messages.push({ role: "user", content: results });
    }
    emit({ type: "error", kind: "other", message: "The model used too many steps without an answer." });
    return "failed";
  }
}

// Validates a key with a no-token call (a model lookup). If the lookup is refused (403), the key may
// still be allowed to send messages, so try the smallest possible request (a few tokens, well under
// $0.0001) and report the API's own words either way.
export async function validateKey(apiKey: string, workspaceId?: string | null): Promise<{ ok: boolean; message: string }> {
  const c = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000, defaultHeaders: headers(workspaceId) });
  try {
    const m = await c.models.retrieve(MODEL);
    return { ok: true, message: `Key works; ${m.display_name ?? MODEL} is available.` };
  } catch (e) {
    if (!(e instanceof Anthropic.PermissionDeniedError)) return { ok: false, message: errorKind(e).message };
    try {
      await c.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply OK." }] } as Anthropic.MessageCreateParamsNonStreaming);
      return { ok: true, message: `Key works for ${MODEL} (the model lookup is not allowed for this key, but messages are).` };
    } catch (e2) {
      const detail = e2 instanceof Anthropic.APIError ? `${e2.status ?? ""} ${e2.message}` : String(e2);
      const hint = workspaceId
        ? `Check in the Anthropic Console that workspace ${workspaceId} allows ${MODEL}, that this key may use it, and that the account has credit.`
        : `If this key is not tied to one workspace (an organization-wide or admin key), enter the workspace ID (Console → Settings → Workspaces, it starts with wrkspc_). Otherwise check that the key's workspace allows ${MODEL} and that the account has credit.`;
      const orgWide = e2 instanceof Anthropic.PermissionDeniedError
        ? " A 403 on every request (even the free model lookup) usually means the organization itself may not make API calls yet: for example its credit is not API credit (the Claude Code cloud-session promotion is not), or the account needs Anthropic to enable it."
        : "";
      return { ok: false, message: `This key cannot use ${MODEL}. Anthropic says: ${detail.trim()}. ${hint}${orgWide}` };
    }
  }
}
