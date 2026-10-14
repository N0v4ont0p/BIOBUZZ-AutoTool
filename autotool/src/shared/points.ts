// What an auto scores in AUTO, by the manual's Table 10-2 (BIOBUZZ point values, 10.5.4/10.5.5):
//   LEAVE 3      the robot no longer touches the perimeter wall at the end of AUTO
//   PARK 5       at least partially in the LOADING ZONE at the end of AUTO
//   HIVE TIP 20  POLLEN launched into the upward-facing CELL tips the HIVE (TIPs complete before TELEOP count
//                as AUTO); how many POLLEN tip it depends on the NECTAR in that CELL (the staged up-CELL holds 3
//                NECTAR, so 3 POLLEN; after a TIP the other CELL faces up, empty, and needs 8)
// POLLEN and NECTAR left in an upward-facing CELL score 2 each, but only at the end of the MATCH: shown as a
// note, never added to the AUTO total. Two robots of one alliance share the HIVE, so the alliance total
// merges both robots' shots in time.

import type { AutoFeatures } from "./features.ts";
import type { SeasonPack } from "./season.ts";

export interface Points {
  total: number;
  leave: number;
  park: number;
  tips: { atS: number; legId: string; robot: "us" | "partner" }[];
  tipPoints: number;
  perLeg: Record<string, number>; // what each of our legs adds
  inUpCell: number; // elements in the upward-facing CELL at the end of AUTO (2 each at the end of the MATCH, if still there)
  perSecond: number;
  notes: string[];
}

interface ShotEvent {
  atS: number;
  legId: string;
  robot: "us" | "partner";
  cell: "far" | "audience";
  pollen: number;
  nectar: number;
}

function endOfAutoS(f: AutoFeatures): number {
  return Math.min(f.timeline.abortAtS, f.timeline.autoS);
}

// The shots that leave the robot inside the shooting zone before AUTO ends.
function shots(f: AutoFeatures, robot: "us" | "partner", delayS: number): { list: ShotEvent[]; notes: string[] } {
  const list: ShotEvent[] = [];
  const notes: string[] = [];
  for (const j of f.junctions) {
    const s = j.shot;
    if (!s || s.pollen + s.nectar === 0) continue;
    const who = robot === "us" ? j.id : `partner ${j.id}`;
    if (!s.inZone) {
      notes.push(`${who}: the shot is outside the shooting zone, so it is not counted`);
      continue;
    }
    // match time: a partner that starts later still stops at the same abort time
    const atS = s.atS + delayS;
    if (atS > endOfAutoS(f)) {
      notes.push(`${who}: the shot comes after the end of AUTO`);
      continue;
    }
    list.push({ atS, legId: j.id, robot, cell: j.target.cell, pollen: s.pollen, nectar: s.nectar });
  }
  return { list, notes };
}

// LEAVE and PARK for one robot, by where its last leg that runs ends.
function robotEnd(f: AutoFeatures): { leave: boolean; park: boolean; legId: string | null } {
  const ran = f.legs.filter((l) => l.cut === "none");
  const last = ran.at(-1);
  const j = last ? f.junctions.find((x) => x.id === last.id) : undefined;
  // a cut leg leaves the robot somewhere along it: no PARK claimed; LEAVE still holds once it drove off
  const cut = f.legs.some((l) => l.cut !== "none");
  return { leave: f.leave, park: !!j && j.inLoadingZone && !cut, legId: last?.id ?? null };
}

export function autoPoints(pack: SeasonPack, ours: AutoFeatures, partner?: { features: AutoFeatures; delayS: number }): Points {
  const sc = pack.scoring;
  const notes: string[] = [];
  const perLeg: Record<string, number> = {};
  const add = (leg: string | null, v: number) => leg && (perLeg[leg] = (perLeg[leg] ?? 0) + v);

  const me = robotEnd(ours);
  let leave = me.leave ? sc.LEAVE.auto : 0;
  let park = me.park ? sc.PARK.auto : 0;
  add(me.legId, leave + park);
  if (!me.leave) notes.push("no LEAVE: the robot still touches the wall at the end of AUTO");
  if (!me.park) notes.push(ours.legs.some((l) => l.cut !== "none") ? "no PARK: the auto is cut before it ends" : "no PARK: the last stop is not in the LOADING ZONE");
  if (partner) {
    const p = robotEnd(partner.features);
    leave += p.leave ? sc.LEAVE.auto : 0;
    park += p.park ? sc.PARK.auto : 0;
  }

  // the HIVE: which CELL faces up, and what is in each
  const a = shots(ours, "us", 0);
  const b = partner ? shots(partner.features, "partner", partner.delayS) : { list: [], notes: [] };
  notes.push(...a.notes, ...b.notes);
  const all = [...a.list, ...b.list].sort((x, y) => x.atS - y.atS);
  let up: "far" | "audience" = pack.cells.upAtStart.BLUE;
  const nectar = { far: up === "far" ? 3 : 0, audience: up === "audience" ? 3 : 0 };
  const pollen = { far: 0, audience: 0 };
  const table = sc.tipPollenByNectar.table;
  const tips: Points["tips"] = [];
  const downNoted = new Set<string>();
  for (const s of all) {
    if (s.cell !== up) {
      const k = `${s.robot}:${s.legId}`;
      if (!downNoted.has(k)) notes.push(`${s.robot === "us" ? s.legId : `partner ${s.legId}`}: launches at the ${s.cell} CELL, which faces down then: it does not count`);
      downNoted.add(k);
      continue;
    }
    pollen[up] += s.pollen;
    nectar[up] += s.nectar;
    const need = table[Math.min(nectar[up], table.length - 1)];
    if (pollen[up] >= need) {
      tips.push({ atS: s.atS, legId: s.legId, robot: s.robot });
      if (s.robot === "us") add(s.legId, sc.HIVE_TIP.auto);
      // the HIVE turns over: the other CELL faces up, with what is in it (staged empty)
      up = up === "far" ? "audience" : "far";
    }
  }
  const tipPoints = tips.length * sc.HIVE_TIP.auto;
  const inUpCell = pollen[up] + nectar[up] - (up === pack.cells.upAtStart.BLUE && tips.length === 0 ? 3 : 0);
  if (!tips.length && all.some((s) => s.cell === pack.cells.upAtStart.BLUE)) notes.push(`no HIVE TIP: ${pollen[pack.cells.upAtStart.BLUE]} of ${table[3]} POLLEN reach the up-facing CELL in AUTO`);
  const total = leave + park + tipPoints;
  const endS = Math.max(Math.min(ours.timeline.nominalS, endOfAutoS(ours)), 0.1);
  return { total, leave, park, tips, tipPoints, perLeg, inUpCell: Math.max(0, inUpCell), perSecond: Math.round((total / endS) * 100) / 100, notes };
}
