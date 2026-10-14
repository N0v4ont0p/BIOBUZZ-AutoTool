<script lang="ts">
  // Our auto and the alliance partner's, run together: pick the partner, set its robot and start delay, see every
  // place the two robots meet, and fix one with a click (a WAIT on our side, or the start delay to agree on).
  import { type Comparison, type Conflict, type PartnerOpts, findFix, partnerModel } from "../../shared/compare.ts";
  import type { AutoFeatures } from "../../shared/features.ts";
  import { autoPoints } from "../../shared/points.ts";
  import type { RobotModel } from "../../shared/profile.ts";
  import { api } from "../api.ts";
  import { app } from "../state.svelte.ts";

  let { comparison, partnerFeatures, ourFeatures, model }: { comparison: Comparison | null; partnerFeatures: AutoFeatures | null; ourFeatures: AutoFeatures | null; model: RobotModel } = $props();
  // the alliance's AUTO points: LEAVE and PARK for each robot, one HIVE for both
  const alliance = $derived(app.pack && ourFeatures && partnerFeatures && app.partner ? autoPoints(app.pack, ourFeatures, { features: partnerFeatures, delayS: app.partner.opts.delayS }) : null);
  const ours = $derived(app.pack && ourFeatures ? autoPoints(app.pack, ourFeatures) : null);

  let ppInput: HTMLInputElement | undefined = $state();
  let fixing = $state<number | null>(null);
  let note = $state<{ i: number; text: string; delayS?: number } | null>(null);

  const o = $derived(app.partner?.opts);
  const autos = $derived((app.server?.autos ?? []).filter((a) => a.name !== app.autoName));
  const lib = $derived(app.partnerLib?.teams ?? []);
  $effect(() => {
    if (!app.partnerLib) app.loadPartnerLib().catch(() => {});
  });
  const libTeam = $derived(app.partner?.lib ? lib.find((t) => t.team === app.partner!.lib!.team) : undefined);
  const newer = $derived(libTeam && app.partner?.lib && libTeam.versions[0] && libTeam.versions[0].id !== app.partner.lib.id ? libTeam.versions[0] : null);
  const robotDiffers = $derived(!!o && !!app.partner?.lib && JSON.stringify(libTeam?.robot ?? null) !== JSON.stringify({ body: o.body, maxVel: o.maxVel }));
  const versionLabel = (t: (typeof lib)[number], v: (typeof lib)[number]["versions"][number]) => `${t.team}${t.name ? ` ${t.name}` : ""} · ${v.autoName || "route"} (${v.date}${v.event ? `, ${v.event}` : ""}, ${v.confidence})`;

  // a team number for a new library entry (blank = do not keep it in the library)
  function askTeam(why: string): string | null {
    const t = prompt(`${why}\nTeam number (blank to skip the library):`, app.partner?.lib?.team ?? "")?.trim() ?? "";
    if (!t) return null;
    if (!/^[0-9]{1,6}$/.test(t)) {
      app.flash("A team number is 1-6 digits.", "warn");
      return null;
    }
    return t;
  }
  async function saveToLibrary() {
    if (!app.partner || !o) return;
    const team = askTeam(`Save "${app.partner.label}" in the partner library (partners/ in the AutoTool repo, shared through git).`);
    if (!team) return;
    const known = lib.find((t) => t.team === team);
    const name = known ? known.name : (prompt("Team name (optional):", "")?.trim() ?? "");
    const r = await api<{ id: string; team: string }>("POST", "/api/partners/add", { team, ...(known ? {} : { name }), robot: { body: o.body, maxVel: o.maxVel }, autoName: app.partner.label, confidence: "seen", spec: $state.snapshot(app.partner.spec) });
    await app.loadPartnerLib();
    await app.setPartner(`lib:${r.team}/${r.id}`, o);
    app.flash(`Saved in the partner library under team ${team}. Commit partners/ with git to share it with the team.`);
  }
  async function saveRobot() {
    if (!app.partner?.lib || !o) return;
    await api("POST", "/api/partners/team", { team: app.partner.lib.team, robot: { body: o.body, maxVel: o.maxVel } });
    await app.loadPartnerLib();
    app.flash(`Team ${app.partner.lib.team}'s robot size and speed saved: they come with every route of theirs.`);
  }
  async function editNotes() {
    const l = app.partner?.lib;
    if (!l) return;
    const v = libTeam?.versions.find((x) => x.id === l.id);
    const notes = prompt(`Notes on this route of team ${l.team} (what they told you, where they park, how reliable it is):`, v?.notes ?? "");
    if (notes === null) return;
    await api("POST", "/api/partners/update", { team: l.team, id: l.id, notes });
    await app.loadPartnerLib();
    await app.setPartner(app.partner!.ref, o);
  }
  const pp = $derived(app.server?.folder.pp ?? []);
  const contact = $derived(comparison?.conflicts.filter((c) => c.kind === "collision" || c.kind === "nearMiss" || c.kind === "park" || (c.kind === "start" && c.gapIn !== Infinity)) ?? []);
  const collisions = $derived(comparison?.conflicts.filter((c) => c.kind === "collision").length ?? 0);
  const near = $derived(comparison?.conflicts.filter((c) => c.kind === "nearMiss").length ?? 0);
  const KIND: Record<Conflict["kind"], string> = { collision: "Collision", nearMiss: "Near miss", start: "Start", park: "Park", elements: "Same elements" };

  async function pick(v: string) {
    note = null;
    try {
      if (!v) return await app.setPartner(null);
      if (v.startsWith("pp:")) {
        const r = await api<{ text: string }>("POST", "/api/file", { path: v.slice(3) });
        return await usePp(v.slice(3), r.text);
      }
      await app.setPartner(v);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }
  // a .pp file goes into the partner library under the team's number (or, without one, becomes a draft)
  async function usePp(file: string, text: string) {
    const short = file.split("/").pop()!.replace(/\.[^.]+$/, "");
    const team = askTeam(`Partner route from ${file.split("/").pop()}.`);
    if (team) {
      const known = lib.find((t) => t.team === team);
      const name = known ? undefined : (prompt("Team name (optional):", "")?.trim() ?? "");
      const r = await api<{ id: string; team: string }>("POST", "/api/partners/add", { team, ...(name !== undefined ? { name } : {}), pp: text, autoName: short, confidence: "seen" });
      await app.loadPartnerLib();
      await app.setPartner(`lib:${r.team}/${r.id}`);
      return app.flash(`${file.split("/").pop()} saved in the partner library under team ${team}, and it is the partner now.`);
    }
    const base = `partner_${file.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 40);
    const have = new Set(app.server?.autos.map((a) => a.name) ?? []);
    let name = base;
    for (let i = 2; have.has(name); i++) name = `${base.slice(0, 36)}_${i}`;
    const r = await api<{ spec: unknown; warnings: string[] }>("POST", "/api/import-pp", { project: JSON.parse(text), name });
    await api("POST", "/api/autos/new", { name, spec: r.spec });
    await app.refresh();
    await app.setPartner(name);
    app.flash(`${file.split("/").pop()} is the partner now (saved as the draft "${name}").`);
  }
  function set<K extends keyof PartnerOpts>(k: K, v: PartnerOpts[K]) {
    if (o) app.setPartnerOpts({ ...o, [k]: v });
  }
  function setBody(k: keyof PartnerOpts["body"], v: number) {
    if (o && Number.isFinite(v) && v > 0) app.setPartnerOpts({ ...o, body: { ...o.body, [k]: v } });
  }
  function fix(c: Conflict, i: number) {
    if (!app.partner || !partnerFeatures || !app.pack || !o) return;
    fixing = i;
    note = null;
    // let the button show its busy state before the search runs
    setTimeout(() => {
      try {
        const f = findFix(app.snapshot(), model, partnerFeatures, partnerModel(model, o), app.pack!, o, c);
        if (f.kind === "wait") {
          app.change(f.spec);
          app.flash(`${f.legId} now holds ${f.addS} s longer at its end (WAIT): that clears it. Ctrl+Z undoes it.`);
        } else if (f.kind === "delay") note = { i, text: `No wait on our side clears it. If the partner starts ${f.delayS} s later, it is clear: agree on that with them.`, delayS: f.delayS };
        else note = { i, text: "No wait on our side (up to 5 s) and no partner delay (up to 10 s) clears it: change one of the routes." };
      } finally {
        fixing = null;
      }
    }, 20);
  }
</script>

<div class="partner">
  <div class="f top">
    <span class="k">Partner</span>
    <select value={app.partner?.ref ?? ""} onchange={(e) => pick(e.currentTarget.value)} aria-label="partner auto">
      <option value="">none</option>
      {#if lib.length}<optgroup label="Partner library">{#each lib as t}{#each t.versions as v}<option value={`lib:${t.team}/${v.id}`}>{versionLabel(t, v)}</option>{/each}{/each}</optgroup>{/if}
      {#if autos.length}<optgroup label="Autos in AutoTool">{#each autos as a}<option value={a.name}>{a.opModes[0]?.name.replace(/_/g, " ") ?? a.name}{a.file ? "" : " (draft)"}</option>{/each}</optgroup>{/if}
      {#if pp.length}<optgroup label="Pedro paths in the repo">{#each pp as f}<option value={`pp:${f}`}>{f.split("/").pop()}</option>{/each}</optgroup>{/if}
    </select>
    <button onclick={() => ppInput?.click()} title="Import the partner's Pedro visualizer file">Open .pp…</button>
    <input type="file" accept=".pp,.json,application/json" hidden bind:this={ppInput} onchange={async (e) => { const f = e.currentTarget.files?.[0]; if (f) await usePp(f.name, await f.text()).catch((x) => app.flash((x as Error).message, "error")); }} />
  </div>

  {#if !app.partner || !o}
    <p class="muted">Pick your alliance partner's auto (drawn here, a draft, or their .pp file). Both run on the blue side together, so you can see whether the two robots meet. ▶ on the timeline plays them.</p>
  {:else}
    {#if app.partner.lib}
      {@const l = app.partner.lib}
      <div class="libcard">
        <div><strong>Team {l.team}{l.name ? ` ${l.name}` : ""}</strong> <span class="muted">{l.date}{l.event ? ` · ${l.event}` : ""} · {l.side || "side?"} · {l.confidence}</span></div>
        {#if l.notes}<div class="libnotes">{l.notes}</div>{/if}
        {#if newer}<div class="hint">A newer route of theirs is in the library ({newer.date}{newer.event ? `, ${newer.event}` : ""}): <button class="link" onclick={() => pick(`lib:${l.team}/${newer!.id}`)}>use it</button></div>{/if}
        <div class="row">
          <button onclick={editNotes}>Notes…</button>
          {#if robotDiffers}<button onclick={saveRobot} title="Keep this size and speed for every route of this team">Save size and speed to team {l.team}</button>{/if}
        </div>
      </div>
    {:else}
      <div class="row"><button onclick={saveToLibrary} title="Keep this route under the team's number, with its robot size and speed">Save to the partner library…</button><span class="muted">so the next match with them starts here</span></div>
    {/if}
    <div class="summary" class:bad={collisions > 0} class:warn={!collisions && contact.length > 0}>
      {#if contact.length}
        {collisions ? `${collisions} collision${collisions > 1 ? "s" : ""}` : ""}{collisions && near ? ", " : ""}{near ? `${near} near miss${near > 1 ? "es" : ""}` : ""}{contact.length - collisions - near ? `${collisions || near ? ", " : ""}${contact.length - collisions - near} at the start or park` : ""}
      {:else if comparison?.closest}
        Clear: closest {comparison.closest.gapIn.toFixed(1)} in apart, at {comparison.closest.t.toFixed(1)} s.
      {/if}
    </div>

    {#if alliance && ours}
      <div class="alliance" title={alliance.notes.join("\n")}>
        <strong>Alliance AUTO ≈ {alliance.total} pts</strong>
        <span class="muted">us {ours.total} · LEAVE {alliance.leave} · PARK {alliance.park} · HIVE TIP {alliance.tipPoints}{alliance.tips.length ? ` (${alliance.tips.map((t) => `${t.robot === "us" ? "our" : "their"} ${t.legId} at ${t.atS.toFixed(1)} s`).join(", ")})` : ""}{collisions ? " · if they do not collide" : ""}</span>
      </div>
    {/if}

    {#if comparison?.conflicts.length}
      <ul class="list">
        {#each comparison.conflicts as c, i}
          <li class={c.kind}>
            <button class="jump" onclick={() => c.kind !== "elements" && c.gapIn !== Infinity && (app.scrubT = c.t)} title="Show this moment on the field">
              <span class="tag">{KIND[c.kind]}</span><span class="txt">{c.text}</span>
            </button>
            {#if c.kind === "collision" || c.kind === "nearMiss" || c.kind === "park"}
              <button class="fix" disabled={fixing !== null || !!app.proposal} onclick={() => fix(c, i)}>{fixing === i ? "…" : "Fix"}</button>
            {/if}
            {#if note?.i === i}
              <div class="note">{note.text} {#if note.delayS !== undefined}<button class="link" onclick={() => (set("delayS", note!.delayS!), (note = null))}>Set the delay to {note.delayS} s here</button>{/if}</div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="settings">
      <div class="f">
        <span class="k">Start delay</span>
        <span class="row"><input type="range" min="0" max="10" step="0.25" value={o.delayS} oninput={(e) => set("delayS", Number(e.currentTarget.value))} aria-label="partner start delay" /><span class="num">{o.delayS.toFixed(2)} s</span></span>
      </div>
      <div class="f">
        <span class="k">Robot size</span>
        <span class="row">
          {#each ["front", "back", "left", "right"] as const as k}
            <label class="sz">{k}<input type="number" min="3" max="12" step="0.5" value={o.body[k]} onchange={(e) => setBody(k, Number(e.currentTarget.value))} aria-label={`partner centre to ${k} (in)`} /></label>
          {/each}
          <span class="muted">in from its centre</span>
        </span>
      </div>
      <div class="f">
        <span class="k">Top speed</span>
        <span class="row"><input type="number" min="10" max="120" step="1" value={o.maxVel} onchange={(e) => set("maxVel", Math.max(10, Number(e.currentTarget.value) || o.maxVel))} aria-label="partner top speed (in/s)" /> in/s</span>
      </div>
      <div class="f">
        <span class="k">Margin</span>
        <span class="row"><input type="number" min="0" max="12" step="0.5" value={o.marginIn} onchange={(e) => set("marginIn", Math.max(0, Number(e.currentTarget.value)))} aria-label="near-miss margin (in)" /> in · timing ± <input type="number" min="0" max="2" step="0.1" value={o.tolS} onchange={(e) => set("tolS", Math.max(0, Number(e.currentTarget.value)))} aria-label="timing tolerance (s)" /> s</span>
      </div>
      <p class="muted">Times are AutoTool's estimates; a near miss is closer than the margin, or touching if the partner runs that much early or late. The partner's auto is never changed.</p>
    </div>
  {/if}
</div>

<style>
  .partner {
    padding: 8px 10px 14px;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .f {
    display: grid;
    grid-template-columns: 82px 1fr;
    gap: 8px;
    align-items: center;
  }
  .f.top {
    grid-template-columns: 82px 1fr auto;
  }
  .k {
    color: var(--muted);
    font-size: 12px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
  }
  .num {
    font-variant-numeric: tabular-nums;
    min-width: 50px;
  }
  input[type="number"] {
    width: 56px;
  }
  input[type="range"] {
    flex: 1;
    accent-color: var(--partner);
  }
  .sz {
    display: inline-flex;
    flex-direction: column;
    font-size: 11px;
    color: var(--muted);
  }
  .sz input {
    width: 48px;
  }
  .summary {
    padding: 6px 10px;
    border-radius: 7px;
    border: 1px solid #14532d;
    background: #052e16;
    font-weight: 600;
  }
  .summary.bad {
    border-color: var(--shoot);
    background: #3f0d0d;
  }
  .summary.warn {
    border-color: var(--unsure);
    background: #2a1d05;
  }
  .libcard {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }
  .libnotes {
    color: #cbd5e1;
    white-space: pre-wrap;
  }
  .hint {
    color: #9cc9f5;
  }
  .alliance {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }
  .alliance strong {
    font-size: 14px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 6px;
    align-items: start;
    padding: 5px 8px;
    background: #12161b;
    border-radius: 6px;
  }
  .collision .tag {
    color: #fca5a5;
  }
  .nearMiss .tag,
  .start .tag,
  .park .tag {
    color: #fcd34d;
  }
  .elements .tag {
    color: var(--partner);
  }
  .jump {
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    color: var(--text);
    font-size: 12px;
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .tag {
    font-weight: 700;
    white-space: nowrap;
  }
  .txt {
    color: #cbd5e1;
  }
  .fix {
    font-size: 12px;
    padding: 2px 10px;
  }
  .note {
    grid-column: 1 / -1;
    font-size: 12px;
    color: #9cc9f5;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--sel);
    text-decoration: underline;
    font-size: 12px;
  }
  .settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--line);
    padding-top: 8px;
  }
</style>
