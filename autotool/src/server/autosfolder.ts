// What autos the robot repo has, as the Driver Station sees them: every @Autonomous OpMode, the route
// it runs (AutoPaths by default, or an AutoTool auto's route), plus Pedro visualizer files
// (.pp). Read-only; the auto selector shows it and the server keeps the saved specs in step with it.

import { statSync } from "node:fs";
import type { RobotRepo } from "./repo.ts";

export interface OpModeInfo {
  file: string;
  className: string;
  name: string; // on the Driver Station
  alliance: "BLUE" | "RED" | null;
  routeFile: string | null; // the file whose route it runs; null = not an AutoRunner auto
}

export interface FolderScan {
  opModes: OpModeInfo[];
  routeFiles: string[]; // files AutoTool can draw: AutoPaths.java and AutoTool autos
  other: { file: string; name: string; why: string }[]; // autos AutoTool can show but not draw
  pp: string[]; // Pedro visualizer projects anywhere in the repo
  signature: string;
}

const AUTONOMOUS = /@Autonomous\s*\(([^)]*)\)\s*$/;
// every class that extends something; an AutoTool auto has two (Blue, Red) nested in one file
const CLASS = /\bclass\s+(\w+)\s+extends\s+([\w.]+)/g;
const OWN_ROUTE = /static class Plan implements Route|autotool-spec:|>>> AutoTool route/;

function signature(repo: RobotRepo, files: string[]): string {
  return files
    .map((f) => {
      try {
        return `${f}:${statSync(repo.resolveInside(f)).mtimeMs}`;
      } catch {
        return f;
      }
    })
    .join("|");
}

export function scanAutos(repo: RobotRepo, previous: FolderScan | null = null): FolderScan {
  const java = repo.textFiles("TeamCode").filter((f) => f.endsWith(".java"));
  const pp = repo.textFiles(".").filter((f) => f.endsWith(".pp"));
  const sig = signature(repo, [...java, ...pp]);
  if (previous && previous.signature === sig) return previous;

  // keyed by class name; a nested class also as File.Class (Near_9.Blue), which a sibling's extends finds first
  const classes = new Map<string, { file: string; cls: string; ext: string; ownPlan: boolean; name: string | null; alliance: "BLUE" | "RED" | null }>();
  for (const file of java) {
    const text = repo.readText(file);
    const outer = file.split("/").pop()!.replace(/\.java$/, "");
    const found = [...text.matchAll(CLASS)];
    found.forEach((c, i) => {
      const before = text.slice(i ? found[i - 1].index! + found[i - 1][0].length : 0, c.index).replace(/\b(public|static|final|abstract)\s+$/g, "").replace(/\s*(public|static|final|abstract|\s)*$/, "");
      const body = text.slice(c.index, found[i + 1]?.index ?? text.length);
      const a = AUTONOMOUS.exec(before);
      const name = a ? (/name\s*=\s*"([^"]*)"/.exec(a[1])?.[1] ?? c[1]) : null;
      const al = /Alliance\s+alliance\s*\(\s*\)\s*\{\s*return\s+[\w.]*Alliance\.(BLUE|RED)/.exec(body)?.[1] as "BLUE" | "RED" | undefined;
      const entry = { file, cls: c[1] === outer ? c[1] : `${outer}.${c[1]}`, ext: c[2].split(".").pop()!, ownPlan: OWN_ROUTE.test(text), name, alliance: al ?? null };
      classes.set(entry.cls, entry);
      if (!classes.has(c[1])) classes.set(c[1], entry);
    });
  }
  const autoPaths = repo.autoPathsRel();
  // the route a class runs: its own Plan, AutoPaths for a plain AutoRunner subclass, or its parent's
  const routeOf = (cls: string, seen = new Set<string>()): string | null => {
    const c = classes.get(cls);
    if (!c || seen.has(c.cls)) return null;
    seen.add(c.cls);
    if (c.ownPlan) return c.file;
    if (c.ext === "AutoRunner") return repo.exists(autoPaths) ? autoPaths : null;
    const outer = c.cls.includes(".") ? c.cls.split(".")[0] : null;
    return routeOf(outer && classes.has(`${outer}.${c.ext}`) ? `${outer}.${c.ext}` : c.ext, seen);
  };
  const opModes: OpModeInfo[] = [];
  const other: FolderScan["other"] = [];
  for (const [cls, c] of classes) {
    if (c.name === null || cls !== c.cls) continue;
    const routeFile = routeOf(cls);
    opModes.push({ file: c.file, className: cls, name: c.name, alliance: c.alliance, routeFile });
    if (!routeFile) other.push({ file: c.file, name: c.name, why: `${cls} extends ${c.ext}, not AutoRunner: AutoTool can show its code but cannot draw it` });
  }
  opModes.sort((a, b) => a.name.localeCompare(b.name));
  const routeFiles = [...new Set([...(repo.exists(autoPaths) ? [autoPaths] : []), ...[...classes.values()].filter((c) => c.ownPlan).map((c) => c.file)])];
  return { opModes, routeFiles, other, pp, signature: sig };
}
