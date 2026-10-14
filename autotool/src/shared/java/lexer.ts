// A small Java lexer and class-member splitter: enough to read AutoPaths-style files exactly,
// keep comments, and compare two files token by token.

export type TokKind = "ident" | "number" | "string" | "char" | "punct" | "comment" | "ws";

export interface Tok {
  kind: TokKind;
  text: string;
  start: number; // offset in the source
  line: number; // 1-based
}

const PUNCT3 = [">>>=", "<<=", ">>=", ">>>", "...", "->", "::", "++", "--", "&&", "||", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "&=", "|=", "^=", "%=", "<<"];

export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const push = (kind: TokKind, end: number) => {
    const text = src.slice(i, end);
    out.push({ kind, text, start: i, line });
    for (const ch of text) if (ch === "\n") line++;
    i = end;
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      push("ws", j);
    } else if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      push("comment", j);
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      if (j < 0) throw new JavaSyntaxError("unclosed /* comment", line);
      push("comment", j + 2);
    } else if (c === '"') {
      if (src.startsWith('"""', i)) {
        const j = src.indexOf('"""', i + 3);
        if (j < 0) throw new JavaSyntaxError("unclosed text block", line);
        push("string", j + 3);
      } else {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\") j++;
          if (src[j] === "\n") throw new JavaSyntaxError("unclosed string", line);
          j++;
        }
        push("string", j + 1);
      }
    } else if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") j++;
        j++;
      }
      push("char", j + 1);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+[lL]?|[0-9][0-9_]*\.?[0-9_]*([eE][+-]?[0-9]+)?[fFdDlL]?|\.[0-9_]+([eE][+-]?[0-9]+)?[fFdD]?)/.exec(src.slice(i));
      push("number", i + (m ? m[0].length : 1));
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      push("ident", j);
    } else {
      const three = PUNCT3.find((p) => src.startsWith(p, i));
      push("punct", i + (three ? three.length : 1));
    }
  }
  return out;
}

export class JavaSyntaxError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

export function code(toks: Tok[]): Tok[] {
  return toks.filter((t) => t.kind !== "ws" && t.kind !== "comment");
}

// Numeric literal -> canonical text, so 60, 60.0 and 60.0d compare equal.
export function canonNumber(text: string): string {
  const v = Number(text.replace(/_/g, "").replace(/[fFdDlL]$/, ""));
  return Number.isFinite(v) ? String(v) : text;
}

export function normalizedText(toks: Tok[]): string {
  return code(toks)
    .map((t) => (t.kind === "number" ? canonNumber(t.text) : t.text))
    .join(" ");
}

export interface Member {
  kind: "field" | "method" | "other";
  name: string; // field or method name ("" if unknown)
  toks: Tok[]; // code + comments of the member itself
  leading: Tok[]; // comments/whitespace right before it
  text: string; // exact source of the member (no leading comments)
  leadingText: string;
  line: number;
}

export interface JavaFile {
  src: string;
  header: Tok[]; // package + imports
  packageName: string;
  imports: string[]; // "com.pedropathing.api.Paths", "static ..." kept with prefix
  classDoc: string; // comments between the imports and the class declaration
  classDecl: Tok[]; // "public class AutoPaths" up to "{"
  className: string;
  members: Member[];
  trailing: Tok[]; // comments/whitespace before the closing brace
  after: string; // anything after the class
}

