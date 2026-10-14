// Every fact code can compute about an auto: geometry, time, zones, aim, inventory, rule checks.
// The AI receives these numbers (not raw coordinates) and every number it quotes is checked against them.
// Behaviour follows the robot repo's opmodes/AutoRunner.java (read at milestone 3):
//  - each leg is its own Pedro path, so the robot starts and ends every leg at rest;
//  - INTAKE legs run the intake for the whole leg and carryIntake seconds into the next;
//  - SHOOT holds, waits for stillness + aim lock + both flywheels (settle SETTLE_S), opens the gates
//    and feeds FEED_S; if the CELL is outside the yaw travel it gives up after the shot timeout (SHOT_TIMEOUT_S) and
//    skips the shot (nothing is fired);
//  - PARK holds and ends the auto; past ABORT_AT_S no further leg runs.

import {
  type HeadingRule,
  type Sample,
  type Vec,
  DEG,
  angleErrorDeg,
  dist,
  footprint,
  headingAt,
  polygonsOverlap,
  rectPolygon,
  round,
  sampleBeziers,
  throughToBeziers,
  toField,
  wrapDeg,
} from "./geometry.ts";
import type { RobotModel } from "./profile.ts";
import type { SeasonPack, StagedElement } from "./season.ts";
import { type AutoSpec, type During, type End, type Problem, startPoseName } from "./spec.ts";

export interface PathSample extends Sample {
  headingDeg: number;
  timeS: number; // from the leg start
  speed: number; // in/s
}

export interface LegGeometry {
  legId: string;
  drawable: boolean;
  problem?: string;
  pieces: Vec[][]; // Bezier pieces for drawing
  approx: boolean; // Paths.through drawn with Catmull-Rom (display approximation)
  samples: PathSample[];
  length: number;
  travelS: number;
}

export interface HeldItem {
  id: string;
  type: "POLLEN" | "NECTAR";
  confirmed: boolean;
}

export interface LegFeatures {
  id: string;
  index: number;
  during: During; // AutoRunner.Leg, as the spec writes it
  end: End;
  lengthIn: number;
  curvaturePeak: number; // 1/in
  minRadiusIn: number | null;
  headingStartDeg: number;
  headingEndDeg: number;
  headingChangeDeg: number; // signed total turn of the robot during the leg
  travelS: number; // estimated, capped at the leg timeout
  rawTravelS: number;
  timeoutS: number;
  timesOut: boolean;
  endActionS: number; // nominal time of the end action
  endActionWorstS: number;
  startS: number;
  endS: number; // start of the next leg (nominal)
  cut: "none" | "partial" | "never"; // by ABORT_AT_S
  intakeRuns: boolean;
  carryS: number;
  intakeLeadWorstDeg: number | null; // worst angle between intake direction and travel, while intaking
  intakeLeads: boolean | null;
  picked: { id: string; type: string; atS: number; confirmed: boolean }[];
  sweepable: string[]; // floor elements the intake mouth passes over on this leg, intake on or not
  missedFull: string[]; // elements the intake reached while full
  flowerReached: string[]; // FLOWER stacks the intake reached (needs the ramp: unconfirmed)
  footprintCrossesMid: boolean;
  centreCrossesMid: boolean;
  outOfField: boolean;
  obstacleHits: string[];
}

export interface JunctionFeatures {
  id: string; // = leg id
  index: number;
  pose: { name: string; x: number; y: number; headingDeg: number };
  isLast: boolean;
  during: During; // what the leg into this stop does
  end: End;
  source: string; // who decided it (imported, ai, user)
  shotInCode: boolean | null; // imported autos: SHOOT in the code; drawn: null
  dwellInCode: { carryIntakeS: number; timeoutS: number | null } | null;
  moveIn: number; // length of the leg into this junction
  turnDeg: number | null; // travel direction change into the next leg, signed (CCW +)
  headingInDeg: number;
  headingOutDeg: number | null;
  target: {
    cell: "far" | "audience";
    x: number;
    y: number;
    frontDistIn: number;
    backDistIn: number;
    bearingDeg: number; // field bearing from robot centre to the CELL
    turretCmdDeg: number; // shared yaw command (front-turret degrees), midway like AutoAim
    reachable: boolean;
    turretMarginDeg: number; // to the nearest yaw limit, negative = outside
  };
  zone: { in: boolean; edgeIn: number; reasons: string[] };
  // atLegStart = held when the leg into this junction began; before = on arrival; after = after the end action
  inventory: { atLegStart: number; before: number; after: number; picked: number; fired: number; beforeConfirmed: boolean };
  flags: string[];
  shotSkipped: boolean;
  // what this stop's shot launched, and whether it can score: in the shooting zone, turret in reach
  shot: { pollen: number; nectar: number; inZone: boolean; atS: number } | null;
  holds: boolean; // SHOOT / PARK hold the robot here
  wallClearanceIn: number;
  inLoadingZone: boolean;
  onCluster: boolean;
  next: null | {
    legId: string;
    intakes: boolean;
    lengthIn: number;
    facingErrDeg: number; // heading here vs the next leg's first travel direction
    intakeFacesNextDeg: number | null; // intake direction vs bearing to the nearest unpicked cluster
    nextClusterDistIn: number | null;
  };
}

