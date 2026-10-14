// The auto reader: runs a hand-written auto's Java symbolically to recover every pose and every action,
// whatever the framework (AutoRunner legs, Pedro 2 path chains, FTCLib command groups, plain OpMode
// calls). It follows helper methods (along(t), line(a, b), redTrim(...)), constants in other files
// (autoConstants.BLUE_CLOSE_START), constructors and getters of the team's classes, and if/else on the
// alliance (always read as BLUE). A value the code does not know yet (a Tuned value that is NaN) stays a
// named unknown, so placing the start and park later fills in every pose derived from them.
//
// Nothing here guesses a number: each value is computed from the source, and each step keeps its line.

import { type Tok, code, lex } from "./lexer.ts";

// ---- formulas: numbers that may depend on unknowns ---------------------------------------------

import { ACTIONS, type Formula } from "../spec.ts";
export type F = Formula;

const C = (v: number): F => ({ k: "c", v });
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const OPS: Record<string, (a: number[]) => number> = {
  "+": (a) => a[0] + a[1],
  "-": (a) => a[0] - a[1],
  "*": (a) => a[0] * a[1],
  "/": (a) => a[0] / a[1],
  "%": (a) => a[0] % a[1],
  neg: (a) => -a[0],
  toRad: (a) => (a[0] * Math.PI) / 180,
  toDeg: (a) => (a[0] * 180) / Math.PI,
  wrapDeg: (a) => wrap(a[0]),
  sin: (a) => Math.sin(a[0]),
  cos: (a) => Math.cos(a[0]),
  tan: (a) => Math.tan(a[0]),
  atan2: (a) => Math.atan2(a[0], a[1]),
  sqrt: (a) => Math.sqrt(a[0]),
  abs: (a) => Math.abs(a[0]),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  hypot: (a) => Math.hypot(...a),
  pow: (a) => a[0] ** a[1],
  round: (a) => Math.round(a[0]),
};

export function mk(op: string, ...a: F[]): F {
  if (op === "toDeg" && a[0].k === "op" && a[0].op === "toRad") return a[0].a[0];
  if (a.every((x) => x.k === "c")) {
    const v = OPS[op]?.(a.map((x) => (x as { v: number }).v));
    if (v !== undefined && Number.isFinite(v)) return C(v);
  }
  // x * 0 and 0 * x are 0 even when x is unknown (along(0) = start)
  if (op === "*" && a.some((x) => x.k === "c" && x.v === 0)) return C(0);
  if (op === "+" && a[1].k === "c" && a[1].v === 0) return a[0];
  if (op === "+" && a[0].k === "c" && a[0].v === 0) return a[1];
  if (op === "*" && a[1].k === "c" && a[1].v === 1) return a[0];
  if (op === "*" && a[0].k === "c" && a[0].v === 1) return a[1];
  return { k: "op", op, a };
}

export function fEval(f: F, env: Record<string, number> = {}): number | null {
  if (f.k === "c") return f.v;
  if (f.k === "v") return Number.isFinite(env[f.name]) ? env[f.name] : null;
  const a = f.a.map((x) => fEval(x, env));
  if (a.some((x) => x === null)) return null;
  const v = OPS[f.op]?.(a as number[]);
  return v === undefined || !Number.isFinite(v) ? null : v;
}

export function fVars(f: F, out = new Set<string>()): string[] {
  if (f.k === "v") out.add(f.name);
  else if (f.k === "op") for (const x of f.a) fVars(x, out);
  return [...out];
}

// The unknowns a number really moves with: changing one of them changes the value. along(1) =
// start + 1 * (park - start) mentions start but moves only with park.
export function relevantVars(f: F, env: Record<string, number> = {}): string[] {
  const vars = fVars(f).filter((v) => !Number.isFinite(env[v]) && !v.startsWith("?"));
  return vars.filter((v) =>
    [0, 1].some((trial) => {
      const base: Record<string, number> = { ...env };
      vars.forEach((w, k) => (base[w] = 37.3 + 23.9 * k + 11.1 * trial));
      const a = fEval(f, base);
      const b = fEval(f, { ...base, [v]: base[v] + 1.7 });
      return a !== null && b !== null && Math.abs(b - a) > 1e-6;
    }),
  );
}

// Solves "this coordinate = target" for the one unknown it moves with (null if it moves with none or
// with several). Unknowns it does not move with are bound to anything.
export function solveFor(f: F, target: number, env: Record<string, number>): { name: string; value: number } | null {
  const rel = relevantVars(f, env);
  if (rel.length !== 1) return null;
  const v = rel[0];
  const bound: Record<string, number> = { ...env };
  for (const w of fVars(f)) if (!Number.isFinite(bound[w]) && w !== v) bound[w] = 0;
  const at = (x: number) => fEval(f, { ...bound, [v]: x });
  const close = (a: number) => Math.abs(a - target) < 1e-6 || Math.abs(wrap(a - target)) < 1e-6;
  // secant steps: exact for the usual linear case, and good for a wrapped heading
  let x0 = target;
  let x1 = target + 1;
  for (let i = 0; i < 20; i++) {
    const f0 = at(x0);
    const f1 = at(x1);
    if (f0 === null || f1 === null) return null;
    if (close(f1)) return { name: v, value: Math.round(x1 * 1000) / 1000 };
    if (Math.abs(f1 - f0) < 1e-12) return null;
    const x2 = x1 - ((f1 - target) * (x1 - x0)) / (f1 - f0);
    x0 = x1;
    x1 = x2;
  }
  const last = at(x1);
  return last !== null && close(last) ? { name: v, value: Math.round(x1 * 1000) / 1000 } : null;
}

// ---- values the interpreter works with --------------------------------------------------------

export interface PoseV {
  t: "pose";
  x: F;
  y: F;
  h: F; // degrees
  src: string;
  line: number;
  name?: string;
}
export interface PathV {
  t: "path";
  kind: "line" | "curve" | "through";
  pts: PoseV[];
  heading: { mode: "linear" | "constant" | "tangent" | "reverseTangent" | "facingPoint"; a?: F; b?: F; pose?: PoseV } | null;
  line: number;
}
type V =
  | { t: "num"; f: F }
  | { t: "str"; s: string }
  | { t: "bool"; b: boolean | null }
  | PoseV
  | PathV
  | { t: "chain"; paths: PathV[]; line: number }
  | { t: "list"; items: V[] }
  | { t: "enum"; name: string; full: string }
  | { t: "obj"; type: string; args: V[]; calls: { name: string; args: V[]; line: number }[]; src: string; line: number }
  | { t: "inst"; cls: ClassInfo; fields: Map<string, V>; line?: number; args?: V[] }
  | { t: "lambda"; src: string; line: number }
  | { t: "factory"; deg: boolean }
  | { t: "null" }
  | { t: "unknown"; src: string; line: number };

// ---- a small Java parser: classes, members, statements, expressions ---------------------------

interface ClassInfo {
  name: string;
  file: string;
  src: string;
  ext: string | null;
  fields: Map<string, { toks: Tok[]; isStatic: boolean; line: number; type: string }>;
  methods: Map<string, { params: string[]; body: Tok[]; line: number; returns: string; isStatic: boolean }>;
  ctors: { params: string[]; types: string[]; body: Tok[] }[];
  staticImports: Map<string, string>; // NAME -> owning class simple name
  outer: ClassInfo | null;
}

