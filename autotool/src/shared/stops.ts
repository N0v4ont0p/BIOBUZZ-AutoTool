// What each leg should do, from the evidence (PLAN section 11), as code. Evidence comes first, then the
// leg's during and end, the same two fields the robot code has. Used three ways: the offline fallback when the
// AI is off, the optional candidate hint in the prompt (an ablation), and the oracle for synthetic evaluation.

import { type AutoFeatures, type JunctionFeatures, type LegFeatures, computeFeatures } from "./features.ts";
import { round } from "./geometry.ts";
import type { RobotModel } from "./profile.ts";
import type { SeasonPack, StagedElement } from "./season.ts";
import { type AutoSpec, type During, type End, cloneSpec, withStop } from "./spec.ts";

export interface StopDecision {
  junction: string; // leg id
  during: During;
  end: End;
  review: boolean; // the evidence conflicts: the team decides
  rule: string; // which row of the table decided
  evidence: string[]; // in protocol order: geometry, zone, inventory, decision
  suggestion?: string;
}

export const stopKey = (s: { during: During; end: End }) => `${s.during}/${s.end}`;
// What a leg does as one comparable value (evaluation): "INTAKE/SHOOT", or "review" when the team must decide.
export const legKey = (l: { during: During; end: End; junction?: { review?: boolean } }) => (l.junction?.review ? "review" : stopKey(l));

// First match per field wins. during and end are decided separately: a leg can collect on the way and shoot at the end.
export const RUBRIC = [
  { field: "end", value: "PARK", when: "it is the last leg and the footprint is at least partially in the LOADING ZONE" },
  { field: "end", value: "SHOOT", when: "it ends in the shooting zone, the turret can reach the CELL, and the robot holds at least 1 element on arrival (counting what this leg picks up)" },
  { field: "end", value: "WAIT", when: "only when the team asks for a hold at the end (to finish pulling elements in); give the seconds" },
  { field: "end", value: "NONE", when: "otherwise: the leg sets up the next one" },
  { field: "during", value: "INTAKE", when: "the leg runs over floor elements (or ends on a cluster) and the robot holds fewer than capacity when it starts" },
  { field: "during", value: "RAMP", when: "only when the team says the leg takes POLLEN from a FLOWER bottom (the field map cannot confirm it)" },
  { field: "during", value: "NONE", when: "otherwise" },
  { field: "review", value: "true", when: "the evidence conflicts (in the zone, holding elements, no shot in the code), or the last leg ends outside the LOADING ZONE" },
] as const;

export function evidenceFor(j: JunctionFeatures, leg: LegFeatures | undefined, m: RobotModel): string[] {
  const e: string[] = [];
  e.push(`move.in=${round(j.moveIn)}in`);
  if (j.turnDeg !== null) e.push(`turn=${round(j.turnDeg, 0)}deg`);
  e.push(j.zone.in ? `zone.in edge=${round(j.zone.edgeIn)}in` : `zone.out(${j.zone.reasons.join("; ")})`);
  e.push(`${j.target.cell}CELL dist=${round(j.target.backDistIn)}in turret=${round(j.target.turretCmdDeg, 0)}deg ${j.target.reachable ? "reachable" : "UNREACHABLE"}`);
  e.push(`inventory.legStart=${j.inventory.atLegStart} before=${j.inventory.before}${j.inventory.beforeConfirmed ? "" : "(unconfirmed)"}`);
  if (leg && leg.sweepable.length) e.push(`sweeps=${leg.sweepable.length}`);
  if (j.inventory.picked) e.push(`picked=${j.inventory.picked}`);
  if (j.shotInCode === true) e.push("shot.in.code");
  if (j.shotInCode === false) e.push(`code=${j.during}/${j.end}`);
  if (j.dwellInCode && j.dwellInCode.carryIntakeS > 0) e.push(`carry.code=${j.dwellInCode.carryIntakeS}s`);
  if (j.dwellInCode && j.dwellInCode.timeoutS !== null && j.dwellInCode.timeoutS < m.legTimeoutS) e.push(`timeout.code=${j.dwellInCode.timeoutS}s`);
  if (j.isLast) e.push(j.inLoadingZone ? "last park.in" : "last park.out");
  if (j.next?.intakes) e.push("next.intakes");
  return e;
}

