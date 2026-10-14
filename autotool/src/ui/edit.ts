// Route edits made by hand in the field view. Pure functions: spec in, new spec out.

import { DEG, round, wrapDeg } from "../shared/geometry.ts";
import { fVars, solveFor } from "../shared/java/reader.ts";
import { applyAssumptions } from "../shared/readspec.ts";
import { type AutoSpec, type During, type End, type Leg, type PoseDef, cloneSpec, nextLegId, renumberLegs, uniqueName, withStop } from "../shared/spec.ts";

const snap = (v: number, fine: boolean) => (fine ? round(v, 1) : Math.round(v * 2) / 2);
const clampField = (v: number) => Math.max(0, Math.min(144, v));

// A pose read from code that hangs on unknowns (Tuned values not set yet): moving it sets those
// unknowns, so every pose computed from them (along(0.25), ...) moves with it. null = not that kind.
function moveFormulaPose(spec: AutoSpec, name: string, want: { x?: number; y?: number; h?: number }): AutoSpec | null {
  const p = spec.poses.find((q) => q.name === name);
  if (!p?.formula) return null;
  const assume = { ...(spec.assume ?? {}) };
  for (const k of ["x", "y", "h"] as const) {
    const v = want[k];
    if (v === undefined) continue;
    const env = { ...assume };
    for (const n of fVars(p.formula[k])) delete env[n];
    const r = solveFor(p.formula[k], v, env);
    if (!r) return null;
    assume[r.name] = k === "h" ? wrapDeg(r.value) : r.value;
  }
  return applyAssumptions({ ...spec, assume });
}

export function movePose(spec: AutoSpec, name: string, x: number, y: number, fine: boolean): AutoSpec {
  const viaCode = moveFormulaPose(spec, name, { x: snap(clampField(x), fine), y: snap(clampField(y), fine) });
  if (viaCode) return viaCode;
  return {
    ...spec,
    poses: spec.poses.map((p) => {
      if (p.name !== name) return p;
      const q: PoseDef = { ...p, x: snap(clampField(x), fine), y: snap(clampField(y), fine) };
      delete q.formula; // moved by hand: no longer follows the code's formula
      if (q.expr) {
        const e = { ...q.expr };
        delete e.x;
        delete e.y;
        if (e.h) q.expr = e;
        else delete q.expr;
      }
      return q;
    }),
  };
}

export function setHeading(spec: AutoSpec, name: string, deg: number, coarse: boolean): AutoSpec {
  const h = coarse ? Math.round(deg / 15) * 15 : Math.round(deg);
  const viaCode = moveFormulaPose(spec, name, { h: wrapDeg(h) });
  if (viaCode) return viaCode;
  return {
    ...spec,
    poses: spec.poses.map((p) => {
      if (p.name !== name) return p;
      const q: PoseDef = { ...p, headingDeg: wrapDeg(h) };
      delete q.formula;
      if (q.expr) {
        const e = { ...q.expr };
        delete e.h;
        if (e.x || e.y) q.expr = e;
        else delete q.expr;
      }
      return q;
    }),
  };
}

function poseNames(s: AutoSpec): Set<string> {
  return new Set(s.poses.map((p) => p.name));
}
function methodNames(s: AutoSpec): Set<string> {
  return new Set(s.legs.map((l) => l.method).filter(Boolean) as string[]);
}

function newLeg(s: AutoSpec, from: string, to: string): Leg {
  const method = uniqueName(`${from}To${to[0].toUpperCase()}${to.slice(1)}`, methodNames(s));
  return {
    id: nextLegId(s),
    method,
    path: { type: "line", from, to },
    heading: { mode: "linear", from, to },
    during: "NONE",
    end: "NONE",
    carryIntakeS: 0,
    legTimeoutS: null,
    junction: { source: "none", evidence: [] },
  };
}