function matchClose(t: Tok[], i: number, open: string, close: string): number {
  let d = 0;
  for (let j = i; j < t.length; j++) {
    if (t[j].text === open) d++;
    else if (t[j].text === close && --d === 0) return j;
  }
  return t.length - 1;
}

const MODIFIERS = new Set(["public", "private", "protected", "static", "final", "abstract", "volatile", "transient", "synchronized", "native", "default"]);

function parseClasses(file: string, src: string): ClassInfo[] {
  const t = code(lex(src));
  const staticImports = new Map<string, string>();
  for (const m of src.matchAll(/^import\s+static\s+[\w.]*?\.(\w+)\.(\w+|\*)\s*;/gm)) staticImports.set(m[2], m[1]);
  const out: ClassInfo[] = [];
  const parseBody = (start: number, end: number, ci: ClassInfo) => {
    let i = start;
    while (i < end) {
      const s = i;
      // annotations
      while (t[i]?.text === "@") {
        i += 2;
        while (t[i]?.text === ".") i += 2;
        if (t[i]?.text === "(") i = matchClose(t, i, "(", ")") + 1;
      }
      let isStatic = false;
      while (t[i] && MODIFIERS.has(t[i].text)) {
        if (t[i].text === "static") isStatic = true;
        i++;
      }
      if (t[i]?.text === "class" || t[i]?.text === "interface" || t[i]?.text === "enum") {
        const kind = t[i].text;
        const name = t[i + 1].text;
        let j = i + 2;
        let ext: string | null = null;
        while (t[j] && t[j].text !== "{") {
          if (t[j].text === "extends") ext = t[j + 1].text.split(".").pop()!;
          j++;
        }
        const close = matchClose(t, j, "{", "}");
        if (kind === "class") {
          const nested: ClassInfo = { name, file, src, ext, fields: new Map(), methods: new Map(), ctors: [], staticImports, outer: ci };
          out.push(nested);
          parseBody(j + 1, close, nested);
        }
        i = close + 1;
        continue;
      }
      if (t[i]?.text === "{") {
        i = matchClose(t, i, "{", "}") + 1; // initializer block
        continue;
      }
      if (t[i]?.text === ";") {
        i++;
        continue;
      }
      // type (with generics / arrays) then name, or a constructor Name(
      let j = i;
      let type = "";
      if (t[j]?.text === "<") j = matchClose(t, j, "<", ">") + 1; // generic method
      if (t[j + 1]?.text === "(" && t[j]?.text === ci.name) {
        // constructor
        const pc = matchClose(t, j + 1, "(", ")");
        const params = paramNames(t.slice(j + 2, pc));
        const types = paramTypes(t.slice(j + 2, pc));
        let k = pc + 1;
        while (t[k] && t[k].text !== "{" && t[k].text !== ";") k++;
        const close = t[k]?.text === "{" ? matchClose(t, k, "{", "}") : k;
        ci.ctors.push({ params, types, body: t.slice(k + 1, close) });
        i = close + 1;
        continue;
      }
      while (t[j] && (t[j].kind === "ident" || t[j].text === ".")) {
        type += t[j].text;
        j++;
        if (t[j]?.text === "<") {
          const c = matchClose(t, j, "<", ">");
          type += t.slice(j, c + 1).map((x) => x.text).join("");
          j = c + 1;
        }
        while (t[j]?.text === "[" && t[j + 1]?.text === "]") {
          type += "[]";
          j += 2;
        }
        if (t[j]?.kind === "ident" && t[j - 1]?.kind === "ident") break;
        if (t[j]?.kind === "ident" && (t[j - 1]?.text === ">" || t[j - 1]?.text === "]")) break;
      }
      const nameTok = t[j];
      if (!nameTok || nameTok.kind !== "ident") {
        // skip to the next ; or block
        while (i < end && t[i].text !== ";" && t[i].text !== "{") i++;
        i = t[i]?.text === "{" ? matchClose(t, i, "{", "}") + 1 : i + 1;
        if (i <= s) i = s + 1;
        continue;
      }
      if (t[j + 1]?.text === "(") {
        const pc = matchClose(t, j + 1, "(", ")");
        const params = paramNames(t.slice(j + 2, pc));
        let k = pc + 1;
        while (t[k] && t[k].text !== "{" && t[k].text !== ";") k++;
        const close = t[k]?.text === "{" ? matchClose(t, k, "{", "}") : k;
        if (!ci.methods.has(nameTok.text) || params.length) ci.methods.set(nameTok.text, { params, body: t[k]?.text === "{" ? t.slice(k + 1, close) : [], line: nameTok.line, returns: type.replace(/^.*\./, ""), isStatic });
        i = close + 1;
        continue;
      }
      // field(s): name [= init] {, name [= init]} ;
      let k = j;
      for (;;) {
        const n = t[k];
        let e = k + 1;
        let init: Tok[] = [];
        if (t[e]?.text === "=") {
          const st = e + 1;
          let d = 0;
          e = st;
          while (t[e] && !(d === 0 && (t[e].text === ";" || t[e].text === ","))) {
            if ("({[".includes(t[e].text)) d++;
            else if (")}]".includes(t[e].text)) d--;
            e++;
          }
          init = t.slice(st, e);
        }
        if (n?.kind === "ident") ci.fields.set(n.text, { toks: init, isStatic, line: n.line, type });
        if (t[e]?.text === ",") {
          k = e + 1;
          continue;
        }
        i = e + 1;
        break;
      }
    }
  };
  for (let i = 0; i < t.length; i++) {
    if (t[i].text === "class" && t[i + 1]?.kind === "ident" && (i === 0 || t[i - 1].text !== ".")) {
      const name = t[i + 1].text;
      let j = i + 2;
      let ext: string | null = null;
      while (t[j] && t[j].text !== "{") {
        if (t[j].text === "extends") ext = t[j + 1].text.split(".").pop()!;
        j++;
      }
      const close = matchClose(t, j, "{", "}");
      const ci: ClassInfo = { name, file, src, ext, fields: new Map(), methods: new Map(), ctors: [], staticImports, outer: null };
      out.push(ci);
      parseBody(j + 1, close, ci);
      i = close;
    }
  }
  return out;
}

// the simple type of each parameter ("Path", "Pose", "double", ...)
function paramTypes(t: Tok[]): string[] {
  const out: string[] = [];
  let d = 0;
  let cur: string[] = [];
  for (const x of [...t, { text: "," } as Tok]) {
    if (x.text === "<") d++;
    else if (x.text === ">") d--;
    else if (x.text === "," && d === 0) {
      const idents = cur.filter((w) => !MODIFIERS.has(w));
      out.push(idents.length >= 2 ? idents[idents.length - 2] : "");
      cur = [];
    } else if (d === 0 && x.kind === "ident") cur.push(x.text);
  }
  return t.length ? out : [];
}

function paramNames(t: Tok[]): string[] {
  const out: string[] = [];
  let d = 0;
  let last = "";
  for (const x of t) {
    if (x.text === "<") d++;
    else if (x.text === ">") d--;
    else if (x.text === "," && d === 0) {
      out.push(last);
      last = "";
    } else if (x.kind === "ident" && d === 0) last = x.text;
  }
  if (last) out.push(last);
  return out;
}

// ---- the interpreter ---------------------------------------------------------------------------

