// Read access to the robot repo (for ingest and the agent's read_repo / grep tools) and the one
// guarded write path: the autos folder only, only the files the adapter writes, with a manifest of hashes.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type Store, readJson, sha256, writeFileAtomic, writeJson } from "./store.ts";

const SKIP_DIRS = new Set([".git", "build", ".gradle", "node_modules", ".idea", "work", "worktrees", ".claude", ".impeccable"]);
const TEXT_EXT = /\.(java|kt|gradle|kts|md|yaml|yml|json|properties|txt|xml|sh|py|csv|pp)$/i;
const MAX_READ = 400_000;

export interface Manifest {
  files: Record<string, { hash: string; writtenAt: string; previous: string | null; specHash: string }>;
  lastWrite?: string[]; // the files of the last Write, undone together
}

// An AutoTool auto's one file, Near_9.java / Far_6.java (numbered _2, _3 ...); Blue_Near.java / Red_Near.java
// from before the one-file format (removed when such an auto is written again); AutoRunner.java only for the
// one-time hook. The sample auto (AutoPaths) is the reference and never written.
const WRITABLE = /^((Blue|Red)_)?(Near|Far)(_[A-Za-z0-9_]+)?\.java$/;

export class RobotRepo {
  readonly root: string;
  readonly autosDir: string; // absolute
  readonly autoRunnerRel: string;

  private constructor(root: string, autosDir: string, autoRunnerRel: string) {
    this.root = root;
    this.autosDir = autosDir;
    this.autoRunnerRel = autoRunnerRel;
  }