// Appends a leg from the last stop (or after `afterLeg`) to a clicked point.
export function addLegAt(spec: AutoSpec, x: number, y: number, afterLeg: string | null): AutoSpec {
  const s = cloneSpec(spec);
  const idx = afterLeg ? s.legs.findIndex((l) => l.id === afterLeg) : s.legs.length - 1;
  const from = idx < 0 ? s.start : s.legs[idx].path.to;
  const fp = s.poses.find((p) => p.name === from);
  const heading = fp && fp.x !== null && fp.y !== null ? Math.atan2(y - fp.y, x - fp.x) / DEG : (fp?.headingDeg ?? 0);
  const name = uniqueName(`p${s.legs.length + 1}`, poseNames(s));
  s.poses.push({ name, x: snap(clampField(x), false), y: snap(clampField(y), false), headingDeg: Math.round(wrapDeg(heading)), role: "waypoint", ...(s.poses.some((p) => p.redTrim) ? { redTrim: [0, 0, 0] as [number, number, number] } : {}) });
  const leg = newLeg(s, from, name);
  s.legs.splice(idx + 1, 0, leg);
  const after = s.legs[idx + 2];
  if (after && after.path.type !== "toPoint" && after.path.from === from) {
    after.path = { ...after.path, from: name };
    if (after.heading.mode === "linear" && after.heading.from === from) after.heading = { ...after.heading, from: name };
  }
  return renumberLegs(s);
}

// Splits a leg at a point: the robot stops there first (a new stop that just drives on).
export function splitLeg(spec: AutoSpec, legId: string, x: number, y: number): AutoSpec {
  const s = cloneSpec(spec);
  const i = s.legs.findIndex((l) => l.id === legId);
  if (i < 0) return spec;
  const leg = s.legs[i];
  const from = i === 0 ? s.start : s.legs[i - 1].path.to;
  const name = uniqueName(`p${s.legs.length + 1}`, poseNames(s));
  const to = s.poses.find((p) => p.name === leg.path.to);
  s.poses.push({ name, x: snap(x, false), y: snap(y, false), headingDeg: to?.headingDeg ?? 0, role: "waypoint", ...(s.poses.some((p) => p.redTrim) ? { redTrim: [0, 0, 0] as [number, number, number] } : {}) });
  const first = newLeg(s, from, name);
  s.legs.splice(i, 0, first);
  // the original leg now starts at the new point; a curve keeps its controls
  if (leg.path.type !== "toPoint") leg.path = { ...leg.path, from: name };
  if (leg.heading.mode === "linear") leg.heading = { ...leg.heading, from: name };
  return renumberLegs(s);
}

// Turns a straight leg into a curve with one control point, pushed sideways from the middle.
export function addBend(spec: AutoSpec, legId: string): AutoSpec {
  const s = cloneSpec(spec);
  const leg = s.legs.find((l) => l.id === legId);
  const path = leg?.path;
  if (!leg || !path || path.type !== "line") return spec;
  const a = s.poses.find((p) => p.name === path.from)!;
  const b = s.poses.find((p) => p.name === path.to)!;
  if (a.x === null || a.y === null || b.x === null || b.y === null) return spec;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const off = Math.min(12, len / 3);
  const name = uniqueName(`${path.to}Control`, poseNames(s));
  s.poses.push({ name, x: round(clampField(mx - ((b.y - a.y) / len) * off), 1), y: round(clampField(my + ((b.x - a.x) / len) * off), 1), headingDeg: 0, role: "control", ...(s.poses.some((p) => p.redTrim) ? { redTrim: [0, 0, 0] as [number, number, number] } : {}) });
  leg.path = { type: "curve", from: path.from, controls: [name], to: path.to };
  return s;
}

// Pedro-style: one more control point. A straight leg becomes a curve (addBend); on a curve the new
// point goes halfway between the last control point and the end, so the shape changes gently.
export function addControl(spec: AutoSpec, legId: string): AutoSpec {
  const leg = spec.legs.find((l) => l.id === legId);
  if (leg?.path.type === "line") return addBend(spec, legId);
  if (!leg || leg.path.type !== "curve") return spec;
  const s = cloneSpec(spec);
  const path = s.legs.find((l) => l.id === legId)!.path as Extract<typeof leg.path, { type: "curve" }>;
  const lastName = path.controls[path.controls.length - 1] ?? path.from;
  const last = s.poses.find((p) => p.name === lastName)!;
  const b = s.poses.find((p) => p.name === path.to)!;
  if (last.x === null || last.y === null || b.x === null || b.y === null) return spec;
  const name = uniqueName(`${path.to}Control`, poseNames(s));
  s.poses.push({ name, x: round(clampField((last.x + b.x) / 2), 1), y: round(clampField((last.y + b.y) / 2), 1), headingDeg: 0, role: "control", ...(s.poses.some((p) => p.redTrim) ? { redTrim: [0, 0, 0] as [number, number, number] } : {}) });
  path.controls.push(name);
  return s;
}

