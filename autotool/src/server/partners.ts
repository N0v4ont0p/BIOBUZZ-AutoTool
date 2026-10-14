// The partner library: other teams' autos, saved by team number, so the next match (or event) with them
// starts from their last route. Lives in the AutoTool repo (partners/<team>/), so the whole team shares it
// through git; AutoTool never commits or pushes it. One folder per team:
//   partners/12345/team.json            team number, name, robot size and speed, notes
//   partners/12345/<version>.json       one route as seen at an event: the auto, where it came from, notes
//   partners/12345/<version>.pp         the Pedro visualizer file it was imported from, kept as it was

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PartnerOpts } from "../shared/compare.ts";
import { importVisualizerProject } from "../shared/pp.ts";
import { type AutoSpec, migrateSpec, validateSpec } from "../shared/spec.ts";
import { readJson, writeJson } from "./store.ts";

export type Confidence = "seen" | "told" | "guessed";

export interface PartnerTeam {
  team: string; // team number
  name: string;
  notes: string;
  robot: { body: PartnerOpts["body"]; maxVel: number } | null; // size and speed for the comparison
  updatedAt: string;
}

export interface PartnerVersion {
  id: string; // file name without .json, sortable by time
  team: string;
  event: string;
  date: string; // YYYY-MM-DD
  autoName: string; // what they call it ("far 6", "Blue_Far_6")
  side: "Near" | "Far" | "";
  confidence: Confidence;
  notes: string;
  source: "pp" | "drawn";
  spec: AutoSpec;
}

// a request the library cannot do (bad team number, unreadable file): the team's mistake, not a server fault
export class PartnerError extends Error {}

const TEAM_RE = /^[0-9]{1,6}$/;
const ID_RE = /^v-[0-9]{8}-[0-9]{6}(-[0-9]+)?$/;

export class PartnerLibrary {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private teamDir(team: string): string {
    if (!TEAM_RE.test(team)) throw new PartnerError("a team number is 1-6 digits");
    return join(this.dir, team);
  }

