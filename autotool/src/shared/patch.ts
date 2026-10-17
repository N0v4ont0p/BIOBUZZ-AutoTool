// The AI's answer format (submit_patch) and how it is applied to a spec. The AI never writes Java:
// it says what each leg does (during, end) and proposes edit operations; code applies and checks them.

import type { AutoFeatures } from "./features.ts";
import { round } from "./geometry.ts";
import { type AutoSpec, DURINGS, type During, ENDS, type End, type HeadingDef, type Leg, cloneSpec, nextLegId, renumberLegs, uniqueName, withStop } from "./spec.ts";

export type PatchOp =
  | { op: "move_pose"; pose: string; x: number; y: number; headingDeg?: number }
  | { op: "set_heading"; pose: string; headingDeg: number }
  | { op: "add_leg"; after: string; pose: { name?: string; x: number; y: number; headingDeg: number }; during: During; end: End; waitS?: number }
  | { op: "delete_leg"; leg: string }
  | { op: "set_auto"; intakeAlways: boolean }
  | { op: "set_leg"; leg: string; legTimeoutS?: number | null; carryIntakeS?: number; shotTimeoutS?: number | null; carryRampS?: number | null; heading?: "linear" | "constant" | "tangent" | "reverseTangent" }
  | { op: "set_preload"; POLLEN: number; onTiles: number };

// What one leg does: the same during/end fields as the robot code's AutoRunner.Leg.
export interface JunctionAnnotation {
  junction: string; // leg id
  evidence: string[];
  during: During;
  end: End;
  waitS?: number; // end WAIT: seconds
  review?: boolean; // the evidence conflicts: the team decides
  reason: string;
}

export interface Claim {
  ref: string;
  value: number;
}

export interface Patch {
  summary: string;
  junctions: JunctionAnnotation[];
  ops: PatchOp[];
  claims: Claim[];
  question?: string; // set when the AI needs the user to decide
}

export const PATCH_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two short sentences: what this patch does. Write measured values as {key} (e.g. {L3.dist}); code fills them in." },
    junctions: {
      type: "array",
      description: "One entry per leg you decide (annotation tasks: every leg). Evidence first, then what the leg does.",
      items: {
        type: "object",
        properties: {
          junction: { type: "string", description: "Leg id, e.g. L3" },
          evidence: { type: "array", items: { type: "string" }, description: "Evidence tokens copied from get_features, in protocol order" },
          during: { type: "string", enum: [...DURINGS], description: "While driving: NONE, INTAKE (intake on the whole path), RAMP (intake + ramp out)" },
          end: { type: "string", enum: [...ENDS], description: "At the end of the path: NONE (go on), SHOOT, PARK (finish), WAIT (hold still waitS seconds)" },
          waitS: { type: "number", description: "end WAIT only: seconds to hold" },
          review: { type: "boolean", description: "true when the evidence conflicts and the team must decide (say why in reason)" },
          reason: { type: "string", description: "One short sentence" },
        },
        required: ["junction", "evidence", "during", "end", "reason"],
      },
    },
    ops: {
      type: "array",
      description: "Edits to the route. Empty for a pure annotation.",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["move_pose", "set_heading", "add_leg", "delete_leg", "set_leg", "set_preload", "set_auto"] },
          intakeAlways: { type: "boolean", description: "set_auto: persistent intake, the intake runs all auto except during shots" },
          pose: { description: "move_pose/set_heading: pose name. add_leg: {name?, x, y, headingDeg} of the new end pose" },
          leg: { type: "string", description: "delete_leg/set_leg: leg id" },
          after: { type: "string", description: "add_leg: the leg id the new leg follows, or 'start'. The new leg is L<next free number> inside this patch (decide it with that id); after the patch every leg is renumbered L1..Ln in route order" },
          x: { type: "number", description: "inches, field frame" },
          y: { type: "number", description: "inches, field frame" },
          headingDeg: { type: "number", description: "degrees, 0 = +x, counter-clockwise +" },
          during: { type: "string", enum: [...DURINGS], description: "add_leg: while driving the new leg" },
          end: { type: "string", enum: [...ENDS], description: "add_leg: at the end of the new leg" },
          waitS: { type: "number", description: "add_leg with end WAIT: seconds" },
          legTimeoutS: { type: ["number", "null"], description: "set_leg: stop driving after this long (null = AutoRunner's default)" },
          carryIntakeS: { type: "number", description: "set_leg, INTAKE/RAMP legs: keep the intake on this long into the next leg" },
          shotTimeoutS: { type: ["number", "null"], description: "set_leg, end SHOOT: skip the shot if not ready within this long (null = default)" },
          carryRampS: { type: ["number", "null"], description: "set_leg, RAMP legs: keep the ramp out this long into the next leg so it backs out of the FLOWER first (null = default)" },
          heading: { type: "string", enum: ["linear", "constant", "tangent", "reverseTangent"] },
          POLLEN: { type: "integer" },
          onTiles: { type: "integer" },
        },
        required: ["op"],
      },
    },
    claims: {
      type: "array",
      description: "Optional: numbers you typed as digits, with the get_features key they come from. Prefer {key} placeholders in the text.",
      items: { type: "object", properties: { ref: { type: "string" }, value: { type: "number" } }, required: ["ref", "value"] },
    },
    question: { type: "string", description: "Only when you cannot decide without the user: one short question." },
  },
  required: ["summary", "junctions", "ops", "claims"],
} as const;

