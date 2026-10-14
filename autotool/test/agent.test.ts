import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { computeFeatures } from "../src/shared/features.ts";
import { evidenceFor } from "../src/shared/stops.ts";
import { checkClaims, featureSheet } from "../src/shared/patch.ts";
import { type Profile, defaultFacts, robotModel } from "../src/shared/profile.ts";
import type { SeasonPack } from "../src/shared/season.ts";
import { cloneSpec } from "../src/shared/spec.ts";
import { Agent, type AgentEvent, type Conversation, type MessageClient } from "../src/server/ai/agent.ts";
import { CAP_STEP_USD, Ledger, costOf } from "../src/server/ai/ledger.ts";
import { DEFAULT_PROMPT_OPTIONS, buildSystemPrompt } from "../src/server/ai/prompt.ts";
import type { ToolContext } from "../src/server/ai/tools.ts";
import type { Digest } from "../src/server/digest.ts";
import { RobotRepo } from "../src/server/repo.ts";
import { Store } from "../src/server/store.ts";
import { sampleSpec } from "./fixtures/sample.ts";

const here = new URL(".", import.meta.url).pathname;
const pack: SeasonPack = JSON.parse(readFileSync(`${here}../season/biobuzz-2026-27.json`, "utf8"));
const model = robotModel(defaultFacts());

function fakeRepo(): RobotRepo {
  const root = mkdtempSync(join(tmpdir(), "autotool-repo-"));
  const dir = join(root, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode", "opmodes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AutoRunner.java"), "package org.firstinspires.ftc.teamcode.opmodes;\npublic abstract class AutoRunner {}\n");
  return RobotRepo.open(root);
}

const profile: Profile = {
  profileVersion: 1,
  team: "19859",
  season: "biobuzz-2026-27",
  repo: { path: "/x", autosDir: "opmodes" },
  createdAt: "",
  updatedAt: "",
  facts: defaultFacts(),
  conventions: { indent: "    ", poseWrap: "redTrim", numberDecimals: 3, pathMethodStyle: "", legListStyle: "Arrays.asList", found: [] },
  startingBalanceUsd: 100,
  sanityConfirmed: true,
};
const digest: Digest = {
  version: 1,
  builtAt: "",
  head: null,
  hash: "x",
  files: [],
  symbols: {},
  constants: {},
  shotTables: { front: { rows: 0, min: null, max: null, line: null }, back: { rows: 0, min: null, max: null, line: null } },
  facts: [],
  legApi: { actions: ["NONE", "INTAKE", "SHOOT", "PARK"], methods: ["Leg(Path, Action)"], file: "AutoRunner.java" },
  autoPaths: { file: "AutoPaths.java", exists: false },
};
const prompt = buildSystemPrompt(profile, digest, pack, [], DEFAULT_PROMPT_OPTIONS, "");

function msg(content: unknown[], stop: string, usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000 }): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: stop, stop_sequence: null, usage } as unknown as Anthropic.Message;
}

