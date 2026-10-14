<script lang="ts">
  // Match day: which of our autos to run with which partner. The pairing matrix runs every pair of our autos
  // with every partner route (collisions and alliance AUTO points); the sheet is one page for the drive team:
  // both autos, both starts on our alliance's side, what was agreed, and the points. Print it or show it full screen.
  import { type Comparison, DEFAULT_PARTNER, type PartnerOpts, compareRuns, partnerModel } from "../../shared/compare.ts";
  import { type AutoFeatures, computeFeatures } from "../../shared/features.ts";
  import { footprint } from "../../shared/geometry.ts";
  import { type Points, autoPoints } from "../../shared/points.ts";
  import type { AutoSpec } from "../../shared/spec.ts";
  import fieldImage from "../../../../public/fields/biobuzz.webp";
  import { api, uiSetting } from "../api.ts";
  import { pointsAttr, sx } from "../draw.ts";
  import { app } from "../state.svelte.ts";

  interface Col {
    ref: string; // AutoTool auto name, or lib:<team>/<version>
    label: string;
    team: string;
    opts: PartnerOpts;
    notes: string;
  }
  interface Cell {
    cmp: Comparison;
    alliance: Points;
    ours: Points;
    theirs: Points;
    collisions: number;
    near: number;
  }
  interface Plan {
    id?: string;
    match: string;
    alliance: "BLUE" | "RED";
    ourAuto: string;
    partnerRef: string;
    partnerTeam: string;
    delayS: number;
    notes: string;
    at?: string;
  }

  const ourAutos = $derived((app.server?.autos ?? []).filter((a) => a.file && a.name !== "AutoPaths"));
  const drafts = $derived((app.server?.autos ?? []).filter((a) => !a.file));
  let picked = $state<string[] | null>(null); // our autos in the matrix (null = every auto on the robot)
  let extraCols = $state<string[]>([]); // AutoTool autos added as partner columns
  const rows = $derived(picked ?? ourAutos.map((a) => a.name));

  const specs = new Map<string, AutoSpec>();
  const feats = new Map<string, AutoFeatures>();
  let cols = $state<Col[]>([]);
  let cells = $state<Record<string, Cell | { error: string }>>({});
  let busy = $state(false);
  let sel = $state<{ row: string; col: string } | null>(null);
  let plan = $state<Plan>({ match: "", alliance: "BLUE", ourAuto: "", partnerRef: "", partnerTeam: "", delayS: 0, notes: "" });
  let saved = $state<Plan[]>([]);
  let simOf = $state<Record<string, { BLUE?: { ok: boolean }; RED?: { ok: boolean } } | null>>({});
  let teleop = $state<string | null>(null);
  let sheet: HTMLElement | undefined = $state();

  const baseOpts = (): PartnerOpts => ({ ...DEFAULT_PARTNER, maxVel: app.model?.maxVel ?? DEFAULT_PARTNER.maxVel });

  async function spec(ref: string): Promise<AutoSpec> {
    const hit = specs.get(ref);
    if (hit) return hit;
    let s: AutoSpec;
    if (ref.startsWith("lib:")) {
      const [team, id] = ref.slice(4).split("/");
      s = (await api<{ version: { spec: AutoSpec } }>("POST", "/api/partners/get", { team, id })).version.spec;
    } else s = await api<AutoSpec>("POST", "/api/autos/get", { name: ref });
    specs.set(ref, s);
    return s;
  }
  function features(ref: string, s: AutoSpec, opts?: PartnerOpts): AutoFeatures {
    const key = `${ref}|${opts ? JSON.stringify([opts.body, opts.maxVel]) : "us"}`;
    let f = feats.get(key);
    if (!f) {
      f = computeFeatures(s, app.pack!, opts ? partnerModel(app.model!, opts) : app.model!);
      feats.set(key, f);
    }
    return f;
  }
  // the delay this pair was last run with in the editor (the Partner tab), else 0
  function delayFor(row: string, col: string): number {
    const s = uiSetting<{ ref?: string; name?: string; opts: PartnerOpts } | null>(`partner:${row}`, null);
    return s && (s.ref ?? s.name) === col ? s.opts.delayS : 0;
  }

  async function build() {
    if (!app.pack || !app.model) return;
    busy = true;
    try {
      if (!app.partnerLib) await app.loadPartnerLib();
      const lib: Col[] = (app.partnerLib?.teams ?? [])
        .filter((t) => t.versions.length)
        .map((t) => ({ ref: `lib:${t.team}/${t.versions[0].id}`, label: `${t.team}${t.name ? ` ${t.name}` : ""}${t.versions[0].autoName ? ` · ${t.versions[0].autoName}` : ""}`, team: t.team, opts: { ...baseOpts(), ...(t.robot ? { body: t.robot.body, maxVel: t.robot.maxVel } : {}) }, notes: [t.notes, t.versions[0].notes].filter(Boolean).join(" · ") }));
      cols = [...lib, ...extraCols.map((r) => ({ ref: r, label: r, team: "", opts: baseOpts(), notes: "" }))];
      const out: typeof cells = {};
      for (const row of rows) {
        const os = await spec(row);
        const of = features(row, os);
        for (const c of cols) {
          try {
            const ts = await spec(c.ref);
            const opts = { ...c.opts, delayS: delayFor(row, c.ref) };
            const tf = features(c.ref, ts, opts);
            const cmp = compareRuns(of, app.model, tf, partnerModel(app.model, opts), opts);
            out[`${row}|${c.ref}`] = {
              cmp,
              alliance: autoPoints(app.pack, of, { features: tf, delayS: opts.delayS }),
              ours: autoPoints(app.pack, of),
              theirs: autoPoints(app.pack, tf),
              collisions: cmp.conflicts.filter((x) => x.kind === "collision").length,
              near: cmp.conflicts.filter((x) => x.kind === "nearMiss" || x.kind === "park" || (x.kind === "start" && x.gapIn !== Infinity)).length,
            };
          } catch (e) {
            out[`${row}|${c.ref}`] = { error: (e as Error).message };
          }
        }
      }
      cells = out;
    } catch (e) {
      app.flash((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }

  async function loadSide() {
    try {
      saved = await api<Plan[]>("GET", "/api/plans");
      const m = await api<{ autos: { name: string; sim: { BLUE?: { ok: boolean }; RED?: { ok: boolean } } | null }[] }>("GET", "/api/manage");
      simOf = Object.fromEntries(m.autos.map((a) => [a.name, a.sim]));
    } catch {
      /* the sheet still works without them */
    }
  }

  $effect(() => {
    void rows.join();
    void extraCols.join();
    build();
  });
  $effect(() => {
    loadSide();
  });

  function choose(row: string, col: Col) {
    sel = { row, col: col.ref };
    plan = { ...plan, id: undefined, ourAuto: row, partnerRef: col.ref, partnerTeam: col.team, delayS: delayFor(row, col.ref) };
    teleop = null;
    const file = app.server?.autos.find((a) => a.name === row)?.file;
    if (file) api<{ text: string }>("POST", "/api/file", { path: file }).then((r) => (teleop = /preselectTeleOp\s*=\s*"([^"]+)"/.exec(r.text)?.[1] ?? null)).catch(() => {});
    queueMicrotask(() => sheet?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  async function openPlan(p: Plan) {
    plan = { ...p };
    if (!rows.includes(p.ourAuto)) picked = [...rows, p.ourAuto];
    if (!p.partnerRef.startsWith("lib:") && !extraCols.includes(p.partnerRef)) extraCols = [...extraCols, p.partnerRef];
    await build();
    const col = cols.find((c) => c.ref === p.partnerRef);
    if (col) {
      sel = { row: p.ourAuto, col: col.ref };
      plan = { ...p };
    } else app.flash("That plan's partner route is no longer in the library.", "warn");
  }
  async function savePlan() {
    try {
      const p = await api<Plan>("POST", "/api/plans/save", { plan: $state.snapshot(plan) });
      plan = { ...plan, id: p.id, at: p.at };
      saved = await api<Plan[]>("GET", "/api/plans");
      app.flash(`Plan ${p.match || "for this match"} saved.`);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }
  async function deletePlan(p: Plan) {
    if (!(await app.confirm("Delete this plan?", `${p.match || "The plan"}: ${p.ourAuto} with ${p.partnerRef}.`, "Delete"))) return;
    await api("POST", "/api/plans/delete", { id: p.id });
    saved = await api<Plan[]>("GET", "/api/plans");
  }
  async function openInEditor() {
    if (!sel) return;
    app.showPlan = false;
    await app.openAuto(sel.row);
    const col = cols.find((c) => c.ref === sel!.col);
    await app.setPartner(sel.col, col ? { ...col.opts, delayS: plan.delayS } : undefined);
    app.redView = plan.alliance === "RED";
  }

  // the chosen pair, recomputed with the plan's delay
  const chosen = $derived.by(() => {
    if (!sel || !app.pack || !app.model) return null;
    const col = cols.find((c) => c.ref === sel!.col);
    const os = specs.get(sel.row);
    const ts = col ? specs.get(col.ref) : undefined;
    if (!col || !os || !ts) return null;
    const opts = { ...col.opts, delayS: plan.delayS };
    const of = features(sel.row, os);
    const tf = features(col.ref, ts, opts);
    const cmp = compareRuns(of, app.model, tf, partnerModel(app.model, opts), opts);
    return { col, os, ts, of, tf, opts, cmp, alliance: autoPoints(app.pack, of, { features: tf, delayS: opts.delayS }), ours: autoPoints(app.pack, of), theirs: autoPoints(app.pack, tf) };
  });

  const red = $derived(plan.alliance === "RED");
  // headings in (-180, 180]: a robot facing the blue wall reads 180, not -180
  const wrap = (d: number) => {
    const w = ((((d + 180) % 360) + 360) % 360) - 180;
    return w === -180 ? 180 : w;
  };
  // a pose as the robot is placed for our alliance (red: turned 180 degrees about the field centre)
  function onSide(p: { x: number | null; y: number | null; headingDeg: number | null } | undefined) {
    if (!p || p.x === null || p.y === null || p.headingDeg === null) return "not set";
    const [x, y, h] = red ? [144 - p.x, 144 - p.y, wrap(p.headingDeg + 180)] : [p.x, p.y, wrap(p.headingDeg)];
    return `x ${x.toFixed(1)}, y ${y.toFixed(1)}, heading ${h.toFixed(0)}°`;
  }
  const startOf = (s: AutoSpec) => s.poses.find((p) => p.name === s.start);
  const lastOf = (s: AutoSpec) => s.poses.find((p) => p.name === s.legs.at(-1)?.path.to);
  const dsName = (row: string) => {
    const a = app.server?.autos.find((x) => x.name === row);
    return a?.opModes.find((o) => o.alliance === plan.alliance)?.name ?? a?.opModes[0]?.name ?? row;
  };
  const waits = (s: AutoSpec) => s.legs.filter((l) => l.end === "WAIT" && l.waitS).map((l) => `${l.id} ${l.waitS} s`);
  const fp = (p: { x: number; y: number; headingDeg: number }, body: PartnerOpts["body"]) => pointsAttr(footprint(p, body), red);
  const pose3 = (p: { x: number | null; y: number | null; headingDeg: number | null } | undefined) => (p && p.x !== null && p.y !== null && p.headingDeg !== null ? { x: p.x, y: p.y, headingDeg: p.headingDeg } : null);

  function fullScreen() {
    sheet?.requestFullscreen?.().catch(() => app.flash("Full screen is not available here.", "warn"));
  }
</script>

<div class="plan">
  <div class="top">
    <h2>Match plan</h2>
    <span class="muted">Which of our autos to run with which partner. Both are drawn for blue; the sheet shows our alliance's side.</span>
    <span class="grow"></span>
    <button onclick={() => (app.showPlan = false)}>Close (Esc)</button>
  </div>

  {#if saved.length}
    <div class="saved">
      <span class="muted">Saved plans</span>
      {#each saved as p (p.id)}
        <span class="chip"><button class="link" onclick={() => openPlan(p)}>{p.match || "plan"} · {p.ourAuto} + {p.partnerTeam || p.partnerRef}</button><button class="x" aria-label="delete plan" onclick={() => deletePlan(p)}>×</button></span>
      {/each}
    </div>
  {/if}

  <section class="matrix">
    <div class="pick">
      <details>
        <summary>Our autos ({rows.length})</summary>
        {#each [...ourAutos, ...drafts] as a}
          <label><input type="checkbox" checked={rows.includes(a.name)} onchange={(e) => (picked = e.currentTarget.checked ? [...rows, a.name] : rows.filter((r) => r !== a.name))} /> {a.opModes[0]?.name.replace(/^Blue_/, "") ?? a.name}{a.file ? "" : " (draft)"}</label>
        {/each}
      </details>
      <details>
        <summary>Partner autos from AutoTool ({extraCols.length})</summary>
        <p class="muted">The library's newest route of every team is always a column. Add drawn or imported autos here.</p>
        {#each app.server?.autos ?? [] as a}
          <label><input type="checkbox" checked={extraCols.includes(a.name)} onchange={(e) => (extraCols = e.currentTarget.checked ? [...extraCols, a.name] : extraCols.filter((r) => r !== a.name))} /> {a.name}</label>
        {/each}
      </details>
      {#if busy}<span class="muted">Running every pair…</span>{/if}
    </div>

    {#if !cols.length}
      <p class="muted">No partner routes yet. Add one in the Partner tab of any auto (a .pp file or a drawn route, saved under the team's number), or tick an AutoTool auto above.</p>
    {:else if !rows.length}
      <p class="muted">No autos on the robot yet. Tick a draft above to plan with it.</p>
    {:else}
      <div class="tablewrap">
        <table>
          <thead>
            <tr><th>Ours \ partner</th>{#each cols as c (c.ref)}<th title={c.notes}>{c.label}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each rows as row (row)}
              <tr>
                <th>{dsName(row).replace(/^(Blue|Red)_/, "")}</th>
                {#each cols as c (c.ref)}
                  {@const v = cells[`${row}|${c.ref}`]}
                  <td>
                    {#if !v}
                      <span class="muted">…</span>
                    {:else if "error" in v}
                      <span class="err" title={v.error}>cannot run</span>
                    {:else}
                      <button class="cell" class:on={sel?.row === row && sel?.col === c.ref} class:bad={v.collisions > 0} class:warn={!v.collisions && v.near > 0} onclick={() => choose(row, c)}>
                        <strong>{v.collisions ? `${v.collisions} collision${v.collisions > 1 ? "s" : ""}` : v.near ? `${v.near} close call${v.near > 1 ? "s" : ""}` : "clear"}</strong>
                        <span>{v.cmp.closest ? `closest ${v.cmp.closest.gapIn.toFixed(0)} in` : ""}</span>
                        <span>≈ {v.alliance.total} pts</span>
                      </button>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if chosen}
    {@const c = chosen}
    {@const ps = startOf(c.ts)}
    {@const pp = lastOf(c.ts)}
    <div class="controls">
      <label>Match <input bind:value={plan.match} placeholder="Q12" /></label>
      <span class="seg" role="radiogroup" aria-label="our alliance">
        <button role="radio" aria-checked={!red} class:on={!red} onclick={() => (plan.alliance = "BLUE")}>Blue</button>
        <button role="radio" aria-checked={red} class:on={red} onclick={() => (plan.alliance = "RED")}>Red</button>
      </span>
      <label>Partner waits <input type="number" min="0" max="10" step="0.25" bind:value={plan.delayS} /> s</label>
      <span class="grow"></span>
      <button onclick={savePlan}>Save plan</button>
      <button onclick={openInEditor}>Open in the editor</button>
      <button onclick={fullScreen}>Full screen</button>
      <button class="primary" onclick={() => window.print()}>Print</button>
    </div>

    <article class="sheet" bind:this={sheet} class:red>
      <header>
        <h1>{plan.match || "Match"} · {red ? "RED" : "BLUE"} alliance</h1>
        <p>19859 with {c.col.team || c.col.label}{c.col.team && c.col.label !== c.col.team ? ` (${c.col.label.replace(/^\d+\s*/, "")})` : ""}</p>
      </header>

      <div class="cols">
        <svg class="mini" viewBox="-2 -2 148 148" aria-label="Both routes on the field">
          <image href={fieldImage} x="0" y="0" width="144" height="144" opacity="0.85" />
          {#each c.tf.geometry as g}{#if g.drawable}<polyline points={pointsAttr(g.samples, red)} class="pr" />{/if}{/each}
          {#each c.of.geometry as g}{#if g.drawable}<polyline points={pointsAttr(g.samples, red)} class="ur" />{/if}{/each}
          {#if pose3(startOf(c.os))}<polygon points={fp(pose3(startOf(c.os))!, app.model!.body)} class="us" />{/if}
          {#if pose3(ps)}<polygon points={fp(pose3(ps)!, c.opts.body)} class="ps" />{/if}
          {#each c.cmp.conflicts.filter((k) => k.kind === "collision" || k.kind === "nearMiss" || k.kind === "park") as k}
            {@const m = sx(k.at.x, k.at.y, red)}
            <circle cx={m.x} cy={m.y} r="4" class="clash" class:near={k.kind !== "collision"} />
          {/each}
        </svg>

        <div class="facts">
          <section>
            <h2>Us: {dsName(sel!.row)}</h2>
            <dl>
              <dt>Start</dt><dd>{onSide(startOf(c.os))}</dd>
              <dt>Preload</dt><dd>{c.os.preload.POLLEN} POLLEN{c.os.preload.onTiles ? ` (${c.os.preload.onTiles} on the tiles)` : ""}</dd>
              <dt>Ends</dt><dd>{onSide(lastOf(c.os))}</dd>
              {#if teleop}<dt>TeleOp</dt><dd>{teleop} (preselected)</dd>{/if}
              <dt>Sim</dt><dd>{simOf[sel!.row] ? `${simOf[sel!.row]?.BLUE ? `Blue ${simOf[sel!.row]!.BLUE!.ok ? "✓" : "✗"}` : ""} ${simOf[sel!.row]?.RED ? `Red ${simOf[sel!.row]!.RED!.ok ? "✓" : "✗"}` : ""}` : "not checked since its last change"}</dd>
              <dt>Points</dt><dd>≈ {c.ours.total} (LEAVE {c.ours.leave}, PARK {c.ours.park}, HIVE TIP {c.ours.tipPoints})</dd>
            </dl>
          </section>
          <section>
            <h2>Partner: {c.col.label}</h2>
            <dl>
              <dt>Start</dt><dd>{onSide(ps)}</dd>
              <dt>Ends</dt><dd>{onSide(pp)}</dd>
              <dt>Robot</dt><dd>{(c.opts.body.front + c.opts.body.back).toFixed(0)} x {(c.opts.body.left + c.opts.body.right).toFixed(0)} in, {c.opts.maxVel} in/s</dd>
              {#if c.col.notes}<dt>Notes</dt><dd>{c.col.notes}</dd>{/if}
              <dt>Points</dt><dd>≈ {c.theirs.total} alone</dd>
            </dl>
          </section>
          <section>
            <h2>Agreed</h2>
            <ul>
              {#if plan.delayS > 0}<li>{c.col.team || "The partner"} waits {plan.delayS} s at the start.</li>{:else}<li>Both start at once.</li>{/if}
              {#each waits(c.os) as w}<li>We hold {w}.</li>{/each}
              {#if plan.notes}<li>{plan.notes}</li>{/if}
            </ul>
            <textarea class="noprint" bind:value={plan.notes} placeholder="Anything else agreed (who parks where, who takes which POLLEN)…" rows="2"></textarea>
          </section>
          <section class="verdict" class:bad={c.cmp.conflicts.some((k) => k.kind === "collision")}>
            <h2>Alliance AUTO ≈ {c.alliance.total} pts</h2>
            <p>LEAVE {c.alliance.leave} · PARK {c.alliance.park} · HIVE TIP {c.alliance.tipPoints}{c.alliance.tips.length ? ` (${c.alliance.tips.map((t) => `${t.robot === "us" ? "us" : "partner"} ${t.legId} at ${t.atS.toFixed(1)} s`).join(", ")})` : ""}</p>
            {#if c.cmp.conflicts.length}
              <ul>{#each c.cmp.conflicts as k}<li>{k.text}</li>{/each}</ul>
            {:else if c.cmp.closest}
              <p>Clear: the robots come no closer than {c.cmp.closest.gapIn.toFixed(1)} in (at {c.cmp.closest.t.toFixed(1)} s).</p>
            {/if}
          </section>
        </div>
      </div>
      <footer>Times are AutoTool's estimates. Planned {new Date().toLocaleString()}.</footer>
    </article>
  {/if}
</div>

<style>
  .plan {
    max-width: 1200px;
    margin: 0 auto;
    padding: 12px 16px 40px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .top {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .top h2 {
    margin: 0;
  }
  .grow {
    flex: 1;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .saved {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 4px 0 10px;
    font-size: 12px;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--text);
    font-size: 12px;
  }
  .x {
    background: none;
    border: 0;
    color: var(--muted);
  }
  .pick {
    display: flex;
    gap: 16px;
    align-items: start;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .pick details {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px 10px;
    max-width: 380px;
  }
  .pick label {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
  }
  .tablewrap {
    overflow-x: auto;
    margin-top: 8px;
  }
  table {
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    border: 1px solid var(--line);
    padding: 4px;
    text-align: left;
    vertical-align: top;
  }
  thead th {
    max-width: 180px;
    font-weight: 600;
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 140px;
    text-align: left;
    background: #0d1f14;
    border: 1px solid #14532d;
    font-size: 12px;
  }
  .cell.warn {
    background: #241a06;
    border-color: #92400e;
  }
  .cell.bad {
    background: #2a0f0f;
    border-color: #7f1d1d;
  }
  .cell.on {
    outline: 2px solid var(--sel);
  }
  .err {
    color: #fca5a5;
  }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .controls input:not([type]) {
    width: 80px;
  }
  .controls input[type="number"] {
    width: 60px;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
  }
  .seg button {
    border: 0;
    border-radius: 0;
    padding: 4px 12px;
    background: none;
  }
  .seg button.on {
    background: var(--sel);
    color: #000;
    font-weight: 700;
  }
  /* the sheet: dark on screen, black on white when printed */
  .sheet {
    background: #f8fafc;
    color: #0b1220;
    border-radius: 10px;
    padding: 18px 22px;
  }
  .sheet header h1 {
    margin: 0;
    font-size: 22px;
  }
  .sheet header p {
    margin: 2px 0 0;
    font-size: 15px;
  }
  .sheet.red header h1 {
    color: #b91c1c;
  }
  .sheet:not(.red) header h1 {
    color: #1d4ed8;
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(240px, 340px) 1fr;
    gap: 18px;
    margin-top: 12px;
  }
  .mini {
    width: 100%;
    background: #111;
    border-radius: 6px;
  }
  .mini .ur {
    fill: none;
    stroke: #38bdf8;
    stroke-width: 1.4;
  }
  .mini .pr {
    fill: none;
    stroke: #c084fc;
    stroke-width: 1.4;
    stroke-dasharray: 3 2;
  }
  .mini .us {
    fill: rgb(56 189 248 / 0.35);
    stroke: #38bdf8;
    stroke-width: 0.6;
  }
  .mini .ps {
    fill: rgb(192 132 252 / 0.35);
    stroke: #c084fc;
    stroke-width: 0.6;
  }
  .mini .clash {
    fill: rgb(239 68 68 / 0.35);
    stroke: #ef4444;
    stroke-width: 0.8;
  }
  .mini .clash.near {
    fill: rgb(245 158 11 / 0.3);
    stroke: #f59e0b;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 18px;
    font-size: 13px;
  }
  .facts h2 {
    font-size: 14px;
    margin: 0 0 4px;
  }
  .facts dl {
    display: grid;
    grid-template-columns: 70px 1fr;
    gap: 2px 8px;
    margin: 0;
  }
  .facts dt {
    color: #475569;
  }
  .facts dd {
    margin: 0;
  }
  .facts ul {
    margin: 0;
    padding-left: 18px;
  }
  .facts textarea {
    width: 100%;
    margin-top: 6px;
    font: inherit;
  }
  .verdict {
    grid-column: 1 / -1;
    border-top: 1px solid #cbd5e1;
    padding-top: 8px;
  }
  .verdict.bad h2 {
    color: #b91c1c;
  }
  .verdict p {
    margin: 2px 0;
  }
  .sheet footer {
    margin-top: 12px;
    font-size: 11px;
    color: #64748b;
  }
  .sheet:fullscreen {
    overflow: auto;
    border-radius: 0;
    padding: 28px 36px;
    font-size: 16px;
  }
  @media (max-width: 900px) {
    .cols,
    .facts {
      grid-template-columns: 1fr;
    }
  }
  @media print {
    :global(body *) {
      visibility: hidden;
    }
    .sheet,
    .sheet :global(*) {
      visibility: visible;
    }
    .sheet {
      position: absolute;
      inset: 0;
      padding: 0;
      background: #fff;
    }
    .noprint {
      display: none;
    }
  }
</style>
