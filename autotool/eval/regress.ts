// The regression gate. Run before accepting any prompt, template, generator or model change:
//   node eval/regress.ts            offline gates (free, about 10 s)
//   node eval/regress.ts --live     also Claude Haiku 5.5 on the validation split (spends money,
//                                   capped by --budget, default $0.50), compared to eval/baseline.json
// Exit code 1 on any failed gate.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { importAutoTool, renderAutoFile, routeNames } from "../src/shared/java/autorunner.ts";
import { autoStops, legKey, stopKey } from "../src/shared/stops.ts";
import { stableStringify } from "../src/shared/spec.ts";
import { DEFAULT_PROMPT_OPTIONS, buildSystemPrompt, knownConfusions } from "../src/server/ai/prompt.ts";
import { TOOL_DEFS } from "../src/server/ai/tools.ts";
import { sha256 } from "../src/server/store.ts";
import { type EvalCase, generate, model, pack } from "./generate.ts";
import { EVAL_DIGEST, EVAL_PROFILE, taskText } from "./run.ts";

const here = new URL(".", import.meta.url).pathname;
const live = process.argv.includes("--live");
const gates: { name: string; ok: boolean; detail: string }[] = [];
const gate = (name: string, ok: boolean, detail = "") => gates.push({ name, ok, detail });

// 1. the case set is deterministic and current
const fresh: EvalCase[] = JSON.parse(JSON.stringify(generate())); // as written to disk (undefined fields dropped)
const stored: EvalCase[] = JSON.parse(readFileSync(`${here}cases.json`, "utf8"));
gate("eval cases are reproducible (seeded generator = eval/cases.json)", stableStringify(fresh) === stableStringify(stored), `${fresh.length} generated vs ${stored.length} stored`);

// 2. oracle consistency: the rubric in code scores 100% and never breaks a must-not
let wrong = 0;
let mustNot = 0;
for (const c of stored) {
  const r = autoStops(c.spec, pack, model);
  for (const j of c.scoreAccuracy) if (!c.expected[j].includes(legKey(r.spec.legs.find((l) => l.id === j)!))) wrong++;
  for (const [j, bad] of Object.entries(c.mustNot ?? {})) if (bad.includes(r.spec.legs.find((l) => l.id === j)!.end)) mustNot++;
}
gate("rubric reference: 100% on every case, 0 must-not violations", wrong === 0 && mustNot === 0, `${wrong} wrong, ${mustNot} must-not`);

// 3. the writer (spec -> Java -> spec) round-trips every eval auto: every leg's during/end comes back
let rt = 0;
for (const c of stored.filter((x) => x.kind === "synthetic")) {
  const decided = autoStops(c.spec, pack, model).spec;
  const java = renderAutoFile(decided, routeNames("Near", "eval"), null);
  const back = importAutoTool(java, new Map());
  if (!back.ok || back.spec.legs.some((l, i) => stopKey(l) !== stopKey(decided.legs[i]))) rt++;
}
gate("every synthetic auto renders to Java that imports back with the same during/end", rt === 0, `${rt} failures`);

// 4. prompt: lint clean, stable version for identical input, size within budget
const examples = JSON.parse(readFileSync(`${here}examples.json`, "utf8"));
const p1 = buildSystemPrompt(EVAL_PROFILE, EVAL_DIGEST, pack, examples, DEFAULT_PROMPT_OPTIONS, knownConfusions(`${here}known-confusions.md`));
const p2 = buildSystemPrompt(structuredClone(EVAL_PROFILE), structuredClone(EVAL_DIGEST), structuredClone(pack), structuredClone(examples), { ...DEFAULT_PROMPT_OPTIONS }, knownConfusions(`${here}known-confusions.md`));
gate("prompt lint clean", p1.lint.length === 0, p1.lint.join("; "));
gate("prompt version is stable (cache prefix does not drift)", p1.version === p2.version, `${p1.version} vs ${p2.version}`);
const toolsChars = JSON.stringify(TOOL_DEFS).length;
const prefixTokens = Math.ceil((p1.system.map((s) => s.text).join("").length + toolsChars) / 3.6);
gate("cached prefix is above the 512-token minimum and well under 100K", prefixTokens > 512 && prefixTokens < 100_000, `about ${prefixTokens} tokens (tools + system)`);
const sample = stored.find((c) => c.kind === "synthetic")!;
const turnTokens = Math.ceil(taskText(sample.spec).length / 3.6);

