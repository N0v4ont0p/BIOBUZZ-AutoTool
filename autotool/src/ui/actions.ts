// Actions shared by the panels and the keyboard: AI turns, approve/reject, write, undo.

import type { ClaimResult, Patch } from "../shared/patch.ts";
import type { AutoSpec } from "../shared/spec.ts";
import { ApiError, api, apiStream } from "./api.ts";
import { type CompileInfo, app } from "./state.svelte.ts";

export async function runAI(kind: "annotate" | "chat", text = "", junctions?: string[]) {
  if (!app.spec || app.busy) return;
  if (kind === "chat" && !text.trim()) return;
  if (app.proposal) rejectProposal("The team asked something else before answering.");
  app.busy = kind === "annotate" ? "AI is deciding what each leg does" : "AI is working on your change";
  if (kind === "chat") app.chat.push({ kind: "user", text });
  else app.chat.push({ kind: "user", text: junctions?.length ? `Label ${junctions.join(", ")}` : "Label every stop" });
  const decision = app.pendingDecision ?? undefined;
  app.pendingDecision = null;
  try {
    await apiStream(`/api/ai/${kind}`, { spec: app.snapshot(), text, junctions, decision }, (e) => {
      switch (e.type) {
        case "status":
          app.chat.push({ kind: "status", text: String(e.text) });
          break;
        case "tool":
          app.chat.push({ kind: "tool", text: `${e.name}`, detail: String(e.summary) });
          break;
        case "usage":
          break;
        case "result":
          app.proposal = { patch: e.patch as Patch, spec: e.spec as AutoSpec, claims: e.claims as ClaimResult, repairs: Number(e.repairs), task: kind };
          app.chat.push({ kind: "ai", text: (e.patch as Patch).summary });
          break;
        case "paused":
          app.chat.push({ kind: "error", text: `${e.reason} The task is kept: press Continue (+$15) to resume.` });
          break;
        case "error":
          app.chat.push({ kind: "error", text: String(e.message) });
          break;
        case "end":
          break;
      }
    });
  } catch (e) {
    app.chat.push({ kind: "error", text: e instanceof ApiError ? e.message : `AI request failed: ${(e as Error).message}` });
  } finally {
    app.busy = null;
    await app.refresh();
  }
}

export async function continueAI() {
  app.busy = "Continuing";
  try {
    await apiStream("/api/ai/continue", {}, (e) => {
      if (e.type === "result") {
        app.proposal = { patch: e.patch as Patch, spec: e.spec as AutoSpec, claims: e.claims as ClaimResult, repairs: Number(e.repairs), task: "chat" };
        app.chat.push({ kind: "ai", text: (e.patch as Patch).summary });
      } else if (e.type === "error") app.chat.push({ kind: "error", text: String(e.message) });
      else if (e.type === "tool") app.chat.push({ kind: "tool", text: String(e.name), detail: String(e.summary) });
    });
  } catch (e) {
    app.chat.push({ kind: "error", text: (e as Error).message });
  } finally {
    app.busy = null;
    await app.refresh();
  }
}

export function rejectProposal(reason = "The team rejected it.") {
  if (!app.proposal) return;
  app.proposal = null;
  app.pendingDecision = reason;
  app.chat.push({ kind: "note", text: "Rejected." });
}

// One key: take the proposal (if any) and write the files.
export async function approve() {
  if (app.busy || !app.spec) return;
  if (app.proposal) {
    app.change(app.proposal.spec);
    app.proposal = null;
    app.chat.push({ kind: "note", text: "Approved." });
  }
  await write(false);
}