// Shape check (the API does not enforce the schema here; this does).
export function parsePatch(input: unknown): { patch?: Patch; errors: string[] } {
  const errors: string[] = [];
  const o = input as Record<string, unknown>;
  if (!o || typeof o !== "object") return { errors: ["patch is not an object"] };
  if (typeof o.summary !== "string") errors.push("summary must be a string");
  if (!Array.isArray(o.junctions)) errors.push("junctions must be an array");
  if (!Array.isArray(o.ops)) errors.push("ops must be an array");
  if (!Array.isArray(o.claims)) errors.push("claims must be an array");
  if (errors.length) return { errors };
  for (const j of o.junctions as JunctionAnnotation[]) {
    if (typeof j?.junction !== "string") errors.push("each junction needs a junction id");
    if (!DURINGS.includes(j?.during)) errors.push(`leg ${j?.junction}: during must be one of ${DURINGS.join(", ")}`);
    if (!ENDS.includes(j?.end)) errors.push(`leg ${j?.junction}: end must be one of ${ENDS.join(", ")}`);
    if (j?.end === "WAIT" && !(typeof j.waitS === "number" && j.waitS > 0)) errors.push(`leg ${j?.junction}: end WAIT needs waitS`);
    if (!Array.isArray(j?.evidence)) errors.push(`junction ${j?.junction}: evidence must be an array`);
  }
  for (const c of o.claims as Claim[]) if (typeof c?.ref !== "string" || typeof c?.value !== "number") errors.push("claims need {ref, value}");
  const ops = (o.ops as Record<string, unknown>[]).map((op) => normaliseOp(op, errors));
  if (errors.length) return { errors };
  return { patch: { summary: o.summary as string, junctions: o.junctions as JunctionAnnotation[], ops: ops.filter((x): x is PatchOp => !!x), claims: o.claims as Claim[], ...(typeof o.question === "string" && o.question ? { question: o.question } : {}) }, errors };
}