// 5. the unit tests
let testsOk = true;
let testOut = "";
try {
  testOut = execFileSync(process.execPath, ["--test", "test/**/*.test.ts"], { cwd: `${here}..`, encoding: "utf8", stdio: "pipe" });
} catch (e) {
  testsOk = false;
  testOut = String((e as { stdout?: string }).stdout ?? e);
}
const m = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(testOut);
gate("unit tests pass", testsOk, m ? `${m[1]} pass, ${m[2]} fail` : testOut.slice(-300));

// 6. the harness itself: a perfect scripted model scores 100%; a bad one is caught
function latest(name: string): string {
  const files = execFileSync("ls", ["-1t", `${here}results`], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(`-${name}.json`));
  return `${here}results/${files[0]}`;
}
function run(mode: string) {
  execFileSync(process.execPath, [`${here}run.ts`, "--model", mode, "--split", "validation", "--out", `regress-${mode}`], { cwd: `${here}..`, encoding: "utf8", env: { ...process.env, AUTOTOOL_CONFIG_DIR: `${here}fixture-repo/.cfg` } });
  return JSON.parse(readFileSync(latest(`regress-${mode}`), "utf8")).summary;
}
const good = run("mock");
const bad = run("mockbad");
gate("harness: scripted perfect model 100%, 0 invented numbers", good.junctionAccuracy === 1 && good.inventedFactRate === 0, `${(good.junctionAccuracy * 100).toFixed(1)}%, invented ${good.inventedFactRate}`);
gate("harness: a bad model is caught (its wrong labels score low; its invented numbers are logged and corrected, never delivered)", bad.inventedFactRate === 1 && bad.inventedReachedAnswer === 0 && bad.junctionAccuracy < 0.5, `accuracy ${(bad.junctionAccuracy * 100).toFixed(1)}%, invented ${bad.inventedFactRate}`);

// 7. live (optional): the real model on the validation split against the accepted baseline
if (live) {
  const budget = process.argv[process.argv.indexOf("--budget") + 1] ?? "0.5";
  execFileSync(process.execPath, [`${here}run.ts`, "--model", "ai", "--split", "validation", "--budget", budget, "--out", "regress-ai"], { cwd: `${here}..`, stdio: "inherit" });
  const s = JSON.parse(readFileSync(latest("regress-ai"), "utf8")).summary;
  let base: { junctionAccuracy: number } | null = null;
  try {
    base = JSON.parse(readFileSync(`${here}baseline.json`, "utf8"));
  } catch {
    /* first run */
  }
  gate("live: no accuracy regression vs eval/baseline.json (2 points tolerance)", !base || s.junctionAccuracy >= base.junctionAccuracy - 0.02, `${(s.junctionAccuracy * 100).toFixed(1)}% vs ${base ? (base.junctionAccuracy * 100).toFixed(1) : "none"}%`);
  gate("live: 0 must-not violations, 0 invented numbers reaching an answer", s.mustNotViolations === 0 && s.inventedReachedAnswer === 0, `${s.mustNotViolations} must-not, ${s.inventedReachedAnswer} reached`);
  if (!base) writeFileSync(`${here}baseline.json`, JSON.stringify({ junctionAccuracy: s.junctionAccuracy, at: new Date().toISOString(), prompt: p1.version }, null, 1));
}

for (const g of gates) console.log(`${g.ok ? "PASS" : "FAIL"}  ${g.name}${g.detail ? `  (${g.detail})` : ""}`);
console.log(`prompt ${p1.version}: about ${prefixTokens} cached tokens + about ${turnTokens} per task turn; cases ${sha256(stableStringify(stored)).slice(0, 10)}`);
if (gates.some((g) => !g.ok)) process.exit(1);
