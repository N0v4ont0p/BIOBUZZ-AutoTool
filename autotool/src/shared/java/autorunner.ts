// The v1 code adapter: the robot repo's AutoRunner leg API (opmodes/AutoPaths.java).
//   parseAutoPaths: Java -> spec. Legs must be fully readable; every other member the spec does not
//                   model is kept verbatim as an opaque block. Fails (with lines) rather than guessing.
//   renderAutoPaths: spec -> Java. Members whose code did not change are written back byte for byte.
//   importAutoPaths: parse + render + equivalence check (the round trip test run on every import).

import { ACTIONS, type AutoSpec, migrateSpec, DURINGS, type During, ENDS, type End, type HeadingDef, type JavaShape, type Leg, type PathGeom, type PoseDef, SPEC_VERSION } from "../spec.ts";
import { type Expr, dotted, evalNumber, isLiteral, parseExpr, sourceOf } from "./expr.ts";
import { JavaSyntaxError, type Member, type Tok, code, equivalentJava, lex, normalizedText, parseFile } from "./lexer.ts";

export const AUTOS_PACKAGE = "org.firstinspires.ftc.teamcode.opmodes";
export const DEFAULT_FACTORY = "private final PoseFactory poseFactory = MatchState.poseFactory();";

// The helper the robot repo's placeholder AutoPaths ships with (kept verbatim when present).
export const DEFAULT_REDTRIM = `// Red-only field correction (in, deg) added after the 180-degree rotation, for differences between the
    // two halves of a real field found in practice. A rotation keeps the robot's motion identical, so
    // expect these to stay near 0. Blue ignores them.
    private static Pose redTrim(Pose pose, double dx, double dy, double dHeadingDeg) {
        if (MatchState.alliance != MatchState.Alliance.RED) return pose;
        return new Pose(pose.x() + dx, pose.y() + dy, pose.heading() + Math.toRadians(dHeadingDeg));
    }`;

export interface ImportIssue {
  line: number;
  message: string;
}

export type ImportResult =
  | { ok: true; spec: AutoSpec; warnings: ImportIssue[]; rendered: string }
  | { ok: false; errors: ImportIssue[]; warnings: ImportIssue[] };

function memberTokens(m: Member): Tok[] {
  return code(m.toks);
}

function bodyTokens(m: Member): Tok[] {
  // tokens between the method's outer braces
  const t = m.toks;
  let i = 0;
  let paren = 0;
  for (; i < t.length; i++) {
    if (t[i].text === "(") paren++;
    else if (t[i].text === ")") paren--;
    else if (t[i].text === "{" && paren === 0) break;
  }
  return t.slice(i + 1, t.length - 1);
}

function returnExpr(m: Member): Tok[] | null {
  const body = bodyTokens(m);
  const c = code(body);
  if (c.length < 3 || c[0].text !== "return" || c[c.length - 1].text !== ";") return null;
  const first = body.indexOf(c[0]);
  const last = body.lastIndexOf(c[c.length - 1]);
  return body.slice(first + 1, last);
}

function signature(m: Member): string[] {
  const c = memberTokens(m);
  const pi = c.findIndex((t) => t.text === "(");
  return c.slice(0, pi + 1).map((t) => t.text);
}

function noParams(m: Member): boolean {
  const c = memberTokens(m);
  const pi = c.findIndex((t) => t.text === "(");
  return c[pi + 1]?.text === ")";
}

function fmtNum(v: number, decimals = 3): string {
  if (Number.isInteger(v)) return v.toFixed(1);
  return String(Number(v.toFixed(decimals)));
}

// --- import -----------------------------------------------------------------------------------

interface ParsedPath {
  path: PathGeom;
  heading: HeadingDef;
  line: number;
}

function parsePathExpr(e: Expr, src: string, poses: Set<string>): ParsedPath | string {
  // Paths.<type>(poses...).<heading>(...)
  if (e.k !== "call") return "not a Paths call";
  const headingCall = e;
  const base = headingCall.callee;
  if (base.k !== "call" || dotted(base.callee) !== "Paths") return `expected Paths.line/curve/through(...).<heading>(...), found ${sourceOf(src, e)}`;
  const names = base.args.map((a) => (a.k === "name" && a.parts.length === 1 ? a.parts[0] : null));
  if (names.some((n) => n === null)) return `path points must be pose fields: ${sourceOf(src, base)}`;
  for (const n of names) if (!poses.has(n!)) return `"${n}" is not a pose field the tool can read`;
  const ns = names as string[];
  let path: PathGeom;
  switch (base.name) {
    case "line":
      if (ns.length !== 2) return "Paths.line needs 2 poses";
      path = { type: "line", from: ns[0], to: ns[1] };
      break;
    case "curve":
      if (ns.length < 3) return "Paths.curve needs at least 3 poses";
      path = { type: "curve", from: ns[0], controls: ns.slice(1, -1), to: ns[ns.length - 1] };
      break;
    case "through":
      if (ns.length < 3) return "Paths.through needs at least 3 poses";
      path = { type: "through", from: ns[0], via: ns.slice(1, -1), to: ns[ns.length - 1] };
      break;
    default:
      return `Paths.${base.name} is not supported (line, curve, through)`;
  }
  const hargs = headingCall.args.map((a) => (a.k === "name" && a.parts.length === 1 ? a.parts[0] : null));
  let heading: HeadingDef;
  switch (headingCall.name) {
    case "linear":
      if (hargs.length !== 2 || hargs.some((h) => !h || !poses.has(h))) return `linear(...) must take two pose fields: ${sourceOf(src, e)}`;
      heading = { mode: "linear", from: hargs[0]!, to: hargs[1]! };
      break;
    case "constant":
      if (hargs.length !== 1 || !hargs[0] || !poses.has(hargs[0])) return `constant(...) must take one pose field: ${sourceOf(src, e)}`;
      heading = { mode: "constant", pose: hargs[0] };
      break;
    case "tangent":
      if (hargs.length) return "tangent() takes no arguments";
      heading = { mode: "tangent" };
      break;
    case "reverseTangent":
      if (hargs.length) return "reverseTangent() takes no arguments";
      heading = { mode: "reverseTangent" };
      break;
    case "facingPoint":
      if (hargs.length !== 1 || !hargs[0] || !poses.has(hargs[0])) return `facingPoint(...) must take one pose field: ${sourceOf(src, e)}`;
      heading = { mode: "facingPoint", pose: hargs[0] };
      break;
    default:
      return `heading .${headingCall.name}(...) is not supported`;
  }
  return { path, heading, line: 0 };
}