  teams(): (PartnerTeam & { versions: Omit<PartnerVersion, "spec">[] })[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && TEAM_RE.test(d.name))
      .map((d) => {
        const t = readJson<PartnerTeam | null>(join(this.dir, d.name, "team.json"), null) ?? { team: d.name, name: "", notes: "", robot: null, updatedAt: "" };
        const versions = this.versionIds(d.name)
          .map((id) => readJson<PartnerVersion | null>(join(this.dir, d.name, `${id}.json`), null))
          .filter((v): v is PartnerVersion => !!v)
          .map(({ spec: _s, ...meta }) => meta)
          .reverse(); // newest first
        return { ...t, team: d.name, versions };
      })
      .sort((a, b) => Number(a.team) - Number(b.team));
  }

  private versionIds(team: string): string[] {
    const d = this.teamDir(team);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".json") && f !== "team.json" && ID_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  // one version (the newest when no id is given), with its route
  get(team: string, id?: string): PartnerVersion | null {
    const ids = this.versionIds(team);
    const pick = id ?? ids.at(-1);
    if (!pick || !ID_RE.test(pick) || !ids.includes(pick)) return null;
    const v = readJson<PartnerVersion | null>(join(this.teamDir(team), `${pick}.json`), null);
    return v ? { ...v, spec: migrateSpec(v.spec) } : null;
  }

  team(team: string): PartnerTeam | null {
    return readJson<PartnerTeam | null>(join(this.teamDir(team), "team.json"), null);
  }

  saveTeam(team: string, patch: Partial<Omit<PartnerTeam, "team" | "updatedAt">>): PartnerTeam {
    const d = this.teamDir(team);
    mkdirSync(d, { recursive: true });
    const old = this.team(team) ?? { team, name: "", notes: "", robot: null, updatedAt: "" };
    const t: PartnerTeam = { ...old, ...clean(patch), team, updatedAt: new Date().toISOString() };
    writeJson(join(d, "team.json"), t);
    return t;
  }

  // a new version of a team's route: from a drawn auto (spec) or a Pedro visualizer file (pp text)
  addVersion(team: string, v: { event?: string; date?: string; autoName?: string; side?: string; confidence?: string; notes?: string; spec?: unknown; pp?: string }): PartnerVersion {
    const d = this.teamDir(team);
    let spec: AutoSpec;
    let source: PartnerVersion["source"] = "drawn";
    if (typeof v.pp === "string") {
      let project: unknown;
      try {
        project = JSON.parse(v.pp);
      } catch {
        throw new PartnerError("the .pp file is not JSON");
      }
      const r = importVisualizerProject(project, `partner_${team}`);
      if (!r.spec) throw new PartnerError(r.errors.join("; ") || "the .pp file has no paths");
      spec = r.spec;
      source = "pp";
    } else if (v.spec && typeof v.spec === "object") {
      spec = migrateSpec(v.spec as AutoSpec);
    } else throw new PartnerError("a partner route needs a drawn auto or a .pp file");
    const errors = validateSpec({ ...spec, name: `partner_${team}` }).filter((p) => p.level === "error" && p.code.startsWith("spec."));
    if (errors.length) throw new PartnerError(errors.map((e) => e.message).join("; "));
    mkdirSync(d, { recursive: true });
    if (!this.team(team)) this.saveTeam(team, {});
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    let id = `v-${stamp}`;
    for (let i = 2; existsSync(join(d, `${id}.json`)); i++) id = `v-${stamp}-${i}`;
    const side = v.side === "Near" || v.side === "Far" ? v.side : "";
    const confidence: Confidence = v.confidence === "told" || v.confidence === "guessed" ? v.confidence : "seen";
    const version: PartnerVersion = {
      id,
      team,
      event: str(v.event, 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(v.date ?? "") ? v.date! : now.toISOString().slice(0, 10),
      autoName: str(v.autoName, 60),
      side,
      confidence,
      notes: str(v.notes, 1000),
      source,
      spec: { ...spec, name: `partner_${team}`, source: undefined, java: undefined, reader: undefined },
    };
    writeJson(join(d, `${id}.json`), version);
    if (typeof v.pp === "string") writeFileSync(join(d, `${id}.pp`), v.pp);
    return version;
  }

  updateVersion(team: string, id: string, patch: { event?: string; autoName?: string; side?: string; confidence?: string; notes?: string }): PartnerVersion {
    const v = this.get(team, id);
    if (!v) throw new PartnerError("no such partner route");
    const next: PartnerVersion = {
      ...v,
      ...(patch.event !== undefined ? { event: str(patch.event, 80) } : {}),
      ...(patch.autoName !== undefined ? { autoName: str(patch.autoName, 60) } : {}),
      ...(patch.side !== undefined ? { side: patch.side === "Near" || patch.side === "Far" ? patch.side : "" } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence === "told" || patch.confidence === "guessed" ? patch.confidence : "seen" } : {}),
      ...(patch.notes !== undefined ? { notes: str(patch.notes, 1000) } : {}),
    };
    writeJson(join(this.teamDir(team), `${id}.json`), next);
    return next;
  }

  // a version, or the whole team when no id is given
  remove(team: string, id?: string) {
    const d = this.teamDir(team);
    if (id === undefined) return rmSync(d, { recursive: true, force: true });
    if (!ID_RE.test(id)) throw new PartnerError("no such partner route");
    for (const ext of [".json", ".pp"]) rmSync(join(d, `${id}${ext}`), { force: true });
  }

  // everything (or one team) as one file, to send to a teammate
  exportBundle(team?: string): { format: "autotool-partners"; v: 1; teams: { team: PartnerTeam; versions: (PartnerVersion & { pp?: string })[] }[] } {
    const teams = this.teams().filter((t) => !team || t.team === team);
    return {
      format: "autotool-partners",
      v: 1,
      teams: teams.map((t) => ({
        team: { team: t.team, name: t.name, notes: t.notes, robot: t.robot, updatedAt: t.updatedAt },
        versions: t.versions.map((m) => {
          const full = this.get(t.team, m.id)!;
          const pp = join(this.teamDir(t.team), `${m.id}.pp`);
          return { ...full, ...(existsSync(pp) ? { pp: readFileSync(pp, "utf8") } : {}) };
        }),
      })),
    };
  }

  // a teammate's bundle: new teams and routes are added; a route already here (same id) is kept as it is
  importBundle(b: unknown): { teams: number; added: number; kept: number } {
    const bundle = b as ReturnType<PartnerLibrary["exportBundle"]>;
    if (!bundle || bundle.format !== "autotool-partners" || !Array.isArray(bundle.teams)) throw new PartnerError("not an AutoTool partner file");
    let added = 0;
    let kept = 0;
    for (const t of bundle.teams) {
      const team = String(t.team?.team ?? "");
      if (!TEAM_RE.test(team)) continue;
      if (!this.team(team)) this.saveTeam(team, { name: t.team.name, notes: t.team.notes, robot: t.team.robot });
      for (const v of t.versions ?? []) {
        if (!ID_RE.test(v.id)) continue;
        const file = join(this.teamDir(team), `${v.id}.json`);
        if (existsSync(file)) {
          kept++;
          continue;
        }
        const spec = migrateSpec(v.spec);
        writeJson(file, { ...v, pp: undefined, team, spec });
        if (typeof v.pp === "string") writeFileSync(join(this.teamDir(team), `${v.id}.pp`), v.pp);
        added++;
      }
    }
    return { teams: bundle.teams.length, added, kept };
  }
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function clean(p: Partial<Omit<PartnerTeam, "team" | "updatedAt">>): Partial<PartnerTeam> {
  const out: Partial<PartnerTeam> = {};
  if (p.name !== undefined) out.name = str(p.name, 80);
  if (p.notes !== undefined) out.notes = str(p.notes, 2000);
  if (p.robot !== undefined) {
    const r = p.robot;
    const ok = r && [r.body?.front, r.body?.back, r.body?.left, r.body?.right].every((n) => typeof n === "number" && n > 0 && n <= 12) && typeof r.maxVel === "number" && r.maxVel > 0 && r.maxVel <= 200;
    out.robot = ok ? { body: { front: r.body.front, back: r.body.back, left: r.body.left, right: r.body.right }, maxVel: r.maxVel } : null;
  }
  return out;
}
