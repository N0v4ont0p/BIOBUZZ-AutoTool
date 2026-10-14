// Usage ledger and spend cap. Spend is estimated from the token counts the API returns; the API does
// not report the account balance, so "remaining" is the starting balance the team entered minus the
// ledger total (the real balance is in the Anthropic console).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Store } from "../store.ts";

export const MODEL = "claude-haiku-5-5"; // pinned: any change re-runs the full evaluation

// Haiku 5.5 rates, USD per million tokens (PLAN section 17; Claude API skill, cached 2026-10-06).
// Two rate cards by prompt size; cache reads 0.1x input, 5-minute writes 1.25x, 1-hour writes 2x.
export const PRICES = {
  small: { input: 0.1, output: 0.5 },
  large: { input: 0.5, output: 2.5 }, // prompts above 100K tokens
  largeAboveTokens: 100_000,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}

export function costOf(u: Usage): { usd: number; promptTokens: number; card: "small" | "large" } {
  const read = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? (u.cache_creation ? 0 : created); // no breakdown: assume 1h (what we request)
  const promptTokens = u.input_tokens + read + created;
  const card = promptTokens > PRICES.largeAboveTokens ? "large" : "small";
  const r = PRICES[card];
  const usd = (u.input_tokens * r.input + read * r.input * PRICES.cacheRead + w5 * r.input * PRICES.cacheWrite5m + w1 * r.input * PRICES.cacheWrite1h + u.output_tokens * r.output) / 1_000_000;
  return { usd, promptTokens, card };
}

export interface LedgerEntry {
  at: string;
  session: string;
  task: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  promptTokens: number;
  usd: number;
  stopReason: string;
}

export const CAP_STEP_USD = 15;

export class Ledger {
  private file: string;
  readonly session: string;
  private sessionUsd = 0;
  cap = CAP_STEP_USD;
  constructor(store: Store, session: string) {
    this.file = store.path("ledger.jsonl");
    this.session = session;
  }
  entries(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LedgerEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LedgerEntry => !!e);
  }
  // usd: the real cost when it is known (another model's rates, or what Claude Code reports)
  record(task: string, model: string, u: Usage, stopReason: string, usd?: number): LedgerEntry {
    const c = { ...costOf(u), ...(usd !== undefined ? { usd } : {}) };
    const e: LedgerEntry = {
      at: new Date().toISOString(),
      session: this.session,
      task,
      model,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      promptTokens: c.promptTokens,
      usd: c.usd,
      stopReason,
    };
    appendFileSync(this.file, JSON.stringify(e) + "\n", { mode: 0o600 });
    this.sessionUsd += c.usd;
    return e;
  }
  spentThisSession(): number {
    return this.sessionUsd;
  }
  // Checked on the server before every API call.
  canSpend(): boolean {
    return this.sessionUsd < this.cap;
  }
  raiseCap(): void {
    this.cap += CAP_STEP_USD;
  }
  summary(startingBalanceUsd: number | null) {
    const all = this.entries();
    const total = all.reduce((s, e) => s + e.usd, 0);
    const mine = all.filter((e) => e.session === this.session);
    const reads = mine.reduce((s, e) => s + e.cacheRead, 0);
    const prompt = mine.reduce((s, e) => s + e.promptTokens, 0);
    return {
      session: this.sessionUsd,
      cap: this.cap,
      warn: this.sessionUsd >= 0.8 * this.cap,
      paused: !this.canSpend(),
      requests: mine.length,
      cacheHitRate: prompt > 0 ? reads / prompt : null,
      allTime: total,
      remainingEstimate: startingBalanceUsd === null ? null : startingBalanceUsd - total,
    };
  }
}