function normaliseOp(op: Record<string, unknown>, errors: string[]): PatchOp | null {
  const num = (k: string) => (typeof op[k] === "number" && Number.isFinite(op[k]) ? (op[k] as number) : undefined);
  switch (op.op) {
    case "move_pose":
      if (typeof op.pose !== "string" || num("x") === undefined || num("y") === undefined) {
        errors.push("move_pose needs pose, x, y");
        return null;
      }
      return { op: "move_pose", pose: op.pose, x: num("x")!, y: num("y")!, ...(num("headingDeg") !== undefined ? { headingDeg: num("headingDeg") } : {}) };
    case "set_heading":
      if (typeof op.pose !== "string" || num("headingDeg") === undefined) {
        errors.push("set_heading needs pose, headingDeg");
        return null;
      }
      return { op: "set_heading", pose: op.pose, headingDeg: num("headingDeg")! };
    case "add_leg": {
      const p = op.pose as Record<string, unknown> | undefined;
      const x = typeof p?.x === "number" ? p.x : num("x");
      const y = typeof p?.y === "number" ? p.y : num("y");
      const h = typeof p?.headingDeg === "number" ? p.headingDeg : num("headingDeg");
      if (typeof op.after !== "string" || x === undefined || y === undefined || h === undefined || !DURINGS.includes(op.during as During) || !ENDS.includes(op.end as End)) {
        errors.push("add_leg needs after, pose {x, y, headingDeg}, during and end");
        return null;
      }
      return { op: "add_leg", after: op.after, pose: { ...(typeof p?.name === "string" ? { name: p.name } : {}), x, y, headingDeg: h }, during: op.during as During, end: op.end as End, ...(num("waitS") !== undefined ? { waitS: num("waitS") } : {}) };
    }
    case "delete_leg":
      if (typeof op.leg !== "string") {
        errors.push("delete_leg needs leg");
        return null;
      }
      return { op: "delete_leg", leg: op.leg };
    case "set_leg":
      if (typeof op.leg !== "string") {
        errors.push("set_leg needs leg");
        return null;
      }
      return {
        op: "set_leg",
        leg: op.leg,
        ...(op.legTimeoutS === null || typeof op.legTimeoutS === "number" ? { legTimeoutS: op.legTimeoutS as number | null } : {}),
        ...(num("carryIntakeS") !== undefined ? { carryIntakeS: num("carryIntakeS") } : {}),
        ...(typeof op.heading === "string" ? { heading: op.heading as "linear" } : {}),
        ...(op.shotTimeoutS === null || num("shotTimeoutS") !== undefined ? { shotTimeoutS: op.shotTimeoutS as number | null } : {}),
        ...(op.carryRampS === null || num("carryRampS") !== undefined ? { carryRampS: op.carryRampS as number | null } : {}),
      };
    case "set_auto":
      if (typeof op.intakeAlways !== "boolean") {
        errors.push("set_auto needs intakeAlways (true or false)");
        return null;
      }
      return { op: "set_auto", intakeAlways: op.intakeAlways };
    case "set_preload":
      if (!Number.isInteger(op.POLLEN) || !Number.isInteger(op.onTiles)) {
        errors.push("set_preload needs POLLEN and onTiles");
        return null;
      }
      return { op: "set_preload", POLLEN: op.POLLEN as number, onTiles: op.onTiles as number };
    default:
      errors.push(`unknown op ${String(op.op)}`);
      return null;
  }
}

function headingFor(kind: "linear" | "constant" | "tangent" | "reverseTangent", from: string, to: string): HeadingDef {
  switch (kind) {
    case "linear":
      return { mode: "linear", from, to };
    case "constant":
      return { mode: "constant", pose: from };
    case "tangent":
      return { mode: "tangent" };
    default:
      return { mode: "reverseTangent" };
  }
}