function parsePoseInit(e: Expr, src: string, symbols: Map<string, number | null>): Omit<PoseDef, "name" | "role"> | string {
  let inner = e;
  let redTrim: [number, number, number] | undefined;
  if (e.k === "call" && e.name === "redTrim" && e.callee.k === "other") {
    if (e.args.length !== 4) return "redTrim needs 4 arguments";
    const trims = e.args.slice(1).map((a) => evalNumber(a, new Map()));
    if (trims.some((v) => typeof v !== "number")) return "redTrim offsets must be numbers";
    redTrim = trims as [number, number, number];
    inner = e.args[0];
  }
  if (inner.k !== "call" || inner.name !== "of" || dotted(inner.callee) !== "poseFactory") return `expected poseFactory.of(x, y, heading), found ${sourceOf(src, inner)}`;
  if (inner.args.length !== 3) return "poseFactory.of needs x, y, heading";
  const vals: (number | null)[] = [];
  const expr: { x?: string; y?: string; h?: string } = {};
  const keys = ["x", "y", "h"] as const;
  for (let i = 0; i < 3; i++) {
    const a = inner.args[i];
    const v = evalNumber(a, symbols);
    if (v === undefined) return `cannot read ${sourceOf(src, a)}`;
    vals.push(v);
    if (!isLiteral(a)) expr[keys[i]] = sourceOf(src, a);
  }
  return { x: vals[0], y: vals[1], headingDeg: vals[2], ...(Object.keys(expr).length ? { expr } : {}), ...(redTrim ? { redTrim } : {}) };
}

function commentText(toks: Tok[]): string {
  return toks
    .filter((t) => t.kind === "comment")
    .map((t) => t.text)
    .join("\n");
}

