// Two autos of the same alliance run together: ours and the partner's (both drawn for BLUE, so they share the
// field as alliance partners do). Both start at the same moment (the partner optionally later); every 0.05 s the
// two footprints are compared. Times are AutoTool's estimates, so a partner running up to `tolS` early or late
// counts too: that is a near miss, as is coming closer than `marginIn`.

import { type AutoFeatures, computeFeatures, poseAtTime } from "./features.ts";
import { type Vec, footprint, pointSegmentDistance, polygonsOverlap } from "./geometry.ts";
import type { RobotModel } from "./profile.ts";
import type { SeasonPack } from "./season.ts";
import { type AutoSpec, cloneSpec } from "./spec.ts";

export interface PartnerOpts {
  delayS: number; // the partner starts this much later
  marginIn: number; // closer than this is a near miss
  tolS: number; // timing uncertainty: the partner may run this much early or late
  body: { front: number; back: number; left: number; right: number };
  maxVel: number; // the partner's top speed (in/s)
}

export const DEFAULT_PARTNER: PartnerOpts = { delayS: 0, marginIn: 3, tolS: 0.5, body: { front: 9, back: 9, left: 9, right: 9 }, maxVel: 40 };

export type ConflictKind = "collision" | "nearMiss" | "start" | "park" | "elements";

export interface Conflict {
  kind: ConflictKind;
  t: number; // our clock (s): the worst moment
  from: number;
  to: number;
  ourLeg: string | null;
  theirLeg: string | null;
  at: Vec; // where on the field (between the two robots)
  gapIn: number; // closest distance between the footprints (0 = they overlap)
  tolOnly?: boolean; // they only touch if the partner runs a little early or late
  text: string;
}

export interface Comparison {
  conflicts: Conflict[];
  closest: { gapIn: number; t: number } | null;
  endS: number;
}

// The partner robot: our model with its own size and speed.
export function partnerModel(m: RobotModel, o: PartnerOpts): RobotModel {
  return { ...m, body: o.body, maxVel: o.maxVel };
}

// Closest distance between two convex footprints (0 when they overlap).
export function footprintGap(a: Vec[], b: Vec[]): number {
  if (polygonsOverlap(a, b)) return 0;
  let d = Infinity;
  for (const [p, q] of [
    [a, b],
    [b, a],
  ]) {
    for (const v of p) for (let i = 0; i < q.length; i++) d = Math.min(d, pointSegmentDistance(v, q[i], q[(i + 1) % q.length]));
  }
  return d;
}

const STEP = 0.05;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function compareRuns(ours: AutoFeatures, ourModel: RobotModel, theirs: AutoFeatures, theirModel: RobotModel, o: PartnerOpts): Comparison {
  const endS = Math.max(ours.timeline.nominalS, theirs.timeline.nominalS + o.delayS);
  const conflicts: Conflict[] = [];
  let closest: Comparison["closest"] = null;
  const offsets = [0, -o.tolS, -o.tolS / 2, o.tolS / 2, o.tolS].filter((v, i, a) => a.indexOf(v) === i);
  let open: Conflict | null = null;
  const close = () => {
    if (open) conflicts.push(open);
    open = null;
  };
  for (let k = 0; k * STEP <= endS + 1e-9; k++) {
    const t = Math.round(k * STEP * 100) / 100;
    const a = poseAtTime(ours, t);
    const b = poseAtTime(theirs, t - o.delayS);
    if (!a || !b) continue;
    const fa = footprint(a, ourModel.body);
    const gap = footprintGap(fa, footprint(b, theirModel.body));
    if (!closest || gap < closest.gapIn) closest = { gapIn: gap, t };
    // the partner a little early or late
    let tolGap = gap;
    for (const d of offsets) {
      const bb = poseAtTime(theirs, t - o.delayS + d);
      if (bb) tolGap = Math.min(tolGap, footprintGap(fa, footprint(bb, theirModel.body)));
    }
    const atStart = t < STEP / 2;
    const parked = a.phase === "done" && b.phase === "done";
    if (!(gap < o.marginIn || tolGap <= 0)) {
      close();
      continue;
    }
    // one event per stretch of contact: a collision if they touch at any moment of it, else a near miss
    const kind: ConflictKind = atStart ? "start" : parked ? "park" : gap <= 0 ? "collision" : "nearMiss";
    const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const contact = (k: ConflictKind) => k === "collision" || k === "nearMiss" || k === "start";
    if (open && (open.kind === kind || (contact(open.kind) && contact(kind)))) {
      open.to = t;
      if (open.kind === "nearMiss" && kind === "collision") open.kind = "collision";
      if (gap < open.gapIn) Object.assign(open, { t, gapIn: gap, ourLeg: a.legId, theirLeg: b.legId, at });
      if (tolGap <= 0) open.tolOnly = open.tolOnly ?? gap > 0;
      continue;
    }
    close();
    open = { kind, t, from: t, to: t, ourLeg: a.legId, theirLeg: b.legId, at, gapIn: gap, text: "", ...(gap > 0 && tolGap <= 0 ? { tolOnly: true } : {}) };
  }
  close();
  for (const c of conflicts) c.text = describe(c, o);

  // both routes plan to pick up the same staged elements: who gets there first
  const picks = (f: AutoFeatures, delay: number) => new Map(f.legs.flatMap((l) => l.picked.map((p) => [p.id, { atS: p.atS + delay, leg: l.id }] as const)));
  const mine = picks(ours, 0);
  for (const [id, p] of picks(theirs, o.delayS)) {
    const m = mine.get(id);
    if (!m) continue;
    const first = m.atS <= p.atS ? "we get there first" : "the partner gets there first";
    conflicts.push({ kind: "elements", t: Math.min(m.atS, p.atS), from: Math.min(m.atS, p.atS), to: Math.max(m.atS, p.atS), ourLeg: m.leg, theirLeg: p.leg, at: { x: 0, y: 0 }, gapIn: Infinity, text: `both routes pick up ${id} (us at ${r1(m.atS)} s on ${m.leg}, the partner at ${r1(p.atS)} s on ${p.leg}): ${first}` });
  }
  // the partner's start must be legal too
  if (theirs.start && Object.values(theirs.start).some((v) => !v)) {
    const bad = Object.entries(theirs.start).filter(([, v]) => !v).map(([k]) => k);
    conflicts.push({ kind: "start", t: 0, from: 0, to: 0, ourLeg: null, theirLeg: null, at: { x: 0, y: 0 }, gapIn: Infinity, text: `the partner's start is not legal (G304): ${bad.join(", ")}` });
  }
  conflicts.sort((x, y) => x.t - y.t);
  return { conflicts, closest, endS };
}