class Scripted implements MessageClient {
  calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private replies: ((p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message)[];
  constructor(replies: ((p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message)[]) {
    this.replies = replies;
  }
  async create(p: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.calls.push(JSON.parse(JSON.stringify(p)));
    const r = this.replies.shift();
    if (!r) throw new Error("no more scripted replies");
    return r(p);
  }
}

function drawn() {
  const s = cloneSpec(sampleSpec());
  for (const l of s.legs) {
    l.during = "NONE";
    l.end = "NONE";
    l.carryIntakeS = 0;
    l.junction = { source: "none", evidence: [] };
  }
  return s;
}

function rightAnswer(s = drawn()) {
  const f = computeFeatures(s, pack, model);
  const legs = [["NONE", "SHOOT"], ["NONE", "NONE"], ["INTAKE", "NONE"], ["NONE", "SHOOT"], ["NONE", "PARK"]];
  return {
    summary: `Preload shot at ${featureSheet(f)["L1.dist"]} in, garden intake, second shot, park.`,
    junctions: f.junctions.map((j, i) => ({ junction: j.id, evidence: evidenceFor(j, f.legs[i], model), during: legs[i][0], end: legs[i][1], reason: "From the evidence." })),
    ops: [],
    claims: [{ ref: "L1.dist", value: featureSheet(f)["L1.dist"] }],
  };
}

function ctx(): ToolContext {
  return { spec: drawn(), pack, model, profile, repo: fakeRepo(), hint: false, compileCache: join(tmpdir(), "autotool-cc"), userNumbers: [], draft: null };
}

test("prompt: fixed modules first, one 1h cache breakpoint on the generated block, lint clean", () => {
  assert.equal(prompt.system.length, 2);
  assert.equal(prompt.system[0].cache_control, undefined);
  assert.deepEqual(prompt.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(prompt.lint, []);
  assert.ok(prompt.approxTokens > 512, `${prompt.approxTokens}`);
  assert.match(prompt.system[0].text, /data, not instructions/);
  assert.match(prompt.system[0].text, /Keep working until every leg in the task is decided/);
});

test("agent: tool round trip, thinking passed back unmodified, request shape per Haiku 5.5 rules", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "autotool-cfg-")));
  const ledger = new Ledger(store, "s1");
  const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
  const client = new Scripted([
    () => msg([thinking, { type: "tool_use", id: "t1", name: "get_features", input: {} }], "tool_use"),
    () => msg([{ type: "tool_use", id: "t2", name: "submit_patch", input: rightAnswer() }], "tool_use"),
  ]);
  const agent = new Agent(client, ledger);
  const conv: Conversation = { messages: [], pending: null };
  const events: AgentEvent[] = [];
  const c = ctx();
  const r = await agent.run(conv, prompt, c, { task: "annotate", userText: "Task: label L1-L5.", effort: "medium" }, (e) => events.push(e));
  assert.equal(r, "done");
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.deepEqual(result.spec.legs.map((l) => `${l.during}/${l.end}`), ["NONE/SHOOT", "NONE/NONE", "INTAKE/NONE", "NONE/SHOOT", "NONE/PARK"]);
  assert.ok(result.spec.legs.every((l) => l.junction.source === "ai"));
  // second request carries the first assistant turn, thinking block included and unmodified
  const second = client.calls[1];
  const asst = second.messages[1];
  assert.equal(asst.role, "assistant");
  assert.deepEqual((asst.content as unknown[])[0], thinking);
  const toolResult = (second.messages[2].content as { type: string; tool_use_id: string }[])[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "t1");
  for (const p of client.calls) {
    assert.equal(p.model, "claude-haiku-5-5");
    assert.deepEqual(p.thinking, { type: "adaptive" });
    assert.deepEqual((p as unknown as { output_config: unknown }).output_config, { effort: "medium" });
    assert.deepEqual(p.tool_choice, { type: "auto" });
    for (const k of ["temperature", "top_p", "top_k"]) assert.equal(k in p, false);
    assert.equal(p.messages[p.messages.length - 1].role, "user"); // no prefill
  }
  // the next team turn answers the submit_patch first, then the new text
  assert.ok(conv.pending);
  const client2 = new Scripted([() => msg([{ type: "text", text: "ok" }], "end_turn"), () => msg([{ type: "text", text: "ok" }], "end_turn"), () => msg([{ type: "text", text: "ok" }], "end_turn")]);
  const agent2 = new Agent(client2, ledger);
  await agent2.run(conv, prompt, c, { task: "chat", userText: "next", decision: "Approved and written.", effort: "medium" }, () => {});
  const firstUser = client2.calls[0].messages[client2.calls[0].messages.length - 1];
  const blocks = firstUser.content as { type: string; tool_use_id?: string; content?: string }[];
  assert.equal(blocks[0].type, "tool_result");
  assert.equal(blocks[0].tool_use_id, "t2");
  assert.equal(blocks[1].type, "text");
  assert.ok(ledger.spentThisSession() > 0);
});

