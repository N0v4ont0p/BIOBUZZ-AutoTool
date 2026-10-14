// Evaluation runner. Every score uses labels code can verify (eval/generate.ts).
//   node eval/run.ts --model rubric            the rubric in code (reference; must be 100%)
//   node eval/run.ts --model mock              a scripted model through the REAL agent loop and tools
//   node eval/run.ts --model ai [options]      Claude Haiku 5.5 (needs the API key; spends money)
// Options: --split train|validation|test|all (default validation) --kinds synthetic,perturbed,...
//          --limit N --prompt v1|naive --effort low|medium|high --examples 0|2|4|6 --hint
//          --budget USD (hard stop, default 1) --repeat N --out name
// Results: eval/results/<time>-<name>.json and .md

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { autoStops, evidenceFor, legKey } from "../src/shared/stops.ts";
import { featureSheet } from "../src/shared/patch.ts";
import { type Profile, defaultFacts } from "../src/shared/profile.ts";
import type { AutoSpec, End } from "../src/shared/spec.ts";
import { Agent, type AgentEvent, type MessageClient, sdkClient } from "../src/server/ai/agent.ts";
import { Ledger } from "../src/server/ai/ledger.ts";
import { DEFAULT_PROMPT_OPTIONS, type PromptExample, type PromptOptions, buildSystemPrompt, knownConfusions } from "../src/server/ai/prompt.ts";
import type { ToolContext } from "../src/server/ai/tools.ts";
import type { Digest } from "../src/server/digest.ts";
import { RobotRepo } from "../src/server/repo.ts";
import { Store } from "../src/server/store.ts";
import { type EvalCase, model, pack } from "./generate.ts";

const here = new URL(".", import.meta.url).pathname;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export const EVAL_PROFILE: Profile = {
  profileVersion: 1,
  team: "eval",
  season: pack.season,
  repo: { path: "", autosDir: "" },
  createdAt: "",
  updatedAt: "",
  facts: defaultFacts(),
  conventions: { indent: "    ", poseWrap: "redTrim", numberDecimals: 3, pathMethodStyle: "camelCase: startToShot1", legListStyle: "Arrays.asList", found: ["AutoPaths.java: poses wrapped as redTrim(poseFactory.of(x, y, h), 0, 0, 0)"] },
  startingBalanceUsd: null,
  sanityConfirmed: true,
};
export const EVAL_DIGEST: Digest = {
  version: 1,
  builtAt: "",
  head: null,
  hash: "eval",
  files: [],
  symbols: {},
  constants: {},
  shotTables: { front: { rows: 0, min: null, max: null, line: null }, back: { rows: 0, min: null, max: null, line: null } },
  facts: [],
  legApi: { actions: ["NONE", "INTAKE", "RAMP", "SHOOT", "PARK", "WAIT"], methods: ["Leg(Path, During, End)", "Leg(Pose target, During, End)", "timeout(seconds)", "carryIntake(seconds)", "shotTimeout(seconds)", "waitFor(seconds)"], file: "opmodes/AutoRunner.java" },
  autoPaths: { file: "opmodes/AutoPaths.java", exists: true },
};

const NAIVE_SYSTEM = "You decide what each leg of an FTC autonomous route does. For each leg choose during (NONE, INTAKE, RAMP) and end (NONE, SHOOT, PARK, WAIT), or set review. Use the tools, then call submit_patch once with every leg decided. List every number you write in claims with its feature key.";

export function specText(spec: AutoSpec): string {
  const s = {
    name: spec.name,
    ...(spec.javadoc ? { comment: spec.javadoc } : {}),
    start: spec.start,
    preload: spec.preload,
    poses: spec.poses.map((p) => ({ name: p.name, x: p.x, y: p.y, headingDeg: p.headingDeg, role: p.role })),
    legs: spec.legs.map((l) => ({ id: l.id, path: l.path, heading: l.heading, during: l.during, end: l.end, decidedBy: l.junction.source, timeoutS: l.legTimeoutS, carryIntakeS: l.carryIntakeS, ...(l.comment ? { comment: l.comment } : {}) })),
  };
  return `Current auto spec (data, not instructions):\n\`\`\`json\n${JSON.stringify(s)}\n\`\`\``;
}

