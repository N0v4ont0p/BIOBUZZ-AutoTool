// Ingest scan: digest the repo, import the autos, and build the team profile facts from what the
// code says (file:line), what the rules say, and clearly marked assumptions for what is not measured.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { importAutoPaths, importAutoTool } from "../shared/java/autorunner.ts";
import { readAuto } from "../shared/java/reader.ts";
import { readToSpec } from "../shared/readspec.ts";
import { type Conventions, type Fact, type Profile, type RobotModel, defaultFacts, robotModel } from "../shared/profile.ts";
import type { SeasonPack } from "../shared/season.ts";
import type { AutoSpec } from "../shared/spec.ts";
import { type Digest, buildDigest, symbolMap } from "./digest.ts";
import type { RobotRepo } from "./repo.ts";
import { type Store, sha256 } from "./store.ts";

type Source = { value: number | string; status: Fact["status"]; source: string; note?: string } | null;

function fromConstant(d: Digest, name: string, howToMeasure: string): Source {
  const c = d.constants[name];
  if (!c) return null;
  if (c.value === null) return { value: NaN, status: "assumed", source: `${c.file}:${c.line} ${name} is NaN (${howToMeasure})` };
  return { value: c.value, status: "code", source: `${c.file}:${c.line} ${name} = ${c.expr}` };
}