export interface Step {
  kind: "drive" | "action" | "wait" | "start";
  text: string; // what the code does, in its own words
  line: number;
  file: string;
  path?: PathV;
  target?: PoseV; // drive to a pose from wherever the robot is
  ms?: number; // waits; or when the action starts, after the drive it runs with began
  group?: string; // "with the next drive" etc.
  // an AutoRunner.Leg: what it does while driving and at the end (an Action shortcut read as its pair)
  during?: "NONE" | "INTAKE" | "RAMP";
  end?: "NONE" | "SHOOT" | "PARK" | "WAIT";
  timeoutS?: number;
  carryS?: number;
  opts?: { shotTimeoutS?: number; waitS?: number };
}

export interface ReadResult {
  framework: string;
  intakeAlways?: boolean; // the route's intakeAlways() (persistent intake)
  start: PoseV | null;
  poses: PoseV[];
  steps: Step[];
  unknowns: string[]; // Tuned values (or others) the code does not know yet
  skipped: { line: number; text: string }[]; // code the reader could not follow
}

class Interp {
  classes = new Map<string, ClassInfo>();
  staticMemo = new Map<string, V>();
  skipped: { line: number; text: string }[] = [];
  depth = 0;
  constructor(files: { path: string; text: string }[]) {
    for (const f of files) {
      try {
        for (const c of parseClasses(f.path, f.text)) if (!this.classes.has(c.name)) this.classes.set(c.name, c);
      } catch {
        /* a file the parser cannot split is skipped */
      }
    }
  }
  skip(line: number, text: string) {
    if (this.skipped.length < 80 && !this.skipped.some((s) => s.line === line && s.text === text)) this.skipped.push({ line, text: text.slice(0, 120) });
  }