// roundTrip false: the caller checks the round trip itself (an AutoTool route region).
export function parseAutoPaths(src: string, symbols: Map<string, number | null>, file = "AutoPaths.java", roundTrip = true): ImportResult {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  let f;
  try {
    f = parseFile(src);
  } catch (e) {
    const err = e as JavaSyntaxError;
    return { ok: false, errors: [{ line: err.line ?? 0, message: err.message }], warnings };
  }
  // the default route class (AutoPaths, or the team's name for it), or an AutoTool auto's nested Plan
  const isRoute = f.className === "Plan";

  const order: string[] = [];
  const originals: JavaShape["originals"] = {};
  const opaque: AutoSpec["opaque"] = [];
  const poses: PoseDef[] = [];
  const poseLines = new Map<string, number>();
  const poseErrors = new Map<string, string>();
  const pathMethods = new Map<string, { parsed: ParsedPath | string; member: Member; key: string }>();
  let factory = DEFAULT_FACTORY;
  let redTrimHelper: string | undefined;
  let readyMember: Member | undefined;
  let startName: string | null = null;
  let legsMember: Member | undefined;
  let intakeAlways = false;

  const blankBefore = (m: Member) => {
    const ws = m.leading.filter((t) => t.kind === "ws").map((t) => t.text).join("");
    return (ws.match(/\n/g) ?? []).length >= 2;
  };
  const keep = (key: string, m: Member) => {
    order.push(key);
    originals[key] = { text: m.text, leading: m.leadingText, norm: normalizedText(m.toks), blankBefore: blankBefore(m) };
  };
  const toOpaque = (m: Member, why: string) => {
    const key = `opaque:${opaque.length}`;
    opaque.push({ anchor: key, code: (m.leadingText ? `${m.leadingText}\n    ` : "") + m.text, why });
    keep(key, m);
  };

  // pass 1: poses (paths reference them)
  for (const m of f.members) {
    const c = memberTokens(m);
    if (m.kind === "field" && c.some((t) => t.text === "Pose") && c[c.indexOf(c.find((t) => t.text === "Pose")!) + 1]?.text === m.name) {
      const eq = m.toks.findIndex((t) => t.text === "=");
      if (eq < 0) continue;
      const exprToks = m.toks.slice(eq + 1, m.toks.length - 1);
      try {
        const r = parsePoseInit(parseExpr(exprToks), src, symbols);
        if (typeof r === "string") poseErrors.set(m.name, r);
        else {
          poses.push({ name: m.name, ...r, role: "waypoint", ...(m.leadingText ? { comment: m.leadingText } : {}) });
          poseLines.set(m.name, m.line);
        }
      } catch (e) {
        poseErrors.set(m.name, (e as Error).message);
      }
    }
  }
  const poseNames = new Set(poses.map((p) => p.name));

  // pass 2: classify every member
  for (const m of f.members) {
    const sig = signature(m);
    if (m.kind === "field" && m.name === "poseFactory") {
      factory = m.text;
      keep("factory", m);
      if (normalizedText(m.toks) !== normalizedText(lex(DEFAULT_FACTORY))) {
        warnings.push({ line: m.line, message: "poseFactory is not MatchState.poseFactory(): the code will not rotate the auto for red" });
      }
    } else if (m.kind === "field" && poseNames.has(m.name)) {
      keep(`pose:${m.name}`, m);
    } else if (m.kind === "method" && ((m.name === "ready" && sig.includes("static")) || (m.name === "isReady" && isRoute && !sig.includes("static"))) && sig.includes("boolean") && noParams(m)) {
      readyMember = m;
      keep("method:ready", m);
    } else if (m.kind === "method" && m.name === "redTrim" && sig.includes("Pose")) {
      redTrimHelper = (m.leadingText ? `${m.leadingText.split("\n").join("\n    ")}\n    ` : "") + m.text;
      keep("method:redTrim", m);
    } else if (m.kind === "method" && m.name === "start" && sig.includes("Pose") && noParams(m)) {
      const r = returnExpr(m);
      const rc = r ? code(r) : [];
      if (rc.length === 1 && rc[0].kind === "ident") {
        startName = rc[0].text;
        keep("method:start", m);
      } else errors.push({ line: m.line, message: "start() must return a pose field" });
    } else if (m.kind === "method" && m.name === "legs" && noParams(m)) {
      legsMember = m;
      keep("method:legs", m);
    } else if (m.kind === "method" && m.name === "intakeAlways" && sig.includes("boolean") && noParams(m) && /return\s+(true|false)\s*;/.test(m.text)) {
      // AutoRunner.Route.intakeAlways(): persistent intake for the whole auto
      intakeAlways = /return\s+true\s*;/.test(m.text);
      keep("method:intakeAlways", m);
    } else if (m.kind === "method" && sig.includes("Path") && noParams(m) && !sig.includes("static")) {
      const r = returnExpr(m);
      let parsed: ParsedPath | string;
      try {
        parsed = r ? parsePathExpr(parseExpr(r), src, poseNames) : "body is not a single return";
      } catch (e) {
        parsed = (e as Error).message;
      }
      if (typeof parsed !== "string") parsed.line = m.line;
      const key = `path:${m.name}`;
      pathMethods.set(m.name, { parsed, member: m, key });
      order.push(key); // placeholder; finalised after the legs are read
    } else {
      toOpaque(m, m.kind === "field" && poseErrors.has(m.name) ? `pose the tool cannot read: ${poseErrors.get(m.name)}` : "not part of the AutoRunner leg format");
    }
  }

  if (!startName) errors.push({ line: 1, message: "no start() method returning a pose" });
  else if (!poseNames.has(startName)) errors.push({ line: 1, message: `start() returns "${startName}", which is not a pose the tool can read${poseErrors.has(startName) ? `: ${poseErrors.get(startName)}` : ""}` });
  if (!legsMember) errors.push({ line: 1, message: "no legs() method" });

  // legs
  const legs: Leg[] = [];
  const usedMethods = new Set<string>();
  let legNew = "AutoRunner.Leg";
  let enumPrefix = "AutoRunner.";
  let legForm: JavaShape["legForm"] = "during";
  let listCall = "Arrays.asList";
  if (legsMember) {
    const r = returnExpr(legsMember);
    try {
      if (!r) throw new JavaSyntaxError("legs() must be a single return of Arrays.asList(...) or List.of(...)", legsMember.line);
      const e = parseExpr(r);
      if (e.k !== "call" || !((dotted(e.callee) === "Arrays" && e.name === "asList") || (dotted(e.callee) === "List" && e.name === "of"))) {
        throw new JavaSyntaxError("legs() must return Arrays.asList(...) or List.of(...)", legsMember.line);
      }
      listCall = `${dotted(e.callee)}.${e.name}`;
      // comments right before each entry become that leg's comment
      const rtoks = r;
      e.args.forEach((arg, idx) => {
        const line = lineOf(src, arg.a);
        let a = arg;
        const chain: { name: string; value: number | string }[] = [];
        while (a.k === "call" && LEG_OPTIONS.includes(a.name)) {
          const v = a.args.length === 1 ? evalNumber(a.args[0], new Map()) : undefined;
          if (typeof v !== "number") throw new JavaSyntaxError(`.${a.name}(...) needs a number`, line);
          chain.unshift({ name: a.name, value: v });
          a = a.callee;
        }
        if (a.k !== "new" || !(a.type === "AutoRunner.Leg" || a.type === "Leg")) throw new JavaSyntaxError(`leg ${idx + 1} is not new AutoRunner.Leg(...): ${sourceOf(src, a)}`, line);
        // new Leg(p, During.X, End.Y), or the older shortcut new Leg(p, Action.X)
        const enumArg = (e: Expr | undefined, type: string, names: readonly string[]): string | null => {
          const d = e ? dotted(e) : null;
          const v = d?.split(".").pop();
          if (!d || !v || !names.includes(v) || !(d === `${type}.${v}` || d === `AutoRunner.${type}.${v}`)) return null;
          enumPrefix = d.startsWith("AutoRunner.") ? "AutoRunner." : "";
          return v;
        };
        let during: During;
        let end: End;
        if (a.args.length === 3) {
          const d = enumArg(a.args[1], "During", DURINGS);
          const en = enumArg(a.args[2], "End", ENDS);
          if (!d || !en) throw new JavaSyntaxError(`leg ${idx + 1}: new Leg(path, During.NONE/INTAKE/RAMP, End.NONE/SHOOT/PARK/WAIT)`, line);
          during = d as During;
          end = en as End;
        } else if (a.args.length === 2) {
          const act = enumArg(a.args[1], "Action", Object.keys(ACTIONS));
          if (!act) throw new JavaSyntaxError(`leg ${idx + 1}: new Leg(path, During..., End...) or the shortcut new Leg(path, Action.NONE/INTAKE/RAMP/SHOOT/PARK)`, line);
          ({ during, end } = ACTIONS[act]);
          legForm = "action";
        } else throw new JavaSyntaxError(`leg ${idx + 1}: AutoRunner.Leg takes (path or pose, During, End)`, line);
        const target = a.args[0];
        let path: PathGeom;
        let heading: HeadingDef;
        let method: string | undefined;
        let inline = false;
        if (target.k === "call" && target.callee.k === "other" && target.args.length === 0) {
          method = target.name;
          const pm = pathMethods.get(method);
          if (!pm) throw new JavaSyntaxError(`leg ${idx + 1} calls ${method}(), which is not a Path method in this file`, line);
          if (typeof pm.parsed === "string") throw new JavaSyntaxError(`leg ${idx + 1} uses ${method}(): ${pm.parsed}`, pm.member.line);
          if (usedMethods.has(method)) throw new JavaSyntaxError(`leg ${idx + 1} reuses ${method}(): the tool needs one path method per leg`, line);
          usedMethods.add(method);
          path = pm.parsed.path;
          heading = pm.parsed.heading;
        } else if (target.k === "name" && target.parts.length === 1) {
          if (!poseNames.has(target.parts[0])) throw new JavaSyntaxError(`leg ${idx + 1} drives to "${target.parts[0]}", which is not a pose the tool can read`, line);
          path = { type: "toPoint", to: target.parts[0] };
          heading = { mode: "toTarget" };
        } else {
          const pp = parsePathExpr(target, src, poseNames);
          if (typeof pp === "string") throw new JavaSyntaxError(`leg ${idx + 1}: ${pp}`, line);
          path = pp.path;
          heading = pp.heading;
          inline = true;
        }
        if (new Set(chain.map((c) => c.name)).size !== chain.length) throw new JavaSyntaxError(`leg ${idx + 1} sets the same option twice`, line);
        const opt = (n: string) => chain.find((c) => c.name === n)?.value;
        const timeout = (opt("timeout") as number | undefined) ?? null;
        const carry = (opt("carryIntake") as number | undefined) ?? 0;
        const leg: Leg = {
          id: `L${idx + 1}`,
          ...(method ? { method } : {}),
          ...(inline ? { inline } : {}),
          path,
          heading,
          during,
          end,
          legTimeoutS: timeout,
          carryIntakeS: carry,
          ...(opt("shotTimeout") !== undefined ? { shotTimeoutS: opt("shotTimeout") as number } : {}),
          ...(opt("waitFor") !== undefined ? { waitS: opt("waitFor") as number } : {}),
          ...(opt("carryRamp") !== undefined ? { carryRampS: opt("carryRamp") as number } : {}),
          junction: { source: "imported", evidence: [`code=${during}/${end}`] },
        };
        // keep the code's own order only when it differs from AutoTool's
        const written = chain.map((c) => c.name);
        if (written.join() !== LEG_OPTIONS.filter((o) => written.includes(o)).join()) leg.optOrder = written;
        legNew = a.type;
        const cmt = commentBefore(rtoks, arg.a, idx === 0 ? null : e.args[idx - 1].b);
        if (cmt) leg.comment = cmt;
        legs.push(leg);
      });
    } catch (err) {
      const e = err as JavaSyntaxError;
      errors.push({ line: e.line ?? legsMember.line, message: e.message });
    }
  }
  // path methods no leg uses are kept verbatim
  for (const [name, pm] of pathMethods) {
    const idx = order.indexOf(pm.key);
    if (usedMethods.has(name)) {
      originals[pm.key] = { text: pm.member.text, leading: pm.member.leadingText, norm: normalizedText(pm.member.toks), blankBefore: blankBefore(pm.member) };
    } else {
      const key = `opaque:${opaque.length}`;
      opaque.push({ anchor: key, code: (pm.member.leadingText ? `${pm.member.leadingText}\n    ` : "") + pm.member.text, why: typeof pm.parsed === "string" ? `path method no leg uses (${pm.parsed})` : "path method no leg uses" });
      order[idx] = key;
      originals[key] = { text: pm.member.text, leading: pm.member.leadingText, norm: normalizedText(pm.member.toks), blankBefore: blankBefore(pm.member) };
    }
  }
  // control points: poses used only as curve controls
  const asWaypoint = new Set<string>();
  if (startName) asWaypoint.add(startName);
  for (const l of legs) {
    if (l.path.type !== "toPoint") asWaypoint.add(l.path.from);
    asWaypoint.add(l.path.to);
    if (l.path.type === "through") l.path.via.forEach((v) => asWaypoint.add(v));
    if ("pose" in l.heading) asWaypoint.add(l.heading.pose);
    if (l.heading.mode === "linear") {
      asWaypoint.add(l.heading.from);
      asWaypoint.add(l.heading.to);
    }
  }
  for (const p of poses) {
    const isControl = legs.some((l) => l.path.type === "curve" && l.path.controls.includes(p.name));
    if (isControl && !asWaypoint.has(p.name)) p.role = "control";
  }

  if (errors.length) return { ok: false, errors, warnings };

  const header = src.slice(0, f.header.length ? f.header[f.header.length - 1].start + 1 : 0).replace(/^\s+/, "");
  const java: JavaShape = {
    packageName: f.packageName,
    imports: f.imports,
    headerText: header,
    classDecl: f.classDecl.filter((t) => t.kind !== "comment").map((t) => t.text).join("").trim(),
    factory,
    ...(redTrimHelper ? { redTrimHelper } : {}),
    order,
    originals,
    trailing: commentText(f.trailing),
    after: f.after,
    legNew,
    enumPrefix,
    legForm,
    listCall,
    ...(isRoute ? { route: true } : {}),
  };
  const spec: AutoSpec = {
    specVersion: SPEC_VERSION,
    name: isRoute ? (/AutoTool auto: (\S+)/.exec(f.classDoc)?.[1] ?? f.className.replace(/^Auto|Paths$/g, "")) : "AutoPaths",
    drawnFor: "BLUE",
    ...(f.classDoc ? { javadoc: f.classDoc } : {}),
    start: startName!,
    ...(intakeAlways ? { intakeAlways: true } : {}),
    preload: { POLLEN: 4, NECTAR: 0, onTiles: 0 },
    poses,
    legs,
    opaque,
    source: { file, hash: "" },
    java,
  };
  if (readyMember) {
    const derived = renderReady(spec);
    if (normalizedText(lex(derived)) !== normalizedText(readyMember.toks)) java.readyCustom = readyMember.text;
  }
  const rendered = roundTrip ? renderAutoPaths(spec) : "";
  const eq = roundTrip ? equivalentJava(src, rendered) : { equal: true, why: [] };
  if (!eq.equal) {
    return { ok: false, errors: [{ line: 1, message: `round trip failed (the importer is wrong for this file): ${eq.why.join("; ")}` }], warnings };
  }
  for (const [name, why] of poseErrors) warnings.push({ line: poseLines.get(name) ?? 1, message: `pose field ${name} kept as code: ${why}` });
  for (const o of opaque) warnings.push({ line: 1, message: `kept unchanged: ${o.why}` });
  return { ok: true, spec, warnings, rendered };
}

function lineOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

function commentBefore(toks: Tok[], argStart: number, prevEnd: number | null): string | undefined {
  const cs = toks.filter((t) => t.kind === "comment" && t.start < argStart && (prevEnd === null || t.start >= prevEnd));
  return cs.length ? cs.map((t) => t.text).join("\n") : undefined;
}

// --- render -----------------------------------------------------------------------------------

function tunedRefs(spec: AutoSpec): string[] {
  const out: string[] = [];
  for (const p of spec.poses) {
    for (const k of ["x", "y", "h"] as const) {
      const e = p.expr?.[k];
      if (!e) continue;
      for (const m of e.matchAll(/\bTuned\.[A-Za-z_$][A-Za-z0-9_$]*/g)) if (!out.includes(m[0])) out.push(m[0]);
    }
  }
  return out;
}

export function renderReady(spec: AutoSpec, instance = !!spec.java?.route): string {
  const refs = tunedRefs(spec);
  const head = instance ? "public boolean isReady() {" : "public static boolean ready() {";
  if (!refs.length) return `${head}\n        return true;\n    }`;
  const lines: string[] = [];
  let line = "";
  for (const r of refs) {
    const piece = line ? `, ${r}` : r;
    if (line && (line + piece).length > 90) {
      lines.push(line + ",");
      line = r;
    } else line += piece;
  }
  lines.push(line);
  return `${head}\n        return Tuned.isSet(${lines.join("\n                ")});\n    }`;
}

