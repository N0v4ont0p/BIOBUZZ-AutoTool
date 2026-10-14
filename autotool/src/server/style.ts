// The house style: a sample auto the team trusts (for example last season's BLUE_CLOSE_18), read once by
// the strongest model together with everything it uses, and turned into written rules for writing new
// autos in that structure with the classes the target robot repo really has. Required before any AI
// call or Write.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RobotRepo } from "./repo.ts";

export interface HouseStyle {
  summary: string;
  sections: { title: string; text: string }[]; // structure, paths, shooting, intake, gate, turret, auto-aim, timing, red/blue, TeleOp handoff, naming
  mapping: { sample: string; target: string; note: string }[]; // sample call -> target repo equivalent
  rules: string[]; // what every generated auto must do
  gaps: string[]; // what the target repo lacks, and the fallback
}

export interface StyleRecord {
  sampleRoot: string;
  autoFile: string; // relative to sampleRoot
  files: string[]; // sample files the analysis read
  targetFiles: string[]; // target repo files it read
  style: HouseStyle;
  notes: string; // the team's own additions
  confirmed: boolean;
  writer: "ai" | "fixed"; // ai = Opus writes each auto in the house style; fixed = AutoTool's own format (no AI)
  targetHash?: string; // the robot code the analysis read; a change (e.g. new AutoRunner options) means analyze again
  at: string;
  model: string;
}

export const STYLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    sections: { type: "array", items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] } },
    mapping: { type: "array", items: { type: "object", additionalProperties: false, properties: { sample: { type: "string" }, target: { type: "string" }, note: { type: "string" } }, required: ["sample", "target", "note"] } },
    rules: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "sections", "mapping", "rules", "gaps"],
};

const SKIP = new Set([".git", "build", ".gradle", "node_modules", ".idea", "FtcRobotController", "libs"]);
const MAX_FILE = 60_000;
const MAX_TOTAL = 260_000;

function javaRoot(root: string): string {
  const j = join(root, "TeamCode", "src", "main", "java");
  if (!existsSync(j)) throw new Error(`${root} has no TeamCode/src/main/java: pick the folder of an FTC robot repo`);
  return j;
}

function walk(dir: string, out: string[], depth = 0) {
  if (depth > 12) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".java")) out.push(p);
  }
}

// The autos of a sample repo (every @Autonomous OpMode), to pick from.
export function sampleAutos(rootIn: string): { root: string; autos: { file: string; name: string; lines: number }[] } {
  if (!rootIn || !existsSync(rootIn)) throw new Error(`folder not found: ${rootIn}`);
  const root = realpathSync(rootIn);
  const files: string[] = [];
  walk(javaRoot(root), files);
  const autos = files
    .map((f) => ({ f, text: readFileSync(f, "utf8") }))
    .filter((x) => /@Autonomous\b/.test(x.text))
    .map((x) => ({ file: relative(root, x.f).split(sep).join("/"), name: /@Autonomous\s*\(\s*name\s*=\s*"([^"]+)"/.exec(x.text)?.[1] ?? x.f.split(sep).pop()!.replace(/\.java$/, ""), lines: x.text.split("\n").length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { root, autos };
}

// The auto and everything it uses from its own repo (imports of the team's packages, followed two levels).
export function gatherSample(rootIn: string, autoFile: string): { root: string; files: { path: string; text: string }[] } {
  const root = realpathSync(rootIn);
  const jr = javaRoot(root);
  const all: string[] = [];
  walk(jr, all);
  const byClass = new Map<string, string>(); // fully qualified name -> file
  for (const f of all) byClass.set(relative(jr, f).split(sep).join(".").replace(/\.java$/, ""), f);
  const start = join(root, autoFile);
  if (!start.startsWith(root + sep) || !existsSync(start)) throw new Error(`not a file of that repo: ${autoFile}`);
  const seen = new Set<string>();
  const out: { path: string; text: string }[] = [];
  let total = 0;
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || total > MAX_TOTAL) return;
    seen.add(file);
    if (statSync(file).size > MAX_FILE * 2) return;
    const text = readFileSync(file, "utf8");
    const clipped = text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n// [... ${text.length - MAX_FILE} more characters not shown]` : text;
    out.push({ path: relative(root, file).split(sep).join("/"), text: clipped });
    total += clipped.length;
    if (depth >= 2) return;
    const pkg = /^package\s+([\w.]+);/m.exec(text)?.[1] ?? "";
    const imports = [...text.matchAll(/^import\s+(?:static\s+)?([\w.]+?)(?:\.\*|\.[A-Z_][A-Z0-9_]*)?;/gm)].map((m) => m[1]);
    // classes the file uses from its own package (no import needed)
    const samePkg = [...byClass.keys()].filter((k) => k.startsWith(`${pkg}.`) && k.split(".").length === pkg.split(".").length + 1 && new RegExp(`\\b${k.split(".").pop()}\\b`).test(text));
    for (const name of [...imports, ...samePkg]) {
      const f = byClass.get(name) ?? byClass.get(name.split(".").slice(0, -1).join("."));
      if (f) visit(f, depth + 1);
    }
  };
  visit(start, 0);
  return { root, files: out };
}