  static open(path: string): RobotRepo {
    if (!path || !existsSync(path)) throw new Error(`robot repo not found: ${path}`);
    const root = realpathSync(path);
    const java = join(root, "TeamCode", "src", "main", "java");
    if (!existsSync(java)) throw new Error(`${root} has no TeamCode/src/main/java: is this an FTC robot repo?`);
    const runner = findFile(java, "AutoRunner.java", 8);
    if (!runner) throw new Error("no AutoRunner.java under TeamCode: the v1 adapter needs the AutoRunner leg format");
    return new RobotRepo(root, dirname(runner), relative(root, runner));
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  // Resolves a repo-relative path and refuses anything outside the repo (including via symlinks).
  resolveInside(rel: string): string {
    const abs = resolve(this.root, rel);
    const real = existsSync(abs) ? realpathSync(abs) : abs;
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error(`outside the robot repo: ${rel}`);
    const parts = relative(this.root, real).split(sep);
    if (parts.some((p) => p === ".git")) throw new Error("the .git folder is not readable");
    if (parts.some((p) => /^\.env/.test(p))) throw new Error("environment files are not readable");
    return real;
  }

  readText(rel: string): string {
    const abs = this.resolveInside(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`not a file: ${rel}`);
    if (st.size > MAX_READ) throw new Error(`file too large to read (${st.size} bytes): ${rel}`);
    const buf = readFileSync(abs);
    if (buf.includes(0)) throw new Error(`binary file: ${rel}`);
    return buf.toString("utf8");
  }

  exists(rel: string): boolean {
    try {
      return existsSync(this.resolveInside(rel));
    } catch {
      return false;
    }
  }

  list(rel = "."): string[] {
    const abs = this.resolveInside(rel);
    return readdirSync(abs, { withFileTypes: true })
      .filter((d) => !SKIP_DIRS.has(d.name) && !d.name.startsWith(".env"))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort();
  }

  // Text files under the repo (TeamCode first), for grep and the digest.
  textFiles(under = "TeamCode"): string[] {
    const out: string[] = [];
    const start = this.resolveInside(under);
    const walk = (d: string, depth: number) => {
      if (depth > 12) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".env")) continue;
        const p = join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p, depth + 1);
        else if (TEXT_EXT.test(e.name)) out.push(this.rel(p));
      }
    };
    if (existsSync(start)) walk(start, 0);
    return out.sort();
  }

  grep(pattern: string, under = ".", maxHits = 200): { file: string; line: number; text: string }[] {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const hits: { file: string; line: number; text: string }[] = [];
    for (const f of this.textFiles(under)) {
      let text: string;
      try {
        text = this.readText(f);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (hits.length >= maxHits) return hits;
        }
      }
    }
    return hits;
  }

  autosRel(): string {
    return this.rel(this.autosDir);
  }

  // The default route class AutoRunner runs (AutoPaths, or whatever the team renamed it to, e.g.
  // SampleAutoPaths), read from AutoRunner itself.
  autoPathsRel(): string {
    let name = "AutoPaths";
    try {
      const runner = readFileSync(join(this.root, this.autoRunnerRel), "utf8");
      name = /new\s+(\w+)\(\)\s*;\s*\n\s*return p;/.exec(runner)?.[1] ?? /if\s*\(!\s*(\w+)\.ready\(\)\)/.exec(runner)?.[1] ?? /(\w+)\s+paths\s*=\s*new\s+(\w+)\(\)/.exec(runner)?.[2] ?? name;
    } catch {
      /* default */
    }
    return `${this.autosRel()}/${name}.java`;
  }

  // Current commit, read from .git without running git.
  head(): string | null {
    try {
      const gitDir = join(this.root, ".git");
      const h = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      if (!h.startsWith("ref:")) return h.slice(0, 12);
      const ref = h.slice(4).trim();
      const p = join(gitDir, ref);
      if (existsSync(p)) return readFileSync(p, "utf8").trim().slice(0, 12);
      const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
      return line ? line.slice(0, 12) : null;
    } catch {
      return null;
    }
  }
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth < 0) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const r = findFile(p, name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

// --- the guarded write path ---------------------------------------------------------------

export class AutoWriter {
  private repo: RobotRepo;
  private store: Store;
  constructor(repo: RobotRepo, store: Store) {
    this.repo = repo;
    this.store = store;
  }

  private manifestPath(): string {
    return join(this.store.repoDir(this.repo.root), "manifest.json");
  }
  manifest(): Manifest {
    return readJson<Manifest>(this.manifestPath(), { files: {} });
  }

  // Only files directly in the autos folder, named like the files the v1 adapter writes.
  private target(rel: string, allowRunner = false): string {
    const name = rel.split("/").pop() ?? "";
    if (!WRITABLE.test(name) && !(allowRunner && name === "AutoRunner.java")) throw new Error(`AutoTool does not write ${name}`);
    const abs = resolve(this.repo.root, rel);
    if (dirname(abs) !== this.repo.autosDir) throw new Error(`writes are limited to ${this.repo.autosRel()}`);
    if (rel.split("/").includes("libs")) throw new Error("never writes under libs/");
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error("refusing to write through a symlink");
    return abs;
  }

  // Has the file changed since this tool last wrote it? (null = the tool never wrote it on this computer)
  changedSinceWritten(rel: string): boolean | null {
    const entry = this.manifest().files[rel];
    const abs = resolve(this.repo.root, rel);
    if (!entry) return null;
    const now = existsSync(abs) ? sha256(readFileSync(abs, "utf8")) : "";
    return now !== entry.hash;
  }

  write(rel: string, content: string, specHash: string, opts: { allowOverwriteChanged: boolean; allowRunner?: boolean }): { previous: string | null } {
    const abs = this.target(rel, opts.allowRunner);
    const previous = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    const changed = this.changedSinceWritten(rel);
    if (previous !== null && changed !== false && !opts.allowOverwriteChanged) {
      throw new Error(changed === null ? "this file was not written by AutoTool on this computer: confirm the overwrite" : "this file changed since AutoTool wrote it: confirm the overwrite");
    }
    writeFileAtomic(abs, content);
    const m = this.manifest();
    m.files[rel] = { hash: sha256(content), writtenAt: new Date().toISOString(), previous, specHash };
    writeJson(this.manifestPath(), m);
    return { previous };
  }

  // Several files as one Write: checks every target first, then writes; Undo write undoes them together.
  writeGroup(files: Map<string, string | null>, specHash: string, opts: { allowOverwriteChanged: boolean; allowRunner?: boolean; appendToLast?: boolean }): { rel: string; created: boolean }[] {
    for (const rel of files.keys()) {
      const abs = this.target(rel, opts.allowRunner);
      if (opts.allowRunner && rel.endsWith("/AutoRunner.java")) continue; // the team confirmed the hook diff
      if (existsSync(abs) && this.changedSinceWritten(rel) !== false && !opts.allowOverwriteChanged) {
        throw new Error(`${rel.split("/").pop()} ${this.changedSinceWritten(rel) === null ? "was not written by AutoTool on this computer" : "changed since AutoTool wrote it"}: confirm the overwrite`);
      }
    }
    const out = [...files].map(([rel, content]) => (content === null ? (this.remove(rel), { rel, created: false }) : { rel, created: this.write(rel, content, specHash, { allowOverwriteChanged: true, allowRunner: opts.allowRunner }).previous === null }));
    const m = this.manifest();
    m.lastWrite = [...new Set([...(opts.appendToLast ? (m.lastWrite ?? []) : []), ...files.keys()])];
    writeJson(this.manifestPath(), m);
    return out;
  }

  // Removes a file AutoTool wrote under an older name; the manifest keeps it so Undo write brings it back.
  remove(rel: string): void {
    const abs = this.target(rel);
    if (!existsSync(abs)) return;
    const previous = readFileSync(abs, "utf8");
    unlinkSync(abs);
    const m = this.manifest();
    m.files[rel] = { hash: "", writtenAt: new Date().toISOString(), previous, specHash: "removed" };
    writeJson(this.manifestPath(), m);
  }

  // Undo restores only what the tool wrote, and only if nobody changed it since.
  undo(rel: string): { restored: boolean; reason?: string } {
    const m = this.manifest();
    const entry = m.files[rel];
    if (!entry || entry.specHash === "") return { restored: false, reason: "nothing to undo for this file" };
    if (this.changedSinceWritten(rel)) return { restored: false, reason: "the file changed since AutoTool wrote it; not touching it" };
    const abs = this.target(rel, true);
    if (entry.previous === null) {
      // AutoTool created it: undo removes it
      if (existsSync(abs)) unlinkSync(abs);
      delete m.files[rel];
      writeJson(this.manifestPath(), m);
      return { restored: true };
    }
    writeFileAtomic(abs, entry.previous);
    m.files[rel] = { hash: sha256(entry.previous), writtenAt: new Date().toISOString(), previous: null, specHash: "" };
    writeJson(this.manifestPath(), m);
    return { restored: true };
  }
}