function poseArg(p: PoseDef, k: "x" | "y" | "h"): string {
  const e = p.expr?.[k];
  if (e) return e;
  const v = k === "x" ? p.x : k === "y" ? p.y : p.headingDeg;
  return fmtNum(v ?? 0);
}

export function renderPose(p: PoseDef): string {
  const of = `poseFactory.of(${poseArg(p, "x")}, ${poseArg(p, "y")}, ${poseArg(p, "h")})`;
  const init = p.redTrim ? `redTrim(${of}, ${p.redTrim.map((n) => (Number.isInteger(n) ? String(n) : fmtNum(n))).join(", ")})` : of;
  return `private final Pose ${p.name} = ${init};`;
}

export function renderPathExpr(leg: Leg): string {
  const p = leg.path;
  let base: string;
  switch (p.type) {
    case "line":
      base = `Paths.line(${p.from}, ${p.to})`;
      break;
    case "curve":
      base = `Paths.curve(${[p.from, ...p.controls, p.to].join(", ")})`;
      break;
    case "through":
      base = `Paths.through(${[p.from, ...p.via, p.to].join(", ")})`;
      break;
    case "toPoint":
      throw new Error("toPoint legs have no path expression");
  }
  const h = leg.heading;
  switch (h.mode) {
    case "linear":
      return `${base}.linear(${h.from}, ${h.to})`;
    case "constant":
      return `${base}.constant(${h.pose})`;
    case "tangent":
      return `${base}.tangent()`;
    case "reverseTangent":
      return `${base}.reverseTangent()`;
    case "facingPoint":
      return `${base}.facingPoint(${h.pose})`;
    case "toTarget":
      throw new Error("toTarget heading belongs to straight-to-point legs");
  }
}

// new Leg(path, During.X, End.Y).options: the leg exactly as the spec has it. A file written with the older
// Action shortcut keeps it on the legs it fits.
export function renderLegEntry(leg: Leg, j?: Pick<JavaShape, "legNew" | "enumPrefix" | "legForm">): string {
  const target = leg.path.type === "toPoint" ? leg.path.to : leg.inline ? renderPathExpr(leg) : `${leg.method}()`;
  const p = j?.enumPrefix ?? "";
  const action = j?.legForm === "action" ? Object.keys(ACTIONS).find((k) => ACTIONS[k].during === leg.during && ACTIONS[k].end === leg.end) : undefined;
  const what = action ? `${p}Action.${action}` : `${p}During.${leg.during}, ${p}End.${leg.end}`;
  const s = `new ${j?.legNew ?? "Leg"}(${target}, ${what})`;
  // every option the leg sets, in the order the code wrote them (or AutoRunner's documented order)
  const parts: Record<string, string> = {
    ...(leg.legTimeoutS !== null ? { timeout: `.timeout(${fmtNum(leg.legTimeoutS, 2)})` } : {}),
    ...(leg.carryIntakeS > 0 ? { carryIntake: `.carryIntake(${fmtNum(leg.carryIntakeS, 2)})` } : {}),
    ...(leg.shotTimeoutS !== undefined ? { shotTimeout: `.shotTimeout(${fmtNum(leg.shotTimeoutS, 2)})` } : {}),
    ...(leg.waitS !== undefined ? { waitFor: `.waitFor(${fmtNum(leg.waitS, 2)})` } : {}),
    ...(leg.carryRampS !== undefined && leg.during === "RAMP" ? { carryRamp: `.carryRamp(${fmtNum(leg.carryRampS, 2)})` } : {}),
  };
  const order = leg.optOrder?.length ? [...leg.optOrder, ...LEG_OPTIONS] : LEG_OPTIONS;
  return s + [...new Set(order)].map((k) => parts[k] ?? "").join("");
}

// AutoRunner.Leg's builder options, in the order AutoTool writes them
export const LEG_OPTIONS = ["timeout", "carryIntake", "carryRamp", "shotTimeout", "waitFor"];

function renderLegs(spec: AutoSpec): string {
  const entries = spec.legs.map((l) => {
    const c = l.comment ? `${l.comment.split("\n").map((x) => x.trim()).join("\n                ")}\n                ` : "";
    return c + renderLegEntry(l, spec.java);
  });
  return `public List<AutoRunner.Leg> legs() {\n        return ${spec.java?.listCall ?? "Arrays.asList"}(\n                ${entries.join(",\n                ")});\n    }`;
}

const MANAGED_IMPORTS = [
  "com.pedropathing.api.Paths",
  "com.pedropathing.api.PoseFactory",
  "com.pedropathing.math.Pose",
  "com.pedropathing.paths.Path",
  "org.firstinspires.ftc.teamcode.config.MatchState",
  "org.firstinspires.ftc.teamcode.config.Tuned",
  "java.util.Arrays",
  "java.util.List",
];

