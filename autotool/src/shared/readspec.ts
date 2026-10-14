// Turns what the reader recovered from hand-written code into an AutoTool route: one leg per drive, what each
// leg does (during, end) from what the code does there, and every step the code takes kept on its leg.

import { type F, type PathV, type PoseV, type ReadResult, type Step, fEval, solveFor } from "./java/reader.ts";
import { type AutoSpec, type During, type End, type HeadingDef, type Leg, type LegStep, type PathGeom, type PoseDef, SPEC_VERSION } from "./spec.ts";

// a shot is a CALL whose method name says so (intakeFire(...), shoot(), launch()); a constant like
// FAR_FIRE_DISTANCE in an assignment is not
const SHOOT_RE = /(?:^|[.\s])\w*(?:[Ff]ire|[Ss]hoot|[Ll]aunch|[Ff]eed|[Ss]core)\w*\s*\(/;
const INTAKE_RE = /intake\s*(in|\()|intakeIn|collect|spinIn|startIntake/i;
const STOP_INTAKE_RE = /intake\s*stop|stopIntake|intakeStop|intake\.stop/i;

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

// Values of a pose's formulas with the team's assumptions for the unknowns.
export function poseValues(p: { formula?: { x: F; y: F; h: F } }, assume: Record<string, number>): { x: number | null; y: number | null; h: number | null } {
  if (!p.formula) return { x: null, y: null, h: null };
  return { x: round(fEval(p.formula.x, assume)), y: round(fEval(p.formula.y, assume)), h: round(fEval(p.formula.h, assume)) };
}

// Re-evaluates every formula pose (after the team placed an unknown pose on the field).
export function applyAssumptions(spec: AutoSpec): AutoSpec {
  const assume = spec.assume ?? {};
  return { ...spec, poses: spec.poses.map((p) => (p.formula ? { ...p, ...(({ x, y, h }) => ({ x, y, headingDeg: h }))(poseValues(p, assume)) } : p)) };
}

export function readToSpec(r: ReadResult, name: string, file: string, assume: Record<string, number> = {}): AutoSpec {
  const poses = new Map<string, PoseDef>();
  const used = new Set<string>();
  const nameOf = (p: PoseV, role: "waypoint" | "control"): string => {
    // the same named pose object (or a copy with the same numbers) is one pose
    const base = (p.name ?? "").replace(/[^A-Za-z0-9_$]/g, "") || `p${poses.size + 1}`;
    const existing = poses.get(base);
    if (existing) {
      // a rebuilt copy without a heading takes the original's
      if (existing.formula && fEval(existing.formula.h) === 0 && fEval(p.h) !== 0) existing.formula.h = p.h;
      return base;
    }
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    const formula = { x: p.x, y: p.y, h: p.h };
    poses.set(n, { name: n, ...(({ x, y, h }) => ({ x, y, headingDeg: h }))(poseValues({ formula }, assume)), role, formula, src: p.src });
    return n;
  };

  const startName = r.start ? nameOf(r.start, "waypoint") : null;
  const drives = r.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "drive");
  const legs: Leg[] = [];
  let prev = startName;
  drives.forEach(({ s, i }, k) => {
    const next = drives[k + 1]?.i ?? r.steps.length;
    // groups nest (race@135>parallel@136): the outermost one is what runs together with the drive
    const top = (g?: string) => g?.split(">")[0];
    const lastOfGroup = !s.group || top(drives[k + 1]?.s.group) !== top(s.group);
    const firstOfGroup = !s.group || top(drives[k - 1]?.s.group) !== top(s.group);
    // during: steps that run with this drive (same parallel group; kept once, on the group's first drive);
    // after: the steps between the end of the group and the next drive
    const groupSteps: LegStep[] = s.group ? r.steps.filter((x) => x.kind !== "drive" && top(x.group) === top(s.group)).map((x) => stepNote(x, "during")) : [];
    const during = firstOfGroup ? groupSteps : [];
    const nextGroup = top(drives[k + 1]?.s.group);
    const after: LegStep[] = lastOfGroup ? r.steps.slice(i + 1, next).filter((x) => x.kind !== "drive" && (!x.group || (top(x.group) !== top(s.group) && top(x.group) !== nextGroup))).map((x) => stepNote(x, "after")) : [];
    // what the code does before the first drive (gate, turret, flywheel set-up) belongs to the first leg
    const before: LegStep[] = k === 0 ? r.steps.slice(0, i).filter((x) => x.kind !== "drive" && (!x.group || top(x.group) !== top(s.group))).map((x) => stepNote(x, "before")) : [];
    const pts = (s.path?.pts ?? []).filter((p) => p.name !== "@current");
    const fromCurrent = !!s.path?.pts.some((p) => p.name === "@current") || (!s.path && !!s.target);
    let path: PathGeom;
    let heading: HeadingDef;
    if (s.path && pts.length >= 2 && !fromCurrent) {
      const from = nameOf(pts[0], "waypoint");
      const to = nameOf(pts[pts.length - 1], "waypoint");
      const mids = pts.slice(1, -1).map((p) => nameOf(p, s.path!.kind === "through" ? "waypoint" : "control"));
      path = s.path.kind === "line" || !mids.length ? { type: "line", from, to } : s.path.kind === "through" ? { type: "through", from, via: mids, to } : { type: "curve", from, controls: mids, to };
      heading = headingOf(s.path, from, to, nameOf);
    } else {
      const target = s.target ?? pts[pts.length - 1];
      const to = target ? nameOf(target, "waypoint") : (prev ?? "start");
      const mids = pts.slice(0, -1).map((p) => nameOf(p, "control"));
      path = mids.length && prev ? { type: "curve", from: prev, controls: mids, to } : { type: "toPoint", to };
      heading = path.type === "toPoint" ? { mode: "toTarget" } : { mode: "linear", from: prev!, to };
    }
    const to = path.to;
    const isLast = k === drives.length - 1;
    const stop = stopFor(s, groupSteps, after, isLast);
    legs.push({
      id: `L${legs.length + 1}`,
      ...(path.type !== "toPoint" ? { method: `leg${legs.length + 1}` } : {}),
      path,
      heading,
      during: stop.during,
      end: stop.end,
      legTimeoutS: s.timeoutS ?? null,
      carryIntakeS: stop.during === "NONE" ? 0 : (s.carryS ?? 0),
      ...(s.opts ?? {}),
      junction: { source: "imported", evidence: [`read from ${file.split("/").pop()}:${s.line}`] },
      ...(before.length || during.length || after.length ? { steps: [...before, ...during, ...after] } : {}),
      ...(fromCurrent ? { fromCurrent: true } : {}),
      comment: s.text,
    });
    prev = to;
  });

  const unknowns = [...new Set([...poses.values()].flatMap((p) => (p.formula ? [p.formula.x, p.formula.y, p.formula.h] : []).flatMap((f) => vars(f))))].filter((v) => !v.startsWith("?"));
  const spec: AutoSpec = {
    specVersion: SPEC_VERSION,
    name,
    drawnFor: "BLUE",
    start: startName ?? (legs[0] && legs[0].path.type !== "toPoint" ? legs[0].path.from : "start"),
    preload: { POLLEN: 4, NECTAR: 0, onTiles: 0 },
    poses: [...poses.values()],
    legs,
    opaque: [],
    ...(r.intakeAlways ? { intakeAlways: true } : {}),
    reader: { file, framework: r.framework, unknowns, skipped: r.skipped, at: new Date().toISOString(), v: READER_VERSION },
    ...(Object.keys(assume).length ? { assume } : {}),
  };
  return Object.keys(assume).length ? spec : guessUnknowns(spec);
}

export const READER_VERSION = 5;
const wrapDeg = (d: number) => Math.round(((((d + 180) % 360) + 360) % 360) * 1000) / 1000 - 180;

// Values the code does not have yet (Tuned NaN) get a first guess so the route draws at once: the
// start against the far wall, the last stop in the LOADING ZONE. Every pose computed from them
// follows; the team drags start and park to where they belong. Marked as assumed, never written.
export function guessUnknowns(spec: AutoSpec): AutoSpec {
  const assume: Record<string, number> = { ...(spec.assume ?? {}) };
  const guesses: [string | undefined, { x: number; y: number; h: number }][] = [
    // against the far wall, left of the GARDEN: a route from there to the LOADING ZONE stays clear of FLOWER F3
    [spec.start, { x: 110, y: 135, h: -90 }],
    [spec.legs.at(-1)?.path.to, { x: 128, y: 36, h: 180 }],
  ];
  for (const [name, at] of guesses) {
    const p = spec.poses.find((q) => q.name === name);
    if (!p?.formula) continue;
    for (const k of ["x", "y", "h"] as const) {
      const r = solveFor(p.formula[k], at[k], assume);
      if (r && !(r.name in assume)) assume[r.name] = k === "h" ? wrapDeg(r.value) : r.value;
    }
  }
  if (!Object.keys(assume).length) return spec;
  return applyAssumptions({ ...spec, assume, reader: spec.reader ? { ...spec.reader, guessed: Object.keys(assume) } : spec.reader });
}

function vars(f: F, out: string[] = []): string[] {
  if (f.k === "v") out.push(f.name);
  else if (f.k === "op") for (const a of f.a) vars(a, out);
  return out;
}

function stepNote(s: Step, when: "before" | "during" | "after"): LegStep {
  // ms: when an action starts after the drive began (a wait's own length is in its text)
  return { when, text: s.text, line: s.line, ...(s.kind !== "wait" && s.ms !== undefined && s.ms > 0 ? { ms: s.ms } : {}), kind: s.kind === "wait" ? "wait" : "action" };
}

function headingOf(p: PathV, from: string, to: string, _n: unknown): HeadingDef {
  const h = p.heading;
  if (!h || h.mode === "linear") return { mode: "linear", from, to };
  if (h.mode === "tangent" || h.mode === "reverseTangent") return { mode: h.mode };
  if (h.mode === "constant") return { mode: "constant", pose: from };
  return { mode: "linear", from, to };
}

// What the code does on a drive: an AutoRunner.Leg says it directly; otherwise an intake running during
// the drive, and a shot after it (or the last drive parks).
function stopFor(s: Step, during: LegStep[], after: LegStep[], isLast: boolean): { during: During; end: End } {
  if (s.during && s.end) return { during: s.during, end: s.end };
  const shot = after.some((x) => x.kind === "action" && SHOOT_RE.test(x.text) && !/stop|close/i.test(x.text.split("(")[0]));
  const intakeOn = during.some((x) => INTAKE_RE.test(x.text) && !STOP_INTAKE_RE.test(x.text));
  return { during: intakeOn ? "INTAKE" : "NONE", end: shot ? "SHOOT" : isLast ? "PARK" : "NONE" };
}
