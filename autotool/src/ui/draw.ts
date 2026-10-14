// Pure drawing math for the field view (no DOM). SVG space: x right, y DOWN, 0..144.
// Field space: x right, y UP. The red view is the 180-degree rotation the robot code applies.

import type { AutoFeatures, PathSample } from "../shared/features.ts";
import { DEG } from "../shared/geometry.ts";
import type { Leg } from "../shared/spec.ts";

export const FIELD = 144;

export function sx(x: number, y: number, red: boolean): { x: number; y: number } {
  const fx = red ? FIELD - x : x;
  const fy = red ? FIELD - y : y;
  return { x: fx, y: FIELD - fy };
}

// field point from an SVG point
export function fromSvg(px: number, py: number, red: boolean): { x: number; y: number } {
  const fx = px;
  const fy = FIELD - py;
  return red ? { x: FIELD - fx, y: FIELD - fy } : { x: fx, y: fy };
}

// heading (field degrees, CCW) -> SVG rotation (degrees, clockwise because y is down)
export function svgAngle(headingDeg: number, red: boolean): number {
  return -(red ? headingDeg + 180 : headingDeg);
}

export function pointsAttr(samples: { x: number; y: number }[], red: boolean): string {
  return samples
    .map((s) => {
      const p = sx(s.x, s.y, red);
      return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    })
    .join(" ");
}

export type LegLook = "drive" | "intake" | "ramp" | "reposition" | "unsure";

// The look of a leg (PLAN section 14 route language): what it does while driving, review when the
// evidence conflicts, dashed when it only moves on to the next leg.
export function legLook(leg: Pick<Leg, "during" | "end" | "junction">): LegLook {
  if (leg.junction.review) return "unsure";
  if (leg.during === "RAMP") return "ramp";
  if (leg.during === "INTAKE") return "intake";
  return leg.end === "NONE" ? "reposition" : "drive";
}

export interface Chevron {
  x: number;
  y: number;
  rot: number;
}

// "IN" chevrons along an intake stretch, pointing the way the robot travels.
export function chevrons(samples: PathSample[], red: boolean, every = 7): Chevron[] {
  const out: Chevron[] = [];
  if (samples.length < 2) return out;
  const total = samples[samples.length - 1].s - samples[0].s;
  for (let d = every / 2; d < total; d += every) {
    const target = samples[0].s + d;
    let k = 0;
    while (k < samples.length - 1 && samples[k + 1].s < target) k++;
    const a = samples[k];
    const p = sx(a.x, a.y, red);
    out.push({ x: p.x, y: p.y, rot: svgAngle(a.tangentDeg, red) });
  }
  return out;
}

// The stretch of the next leg where the intake still runs (carryIntake seconds).
export function carryStretch(next: PathSample[] | undefined, carryS: number): PathSample[] {
  if (!next || carryS <= 0) return [];
  return next.filter((s) => s.timeS <= carryS + 1e-9);
}

export function midpoint(samples: PathSample[]): PathSample | null {
  if (!samples.length) return null;
  const half = samples[samples.length - 1].s / 2;
  return samples.find((s) => s.s >= half) ?? samples[samples.length - 1];
}

// Arc showing a sharp turn at a junction: from the incoming to the outgoing direction.
export function turnArc(cx: number, cy: number, inDeg: number, turnDeg: number, r: number, red: boolean): string {
  const c = sx(cx, cy, red);
  const a0 = svgAngle(inDeg, red) * DEG;
  const a1 = svgAngle(inDeg + turnDeg, red) * DEG;
  const p0 = { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) };
  const p1 = { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) };
  const large = Math.abs(turnDeg) > 180 ? 1 : 0;
  // SVG y is down: a CCW field turn is a counter-clockwise SVG sweep (sweep-flag 0), unless red-rotated (rotation keeps orientation)
  const sweep = turnDeg > 0 ? 0 : 1;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

// Shooting-zone annulus around a CELL: outer circle minus inner circle (even-odd fill).
export function annulus(cx: number, cy: number, rIn: number, rOut: number, red: boolean): string {
  const c = sx(cx, cy, red);
  const circ = (r: number) => `M ${c.x - r} ${c.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  return `${circ(rOut)} ${circ(rIn)}`;
}

export function rectAttrs(r: { x0: number; y0: number; x1: number; y1: number }, red: boolean) {
  const a = sx(r.x0, r.y0, red);
  const b = sx(r.x1, r.y1, red);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function fmtS(s: number): string {
  return `${s.toFixed(1)} s`;
}

export function fmtIn(v: number): string {
  return `${v.toFixed(1)} in`;
}

// Short one-line evidence for the junction list (the full tokens are in the tooltip).
export function evidenceLine(f: AutoFeatures, legId: string): string {
  const j = f.junctions.find((x) => x.id === legId);
  if (!j) return "";
  const parts: string[] = [];
  parts.push(`${j.moveIn.toFixed(1)} in move`);
  if (j.turnDeg !== null && Math.abs(j.turnDeg) >= 5) parts.push(`turn ${j.turnDeg > 0 ? "+" : ""}${j.turnDeg.toFixed(0)}°`);
  parts.push(j.zone.in ? `in zone (${j.target.backDistIn.toFixed(1)} in, edge ${j.zone.edgeIn.toFixed(1)} in)` : `out of zone: ${j.zone.reasons[0] ?? ""}`);
  parts.push(`turret ${j.target.turretCmdDeg.toFixed(0)}°${j.target.reachable ? "" : " UNREACHABLE"}`);
  const leg = f.legs[j.index];
  if (leg?.sweepable.length) parts.push(`sweeps ${leg.sweepable.length}`);
  if (j.shotInCode) parts.push("shot in code");
  if (j.dwellInCode?.carryIntakeS) parts.push(`carry ${j.dwellInCode.carryIntakeS} s`);
  return parts.join(" · ");
}