// What the target repo offers: its subsystems, config and the existing auto framework, in full.
export function gatherTarget(repo: RobotRepo): { path: string; text: string }[] {
  const want = repo
    .textFiles("TeamCode/src/main/java")
    .filter((f) => f.endsWith(".java") && /\/(subsystems|config|pedro|opmodes)\//.test(f) && !/TeleOpMain|\/procedures\/|\/(Blue|Red)_[A-Za-z0-9_]+\.java$/.test(f));
  const out: { path: string; text: string }[] = [];
  let total = 0;
  for (const f of want) {
    const text = repo.readText(f);
    if (total + text.length > MAX_TOTAL) break;
    out.push({ path: f, text });
    total += text.length;
  }
  return out;
}

export const fileBlock = (files: { path: string; text: string }[]) => files.map((f) => `=== ${f.path} ===\n${f.text}`).join("\n\n");

export const ANALYZE_SYSTEM = `You are the lead software engineer of an FTC robotics team. You read robot code with full attention to detail and you never guess: every claim you make about the code is something you read in it.

The team will write this season's autonomous programs in the style of a sample auto they trust. Read the sample auto and every file it uses, then the target robot repo (this season's robot), and write the house style: precise, written rules a code writer will follow to produce new autos in the sample's structure, using ONLY the classes, methods and constants that exist in the target repo.

Cover, from the sample, step by step and with the exact calls, numbers and timings (cite file:line for each number):
- the overall structure (OpMode type, init / init_loop / start / loop / stop duties, how the sequence is expressed);
- paths: how they are built (curves, lines, control points, heading interpolation, chains), how the robot is driven and how a step waits for the path;
- the shooting procedure in order (flywheel/shooter set-up and from what, turret or yaw angle, aim, gate, feeding, the waits and why, what happens after);
- intake (when it starts relative to the path, how long, when it stops), gates, any racing timeouts;
- auto-aim / turret use (fixed angles versus tracking, where the target comes from);
- red versus blue in the sample (note: this season's robot code reflects red by a 180-degree rotation through the field centre via MatchState.poseFactory; new autos must follow that, not the sample's convention);
- the TeleOp hand-off at the end (end pose, target) and the stop behaviour;
- naming and constants organisation.

Then map every sample call to its target-repo equivalent (class.method with the target file), and list the gaps: what the sample relies on that the target repo does not have (for example a command library or a different Pedro Pathing version) and exactly how a new auto should do the same thing with what the target repo has.

AutoTool fixes these points; write your rules inside them, never against them:
- each new auto is ONE file Blue_<Near|Far>_<tag>.java (class and Driver Station name the same, group "AutoTool") written for BLUE, plus a Red_<...>.java that AutoTool writes itself: "public class Red_X extends Blue_X" overriding only "protected MatchState.Alliance alliance()" to return RED. So the Blue class must be public, not final, declare that alliance() method, and build every pose through MatchState.poseFactory() after the alliance is set;
- the route (poses, control points, legs, the label of every stop) comes from AutoTool's drawing; your rules say HOW to turn it into code, not which poses to use;
- the path library's public API is listed with the target code: any method listed there may be used even if the team's code does not use it yet (for example curves through control points).

Rules for new autos must be concrete and checkable ("start the intake 150 ms after the path starts, stop it 400 ms before the shot", "open the gate, wait until the target repo's shooter-ready check passes, feed for N ms, close the gate"). Write in plain sentences.`;

// One hash of the robot code an analysis reads, to notice when it changes.
export function targetHash(files: { path: string; text: string }[]): string {
  return createHash("sha256").update(files.map((f) => `${f.path}\n${f.text}`).join("\n\u0000")).digest("hex").slice(0, 16);
}

// The house style as text for the AI prompt.
export function styleText(s: StyleRecord): string {
  const st = s.style;
  return [
    `House style (from the sample ${s.autoFile}):`,
    st.summary,
    ...st.sections.map((x) => `## ${x.title}\n${x.text}`),
    `## Sample call -> this robot\n${st.mapping.map((m) => `- ${m.sample} -> ${m.target}${m.note ? ` (${m.note})` : ""}`).join("\n")}`,
    `## Rules for every new auto\n${st.rules.map((r) => `- ${r}`).join("\n")}`,
    `## Gaps in this robot's code, and what to do instead\n${st.gaps.map((g) => `- ${g}`).join("\n")}`,
    s.notes ? `## The team's notes\n${s.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