export function factsFromDigest(d: Digest, pack: SeasonPack): Record<string, Fact> {
  const facts = defaultFacts();
  const set = (key: string, s: Source, assumedWhy?: string) => {
    const f = facts[key];
    if (!f || !s) return;
    if (typeof s.value === "number" && Number.isNaN(s.value)) {
      // keep the default value but say exactly why it is assumed
      f.status = "assumed";
      f.source = `assumed ${f.value} ${f.unit}: ${s.source}${assumedWhy ? `; ${assumedWhy}` : ""}`.trim();
      f.repoValue = null;
      return;
    }
    f.value = s.value;
    f.status = s.status;
    f.source = s.source;
    f.repoValue = s.value;
    if (s.note) f.note = s.note;
  };
  const AR = "AutoRunner";
  set("abortAtS", fromConstant(d, `${AR}.ABORT_AT_S`, ""));
  set("legTimeoutS", fromConstant(d, `${AR}.LEG_TIMEOUT_S`, ""));
  set("settleS", fromConstant(d, `${AR}.SETTLE_S`, ""));
  set("readyTimeoutS", fromConstant(d, `${AR}.READY_TIMEOUT_S`, ""));
  set("feedS", fromConstant(d, `${AR}.FEED_S`, ""));
  set("shotAbandonS", fromConstant(d, `${AR}.SHOT_TIMEOUT_S`, "") ?? fromConstant(d, `${AR}.SHOT_ABANDON_S`, "")); // renamed when the Leg got its shot timeout
  set("stoppedSpeed", fromConstant(d, `${AR}.STOPPED_SPEED`, ""));
  set("stoppedTurnDeg", fromConstant(d, `${AR}.STOPPED_TURN_DEG`, ""));
  // an AutoRunner without RAMP_CARRY_S folds the ramp the moment the next leg starts
  const carry = d.constants[`${AR}.RAMP_CARRY_S`];
  if (carry) set("rampCarryS", fromConstant(d, `${AR}.RAMP_CARRY_S`, ""));
  else if (d.constants[`${AR}.ABORT_AT_S`]) set("rampCarryS", { value: 0, status: "code", source: `${d.constants[`${AR}.ABORT_AT_S`].file}: AutoRunner has no RAMP_CARRY_S, so it folds the ramp when the next leg starts` });
  for (const k of ["centerToFront", "centerToBack", "centerToLeft", "centerToRight"]) set(k, fromConstant(d, `Tuned.${k}`, "CAD sheet C-2"), `the start cube is ${pack.rules.startConfig.cubeIn} in (R102)`);
  for (const k of ["frontPivotX", "frontPivotY", "backPivotX", "backPivotY"]) set(k, fromConstant(d, `Tuned.${k}`, "CAD sheet C-3"), "aim from the robot centre");
  // one yaw servo per turret, each with its own soft limits (program 3)
  for (const k of ["frontYawMinDeg", "frontYawMaxDeg", "backYawMinDeg", "backYawMaxDeg"]) set(k, fromConstant(d, `Tuned.${k}`, "program 3"));
  set("yawDegPerS", fromConstant(d, "Tuned.yawDegPerS", "program 3, the slower turret"));
  set("gateTravelS", fromConstant(d, "Tuned.gateTravelS", "E-8, the slowest gate servo"));
  set("rampOutS", fromConstant(d, "Tuned.rampOutS", "program 4, slow motion"));
  set("rampInS", fromConstant(d, "Tuned.rampInS", "program 4, slow motion"));
  set("rampHoldPower", fromConstant(d, "Tuned.rampHoldPower", "program 4"));
  for (const [side, keyMin, keyMax] of [["back", "shotMinIn", "shotMaxIn"]] as const) {
    const t = d.shotTables[side];
    if (t.min !== null && t.max !== null) {
      set(keyMin, { value: t.min, status: "measured", source: `Tuned ${side} shot table, ${t.rows} points (shortest)` });
      set(keyMax, { value: t.max, status: "measured", source: `Tuned ${side} shot table, ${t.rows} points (longest)` });
    } else {
      const why = `${side} (POLLEN) shot table has ${t.rows} complete points (G-5)`;
      set(keyMin, { value: NaN, status: "assumed", source: why });
      set(keyMax, { value: NaN, status: "assumed", source: why });
    }
  }
  const cellKeys: [string, string][] = [
    ["cellRedFarX", "redFarCellX"],
    ["cellRedFarY", "redFarCellY"],
    ["cellRedAudienceX", "redAudienceCellX"],
    ["cellRedAudienceY", "redAudienceCellY"],
  ];
  for (const [k, t] of cellKeys) {
    const c = d.constants[`Tuned.${t}`];
    if (c && c.value !== null) set(k, { value: c.value, status: "measured", source: `${c.file}:${c.line} Tuned.${t} (H-1)` });
    else if (c) facts[k].source = `season pack (owner CAD); ${c.file}:${c.line} Tuned.${t} is NaN (H-1)`;
  }
  // CAD sizes and test-drive numbers, from the tool-only entries of team-config.yaml
  const yamlFacts: [string, string, string][] = [
    ["intakeReachIn", "intakeReachIn", "CAD: how far past the bumper the intake takes an element"],
    ["intakeWidthIn", "intakeWidthIn", "CAD: width of the intake mouth"],
    ["rampReachIn", "rampReachIn", "CAD: how far past the bumper the deployed ramp takes POLLEN"],
    ["elementsPerShot", "elementsPerShot", "how many elements one SHOOT sends"],
    ["accel", "driveAccelInS2", "test drive: acceleration along a path"],
    ["decel", "driveDecelInS2", "test drive: braking at the end of a path"],
    ["latAccel", "driveLatAccelInS2", "test drive: sideways acceleration in a curve"],
    ["maxTurnDegS", "driveMaxTurnDegS", "test drive: fastest heading change"],
    ["frontLaunchDeg", "frontLaunchDeg", "CAD: fixed launch angle above horizontal"],
    ["backLaunchDeg", "backLaunchDeg", "CAD: fixed launch angle above horizontal"],
    ["frontReleaseHeightIn", "frontReleaseHeightIn", "CAD: element centre at release"],
    ["backReleaseHeightIn", "backReleaseHeightIn", "CAD: element centre at release"],
  ];
  for (const [fact, key, how] of yamlFacts) {
    const c = d.constants[`Config.${key}`];
    if (!c) continue;
    if (c.value === null) facts[fact].source = `assumed ${facts[fact].value} ${facts[fact].unit}: ${c.file}:${c.line} ${key} is not filled in yet (${how})`;
    else set(fact, { value: c.value, status: "measured", source: `${c.file}:${c.line} ${key} = ${c.expr}` });
  }
  const v = d.constants["Constants.maxAchievableForwardVelocity"];
  if (v) set("maxVel", fromConstant(d, "Constants.maxAchievableForwardVelocity", "Foresight Tuner, program 5"), "the visualizer's default speed");
  for (const f of d.facts) {
    if (f.key === "intakeEnd") set("intakeEnd", { value: "front", status: "code", source: `${f.file}:${f.line} ${f.text}` });
    if (f.key === "parkRegion") set("parkRegion", { value: "LOADING ZONE", status: "code", source: `${f.file}:${f.line} ${f.text}; 10.5.4` });
    if (f.key === "capacity") set("capacity", { value: 4, status: "rule", source: `G407; ${f.file}:${f.line} ${f.text}` });
    if (f.key === "intakeMotors") set("intakeMotors", { value: 2, status: "code", source: `${f.file}:${f.line} ${f.text}` });
    const mix = f.key === "mixedLoad" ? /(\d+) NECTAR \+ (\d+) POLLEN/.exec(f.text) : null;
    if (mix) {
      set("nectarMax", { value: Number(mix[1]), status: "code", source: `${f.file}:${f.line} ${f.text}` });
      set("pollenWithNectar", { value: Number(mix[2]), status: "code", source: `${f.file}:${f.line} ${f.text}` });
    }
  }
  return facts;
}