// Applies a patch to a copy of the spec. Decision sources are "ai"; evidence is kept.
export function applyPatch(spec: AutoSpec, patch: Patch, source: "ai" | "user" = "ai"): { spec: AutoSpec; errors: string[] } {
  const s = cloneSpec(spec);
  const errors: string[] = [];
  const legIndex = (id: string) => s.legs.findIndex((l) => l.id === id);
  for (const op of patch.ops) {
    switch (op.op) {
      case "move_pose":
      case "set_heading": {
        const p = s.poses.find((q) => q.name === op.pose);
        if (!p) {
          errors.push(`${op.op}: no pose ${op.pose}`);
          break;
        }
        if (op.op === "move_pose") {
          p.x = round(op.x, 2);
          p.y = round(op.y, 2);
          if (p.expr) {
            delete p.expr.x;
            delete p.expr.y;
          }
        }
        if (op.headingDeg !== undefined) {
          p.headingDeg = round(op.headingDeg, 2);
          if (p.expr) delete p.expr.h;
        }
        if (p.expr && !p.expr.x && !p.expr.y && !p.expr.h) delete p.expr;
        break;
      }
      case "add_leg": {
        const at = op.after === "start" ? -1 : legIndex(op.after);
        if (op.after !== "start" && at < 0) {
          errors.push(`add_leg: no leg ${op.after}`);
          break;
        }
        const from = at < 0 ? s.start : s.legs[at].path.to;
        const taken = new Set(s.poses.map((p) => p.name));
        const name = uniqueName(op.pose.name ?? defaultPoseName(op.during, op.end), taken);
        s.poses.push({ name, x: round(op.pose.x, 2), y: round(op.pose.y, 2), headingDeg: round(op.pose.headingDeg, 2), role: "waypoint", ...(s.poses.some((p) => p.redTrim) ? { redTrim: [0, 0, 0] as [number, number, number] } : {}) });
        const methods = new Set(s.legs.map((l) => l.method).filter(Boolean) as string[]);
        const method = uniqueName(`${from}To${name[0].toUpperCase()}${name.slice(1)}`, methods);
        let leg: Leg = {
          id: nextLegId(s),
          method,
          path: { type: "line", from, to: name },
          heading: { mode: "linear", from, to: name },
          during: "NONE",
          end: "NONE",
          carryIntakeS: 0,
          legTimeoutS: null,
          junction: { source, evidence: [] },
        };
        leg = withStop(leg, op.during, op.end, source, [], op.waitS ? { waitS: op.waitS } : {});
        s.legs.splice(at + 1, 0, leg);
        // the leg after it now starts at the new pose
        const after = s.legs[at + 2];
        if (after && after.path.type !== "toPoint") {
          after.path = { ...after.path, from: name };
          if (after.heading.mode === "linear" && after.heading.from === from) after.heading = { ...after.heading, from: name };
        }
        break;
      }
      case "delete_leg": {
        const i = legIndex(op.leg);
        if (i < 0) {
          errors.push(`delete_leg: no leg ${op.leg}`);
          break;
        }
        if (s.legs.length === 1) {
          errors.push("delete_leg: an auto needs at least one leg");
          break;
        }
        const removed = s.legs[i];
        const from = i === 0 ? s.start : s.legs[i - 1].path.to;
        s.legs.splice(i, 1);
        const next = s.legs[i];
        if (next && next.path.type !== "toPoint" && next.path.from === removed.path.to) {
          next.path = { ...next.path, from };
          if (next.heading.mode === "linear" && next.heading.from === removed.path.to) next.heading = { ...next.heading, from };
        }
        // drop poses nothing uses any more
        const used = new Set<string>([s.start]);
        for (const l of s.legs) {
          const p = l.path;
          if (p.type !== "toPoint") used.add(p.from);
          used.add(p.to);
          if (p.type === "curve") p.controls.forEach((c) => used.add(c));
          if (p.type === "through") p.via.forEach((c) => used.add(c));
          if (l.heading.mode === "linear") {
            used.add(l.heading.from);
            used.add(l.heading.to);
          }
          if ("pose" in l.heading) used.add(l.heading.pose);
        }
        s.poses = s.poses.filter((p) => used.has(p.name));
        break;
      }
      case "set_leg": {
        const i = legIndex(op.leg);
        if (i < 0) {
          errors.push(`set_leg: no leg ${op.leg}`);
          break;
        }
        const l = s.legs[i];
        if (op.legTimeoutS !== undefined) l.legTimeoutS = op.legTimeoutS;
        if (op.carryIntakeS !== undefined) l.carryIntakeS = op.carryIntakeS;
        if (op.shotTimeoutS === null) delete l.shotTimeoutS;
        else if (op.shotTimeoutS !== undefined) l.shotTimeoutS = op.shotTimeoutS;
        if (op.carryRampS === null) delete l.carryRampS;
        else if (op.carryRampS !== undefined) l.carryRampS = op.carryRampS;
        if (op.heading) {
          if (l.path.type === "toPoint") errors.push(`set_leg ${op.leg}: a straight-to-point leg always turns linearly`);
          else l.heading = headingFor(op.heading, l.path.from, l.path.to);
        }
        break;
      }
      case "set_preload":
        s.preload = { ...s.preload, POLLEN: op.POLLEN, onTiles: op.onTiles };
        break;
      case "set_auto":
        if (op.intakeAlways) s.intakeAlways = true;
        else delete s.intakeAlways;
        break;
    }
  }
  for (const a of patch.junctions) {
    const i = legIndex(a.junction);
    if (i < 0) {
      errors.push(`no leg ${a.junction}`);
      continue;
    }
    s.legs[i] = withStop(s.legs[i], a.during, a.end, source, a.evidence, { ...(a.review ? { review: true, note: a.reason } : {}), ...(a.waitS ? { waitS: a.waitS } : {}) });
  }
  // ids are positional: a new leg is L<next free> during the patch, then all legs are renumbered
  const structural = patch.ops.some((o) => o.op === "add_leg" || o.op === "delete_leg");
  return { spec: structural ? renumberLegs(s) : s, errors };
}