function neededImports(spec: AutoSpec, members: string[]): string[] {
  const all = members.join("\n");
  const imps: string[] = [];
  const add = (cond: boolean, name: string) => cond && imps.push(name);
  add(/\bPaths\./.test(all), "com.pedropathing.api.Paths");
  add(/\bPoseFactory\b/.test(all), "com.pedropathing.api.PoseFactory");
  add(/\bPose\b/.test(all), "com.pedropathing.math.Pose");
  add(/\bPath\b/.test(all), "com.pedropathing.paths.Path");
  add(/\bMatchState\./.test(all), "org.firstinspires.ftc.teamcode.config.MatchState");
  add(/\bTuned\./.test(all), "org.firstinspires.ftc.teamcode.config.Tuned");
  add(/\bArrays\./.test(all), "java.util.Arrays");
  add(/\bList\b/.test(all), "java.util.List");
  void spec;
  return imps;
}

function importBlock(imps: string[]): string {
  const groups = [imps.filter((i) => i.startsWith("com.")), imps.filter((i) => i.startsWith("org.")), imps.filter((i) => !i.startsWith("com.") && !i.startsWith("org.") && !i.startsWith("java")), imps.filter((i) => i.startsWith("java"))];
  return groups
    .filter((g) => g.length)
    .map((g) => g.sort().map((i) => `import ${i};`).join("\n"))
    .join("\n\n");
}

export function renderAutoPaths(spec: AutoSpec): string {
  const j = spec.java;
  const members = new Map<string, string>();
  members.set("factory", j?.factory ?? DEFAULT_FACTORY);
  for (const p of spec.poses) members.set(`pose:${p.name}`, renderPose(p));
  members.set("method:ready", j?.readyCustom ?? renderReady(spec));
  const usesTrim = spec.poses.some((p) => p.redTrim);
  if (usesTrim || j?.redTrimHelper) members.set("method:redTrim", j?.redTrimHelper ?? DEFAULT_REDTRIM);
  members.set("method:start", `public Pose start() {\n        return ${spec.start};\n    }`);
  for (const l of spec.legs) {
    if (l.path.type !== "toPoint" && !l.inline && l.method) members.set(`path:${l.method}`, `public Path ${l.method}() {\n        return ${renderPathExpr(l)};\n    }`);
  }
  members.set("method:legs", renderLegs(spec));
  if (spec.intakeAlways) members.set("method:intakeAlways", `@Override\n    public boolean intakeAlways() {\n        return true; // persistent intake: AutoRunner runs the intake all auto except during shots\n    }`);
  spec.opaque.forEach((o, i) => members.set(`opaque:${i}`, o.code));

  // order: the file's order, then new members where they belong
  const order = (j?.order ?? []).filter((k) => members.has(k));
  const place = (key: string, afterPrefix: string[], beforeKey: string | null) => {
    if (order.includes(key)) return;
    let at = -1;
    for (let i = 0; i < order.length; i++) if (afterPrefix.some((pre) => order[i].startsWith(pre))) at = i;
    if (at < 0 && beforeKey && order.includes(beforeKey)) at = order.indexOf(beforeKey) - 1;
    order.splice(at + 1, 0, key);
  };
  place("factory", [], null);
  for (const p of spec.poses) place(`pose:${p.name}`, ["factory", "pose:"], null);
  place("method:ready", ["factory", "pose:"], null);
  if (members.has("method:redTrim")) place("method:redTrim", ["method:ready"], null);
  place("method:start", ["method:ready", "method:redTrim"], null);
  for (const l of spec.legs) if (members.has(`path:${l.method}`)) place(`path:${l.method}`, ["method:start", "path:"], "method:legs");
  place("method:legs", ["method:start", "path:", "opaque:"], null);
  if (members.has("method:intakeAlways")) place("method:intakeAlways", ["method:legs"], null);
  spec.opaque.forEach((_, i) => place(`opaque:${i}`, ["method:legs", "opaque:"], null));

  const parts: string[] = [];
  let prevKey = "";
  for (const key of order) {
    const text = members.get(key)!;
    const orig = j?.originals[key];
    const same = orig && normalizedText(lex(text)) === orig.norm;
    const kind = key.startsWith("pose:") || key === "factory" ? "field" : "method";
    let blank: boolean;
    if (orig && same) blank = orig.blankBefore;
    else blank = parts.length > 0 && !(kind === "field" && prevKey.startsWith("pose:") && key.startsWith("pose:"));
    if (parts.length === 0) blank = false;
    let out: string;
    if (orig && same) {
      const lead = orig.leading ? orig.leading.split("\n").map((l) => `    ${l.trimStart()}`).join("\n") + "\n" : "";
      out = `${lead}    ${orig.text}`;
    } else if (key.startsWith("opaque:")) {
      out = `    ${text}`;
    } else {
      const comment = key.startsWith("pose:") ? spec.poses.find((p) => `pose:${p.name}` === key)?.comment : undefined;
      out = (comment ? comment.split("\n").map((l) => `    ${l.trimStart()}`).join("\n") + "\n" : "") + `    ${text}`;
    }
    parts.push((blank ? "\n" : "") + out);
    prevKey = key;
  }
  const body = parts.join("\n");
  const memberTexts = [...members.values()];
  const needed = neededImports(spec, memberTexts);
  let header: string;
  if (j) {
    // imports the adapter manages follow the code; any other import of the file is kept as written
    const keep = j.imports.filter((i) => !MANAGED_IMPORTS.includes(i) || needed.includes(i));
    const missing = needed.filter((n) => !j.imports.includes(n));
    const changed = missing.length > 0 || keep.length !== j.imports.length;
    header = changed ? `package ${j.packageName};\n\n${importBlock([...keep.filter((i) => !i.startsWith("static")), ...missing])}` : j.headerText;
    if (changed && keep.some((i) => i.startsWith("static"))) header += "\n\n" + keep.filter((i) => i.startsWith("static")).map((i) => `import ${i};`).join("\n");
  } else {
    header = `package ${AUTOS_PACKAGE};\n\n${importBlock(needed)}`;
  }
  const doc = spec.javadoc ? `${spec.javadoc}\n` : "";
  const decl = j?.classDecl ?? "public class AutoPaths {";
  const trailing = j?.trailing ? `\n${j.trailing.split("\n").map((l) => `    ${l.trimStart()}`).join("\n")}` : "";
  const after = j ? j.after : "\n";
  return `${header}\n\n${doc}${decl}\n${body}${trailing}\n}${after}`;
}