  // -- statements --
  exec(body: Tok[], env: Map<string, V>, self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> } | null, trace: Step[] | null): V | undefined {
    let i = 0;
    const t = body;
    while (i < t.length) {
      const r = this.stmt(t, i, env, self, trace);
      if (r.ret !== undefined) return r.ret;
      i = r.next;
    }
    return undefined;
  }
  private endOf(t: Tok[], i: number): number {
    let d = 0;
    for (let j = i; j < t.length; j++) {
      if ("({[".includes(t[j].text)) d++;
      else if (")}]".includes(t[j].text)) d--;
      else if (t[j].text === ";" && d === 0) return j;
    }
    return t.length;
  }
  private stmt(t: Tok[], i: number, env: Map<string, V>, self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> } | null, trace: Step[] | null): { next: number; ret?: V } {
    const tok = t[i];
    if (tok.text === "{") {
      const c = matchClose(t, i, "{", "}");
      const r = this.exec(t.slice(i + 1, c), env, self, trace);
      return { next: c + 1, ret: r };
    }
    if (tok.text === ";") return { next: i + 1 };
    if (tok.text === "return") {
      const e = this.endOf(t, i + 1);
      const v = e > i + 1 ? this.evalToks(t.slice(i + 1, e), env, self, trace) : { t: "null" as const };
      return { next: e + 1, ret: v };
    }
    if (tok.text === "if") {
      const pc = matchClose(t, i + 1, "(", ")");
      const cond = this.evalToks(t.slice(i + 2, pc), env, self, null);
      const thenStart = pc + 1;
      const thenEnd = this.stmtEnd(t, thenStart);
      let elseStart = -1;
      let elseEnd = thenEnd;
      if (t[thenEnd]?.text === "else") {
        elseStart = thenEnd + 1;
        elseEnd = this.stmtEnd(t, elseStart);
      }
      const b = cond.t === "bool" ? cond.b : null;
      if (b === null) this.skip(tok.line, `if (${t.slice(i + 2, pc).map((x) => x.text).join(" ")}): unknown, read as true`);
      if (b !== false) {
        const r = this.stmt(t, thenStart, env, self, trace);
        if (r.ret !== undefined) return { next: elseEnd, ret: r.ret };
      } else if (elseStart >= 0) {
        const r = this.stmt(t, elseStart, env, self, trace);
        if (r.ret !== undefined) return { next: elseEnd, ret: r.ret };
      }
      return { next: elseEnd };
    }
    if (tok.text === "for" || tok.text === "while" || tok.text === "do" || tok.text === "switch") {
      const end = this.stmtEnd(t, i);
      this.skip(tok.line, `${tok.text} loop (not followed)`);
      return { next: end };
    }
    if (tok.text === "try") {
      const c = matchClose(t, i + 1, "{", "}");
      const r = this.exec(t.slice(i + 2, c), env, self, trace);
      let k = c + 1;
      while (t[k]?.text === "catch" || t[k]?.text === "finally") {
        if (t[k].text === "catch") k = matchClose(t, k + 1, "(", ")") + 1;
        else k++;
        k = matchClose(t, k, "{", "}") + 1;
      }
      return { next: k, ret: r };
    }
    const e = this.endOf(t, i);
    const s = t.slice(i, e);
    // local declaration: [final] Type[<..>] name = expr
    const eq = s.findIndex((x) => x.text === "=");
    if (eq > 1 && s[eq - 1].kind === "ident" && (s[eq - 2].kind === "ident" || s[eq - 2].text === ">" || s[eq - 2].text === "]") && !["+", "-", "*", "/"].includes(s[eq - 1].text)) {
      env.set(s[eq - 1].text, this.evalToks(s.slice(eq + 1), env, self, trace));
      return { next: e + 1 };
    }
    if (eq === 1 && s[0].kind === "ident") {
      const v = this.evalToks(s.slice(2), env, self, trace);
      if (env.has(s[0].text)) env.set(s[0].text, v);
      else if (self) self.fields.set(s[0].text, v);
      return { next: e + 1 };
    }
    if (eq === 3 && s[0].text === "this" && s[1].text === ".") {
      if (self) self.fields.set(s[2].text, this.evalToks(s.slice(4), env, self, trace));
      return { next: e + 1 };
    }
    if (s.length) this.evalToks(s, env, self, trace, true);
    return { next: e + 1 };
  }
  private stmtEnd(t: Tok[], i: number): number {
    if (t[i]?.text === "{") return matchClose(t, i, "{", "}") + 1;
    if (t[i]?.text === "if") {
      const pc = matchClose(t, i + 1, "(", ")");
      let e = this.stmtEnd(t, pc + 1);
      if (t[e]?.text === "else") e = this.stmtEnd(t, e + 1);
      return e;
    }
    if (t[i]?.text === "for" || t[i]?.text === "while" || t[i]?.text === "switch") {
      const pc = matchClose(t, i + 1, "(", ")");
      return this.stmtEnd(t, pc + 1);
    }
    return this.endOf(t, i) + 1;
  }

  // -- expressions (precedence climbing over tokens) --
  evalToks(t: Tok[], env: Map<string, V>, self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> } | null, trace: Step[] | null, statement = false): V {
    const p = { i: 0 };
    try {
      const v = this.ternary(t, p, env, self, trace, statement);
      return v;
    } catch (err) {
      this.skip(t[0]?.line ?? 0, `${t.map((x) => x.text).join(" ").slice(0, 100)} (${(err as Error).message})`);
      return { t: "unknown", src: t.map((x) => x.text).join(" "), line: t[0]?.line ?? 0 };
    }
  }
  private ternary(t: Tok[], p: { i: number }, env: Map<string, V>, self: any, trace: Step[] | null, st = false): V {
    // lambda: () -> ..., x -> ...
    if ((t[p.i]?.text === "(" && t[matchClose(t, p.i, "(", ")") + 1]?.text === "->") || (t[p.i]?.kind === "ident" && t[p.i + 1]?.text === "->")) {
      const start = p.i;
      p.i = t.length;
      const arrow = t.findIndex((x, k) => k >= start && x.text === "->");
      const bodyText = t.slice(arrow + 1).map((x) => x.text).join(" ").replace(/^\{\s*|\s*;?\s*\}$/g, "").replace(/\s*\.\s*/g, ".").replace(/\s*\(\s*/g, "(").replace(/\s*\)/g, ")").replace(/\s*,\s*/g, ", ").replace(/\s*;\s*/g, "; ");
      return { t: "lambda", src: bodyText, line: t[start].line };
    }
    const c = this.binary(t, p, 0, env, self, trace, st);
    if (t[p.i]?.text === "?") {
      p.i++;
      const a = this.ternary(t, p, env, self, trace);
      p.i++; // :
      const b = this.ternary(t, p, env, self, trace);
      return c.t === "bool" && c.b !== null ? (c.b ? a : b) : a;
    }
    return c;
  }
  private static PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
  private binary(t: Tok[], p: { i: number }, min: number, env: Map<string, V>, self: any, trace: Step[] | null, st = false): V {
    let l = this.unary(t, p, env, self, trace, st);
    for (;;) {
      let op = t[p.i]?.text;
      let width = 1;
      // the lexer may split two-char operators into two tokens
      if (op && ["=", "!", "<", ">", "&", "|"].includes(op) && ["=", "&", "|"].includes(t[p.i + 1]?.text) && t[p.i + 1].start === t[p.i].start + 1) {
        op += t[p.i + 1].text;
        width = 2;
      }
      const pr = op ? Interp.PREC[op] : undefined;
      if (!pr || pr < min || !op) return l;
      p.i += width;
      const r = this.binary(t, p, pr + 1, env, self, trace);
      l = this.bin(op, l, r);
    }
  }
  private bin(op: string, l: V, r: V): V {
    if (["+", "-", "*", "/", "%"].includes(op)) {
      if (l.t === "str" || r.t === "str") return { t: "str", s: `${l.t === "str" ? l.s : "?"}${r.t === "str" ? r.s : "?"}` };
      if (l.t === "num" && r.t === "num") return { t: "num", f: mk(op, l.f, r.f) };
      return { t: "unknown", src: op, line: 0 };
    }
    if (op === "==" || op === "!=") {
      let eq: boolean | null = null;
      if (l.t === "enum" && r.t === "enum") eq = l.name === r.name;
      else if (l.t === "num" && r.t === "num") {
        const a = fEval(l.f);
        const b = fEval(r.f);
        eq = a === null || b === null ? null : a === b;
      } else if (l.t === "null" || r.t === "null") eq = l.t === r.t ? true : l.t === "unknown" || r.t === "unknown" ? null : false;
      return { t: "bool", b: eq === null ? null : op === "==" ? eq : !eq };
    }
    if (op === "&&" || op === "||") {
      const a = l.t === "bool" ? l.b : null;
      const b = r.t === "bool" ? r.b : null;
      if (op === "&&") return { t: "bool", b: a === false || b === false ? false : a === null || b === null ? null : true };
      return { t: "bool", b: a === true || b === true ? true : a === null || b === null ? null : false };
    }
    if (l.t === "num" && r.t === "num") {
      const a = fEval(l.f);
      const b = fEval(r.f);
      if (a === null || b === null) return { t: "bool", b: null };
      return { t: "bool", b: op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b };
    }
    return { t: "bool", b: null };
  }
  private unary(t: Tok[], p: { i: number }, env: Map<string, V>, self: any, trace: Step[] | null, st = false): V {
    const tok = t[p.i];
    if (tok?.text === "-") {
      p.i++;
      const v = this.unary(t, p, env, self, trace);
      return v.t === "num" ? { t: "num", f: mk("neg", v.f) } : v;
    }
    if (tok?.text === "+") {
      p.i++;
      return this.unary(t, p, env, self, trace);
    }
    if (tok?.text === "!") {
      p.i++;
      const v = this.unary(t, p, env, self, trace);
      return { t: "bool", b: v.t === "bool" && v.b !== null ? !v.b : null };
    }
    // cast: (double) x, (int) x
    if (tok?.text === "(" && t[p.i + 1]?.kind === "ident" && t[p.i + 2]?.text === ")" && /^(double|int|long|float|short)$/.test(t[p.i + 1].text)) {
      p.i += 3;
      return this.unary(t, p, env, self, trace);
    }
    return this.postfix(t, p, this.primary(t, p, env, self, trace), env, self, trace, st);
  }
  private args(t: Tok[], p: { i: number }, env: Map<string, V>, self: any, trace: Step[] | null): V[] {
    const close = matchClose(t, p.i, "(", ")");
    const out: V[] = [];
    let s = p.i + 1;
    let d = 0;
    for (let k = p.i + 1; k <= close; k++) {
      const x = t[k].text;
      if ("({[".includes(x)) d++;
      else if (k === close || (x === "," && d === 0)) {
        if (k > s) out.push(this.evalToks(t.slice(s, k), env, self, trace));
        s = k + 1;
      } else if (")}]".includes(x)) d--;
    }
    p.i = close + 1;
    return out;
  }
  private primary(t: Tok[], p: { i: number }, env: Map<string, V>, self: any, trace: Step[] | null): V {
    const tok = t[p.i++];
    if (!tok) throw new Error("unexpected end");
    if (tok.kind === "number") return { t: "num", f: C(Number(tok.text.replace(/[_dDfFlL]$/g, "").replace(/_/g, ""))) };
    if (tok.kind === "string") return { t: "str", s: tok.text.slice(1, -1) };
    if (tok.text === "true" || tok.text === "false") return { t: "bool", b: tok.text === "true" };
    if (tok.text === "null") return { t: "null" };
    if (tok.text === "(") {
      const c = matchClose(t, p.i - 1, "(", ")");
      const v = this.evalToks(t.slice(p.i, c), env, self, trace);
      p.i = c + 1;
      return v;
    }
    if (tok.text === "new") {
      let type = t[p.i++].text;
      while (t[p.i]?.text === ".") {
        type += `.${t[p.i + 1].text}`;
        p.i += 2;
      }
      if (t[p.i]?.text === "<") p.i = matchClose(t, p.i, "<", ">") + 1;
      if (t[p.i]?.text === "[") {
        // arrays: new X[] { ... }
        while (t[p.i] && t[p.i].text !== "{") p.i++;
        const c = matchClose(t, p.i, "{", "}");
        const items = this.listItems(t.slice(p.i + 1, c), env, self, trace);
        p.i = c + 1;
        return { t: "list", items };
      }
      const a0 = p.i;
      const args = this.args(t, p, env, self, trace);
      if (t[p.i]?.text === "{") p.i = matchClose(t, p.i, "{", "}") + 1; // anonymous class body
      return this.construct(type, args, t.slice(a0 - 2, p.i), tok.line);
    }
    if (tok.text === "this") {
      if (t[p.i]?.text === ":" && t[p.i + 1]?.text === ":") {
        p.i += 3;
        return { t: "lambda", src: `${t[p.i - 1].text}()`, line: tok.line };
      }
      return self ?? { t: "unknown", src: "this", line: tok.line };
    }
    if (tok.text === "super") return self ?? { t: "unknown", src: "super", line: tok.line };
    if (tok.kind === "ident") {
      // method reference Name::method
      if (t[p.i]?.text === ":" && t[p.i + 1]?.text === ":") {
        p.i += 3;
        return { t: "lambda", src: `${tok.text}.${t[p.i - 1].text}()`, line: tok.line };
      }
      if (t[p.i]?.text === "(") {
        const args = this.args(t, p, env, self, trace);
        return this.callFree(tok.text, args, self, tok.line, trace);
      }
      return this.name(tok.text, env, self, tok.line);
    }
    throw new Error(`unexpected "${tok.text}"`);
  }
  private listItems(t: Tok[], env: Map<string, V>, self: any, trace: Step[] | null): V[] {
    const out: V[] = [];
    let s = 0;
    let d = 0;
    for (let k = 0; k <= t.length; k++) {
      const x = t[k]?.text;
      if (x && "({[".includes(x)) d++;
      else if (x && ")}]".includes(x)) d--;
      else if (k === t.length || (x === "," && d === 0)) {
        if (k > s) out.push(this.evalToks(t.slice(s, k), env, self, trace));
        s = k + 1;
      }
    }
    return out;
  }
  private postfix(t: Tok[], p: { i: number }, v: V, env: Map<string, V>, self: any, trace: Step[] | null, st = false): V {
    while (t[p.i]?.text === ".") {
      const n = t[p.i + 1];
      p.i += 2;
      if (t[p.i]?.text === "(") {
        const a0 = p.i;
        const args = this.args(t, p, env, self, trace);
        v = this.call(v, n.text, args, n.line, trace, t.slice(Math.max(0, a0 - 6), p.i), st && t[p.i]?.text !== ".");
      } else v = this.member(v, n.text, n.line);
    }
    if (t[p.i]?.text === "[") p.i = matchClose(t, p.i, "[", "]") + 1;
    return v;
  }

  // -- names, fields, statics --
  private name(n: string, env: Map<string, V>, self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> } | null, line: number): V {
    if (env.has(n)) return env.get(n)!;
    if (self) {
      const f = this.field(self, n);
      if (f) return f;
    }
    // static field of an enclosing / imported class
    const cls = self?.cls;
    for (let c: ClassInfo | null | undefined = cls; c; c = c.outer) {
      if (c.fields.get(n)?.isStatic) return this.staticField(c.name, n) ?? { t: "unknown", src: n, line };
    }
    const owner = cls?.staticImports.get(n);
    if (owner && this.classes.has(owner)) return this.staticField(owner, n) ?? { t: "unknown", src: n, line };
    if (this.classes.has(n) || /^[A-Z]/.test(n)) return { t: "obj", type: `class:${n}`, args: [], calls: [], src: n, line };
    return { t: "unknown", src: n, line };
  }
  private field(inst: { t: "inst"; cls: ClassInfo; fields: Map<string, V> }, n: string): V | null {
    if (inst.fields.has(n)) return inst.fields.get(n)!;
    for (let c: ClassInfo | undefined = inst.cls; c; c = c.ext ? this.classes.get(c.ext) : undefined) {
      const f = c.fields.get(n);
      if (!f) continue;
      if (f.isStatic) return this.staticField(c.name, n);
      inst.fields.set(n, { t: "unknown", src: n, line: f.line }); // cycle guard
      let v: V = f.toks.length ? this.evalToks(f.toks, new Map(), inst, null) : { t: "null" as const };
      // the pose is what the field's own line says (along(0.25)), not the helper's body
      if (v.t === "pose") v = { ...v, name: v.name ?? n, src: tokText(f.toks) };
      inst.fields.set(n, v);
      return v;
    }
    return null;
  }
  staticField(cls: string, n: string): V | null {
    const key = `${cls}.${n}`;
    if (this.staticMemo.has(key)) return this.staticMemo.get(key)!;
    const c = this.classes.get(cls);
    const f = c?.fields.get(n);
    if (!c || !f) return null;
    this.staticMemo.set(key, { t: "unknown", src: key, line: f.line });
    let v: V = f.toks.length ? this.evalToks(f.toks, new Map(), { t: "inst", cls: c, fields: new Map() }, null) : { t: "num", f: C(0) };
    // a value the code does not know yet (NaN) is a named unknown
    if (v.t === "num" && v.f.k === "v" && v.f.name === "NaN") v = { t: "num", f: { k: "v", name: key } };
    if (v.t === "pose") v = { ...v, name: v.name ?? n, src: tokText(f.toks) };
    this.staticMemo.set(key, v);
    return v;
  }
  private member(v: V, n: string, line: number): V {
    if (v.t === "obj" && v.type.startsWith("class:")) {
      const cls = v.type.slice(6);
      if (cls === "Double" && n === "NaN") return { t: "num", f: { k: "v", name: "NaN" } };
      if (cls === "Math" && n === "PI") return { t: "num", f: C(Math.PI) };
      if (this.classes.has(cls)) {
        const s = this.staticField(cls, n);
        if (s) return s;
      }
      // enums and nested types: Alliance.BLUE, AutoRunner.Action.SHOOT
      if (/^[A-Z][A-Z0-9_]*$/.test(n)) return { t: "enum", name: n, full: `${cls}.${n}` };
      return { t: "obj", type: `class:${n}`, args: [], calls: [], src: `${v.src}.${n}`, line };
    }
    if (v.t === "inst") return this.field(v, n) ?? { t: "unknown", src: n, line };
    if (v.t === "obj") return { t: "obj", type: `${v.type}.${n}`, args: [], calls: [], src: `${v.src}.${n}`, line };
    return { t: "unknown", src: n, line };
  }

  // -- construction and calls --
  private construct(type: string, args: V[], toks: Tok[], line: number): V {
    const simple = type.split(".").pop()!;
    if (simple === "Pose" && args.length >= 2) return this.pose(args[0], args[1], args[2] ? this.radToDeg(args[2]) : { t: "num", f: C(0) }, toks, line);
    if (simple === "Point" && args.length >= 2) return this.pose(args[0], args[1], { t: "num", f: C(0) }, toks, line);
    if (simple === "BezierLine" || simple === "BezierCurve" || simple === "BezierPoint") {
      const pts = args.filter((a): a is PoseV => a.t === "pose");
      return { t: "path", kind: simple === "BezierCurve" ? "curve" : "line", pts, heading: null, line };
    }
    const cls = this.classes.get(simple);
    if (cls && this.depth < 25) {
      // the team's own class: run its constructor and field initializers
      const inst: { t: "inst"; cls: ClassInfo; fields: Map<string, V>; line?: number; args?: V[] } = { t: "inst", cls, fields: new Map(), line, args };
      // the constructor whose parameter types fit the arguments (Leg(Path, Action) vs Leg(Pose, Action))
      const fits = (type: string, v: V) => (/^(double|float|int|long|short|Double|Integer)$/.test(type) ? v.t === "num" : type === "Pose" ? v.t === "pose" : /Path|Chain/.test(type) ? v.t === "path" || v.t === "chain" : true);
      const ctor = cls.ctors.filter((c) => c.params.length === args.length).find((c) => c.types.every((ty, k) => fits(ty, args[k]))) ?? cls.ctors.find((c) => c.params.length === args.length);
      if (ctor) {
        const env = new Map<string, V>();
        ctor.params.forEach((pn, k) => env.set(pn, args[k] ?? { t: "unknown", src: pn, line }));
        this.depth++;
        this.exec(ctor.body, env, inst, null);
        this.depth--;
      }
      return inst;
    }
    return { t: "obj", type: simple, args, calls: [], src: toks.map((x) => x.text).join(" "), line };
  }
  private radToDeg(v: V): V {
    return v.t === "num" ? { t: "num", f: mk("toDeg", v.f) } : v;
  }
  private pose(x: V, y: V, h: V, toks: Tok[], line: number): PoseV {
    const n = (v: V): F => (v.t === "num" ? v.f : { k: "v", name: `?${v.t === "unknown" ? v.src : v.t}` });
    return { t: "pose", x: n(x), y: n(y), h: n(h), src: toks.map((x) => x.text).join(" ").replace(/\s*([(),.])\s*/g, "$1").replace(/,/g, ", "), line };
  }
  private callFree(name: string, args: V[], self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> } | null, line: number, trace: Step[] | null): V {
    // a method of this class (or an enclosing / parent class), or a statically imported one
    for (let c: ClassInfo | null | undefined = self?.cls; c; c = c.outer ?? (c.ext ? this.classes.get(c.ext) : undefined)) {
      const m = c.methods.get(name);
      if (m) return this.invoke(c, m, args, self && (self.cls === c || !m.isStatic) ? self : { t: "inst", cls: c, fields: new Map() }, line, trace, name);
    }
    const owner = self?.cls.staticImports.get(name);
    const oc = owner ? this.classes.get(owner) : undefined;
    const om = oc?.methods.get(name);
    if (oc && om) return this.invoke(oc, om, args, { t: "inst", cls: oc, fields: new Map() }, line, trace, name);
    this.record(trace, { kind: "action", text: `${name}(${args.map(show).join(", ")})`, line, file: self?.cls.file ?? "" });
    return { t: "unknown", src: `${name}()`, line };
  }
  private invoke(c: ClassInfo, m: { params: string[]; body: Tok[]; returns: string }, args: V[], self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> }, line: number, trace: Step[] | null, name: string): V {
    if (this.depth > 25) return { t: "unknown", src: `${name}()`, line };
    // helpers the reader understands better than their code (loops inside)
    if (/^wrap(Deg|Degrees|Angle)$/i.test(name) && args[0]?.t === "num") return { t: "num", f: mk("wrapDeg", args[0].f) };
    const env = new Map<string, V>();
    m.params.forEach((pn, k) => env.set(pn, args[k] ?? { t: "unknown", src: pn, line }));
    this.depth++;
    const r = this.exec(m.body, env, self, m.returns === "void" ? trace : null);
    this.depth--;
    return r ?? { t: "null" };
  }
  private call(recv: V, name: string, args: V[], line: number, trace: Step[] | null, toks: Tok[], statement: boolean): V {
    // numbers and poses
    if (recv.t === "obj" && recv.type === "class:Math") {
      const fn = { toRadians: "toRad", toDegrees: "toDeg", sin: "sin", cos: "cos", tan: "tan", atan2: "atan2", sqrt: "sqrt", abs: "abs", min: "min", max: "max", hypot: "hypot", pow: "pow", round: "round" }[name];
      if (fn && args.every((a) => a.t === "num")) return { t: "num", f: mk(fn, ...args.map((a) => (a as { f: F }).f)) };
    }
    if (recv.t === "obj" && recv.type === "class:PoseFactory" && (name === "degrees" || name === "radians")) return { t: "factory", deg: name === "degrees" };
    if (recv.t === "factory") {
      if (name === "of" && args.length >= 2) return this.pose(args[0], args[1], recv.deg ? (args[2] ?? { t: "num", f: C(0) }) : this.radToDeg(args[2] ?? { t: "num", f: C(0) }), toks, line);
      return recv; // mirror/map: the blue drawing is what is read
    }
    if (recv.t === "pose") {
      if (name === "x" || name === "getX") return { t: "num", f: recv.x };
      if (name === "y" || name === "getY") return { t: "num", f: recv.y };
      if (name === "heading" || name === "getHeading") return { t: "num", f: mk("toRad", recv.h) };
      if (name === "copy") return recv;
      if (name === "withHeading" || name === "setHeading") return { ...recv, h: args[0]?.t === "num" ? mk("toDeg", args[0].f) : recv.h };
    }
    // Pedro 3 paths
    if (recv.t === "obj" && recv.type === "class:Paths" && (name === "line" || name === "curve" || name === "through")) {
      return { t: "path", kind: name, pts: args.filter((a): a is PoseV => a.t === "pose"), heading: null, line };
    }
    if (recv.t === "path") {
      const pose = (v?: V) => (v?.t === "pose" ? v : undefined);
      if (name === "linear") return { ...recv, heading: { mode: "linear", ...(args[0]?.t === "pose" ? { a: args[0].h } : args[0]?.t === "num" ? { a: args[0].f } : {}), ...(args[1]?.t === "pose" ? { b: args[1].h } : args[1]?.t === "num" ? { b: args[1].f } : {}) } };
      if (name === "constant") return { ...recv, heading: { mode: "constant", ...(pose(args[0]) ? { pose: pose(args[0]) } : {}) } };
      if (name === "tangent" || name === "reverseTangent") return { ...recv, heading: { mode: name } };
      if (name === "facingPoint") return { ...recv, heading: { mode: "facingPoint", ...(pose(args[0]) ? { pose: pose(args[0]) } : {}) } };
      return recv;
    }
    // Pedro 2 path builder: follower.pathBuilder().addPath(...).setLinearHeadingInterpolation(a, b)...build()
    if (name === "pathBuilder") return { t: "chain", paths: [], line };
    if (recv.t === "chain") {
      if (name === "addPath" || name === "addBezierLine" || name === "addBezierCurve") {
        const p = args.find((a): a is PathV => a.t === "path") ?? (args.every((a) => a.t === "pose") && args.length >= 2 ? { t: "path" as const, kind: (args.length > 2 ? "curve" : "line") as "curve" | "line", pts: args as PoseV[], heading: null, line } : null);
        return p ? { ...recv, paths: [...recv.paths, p] } : recv;
      }
      if (/^set(Linear|Constant|Tangent|Reverse)/.test(name) && recv.paths.length) {
        const last = recv.paths[recv.paths.length - 1];
        const h: PathV["heading"] = name.startsWith("setLinear")
          ? { mode: "linear", ...(args[0]?.t === "num" ? { a: mk("toDeg", args[0].f) } : {}), ...(args[1]?.t === "num" ? { b: mk("toDeg", args[1].f) } : {}) }
          : name.startsWith("setConstant")
            ? { mode: "constant", ...(args[0]?.t === "num" ? { a: mk("toDeg", args[0].f) } : {}) }
            : { mode: name.startsWith("setReverse") ? "reverseTangent" : "tangent" };
        return { ...recv, paths: [...recv.paths.slice(0, -1), { ...last, heading: h }] };
      }
      return recv; // build(), setBrakingStrength(...), ...
    }
    // lists
    if (recv.t === "obj" && (recv.type === "class:Arrays" || recv.type === "class:List") && (name === "asList" || name === "of")) return { t: "list", items: args };
    // the team's classes: getters run, void methods are actions
    if (recv.t === "inst") {
      for (let c: ClassInfo | undefined = recv.cls; c; c = c.ext ? this.classes.get(c.ext) : undefined) {
        const m = c.methods.get(name);
        if (m) {
          if (m.returns === "void") {
            this.record(trace, { kind: "action", text: `${actionReceiver(toks)}${name}(${args.map(show).join(", ")})`, line, file: c.file });
            return { t: "null" };
          }
          return this.invoke(c, m, args, recv, line, trace, name);
        }
      }
    }
    if (recv.t === "obj" && recv.type.startsWith("class:")) {
      const cls = this.classes.get(recv.type.slice(6));
      const m = cls?.methods.get(name);
      if (cls && m) return this.invoke(cls, m, args, { t: "inst", cls, fields: new Map() }, line, trace, name);
    }
    // a builder call on a constructed object (Leg.timeout(4), command.andThen(...)) or an action on something
    if (recv.t === "obj" && !recv.type.startsWith("class:")) {
      const known = /^[A-Z]/.test(recv.type.split(".").pop() ?? "");
      if (known) return { ...recv, calls: [...recv.calls, { name, args, line }] };
    }
    if (statement || trace) this.record(trace, { kind: "action", text: `${actionReceiver(toks)}${name}(${args.map(show).join(", ")})`, line, file: "" });
    return { t: "unknown", src: `${name}()`, line };
  }
  private record(trace: Step[] | null, s: Step) {
    if (trace) trace.push(s);
  }
}

