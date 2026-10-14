import { DEFAULT_PARTNER, type PartnerOpts } from "../shared/compare.ts";
import type { ClaimResult, Patch } from "../shared/patch.ts";
import { type Profile, type RobotModel, robotModel } from "../shared/profile.ts";
import type { SeasonPack } from "../shared/season.ts";
import { type AutoSpec, stableStringify } from "../shared/spec.ts";
import { api, saveUiSetting, uiSetting } from "./api.ts";

export interface ServerState {
  session: string;
  model: string;
  key: { set: boolean; last4: string | null; workspace: string | null };
  repo: { root: string; autosDir: string; autoPaths: string; head: string | null } | null;
  repoError: string | null;
  profile: Profile | null;
  profileContradictions: string[];
  unconfirmedFacts: number | null;
  onboarding: { key: boolean; repo: boolean; scanned: boolean; profileConfirmed: boolean; sanityConfirmed: boolean; style: boolean };
  style: StyleRecord | null;
  styleStale: boolean;
  simulator: { available: boolean; afterWrite: boolean };
  importStatus: { ok: boolean; errors?: { line: number; message: string }[]; warnings: { line: number; message: string }[] } | null;
  autos: { name: string; updatedAt: string; legs: number; active: boolean; file: string | null; points: number | null; opModes: { name: string; alliance: "BLUE" | "RED" | null }[] }[];
  folder: { other: { file: string; name: string; why: string }[]; pp: string[] };
  spend: { session: number; cap: number; warn: boolean; paused: boolean; requests: number; cacheHitRate: number | null; allTime: number; remainingEstimate: number | null };
  ai: { enabled: boolean; why: string | null; paused: boolean; fake: boolean; mode: "claude" | "api" | "fake"; claude: boolean; claudeModel: string | null; claudeModels: string[] };
  pack: { season: string; manual: string; lastModified: string };
}

export interface StyleRecord {
  sampleRoot: string;
  autoFile: string;
  files: string[];
  targetFiles: string[];
  style: { summary: string; sections: { title: string; text: string }[]; mapping: { sample: string; target: string; note: string }[]; rules: string[]; gaps: string[] };
  notes: string;
  confirmed: boolean;
  writer: "ai" | "fixed";
  at: string;
  model: string;
  targetHash?: string;
}

export interface ChatItem {
  kind: "user" | "status" | "tool" | "ai" | "error" | "note";
  text: string;
  detail?: string;
}

export interface Proposal {
  patch: Patch;
  spec: AutoSpec;
  claims: ClaimResult;
  repairs: number;
  task: "annotate" | "chat";
}

export interface LibTeam {
  team: string;
  name: string;
  notes: string;
  robot: { body: PartnerOpts["body"]; maxVel: number } | null;
  updatedAt: string;
  versions: { id: string; team: string; event: string; date: string; autoName: string; side: string; confidence: string; notes: string; source: string }[];
}

export interface PartnerLib {
  team: string;
  id: string;
  name: string;
  event: string;
  date: string;
  side: string;
  confidence: string;
  notes: string;
}

export interface CompileInfo {
  ok: boolean;
  method: string;
  available: boolean;
  why?: string;
  errors: { file: string; line: number; message: string }[];
  ms: number;
}

