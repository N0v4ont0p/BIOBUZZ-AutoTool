// Talks to the local server. The page's key comes from the URL fragment (#t=...), which the browser never
// sends to a server; it goes in a header on every API call. It is also kept in this page's own storage
// (only this origin can read it), so a bookmark of http://localhost:4791 works without the fragment.

const KEY = "autotool.token";
let cached = "";
function token(): string {
  const t = new URLSearchParams(location.hash.slice(1)).get("t");
  if (t && t !== cached) {
    cached = t;
    try {
      localStorage.setItem(KEY, t);
      // the address bar then shows the plain address, which is what to bookmark
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* storage blocked: the fragment still works for this visit */
    }
  }
  if (!cached) {
    try {
      cached = localStorage.getItem(KEY) ?? "";
    } catch {
      cached = "";
    }
  }
  return cached;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function hasToken(): boolean {
  return token().length > 0;
}

const DOWN = "AutoTool is not running. Start it with ./autotool.sh in the robot repo, then reload this page.";

async function reach(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(0, DOWN);
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await reach(path, {
    method,
    headers: { "x-autotool-token": token(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, text.slice(0, 300) || res.statusText);
  }
  if (res.status === 401) throw new ApiError(401, "This page's key does not match the running AutoTool. Run ./autotool.sh open in the robot repo: it opens the page with the right key (once; after that the plain address works).");
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string })?.error ?? res.statusText);
  return json as T;
}

// AI turns stream newline-delimited JSON events.
export async function apiStream(path: string, body: unknown, onEvent: (e: Record<string, unknown>) => void): Promise<void> {
  const res = await reach(path, { method: "POST", headers: { "x-autotool-token": token(), "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const t = await res.text();
    let msg = t;
    try {
      msg = JSON.parse(t).error ?? t;
    } catch {
      /* text */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}

export function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// UI settings are the only thing kept in browser storage (PLAN section 6).
export function uiSetting<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`autotool.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function saveUiSetting(key: string, v: unknown) {
  try {
    localStorage.setItem(`autotool.${key}`, JSON.stringify(v));
  } catch {
    /* storage blocked: settings just don't persist */
  }
}