function tokText(t: Tok[]): string {
  return t.map((x) => x.text).join(" ").replace(/\s*([(),.\[\]])\s*/g, "$1").replace(/,/g, ", ");
}

// the receiver text of a call, e.g. "robot.intake." for robot.intake.gateOpen()
function actionReceiver(toks: Tok[]): string {
  const txt = toks.map((x) => x.text).join("");
  const m = /([A-Za-z_][\w.]*\.)\w+\(/.exec(txt);
  return m ? m[1].replace(/^.*?\b(?=[a-z])/, "") : "";
}

function show(v: V): string {
  switch (v.t) {
    case "num": {
      const n = fEval(v.f);
      return n === null ? "?" : String(Math.round(n * 1000) / 1000);
    }
    case "str":
      return JSON.stringify(v.s);
    case "bool":
      return String(v.b);
    case "enum":
      return v.full;
    case "pose":
      return v.name ?? "pose";
    case "lambda":
      return `() -> ${v.src}`;
    case "obj":
      return v.type.replace(/^class:/, "");
    default:
      return v.t === "unknown" ? v.src : v.t;
  }
}

// ---- turning the run into steps ---------------------------------------------------------------

function msOf(v: V | undefined): number | undefined {
  if (v?.t !== "num") return undefined;
  const n = fEval(v.f);
  return n === null ? undefined : n;
}

// Walks a command tree (FTCLib and similar) into ordered steps; parallel children get a group tag.
function walkCommand(v: V, out: Step[], file: string, group: string | undefined, offsetMs: number) {
  if (v.t === "lambda") {
    out.push({ kind: "action", text: v.src, line: v.line, file, group, ms: offsetMs });
    return;
  }
  if (v.t === "list") {
    for (const x of v.items) walkCommand(x, out, file, group, offsetMs);
    return;
  }
  // the team's own command classes are read by their constructor arguments, like any other command
  if (v.t === "inst" && v.args) v = { t: "obj", type: v.cls.name, args: v.args, calls: [], src: v.cls.name, line: v.line ?? 0 };
  if (v.t !== "obj") return;
  const type = v.type;
  if (/^Sequential(Command)?Group$/.test(type)) {
    let t = offsetMs;
    for (const a of v.args) {
      walkCommand(a, out, file, group, t);
      if (a.t === "obj" && a.type === "WaitCommand" && group) t += msOf(a.args[0]) ?? 0;
    }
    return;
  }
  if (/^Parallel(Command|Race|Deadline)?Group$/.test(type) || type === "ParallelRaceGroup" || type === "ParallelDeadlineGroup") {
    const tag = `${group ? `${group}>` : ""}${type === "ParallelRaceGroup" ? "race" : "parallel"}@${v.line}`;
    for (const a of v.args) walkCommand(a, out, file, tag, 0);
    return;
  }
  if (type === "WaitCommand" || type === "WaitUntilCommand") {
    out.push({ kind: "wait", text: `wait ${type === "WaitCommand" ? `${msOf(v.args[0]) ?? "?"} ms` : "until a condition"}`, line: v.line, file, ms: msOf(v.args[0]), group });
    return;
  }
  if (type === "InstantCommand" || type === "RunCommand") {
    for (const a of v.args) if (a.t === "lambda") out.push({ kind: "action", text: a.src, line: a.line, file, group, ms: offsetMs });
    return;
  }
  // any command that carries a path or poses is a drive
  const path = v.args.find((a): a is PathV => a.t === "path");
  const chain = v.args.find((a): a is { t: "chain"; paths: PathV[]; line: number } => a.t === "chain");
  const poses = v.args.filter((a): a is PoseV => a.t === "pose");
  if (chain) for (const p of chain.paths) out.push({ kind: "drive", text: type, line: v.line, file, path: p, group });
  else if (path) out.push({ kind: "drive", text: type, line: v.line, file, path, group });
  else if (poses.length === 1) out.push({ kind: "drive", text: `${type} to ${poses[0].name ?? "a pose"} from where the robot is`, line: v.line, file, target: poses[0], group });
  else if (/current/i.test(type)) {
    // DriveCurrentToPoint(follower, control..., target): from wherever the robot is, through the control points
    out.push({ kind: "drive", text: `${type}: from where the robot is via ${poses.slice(0, -1).map((p) => p.name ?? "a point").join(", ")} to ${poses[poses.length - 1].name ?? "a pose"}`, line: v.line, file, target: poses[poses.length - 1], group, path: { t: "path", kind: "curve", pts: [{ t: "pose", x: { k: "v", name: "?current" }, y: { k: "v", name: "?current" }, h: { k: "v", name: "?current" }, src: "the robot's pose", line: v.line, name: "@current" }, ...poses], heading: null, line: v.line } });
  } else if (poses.length === 2) out.push({ kind: "drive", text: type, line: v.line, file, path: { t: "path", kind: "line", pts: poses, heading: null, line: v.line }, group });
  else if (poses.length > 2) {
    // DriveCurrentToPoint(follower, control, end): from where the robot is, through the control point
    out.push({ kind: "drive", text: `${type} via ${poses.slice(0, -1).map((p) => p.name ?? "a point").join(", ")}`, line: v.line, file, target: poses[poses.length - 1], group, path: { t: "path", kind: "curve", pts: poses, heading: null, line: v.line } });
  } else out.push({ kind: "action", text: `${type}(${v.args.map(show).join(", ")})`, line: v.line, file, group, ms: offsetMs });
  for (const c of v.calls) out.push({ kind: "action", text: `.${c.name}(${c.args.map(show).join(", ")})`, line: c.line, file, group });
}

function legSteps(list: V, file: string): Step[] {
  const out: Step[] = [];
  const items = list.t === "list" ? list.items : [];
  for (const it of items) {
    // a leg is either an object the reader could not open (args + builder calls) or the team's Leg class (fields)
    let vals: V[];
    let timeoutV: V | undefined;
    let carryV: V | undefined;
    // the newer AutoRunner.Leg options: builder calls, or the Leg object's fields
    const opts: NonNullable<Step["opts"]> = {};
    const num = (v?: V) => (v?.t === "num" ? (fEval(v.f) ?? undefined) : undefined);
    if (it.t === "obj" && /Leg$/.test(it.type)) {
      vals = it.args;
      const c = (n: string) => it.calls.find((x) => x.name === n)?.args[0];
      timeoutV = c("timeout");
      carryV = c("carryIntake");
      const shot = num(c("shotTimeout"));
      if (shot !== undefined) opts.shotTimeoutS = shot;
      const wait = num(c("waitFor"));
      if (wait !== undefined) opts.waitS = wait;
    } else if (it.t === "inst" && /Leg$/.test(it.cls.name)) {
      vals = [...it.fields.values()];
      const f = (re: RegExp) => [...it.fields.entries()].find(([k]) => re.test(k))?.[1];
      // the field names of AutoRunner.Leg: timeoutS is the leg timeout; shotTimeoutS is a different option and
      // must not be read as the leg's timeout
      timeoutV = f(/^timeout/i);
      carryV = f(/^carry/i);
      if (carryV?.t === "num" && fEval(carryV.f) === 0) carryV = undefined;
      const shot = num(f(/^shotTimeout/i));
      if (shot !== undefined) opts.shotTimeoutS = shot;
      const wait = num(f(/^wait/));
      if (wait) opts.waitS = wait;
    } else continue;
    // new Leg(p, During.X, End.Y), or the shortcut new Leg(p, Action.X)
    const enums = vals.filter((a): a is { t: "enum"; name: string; full: string } => a.t === "enum");
    const of = (type: string) => enums.find((e) => e.full === `${type}.${e.name}`)?.name;
    let during = of("During") as Step["during"];
    let end = of("End") as Step["end"];
    if (!during || !end) {
      const a = ACTIONS[of("Action") ?? enums.find((e) => e.name in ACTIONS)?.name ?? "NONE"] ?? ACTIONS.NONE;
      during ??= a.during;
      end ??= a.end;
    }
    if (end !== "SHOOT") delete opts.shotTimeoutS;
    if (end !== "WAIT") delete opts.waitS;
    const action = during === "NONE" ? end : end === "NONE" ? during : `${during} -> ${end}`;
    const path = vals.find((a): a is PathV => a.t === "path");
    const target = vals.find((a): a is PoseV => a.t === "pose");
    const timeout = timeoutV ? { args: [timeoutV] } : undefined;
    const carry = carryV ? { args: [carryV] } : undefined;
    out.push({
      kind: "drive",
      text: path ? `${path.kind} ${path.pts.map((p) => p.name ?? "pose").join(" -> ")}, then ${action}` : `straight to ${target?.name ?? "a pose"} from where the robot is, then ${action}`,
      line: it.line ?? 0,
      file,
      ...(path ? { path } : {}),
      ...(target && !path ? { target } : {}),
      during,
      end,
      ...(timeout ? { timeoutS: msOf(timeout.args[0]) } : {}),
      ...(carry ? { carryS: msOf(carry.args[0]) } : {}),
      ...(Object.keys(opts).length ? { opts } : {}),
    });
  }
  return out;
}

// Reads the auto in `entry` (an OpMode or a route class), with every other file of the repo available.
export function readAuto(files: { path: string; text: string }[], entry: string, defaultRoute?: string): ReadResult {
  const I = new Interp(files);
  const entryText = files.find((f) => f.path === entry)?.text ?? "";
  const entryClasses = parseClasses(entry, entryText);
  const top = entryClasses.find((c) => !c.outer) ?? entryClasses[0];
  if (!top) return { framework: "unknown", start: null, poses: [], steps: [], unknowns: [], skipped: [{ line: 1, text: "no class found" }] };
  const steps: Step[] = [];
  let framework = "OpMode";
  let start: PoseV | null = null;
  let intakeAlwaysOn = false;
  const inst = { t: "inst" as const, cls: I.classes.get(top.name) ?? top, fields: new Map<string, V>() };

  // a route class (AutoRunner style): legs() + start(), possibly nested (class Plan) or the default route
  const routeClass = [top, ...entryClasses].find((c) => c.methods.has("legs") && c.methods.has("start")) ?? (top.ext && !top.methods.has("route") && defaultRoute ? I.classes.get(defaultRoute) : undefined);
  if (routeClass) {
    framework = "AutoRunner legs";
    const r = { t: "inst" as const, cls: I.classes.get(routeClass.name) ?? routeClass, fields: new Map<string, V>() };
    const sv = I.exec(routeClass.methods.get("start")!.body, new Map(), r, null);
    if (sv?.t === "pose") start = sv;
    const lv = I.exec(routeClass.methods.get("legs")!.body, new Map(), r, null);
    if (lv) steps.push(...legSteps(lv, routeClass.file));
    const ia = routeClass.methods.get("intakeAlways");
    if (ia) {
      const v = I.exec(ia.body, new Map(), r, null);
      if (v?.t === "bool" && v.b) intakeAlwaysOn = true;
    }
  } else {
    // an OpMode: run init() for the start pose, then start()/runOpMode() for the sequence
    const order = ["init", "runOpMode", "start"];
    for (const m of order) {
      const meth = top.methods.get(m);
      if (!meth) continue;
      const trace: Step[] = [];
      const scheduled: V[] = [];
      const self = inst;
      // CommandScheduler.schedule(x) and follower.setStartingPose(p) are what matter
      const before = I.skipped.length;
      const run = new Proxy(trace, {});
      I.exec(meth.body, new Map(), self, run);
      void before;
      for (const s of trace) {
        if (/setStartingPose|setPose/.test(s.text) && !start) {
          const name = /\(([^)]*)\)/.exec(s.text)?.[1]?.trim();
          const v = name ? (I.staticField(top.staticImports.get(name) ?? "", name) ?? null) : null;
          if (v?.t === "pose") start = v;
        }
      }
      // re-run start() collecting the scheduled command trees
      if (m !== "init") {
        const objs = collectScheduled(I, meth.body, self);
        scheduled.push(...objs);
        if (scheduled.length) {
          framework = "FTCLib commands";
          for (const sc of scheduled) walkCommand(sc, steps, top.file, undefined, 0);
        } else steps.push(...trace.filter((s) => !/telemetry|Drawing|update\(/i.test(s.text)));
      }
    }
  }
  // poses: every pose the run touched, by name
  const poses: PoseV[] = [];
  const add = (p?: PoseV) => {
    if (p && !poses.some((q) => q === p || (q.name && q.name === p.name))) poses.push(p);
  };
  add(start ?? undefined);
  for (const s of steps) {
    s.path?.pts.forEach(add);
    add(s.target);
  }
  // poses rebuilt from a named one (new Pose(A.getX(), A.getY())) take its name
  const named = [...I.staticMemo.values(), ...poses].filter((p): p is PoseV => p.t === "pose" && !!p.name);
  for (const p of poses) {
    if (p.name) continue;
    const x = fEval(p.x);
    const y = fEval(p.y);
    if (x === null || y === null) continue;
    const m = named.find((q) => fEval(q.x) === x && fEval(q.y) === y);
    if (m) {
      p.name = m.name;
      p.h = m.h; // a copy rebuilt from x and y only takes the original's heading
    }
  }
  const unknowns = [...new Set(poses.flatMap((p) => [...fVars(p.x), ...fVars(p.y), ...fVars(p.h)]))].filter((v) => !v.startsWith("?"));
  return { framework, ...(intakeAlwaysOn ? { intakeAlways: true } : {}), start, poses, steps, unknowns, skipped: I.skipped };
}

// The values handed to CommandScheduler.schedule(...) inside a method body.
function collectScheduled(I: Interp, body: Tok[], self: { t: "inst"; cls: ClassInfo; fields: Map<string, V> }): V[] {
  const out: V[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i].text === "schedule" && body[i + 1]?.text === "(") {
      const c = matchClose(body, i + 1, "(", ")");
      out.push(I.evalToks(body.slice(i + 2, c), new Map(), self, null));
      i = c;
    }
  }
  return out;
}