export async function write(allowOverwriteChanged: boolean, allowHook = false): Promise<void> {
  if (!app.spec || app.busy) return;
  app.busy = "Compiling and writing";
  try {
    await app.saveNow();
    const r = await api<{ written: boolean; unchanged?: boolean; file?: string; files?: { file: string; created: boolean }[]; compile?: CompileInfo; needsConfirm?: boolean; needsHook?: boolean; message?: string; opModes?: string[] }>("POST", "/api/write", { spec: app.snapshot(), allowOverwriteChanged, allowHook });
    if (r.unchanged) {
      const sim = await afterWriteSim();
      app.flash(`${r.file?.split("/").pop()} already matches this auto: nothing to write.${sim ? ` ${sim.text}` : ""}`, sim && !sim.ok ? "warn" : "ok");
      return;
    }
    if (r.needsHook) {
      app.busy = null;
      if (await app.confirm("Change AutoRunner.java once?", "This auto gets its own file and its own entries on the Driver Station. For that, AutoRunner.java gets a small Route interface and a route() method, once. The sample auto stays the default, so it runs exactly as before. The Java tab shows the change.", "Change it and write")) return write(allowOverwriteChanged, true);
      app.flash("Not written.", "warn");
      return;
    }
    if (r.compile) app.lastCompile = r.compile;
    if (r.needsConfirm) {
      app.busy = null;
      if (await app.confirm("Overwrite the file?", `${r.message}. AutoTool rewrites only the lines between ">>> AutoTool route" and "<<< AutoTool route"; your code outside them stays. The Java tab shows the change.`, "Overwrite")) return write(true, allowHook);
      app.flash("Not written.", "warn");
      return;
    }
    if (!r.written) {
      const c = r.compile;
      const first = c?.errors[0];
      app.flash("Not written: the robot code would not compile.", "error", first ? `${first.file}:${first.line}: ${first.message}` : undefined);
      app.pendingDecision = `Approved, but the Java did not compile: ${c?.errors.map((e) => `${e.file}:${e.line} ${e.message}`).join("; ")}`;
      return;
    }
    app.lastWrite = { file: r.file ?? "", at: new Date().toLocaleTimeString() };
    const c = r.compile;
    const how = !c?.available ? `compile check unavailable: ${c?.why}` : `compiles (javac, ${(c.ms / 1000).toFixed(1)} s)`;
    const gone = r.files?.filter((f) => !f.created && !r.file?.endsWith(f.file.split("/").pop()!)).map((f) => f.file.split("/").pop()) ?? [];
    const written = `Written ${r.file?.split("/").pop()}: ${r.opModes?.join(" and ") ?? ""} on the Driver Station${gone.length ? ` (replaces ${gone.join(", ")})` : ""} · ${how}`;
    app.flash(written, c?.available ? "ok" : "warn");
    const sim = await afterWriteSim();
    if (sim) app.flash(`${written} · ${sim.text}${sim.ok ? "" : ". The file is written; Undo write takes it back."}`, sim.ok && c?.available ? "ok" : "warn");
    app.pendingDecision = app.pendingDecision ?? "Approved and written; it compiles.";
    // the written file is now the saved auto
    app.spec = await api<AutoSpec>("POST", "/api/autos/get", { name: app.autoName });
  } catch (e) {
    app.flash(`Not written: ${(e as Error).message}`, "error");
  } finally {
    app.busy = null;
    await app.refresh();
  }
}

export async function undoWrite() {
  try {
    const r = await api<{ restored: boolean; reason?: string }>("POST", "/api/write/undo", {});
    if (r.restored) {
      app.flash("Undone: files AutoTool created are removed, changed files are restored.");
      if (app.autoName === "AutoPaths") app.spec = await api<AutoSpec>("POST", "/api/autos/get", { name: "AutoPaths" });
      app.lastWrite = null;
    } else app.flash(`Not undone: ${r.reason}`, "warn");
  } catch (e) {
    app.flash((e as Error).message, "error");
  } finally {
    await app.refresh();
  }
}

// Offline: decide legs with the rubric in code (marked as the team's choice, shown with its evidence).
export async function codeLabel(onlyUndecided: boolean) {
  if (!app.spec) return;
  const ids = app.spec.legs.filter((l) => !onlyUndecided || l.junction.source === "none").map((l) => l.id);
  if (!ids.length) return app.flash("Every leg is already decided.");
  const r = await api<{ spec: AutoSpec }>("POST", "/api/autolabel", { spec: app.snapshot(), junctions: ids });
  app.change(r.spec);
  app.flash(`Decided ${ids.length} leg(s) with the code's rubric. Check each one.`, "warn");
}

// A Pedro visualizer project (.pp) becomes a new auto (not written until the team presses Write).
export async function importPpText(fileName: string, text: string) {
  try {
    const project = JSON.parse(text);
    const base = fileName.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "drawn";
    const have = new Set(app.server?.autos.map((a) => a.name) ?? []);
    let name = base;
    for (let i = 2; have.has(name); i++) name = `${base.slice(0, 36)}_${i}`;
    const r = await api<{ spec: AutoSpec; warnings: string[] }>("POST", "/api/import-pp", { project, name });
    await api("POST", "/api/autos/new", { name, spec: r.spec });
    await app.refresh();
    await app.openAuto(name);
    for (const w of r.warnings) app.chat.push({ kind: "note", text: w });
    app.flash(`Opened ${fileName.split("/").pop()} as "${name}": ${r.spec.legs.length} legs; say what each one does.`, "warn");
  } catch (e) {
    app.flash(`Could not open ${fileName}: ${(e as Error).message}`, "error");
  }
}

// A new auto from scratch: legal start on the blue wall, a shot, then park. Drag the points, tick what each leg
// does; nothing is on the robot until Write.
export async function blankAuto() {
  const have = new Set(app.server?.autos.map((a) => a.name) ?? []);
  let def = "my_auto";
  for (let i = 2; have.has(def); i++) def = `my_auto_${i}`;
  const name = prompt("Name for the new auto (letters, digits, - or _):", def)?.trim();
  if (!name) return;
  const w = { role: "waypoint" as const, redTrim: [0, 0, 0] as [number, number, number] };
  const leg = (id: string, from: string, to: string, end: "SHOOT" | "PARK") => ({ id, method: `${from}To${to[0].toUpperCase()}${to.slice(1)}`, path: { type: "line" as const, from, to }, heading: { mode: "linear" as const, from, to }, during: "NONE" as const, end, carryIntakeS: 0, legTimeoutS: null, junction: { source: "user" as const, evidence: [] } });
  const spec: AutoSpec = {
    specVersion: 2,
    name,
    drawnFor: "BLUE",
    start: "start",
    preload: { POLLEN: 4, NECTAR: 0, onTiles: 0 },
    poses: [
      { name: "start", x: 135, y: 72, headingDeg: 180, ...w },
      { name: "shot1", x: 118, y: 90, headingDeg: 180, ...w },
      { name: "park", x: 128, y: 36, headingDeg: 180, ...w },
    ],
    legs: [leg("L1", "start", "shot1", "SHOOT"), leg("L2", "shot1", "park", "PARK")],
    opaque: [],
  };
  try {
    await api("POST", "/api/autos/new", { name, spec });
    await app.refresh();
    await app.openAuto(name);
    app.flash(`Created ${name}: drag the points on the field, then set what each leg does.`);
  } catch (e) {
    app.flash((e as Error).message, "error");
  }
}

