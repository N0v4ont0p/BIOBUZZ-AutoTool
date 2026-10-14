<script lang="ts">
  import type { AutoSpec } from "../../shared/spec.ts";
  import { importPpText, undoWrite, viewFile } from "../actions.ts";
  import { api, download } from "../api.ts";
  import { type ServerState, app } from "../state.svelte.ts";

  type Kind = "robot" | "hand-written" | "draft" | "read" | "sample";
  interface ManageAuto {
    name: string;
    updatedAt: string;
    legs: number;
    review: number;
    points: number | null; // AUTO points (Table 10-2)
    sim: { BLUE?: { ok: boolean; at: string; text: string }; RED?: { ok: boolean; at: string; text: string } } | null; // simulator checks of the file as it is now
    file: string | null;
    opModes: { name: string; alliance: "BLUE" | "RED" | null }[];
    kind: Kind;
    generated: boolean;
    framework: string | null;
    readFrom: string | null;
    history: number;
  }
  interface ManageData {
    autos: ManageAuto[];
    repo: { root: string; autosDir: string; defaultRoute: string; hooked: boolean; head: string | null };
    written: { file: string; at: string; exists: boolean; changed: boolean | null; removed: boolean }[];
    lastWrite: string[];
    style: { autoFile: string; sampleRoot: string; confirmed: boolean; writer: "ai" | "fixed"; at: string } | null;
    folder: { other: { file: string; name: string; why: string }[]; pp: string[] };
  }

  let tab = $state<"autos" | "partners" | "repo" | "files">("autos");
  let libInput: HTMLInputElement | undefined = $state();
  const lib = $derived(app.partnerLib?.teams ?? []);
  $effect(() => {
    if (tab === "partners") app.loadPartnerLib().catch((e) => (err = (e as Error).message));
  });
  async function libRun(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      await app.loadPartnerLib();
      app.flash(ok);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }
  async function usePartnerRoute(team: string, id: string) {
    try {
      await app.setPartner(`lib:${team}/${id}`);
      app.showManage = false;
      app.flash(`Team ${team}'s route runs as the partner of ${app.autoName}: see the Partner tab.`);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }
  async function editTeam(t: (typeof lib)[number]) {
    const name = prompt(`Team ${t.team}: name`, t.name);
    if (name === null) return;
    const notes = prompt(`Team ${t.team}: notes (their robot, how they play, contact)`, t.notes);
    if (notes === null) return;
    await libRun(() => api("POST", "/api/partners/team", { team: t.team, name, notes }), `Team ${t.team} saved.`);
  }
  async function editRoute(team: string, v: (typeof lib)[number]["versions"][number]) {
    const autoName = prompt("What they call this auto:", v.autoName);
    if (autoName === null) return;
    const event = prompt("Event (where you saw or heard about it):", v.event);
    if (event === null) return;
    const side = prompt("Near or Far (blank if unknown):", v.side);
    if (side === null) return;
    const confidence = prompt("How sure: seen, told or guessed:", v.confidence);
    if (confidence === null) return;
    const notes = prompt("Notes:", v.notes);
    if (notes === null) return;
    const s = side.trim().toLowerCase();
    await libRun(() => api("POST", "/api/partners/update", { team, id: v.id, autoName, event, side: s === "near" ? "Near" : s === "far" ? "Far" : "", confidence: confidence.trim().toLowerCase(), notes }), "Route saved.");
  }
  async function removeRoute(team: string, id: string | undefined, what: string) {
    if (!(await app.confirm(`Delete ${what}?`, `It is removed from partners/ in the AutoTool repo. If the library is committed in git, git still has it.`, "Delete"))) return;
    await libRun(() => api("POST", "/api/partners/delete", { team, ...(id ? { id } : {}) }), `Deleted ${what}.`);
  }
  async function importLib(f: File) {
    try {
      const r = await api<{ teams: number; added: number; kept: number }>("POST", "/api/partners/import", { bundle: JSON.parse(await f.text()) });
      await app.loadPartnerLib();
      app.flash(`Imported: ${r.added} new route${r.added === 1 ? "" : "s"} from ${r.teams} team${r.teams === 1 ? "" : "s"}${r.kept ? `; ${r.kept} already here, kept as they are` : ""}.`);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }
  let data = $state<ManageData | null>(null);
  let err = $state<string | null>(null);
  let filter = $state<"all" | Kind>("all");
  let q = $state("");
  let picked = $state<Set<string>>(new Set());
  let repoPath = $state(app.server?.repo?.root ?? "");
  let busy = $state(false);
  let importInput: HTMLInputElement | undefined = $state();
  let ppInput: HTMLInputElement | undefined = $state();

  async function load() {
    try {
      data = await api<ManageData>("GET", "/api/manage");
      err = null;
    } catch (e) {
      err = (e as Error).message;
    }
  }
  $effect(() => {
    load();
  });

  const KIND: Record<Kind, { label: string; hint: string }> = {
    robot: { label: "On the robot", hint: "AutoTool wrote it; it runs on the Driver Station" },
    "hand-written": { label: "Hand-written", hint: "robot code AutoTool reads but never rewrites" },
    draft: { label: "Draft", hint: "only in AutoTool; Write puts it on the robot" },
    read: { label: "Read from code", hint: "a copy of another auto's route, read-only" },
    sample: { label: "Sample", hint: "a sample auto drawn for reference" },
  };
  let byPoints = $state(false);
  const shown = $derived(
    (data?.autos ?? [])
      .filter((a) => (filter === "all" || a.kind === filter) && (!q.trim() || [a.name, a.file ?? "", ...a.opModes.map((o) => o.name)].some((s) => s.toLowerCase().includes(q.trim().toLowerCase()))))
      .toSorted((a, b) => (byPoints ? (b.points ?? -1) - (a.points ?? -1) : 0)),
  );
  const counts = $derived(Object.fromEntries((["robot", "hand-written", "draft", "read", "sample"] as Kind[]).map((k) => [k, (data?.autos ?? []).filter((a) => a.kind === k).length])) as Record<Kind, number>);
  const deletable = (a: ManageAuto) => a.kind !== "hand-written";
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    busy = true;
    try {
      const r = await fn();
      if (ok) app.flash(ok);
      await app.refresh();
      await load();
      return r;
    } catch (e) {
      app.flash((e as Error).message, "error");
      return undefined;
    } finally {
      busy = false;
    }
  }
  async function openAuto(name: string, red = false) {
    await app.openAuto(name);
    app.redView = red;
    app.showManage = false;
  }
  async function rename(a: ManageAuto) {
    const to = prompt(`New name for "${a.name}" (letters, digits, - or _)${a.kind === "robot" ? ". On the robot it is renamed at the next Write." : ""}`, a.name)?.trim();
    if (!to || to === a.name) return;
    await run(() => api("POST", "/api/autos/rename", { from: a.name, to }), `Renamed to ${to}.`);
    if (app.autoName === a.name) await app.openAuto(to);
  }
  async function usePartner(a: ManageAuto) {
    try {
      await app.setPartner(a.name);
      app.showManage = false;
      app.flash(`${a.name} runs as the partner of ${app.autoName}: see the Partner tab.`);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }

  async function duplicate(a: ManageAuto) {
    const to = prompt(`Name for the copy of "${a.name}" (a draft)`, `${a.name}_copy`)?.trim();
    if (!to) return;
    await run(() => api("POST", "/api/autos/duplicate", { name: a.name, to }), `Made the draft ${to}.`);
  }
  async function exportAuto(a: ManageAuto) {
    const spec = await api<AutoSpec>("POST", "/api/autos/get", { name: a.name });
    download(`${a.name}.autotool.json`, spec);
  }
  async function remove(a: ManageAuto) {
    if (a.kind === "robot") {
      const ask = await api<{ needsConfirm?: boolean; files?: string[] }>("POST", "/api/autos/delete", { name: a.name });
      if (!ask.needsConfirm) return;
      const files = (ask.files ?? []).map((f) => f.split("/").pop()).join(" and ");
      if (!(await app.confirm(`Remove ${a.name} from the robot?`, `AutoTool deletes ${files} from the robot repo (files it wrote) and forgets the auto, so ${a.opModes.map((o) => o.name).join(" and ")} leave the Driver Station after the next build. Undo write puts the files back.`, "Remove from robot"))) return;
      const r = await run(() => api<{ deleted: boolean; needsConfirm?: boolean; message?: string }>("POST", "/api/autos/delete", { name: a.name, removeFiles: true }));
      if (r?.needsConfirm && (await app.confirm("The file was edited by hand", `${r.message}. Remove it anyway? Undo write puts it back.`, "Remove anyway"))) {
        await run(() => api("POST", "/api/autos/delete", { name: a.name, removeFiles: true, allowOverwriteChanged: true }), `Removed ${a.name} from the robot.`);
      } else if (r?.deleted) app.flash(`Removed ${a.name} from the robot. Undo write puts it back.`);
    } else {
      if (!(await app.confirm(`Delete ${a.name}?`, `${KIND[a.kind].label}: AutoTool forgets it and its edit history (${a.history} steps). Nothing in the robot repo changes.`, "Delete"))) return;
      await run(() => api("POST", "/api/autos/delete", { name: a.name }), `Deleted ${a.name}.`);
    }
    if (app.autoName === a.name) {
      const first = app.server?.autos[0]?.name;
      if (first) await app.openAuto(first);
    }
  }
  async function deletePicked() {
    const names = [...picked].filter((n) => data?.autos.find((a) => a.name === n && a.kind !== "robot" && a.kind !== "hand-written"));
    if (!names.length) return;
    if (!(await app.confirm(`Delete ${names.length} auto${names.length === 1 ? "" : "s"}?`, `${names.join(", ")}: drafts and read copies only; nothing in the robot repo changes.`, "Delete"))) return;
    await run(async () => {
      for (const n of names) await api("POST", "/api/autos/delete", { name: n });
    }, `Deleted ${names.length}.`);
    picked = new Set();
  }
  async function importJson(f: File) {
    try {
      const spec = JSON.parse(await f.text()) as AutoSpec;
      const base = (spec.name || f.name.replace(/\..*$/, "")).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 36);
      const have = new Set(data?.autos.map((a) => a.name));
      let name = base;
      for (let i = 2; have.has(name) || name === "AutoPaths"; i++) name = `${base}_${i}`;
      const { reader: _r, source: _s, ...rest } = spec;
      await run(() => api("POST", "/api/autos/new", { name, spec: { ...rest, name } }), `Imported ${f.name} as the draft ${name}.`);
    } catch (e) {
      app.flash(`Could not import ${f.name}: ${(e as Error).message}`, "error");
    }
  }
  async function useRepo() {
    await run(async () => {
      app.server = await api<ServerState>("POST", "/api/repo", { path: repoPath.trim() });
    }, "Repo set. Scan it to read its autos.");
  }
  async function rescan() {
    await run(() => api("POST", "/api/ingest", {}), "Scanned the repo again.");
  }
  async function readOther(file: string, name: string) {
    const r = await run(() => api<{ name: string }>("POST", "/api/autos/read", { file, name }), `Read ${file.split("/").pop()}.`);
    if (r) await openAuto(r.name);
  }
</script>

<div class="manage">
  <header class="top">
    <div>
      <h1>Manage</h1>
      <span class="muted">{data ? `${data.autos.length} autos in ${data.repo.root}` : "Loading…"}</span>
    </div>
    <button onclick={() => (app.showManage = false)}>Close (Esc)</button>
  </header>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === "autos"} class:on={tab === "autos"} onclick={() => (tab = "autos")}>Autos</button>
    <button role="tab" aria-selected={tab === "partners"} class:on={tab === "partners"} onclick={() => (tab = "partners")}>Partner library {app.partnerLib ? `(${lib.length})` : ""}</button>
    <button role="tab" aria-selected={tab === "repo"} class:on={tab === "repo"} onclick={() => (tab = "repo")}>Robot repo</button>
    <button role="tab" aria-selected={tab === "files"} class:on={tab === "files"} onclick={() => (tab = "files")}>Files AutoTool wrote {data ? `(${data.written.filter((w) => w.exists).length})` : ""}</button>
  </div>

  {#if err}<p class="err">{err}</p>{/if}

  {#if data && tab === "autos"}
    <div class="bar">
      <div class="chips" role="radiogroup" aria-label="Show">
        <button class:on={filter === "all"} onclick={() => (filter = "all")}>All {data.autos.length}</button>
        {#each Object.entries(KIND) as [k, v]}
          {#if counts[k as Kind]}<button class:on={filter === k} onclick={() => (filter = k as Kind)} title={v.hint}><span class="dot {k}"></span>{v.label} {counts[k as Kind]}</button>{/if}
        {/each}
      </div>
      <input class="find" bind:value={q} placeholder="Find by name, file or Driver Station name" aria-label="Find" />
      <div class="grow"></div>
      <button onclick={() => importInput?.click()}>Import auto (.json)</button>
      <button onclick={() => ppInput?.click()}>Open a .pp file</button>
      {#if picked.size}<button class="danger" onclick={deletePicked} disabled={busy}>Delete {picked.size} selected</button>{/if}
      <input type="file" accept=".json,application/json" hidden bind:this={importInput} onchange={(e) => e.currentTarget.files?.[0] && importJson(e.currentTarget.files[0])} />
      <input type="file" accept=".pp,.json,application/json" hidden bind:this={ppInput} onchange={async (e) => { const f = e.currentTarget.files?.[0]; if (f) { await importPpText(f.name, await f.text()); app.showManage = false; } }} />
    </div>

    <table class="autos">
      <thead>
        <tr><th class="ck"></th><th>Auto</th><th>Driver Station</th><th>Kind</th><th class="num">Legs</th><th class="num"><button class="sortb" class:on={byPoints} onclick={() => (byPoints = !byPoints)} title="AUTO points (Table 10-2); click to sort">Points{byPoints ? " ↓" : ""}</button></th><th>Changed</th><th></th></tr>
      </thead>
      <tbody>
        {#each shown as a (a.name)}
          <tr class:current={a.name === app.autoName}>
            <td class="ck">{#if a.kind !== "robot" && a.kind !== "hand-written"}<input type="checkbox" aria-label={`select ${a.name}`} checked={picked.has(a.name)} onchange={(e) => { const n = new Set(picked); if (e.currentTarget.checked) n.add(a.name); else n.delete(a.name); picked = n; }} />{/if}</td>
            <td>
              <button class="name" onclick={() => openAuto(a.name)}>{a.name}</button>
              <div class="sub">{a.file ? a.file.split("/").pop() : a.readFrom ? `read from ${a.readFrom.split("/").pop()}` : "not written"}{a.framework ? `, ${a.framework}` : ""}</div>
            </td>
            <td>
              {#each a.opModes as o}<button class="ds" onclick={() => openAuto(a.name, o.alliance === "RED")}><span class="dot {o.alliance === 'RED' ? 'redd' : 'blued'}"></span>{o.name}</button>{:else}<span class="muted">—</span>{/each}
              {#if a.sim}
                <div class="sub" title={[a.sim.BLUE && `Blue: ${a.sim.BLUE.text}`, a.sim.RED && `Red: ${a.sim.RED.text}`].filter(Boolean).join("\n")}>
                  sim {a.sim.BLUE ? `Blue ${a.sim.BLUE.ok ? "✓" : "✗"}` : ""} {a.sim.RED ? `Red ${a.sim.RED.ok ? "✓" : "✗"}` : ""} · {when((a.sim.BLUE ?? a.sim.RED)!.at)}
                </div>
              {:else if a.kind === "robot"}
                <div class="sub">not checked in the sim since its last change</div>
              {/if}
            </td>
            <td><span class="badge {a.kind}" title={KIND[a.kind].hint}>{KIND[a.kind].label}</span></td>
            <td class="num">{a.legs}{a.review ? ` (${a.review} to review)` : ""}</td>
            <td class="num">{a.points ?? "—"}</td>
            <td class="when">{when(a.updatedAt)}<div class="sub">{a.history} edit{a.history === 1 ? "" : "s"} saved</div></td>
            <td class="acts">
              <button onclick={() => openAuto(a.name)}>Open</button>
              {#if a.name !== "AutoPaths"}<button onclick={() => rename(a)}>Rename</button>{/if}
              <button onclick={() => duplicate(a)}>Duplicate</button>
              {#if a.name !== app.autoName}<button onclick={() => usePartner(a)} title={`Run ${a.name} as the alliance partner of ${app.autoName}, to look for collisions`}>Use as partner</button>{/if}
              <button onclick={() => exportAuto(a)}>Export</button>
              {#if a.file}<button onclick={() => viewFile(a.file!)}>Code</button>{/if}
              {#if deletable(a)}<button class="danger" onclick={() => remove(a)} disabled={busy}>{a.kind === "robot" ? "Remove from robot" : "Delete"}</button>{/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="8" class="muted empty">Nothing matches.</td></tr>
        {/each}
      </tbody>
    </table>

    {#if data.folder.other.length || data.folder.pp.length}
      <h3>Also in the repo</h3>
      <ul class="also">
        {#each data.folder.other as o}<li><span class="dot other"></span><strong>{o.name}</strong> <span class="muted">{o.file.split("/").pop()}, hand-written</span> <button onclick={() => readOther(o.file, o.name.replace(/[^A-Za-z0-9_-]/g, "_"))}>Read it</button> <button onclick={() => viewFile(o.file, o.why)}>Code</button></li>{/each}
        {#each data.folder.pp as f}<li><span class="dot pp"></span><strong>{f.split("/").pop()}</strong> <span class="muted">{f}</span> <button onclick={async () => { const r = await api<{ text: string }>("POST", "/api/file", { path: f }); await importPpText(f, r.text); app.showManage = false; }}>Open as draft</button></li>{/each}
      </ul>
    {/if}
  {/if}

  {#if data && tab === "repo"}
    <section class="cards">
      <div class="card">
        <h3>Robot repo</h3>
        <div class="row"><input class="path" bind:value={repoPath} aria-label="robot repo path" /><button onclick={useRepo} disabled={busy || !repoPath.trim() || repoPath === data.repo.root}>Use</button></div>
        <dl>
          <dt>Autos folder</dt><dd><code>{data.repo.autosDir}</code></dd>
          <dt>Commit</dt><dd><code>{data.repo.head ?? "unknown"}</code></dd>
          <dt>Default route</dt><dd><code>{data.repo.defaultRoute.split("/").pop()}</code> <span class="muted">(what AutoRunner runs when an OpMode brings no route)</span></dd>
          <dt>Route hook</dt><dd>{data.repo.hooked ? "AutoRunner has route(): each AutoTool auto runs its own route" : "not yet: added (with your confirm) at the first Write of a new auto"}</dd>
        </dl>
        <div class="row"><button onclick={rescan} disabled={busy}>Scan again</button><button onclick={() => ((app.showManage = false), (app.showSettings = true))}>Settings</button></div>
      </div>
      <div class="card">
        <h3>Reference auto</h3>
        {#if data.style}
          <dl>
            <dt>Sample</dt><dd><code>{data.style.autoFile.split("/").pop()}</code> <span class="muted">from {data.style.sampleRoot}</span></dd>
            <dt>House style</dt><dd>{data.style.confirmed ? "confirmed" : "not confirmed yet"}, analyzed {when(data.style.at)}</dd>
            <dt>New autos</dt><dd>one file each; AutoTool writes only the route lines between its markers</dd>
          </dl>
        {:else}<p class="muted">None yet.</p>{/if}
        <div class="row"><button onclick={() => ((app.showManage = false), (app.showSettings = true))}>Change it (Settings)</button><button onclick={() => ((app.showManage = false), (app.redoSetup = true))}>Redo setup</button></div>
      </div>
    </section>
  {/if}

  {#if tab === "partners"}
    <div class="bar">
      <span class="muted">Other teams' autos by team number, in <code>{app.partnerLib?.dir ?? "partners/"}</code> (the AutoTool repo: commit it with git to share it with the team). Add one from the Partner tab of any auto (a .pp file, or a route drawn here).</span>
      <div class="grow"></div>
      <button disabled={!lib.length} onclick={async () => download(`partners-${new Date().toISOString().slice(0, 10)}.json`, await api("POST", "/api/partners/export", {}))}>Export all</button>
      <button onclick={() => libInput?.click()}>Import a teammate's file</button>
      <input type="file" accept="application/json" hidden bind:this={libInput} onchange={(e) => e.currentTarget.files?.[0] && importLib(e.currentTarget.files[0])} />
    </div>
    {#if !lib.length}
      <p class="muted empty">No partners yet.</p>
    {:else}
      <table class="files">
        <thead><tr><th>Team</th><th>Route</th><th>Seen</th><th>How sure</th><th></th></tr></thead>
        <tbody>
          {#each lib as t (t.team)}
            {#each t.versions as v, i (v.id)}
              <tr>
                <td>{#if i === 0}<strong>{t.team}</strong> {t.name}<div class="sub">{t.robot ? `${t.robot.body.front + t.robot.body.back} x ${t.robot.body.left + t.robot.body.right} in, ${t.robot.maxVel} in/s` : "size and speed not saved"}{t.notes ? ` · ${t.notes}` : ""}</div>{/if}</td>
                <td>{v.autoName || "route"}{v.side ? ` · ${v.side}` : ""}<div class="sub">{v.source === "pp" ? "from a .pp file" : "drawn in AutoTool"}{v.notes ? ` · ${v.notes}` : ""}{i === 0 && t.versions.length > 1 ? " · newest" : ""}</div></td>
                <td class="when">{v.date}{v.event ? `, ${v.event}` : ""}</td>
                <td>{v.confidence}</td>
                <td class="acts">
                  <button onclick={() => usePartnerRoute(t.team, v.id)} disabled={!app.spec}>Use as partner</button>
                  <button onclick={() => editRoute(t.team, v)}>Edit</button>
                  {#if i === 0}<button onclick={() => editTeam(t)}>Team…</button>{/if}
                  <button onclick={async () => download(`partner-${t.team}.json`, await api("POST", "/api/partners/export", { team: t.team }))}>Export</button>
                  <button class="danger" onclick={() => removeRoute(t.team, t.versions.length > 1 ? v.id : undefined, t.versions.length > 1 ? `this route of team ${t.team}` : `team ${t.team}`)}>Delete</button>
                </td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}

  {#if data && tab === "files"}
    <div class="bar">
      <span class="muted">Every file AutoTool wrote or removed in this repo, and whether it changed since. AutoTool only ever touches these.</span>
      <div class="grow"></div>
      {#if data.written.some((w) => !w.exists && !data!.lastWrite.includes(w.file))}<button onclick={() => run(() => api("POST", "/api/manage/forget-gone", {}), "Forgot the files that are gone.")}>Forget gone files</button>{/if}
      {#if data.lastWrite.length}<button onclick={async () => (await undoWrite(), await load())}>Undo last write ({data.lastWrite.map((f) => f.split("/").pop()).join(", ")})</button>{/if}
    </div>
    <table class="files">
      <thead><tr><th>File</th><th>Last write</th><th>State</th><th></th></tr></thead>
      <tbody>
        {#each data.written as w (w.file)}
          <tr>
            <td><code>{w.file.split("/").pop()}</code><div class="sub">{w.file}</div></td>
            <td class="when">{when(w.at)}</td>
            <td>{#if w.removed}<span class="badge draft">removed by AutoTool</span>{:else if !w.exists}<span class="badge read">gone (deleted outside AutoTool)</span>{:else if w.changed}<span class="badge hand-written">edited by hand since</span>{:else}<span class="badge robot">as AutoTool wrote it</span>{/if}</td>
            <td>{#if w.exists}<button onclick={() => viewFile(w.file)}>Code</button>{/if}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="muted empty">AutoTool has not written anything in this repo yet.</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .manage {
    padding: 14px 20px 40px;
    max-width: 1280px;
    margin: 0 auto;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  h1 {
    font-size: 20px;
    margin: 0;
    letter-spacing: -0.01em;
  }
  h3 {
    font-size: 14px;
    margin: 18px 0 6px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--line);
    margin: 12px 0;
  }
  .tabs button {
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: none;
    padding: 8px 12px;
  }
  .tabs button.on {
    border-bottom-color: var(--sel);
    color: #fff;
  }
  .bar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .grow {
    flex: 1;
  }
  .chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .chips button {
    border-radius: 999px;
    font-size: 12px;
    padding: 3px 10px;
  }
  .chips button.on {
    background: #13283a;
    border-color: var(--sel);
    color: #fff;
  }
  .find {
    min-width: 240px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
    font-size: 12px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 8px;
    border-bottom: 1px solid #1d2127;
    vertical-align: top;
  }
  tr.current td {
    background: #0f1d2a;
  }
  .ck {
    width: 24px;
  }
  .sortb {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .sortb.on {
    color: var(--sel);
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .when {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .sub {
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
  }
  .name {
    background: none;
    border: 0;
    padding: 0;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
  }
  .name:hover {
    color: var(--sel);
  }
  .ds {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    padding: 2px 8px;
    margin: 0 4px 4px 0;
    border-radius: 999px;
  }
  .acts {
    white-space: nowrap;
    text-align: right;
  }
  .acts button {
    font-size: 12px;
    padding: 3px 8px;
  }
  .danger {
    border-color: #7f1d1d;
    color: #fca5a5;
  }
  .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
    border: 1px solid var(--line);
  }
  .badge.robot {
    color: #86efac;
    border-color: #14532d;
  }
  .badge.hand-written {
    color: #fcd34d;
    border-color: #713f12;
  }
  .badge.draft {
    color: #cbd5e1;
  }
  .badge.read,
  .badge.sample {
    color: #93c5fd;
    border-color: #1e3a5f;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
  .dot.robot,
  .dot.blued {
    background: #3b82f6;
  }
  .dot.redd {
    background: #ef4444;
  }
  .dot.hand-written {
    background: #f59e0b;
  }
  .dot.draft {
    border: 1.5px solid var(--unsure);
  }
  .dot.read,
  .dot.sample,
  .dot.pp {
    background: var(--repo);
  }
  .dot.other {
    background: var(--line);
  }
  .also {
    list-style: none;
    padding: 0;
    font-size: 13px;
  }
  .also li {
    padding: 4px 0;
  }
  .also button {
    font-size: 12px;
    padding: 2px 8px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 14px;
    background: #12151a;
  }
  .card h3 {
    margin-top: 0;
  }
  .row {
    display: flex;
    gap: 6px;
    margin: 8px 0;
    flex-wrap: wrap;
  }
  .path {
    flex: 1;
    min-width: 220px;
  }
  dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 4px 10px;
    font-size: 13px;
    margin: 8px 0;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .empty {
    text-align: center;
    padding: 18px;
  }
  .err {
    color: #fca5a5;
  }
  @media (max-width: 900px) {
    .autos th:nth-child(5),
    .autos td:nth-child(5),
    .autos th:nth-child(6),
    .autos td:nth-child(6) {
      display: none;
    }
    .acts {
      white-space: normal;
    }
  }
</style>
