// Import a Pedro-Pathing visualizer project (.pp / JSON, src/utils/project.ts in the fork) as a drawn
// auto spec. The numbers are kept as drawn: they are what the robot drives to. Everything AutoRunner
// cannot represent is reported, never silently dropped.

import { DEG, angleErrorDeg, bezierDeriv, throughToBeziers, wrapDeg } from "./geometry.ts";
import { type AutoSpec, type HeadingDef, type Leg, type PoseDef, SPEC_VERSION, uniqueName } from "./spec.ts";

interface PpPoint {
  x: number;
  y: number;
  name?: string;
  heading?: string;
  startDeg?: number;
  endDeg?: number;
  degrees?: number;
  reverse?: boolean;
  headingDeg?: number;
}

interface PpHeading {
  type: "linear" | "constant" | "tangential" | "piecewise";
  startDeg?: number;
  endDeg?: number;
  degrees?: number;
  reverse?: boolean;
}

interface PpPath {
  id?: string;
  name?: string;
  kind?: "atomic" | "compound";
  endPoint?: PpPoint;
  controlPoints?: { x: number; y: number }[];
  throughPoints?: { x: number; y: number }[];
  segments?: PpPath[];
  heading?: PpHeading | string;
  waitBeforeMs?: number;
  waitAfterMs?: number;
  waitBefore?: { durationMs: number };
  waitAfter?: { durationMs: number };
}

interface PpProject {
  startPoint?: PpPoint;
  lines?: PpPath[];
  sequence?: ({ kind: "path"; lineId: string } | { kind: "wait"; durationMs: number; name?: string })[];
  version?: string;
}

function headingOf(p: PpPath): PpHeading {
  if (p.heading && typeof p.heading === "object") return p.heading;
  const e = p.endPoint ?? ({} as PpPoint);
  const legacy = typeof p.heading === "string" ? p.heading : e.heading;
  if (legacy === "linear") return { type: "linear", startDeg: e.startDeg ?? 0, endDeg: e.endDeg ?? 0 };
  if (legacy === "constant") return { type: "constant", degrees: e.degrees ?? 0 };
  if (legacy === "piecewise") return { type: "piecewise" };
  return { type: "tangential", reverse: !!e.reverse };
}

function safeName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? "")
    .replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[^A-Za-z]+/, "");
  const n = base ? base[0].toLowerCase() + base.slice(1) : fallback;
  return n.length > 40 ? n.slice(0, 40) : n;
}