// The import every auto goes through: parse, render, and prove the round trip.
export function importAutoPaths(src: string, symbols: Map<string, number | null>, file?: string): ImportResult {
  return parseAutoPaths(src, symbols, file);
}

// --- AutoTool autos: one file each, named as on the Driver Station -----------------------------
// Near_9.java holds the whole auto: two OpModes (Blue_Near_9 as drawn, Red_Near_9 the same route reflected
// through the field centre by MatchState.poseFactory) and the route (class Plan). AutoTool writes only the
// lines between the two route markers: poses, path methods and the leg list. Everything else in the file
// is the team's and survives every write.

export interface RouteNames {
  cls: string; // class and file: Near_9
  blue: string; // Driver Station names: Blue_Near_9, Red_Near_9
  red: string;
}
// The part of an auto's name the Driver Station shows after Blue_Near_: the name without the words
// the alliance and the half already say ("close_9" -> "9", "far_6_cycle" -> "6_cycle").
export function autoTag(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(near|far|close|blue|red|auto)$/i.test(w))
    .join("_");
}
// (Near|Far)[_tag], numbered from the second auto with the same name.
export function routeNames(side: "Near" | "Far", tag = "", n = 1): RouteNames {
  const suffix = [side, tag, n > 1 ? String(n) : ""].filter(Boolean).join("_");
  return { cls: suffix, blue: `Blue_${suffix}`, red: `Red_${suffix}` };
}

export const ROUTE_BEGIN = "// >>> AutoTool route: poses, paths and legs. AutoTool rewrites everything down to the <<< line.";
export const ROUTE_END = "// <<< AutoTool route";
const BEGIN_RE = /^[ \t]*\/\/ >>> AutoTool route.*$/m;
const END_RE = /^[ \t]*\/\/ <<< AutoTool route.*$/m;

// Where the route region is: [start, end) of the text between the marker lines.
export function routeRegion(src: string): { start: number; end: number; line: number } | null {
  const b = BEGIN_RE.exec(src);
  const e = END_RE.exec(src);
  if (!b || !e || e.index < b.index) return null;
  const start = b.index + b[0].length + 1;
  return { start, end: src.lastIndexOf("\n", e.index) + 1, line: src.slice(0, start).split("\n").length };
}

const IND = "        "; // inside Plan, inside the auto's class

// The route region: isReady, poses, start(), one path method per leg, legs(), and persistent intake.
export function renderRoute(spec: AutoSpec): string {
  const block = (t: string) => t.split("\n").map((l) => (l ? `${IND}${l.replace(/^ {4}/, "")}` : l)).join("\n");
  const parts: string[] = [];
  parts.push(block(`    ${renderReady(spec, true)}`));
  parts.push(spec.poses.map((p) => (p.comment ? `${p.comment.split("\n").map((l) => `${IND}${l.trimStart()}`).join("\n")}\n` : "") + `${IND}${renderPose(p)}`).join("\n"));
  parts.push(block(`    public Pose start() {\n        return ${spec.start};\n    }`));
  for (const l of spec.legs) {
    if (l.path.type !== "toPoint" && !l.inline && l.method) parts.push(block(`    public Path ${l.method}() {\n        return ${renderPathExpr(l)};\n    }`));
  }
  const entries = spec.legs.map((l) => (l.comment ? `${l.comment.split("\n").map((x) => x.trim()).join("\n                    ")}\n                    ` : "") + renderLegEntry(l));
  parts.push(`${IND}public List<Leg> legs() {\n${IND}    return Arrays.asList(\n${IND}            ${entries.join(`,\n${IND}            `)});\n${IND}}`);
  if (spec.intakeAlways) parts.push(block(`    @Override\n    public boolean intakeAlways() {\n        return true; // persistent intake: AutoRunner runs the intake all auto except during shots\n    }`));
  return parts.join("\n\n") + "\n";
}

export function renderAutoFile(spec: AutoSpec, n: RouteNames, preselectTeleOp: string | null): string {
  const pre = preselectTeleOp ? `, preselectTeleOp = "${preselectTeleOp}"` : "";
  const trim = DEFAULT_REDTRIM.split("\n").map((l, i) => (i ? `    ${l}` : `        ${l}`)).join("\n");
  return `package ${AUTOS_PACKAGE};

${importBlock([
  "com.pedropathing.api.Paths",
  "com.pedropathing.api.PoseFactory",
  "com.pedropathing.math.Pose",
  "com.pedropathing.paths.Path",
  "com.qualcomm.robotcore.eventloop.opmode.Autonomous",
  "org.firstinspires.ftc.teamcode.config.MatchState",
  "org.firstinspires.ftc.teamcode.config.Tuned",
  `${AUTOS_PACKAGE}.AutoRunner.During`,
  `${AUTOS_PACKAGE}.AutoRunner.End`,
  `${AUTOS_PACKAGE}.AutoRunner.Leg`,
  `${AUTOS_PACKAGE}.AutoRunner.Route`,
  "java.util.Arrays",
  "java.util.List",
])}

// AutoTool auto: ${spec.name}
// Two OpModes, one route: ${n.blue} as drawn, ${n.red} the same route reflected through the field centre.
// AutoTool rewrites only the lines between ">>> AutoTool route" and "<<< AutoTool route" (poses, paths, legs).
// Everything else in this file is yours: code you add outside those lines stays when AutoTool writes again.
public class ${n.cls} {
    @Autonomous(name = "${n.blue}", group = "AutoTool"${pre})
    public static class Blue extends AutoRunner {
        @Override
        protected MatchState.Alliance alliance() {
            return MatchState.Alliance.BLUE;
        }

        @Override
        protected Route route() {
            return new Plan();
        }
    }

    @Autonomous(name = "${n.red}", group = "AutoTool"${pre})
    public static class Red extends Blue {
        @Override
        protected MatchState.Alliance alliance() {
            return MatchState.Alliance.RED;
        }
    }

    // The route. AutoRunner builds it in INIT, after the alliance is set, so every pose comes out reflected for red.
    static class Plan implements Route {
        private final PoseFactory poseFactory = MatchState.poseFactory();

${trim}

        ${ROUTE_BEGIN}
${renderRoute(spec)}        ${ROUTE_END}
    }
}
`;
}

