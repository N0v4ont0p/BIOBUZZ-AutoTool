import type { Rect, Vec } from "./geometry.ts";

export type Alliance = "BLUE" | "RED";

export interface StagedElement {
  id: string;
  type: "POLLEN" | "NECTAR";
  x: number;
  y: number;
  count?: number; // stacks (FLOWER) hold several
  where: string;
  access: "floor" | "flowerBottom";
  unconfirmed?: boolean; // added by the user, not from the pack
}

export interface SeasonPack {
  packVersion: number;
  season: string;
  manual: { title: string; version: string; liveAsOf: string; lastModified: string; url: string; teamUpdates: { id: string; date: string; affects: string }[] };
  frame: { sizeIn: number; tileIn: number; drawnFor: "BLUE"; redIs: string; visualizerNote: string };
  fieldImage: { file: string; spansIn: number };
  elements: Record<"POLLEN" | "NECTAR", { diameterIn: number }>;
  allianceSide: Record<Alliance, Rect>;
  loadingZone: Record<Alliance, Rect>;
  garden: Record<Alliance, Rect>;
  cells: Record<Alliance, { far: Vec; audience: Vec }> & { upAtStart: Record<Alliance, "far" | "audience">; openingIn: { w: number; zBottom: number; zTop: number } };
  flowers: { id: string; wall: string; x: number; y: number; nearest: Alliance; foot: Rect }[];
  obstacles: { id: string; name: string; rect: Rect; source: string }[];
  staged: StagedElement[];
  rules: {
    autoDurationS: number;
    maxControlled: { value: number; rule: string };
    preload: { POLLEN: number; rule: string };
    start: { rule: string; clauses: Record<string, string>; wallTouchTolIn: number };
    autoSide: { rule: string; text: string };
    flower: { rule: string; text: string };
    humanFeed: { rule: string; default: string; text: string };
    startConfig: { rule: string; cubeIn: number };
  };
  // Table 10-2 point values (AUTO column), and the POLLEN that tip a CELL by the NECTAR in it
  scoring: {
    LEAVE: { auto: number; text: string; source: string };
    PARK: { auto: number; teleop: number; text: string; source: string };
    HIVE_TIP: { auto: number; teleop: number; source: string };
    CELL_REMAINING?: { auto: number | null; endOfMatch: number; text: string; source: string };
    tipPollenByNectar: { table: number[]; text: string; source: string };
  };
}

export function validatePack(p: SeasonPack): string[] {
  const out: string[] = [];
  if (!p || typeof p !== "object") return ["pack is not an object"];
  if (!p.manual?.version) out.push("pack does not name the manual version it came from");
  if (p.frame?.sizeIn !== 144) out.push("pack frame size is not 144 in");
  const sc = p.scoring;
  if (!(sc?.LEAVE?.auto >= 0 && sc?.PARK?.auto >= 0 && sc?.HIVE_TIP?.auto >= 0)) out.push("pack scoring has no LEAVE / PARK / HIVE TIP AUTO points");
  if (!Array.isArray(sc?.tipPollenByNectar?.table) || sc.tipPollenByNectar.table.length < 4) out.push("pack scoring has no POLLEN-to-tip table");
  for (const a of ["BLUE", "RED"] as const) {
    if (!p.loadingZone?.[a]) out.push(`no ${a} loading zone`);
    if (!p.cells?.[a]?.far || !p.cells?.[a]?.audience) out.push(`no ${a} CELLs`);
  }
  // the layout must be a 180-degree rotation, never a mirror
  const s = p.frame?.sizeIn ?? 144;
  const rot = (v: Vec) => ({ x: s - v.x, y: s - v.y });
  const close = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  if (p.cells && !(close(rot(p.cells.RED.far), p.cells.BLUE.audience) && close(rot(p.cells.RED.audience), p.cells.BLUE.far))) {
    out.push("CELLs are not 180-degree rotations of each other");
  }
  const rr = (r: Rect) => ({ x0: s - r.x1, y0: s - r.y1, x1: s - r.x0, y1: s - r.y0 });
  const same = (a: Rect, b: Rect) => Math.abs(a.x0 - b.x0) + Math.abs(a.y0 - b.y0) + Math.abs(a.x1 - b.x1) + Math.abs(a.y1 - b.y1) < 0.01;
  if (p.loadingZone && !same(rr(p.loadingZone.RED), p.loadingZone.BLUE)) out.push("loading zones are not 180-degree rotations of each other");
  if (p.garden && !same(rr(p.garden.RED), p.garden.BLUE)) out.push("gardens are not 180-degree rotations of each other");
  return out;
}

export function rotate180(v: Vec, size = 144): Vec {
  return { x: size - v.x, y: size - v.y };
}

export function inRect(p: Vec, r: Rect, pad = 0): boolean {
  return p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.y >= r.y0 - pad && p.y <= r.y1 + pad;
}