// Removes one control point; the last one gone makes the leg straight.
export function removeControl(spec: AutoSpec, legId: string, name: string): AutoSpec {
  const leg = spec.legs.find((l) => l.id === legId);
  if (!leg || leg.path.type !== "curve" || !leg.path.controls.includes(name)) return spec;
  if (leg.path.controls.length === 1) return straighten(spec, legId);
  const s = cloneSpec(spec);
  const path = s.legs.find((l) => l.id === legId)!.path as Extract<typeof leg.path, { type: "curve" }>;
  path.controls = path.controls.filter((c) => c !== name);
  const used = s.legs.some((l) => l.path.type === "curve" && l.path.controls.includes(name)) || s.legs.some((l) => l.path.type !== "toPoint" && (l.path.from === name || l.path.to === name)) || s.start === name;
  if (!used) s.poses = s.poses.filter((p) => p.name !== name);
  return s;
}

// Straightens a curve (its control points go if nothing else uses them).
export function straighten(spec: AutoSpec, legId: string): AutoSpec {
  const s = cloneSpec(spec);
  const leg = s.legs.find((l) => l.id === legId);
  if (!leg || leg.path.type !== "curve") return spec;
  const controls = leg.path.controls;
  leg.path = { type: "line", from: leg.path.from, to: leg.path.to };
  const usedElsewhere = (n: string) => s.legs.some((l) => l.path.type === "curve" && l.path.controls.includes(n));
  s.poses = s.poses.filter((p) => !controls.includes(p.name) || usedElsewhere(p.name));
  return s;
}

// Gives an unresolved pose (a NaN Tuned value) a position so the route can be drawn and edited.
export function placePose(spec: AutoSpec, name: string, x: number, y: number, h: number): AutoSpec {
  return {
    ...spec,
    poses: spec.poses.map((p) => (p.name === name ? { ...p, x: p.x ?? x, y: p.y ?? y, headingDeg: p.headingDeg ?? h, expr: undefined } : p)),
  };
}

export function renamePose(spec: AutoSpec, from: string, to: string): AutoSpec | string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(to)) return "a pose name must be a Java name (letters, digits, _)";
  if (to === "poseFactory") return "poseFactory is taken";
  if (spec.poses.some((p) => p.name === to)) return `"${to}" is taken`;
  const s = cloneSpec(spec);
  const r = (n: string) => (n === from ? to : n);
  s.poses = s.poses.map((p) => (p.name === from ? { ...p, name: to } : p));
  s.start = r(s.start);
  for (const l of s.legs) {
    const p = l.path;
    if (p.type === "toPoint") l.path = { type: "toPoint", to: r(p.to) };
    else if (p.type === "line") l.path = { type: "line", from: r(p.from), to: r(p.to) };
    else if (p.type === "curve") l.path = { type: "curve", from: r(p.from), controls: p.controls.map(r), to: r(p.to) };
    else l.path = { type: "through", from: r(p.from), via: p.via.map(r), to: r(p.to) };
    const h = l.heading;
    if (h.mode === "linear") l.heading = { mode: "linear", from: r(h.from), to: r(h.to) };
    else if (h.mode === "constant") l.heading = { mode: "constant", pose: r(h.pose) };
    else if (h.mode === "facingPoint") l.heading = { mode: "facingPoint", pose: r(h.pose) };
  }
  if (s.java) {
    s.java.order = s.java.order.map((k) => (k === `pose:${from}` ? `pose:${to}` : k));
    delete s.java.originals[`pose:${from}`]; // renamed code is re-rendered
  }
  return s;
}

// ---- what a leg does ----------------------------------------------------------------------------