// The file with its route region rewritten (and the file's other text untouched); a new file when it has none.
export function writeAutoFile(current: string | null, spec: AutoSpec, n: RouteNames, preselectTeleOp: string | null): string {
  const r = current ? routeRegion(current) : null;
  if (!current || !r) return renderAutoFile(spec, n, preselectTeleOp);
  return current.slice(0, r.start) + renderRoute(spec) + current.slice(r.end);
}

// Reads an AutoTool auto back: the route region through the AutoPaths importer, the name from the header.
// Autos written before the one-file format (Blue_Near.java with a nested Plan) are read too.
export function importAutoTool(src: string, symbols: Map<string, number | null>, file?: string): ImportResult {
  const r = routeRegion(src);
  if (!r) return importOldAuto(src, symbols, file);
  const head = "package p;\n\nclass Plan {\n    private final PoseFactory poseFactory = MatchState.poseFactory();\n";
  const region = src.slice(r.start, r.end);
  const res = parseAutoPaths(`${head}${region}}\n`, symbols, file, false);
  const at = (line: number) => line - 4 + r.line - 1;
  if (!res.ok) return { ...res, errors: res.errors.map((e) => ({ ...e, line: at(e.line) })) };
  res.spec.name = /\/\/ AutoTool auto: (\S+)/.exec(src)?.[1] ?? res.spec.name;
  // everything in the region must come back from the spec, or the next write would lose it
  const strange = res.spec.opaque.map((o) => o.code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? o.why);
  if (strange.length) return { ok: false, errors: strange.map((t) => ({ line: r.line, message: `the AutoTool route lines have code AutoTool does not write (${t}): move it outside the >>> / <<< lines` })), warnings: res.warnings };
  if (normalizedText(lex(renderRoute(res.spec))) !== normalizedText(lex(region))) {
    return { ok: false, errors: [{ line: r.line, message: "the AutoTool route lines were edited in a way AutoTool cannot read back exactly; keep custom code outside the >>> / <<< lines" }], warnings: res.warnings };
  }
  res.spec.java = undefined; // the file around the region is the team's; only the region is AutoTool's
  res.spec.opaque = [];
  return res;
}

const PLAN_DECL = "static class Plan implements Route {";
const dedent = (t: string) => t.split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n");

function splitHeader(java: string): { imports: string[]; body: string } {
  const lines = java.split("\n");
  const imports = lines.filter((l) => l.startsWith("import ")).map((l) => l.slice(7, -1));
  const first = lines.findIndex((l) => !/^(package |import |\s*$)/.test(l));
  return { imports, body: lines.slice(first).join("\n").replace(/\s+$/, "") };
}

// Blue_Near.java from before the one-file format: the nested Plan through the AutoPaths importer.
function importOldAuto(src: string, symbols: Map<string, number | null>, file?: string): ImportResult {
  // an auto written in the house style carries AutoTool's copy of its route
  const copy = /autotool-spec:\s*([A-Za-z0-9+/=]+)/.exec(src);
  if (copy) {
    try {
      const spec = migrateSpec(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(copy[1]), (c) => c.charCodeAt(0)))) as AutoSpec);
      return { ok: true, spec, rendered: src, warnings: [] };
    } catch {
      return { ok: false, errors: [{ line: 1, message: "AutoTool's copy of the route in this file is damaged" }], warnings: [] };
    }
  }
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l.trim() === PLAN_DECL);
  const end = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l === "    }");
  if (at < 0 || end < 0) return { ok: false, errors: [{ line: 1, message: "no AutoTool route in this file (the >>> AutoTool route ... <<< AutoTool route lines)" }], warnings: [] };
  const { imports } = splitHeader(src);
  const plan = `package ${AUTOS_PACKAGE};\n\n${importBlock(imports)}\n\n${dedent(lines.slice(at, end + 1).join("\n"))}\n`;
  // read only: the next write turns it into the one-file format
  const r = parseAutoPaths(plan, symbols, file, false);
  if (!r.ok) return { ...r, errors: r.errors.map((e) => ({ ...e, line: e.line + at - 4 })) };
  const name = /\/\/ AutoTool auto: (\S+)/.exec(src)?.[1];
  if (name) r.spec.name = name;
  r.spec.java = undefined;
  return r;
}

// The one-time AutoRunner change: a Route interface, and init() asks route() for the auto instead of
// hard-wiring AutoPaths. Returns null when the file is already hooked; throws when the expected code
// is not there.
export function hookAutoRunner(src: string): string | null {
  if (/protected\s+Route\s+route\s*\(\s*\)/.test(src)) return null;
  const old = /( *)if \(!(\w+)\.ready\(\)\) \{\n([\s\S]*?)\n\s*return;\n\s*\}\n\s*\2 paths = new \2\(\);\n/;
  const m = old.exec(src);
  if (!m) throw new Error("AutoRunner.init() does not look like the version AutoTool knows (AutoPaths.ready() / new AutoPaths()); add the route() hook by hand or ask for help");
  const ind = m[1];
  const cls = m[2];
  const replaced = src.replace(old, `${ind}Route paths = route();\n${ind}if (!paths.isReady()) {\n${m[3]}\n${ind}    return;\n${ind}}\n`);
  const method = `
    // An auto's route: where it starts and its legs. ${cls} is the default; AutoTool's autos
    // (Blue_Near, Red_Far, ...) bring their own.
    public interface Route {
        boolean isReady(); // false while a pose is still an unset Tuned value (NaN)

        Pose start();

        List<Leg> legs();
    }

    protected Route route() {
        return new Route() {
            private ${cls} p; // built after the ready check, as before

            private AutoPaths p() {
                if (p == null) p = new ${cls}();
                return p;
            }

            @Override
            public boolean isReady() {
                return ${cls}.ready();
            }

            @Override
            public Pose start() {
                return p().start();
            }

            @Override
            public List<Leg> legs() {
                return p().legs();
            }
        };
    }
`;
  const at = replaced.indexOf("    protected abstract MatchState.Alliance alliance();");
  if (at < 0) throw new Error("AutoRunner has no alliance() declaration where the hook goes");
  const end = at + "    protected abstract MatchState.Alliance alliance();".length;
  return replaced.slice(0, end) + "\n" + method + replaced.slice(end);
}