export interface StartCheck {
  ownSide: boolean;
  insideField: boolean;
  touchingWall: boolean;
  clearOfFlowers: boolean;
  outOfLoadingZone: boolean;
  preloadFour: boolean;
}

export interface AutoFeatures {
  drawable: boolean;
  geometry: LegGeometry[];
  legs: LegFeatures[];
  junctions: JunctionFeatures[];
  start: StartCheck | null;
  timeline: { nominalS: number; worstS: number; abortAtS: number; autoS: number; cutLegIds: string[] };
  inventoryTimeline: { t: number; held: number }[];
  problems: Problem[];
  elementsLeft: StagedElement[];
  leave: boolean;
}

interface ResolvedPose {
  x: number;
  y: number;
  h: number;
}

const FIELD = 144;
const MID = 72;

function resolve(spec: AutoSpec): Map<string, ResolvedPose | null> {
  const out = new Map<string, ResolvedPose | null>();
  for (const p of spec.poses) {
    out.set(p.name, p.x === null || p.y === null || p.headingDeg === null ? null : { x: p.x, y: p.y, h: p.headingDeg });
  }
  return out;
}

// Pedro heading rule for a leg (toPoint: linear from the previous end heading to the target).
function headingRule(spec: AutoSpec, i: number, poses: Map<string, ResolvedPose | null>): HeadingRule | null {
  const leg = spec.legs[i];
  const h = leg.heading;
  const get = (n: string) => poses.get(n) ?? null;
  switch (h.mode) {
    case "linear": {
      const a = get(h.from);
      const b = get(h.to);
      return a && b ? { mode: "linear", startDeg: a.h, endDeg: b.h } : null;
    }
    case "constant": {
      const a = get(h.pose);
      return a ? { mode: "constant", deg: a.h } : null;
    }
    case "tangent":
      return { mode: "tangent" };
    case "reverseTangent":
      return { mode: "reverseTangent" };
    case "facingPoint": {
      const a = get(h.pose);
      return a ? { mode: "facingPoint", point: { x: a.x, y: a.y } } : null;
    }
    case "toTarget": {
      const a = get(startPoseName(spec, i));
      const b = get(leg.path.to);
      return a && b ? { mode: "linear", startDeg: a.h, endDeg: b.h } : null;
    }
  }
}

// Speed profile along the samples: rest to rest, capped by top speed, cornering and turn rate.
function timeProfile(samples: (Sample & { headingDeg: number })[], m: RobotModel): { speeds: number[]; times: number[]; total: number } {
  const n = samples.length;
  const cap = new Array<number>(n).fill(m.maxVel);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(samples[i].curvature);
    if (k > 1e-6) cap[i] = Math.min(cap[i], Math.sqrt(m.latAccel / k));
    if (i > 0) {
      const ds = samples[i].s - samples[i - 1].s;
      const dh = Math.abs(angleErrorDeg(samples[i - 1].headingDeg, samples[i].headingDeg));
      if (ds > 1e-9 && dh > 1e-9) cap[i] = Math.min(cap[i], (m.maxTurnDegS * ds) / dh);
    }
  }
  const v = cap.slice();
  v[0] = 0;
  v[n - 1] = 0;
  for (let i = 1; i < n; i++) {
    const ds = samples[i].s - samples[i - 1].s;
    v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * m.accel * ds));
  }
  for (let i = n - 2; i >= 0; i--) {
    const ds = samples[i + 1].s - samples[i].s;
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * m.decel * ds));
  }
  const times = [0];
  for (let i = 1; i < n; i++) {
    const ds = samples[i].s - samples[i - 1].s;
    const avg = (v[i] + v[i - 1]) / 2;
    times.push(times[i - 1] + (avg > 1e-6 ? ds / avg : ds > 1e-9 ? Math.sqrt((2 * ds) / m.accel) : 0));
  }
  return { speeds: v, times, total: times[n - 1] ?? 0 };
}