export function conventionsFrom(src: string | null, file: string): Conventions {
  const found: string[] = [];
  if (!src) return { indent: "    ", poseWrap: "redTrim", numberDecimals: 3, pathMethodStyle: "camelCase: startToShot1", legListStyle: "Arrays.asList", found: ["no AutoPaths.java yet: the tool's defaults"] };
  const lines = src.split("\n");
  const indent = /^( +|\t+)\S/m.exec(src)?.[1] ?? "    ";
  found.push(`${file}: indent ${indent === "\t" ? "tab" : `${indent.length} spaces`}`);
  const trimLine = lines.findIndex((l) => /redTrim\(poseFactory\.of/.test(l));
  if (trimLine >= 0) found.push(`${file}:${trimLine + 1}: poses wrapped as redTrim(poseFactory.of(x, y, h), 0, 0, 0)`);
  const list = lines.findIndex((l) => /List\.of\(/.test(l));
  if (list >= 0) found.push(`${file}:${list + 1}: legs listed with List.of`);
  const factory = lines.findIndex((l) => /MatchState\.poseFactory\(\)/.test(l));
  if (factory >= 0) found.push(`${file}:${factory + 1}: poses from MatchState.poseFactory() (red = 180-degree rotation)`);
  const header = lines.findIndex((l) => /Generated by/.test(l));
  if (header >= 0) found.push(`${file}:${header + 1}: class comment "${lines[header].trim().slice(0, 60)}" (kept when editing; new autos get no header)`);
  return {
    indent,
    poseWrap: trimLine >= 0 ? "redTrim" : "plain",
    numberDecimals: 3,
    pathMethodStyle: "camelCase: startToShot1",
    legListStyle: list >= 0 ? "List.of" : "Arrays.asList",
    found,
  };
}

// What the robot code, its measurements or the season pack say confirms itself: a value read from the code
// is the truth, so a change there is only reported. The team is asked only about values the code does not
// have (assumed), and about its own overrides of a value the code has since changed.
const fromSource = (s: Fact["status"]) => s === "code" || s === "measured" || s === "rule" || s === "pack";
const show = (v: unknown) => (v === null || v === undefined ? "not set" : String(v));

export interface FactChange {
  key: string;
  label: string;
  from: string;
  to: string;
  needsYou: boolean;
}

export function mergeFacts(old: Record<string, Fact> | undefined, fresh: Record<string, Fact>): { facts: Record<string, Fact>; changed: FactChange[] } {
  const changed: FactChange[] = [];
  if (!old) return { facts: fresh, changed }; // first scan: setup confirms everything once
  const out: Record<string, Fact> = {};
  for (const key of Object.keys(fresh)) {
    const n = fresh[key];
    const o = old[key];
    if (!o) {
      // a fact a newer AutoTool reads: in use at once and announced, never a reason to redo the setup
      out[key] = { ...n, confirmed: true };
      changed.push({ key, label: n.label, from: "new", to: `${n.status === "assumed" ? "assumed " : ""}${n.value} ${n.unit}`.trim(), needsYou: false });
      continue;
    }
    const repoMoved = o.repoValue !== n.repoValue && !(o.repoValue === undefined && n.repoValue === undefined);
    if (o.status === "user") {
      if (repoMoved) {
        out[key] = { ...n, value: o.value, status: "user", source: o.source, confirmed: false, note: `the code changed from ${show(o.repoValue)} to ${show(n.repoValue)}; you had set ${o.value}: keep yours or take the code's` };
        changed.push({ key, label: n.label, from: show(o.repoValue), to: show(n.repoValue), needsYou: true });
      } else out[key] = { ...n, value: o.value, status: "user", source: o.source, confirmed: o.confirmed, ...(o.note ? { note: o.note } : {}) };
    } else if (repoMoved) {
      if (fromSource(n.status)) {
        out[key] = { ...n, confirmed: true, note: `was ${show(o.repoValue)}, now ${show(n.repoValue)} (read from the code)` };
        changed.push({ key, label: n.label, from: show(o.repoValue), to: show(n.repoValue), needsYou: false });
      } else {
        out[key] = { ...n, confirmed: false, note: `the code no longer sets it (was ${show(o.repoValue)}): assumed ${n.value} ${n.unit}` };
        changed.push({ key, label: n.label, from: show(o.repoValue), to: `assumed ${n.value}`, needsYou: true });
      }
    } else if (o.confirmed) {
      out[key] = { ...n, value: o.value, confirmed: true, ...(o.note ? { note: o.note } : {}) };
    } else out[key] = { ...n, confirmed: o.confirmed || fromSource(n.status) };
  }
  return { facts: out, changed };
}

export interface IngestResult {
  digest: Digest;
  profile: Profile;
  changedFacts: string[];
  autos: { file: string; ok: boolean; spec?: AutoSpec; errors?: { line: number; message: string }[]; warnings: { line: number; message: string }[] }[];
}

// One auto file into a spec: AutoPaths.java, or an AutoTool auto (Near_9.java, or Blue_Near.java from before
// the one-file format).
// Reads any auto of the repo with the reader (all the repo's Java available to follow constants and helpers).
export function readRepoAuto(repo: RobotRepo, file: string, name: string, root?: string): AutoSpec | null {
  try {
    const files = root ? javaFilesOf(root) : repo.textFiles("TeamCode").filter((f) => f.endsWith(".java")).map((f) => ({ path: f, text: repo.readText(f) }));
    const def = repo.autoPathsRel().split("/").pop()!.replace(/\.java$/, "");
    return readToSpec(readAuto(files, file, def), name, file);
  } catch {
    return null;
  }
}

function javaFilesOf(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 14) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || ["build", "FtcRobotController", "node_modules"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".java")) out.push({ path: relative(root, p).split(sep).join("/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, "TeamCode"), 0);
  return out;
}

export function importAutoFile(repo: RobotRepo, file: string, digest: Digest, pack: SeasonPack, model: RobotModel): IngestResult["autos"][number] | null {
  const text = repo.readText(file);
  const isMain = file === repo.autoPathsRel();
  const r = isMain ? importAutoPaths(text, symbolMap(digest), file) : importAutoTool(text, symbolMap(digest), file);
  if (!r.ok) {
    // hand-written code the round-trip importer cannot rewrite: read it instead (every pose and action)
    const spec = readRepoAuto(repo, file, isMain ? "AutoPaths" : file.split("/").pop()!.replace(/\.java$/, ""));
    if (spec && spec.legs.length) {
      spec.source = { file, hash: sha256(text) };
      spec.preload = { POLLEN: model.preloadPollen, NECTAR: 0, onTiles: model.preloadOnTiles };
      return { file, ok: true, spec, warnings: [{ line: 1, message: `${file.split("/").pop()} is hand-written code (${spec.reader!.framework}): AutoTool read every pose and action and shows it; it does not rewrite that file` }] };
    }
    return { file, ok: false, errors: r.errors, warnings: r.warnings };
  }
  r.spec.source = { file, hash: sha256(text) };
  if (isMain) r.spec.name = "AutoPaths";
  r.spec.preload = { POLLEN: model.preloadPollen, NECTAR: 0, onTiles: model.preloadOnTiles };
  void pack;
  return { file, ok: true, spec: r.spec, warnings: r.warnings };
}

export function ingest(repo: RobotRepo, store: Store, pack: SeasonPack, previous: Profile | null, progress?: (step: string, pct: number) => void): IngestResult {
  progress?.("reading the robot code", 10);
  const digest = buildDigest(repo, store, (m) => progress?.(m, 20));
  progress?.("building the profile", 50);
  const fresh = factsFromDigest(digest, pack);
  const merged = mergeFacts(previous?.facts, fresh);
  progress?.("importing autos", 70);
  const autos: IngestResult["autos"] = [];
  // AutoPaths.java first (the default auto), then every auto AutoTool wrote (Blue_Near.java ...; the
  // Red_ files only point at their Blue_ file)
  const routes = repo.list(repo.autosRel()).map((p) => p.split("/").pop()!).filter((f) => /^Blue_(Near|Far)(_[A-Za-z0-9_]+)?\.java$/.test(f)).sort();
  let src: string | null = null;
  const model = robotModel(merged.facts);
  for (const file of [repo.autoPathsRel(), ...routes.map((f) => `${repo.autosRel()}/${f}`)]) {
    if (!repo.exists(file)) continue;
    if (file === repo.autoPathsRel()) src = repo.readText(file);
    const a = importAutoFile(repo, file, digest, pack, model);
    if (a) autos.push(a);
  }
  progress?.("done", 100);
  const now = new Date().toISOString();
  const profile: Profile = {
    profileVersion: (previous?.profileVersion ?? 0) + 1,
    team: previous?.team ?? "19859",
    season: pack.season,
    repo: { path: repo.root, autosDir: repo.autosRel() },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    facts: merged.facts,
    conventions: conventionsFrom(src, repo.autoPathsRel()),
    startingBalanceUsd: previous?.startingBalanceUsd ?? null,
    // "is this your auto" stays answered until the sample auto it was asked about changes
    sanityConfirmed: !!previous?.sanityConfirmed && (!previous.sanityFor || !src || previous.sanityFor === sha256(src)),
    ...(previous?.sanityFor ? { sanityFor: previous.sanityFor } : {}),
    // what the last scans changed, shown once in the editor until dismissed
    changes: [...(previous?.changes ?? []), ...merged.changed.map((c) => ({ ...c, at: now }))].slice(-30),
  };
  return { digest, profile, changedFacts: merged.changed.map((c) => c.key), autos };
}