export async function newAuto() {
  if (!app.spec) return;
  const name = prompt("Name for the new auto (letters, digits, - or _):", "close_9")?.trim();
  if (!name) return;
  try {
    // a copy of a hand-written auto becomes AutoTool's own: numbers frozen, no link to the code it was read from
    const src = app.snapshot();
    const { reader: _r, source: _s, assume: _a, ...rest } = src;
    const spec = { ...rest, name, poses: src.poses.map(({ formula: _f, src: _c, ...p }) => p) };
    await api("POST", "/api/autos/new", { name, spec });
    await app.refresh();
    await app.openAuto(name);
  } catch (e) {
    app.flash((e as Error).message, "error");
  }
}

export async function viewFile(path: string, note?: string) {
  try {
    const r = await api<{ path: string; text: string }>("POST", "/api/file", { path });
    app.viewer = { ...r, note };
  } catch (e) {
    app.flash((e as Error).message, "error");
  }
}

type SimResult = { ok: boolean; error?: string; cached?: boolean; opmode: string; summary?: string; legs: { leg: number; during: string; end: string; at: number }[]; events: { at: number; status: string }[]; status: string | null; endMissIn?: number; timeS?: number; problems?: string[] };

// Settings > "check in the simulator after Write": both alliances at once; a file already checked is not run again.
async function afterWriteSim(): Promise<{ ok: boolean; text: string } | null> {
  const s = app.server?.simulator;
  if (!s?.available || !s.afterWrite || !app.spec) return null;
  app.busy = "Written. Checking Blue and Red in the simulator (about a minute)";
  const spec = app.snapshot();
  const run = (alliance: "BLUE" | "RED") => api<SimResult>("POST", "/api/simcheck", { spec, alliance, reuse: true }).catch((e) => ({ ok: false, error: (e as Error).message, opmode: alliance, legs: [], events: [], status: null }) as SimResult);
  const [blue, red] = await Promise.all([run("BLUE"), run("RED")]);
  const one = (name: string, r: SimResult) => (r.error ? `${name} could not run (${r.error})` : `${name} ${r.ok ? "✓" : "✗"}`);
  const detail = [blue, red].filter((r) => !r.ok || r.error).map((r) => `${r.opmode}: ${r.error ?? r.problems?.join("; ") ?? r.summary}`);
  const ok = blue.ok && red.ok;
  return { ok, text: `sim ${one("Blue", blue)} ${one("Red", red)}${ok ? ` (${blue.summary ?? ""})` : `: ${detail.join(" · ")}`}` };
}

// Runs the auto, as Write would render it, in the robot repo's simulator (its own copy of the repo).
export async function simCheck(alliance: "BLUE" | "RED") {
  if (!app.spec || app.busy) return;
  app.busy = `Running ${alliance === "RED" ? "the Red" : "the Blue"} auto in the simulator (about a minute)`;
  try {
    const r = await api<{ ok: boolean; error?: string; opmode: string; legs: { leg: number; during: string; end: string; at: number }[]; events: { at: number; status: string }[]; status: string | null; endMissIn?: number; timeS?: number; problems?: string[] }>("POST", "/api/simcheck", { spec: app.snapshot(), alliance });
    if (r.error) return app.flash(`Simulator check could not run: ${r.error}`, "error");
    const legs = r.legs.map((l) => `L${l.leg} ${l.during === "NONE" ? "" : `${l.during} `}-> ${l.end} at ${l.at} s`).join("; ");
    const events = r.events.map((e) => `${e.at} s ${e.status}`).join("; ");
    app.chat.push({ kind: "note", text: `Simulator, ${r.opmode}: ${legs}. ${events}${r.endMissIn !== undefined ? `. Ended ${r.endMissIn} in from the last stop` : ""}.` });
    app.flash(r.ok ? `${r.opmode} ran in the simulator: ${r.legs.length} legs, ${r.status} at ${r.timeS} s.` : `${r.opmode} in the simulator: ${r.problems?.join("; ")}`, r.ok ? "ok" : "warn");
  } catch (e) {
    app.flash(`Simulator check could not run: ${(e as Error).message}`, "error");
  } finally {
    app.busy = null;
  }
}
