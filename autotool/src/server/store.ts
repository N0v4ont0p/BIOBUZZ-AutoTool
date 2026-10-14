// Everything AutoTool keeps on this computer, in the OS config folder (never in the repo or the browser):
// macOS ~/Library/Application Support/biobuzz-autotool, Linux $XDG_CONFIG_HOME or ~/.config, Windows %APPDATA%.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// The page's key to this server, kept so the link (and a bookmark of http://localhost:4791) works across
// restarts. Readable only by this user; the server still only listens on 127.0.0.1.
export const SESSION_TOKEN_FILE = "session-token";
export function sessionToken(dir = configDir()): string {
  const f = join(ensureDir(dir), SESSION_TOKEN_FILE);
  try {
    const t = readFileSync(f, "utf8").trim();
    if (/^[A-Za-z0-9_-]{24,}$/.test(t)) return t;
  } catch {
    /* none yet */
  }
  const t = randomBytes(24).toString("base64url");
  writeFileSync(f, t, { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function configDir(): string {
  if (process.env.AUTOTOOL_CONFIG_DIR) return process.env.AUTOTOOL_CONFIG_DIR;
  const home = homedir();
  const p = platform();
  if (p === "darwin") return join(home, "Library", "Application Support", "biobuzz-autotool");
  if (p === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "biobuzz-autotool");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "biobuzz-autotool");
}

export function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// Atomic write: a crash never leaves half a file. `secret` files are user-only (0600).
export function writeFileAtomic(path: string, data: string, secret = false): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, v: unknown, secret = false): void {
  writeFileAtomic(path, JSON.stringify(v, null, 2) + "\n", secret);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class Store {
  readonly dir: string;
  constructor(dir = configDir()) {
    this.dir = ensureDir(dir);
  }
  path(...p: string[]): string {
    return join(this.dir, ...p);
  }

  // --- API key: server side only; the browser learns "set" and the last 4 characters ---
  readKey(): string | null {
    const p = this.path("key");
    if (!existsSync(p)) return null;
    const k = readFileSync(p, "utf8").trim();
    return k || null;
  }
  saveKey(key: string, workspaceId: string | null = null): void {
    writeFileAtomic(this.path("key"), key.replace(/\s/g, "") + "\n", true);
    if (workspaceId) writeFileAtomic(this.path("workspace"), workspaceId + "\n", true);
    else rmSync(this.path("workspace"), { force: true });
  }
  // Some keys (organization-wide / admin keys) are not tied to a workspace: model calls then need an
  // anthropic-workspace-id header.
  readWorkspace(): string | null {
    const p = this.path("workspace");
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8").trim() || null;
  }
  deleteKey(): void {
    rmSync(this.path("key"), { force: true });
    rmSync(this.path("workspace"), { force: true });
  }
  keyStatus(): { set: boolean; last4: string | null; workspace: string | null } {
    const k = this.readKey();
    return { set: !!k, last4: k ? k.slice(-4) : null, workspace: k ? this.readWorkspace() : null };
  }

  // --- Claude account (Claude Code token from `claude setup-token`): user-only file, never sent out ---
  readClaudeToken(): string | null {
    const p = this.path("claude-token");
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8").trim() || null;
  }
  saveClaudeToken(t: string): void {
    writeFileAtomic(this.path("claude-token"), t.replace(/\s/g, "") + "\n", true);
  }
  deleteClaudeToken(): void {
    rmSync(this.path("claude-token"), { force: true });
  }
  // which AI to use when both are set: "claude" (account) or "api" (key)
  aiMode(): "claude" | "api" {
    const t = this.readClaudeToken();
    const k = this.readKey();
    let pref: string | null = null;
    try {
      pref = readFileSync(this.path("ai-mode"), "utf8").trim();
    } catch {
      /* none yet */
    }
    if (pref === "api" && k) return "api";
    if (pref === "claude" && t) return "claude";
    return t ? "claude" : "api";
  }
  setAiMode(m: "claude" | "api"): void {
    writeFileAtomic(this.path("ai-mode"), m + "\n");
  }

  // Model for the Claude-account mode (it runs on the plan, not on API credit, so the strongest is the default).
  claudeModel(): string {
    try {
      const m = readFileSync(this.path("claude-model"), "utf8").trim();
      if (CLAUDE_MODELS.includes(m)) return m;
    } catch {
      /* default */
    }
    return CLAUDE_MODELS[0];
  }
  setClaudeModel(m: string): void {
    if (!CLAUDE_MODELS.includes(m)) throw new Error(`model must be one of ${CLAUDE_MODELS.join(", ")}`);
    writeFileAtomic(this.path("claude-model"), m + "\n");
  }

  // --- per-repo folder (profiles, autos, manifest, history) ---
  repoId(repoPath: string): string {
    return sha256(repoPath).slice(0, 12);
  }
  repoDir(repoPath: string): string {
    return ensureDir(this.path("repos", this.repoId(repoPath)));
  }

  // UI settings live in the browser; everything else here.
  listJson(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }
}

// Redacts anything that looks like an Anthropic key from text bound for logs or the browser.
export function redact(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, "sk-ant-…[redacted]");
}
