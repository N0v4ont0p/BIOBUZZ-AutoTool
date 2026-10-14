// Field awareness for the model: a text map of the field (and the route on it), the near/far half,
// and a plain-words description of every stop. Everything comes from the season pack and the
// computed features; nothing here is a new measurement.

import type { AutoFeatures } from "./features.ts";
import type { Rect } from "./geometry.ts";
import type { SeasonPack } from "./season.ts";

// "Near" = the half of the field (split at y = 72) with the HIVE CELL that holds the NECTAR at the
// start (the staged up-CELL). Autos are drawn for BLUE; red is the 180-degree rotation, which keeps
// the same half, so one auto is Near or Far for both alliances.
export function nectarY(pack: SeasonPack): number {
  return pack.cells.BLUE[pack.cells.upAtStart.BLUE].y;
}
export function sideOf(y: number, pack: SeasonPack): "Near" | "Far" {
  return y >= 72 === nectarY(pack) >= 72 ? "Near" : "Far";
}

const COLS = 48; // 3 in per column
const ROWS = 24; // 6 in per row (text characters are about twice as tall as wide)
const SYMBOLS = "123456789abcdefghijklmnopqrstuvwxyz";

export function fieldMap(pack: SeasonPack, f?: AutoFeatures | null): string {
  const g: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill("."));
  const col = (x: number) => Math.min(COLS - 1, Math.max(0, Math.floor(x / 3)));
  const row = (y: number) => Math.min(ROWS - 1, Math.max(0, Math.floor((144 - y) / 6)));
  const put = (x: number, y: number, ch: string) => (g[row(y)][col(x)] = ch);
  const fill = (r: Rect, ch: string) => {
    for (let y = r.y0; y <= r.y1; y += 1) for (let x = r.x0; x <= r.x1; x += 1) put(x, y, ch);
  };
  for (let r = 0; r < ROWS; r++) g[r][col(72)] = ":";
  for (const a of ["BLUE", "RED"] as const) {
    fill(pack.loadingZone[a], a === "BLUE" ? "L" : "l");
    fill(pack.garden[a], a === "BLUE" ? "G" : "g");
  }
  for (const o of pack.obstacles) fill(o.rect, o.id.startsWith("hive") ? "H" : "F");
  for (const a of ["BLUE", "RED"] as const) {
    for (const which of ["far", "audience"] as const) {
      const c = pack.cells[a][which];
      put(c.x, c.y, pack.cells.upAtStart[a] === which ? "N" : "C");
    }
  }
  for (const e of pack.staged) if (e.access === "floor") put(e.x, e.y, "p");
  if (f?.drawable) {
    for (const leg of f.geometry) for (const s of leg.samples) if (g[row(s.y)][col(s.x)] !== "S") put(s.x, s.y, "*");
    const s0 = f.geometry[0]?.samples[0];
    if (s0) put(s0.x, s0.y, "S");
    f.junctions.forEach((j, i) => put(j.pose.x, j.pose.y, SYMBOLS[i] ?? "#"));
  }
  const lines = g.map((r, i) => `${String(Math.round(144 - i * 6)).padStart(3)} |${r.join("")}|`);
  const ticks = `     ${Array.from({ length: COLS }, (_, c) => (c % 8 === 0 ? String(c * 3).padEnd(8) : "")).join("")}`.trimEnd();
  return [
    "y (in)  far (rear) wall at y = 144",
    ...lines,
    `     ${"-".repeat(COLS)}`,
    `${ticks}   x (in)`,
    "x = 0 is the red ALLIANCE wall, x = 144 the blue ALLIANCE wall, y = 0 the audience wall. One character = 3 in wide x 6 in tall.",
    `Legend: ':' x = 72 (alliance line; BLUE side is x >= 72) | H HIVE frame bar (no-go) | N CELL holding NECTAR at the start | C other CELL | F FLOWER foot (no-go) | L/l blue/red LOADING ZONE | G/g blue/red GARDEN | p staged POLLEN${f?.drawable ? " | S start | 1-9,a-z junctions L1, L2, ... | * path" : ""}`,
  ].join("\n");
}

function headingWords(h: number): string {
  const d = ((h % 360) + 360) % 360;
  const dirs = ["+x (toward the blue wall)", "+x+y", "+y (toward the far wall)", "-x+y", "-x (toward the red side)", "-x-y", "-y (toward the audience wall)", "+x-y"];
  return dirs[Math.round(d / 45) % 8];
}

// One line per stop, in words, so the model can place it without doing arithmetic.
export function routeWords(pack: SeasonPack, f: AutoFeatures): string {
  if (!f.drawable) return "The route cannot be drawn yet (some poses are unset), so there is no geometry for it.";
  const out: string[] = [];
  const s0 = f.geometry[0]?.samples[0];
  if (s0) out.push(`start (${Math.round(s0.x * 10) / 10}, ${Math.round(s0.y * 10) / 10}) heading ${Math.round(s0.headingDeg)}: ${sideOf(s0.y, pack)} half; faces ${headingWords(s0.headingDeg)}.`);
  for (const j of f.junctions) {
    const where: string[] = [`${sideOf(j.pose.y, pack)} half`, j.pose.x >= 72 ? "own side" : "OPPONENT side"];
    if (j.inLoadingZone) where.push("in the LOADING ZONE");
    if (j.wallClearanceIn < 2) where.push("against a wall");
    if (j.onCluster) where.push("on staged elements");
    out.push(
      `${j.id} -> ${j.pose.name} (${j.pose.x}, ${j.pose.y}) heading ${j.pose.headingDeg}: ${where.join(", ")}; faces ${headingWords(j.pose.headingDeg)}; aims at the ${j.target.cell} CELL, bearing ${Math.round(j.target.bearingDeg)} deg, turret ${j.target.reachable ? "reaches" : "CANNOT reach"} it; ${j.zone.in ? "in the shooting zone" : `out of the shooting zone (${j.zone.reasons.join("; ")})`}.`,
    );
  }
  return out.join("\n");
}