// Sets what leg `legId` does while driving and at its end (the team decided: source "user"). A WAIT gets
// 1 s until the team types its time; options that stop applying are dropped.
export function setStop(spec: AutoSpec, legId: string, during: During, end: End): AutoSpec {
  const s = cloneSpec(spec);
  const i = s.legs.findIndex((l) => l.id === legId);
  if (i < 0) return spec;
  s.legs[i] = withStop(s.legs[i], during, end, "user", s.legs[i].junction.evidence);
  return s;
}

// One leg option: timeout, carryIntake, shotTimeout or the WAIT time. null = AutoRunner's default.
export function setOption(spec: AutoSpec, legId: string, key: "legTimeoutS" | "carryIntakeS" | "shotTimeoutS" | "waitS", v: number | null): AutoSpec {
  const s = cloneSpec(spec);
  const l = s.legs.find((x) => x.id === legId);
  if (!l) return spec;
  if (key === "legTimeoutS") l.legTimeoutS = v;
  else if (key === "carryIntakeS") l.carryIntakeS = v ?? 0;
  else if (v === null) delete l[key];
  else l[key] = v;
  return s;
}

// A new stop halfway along leg `legId` (between the stop before it and its own stop); returns its leg id.
export function insertStopBefore(spec: AutoSpec, legId: string): { spec: AutoSpec; legId: string } | null {
  const i = spec.legs.findIndex((l) => l.id === legId);
  if (i < 0) return null;
  const fromName = i === 0 ? spec.start : spec.legs[i - 1].path.to;
  const a = spec.poses.find((p) => p.name === fromName);
  const b = spec.poses.find((p) => p.name === spec.legs[i].path.to);
  if (a?.x == null || a.y == null || b?.x == null || b.y == null) return null;
  const s = splitLeg(spec, legId, (a.x + b.x) / 2, (a.y + b.y) / 2);
  return { spec: s, legId: s.legs[i].id };
}

// A new stop after the last one: a short leg on from it (for dropping an action at the end).
export function appendStop(spec: AutoSpec): { spec: AutoSpec; legId: string } | null {
  const lastName = spec.legs.at(-1)?.path.to ?? spec.start;
  const p = spec.poses.find((q) => q.name === lastName);
  if (p?.x == null || p.y == null) return null;
  const s = addLegAt(spec, Math.max(80, p.x - 12), p.y, spec.legs.at(-1)?.id ?? null);
  return { spec: s, legId: s.legs.at(-1)!.id };
}

// Moves stop `from` (index in legs) so it becomes stop `to`. The route then visits the stops in the new order:
// a leg between two stops that were already neighbours keeps its path; a new pair gets a straight line.
// Each stop keeps what it does and its options (they belong to the leg that ends there).
export function moveStop(spec: AutoSpec, from: number, to: number): AutoSpec {
  if (from === to || from < 0 || from >= spec.legs.length) return spec;
  const s = cloneSpec(spec);
  const order = s.legs.map((_, k) => k);
  const [moved] = order.splice(from, 1);
  order.splice(Math.max(0, Math.min(to, order.length)), 0, moved);
  const byPair = new Map(s.legs.map((l, k) => [`${k === 0 ? s.start : s.legs[k - 1].path.to}>${l.path.to}`, l]));
  let prev = s.start;
  s.legs = order.map((k) => {
    const own = s.legs[k];
    const stop = own.path.to;
    const same = byPair.get(`${prev}>${stop}`);
    let leg: Leg;
    if (same) leg = { ...same };
    else if (own.path.type === "toPoint") leg = { ...own };
    else {
      const method = own.method ?? `${prev}To${stop[0].toUpperCase()}${stop.slice(1)}`;
      leg = { ...own, method, path: { type: "line", from: prev, to: stop }, heading: { mode: "linear", from: prev, to: stop } };
    }
    // the stop's own during/end and options travel with it
    leg = { ...leg, junction: own.junction, during: own.during, end: own.end, carryIntakeS: own.carryIntakeS, legTimeoutS: own.legTimeoutS, shotTimeoutS: own.shotTimeoutS, waitS: own.waitS };
    for (const k2 of ["shotTimeoutS", "waitS"] as const) if (leg[k2] === undefined) delete leg[k2];
    prev = stop;
    return leg;
  });
  return renumberLegs(s);
}