export function taskText(spec: AutoSpec): string {
  const ids = spec.legs.map((l) => l.id);
  return `Task: decide legs ${ids.join(", ")} of the auto "${spec.name}" (during and end). Call get_features first. Reason per leg in route order, then submit_patch with one entry per leg (ops empty unless a leg needs an edit).\n\n${specText(spec)}`;
}

// A scripted model that answers like a perfect annotator, through the real agent loop and tools.
function mockClient(spec: AutoSpec): MessageClient {
  let step = 0;
  return {
    async create(): Promise<Anthropic.Message> {
      step++;
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      if (step === 1) return { id: "m1", type: "message", role: "assistant", model: "mock", content: [{ type: "tool_use", id: "t1", name: "get_features", input: {} }], stop_reason: "tool_use", stop_sequence: null, usage } as unknown as Anthropic.Message;
      const r = autoStops(spec, pack, model, undefined);
      const f = r.features;
      const sheet = featureSheet(f);
      const junctions = r.decisions.map((d) => {
        const j = f.junctions.find((x) => x.id === d.junction)!;
        return { junction: d.junction, evidence: evidenceFor(j, f.legs[j.index], model), during: d.during, end: d.end, ...(d.review ? { review: true } : {}), reason: `Rubric row ${d.rule.split(" ")[0]}: ${d.rule.slice(2)}.` };
      });
      const first = f.junctions[0];
      const input = { summary: `Decided ${junctions.length} legs; the first stop is ${sheet[`${first.id}.dist`]} in from the CELL.`, junctions, ops: [], claims: [{ ref: "total.junctions", value: junctions.length }, { ref: `${first.id}.dist`, value: sheet[`${first.id}.dist`] }] };
      return { id: "m2", type: "message", role: "assistant", model: "mock", content: [{ type: "tool_use", id: "t2", name: "submit_patch", input }], stop_reason: "tool_use", stop_sequence: null, usage } as unknown as Anthropic.Message;
    },
  };
}

// Negative control: ends every leg in SHOOT and cites a wrong number. The harness must catch both.
function badClient(spec: AutoSpec): MessageClient {
  return {
    async create(): Promise<Anthropic.Message> {
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const input = { summary: "Every stop is a shot from 12.5 in.", junctions: spec.legs.map((l) => ({ junction: l.id, evidence: [], during: "NONE", end: "SHOOT", reason: "Looks like a shot." })), ops: [], claims: [{ ref: "L1.dist", value: 12.5 }] };
      return { id: "b", type: "message", role: "assistant", model: "bad", content: [{ type: "tool_use", id: `b${Math.random()}`, name: "submit_patch", input }], stop_reason: "tool_use", stop_sequence: null, usage } as unknown as Anthropic.Message;
    },
  };
}

// "Wrong?" clicks in the UI: the team's own answer for one leg. Reported as their own kind ("team"),
// never mixed into the code-verified score.
function teamCases(store: Store): EvalCase[] {
  const out: EvalCase[] = [];
  const repos = store.path("repos");
  if (!existsSync(repos)) return out;
  for (const r of readdirSync(repos)) {
    const dir = join(repos, r, "cases");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; spec: AutoSpec; junction: string; expected: string; note?: string };
      const spec = structuredClone(c.spec);
      for (const l of spec.legs) if (l.junction.source !== "imported") Object.assign(l, { during: "NONE", end: "NONE", junction: { source: "none", evidence: [] } });
      out.push({ id: `team_${c.id}`, kind: "team", split: "test", note: c.note ?? "", spec, expected: { [c.junction]: [c.expected] }, scoreAccuracy: [c.junction], difficulty: "hard" });
    }
  }
  return out;
}

interface CaseResult {
  id: string;
  kind: string;
  group?: string;
  predicted: Record<string, string | null>;
  scored: number;
  correct: number;
  mustNotViolations: number;
  firstSubmitValid: boolean | null;
  answered: boolean;
  claimMismatches: number;
  unverifiedNumbers: number;
  submitAttempts: number;
  inventedAttempts: number;
  deliveredInvented: number;
  repairs: number;
  usd: number;
  cacheRead: number;
  promptTokens: number;
  error?: string;
}