function describe(c: Conflict, o: PartnerOpts): string {
  const when = c.to - c.from > 0.15 ? `${r1(c.from)}-${r1(c.to)} s` : `${r1(c.t)} s`;
  const legs = `our ${c.ourLeg ?? "park"}, their ${c.theirLeg ?? "park"}`;
  switch (c.kind) {
    case "start":
      return `the two start poses ${c.gapIn <= 0 ? "overlap" : `are only ${r1(c.gapIn)} in apart`}`;
    case "park":
      return `both parked ${c.gapIn <= 0 ? "on top of each other" : `${r1(c.gapIn)} in apart`} in the end`;
    case "collision":
      return `collision at ${when} (${legs})`;
    default:
      return c.gapIn < o.marginIn ? `${r1(c.gapIn)} in apart at ${when} (${legs}), under the ${o.marginIn} in margin` : `they touch at ${when} if the partner runs up to ${o.tolS} s early or late (${legs})`;
  }
}

const blocking = (c: Comparison) => c.conflicts.filter((x) => x.kind === "collision" || x.kind === "nearMiss" || x.kind === "park");
const collisions = (c: Comparison) => c.conflicts.filter((x) => x.kind === "collision").length;

// Our leg `legId` holds `addS` seconds longer at its end: a NONE end becomes WAIT, a WAIT gets longer.
export function addWait(spec: AutoSpec, legId: string, addS: number): AutoSpec | null {
  const s = cloneSpec(spec);
  const l = s.legs.find((x) => x.id === legId);
  if (!l || (l.end !== "NONE" && l.end !== "WAIT")) return null;
  l.waitS = Math.round(((l.end === "WAIT" ? (l.waitS ?? 0) : 0) + addS) * 100) / 100;
  l.end = "WAIT";
  return s;
}

export type Fix = { kind: "wait"; legId: string; addS: number; spec: AutoSpec } | { kind: "delay"; delayS: number } | { kind: "none" };

// The smallest change that clears conflict `c` without adding a collision: a WAIT on one of our legs that ends
// before it (latest leg first, 0.25 s steps up to 5 s); failing that, the partner start delay to agree on.
export function findFix(ours: AutoSpec, ourModel: RobotModel, theirs: AutoFeatures, theirModel: RobotModel, pack: SeasonPack, o: PartnerOpts, c: Conflict): Fix {
  const base = compareRuns(computeFeatures(ours, pack, ourModel), ourModel, theirs, theirModel, o);
  const before = blocking(base).length;
  const cols = collisions(base);
  const ourF = computeFeatures(ours, pack, ourModel);
  const ok = (r: Comparison) => blocking(r).length < before && collisions(r) <= cols && !blocking(r).some((x) => x.kind === c.kind && Math.abs(x.t - c.t) < 0.3);
  const legs = ourF.legs.filter((l) => l.endS <= c.from + 1e-6 || l.id === c.ourLeg).reverse();
  for (const lf of legs) {
    for (let w = 0.25; w <= 5 + 1e-9; w += 0.25) {
      const s = addWait(ours, lf.id, w);
      if (!s) break;
      if (ok(compareRuns(computeFeatures(s, pack, ourModel), ourModel, theirs, theirModel, o))) return { kind: "wait", legId: lf.id, addS: Math.round(w * 100) / 100, spec: s };
    }
  }
  for (let d = o.delayS + 0.25; d <= 10 + 1e-9; d += 0.25) {
    if (ok(compareRuns(ourF, ourModel, theirs, theirModel, { ...o, delayS: d }))) return { kind: "delay", delayS: Math.round(d * 100) / 100 };
  }
  return { kind: "none" };
}
