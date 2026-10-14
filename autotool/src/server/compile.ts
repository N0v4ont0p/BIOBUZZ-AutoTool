// Compile checks for the robot repo, run BEFORE anything is written:
//  - "javac": the JDK compiler on TeamCode's sources (with the new file swapped in) against the exact
//    jars Gradle downloaded for build.dependencies.gradle (found in ~/.gradle/caches, POMs followed),
//    plus android.jar. A few seconds. Same compiler and same API jars as the Gradle build.
//  - "gradle": ./gradlew :TeamCode:compileDebugJavaWithJavac --offline, on request (slower).
// If neither can run, it says so instead of guessing.

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { RobotRepo } from "./repo.ts";
import { sha256 } from "./store.ts";

export interface CompileError {
  file: string;
  line: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  method: "javac" | "gradle";
  available: boolean;
  why?: string; // when not available
  errors: CompileError[];
  output: string;
  ms: number;
}

interface Coord {
  group: string;
  artifact: string;
  version: string;
}

const GRADLE_FILES = join(homedir(), ".gradle", "caches", "modules-2", "files-2.1");

function findArtifact(c: Coord): { file: string; pom: string | null } | null {
  const dir = join(GRADLE_FILES, c.group, c.artifact, c.version);
  if (!existsSync(dir)) return null;
  let jar = "";
  let aar = "";
  let pom: string | null = null;
  for (const h of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, h))) {
      const p = join(dir, h, f);
      if (f === `${c.artifact}-${c.version}.jar` || (f === `${c.artifact}-${c.version}-no-tzdb.jar` && !jar)) jar = p;
      else if (f === `${c.artifact}-${c.version}.aar`) aar = p;
      else if (f === `${c.artifact}-${c.version}.pom`) pom = p;
    }
  }
  const file = jar || aar;
  return file || pom ? { file, pom } : null;
}

function pomDeps(pomPath: string): Coord[] {
  const xml = readFileSync(pomPath, "utf8");
  const props = new Map<string, string>();
  const propBlock = /<properties>([\s\S]*?)<\/properties>/.exec(xml)?.[1] ?? "";
  for (const m of propBlock.matchAll(/<([\w.\-]+)>([^<]*)<\/\1>/g)) props.set(m[1], m[2]);
  const sub = (s: string) => s.replace(/\$\{([^}]+)\}/g, (_, k) => props.get(k) ?? "");
  const depsBlock = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(xml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, ""))?.[1] ?? "";
  const out: Coord[] = [];
  for (const d of depsBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const get = (t: string) => sub(new RegExp(`<${t}>([^<]*)</${t}>`).exec(d[1])?.[1]?.trim() ?? "");
    const scope = get("scope") || "compile";
    if (scope === "test" || scope === "provided" || get("optional") === "true") continue;
    const v = get("version").replace(/^\[([^,\]]+).*$/, "$1");
    if (get("groupId") && get("artifactId") && v) out.push({ group: get("groupId"), artifact: get("artifactId"), version: v });
  }
  return out;
}