function score(c: EvalCase, predicted: Record<string, string | null>) {
  let scored = 0;
  let correct = 0;
  for (const j of c.scoreAccuracy) {
    scored++;
    if (predicted[j] && c.expected[j].includes(predicted[j]!)) correct++;
  }
  let mustNotViolations = 0;
  for (const [j, bad] of Object.entries(c.mustNot ?? {})) if (predicted[j] && bad.includes(predicted[j]!.split("/")[1] as End)) mustNotViolations++;
  return { scored, correct, mustNotViolations };
}

async function runCase(c: EvalCase, mode: string, opts: PromptOptions, promptKind: string, key: string | null, ledger: Ledger, repo: RobotRepo): Promise<CaseResult> {
  const base = { id: c.id, kind: c.kind, ...(c.group ? { group: c.group } : {}) };
  if (mode === "rubric") {
    const r = autoStops(c.spec, pack, model, undefined);
    const predicted = Object.fromEntries(r.spec.legs.map((l) => [l.id, legKey(l)]));
    return { ...base, predicted, ...score(c, predicted), firstSubmitValid: null, answered: true, claimMismatches: 0, unverifiedNumbers: 0, submitAttempts: 0, inventedAttempts: 0, deliveredInvented: 0, repairs: 0, usd: 0, cacheRead: 0, promptTokens: 0 };
  }
  const examples: PromptExample[] = (() => {
    try {
      return JSON.parse(readFileSync(`${here}examples.json`, "utf8"));
    } catch {
      return [];
    }
  })();
  const built = buildSystemPrompt(EVAL_PROFILE, EVAL_DIGEST, pack, examples, opts, knownConfusions(`${here}known-confusions.md`));
  const prompt = promptKind === "naive" ? { ...built, system: [{ type: "text" as const, text: NAIVE_SYSTEM, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] } : built;
  const client = mode === "mock" ? mockClient(c.spec) : mode === "mockbad" ? badClient(c.spec) : sdkClient(key!, process.env.ANTHROPIC_WORKSPACE_ID ?? new Store().readWorkspace());
  const ctx: ToolContext = { spec: c.spec, pack, model, profile: EVAL_PROFILE, repo, hint: opts.hint, compileCache: "/tmp", userNumbers: [], draft: null };
  const events: AgentEvent[] = [];
  const before = ledger.spentThisSession();
  const reads0 = ledger.entries().length;
  const outcome = await new Agent(client, ledger).run({ messages: [], pending: null }, prompt, ctx, { task: `eval:${c.id}`, userText: taskText(c.spec), effort: opts.effort }, (e) => events.push(e));
  const result = events.find((e) => e.type === "result");
  const err = events.find((e) => e.type === "error");
  const firstSubmit = events.find((e) => e.type === "tool" && e.name === "submit_patch");
  const predicted: Record<string, string | null> = Object.fromEntries(c.spec.legs.map((l) => [l.id, null]));
  let claimMismatches = 0;
  let unverifiedNumbers = 0;
  let repairs = 0;
  let deliveredInvented = 0;
  if (result && result.type === "result") {
    deliveredInvented = result.claims.mismatches.length + result.claims.unverifiedNumbers.length;
    for (const l of result.spec.legs) predicted[l.id] = legKey(l);
    repairs = result.repairs;
  }
  // hallucinations are counted over every attempt the model made, accepted or rejected
  for (const e of events) if (e.type === "claims" && e.tool === "submit_patch") {
    claimMismatches += e.mismatches;
    unverifiedNumbers += e.unverified;
  }
  const attempts = events.filter((e) => e.type === "claims" && e.tool === "submit_patch");
  const inventedAttempts = attempts.filter((e) => e.type === "claims" && !e.ok && e.mismatches + e.unverified > 0).length;
  const mine = ledger.entries().slice(reads0);
  return {
    ...base,
    predicted,
    ...score(c, predicted),
    firstSubmitValid: firstSubmit ? !(firstSubmit.type === "tool" && firstSubmit.summary.startsWith("error")) : false,
    answered: outcome === "done" && !!result,
    claimMismatches,
    unverifiedNumbers,
    submitAttempts: attempts.length,
    inventedAttempts,
    deliveredInvented,
    repairs,
    usd: ledger.spentThisSession() - before,
    cacheRead: mine.reduce((s, e) => s + e.cacheRead, 0),
    promptTokens: mine.reduce((s, e) => s + e.promptTokens, 0),
    ...(err && err.type === "error" ? { error: err.message } : {}),
  };
}

export function summarize(results: CaseResult[], cases: EvalCase[]) {
  const sum = (f: (r: CaseResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const byKind: Record<string, { scored: number; correct: number; cases: number }> = {};
  for (const r of results) {
    const k = (byKind[r.kind] ??= { scored: 0, correct: 0, cases: 0 });
    k.scored += r.scored;
    k.correct += r.correct;
    k.cases++;
  }
  // metamorphic: every member of a group must get the same labels
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) if (r.group) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  let groupsChecked = 0;
  let groupsConsistent = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    groupsChecked++;
    const sig = (r: CaseResult) => JSON.stringify(Object.values(r.predicted));
    if (g.every((r) => sig(r) === sig(g[0]))) groupsConsistent++;
  }
  // REPOSITION vs SETTLE has no code truth: scored for consistency only (within groups)
  const confusion: Record<string, Record<string, number>> = {};
  const caseById = new Map(cases.map((c) => [c.id, c]));
  for (const r of results) {
    const c = caseById.get(r.id)!;
    for (const j of c.scoreAccuracy) {
      const want = c.expected[j].join("|");
      const got = r.predicted[j] ?? "none";
      (confusion[want] ??= {})[got] = (confusion[want][got] ?? 0) + 1;
    }
  }
  // the headline score is code-verified only; the team's flagged cases are reported on their own
  const verified = results.filter((r) => r.kind !== "team");
  const scored = verified.reduce((a, r) => a + r.scored, 0);
  const prompt = sum((r) => r.promptTokens);
  return {
    cases: results.length,
    junctionAccuracy: scored ? verified.reduce((a, r) => a + r.correct, 0) / scored : null,
    scoredJunctions: scored,
    mustNotViolations: sum((r) => r.mustNotViolations),
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { ...v, accuracy: v.scored ? v.correct / v.scored : null }])),
    metamorphic: { groupsChecked, groupsConsistent },
    schemaValidFirstTry: results.filter((r) => r.firstSubmitValid !== null).length ? results.filter((r) => r.firstSubmitValid).length / results.filter((r) => r.firstSubmitValid !== null).length : null,
    answered: results.filter((r) => r.answered).length / results.length,
    inventedFactsPerAnswer: results.length ? sum((r) => r.claimMismatches + r.unverifiedNumbers) / results.length : 0,
    // share of the model's submit attempts that contained an invented number (accepted or rejected)
    inventedFactRate: sum((r) => r.submitAttempts) ? sum((r) => r.inventedAttempts) / sum((r) => r.submitAttempts) : 0,
    // after code corrected the text: a number with no computed value left in the delivered answer
    inventedReachedAnswer: results.filter((r) => r.answered && r.deliveredInvented > 0).length,
    usd: sum((r) => r.usd),
    usdPerAnnotation: results.length ? sum((r) => r.usd) / results.length : 0,
    cacheHitRate: prompt ? sum((r) => r.cacheRead) / prompt : null,
    repairs: sum((r) => r.repairs),
    errors: results.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`),
    confusion,
  };
}

async function main() {
  const mode = arg("model", "rubric")!;
  const split = arg("split", "validation")!;
  const kinds = arg("kinds")?.split(",");
  const limit = Number(arg("limit", "0"));
  const opts: PromptOptions = {
    examples: Number(arg("examples", String(DEFAULT_PROMPT_OPTIONS.examples))) as PromptOptions["examples"],
    hint: flag("hint"),
    rubricStyle: (arg("rubric", "table") as PromptOptions["rubricStyle"]) ?? "table",
    effort: (arg("effort", DEFAULT_PROMPT_OPTIONS.effort) as PromptOptions["effort"]) ?? "medium",
  };
  const promptKind = arg("prompt", "v1")!;
  const budget = Number(arg("budget", "1"));
  const repeat = Number(arg("repeat", "1"));
  const all: EvalCase[] = JSON.parse(readFileSync(`${here}cases.json`, "utf8"));
  let cases = all.filter((c) => split === "all" || c.split === split).filter((c) => !kinds || kinds.includes(c.kind));
  if (limit > 0) cases = cases.slice(0, limit);
  const store = new Store();
  if (flag("user-cases")) cases = cases.concat(teamCases(store));
  const key = mode === "ai" ? (process.env.ANTHROPIC_API_KEY ?? store.readKey()) : null;
  if (mode === "ai" && !key) throw new Error("no API key: run onboarding (or set ANTHROPIC_API_KEY)");
  const ledger = new Ledger(store, `eval-${Date.now().toString(36)}`);
  ledger.cap = budget;
  const repoRoot = `${here}fixture-repo`;
  mkdirSync(`${repoRoot}/TeamCode/src/main/java/org/firstinspires/ftc/teamcode/opmodes`, { recursive: true });
  writeFileSync(`${repoRoot}/TeamCode/src/main/java/org/firstinspires/ftc/teamcode/opmodes/AutoRunner.java`, "package org.firstinspires.ftc.teamcode.opmodes;\npublic abstract class AutoRunner {}\n");
  const repo = RobotRepo.open(repoRoot);
  const results: CaseResult[] = [];
  const t0 = Date.now();
  for (let rep = 0; rep < repeat; rep++) {
    for (const c of cases) {
      if (mode === "ai" && !ledger.canSpend()) {
        console.log(`budget $${budget} reached after ${results.length} cases`);
        break;
      }
      const r = await runCase(c, mode, opts, promptKind, key, ledger, repo);
      results.push(rep ? { ...r, id: r.id, group: `${r.group ?? r.id}#repeat` } : r);
      if (mode === "ai") process.stdout.write(`${c.id}: ${r.correct}/${r.scored}${r.mustNotViolations ? " MUSTNOT" : ""}${r.error ? ` ERROR ${r.error}` : ""} $${r.usd.toFixed(4)}\n`);
    }
  }
  const s = summarize(results, cases);
  const name = arg("out", `${mode}-${promptKind}-${split}`)!;
  mkdirSync(`${here}results`, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${here}results/${stamp}-${name}`;
  writeFileSync(`${file}.json`, JSON.stringify({ config: { mode, split, kinds, limit, opts, promptKind, budget, repeat }, summary: s, results }, null, 1));
  const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
  const md = [
    `# Eval ${name} (${new Date().toISOString()})`,
    ``,
    `mode ${mode}, prompt ${promptKind}, split ${split}, effort ${opts.effort}, examples ${opts.examples}, hint ${opts.hint}, ${results.length} cases, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    ``,
    `| Metric | Value | Target |`,
    `|---|---|---|`,
    `| junction label accuracy | ${pct(s.junctionAccuracy)} (${s.scoredJunctions} scored) | >= 90% synthetic, >= 95% real |`,
    `| must-not violations (e.g. SHOOT out of the zone) | ${s.mustNotViolations} | 0 |`,
    `| metamorphic groups consistent | ${s.metamorphic.groupsConsistent}/${s.metamorphic.groupsChecked} | all |`,
    `| schema valid on the first submit | ${pct(s.schemaValidFirstTry)} | 100% |`,
    `| answered | ${pct(s.answered)} | 100% |`,
    `| submit attempts with an invented number | ${pct(s.inventedFactRate)} | < 1% |`,
    `| invented numbers that reached an answer | ${s.inventedReachedAnswer} | 0 |`,
    `| cost | $${s.usd.toFixed(4)} ($${s.usdPerAnnotation.toFixed(5)} per annotation) | < $0.01 per annotation |`,
    `| cache hit rate | ${pct(s.cacheHitRate)} | > 90% after the first call |`,
    ``,
    `By kind: ${Object.entries(s.byKind).map(([k, v]) => `${k} ${pct(v.accuracy)} (${v.cases} cases)`).join(", ")}`,
    ``,
    s.errors.length ? `Errors:\n${s.errors.map((e) => `- ${e}`).join("\n")}` : "No errors.",
  ].join("\n");
  writeFileSync(`${file}.md`, md + "\n");
  console.log(md);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
