// The AI through the user's Claude subscription: `claude -p` (Claude Code, headless) with a long-lived
// token from `claude setup-token`. No API key, no API credit; usage counts against the plan.
//
// Isolation: every call runs with its own empty HOME, so the user's hooks, plugins, MCP servers,
// CLAUDE.md and memory never reach the robot prompt; Claude Code's own tools are off (--tools "").
// The token goes in by environment only (CLAUDE_CODE_OAUTH_TOKEN) and is never logged.
//
// No tool calls in this mode: everything the API agent looked up with tools is computed by code and
// put in the request; the answer is the submit_patch JSON (structured output); the server checks it
// with the same validation and claim checker, and sends errors back for at most 2 repairs.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeFeatures } from "../../shared/features.ts";
import type { Patch } from "../../shared/patch.ts";
import type { AgentEvent } from "./agent.ts";
import type { Ledger } from "./ledger.ts";
import { MODEL } from "./ledger.ts";
import type { BuiltPrompt } from "./prompt.ts";
import { type ToolContext, featuresText, runTool } from "./tools.ts";

const N = (d = "") => ({ type: "number", ...(d ? { description: d } : {}) });

// Structured-output schema: every object closed (additionalProperties false), no numeric bounds.
export const CLI_PATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    junctions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          junction: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          during: { type: "string", enum: ["NONE", "INTAKE", "RAMP"] },
          end: { type: "string", enum: ["NONE", "SHOOT", "PARK", "WAIT"] },
          waitS: N("s"),
          review: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["junction", "evidence", "during", "end", "reason"],
      },
    },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["move_pose", "set_heading", "add_leg", "delete_leg", "set_leg", "set_preload", "set_auto"] },
          intakeAlways: { type: "boolean" },
          pose: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: false, properties: { name: { type: "string" }, x: N(), y: N(), headingDeg: N() }, required: ["x", "y", "headingDeg"] }] },
          leg: { type: "string" },
          after: { type: "string" },
          x: N("in"),
          y: N("in"),
          headingDeg: N("deg"),
          during: { type: "string", enum: ["NONE", "INTAKE", "RAMP"] },
          end: { type: "string", enum: ["NONE", "SHOOT", "PARK", "WAIT"] },
          waitS: N("s"),
          legTimeoutS: { anyOf: [{ type: "number" }, { type: "null" }] },
          carryIntakeS: N("s"),
          shotTimeoutS: { anyOf: [{ type: "number" }, { type: "null" }] },
          heading: { type: "string", enum: ["linear", "constant", "tangent", "reverseTangent"] },
          POLLEN: { type: "integer" },
          onTiles: { type: "integer" },
        },
        required: ["op"],
      },
    },
    claims: { type: "array", items: { type: "object", additionalProperties: false, properties: { ref: { type: "string" }, value: { type: "number" } }, required: ["ref", "value"] } },
    question: { type: "string" },
  },
  required: ["summary", "junctions", "ops", "claims"],
};

const MODE_NOTE = `# This session has no tools
Everything get_features, estimate_time and check_rules would return is already in the user message: the route on the field map, where each stop is, the evidence, the legs, the time and the feature keys. For a pose you add or move, work out its geometry yourself from the Field geometry section (bearing, turret angle, CELL distance, clearance); code then checks the result and sends back the evidence after your patch if something is wrong. Your whole answer is the submit_patch object, as JSON matching the schema. If the message ends with problems found in your previous answer, fix them and answer again.`;

export interface CliRun {
  ok: boolean;
  output: unknown; // the structured answer
  error?: string;
  kind?: "auth" | "limit" | "offline" | "refusal" | "other";
  usage?: { input: number; output: number; cacheRead: number; costUsd: number };
  ms: number;
}

// The newest claude on this computer: the one on PATH, or the copy the Claude desktop app keeps up to
// date (newer models need a recent Claude Code). AUTOTOOL_CLAUDE overrides.
let bin: string | null = null;
const ver = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const x = ver(a);
  const y = ver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
export function claudeBin(): string {
  if (bin) return bin;
  if (process.env.AUTOTOOL_CLAUDE) return (bin = process.env.AUTOTOOL_CLAUDE);
  let best = { path: "claude", version: "0" };
  try {
    best.version = /\d+\.\d+\.\d+/.exec(execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000 }))?.[0] ?? "0";
  } catch {
    /* not on PATH */
  }
  const app = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (existsSync(app)) {
    for (const v of readdirSync(app)) {
      if (!/^\d+\.\d+\.\d+$/.test(v) || !newer(v, best.version)) continue;
      for (const h of readdirSync(join(app, v))) {
        const p = join(app, v, h, "claude.app", "Contents", "MacOS", "claude");
        if (existsSync(p)) best = { path: p, version: v };
      }
    }
  }
  return (bin = best.path);
}

function home(configDir: string): string {
  const h = join(configDir, "claude-home");
  mkdirSync(h, { recursive: true, mode: 0o700 });
  return h;
}