export function defaultPoseName(during: During, end: End): string {
  if (end === "SHOOT") return "shot";
  if (end === "PARK") return "park";
  if (during === "RAMP") return "ramp";
  if (during === "INTAKE") return "intake";
  return end === "WAIT" ? "hold" : "point";
}

// --- the features sheet the AI cites from, and the claim checker ---------------------------------

export function featureSheet(f: AutoFeatures): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined, places = 1) => {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = round(v, places);
  };
  for (const j of f.junctions) {
    const p = j.id;
    put(`${p}.x`, j.pose.x);
    put(`${p}.y`, j.pose.y);
    put(`${p}.heading`, j.pose.headingDeg, 0);
    put(`${p}.move`, j.moveIn);
    put(`${p}.turn`, j.turnDeg, 0);
    put(`${p}.dist`, j.target.backDistIn);
    put(`${p}.frontDist`, j.target.frontDistIn);
    put(`${p}.frontTurret`, j.target.frontYawDeg, 0);
    put(`${p}.backTurret`, j.target.backYawDeg, 0);
    put(`${p}.turretMargin`, j.target.turretMarginDeg, 0);
    put(`${p}.zoneEdge`, j.zone.edgeIn);
    put(`${p}.heldAtLegStart`, j.inventory.atLegStart, 0);
    put(`${p}.held`, j.inventory.before, 0);
    put(`${p}.heldAfter`, j.inventory.after, 0);
    put(`${p}.picked`, j.inventory.picked, 0);
    put(`${p}.fired`, j.inventory.fired, 0);
    put(`${p}.wall`, j.wallClearanceIn);
    const leg = f.legs[j.index];
    put(`${p}.sweeps`, leg?.sweepable.length ?? 0, 0);
    put(`${p}.travel`, leg?.travelS, 1);
    put(`${p}.arrive`, (leg?.startS ?? 0) + (leg?.travelS ?? 0), 1);
    put(`${p}.leave`, leg?.endS, 1);
    if (leg && (leg.during === "RAMP" || leg.ramp.maxOut > 0.02)) {
      put(`${p}.rampOnArrival`, leg.ramp.atArrival * 100, 0); // percent out when the robot arrives
      put(`${p}.rampOut`, leg.ramp.outAtS, 1); // when it is fully out (s)
    }
    if (j.next) {
      put(`${p}.facingNext`, j.next.facingErrDeg, 0);
      put(`${p}.nextClusterDist`, j.next.nextClusterDistIn);
    }
  }
  put("total.legs", f.legs.length, 0);
  put("total.junctions", f.junctions.length, 0);
  put("total.time", f.timeline.nominalS, 1);
  put("total.worst", f.timeline.worstS, 1);
  if (f.ramp.used) {
    put("ramp.out", f.ramp.outS, 2);
    put("ramp.in", f.ramp.inS, 2);
  }
  put("abortAt", f.timeline.abortAtS, 1);
  return out;
}

export interface ClaimResult {
  ok: boolean;
  mismatches: { ref: string; claimed: number; actual: number | null }[];
  unverifiedNumbers: string[]; // numbers in the text that no claim or computed value supports
}

function tolerance(ref: string, actual: number): number {
  if (/held|picked|fired|sweeps/.test(ref)) return 0;
  if (/heading|turn|turret|facing/.test(ref)) return 2;
  if (/time|travel|arrive|leave|worst|abort/.test(ref)) return 0.2;
  return Math.max(0.6, Math.abs(actual) * 0.02);
}