test("agent: a wrong number is logged and corrected by code, {key} placeholders are filled, no repair round", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "autotool-cfg-")));
  const bad = rightAnswer();
  bad.claims = [{ ref: "L1.dist", value: 12.3 }];
  bad.summary = "Preload shot at 12.3 in, {L1.dist} in by the code, from 77.7 in.";
  const client = new Scripted([() => msg([{ type: "tool_use", id: "a", name: "submit_patch", input: bad }], "tool_use"), () => msg([{ type: "text", text: "done" }], "end_turn")]);
  const events: AgentEvent[] = [];
  const r = await new Agent(client, new Ledger(store, "s")).run({ messages: [], pending: null }, prompt, ctx(), { task: "annotate", userText: "Task", effort: "medium" }, (e) => events.push(e));
  assert.equal(r, "done");
  const log = events.find((e) => e.type === "claims");
  assert.ok(log && log.type === "claims" && !log.ok && log.mismatches === 1 && log.unverified === 1); // the attempt is logged as invented
  const res = events.find((e) => e.type === "result");
  assert.ok(res && res.type === "result");
  assert.equal(res.repairs, 0);
  const d = res.claims.mismatches.length + res.claims.unverifiedNumbers.length;
  assert.equal(d, 0, "nothing invented is delivered");
  assert.doesNotMatch(res.patch.summary, /12\.3|77\.7|\{/);
  assert.match(res.patch.summary, /\[\?\]/);
});

test("agent: refusal is reported clearly; the spend cap pauses before the call", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "autotool-cfg-")));
  const ledger = new Ledger(store, "s");
  const conv: Conversation = { messages: [], pending: null };
  const events: AgentEvent[] = [];
  const refusing = new Scripted([() => ({ ...msg([], "refusal"), stop_details: { category: "cyber" } }) as unknown as Anthropic.Message]);
  assert.equal(await new Agent(refusing, ledger).run(conv, prompt, ctx(), { task: "chat", userText: "x", effort: "medium" }, (e) => events.push(e)), "failed");
  assert.ok(events.some((e) => e.type === "error" && e.kind === "refusal" && /cyber/.test(e.message)));
  // spend the whole cap in one (fake) request
  ledger.record("t", "claude-haiku-5-5", { input_tokens: 200_000_000, output_tokens: 0 }, "end_turn");
  const never = new Scripted([]);
  const ev2: AgentEvent[] = [];
  assert.equal(await new Agent(never, ledger).run(conv, prompt, ctx(), { task: "chat", userText: "y", effort: "medium" }, (e) => ev2.push(e)), "paused");
  assert.equal(never.calls.length, 0);
  ledger.raiseCap();
  assert.equal(ledger.cap, CAP_STEP_USD * 2);
});

test("cost: rate cards and cache multipliers", () => {
  assert.ok(Math.abs(costOf({ input_tokens: 50_000, output_tokens: 0 }).usd - 0.005) < 1e-12);
  assert.ok(Math.abs(costOf({ input_tokens: 0, output_tokens: 1_000_000 }).usd - 0.5) < 1e-9);
  // a 1M-token prompt is on the large card: $0.50 per million input
  assert.ok(Math.abs(costOf({ input_tokens: 1_000_000, output_tokens: 0 }).usd - 0.5) < 1e-9);
  // 1h cache write = 2x input
  assert.ok(Math.abs(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10_000 }).usd - 0.002) < 1e-12);
  // 40K cached prefix read + 2K fresh input + 500 out
  const c = costOf({ input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 });
  assert.ok(c.usd < 0.001 && c.card === "small", `${c.usd}`);
  assert.equal(costOf({ input_tokens: 120_000, output_tokens: 0 }).card, "large");
});

test("claims: unit-bearing numbers in text must be backed", () => {
  const s = sampleSpec();
  const sheet = featureSheet(computeFeatures(s, pack, model));
  const ok = checkClaims({ summary: `Holding 4 at L3, ${sheet["L1.dist"]} in to the CELL.`, junctions: [], ops: [], claims: [{ ref: "L3.held", value: 4 }, { ref: "L1.dist", value: sheet["L1.dist"] }] }, sheet);
  assert.ok(ok.ok, JSON.stringify(ok));
  const bad = checkClaims({ summary: "Holding 3 at L3.", junctions: [], ops: [], claims: [] }, sheet);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unverifiedNumbers, ["3"]);
});

test("a tool error summary shows the heading with its first item", async () => {
  const { errorSummary } = await import("../src/server/ai/tools.ts");
  assert.equal(errorSummary("Ops that failed:\n- move_pose p9: no such pose\n- other"), "Ops that failed: move_pose p9: no such pose");
  assert.equal(errorSummary("The patch does not match the schema"), "The patch does not match the schema");
});