class AppState {
  server = $state<ServerState | null>(null);
  pack = $state<SeasonPack | null>(null);
  spec = $state<AutoSpec | null>(null);
  autoName = $state<string>(uiSetting("lastAuto", "AutoPaths"));
  selected = $state<string | null>(null); // leg id
  selectedPose = $state<string | null>(null);
  mode = $state<"select" | "add">("select");
  showZones = $state<boolean>(uiSetting("showZones", true));
  showElements = $state<boolean>(uiSetting("showElements", true));
  redView = $state<boolean>(false);
  scrubT = $state(0);
  proposal = $state<Proposal | null>(null);
  pendingDecision = $state<string | null>(null);
  chat = $state<ChatItem[]>([]);
  busy = $state<string | null>(null);
  toast = $state<{ text: string; kind: "ok" | "warn" | "error"; detail?: string } | null>(null);
  lastCompile = $state<CompileInfo | null>(null);
  lastWrite = $state<{ file: string; at: string } | null>(null);
  showSettings = $state(false);
  ask = $state<{ title: string; text: string; yes: string; resolve: (ok: boolean) => void } | null>(null);
  showJava = $state(false);
  aiOpen = $state<boolean>(uiSetting("aiOpen", true));
  showManage = $state(false); // the Manage dashboard (autos, repo, files AutoTool wrote)
  showPlan = $state(false); // match day: pairing matrix and the plan sheet
  redoSetup = $state(false); // Settings > Redo setup: the setup steps again (the AI connection stays)
  viewer = $state<{ path: string; text: string; note?: string } | null>(null); // read-only file view
  // the alliance partner's auto, run together with ours (remembered per auto in this browser). ref: an AutoTool
  // auto's name, or "lib:<team>/<version>" for a route in the partner library
  partner = $state<{ ref: string; label: string; spec: AutoSpec; opts: PartnerOpts; lib?: PartnerLib } | null>(null);
  playing = $state(false);
  // the partner library (partners/<team>/ in the AutoTool repo), loaded when a view needs it
  partnerLib = $state<{ dir: string; teams: LibTeam[] } | null>(null);
  history: string[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  model = $derived<RobotModel | null>(this.server?.profile ? safeModel(this.server.profile) : null);

  async refresh() {
    this.server = await api<ServerState>("GET", "/api/state");
  }

  async loadPack() {
    this.pack = await api<SeasonPack>("GET", "/api/pack");
  }

  setAiOpen(v: boolean) {
    this.aiOpen = v;
    saveUiSetting("aiOpen", v);
  }

  async openAuto(name: string) {
    const s = await api<AutoSpec>("POST", "/api/autos/get", { name });
    this.autoName = name;
    saveUiSetting("lastAuto", name);
    this.spec = s;
    this.history = [];
    this.selected = null;
    this.selectedPose = null;
    this.proposal = null;
    this.chat = [];
    this.scrubT = 0;
    const saved = uiSetting<{ ref?: string; name?: string; opts: PartnerOpts } | null>(`partner:${name}`, null);
    this.partner = null;
    const ref = saved?.ref ?? saved?.name;
    if (saved && ref) await this.setPartner(ref, saved.opts).catch(() => this.setPartner(null));
  }

  // Run another auto of the alliance together with this one (null = no partner): an AutoTool auto by name,
  // or "lib:<team>/<version>" from the partner library (its robot size and speed come with it).
  async setPartner(ref: string | null, opts?: PartnerOpts) {
    if (!ref) {
      this.partner = null;
      saveUiSetting(`partner:${this.autoName}`, null);
      return;
    }
    const base = { ...DEFAULT_PARTNER, maxVel: this.model?.maxVel ?? DEFAULT_PARTNER.maxVel };
    let o = opts ?? (this.partner?.ref === ref ? this.partner.opts : undefined);
    if (ref.startsWith("lib:")) {
      const [team, id] = ref.slice(4).split("/");
      const r = await api<{ version: { id: string; team: string; event: string; date: string; autoName: string; side: string; confidence: string; notes: string; spec: AutoSpec }; team: { name: string; notes: string; robot: { body: PartnerOpts["body"]; maxVel: number } | null } | null }>("POST", "/api/partners/get", { team, id });
      const v = r.version;
      o ??= { ...base, ...(r.team?.robot ? { body: r.team.robot.body, maxVel: r.team.robot.maxVel } : {}) };
      const label = `${v.team}${r.team?.name ? ` ${r.team.name}` : ""}${v.autoName ? ` · ${v.autoName}` : ""}`;
      this.partner = { ref: `lib:${v.team}/${v.id}`, label, spec: v.spec, opts: o, lib: { team: v.team, id: v.id, name: r.team?.name ?? "", event: v.event, date: v.date, side: v.side, confidence: v.confidence, notes: [r.team?.notes, v.notes].filter(Boolean).join(" · ") } };
    } else {
      const spec = await api<AutoSpec>("POST", "/api/autos/get", { name: ref });
      this.partner = { ref, label: ref, spec, opts: o ?? base };
    }
    saveUiSetting(`partner:${this.autoName}`, { ref: this.partner.ref, opts: this.partner.opts });
  }

  async loadPartnerLib() {
    this.partnerLib = await api<{ dir: string; teams: LibTeam[] }>("GET", "/api/partners");
  }

  setPartnerOpts(o: PartnerOpts) {
    if (!this.partner) return;
    this.partner = { ...this.partner, opts: o };
    saveUiSetting(`partner:${this.autoName}`, { ref: this.partner.ref, opts: o });
  }

  // Every change goes through here: one undo step, then a debounced save.
  change(next: AutoSpec, opts: { record?: boolean } = {}) {
    if (!this.spec) return;
    if (opts.record !== false) {
      this.history.push(JSON.stringify(this.spec));
      if (this.history.length > 200) this.history.shift();
    }
    this.spec = next;
    this.scheduleSave();
  }

  // During a drag: change without an undo step per frame (the drag start recorded one).
  live(next: AutoSpec) {
    this.spec = next;
  }

  beginDrag() {
    if (this.spec) this.history.push(JSON.stringify(this.spec));
  }

  endDrag() {
    this.scheduleSave();
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.spec = JSON.parse(prev);
    this.scheduleSave();
    return true;
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 600);
  }

  async saveNow() {
    if (!this.spec) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await api("POST", "/api/autos/save", { spec: $state.snapshot(this.spec) });
    } catch (e) {
      this.flash(`Not saved: ${(e as Error).message}`, "error");
    }
  }

  // An in-app yes/no question (Enter = yes, Esc = no).
  confirm(title: string, text: string, yes: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.ask = {
        title,
        text,
        yes,
        resolve: (ok) => {
          this.ask = null;
          resolve(ok);
        },
      };
    });
  }

  flash(text: string, kind: "ok" | "warn" | "error" = "ok", detail?: string) {
    this.toast = { text, kind, ...(detail ? { detail } : {}) };
    const mine = this.toast;
    if (kind === "ok") setTimeout(() => this.toast === mine && (this.toast = null), 4000);
  }

  setView(key: "showZones" | "showElements", v: boolean) {
    this[key] = v;
    saveUiSetting(key, v);
  }

  snapshot(): AutoSpec {
    return $state.snapshot(this.spec) as AutoSpec;
  }

  same(a: AutoSpec | null, b: AutoSpec | null): boolean {
    return !!a && !!b && stableStringify(a) === stableStringify(b);
  }
}

function safeModel(p: Profile): RobotModel | null {
  try {
    return robotModel(p.facts);
  } catch {
    return null;
  }
}

export const app = new AppState();