export function legGeometry(spec: AutoSpec, model: RobotModel): LegGeometry[] {
  const poses = resolve(spec);
  return spec.legs.map((leg, i) => {
    const names =
      leg.path.type === "toPoint"
        ? [startPoseName(spec, i), leg.path.to]
        : leg.path.type === "line"
          ? [leg.path.from, leg.path.to]
          : leg.path.type === "curve"
            ? [leg.path.from, ...leg.path.controls, leg.path.to]
            : [leg.path.from, ...leg.path.via, leg.path.to];
    const pts = names.map((n) => poses.get(n));
    const rule = headingRule(spec, i, poses);
    if (pts.some((p) => !p) || !rule) {
      const missing = names.filter((n) => !poses.get(n));
      return { legId: leg.id, drawable: false, problem: `pose ${missing.join(", ") || "heading"} has no value yet`, pieces: [], approx: false, samples: [], length: 0, travelS: 0 };
    }
    const vecs = pts.map((p) => ({ x: p!.x, y: p!.y }));
    const pieces = leg.path.type === "through" ? throughToBeziers(vecs) : [vecs];
    const sc = sampleBeziers(pieces, 1.0);
    let samples = sc.samples.map((s) => ({ ...s, headingDeg: headingAt(rule, sc.length > 0 ? s.s / sc.length : 0, s) }));
    if (sc.length < 1e-6) {
      // turn in place: two samples at the same point
      const p = vecs[0];
      const a = { s: 0, t: 0, x: p.x, y: p.y, tangentDeg: 0, curvature: 0 };
      samples = [
        { ...a, headingDeg: headingAt(rule, 0, a) },
        { ...a, t: 1, headingDeg: headingAt(rule, 1, a) },
      ];
    }
    const prof = timeProfile(samples, model);
    let total = prof.total;
    if (sc.length < 1e-6) {
      // a turn in place with no translation: rate-limited rotation
      const turn = Math.abs(angleErrorDeg(samples[0].headingDeg, samples[1].headingDeg));
      total = turn / model.maxTurnDegS;
      prof.times[1] = total;
    }
    const out: PathSample[] = samples.map((s, k) => ({ ...s, timeS: prof.times[k], speed: prof.speeds[k] }));
    return { legId: leg.id, drawable: true, pieces, approx: leg.path.type === "through", samples: out, length: sc.length, travelS: total };
  });
}

function wallClearance(poly: Vec[]): number {
  let d = Infinity;
  for (const p of poly) d = Math.min(d, p.x, p.y, FIELD - p.x, FIELD - p.y);
  return d;
}

// Intake mouth in the field: a strip past the intake edge, as wide as the robot.
function mouth(pose: { x: number; y: number; headingDeg: number }, m: RobotModel, extra: number, reachIn = m.intakeReachIn): Vec[] {
  const s = m.intakeEnd === "front" ? 1 : -1;
  const edge = m.intakeEnd === "front" ? m.body.front : m.body.back;
  const near = edge - 0.5;
  const far = edge + reachIn + extra;
  const half = m.intakeWidthIn / 2;
  return [
    toField(pose, s * near, half),
    toField(pose, s * far, half),
    toField(pose, s * far, -half),
    toField(pose, s * near, -half),
  ];
}