export function declaredDeps(repo: RobotRepo): Coord[] {
  const out: Coord[] = [];
  for (const f of ["build.dependencies.gradle", "TeamCode/build.gradle"]) {
    if (!repo.exists(f)) continue;
    const text = repo.readText(f);
    for (const m of text.matchAll(/(?:implementation|api|compileOnly)\s*\(?\s*['"]([^'":]+):([^'":]+):([^'"]+)['"]/g)) out.push({ group: m[1], artifact: m[2], version: m[3] });
  }
  return out;
}

function androidJar(repo: RobotRepo): string | null {
  let sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";
  if (repo.exists("local.properties")) {
    const m = /^sdk\.dir=(.*)$/m.exec(repo.readText("local.properties"));
    if (m) sdk = m[1].trim().replace(/\\:/g, ":").replace(/\\\\/g, "\\");
  }
  if (!sdk) sdk = join(homedir(), "Library", "Android", "sdk");
  const plat = join(sdk, "platforms");
  if (!existsSync(plat)) return null;
  const vs = readdirSync(plat)
    .filter((d) => /^android-\d+$/.test(d) && existsSync(join(plat, d, "android.jar")))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  return vs.length ? join(plat, vs[0], "android.jar") : null;
}

// Classpath: declared deps and what their POMs pull in (androidx and test libraries skipped).
export function classpath(repo: RobotRepo, cacheDir: string): { jars: string[]; missing: string[] } {
  const seen = new Set<string>();
  const jars: string[] = [];
  const missing: string[] = [];
  const queue = declaredDeps(repo).map((c) => ({ c, depth: 0 }));
  while (queue.length) {
    const { c, depth } = queue.shift()!;
    const key = `${c.group}:${c.artifact}`;
    if (seen.has(key) || c.group.startsWith("androidx") || c.group.startsWith("com.android") || c.group === "junit" || depth > 4) continue;
    seen.add(key);
    const a = findArtifact(c);
    if (!a) {
      missing.push(`${key}:${c.version}`);
      continue;
    }
    if (a.file.endsWith(".jar")) jars.push(a.file);
    else if (a.file.endsWith(".aar")) {
      const out = join(cacheDir, `${c.group}-${c.artifact}-${c.version}`);
      if (!existsSync(join(out, "classes.jar"))) {
        mkdirSync(out, { recursive: true });
        const r = spawnSync("unzip", ["-q", "-o", a.file, "classes.jar", "libs/*", "-d", out], { encoding: "utf8" });
        if (!existsSync(join(out, "classes.jar"))) {
          missing.push(`${key}:${c.version} (could not unpack: ${r.stderr || r.error?.message || "unzip"})`);
          continue;
        }
      }
      jars.push(join(out, "classes.jar"));
      const libs = join(out, "libs");
      if (existsSync(libs)) for (const l of readdirSync(libs)) if (l.endsWith(".jar")) jars.push(join(libs, l));
    }
    if (a.pom) for (const d of pomDeps(a.pom)) queue.push({ c: d, depth: depth + 1 });
  }
  return { jars, missing };
}

function javacPath(): string | null {
  const home = process.env.JAVA_HOME;
  if (home && existsSync(join(home, "bin", "javac"))) return join(home, "bin", "javac");
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["javac"], { encoding: "utf8" });
  const p = r.stdout?.split("\n")[0]?.trim();
  if (!p) return null;
  const v = spawnSync(p, ["-version"], { encoding: "utf8" });
  const m = /javac (\d+)/.exec((v.stdout || "") + (v.stderr || ""));
  return m && Number(m[1]) >= 17 ? p : null;
}

function parseErrors(output: string, map: (file: string) => string): CompileError[] {
  const errs: CompileError[] = [];
  for (const m of output.matchAll(/^(.+?\.java):(\d+): error: (.*)$/gm)) errs.push({ file: map(m[1]), line: Number(m[2]), message: m[3] });
  return errs;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20_000_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

// overrides: repo-relative path -> new content (the files about to be written); null = about to be removed
export async function javacCheck(repo: RobotRepo, overrides: Map<string, string | null>, cacheDir: string): Promise<CompileResult> {
  const t0 = Date.now();
  const javac = javacPath();
  const base: CompileResult = { ok: false, method: "javac", available: false, errors: [], output: "", ms: 0 };
  if (!javac) return { ...base, why: "no JDK 17+ javac found (set JAVA_HOME)" };
  const aj = androidJar(repo);
  if (!aj) return { ...base, why: "no Android SDK android.jar (set sdk.dir in local.properties or ANDROID_HOME)" };
  mkdirSync(cacheDir, { recursive: true });
  const cp = classpath(repo, join(cacheDir, "aar"));
  if (!cp.jars.length) return { ...base, why: `no dependency jars in the Gradle cache (build the robot app once in Android Studio): ${cp.missing.join(", ")}` };
  const work = join(cacheDir, `run-${sha256(String(Date.now() + Math.random())).slice(0, 8)}`);
  const overlay = join(work, "src");
  const classes = join(work, "classes");
  mkdirSync(overlay, { recursive: true });
  mkdirSync(classes, { recursive: true });
  const sources: string[] = [];
  const back = new Map<string, string>();
  for (const f of repo.textFiles("TeamCode/src/main/java")) {
    if (!f.endsWith(".java")) continue;
    if (overrides.has(f) && overrides.get(f) === null) continue;
    if (overrides.has(f)) {
      const p = join(overlay, f);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, overrides.get(f)!);
      sources.push(p);
      back.set(p, f);
    } else sources.push(join(repo.root, f));
  }
  for (const [f, content] of overrides) {
    if (content !== null && !sources.some((s) => back.get(s) === f)) {
      const p = join(overlay, f);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      sources.push(p);
      back.set(p, f);
    }
  }
  const argfile = join(work, "sources.txt");
  writeFileSync(argfile, sources.map((s) => `"${s.replace(/\\/g, "/")}"`).join("\n"));
  const sepc = process.platform === "win32" ? ";" : ":";
  const r = await run(javac, ["-nowarn", "-encoding", "UTF-8", "--release", "17", "-proc:none", "-Xmaxerrs", "50", "-d", classes, "-cp", [...cp.jars, aj].join(sepc), `@${argfile}`], repo.root, 180_000);
  const map = (f: string) => back.get(f) ?? (f.startsWith(repo.root) ? relative(repo.root, f).split("\\").join("/") : f);
  const output = r.out.replaceAll(overlay + "/", "").replaceAll(repo.root + "/", "");
  rmSync(work, { recursive: true, force: true });
  const errors = parseErrors(r.out, map);
  const missingNote = cp.missing.length ? `\n(not found in the Gradle cache: ${cp.missing.join(", ")})` : "";
  return { ok: r.code === 0, method: "javac", available: true, errors, output: output.slice(0, 20000) + missingNote, ms: Date.now() - t0 };
}

// The real Gradle compile, on the repo as it is on disk (run after writing, on request).
export async function gradleCheck(repo: RobotRepo): Promise<CompileResult> {
  const t0 = Date.now();
  const wrapper = join(repo.root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const base: CompileResult = { ok: false, method: "gradle", available: false, errors: [], output: "", ms: 0 };
  if (!existsSync(wrapper)) return { ...base, why: "no gradlew in the robot repo" };
  const r = await run(wrapper, [":TeamCode:compileDebugJavaWithJavac", "--offline", "--console=plain", "-q"], repo.root, 600_000);
  const errors = parseErrors(r.out, (f) => (f.startsWith(repo.root) ? relative(repo.root, f).split("\\").join("/") : f));
  return { ok: r.code === 0, method: "gradle", available: true, errors, output: r.out.slice(-20000), ms: Date.now() - t0 };
}

// The public API of the path library the repo builds against (javap on the same jars javac uses), so
// the AI writes calls that exist instead of only the ones the team's code happens to use.
const LIBRARY_CLASSES = ["com.pedropathing.api.Paths", "com.pedropathing.api.PoseFactory", "com.pedropathing.math.Pose", "com.pedropathing.paths.Path"];
export function libraryApi(repo: RobotRepo, cacheDir: string): string {
  const javac = javacPath();
  if (!javac) return "";
  const javap = join(dirname(javac), "javap");
  if (!existsSync(javap)) return "";
  const jars = classpath(repo, cacheDir).jars.filter((j) => /pedropathing/.test(j));
  if (!jars.length) return "";
  const r = spawnSync(javap, ["-public", "-cp", jars.join(process.platform === "win32" ? ";" : ":"), ...LIBRARY_CLASSES], { encoding: "utf8", timeout: 30_000 });
  return (r.stdout || "").trim();
}
