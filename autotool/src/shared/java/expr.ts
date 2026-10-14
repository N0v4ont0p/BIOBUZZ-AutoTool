// Expression parser for the Java subset AutoPaths files use: literals, dotted names, calls,
// method chains, `new T(...)`, unary minus and + - * / with parentheses.

import { JavaSyntaxError, type Tok, canonNumber, code } from "./lexer.ts";

export type Expr =
  | { k: "num"; value: number; a: number; b: number }
  | { k: "name"; parts: string[]; a: number; b: number }
  | { k: "call"; callee: Expr; name: string; args: Expr[]; a: number; b: number } // callee.name(args) or name(args) when callee is null-ish
  | { k: "new"; type: string; args: Expr[]; a: number; b: number }
  | { k: "neg"; e: Expr; a: number; b: number }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; l: Expr; r: Expr; a: number; b: number }
  | { k: "other"; a: number; b: number };

// a, b = source offsets of the expression (b exclusive)

export class ExprParser {
  private toks: Tok[];
  private i = 0;
  constructor(tokens: Tok[]) {
    this.toks = code(tokens);
  }
  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new JavaSyntaxError("unexpected end of expression", this.toks[this.toks.length - 1]?.line ?? 0);
    return t;
  }
  expect(text: string): Tok {
    const t = this.next();
    if (t.text !== text) throw new JavaSyntaxError(`expected "${text}", found "${t.text}"`, t.line);
    return t;
  }
  atEnd(): boolean {
    return this.i >= this.toks.length;
  }
  pos(): number {
    return this.i;
  }

  expr(): Expr {
    return this.additive();
  }
  private additive(): Expr {
    let l = this.multiplicative();
    while (this.peek()?.text === "+" || this.peek()?.text === "-") {
      const op = this.next().text as "+" | "-";
      const r = this.multiplicative();
      l = { k: "bin", op, l, r, a: l.a, b: r.b };
    }
    return l;
  }
  private multiplicative(): Expr {
    let l = this.unary();
    while (this.peek()?.text === "*" || this.peek()?.text === "/") {
      const op = this.next().text as "*" | "/";
      const r = this.unary();
      l = { k: "bin", op, l, r, a: l.a, b: r.b };
    }
    return l;
  }
  private unary(): Expr {
    const t = this.peek();
    if (t?.text === "-") {
      this.next();
      const e = this.unary();
      return { k: "neg", e, a: t.start, b: e.b };
    }
    return this.postfix(this.primary());
  }
  private args(): { args: Expr[]; end: number } {
    this.expect("(");
    const args: Expr[] = [];
    if (this.peek()?.text === ")") return { args, end: this.next().start + 1 };
    for (;;) {
      args.push(this.expr());
      const t = this.next();
      if (t.text === ")") return { args, end: t.start + 1 };
      if (t.text !== ",") throw new JavaSyntaxError(`expected "," or ")", found "${t.text}"`, t.line);
    }
  }
  private primary(): Expr {
    const t = this.next();
    if (t.kind === "number") return { k: "num", value: Number(canonNumber(t.text)), a: t.start, b: t.start + t.text.length };
    if (t.text === "(") {
      const e = this.expr();
      const c = this.expect(")");
      return { ...e, a: t.start, b: c.start + 1 };
    }
    if (t.kind === "ident" && t.text === "new") {
      const parts: string[] = [this.next().text];
      while (this.peek()?.text === ".") {
        this.next();
        parts.push(this.next().text);
      }
      if (this.peek()?.text === "<") throw new JavaSyntaxError("generic new is not supported", t.line);
      const { args, end } = this.args();
      return { k: "new", type: parts.join("."), args, a: t.start, b: end };
    }
    if (t.kind === "ident") {
      const parts = [t.text];
      let b = t.start + t.text.length;
      while (this.peek()?.text === "." && this.peek(1)?.kind === "ident" && this.peek(2)?.text !== "(") {
        this.next();
        const n = this.next();
        parts.push(n.text);
        b = n.start + n.text.length;
      }
      if (this.peek()?.text === "(") {
        const { args, end } = this.args();
        const name = parts.pop()!;
        const callee: Expr = parts.length ? { k: "name", parts, a: t.start, b: t.start } : { k: "other", a: t.start, b: t.start };
        return { k: "call", callee, name, args, a: t.start, b: end };
      }
      if (this.peek()?.text === "." && this.peek(1)?.kind === "ident" && this.peek(2)?.text === "(") {
        // a.b.c.method(...) handled by postfix
        return { k: "name", parts, a: t.start, b };
      }
      return { k: "name", parts, a: t.start, b };
    }
    throw new JavaSyntaxError(`unexpected "${t.text}"`, t.line);
  }
  private postfix(e: Expr): Expr {
    while (this.peek()?.text === "." && this.peek(1)?.kind === "ident") {
      this.next();
      const n = this.next();
      if (this.peek()?.text !== "(") throw new JavaSyntaxError(`field access ".${n.text}" on an expression is not supported`, n.line);
      const { args, end } = this.args();
      e = { k: "call", callee: e, name: n.text, args, a: e.a, b: end };
    }
    return e;
  }
}

export function parseExpr(tokens: Tok[]): Expr {
  const p = new ExprParser(tokens);
  const e = p.expr();
  if (!p.atEnd()) {
    const t = p.peek()!;
    throw new JavaSyntaxError(`unexpected "${t.text}" after expression`, t.line);
  }
  return e;
}

export function dotted(e: Expr): string | null {
  return e.k === "name" ? e.parts.join(".") : null;
}

// Numeric value of an expression; names resolve through `symbols` (null = known but not set, e.g. NaN).
export function evalNumber(e: Expr, symbols: Map<string, number | null>): number | null | undefined {
  switch (e.k) {
    case "num":
      return e.value;
    case "neg": {
      const v = evalNumber(e.e, symbols);
      return v === null || v === undefined ? v : -v;
    }
    case "bin": {
      const l = evalNumber(e.l, symbols);
      const r = evalNumber(e.r, symbols);
      if (l === undefined || r === undefined) return undefined;
      if (l === null || r === null) return null;
      return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : r === 0 ? null : l / r;
    }
    case "name": {
      const key = e.parts.join(".");
      return symbols.has(key) ? symbols.get(key)! : undefined;
    }
    default:
      return undefined;
  }
}

export function isLiteral(e: Expr): boolean {
  return e.k === "num" || (e.k === "neg" && e.e.k === "num");
}

export function sourceOf(src: string, e: Expr): string {
  return src.slice(e.a, e.b);
}