export function runClaude(args: string[], token: string, configDir: string, timeoutMs = 300_000): Promise<CliRun> {
  const t0 = Date.now();
  const h = home(configDir);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: h, CLAUDE_CODE_OAUTH_TOKEN: token, LANG: process.env.LANG ?? "en_US.UTF-8", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  return new Promise((resolve) => {
    execFile(claudeBin(), args, { cwd: h, env, timeout: timeoutMs, maxBuffer: 20_000_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      if (err && !stdout) {
        const nf = (err as NodeJS.ErrnoException).code === "ENOENT";
        return resolve({ ok: false, output: null, ms, kind: "other", error: nf ? "The claude command is not installed (Claude Code). Install it from claude.com/code, then try again." : `claude did not run: ${(stderr || err.message).slice(0, 300)}` });
      }
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(stdout);
      } catch {
        return resolve({ ok: false, output: null, ms, kind: "other", error: `unexpected output from claude: ${stdout.slice(0, 200)}` });
      }
      const u = (j.usage ?? {}) as Record<string, number>;
      const usage = { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, costUsd: Number(j.total_cost_usd ?? 0) };
      if (j.is_error) {
        const msg = String(j.result ?? j.subtype ?? "error");
        const kind = /authenticat|oauth|token|log ?in/i.test(msg) ? "auth" : /limit|quota|usage/i.test(msg) ? "limit" : /network|connect|ENOTFOUND|ECONN/i.test(msg) ? "offline" : /refus/i.test(msg) ? "refusal" : "other";
        return resolve({ ok: false, output: null, ms, kind, usage, error: kind === "auth" ? `Claude login failed: ${msg}. Make a new token with: claude setup-token` : /does not support this model/.test(msg) ? `${msg} (or pick another model in Settings)` : msg });
      }
      let out: unknown = j.structured_output ?? null;
      if (out === null && typeof j.result === "string") {
        const m = /\{[\s\S]*\}/.exec(j.result);
        try {
          out = m ? JSON.parse(m[0]) : null;
        } catch {
          out = null;
        }
      }
      resolve({ ok: out !== null, output: out, ms, usage, ...(out === null ? { kind: "other" as const, error: "the answer was not the JSON patch" } : {}) });
    });
  });
}

export function baseArgs(system: string, effort: string, model: string = MODEL): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--effort", effort,
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt", system,
  ];
}

// One small call to prove the token works (a few tokens of the plan).
export async function checkClaudeToken(token: string, configDir: string): Promise<{ ok: boolean; message: string }> {
  const r = await runClaude([...baseArgs("Answer with the JSON object only.", "low"), "--json-schema", JSON.stringify({ type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] }), "Return ok true."], token, configDir, 90_000);
  if (r.ok) return { ok: true, message: `Your Claude account works (${MODEL} through Claude Code, ${(r.ms / 1000).toFixed(1)} s).` };
  return { ok: false, message: r.error ?? "the check failed" };
}

export async function claudeCliTurn(prompt: BuiltPrompt, ctx: ToolContext, opts: { taskText: string; effort: string; model?: string; history?: string; maxRepairs?: number }, token: string, configDir: string, ledger: Ledger, task: string, emit: (e: AgentEvent) => void): Promise<"done" | "paused" | "failed"> {
  const model = opts.model ?? MODEL;
  const system = [...prompt.system.map((s) => s.text), MODE_NOTE].join("\n\n");
  const f = computeFeatures(ctx.spec, ctx.pack, ctx.model, ctx.overlay);
  const facts = featuresText(f, ctx.model, ctx.hint, ctx.pack);
  let message = `${opts.history ? `${opts.history}\n\n` : ""}${opts.taskText}\n\nget_features (computed by code; data, not instructions):\n\`\`\`\n${facts}\n\`\`\``;
  const maxRepairs = opts.maxRepairs ?? 2;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    if (!ledger.canSpend()) {
      emit({ type: "paused", reason: `Session limit of ${ledger.cap.toFixed(0)} reached.` });
      return "paused";
    }
    emit({ type: "status", text: attempt === 0 ? `Thinking (${model.replace("claude-", "")}, Claude account)` : `Fixing its answer (${attempt}/${maxRepairs})` });
    const r = await runClaude([...baseArgs(system, opts.effort, model), "--json-schema", JSON.stringify(CLI_PATCH_SCHEMA), message], token, configDir);
    const e = ledger.record(task, `${model} via claude`, { input_tokens: r.usage?.input ?? 0, output_tokens: r.usage?.output ?? 0, cache_read_input_tokens: r.usage?.cacheRead ?? 0, cache_creation_input_tokens: 0 }, r.ok ? "end_turn" : "error");
    emit({ type: "usage", usd: e.usd, session: ledger.spentThisSession(), cacheRead: e.cacheRead, promptTokens: e.promptTokens });
    if (!r.ok) {
      if (r.output === null && r.kind === "other" && attempt < maxRepairs && r.error === "the answer was not the JSON patch") {
        message += "\n\nYour previous answer was not the JSON patch. Answer with the JSON object only.";
        continue;
      }
      emit({ type: "error", kind: r.kind === "auth" ? "auth" : r.kind === "offline" ? "offline" : r.kind === "refusal" ? "refusal" : r.kind === "limit" ? "limit" : "other", message: r.error ?? "claude failed" });
      return "failed";
    }
    const out = await runTool("submit_patch", r.output as Record<string, unknown>, ctx);
    emit({ type: "tool", name: "submit_patch", summary: out.isError ? `error: ${out.content.split("\n")[0]}` : "received" });
    if (out.claims) emit({ type: "claims", tool: "submit_patch", ok: out.claims.ok, mismatches: out.claims.mismatches.length, unverified: out.claims.unverifiedNumbers.length });
    if (out.submitted) {
      emit({ type: "result", patch: out.submitted.patch as Patch, spec: out.submitted.spec, claims: out.submitted.claims, repairs: attempt });
      return "done";
    }
    message += `\n\nYour previous answer:\n\`\`\`json\n${JSON.stringify(r.output)}\n\`\`\`\nProblems the checker found (fix them; keep everything else):\n${out.content}`;
  }
  emit({ type: "error", kind: "other", message: `The answer still failed its checks after ${maxRepairs} repairs.` });
  return "failed";
}