export function decideStop(j: JunctionFeatures, leg: LegFeatures | undefined, m: RobotModel): StopDecision {
  const evidence = evidenceFor(j, leg, m);
  const sweeps = (leg?.sweepable.length ?? 0) > 0 || j.onCluster;
  // the ramp is the team's call (FLOWER bottoms are not in the field map): keep it when it is set
  const during: During = j.during === "RAMP" ? "RAMP" : sweeps && j.inventory.atLegStart < m.capacity ? "INTAKE" : "NONE";
  const holding = j.inventory.before > 0 || (during !== "NONE" && (leg?.sweepable.length ?? 0) > 0);
  const mk = (end: End, rule: string, review = false, suggestion?: string): StopDecision => ({
    junction: j.id,
    during,
    end,
    review,
    rule,
    evidence: [...evidence, `during=${during}`, `end=${end}`, ...(review ? ["review"] : [])],
    ...(suggestion ? { suggestion } : {}),
  });
  if (j.isLast && j.inLoadingZone) return mk("PARK", "1 last leg in the LOADING ZONE");
  if (j.zone.in && j.target.reachable && holding) {
    if (j.shotInCode === false) return mk(j.end, "8 conflict: zone + holding but no shot in the code", true, "possible missed shot");
    return mk("SHOOT", "2 zone + reachable + holding");
  }
  // a hold the team set is kept: the field map cannot tell how long pulling elements in takes
  if (j.end === "WAIT" && !j.isLast) return mk("WAIT", "3 the team's hold");
  if (j.isLast) return mk("NONE", "8 last leg outside the LOADING ZONE: no PARK points", true, "last stop outside the LOADING ZONE: no PARK points");
  return mk("NONE", during === "NONE" ? "4 sets up the next leg" : "5 collects on the way, sets up the next leg");
}

// Decides every leg in order, recomputing features after each (what a leg does changes the inventory for the
// legs after it). `only` = the leg ids to decide (others keep theirs).
export function autoStops(
  spec: AutoSpec,
  pack: SeasonPack,
  m: RobotModel,
  overlay?: StagedElement[],
  only?: Set<string>,
): { spec: AutoSpec; decisions: StopDecision[]; features: AutoFeatures } {
  let s = cloneSpec(spec);
  const decisions: StopDecision[] = [];
  let f = computeFeatures(s, pack, m, overlay);
  for (let i = 0; i < s.legs.length; i++) {
    const id = s.legs[i].id;
    if (only && !only.has(id)) continue;
    const j = f.junctions.find((x) => x.id === id);
    if (!j) continue;
    const d = decideStop(j, f.legs[i], m);
    decisions.push(d);
    s.legs[i] = withStop(s.legs[i], d.during, d.end, "ai", d.evidence, { ...(d.suggestion ? { note: d.suggestion } : {}), review: d.review });
    f = computeFeatures(s, pack, m, overlay);
  }
  return { spec: s, decisions, features: f };
}

// For imported autos: the code is the truth; this lists where the evidence disagrees with it.
export function codeChecks(spec: AutoSpec, f: AutoFeatures, m: RobotModel): { junction: string; code: string; rubric: string; suggestion: string }[] {
  const out: { junction: string; code: string; rubric: string; suggestion: string }[] = [];
  for (const j of f.junctions) {
    const d = decideStop(j, f.legs[j.index], m);
    if (d.review || d.end !== j.end) {
      out.push({ junction: j.id, code: stopKey(j), rubric: stopKey(d), suggestion: d.suggestion ?? `the evidence points to end ${d.end}` });
    }
  }
  void spec;
  return out;
}