// Splits a single top-level class into its members.
export function parseFile(src: string): JavaFile {
  const toks = lex(src);
  let k = 0;
  const skipTrivia = () => {
    while (k < toks.length && (toks[k].kind === "ws" || toks[k].kind === "comment")) k++;
  };
  const header: Tok[] = [];
  let packageName = "";
  const imports: string[] = [];
  // package and imports
  for (;;) {
    const save = k;
    skipTrivia();
    const t = toks[k];
    if (t && t.kind === "ident" && (t.text === "package" || t.text === "import")) {
      const parts: string[] = [];
      let j = k + 1;
      while (j < toks.length && toks[j].text !== ";") {
        if (toks[j].kind !== "ws" && toks[j].kind !== "comment") parts.push(toks[j].text);
        j++;
      }
      if (j >= toks.length) throw new JavaSyntaxError(`${t.text} without ;`, t.line);
      const name = parts.join("").replace(/^static/, "static ");
      if (t.text === "package") packageName = name;
      else imports.push(name);
      header.push(...toks.slice(save, j + 1));
      k = j + 1;
    } else {
      k = save;
      break;
    }
  }
  // class doc: comments before the class keyword
  const docStart = k;
  skipTrivia();
  const classDoc = toks
    .slice(docStart, k)
    .filter((t) => t.kind === "comment")
    .map((t) => t.text)
    .join("\n");
  const declStart = k;
  while (k < toks.length && toks[k].text !== "{") k++;
  if (k >= toks.length) throw new JavaSyntaxError("no class body", toks[declStart]?.line ?? 1);
  const classDecl = toks.slice(declStart, k + 1);
  const declCode = code(classDecl).map((t) => t.text);
  const ci = declCode.indexOf("class");
  if (ci < 0) throw new JavaSyntaxError("expected a class", toks[declStart].line);
  const className = declCode[ci + 1];
  k++;
  const members: Member[] = [];
  let trailing: Tok[] = [];
  for (;;) {
    const leadStart = k;
    skipTrivia();
    if (k >= toks.length) throw new JavaSyntaxError("class is not closed", toks[toks.length - 1]?.line ?? 1);
    if (toks[k].text === "}") {
      trailing = toks.slice(leadStart, k);
      break;
    }
    // leading = comments+ws before the member; keep only from the first comment after a blank line
    let leading = toks.slice(leadStart, k);
    const memStart = k;
    // A member ends at ";" (fields) or at the "}" closing a body (methods, initializer blocks,
    // nested types). Braces after "=" belong to an initializer (array init, anonymous class).
    let depth = 0;
    let parenDepth = 0;
    let sawParenAtDepth0 = false;
    let sawAssign = false;
    let end = -1;
    let isBody = false;
    let isMethod = false;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j];
      if (t.kind !== "punct") continue;
      if (t.text === "(") {
        if (depth === 0 && parenDepth === 0) sawParenAtDepth0 = true;
        parenDepth++;
      } else if (t.text === ")") parenDepth--;
      else if (t.text === "=" && depth === 0 && parenDepth === 0) sawAssign = true;
      else if (t.text === "{") {
        if (depth === 0 && parenDepth === 0 && !sawAssign) {
          isBody = true;
          isMethod = sawParenAtDepth0;
        }
        depth++;
      } else if (t.text === "}") {
        depth--;
        if (depth < 0) throw new JavaSyntaxError("unbalanced }", t.line);
        if (depth === 0 && isBody) {
          end = j;
          break;
        }
      } else if (t.text === ";" && depth === 0 && parenDepth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new JavaSyntaxError("member is not closed", toks[memStart].line);
    const mt = toks.slice(memStart, end + 1);
    const c = code(mt);
    let name = "";
    let kind: Member["kind"] = "other";
    if (isMethod) {
      const pi = c.findIndex((t) => t.text === "(");
      name = pi > 0 ? c[pi - 1].text : "";
      kind = "method";
    } else if (isBody) {
      kind = "other"; // initializer block or nested type
      const ci = c.findIndex((t) => t.text === "class" || t.text === "interface" || t.text === "enum" || t.text === "record");
      name = ci >= 0 ? (c[ci + 1]?.text ?? "") : "";
    } else {
      const ei = c.findIndex((t) => t.text === "=" || t.text === ";");
      name = ei > 0 ? c[ei - 1].text : "";
      kind = "field";
    }
    // comments separated from the member by a blank line stay with the member anyway (they precede it)
    leading = leading.filter((t) => t.kind === "comment" || t.kind === "ws");
    members.push({
      kind,
      name,
      toks: mt,
      leading,
      text: src.slice(mt[0].start, mt[mt.length - 1].start + mt[mt.length - 1].text.length),
      leadingText: leading
        .filter((t) => t.kind === "comment")
        .map((t) => t.text)
        .join("\n"),
      line: mt[0].line,
    });
    k = end + 1;
  }
  const closeTok = toks[k];
  return {
    src,
    header,
    packageName,
    imports,
    classDoc,
    classDecl,
    className,
    members,
    trailing,
    after: src.slice(closeTok.start + 1),
  };
}

// Two files are equivalent if they have the same package, the same imports (as a set), the same
// class declaration and the same members (as a multiset), comparing code tokens only and numbers
// by value. Member order and formatting do not change what an AutoPaths file does.
export function equivalentJava(a: string, b: string): { equal: boolean; why: string[] } {
  const why: string[] = [];
  let fa: JavaFile;
  let fb: JavaFile;
  try {
    fa = parseFile(a);
    fb = parseFile(b);
  } catch (e) {
    return { equal: false, why: [`parse: ${(e as Error).message}`] };
  }
  if (fa.packageName !== fb.packageName) why.push(`package ${fa.packageName} vs ${fb.packageName}`);
  const ia = new Set(fa.imports);
  const ib = new Set(fb.imports);
  for (const x of ia) if (!ib.has(x)) why.push(`import ${x} only in the first`);
  for (const x of ib) if (!ia.has(x)) why.push(`import ${x} only in the second`);
  if (normalizedText(fa.classDecl) !== normalizedText(fb.classDecl)) why.push("class declaration differs");
  const ma = fa.members.map((m) => normalizedText(m.toks)).sort();
  const mb = fb.members.map((m) => normalizedText(m.toks)).sort();
  const count = (arr: string[]) => arr.reduce((acc, s) => acc.set(s, (acc.get(s) ?? 0) + 1), new Map<string, number>());
  const ca = count(ma);
  const cb = count(mb);
  for (const [s, n] of ca) if ((cb.get(s) ?? 0) !== n) why.push(`member differs: ${s.slice(0, 160)}`);
  for (const [s, n] of cb) if ((ca.get(s) ?? 0) !== n) why.push(`member differs: ${s.slice(0, 160)}`);
  return { equal: why.length === 0, why: [...new Set(why)] };
}