function pointIn(poly: Vec[], p: Vec): boolean {
  // convex polygon test via same-side cross products
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

export function targetCell(model: RobotModel, robotY: number): { cell: "far" | "audience"; x: number; y: number } {
  // BLUE (drawn side): far CELL = rotated red audience CELL, audience CELL = rotated red far CELL
  const far = robotY >= MID;
  const src = far ? model.cells.RED.audience : model.cells.RED.far;
  return { cell: far ? "far" : "audience", x: FIELD - src.x, y: FIELD - src.y };
}

// The aim math of subsystems/AutoAim.solve, for a stopped robot (no lead, no trims).
export function solveAim(pose: { x: number; y: number; headingDeg: number }, model: RobotModel) {
  const t = targetCell(model, pose.y);
  const fp = toField(pose, model.frontPivot.x, model.frontPivot.y);
  const bp = toField(pose, model.backPivot.x, model.backPivot.y);
  const frontDist = dist(fp, t);
  const backDist = dist(bp, t);
  const frontYaw = wrapDeg(Math.atan2(t.y - fp.y, t.x - fp.x) / DEG - pose.headingDeg);
  // AutoAim: the back angle (back degrees) nearest to where the gearing puts it for the front angle,
  // then converted to front degrees; the shared yaw goes midway between the two
  let backYaw = wrapDeg(Math.atan2(t.y - bp.y, t.x - bp.x) / DEG - pose.headingDeg);
  const ref = frontYaw * model.yawBackPerFront;
  while (backYaw - ref > 180) backYaw -= 360;
  while (backYaw - ref < -180) backYaw += 360;
  const cmd = (frontYaw + backYaw / model.yawBackPerFront) / 2;
  const margin = Math.min(cmd - model.yawMinDeg, model.yawMaxDeg - cmd);
  return {
    cell: t.cell,
    x: t.x,
    y: t.y,
    frontDistIn: frontDist,
    backDistIn: backDist,
    bearingDeg: wrapDeg(Math.atan2(t.y - pose.y, t.x - pose.x) / DEG),
    turretCmdDeg: cmd,
    reachable: margin >= 0,
    turretMarginDeg: margin,
  };
}

function clusters(elements: StagedElement[]): { x: number; y: number; ids: string[] }[] {
  const out: { x: number; y: number; ids: string[] }[] = [];
  for (const e of elements) {
    const c = out.find((k) => Math.hypot(k.x - e.x, k.y - e.y) < 12);
    if (c) {
      c.ids.push(e.id);
      c.x = (c.x * (c.ids.length - 1) + e.x) / c.ids.length;
      c.y = (c.y * (c.ids.length - 1) + e.y) / c.ids.length;
    } else out.push({ x: e.x, y: e.y, ids: [e.id] });
  }
  return out;
}

export function computeFeatures(spec: AutoSpec, pack: SeasonPack, model: RobotModel, overlay?: StagedElement[]): AutoFeatures {
  const problems: Problem[] = [];
  const geometry = legGeometry(spec, model);
  const poses = resolve(spec);
  const drawable = geometry.every((g) => g.drawable) && !!poses.get(spec.start);
  for (const g of geometry) if (!g.drawable) problems.push({ level: "warning", code: "leg.undrawable", where: `leg:${g.legId}`, message: g.problem ?? "cannot draw" });

  const elements: StagedElement[] = (overlay ?? pack.staged).map((e) => ({ ...e }));
  const remaining = new Map<string, StagedElement>(elements.map((e) => [e.id, e]));
  const held: HeldItem[] = [];
  const startPose = poses.get(spec.start);
  const preloadHeld = Math.max(0, spec.preload.POLLEN - spec.preload.onTiles);
  for (let k = 0; k < preloadHeld; k++) held.push({ id: `preload${k + 1}`, type: "POLLEN", confirmed: true });
  for (let k = 0; k < spec.preload.NECTAR; k++) held.push({ id: `preloadN${k + 1}`, type: "NECTAR", confirmed: true });
  if (startPose && spec.preload.onTiles > 0) {
    // TU03: preload on the tiles touching the robot; assumed in front of the intake
    for (let k = 0; k < spec.preload.onTiles; k++) {
      const off = (k - (spec.preload.onTiles - 1) / 2) * 3;
      const p = toField({ x: startPose.x, y: startPose.y, headingDeg: startPose.h }, (model.intakeEnd === "front" ? 1 : -1) * ((model.intakeEnd === "front" ? model.body.front : model.body.back) + 1.4), off);
      const e: StagedElement = { id: `tile${k + 1}`, type: "POLLEN", x: p.x, y: p.y, where: "preload on the tiles", access: "floor" };
      elements.push(e);
      remaining.set(e.id, e);
    }
  }

  let start: StartCheck | null = null;
  if (startPose) {
    const fp = footprint({ x: startPose.x, y: startPose.y, headingDeg: startPose.h }, model.body);
    const tol = pack.rules.start.wallTouchTolIn;
    const clear = wallClearance(fp);
    start = {
      ownSide: fp.every((p) => p.x >= MID - 1e-6),
      insideField: clear >= -tol,
      touchingWall: Math.abs(clear) <= tol,
      clearOfFlowers: pack.flowers.every((f) => !polygonsOverlap(fp, rectPolygon(f.foot))),
      outOfLoadingZone: !polygonsOverlap(fp, rectPolygon(pack.loadingZone.BLUE)),
      preloadFour: spec.preload.POLLEN === pack.rules.preload.POLLEN,
    };
    const g304: [keyof StartCheck, string][] = [
      ["ownSide", "G304.A: the start footprint is not fully on the blue side (x >= 72)"],
      ["insideField", "G304.A: the start footprint is outside the field"],
      ["touchingWall", "G304.C: the robot must start touching the perimeter wall"],
      ["clearOfFlowers", "G304.D: the start footprint touches a FLOWER"],
      ["outOfLoadingZone", "G304.E: the robot may not start in the LOADING ZONE"],
      ["preloadFour", "G304.G: exactly 4 POLLEN pre-loads"],
    ];
    for (const [k, msg] of g304) if (!start[k]) problems.push({ level: "error", code: `rule.G304.${k}`, where: `pose:${spec.start}`, message: msg });
  }

  const legs: LegFeatures[] = [];
  const junctions: JunctionFeatures[] = [];
  const invTimeline: { t: number; held: number }[] = [{ t: 0, held: held.length }];
  let t = 0;
  let carryUntil = -1;
  const cutLegIds: string[] = [];
  let worst = 0;
  let aborted = false;

  for (let i = 0; i < spec.legs.length; i++) {
    const leg = spec.legs[i];
    const g = geometry[i];
    const timeoutS = leg.legTimeoutS ?? model.legTimeoutS;
    const rawTravel = g.travelS;
    const travel = Math.min(rawTravel, timeoutS);
    const startS = t;
    const cut: LegFeatures["cut"] = aborted || startS >= model.abortAtS ? "never" : startS + travel > model.abortAtS ? "partial" : "none";
    if (cut !== "none") cutLegIds.push(leg.id);
    if (cut === "never") aborted = true;

    const heldAtLegStart = held.length;
    const lf: LegFeatures = {
      id: leg.id,
      index: i,
      during: leg.during,
      end: leg.end,
      lengthIn: g.length,
      curvaturePeak: 0,
      minRadiusIn: null,
      headingStartDeg: g.samples[0]?.headingDeg ?? 0,
      headingEndDeg: g.samples[g.samples.length - 1]?.headingDeg ?? 0,
      headingChangeDeg: 0,
      travelS: travel,
      rawTravelS: rawTravel,
      timeoutS,
      timesOut: rawTravel > timeoutS,
      endActionS: 0,
      endActionWorstS: 0,
      startS,
      endS: startS + travel,
      cut,
      intakeRuns: leg.during !== "NONE" || !!spec.intakeAlways,
      carryS: leg.carryIntakeS,
      intakeLeadWorstDeg: null,
      intakeLeads: null,
      picked: [],
      sweepable: [],
      missedFull: [],
      flowerReached: [],
      footprintCrossesMid: false,
      centreCrossesMid: false,
      outOfField: false,
      obstacleHits: [],
    };
    if (lf.timesOut) problems.push({ level: "warning", code: "time.legTimeout", where: `leg:${leg.id}`, message: `estimated ${round(rawTravel)} s but the leg timeout is ${timeoutS} s: the robot moves on before the end` });

    if (g.drawable) {
      let peak = 0;
      let turned = 0;
      let worstLead = 0;
      for (let k = 0; k < g.samples.length; k++) {
        const s = g.samples[k];
        peak = Math.max(peak, Math.abs(s.curvature));
        if (k > 0) turned += angleErrorDeg(g.samples[k - 1].headingDeg, s.headingDeg);
        const tAbs = startS + Math.min(s.timeS, travel);
        if (tAbs > model.abortAtS && cut !== "none") break;
        if (s.timeS > travel + 1e-9) break; // timed out before reaching this point
        const pose = { x: s.x, y: s.y, headingDeg: s.headingDeg };
        const fp = footprint(pose, model.body);
        if (fp.some((p) => p.x < MID)) lf.footprintCrossesMid = true;
        if (s.x < MID) lf.centreCrossesMid = true;
        if (wallClearance(fp) < -0.25) lf.outOfField = true;
        for (const o of pack.obstacles) if (!lf.obstacleHits.includes(o.name) && polygonsOverlap(fp, rectPolygon(o.rect))) lf.obstacleHits.push(o.name);
        const intakeOn = lf.intakeRuns || tAbs <= carryUntil;
        // the lead check is for legs set to intake; persistent intake runs on every leg and is not a promise to collect there
        if (leg.during !== "NONE" && k > 0 && s.speed > 1) {
          const dir = model.intakeEnd === "front" ? s.headingDeg : s.headingDeg + 180;
          worstLead = Math.max(worstLead, Math.abs(angleErrorDeg(dir, s.tangentDeg)));
        }
        {
          for (const e of [...remaining.values()]) {
            const r = pack.elements[e.type].diameterIn / 2;
            if (!pointIn(mouth(pose, model, r, leg.during === "RAMP" ? model.rampReachIn : model.intakeReachIn), e)) continue;
            if (e.access === "floor" && !lf.sweepable.includes(e.id)) lf.sweepable.push(e.id);
            if (!intakeOn) continue;
            // a FLOWER stack: only a RAMP leg (ramp out, G418 B) takes POLLEN from its bottom
            const stack = e.access === "flowerBottom";
            if (stack && leg.during !== "RAMP") {
              if (!lf.flowerReached.includes(e.id)) lf.flowerReached.push(e.id);
              continue;
            }
            if (held.length >= model.capacity) {
              if (!lf.missedFull.includes(e.id)) lf.missedFull.push(e.id);
              continue;
            }
            // how many one ramp pass frees is not measured yet, so a stack counts as unconfirmed
            const taken = stack ? Math.min(e.count ?? 1, model.capacity - held.length) : 1;
            for (let n = 0; n < taken; n++) {
              held.push({ id: taken > 1 ? `${e.id}#${n + 1}` : e.id, type: e.type, confirmed: !stack && !e.unconfirmed });
              lf.picked.push({ id: e.id, type: e.type, atS: round(tAbs, 2), confirmed: !stack && !e.unconfirmed });
            }
            remaining.delete(e.id);
            invTimeline.push({ t: tAbs, held: held.length });
          }
        }
      }
      lf.curvaturePeak = peak;
      lf.minRadiusIn = peak > 1e-6 ? 1 / peak : null;
      lf.headingChangeDeg = turned;
      if (leg.during !== "NONE" && g.length > 1) {
        lf.intakeLeadWorstDeg = worstLead;
        lf.intakeLeads = worstLead <= model.intakeLeadMaxDeg;
      }
    }
    if (lf.outOfField) problems.push({ level: "error", code: "rule.field", where: `leg:${leg.id}`, message: "the robot footprint leaves the field (drives into the wall)" });
    for (const o of lf.obstacleHits) {
      const flowerish = o.startsWith("FLOWER");
      problems.push({
        level: flowerish && lf.intakeRuns ? "warning" : "error",
        code: "rule.obstacle",
        where: `leg:${leg.id}`,
        message: `the robot footprint hits ${o}${flowerish && lf.intakeRuns ? " (allowed while picking up, G418 note A)" : ""}`,
      });
    }
    if (lf.centreCrossesMid) problems.push({ level: "warning", code: "rule.G402", where: `leg:${leg.id}`, message: "the robot centre crosses onto the red side during AUTO (G402: risky, may be STRATEGIC)" });
    else if (lf.footprintCrossesMid) problems.push({ level: "warning", code: "rule.G402", where: `leg:${leg.id}`, message: "part of the robot crosses x = 72 onto the red side during AUTO (G402)" });
    if (lf.flowerReached.length) problems.push({ level: "warning", code: "inventory.flower", where: `leg:${leg.id}`, message: `the intake reaches FLOWER ${lf.flowerReached.join(", ")}: POLLEN only come out of the FLOWER bottom with the ramp, and only a RAMP leg deploys it (unconfirmed, not counted)` });
    if (lf.intakeLeads === false) problems.push({ level: "warning", code: "geometry.intakeLeads", where: `leg:${leg.id}`, message: `the intake does not lead: up to ${round(lf.intakeLeadWorstDeg ?? 0, 0)} deg off the direction of travel` });

    // --- junction at the end of this leg ---
    const endName = leg.path.to;
    const ep = poses.get(endName);
    const before = held.length + 0;
    const beforeConfirmed = held.every((h) => h.confirmed);
    let fired = 0;
    let shotSkipped = false;
    let shot: JunctionFeatures["shot"] = null;
    const flags: string[] = [];
    let endActionS = 0;
    let endWorst = 0;
    if (g.drawable && ep) {
      const endSample = g.samples[g.samples.length - 1];
      const hEnd = endSample?.headingDeg ?? ep.h;
      const pose = { x: ep.x, y: ep.y, headingDeg: hEnd };
      const aim = solveAim(pose, model);
      const fp = footprint(pose, model.body);
      const clear = wallClearance(fp);
      const firing = held.some((h) => h.type === "NECTAR") ? Math.max(aim.frontDistIn, aim.backDistIn) : aim.backDistIn;
      const firingMin = held.some((h) => h.type === "NECTAR") ? Math.min(aim.frontDistIn, aim.backDistIn) : aim.backDistIn;
      const reasons: string[] = [];
      const bandEdge = Math.min(firingMin - model.shotMinIn, model.shotMaxIn - firing);
      if (firingMin < model.shotMinIn) reasons.push(`closer than the shortest shot (${round(firingMin)} < ${model.shotMinIn} in)`);
      if (firing > model.shotMaxIn) reasons.push(`farther than the longest shot (${round(firing)} > ${model.shotMaxIn} in)`);
      if (!aim.reachable) reasons.push(`CELL outside yaw travel (needs ${round(aim.turretCmdDeg, 0)} deg)`);
      if (clear < model.wallMarginIn) reasons.push(`within ${model.wallMarginIn} in of a wall`);
      if (pack.obstacles.some((o) => polygonsOverlap(fp, rectPolygon(o.rect)))) reasons.push("footprint on a field element");
      if (fp.some((p) => p.x < MID)) reasons.push("not fully on the blue side");
      const inZone = reasons.length === 0;

      if (leg.end === "SHOOT") {
        if (!aim.reachable) {
          shotSkipped = true;
          endActionS = leg.shotTimeoutS ?? model.shotAbandonS;
          endWorst = endActionS;
          flags.push("shot skipped: CELL outside yaw travel, AutoRunner gives up after the shot timeout");
        } else {
          endActionS = model.settleS + model.gateTravelS + model.feedS;
          endWorst = Math.min(model.readyTimeoutS + model.settleS, leg.shotTimeoutS ?? Infinity) + model.shotAbandonS;
          fired = Math.min(held.length, model.elementsPerShot);
          if (before === 0) flags.push("empty shot: holding 0");
          if (!inZone) flags.push(`shot outside the shooting zone: ${reasons.join("; ")}`);
          const out = held.slice(0, fired);
          shot = { pollen: out.filter((h) => h.type === "POLLEN").length, nectar: out.filter((h) => h.type === "NECTAR").length, inZone, atS: startS + travel + endActionS };
          held.splice(0, fired);
          invTimeline.push({ t: startS + travel + endActionS, held: held.length });
        }
      }
      const cl = clusters([...remaining.values()].filter((e) => e.access === "floor"));
      const near = cl.map((c) => ({ c, d: Math.hypot(c.x - ep.x, c.y - ep.y) })).sort((a, b) => a.d - b.d)[0] ?? null;
      const onCluster = lf.picked.length > 0 || (near !== null && near.d < Math.max(model.body.front, model.body.back) + model.intakeReachIn + 6);
      if (leg.during !== "NONE" && lf.picked.length === 0 && lf.missedFull.length === 0) {
        // a RAMP leg is meant for a FLOWER: say how far it ended from the nearest stack
        const stacks = [...remaining.values()].filter((e) => e.access === "flowerBottom").map((e) => ({ e, d: Math.hypot(e.x - ep.x, e.y - ep.y) })).sort((a, b) => a.d - b.d);
        flags.push(leg.during === "RAMP" && stacks.length
          ? `RAMP leg takes nothing: it ends ${round(stacks[0].d, 1)} in from the ${stacks[0].e.where} (the ramp takes POLLEN up to ${round(model.body.front + model.rampReachIn + pack.elements[stacks[0].e.type].diameterIn / 2, 1)} in from the centre; set the ramp reach in the profile once the CAD has it)`
          : "intake leg picks nothing the field map confirms");
      }
      if (lf.missedFull.length) flags.push(`intake while full: ${lf.missedFull.length} element(s) reached at capacity ${model.capacity}`);
      if (lf.picked.some((p) => !p.confirmed)) flags.push(leg.during === "RAMP" && lf.picked.some((p) => p.id.startsWith("F")) ? "POLLEN taken from a FLOWER by the ramp: how many one pass frees is not measured (unconfirmed)" : "unconfirmed elements picked (not in the season pack)");
      const inLZ = polygonsOverlap(fp, rectPolygon(pack.loadingZone.BLUE));
      if (leg.end === "PARK" && !inLZ) flags.push("PARK outside the LOADING ZONE scores nothing (10.5.4)");

      const nextLeg = spec.legs[i + 1];
      const nextGeo = geometry[i + 1];
      let next: JunctionFeatures["next"] = null;
      let turnDeg: number | null = null;
      if (nextLeg && nextGeo?.drawable && nextGeo.samples.length > 1) {
        const outDir = nextGeo.length > 0.5 ? nextGeo.samples[Math.min(2, nextGeo.samples.length - 1)].tangentDeg : hEnd;
        const inDir = g.length > 0.5 ? endSample.tangentDeg : hEnd;
        turnDeg = g.length > 0.5 && nextGeo.length > 0.5 ? angleErrorDeg(inDir, outDir) : null;
        let intakeFaces: number | null = null;
        let nextDist: number | null = null;
        if (near) {
          const bearing = Math.atan2(near.c.y - ep.y, near.c.x - ep.x) / DEG;
          const dir = model.intakeEnd === "front" ? hEnd : hEnd + 180;
          intakeFaces = Math.abs(angleErrorDeg(dir, bearing));
          nextDist = near.d;
        }
        next = {
          legId: nextLeg.id,
          intakes: nextLeg.during !== "NONE",
          lengthIn: nextGeo.length,
          facingErrDeg: Math.abs(angleErrorDeg(hEnd, outDir)),
          intakeFacesNextDeg: intakeFaces,
          nextClusterDistIn: nextDist,
        };
      }
      const isImported = leg.junction.source === "imported";
      junctions.push({
        id: leg.id,
        index: i,
        pose: { name: endName, x: ep.x, y: ep.y, headingDeg: hEnd },
        isLast: i === spec.legs.length - 1,
        during: leg.during,
        end: leg.end,
        source: leg.junction.source,
        shotInCode: isImported ? leg.end === "SHOOT" : null,
        dwellInCode: isImported ? { carryIntakeS: leg.carryIntakeS, timeoutS: leg.legTimeoutS } : null,
        moveIn: g.length,
        turnDeg,
        headingInDeg: hEnd,
        headingOutDeg: nextGeo?.drawable ? (nextGeo.samples[0]?.headingDeg ?? null) : null,
        target: aim,
        zone: { in: inZone, edgeIn: bandEdge, reasons },
        inventory: { atLegStart: heldAtLegStart, before, after: held.length, picked: lf.picked.length, fired, beforeConfirmed },
        flags,
        shotSkipped,
        shot,
        holds: leg.end === "SHOOT" || leg.end === "PARK" || leg.end === "WAIT",
        wallClearanceIn: clear,
        inLoadingZone: inLZ,
        onCluster,
        next,
      });
    }
    lf.endActionS = endActionS;
    lf.endActionWorstS = endWorst;
    // AutoRunner's abort check also stops a shot that is still firing
    if (lf.cut === "none" && startS + travel + endActionS > model.abortAtS) {
      lf.cut = "partial";
      cutLegIds.push(leg.id);
    }
    if (leg.during !== "NONE" && leg.carryIntakeS > 0) carryUntil = startS + travel + leg.carryIntakeS;
    // End.WAIT: the robot holds still at the path end
    const waitS = leg.end === "WAIT" ? (leg.waitS ?? 0) : 0;
    t = startS + travel + endActionS + waitS;
    lf.endS = t;
    worst += travel + Math.max(endActionS, endWorst) + waitS;
    legs.push(lf);
    if (leg.end === "PARK") {
      for (const rest of spec.legs.slice(i + 1)) if (!cutLegIds.includes(rest.id)) cutLegIds.push(rest.id);
      break;
    }
  }

  for (const j of junctions) {
    for (const f of j.flags) {
      if (f.startsWith("empty shot") || f.startsWith("shot skipped")) problems.push({ level: "warning", code: "inventory.emptyShot", where: `leg:${j.id}`, message: f });
      else if (f.startsWith("PARK outside")) problems.push({ level: "warning", code: "rule.park", where: `leg:${j.id}`, message: f });
    }
  }
  // An over-long auto is not unsafe (AutoRunner stops at ABORT_AT_S) but the cut legs never score.
  const parked = spec.legs.findIndex((l) => l.end === "PARK");
  const afterPark = parked >= 0 ? spec.legs.slice(parked + 1).map((l) => l.id) : [];
  const timeCut = cutLegIds.filter((id) => !afterPark.includes(id));
  if (timeCut.length) {
    problems.push({
      level: "warning",
      code: "time.abort",
      where: "spec",
      message: `${t > pack.rules.autoDurationS ? `estimated ${round(t)} s is longer than the ${pack.rules.autoDurationS} s auto; ` : ""}AutoRunner stops at ${model.abortAtS} s, so ${timeCut.join(", ")} ${timeCut.length > 1 ? "are" : "is"} cut or never run`,
    });
  }

  const last = junctions[junctions.length - 1];
  const leave = !!last && last.wallClearanceIn > pack.rules.start.wallTouchTolIn;
  return {
    drawable,
    geometry,
    legs,
    junctions,
    start,
    timeline: { nominalS: t, worstS: worst, abortAtS: model.abortAtS, autoS: pack.rules.autoDurationS, cutLegIds },
    inventoryTimeline: invTimeline,
    problems,
    elementsLeft: [...remaining.values()],
    leave,
  };
}

// The robot pose at time `ts` along the route (for the scrubber).
export function poseAtTime(f: AutoFeatures, ts: number): { x: number; y: number; headingDeg: number; legId: string | null; phase: "travel" | "action" | "done" } | null {
  for (const lf of f.legs) {
    const g = f.geometry[lf.index];
    if (!g?.drawable || g.samples.length === 0) continue;
    if (ts <= lf.startS + lf.travelS) {
      const local = Math.max(0, ts - lf.startS);
      let k = 0;
      while (k < g.samples.length - 1 && g.samples[k + 1].timeS < local) k++;
      const a = g.samples[k];
      const b = g.samples[Math.min(k + 1, g.samples.length - 1)];
      const span = b.timeS - a.timeS;
      const fr = span > 1e-9 ? Math.min(1, Math.max(0, (local - a.timeS) / span)) : 0;
      return {
        x: a.x + (b.x - a.x) * fr,
        y: a.y + (b.y - a.y) * fr,
        headingDeg: wrapDeg(a.headingDeg + angleErrorDeg(a.headingDeg, b.headingDeg) * fr),
        legId: lf.id,
        phase: "travel",
      };
    }
    if (ts <= lf.endS) {
      const s = g.samples[g.samples.length - 1];
      return { x: s.x, y: s.y, headingDeg: s.headingDeg, legId: lf.id, phase: "action" };
    }
  }
  const lastLeg = f.legs[f.legs.length - 1];
  const g = lastLeg ? f.geometry[lastLeg.index] : null;
  const s = g?.samples[g.samples.length - 1];
  return s ? { x: s.x, y: s.y, headingDeg: s.headingDeg, legId: null, phase: "done" } : null;
}

export function heldAt(f: AutoFeatures, ts: number): number {
  let h = f.inventoryTimeline[0]?.held ?? 0;
  for (const e of f.inventoryTimeline) if (e.t <= ts + 1e-9) h = e.held;
  return h;
}