export function importVisualizerProject(json: unknown, name = "drawn"): { spec?: AutoSpec; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const doc = json as PpProject;
  if (!doc || typeof doc !== "object" || !doc.startPoint || !Array.isArray(doc.lines)) return { warnings, errors: ["not a visualizer project: needs startPoint and lines"] };
  warnings.push("The stock visualizer draws on a 141.5 in field image; AutoTool draws on 144 in (the manual, the robot code). The numbers are kept exactly as drawn, so points near the far walls can look up to 2.5 in off on this field image.");
  // order: the sequence when present, else the lines
  const byId = new Map(doc.lines.map((l) => [l.id ?? "", l]));
  let ordered: PpPath[] = doc.lines;
  if (Array.isArray(doc.sequence) && doc.sequence.length) {
    ordered = [];
    for (const s of doc.sequence) {
      if (s.kind === "wait") warnings.push(`wait ${s.durationMs} ms${s.name ? ` (${s.name})` : ""} dropped: AutoRunner has no wait step (a SHOOT already holds the robot)`);
      else {
        const l = byId.get(s.lineId);
        if (l) ordered.push(l);
        else errors.push(`sequence names a path that is not in the file (${s.lineId})`);
      }
    }
  }
  const flat: PpPath[] = [];
  for (const l of ordered) {
    if (l.kind === "compound" || Array.isArray(l.segments)) {
      warnings.push(`group "${l.name ?? l.id ?? "?"}" split into ${l.segments?.length ?? 0} legs: AutoRunner follows one path per leg`);
      for (const s of l.segments ?? []) flat.push(s);
    } else flat.push(l);
    if (l.waitBeforeMs || l.waitAfterMs || l.waitBefore || l.waitAfter) warnings.push(`waits on "${l.name ?? l.id ?? "?"}" not carried over: set "At the end: Wait" on that leg`);
  }
  const sp = doc.startPoint;
  const startHeading = typeof sp.headingDeg === "number" ? sp.headingDeg : (sp.startDeg ?? sp.degrees ?? 0);
  const poses: PoseDef[] = [{ name: "start", x: sp.x, y: sp.y, headingDeg: wrapDeg(startHeading), role: "waypoint", redTrim: [0, 0, 0] }];
  const taken = new Set(["start"]);
  const legs: Leg[] = [];
  const methods = new Set<string>();
  let prev = poses[0];
  flat.forEach((l, i) => {
    if (!l.endPoint) {
      errors.push(`path ${i + 1} has no end point`);
      return;
    }
    const h = headingOf(l);
    const endName = uniqueName(safeName(l.endPoint.name ?? l.name, `p${i + 1}`), taken);
    taken.add(endName);
    const controls: PoseDef[] = (l.controlPoints ?? []).map((c, k) => {
      const n = uniqueName(`${endName}Control${k + 1}`, taken);
      taken.add(n);
      return { name: n, x: c.x, y: c.y, headingDeg: 0, role: "control", redTrim: [0, 0, 0] };
    });
    const via = (l.throughPoints ?? []).map((c, k) => {
      const n = uniqueName(`${endName}Via${k + 1}`, taken);
      taken.add(n);
      return { name: n, x: c.x, y: c.y, headingDeg: 0, role: "waypoint" as const, redTrim: [0, 0, 0] as [number, number, number] };
    });
    // end heading, so the next leg starts where this one ends
    let endDeg = prev.headingDeg ?? 0;
    let heading: HeadingDef;
    const pts = [{ x: prev.x!, y: prev.y! }, ...(via.length ? via : controls).map((c) => ({ x: c.x!, y: c.y! })), { x: l.endPoint.x, y: l.endPoint.y }];
    const pieces = via.length ? throughToBeziers(pts) : [pts];
    const lastPiece = pieces[pieces.length - 1];
    const d = bezierDeriv(lastPiece, 1);
    const tangentEnd = Math.atan2(d.y, d.x) / DEG;
    switch (h.type) {
      case "linear":
        endDeg = h.endDeg ?? 0;
        if (Math.abs(angleErrorDeg(prev.headingDeg ?? 0, h.startDeg ?? 0)) > 0.5) {
          warnings.push(`path ${i + 1} was drawn turning from ${h.startDeg} deg, but the robot arrives at ${prev.headingDeg} deg: AutoRunner turns from where the robot is`);
        }
        heading = { mode: "linear", from: prev.name, to: endName };
        break;
      case "constant":
        endDeg = h.degrees ?? 0;
        heading = { mode: "constant", pose: endName };
        if (Math.abs(angleErrorDeg(prev.headingDeg ?? 0, endDeg)) > 0.5) warnings.push(`path ${i + 1} holds ${endDeg} deg but the robot arrives at ${prev.headingDeg} deg: it snaps to ${endDeg} deg at the start`);
        break;
      case "tangential":
        endDeg = wrapDeg(tangentEnd + (h.reverse ? 180 : 0));
        heading = { mode: h.reverse ? "reverseTangent" : "tangent" };
        break;
      default:
        errors.push(`path ${i + 1} uses a piecewise heading, which the AutoRunner adapter cannot write`);
        heading = { mode: "linear", from: prev.name, to: endName };
    }
    const end: PoseDef = { name: endName, x: l.endPoint.x, y: l.endPoint.y, headingDeg: Math.round(endDeg * 100) / 100, role: "waypoint", redTrim: [0, 0, 0] };
    poses.push(...controls, ...via, end);
    const method = uniqueName(`${prev.name}To${endName[0].toUpperCase()}${endName.slice(1)}`, methods);
    methods.add(method);
    legs.push({
      id: `L${legs.length + 1}`,
      method,
      path: via.length ? { type: "through", from: prev.name, via: via.map((v) => v.name), to: endName } : controls.length ? { type: "curve", from: prev.name, controls: controls.map((c) => c.name), to: endName } : { type: "line", from: prev.name, to: endName },
      heading,
      during: "NONE",
      end: "NONE",
      carryIntakeS: 0,
      legTimeoutS: null,
      junction: { source: "none", evidence: [] },
    });
    prev = end;
  });
  if (!legs.length) errors.push("the project has no paths");
  if (errors.length) return { warnings, errors };
  return {
    spec: { specVersion: SPEC_VERSION, name, drawnFor: "BLUE", start: "start", preload: { POLLEN: 4, NECTAR: 0, onTiles: 0 }, poses, legs, opaque: [] },
    warnings,
    errors,
  };
}