export function checkClaims(patch: Patch, sheet: Record<string, number>, extraAllowed: number[] = []): ClaimResult {
  const mismatches: ClaimResult["mismatches"] = [];
  for (const c of patch.claims) {
    const actual = sheet[c.ref];
    if (actual === undefined) mismatches.push({ ref: c.ref, claimed: c.value, actual: null });
    else if (Math.abs(actual - c.value) > tolerance(c.ref, actual)) mismatches.push({ ref: c.ref, claimed: c.value, actual });
  }
  // Free-text numbers must be declared in claims (each checked above against its feature key), be an
  // op value, or be a number the user typed. Matching "any computed value" would let a made-up number
  // through by coincidence.
  const text = [patch.summary, ...patch.junctions.map((j) => j.reason), patch.question ?? ""].join(" ");
  const allowed = [...patch.claims.map((c) => c.value), ...extraAllowed];
  for (const op of patch.ops) for (const v of Object.values(op)) if (typeof v === "number") allowed.push(v);
  const unverified: string[] = [];
  // a number with a unit or a count word is always checked; a bare small integer is an ordinal ("shot 2")
  const re = /(holding|holds|held|hold|picks?|fires?|with)?\s*(?<![A-Za-z0-9_.])(-?\d+(?:\.\d+)?)(?![A-Za-z0-9_])\s*(in\b|inch|inches|s\b|sec|seconds|deg|degrees|°|elements?|POLLEN|NECTAR|balls?)?/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]);
    // ordinals naming things, not measurements: "rule 6", "row 3", "shot 2", "leg 4", "stop 1"
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + (m[0].indexOf(m[2]) >= 0 ? m[0].indexOf(m[2]) : 0));
    if (/\b(rule|row|step|order|leg|junction|shot|stop|example|attempt|pose|point|L)\s*$/i.test(before) && Number.isInteger(n)) continue;
    const counted = !!m[1] || !!m[3];
    if (!counted && Number.isInteger(n) && n >= 0 && n <= 4) continue;
    // a bare small count ("all 6 junctions") is not a measurement; held counts and anything with a unit are checked
    if (!counted && Number.isInteger(n) && n >= 0 && n <= 12) continue;
    const tol = (a: number) => (counted && Number.isInteger(n) && /element|POLLEN|NECTAR|ball/i.test(m[3] ?? "") ? 0 : Math.max(0.6, Math.abs(a) * 0.02));
    if (!allowed.some((a) => Math.abs(a - n) <= tol(a))) unverified.push(m[2]);
  }
  return { ok: mismatches.length === 0 && unverified.length === 0, mismatches, unverifiedNumbers: [...new Set(unverified)] };
}

// Text fields the team reads.
function mapText(patch: Patch, f: (t: string) => string): Patch {
  return { ...patch, summary: f(patch.summary), junctions: patch.junctions.map((j) => ({ ...j, reason: f(j.reason) })), ...(patch.question ? { question: f(patch.question) } : {}) };
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

// {L3.dist} in the text -> the computed value; each becomes a claim (it is right by construction).
export function fillRefs(patch: Patch, sheet: Record<string, number>): { patch: Patch; unknown: string[] } {
  const unknown: string[] = [];
  const claims = [...patch.claims];
  const out = mapText(patch, (t) =>
    t.replace(/\{([A-Za-z][A-Za-z0-9_.]*)\}/g, (all, k: string) => {
      const v = sheet[k];
      if (v === undefined) {
        unknown.push(k);
        return all;
      }
      claims.push({ ref: k, value: v });
      return fmt(v);
    }),
  );
  return { patch: { ...out, claims }, unknown: [...new Set(unknown)] };
}

// Code is the truth: a claimed number that disagrees with its feature key is replaced by the computed
// value, and a number nothing backs is replaced by "[?]", so no invented number reaches the team.
export function correctNumbers(patch: Patch, r: ClaimResult): { patch: Patch; corrected: string[] } {
  const corrected: string[] = [];
  const wrong = r.mismatches.filter((m) => m.actual !== null);
  const bad = new Set(r.unverifiedNumbers);
  const p = mapText(patch, (t) =>
    t.replace(/(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g, (n) => {
      const m = wrong.find((w) => Math.abs(w.claimed - Number(n)) < 0.05);
      if (m) {
        corrected.push(`${n} -> ${fmt(m.actual!)} (${m.ref})`);
        return fmt(m.actual!);
      }
      if (bad.has(n)) {
        corrected.push(`${n} -> [?] (no computed value)`);
        return "[?]";
      }
      return n;
    }),
  );
  return { patch: { ...p, claims: p.claims.map((c) => (wrong.some((w) => w.ref === c.ref) ? { ...c, value: wrong.find((w) => w.ref === c.ref)!.actual! } : c)).filter((c) => !r.mismatches.some((m) => m.ref === c.ref && m.actual === null)) }, corrected };
}
