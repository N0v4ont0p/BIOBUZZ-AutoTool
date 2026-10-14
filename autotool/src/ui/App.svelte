<script lang="ts">
  import { onMount } from "svelte";
  import { compareRuns, partnerModel } from "../shared/compare.ts";
  import { computeFeatures } from "../shared/features.ts";
  import { applyPatch } from "../shared/patch.ts";
  import { validateSpec, writable } from "../shared/spec.ts";
  import { sideOf } from "../shared/fieldmap.ts";
  import { autoTag } from "../shared/java/autorunner.ts";
  import { approve, blankAuto, rejectProposal, simCheck, undoWrite } from "./actions.ts";
  import { api, hasToken } from "./api.ts";
  import AIPanel from "./components/AIPanel.svelte";
  import AutoPicker from "./components/AutoPicker.svelte";
  import Manage from "./components/Manage.svelte";
  import MatchPlan from "./components/MatchPlan.svelte";
  import Field from "./components/Field.svelte";
  import JavaPanel from "./components/JavaPanel.svelte";
  import Legs from "./components/Legs.svelte";
  import Partner from "./components/Partner.svelte";
  import Legend from "./components/Legend.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import Settings from "./components/Settings.svelte";
  import TimeBar from "./components/TimeBar.svelte";
  import { app } from "./state.svelte.ts";

  let loadError = $state<string | null>(null);
  let onboarding = $state(false);
  let tab = $state<"legs" | "partner" | "java">("legs");

  const features = $derived(app.spec && app.pack && app.model ? computeFeatures(app.spec, app.pack, app.model) : null);
  const propFeatures = $derived(app.proposal && app.pack && app.model ? computeFeatures(app.proposal.spec, app.pack, app.model) : null);
  const shown = $derived(app.proposal && propFeatures ? { spec: app.proposal.spec, features: propFeatures } : app.spec && features ? { spec: app.spec, features } : null);
  const problems = $derived(shown ? [...validateSpec(shown.spec).filter((p) => p.level === "error" || p.code.startsWith("junction")), ...shown.features.problems] : []);
  // Near = starts in the half with the NECTAR CELL
  const side = $derived.by(() => {
    const s = shown?.spec;
    const y = s?.poses.find((p) => p.name === s.start)?.y;
    return app.pack && y != null ? sideOf(y, app.pack) : "Near/Far";
  });
  // the alliance partner's auto, run together with ours
  const pModel = $derived(app.partner && app.model ? partnerModel(app.model, app.partner.opts) : null);
  const pFeatures = $derived(app.partner && app.pack && pModel ? computeFeatures(app.partner.spec, app.pack, pModel) : null);
  const comparison = $derived(shown && pFeatures && pModel && app.model && app.partner ? compareRuns(shown.features, app.model, pFeatures, pModel, app.partner.opts) : null);
  const pStart = $derived.by(() => {
    const s = app.partner?.spec;
    const p = s?.poses.find((q) => q.name === s.start);
    return p && p.x !== null && p.y !== null && p.headingDeg !== null ? { x: p.x, y: p.y, headingDeg: p.headingDeg } : null;
  });
  const clashes = $derived(comparison?.conflicts.filter((c) => c.kind === "collision").length ?? 0);
  const canWrite = $derived(shown ? writable(validateSpec(shown.spec)) : false);

  // facts the robot code changed since the last scan (already in use); the team only acknowledges them
  const codeChanges = $derived((app.server?.profile?.changes ?? []).filter((c) => !c.needsYou));
  async function dismissChanges() {
    app.server = await api<typeof app.server & object>("POST", "/api/profile/changes/dismiss", {});
  }

  async function boot() {
    if (!hasToken()) {
      loadError = "Open AutoTool with autotool.sh from the robot repo: it starts the local server and opens this page with a session key.";
      return;
    }
    try {
      await app.refresh();
      await app.loadPack();
      const ob = app.server!.onboarding;
      onboarding = !(ob.repo && ob.scanned && ob.style && ob.profileConfirmed && ob.sanityConfirmed);
      if (!onboarding) await openFirst();
    } catch (e) {
      loadError = (e as Error).message;
    }
  }
  async function openFirst() {
    const names = app.server?.autos.map((a) => a.name) ?? [];
    const name = names.includes(app.autoName) ? app.autoName : names.includes("AutoPaths") ? "AutoPaths" : names[0];
    if (name) await app.openAuto(name);
  }
  onMount(boot);

  function deleteSelected() {
    if (!app.selected || !app.spec) return;
    const r = applyPatch(app.snapshot(), { summary: "", junctions: [], ops: [{ op: "delete_leg", leg: app.selected }], claims: [] }, "user");
    if (r.errors.length) return app.flash(r.errors.join("; "), "warn");
    app.change(r.spec);
    app.selected = null;
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (app.ask) {
      if (e.key === "Escape") app.ask.resolve(false);
      else if (e.key === "Enter") app.ask.resolve(true);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (app.viewer) app.viewer = null;
      else if (app.showManage) app.showManage = false;
      else if (app.showPlan) app.showPlan = false;
      else if (app.showSettings) app.showSettings = false;
      else if (app.proposal) rejectProposal();
      else if (app.mode === "add") app.mode = "select";
      else {
        app.selected = null;
        app.selectedPose = null;
      }
      if (typing) t.blur();
      return;
    }
    if (typing || onboarding || app.redoSetup || app.showSettings || app.showManage || app.showPlan) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!app.undo()) app.flash("Nothing to undo.", "warn");
      return;
    }
    if (mod) return;
    if (e.key === "Enter") {
      e.preventDefault();
      approve();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "a" || e.key === "A") app.mode = app.mode === "add" ? "select" : "add";
    else if (e.key === "z" || e.key === "Z") app.setView("showZones", !app.showZones);
    else if (e.key === "e" || e.key === "E") app.setView("showElements", !app.showElements);
    else if (e.key === "r" || e.key === "R") app.redView = !app.redView;
    else if (e.key === "i" || e.key === "I") app.setAiOpen(!app.aiOpen);
  }
</script>

<svelte:window onkeydown={onKey} onhashchange={() => loadError && ((loadError = null), boot())} />

{#if loadError}
  <div class="fatal"><h1>AutoTool</h1><p>{loadError}</p></div>
{:else if !app.server}
  <div class="fatal"><p>Starting…</p></div>
{:else if onboarding || app.redoSetup}
  <Onboarding startAt={app.redoSetup ? 2 : undefined} onDone={async () => ((onboarding = false), (app.redoSetup = false), await app.refresh(), await openFirst())} />
{:else if app.showSettings}
  <Settings />
{:else if app.showManage}
  <Manage />
{:else if app.showPlan}
  <MatchPlan />
{:else}
  <div class="shell">
    <header class="top">
      <AutoPicker />
      <button onclick={blankAuto} title="Start a new auto from scratch (start, a shot, park)">+ New</button>
      <button class="pbtn" class:on={tab === "partner"} onclick={() => (tab = tab === "partner" ? "legs" : "partner")} title={app.partner ? `Running with ${app.partner.label}${clashes ? `: ${clashes} collision${clashes > 1 ? "s" : ""}` : ""}` : "Run your alliance partner's auto together with this one and look for collisions"}>{app.partner ? `${clashes ? `⚠ ${clashes} · ` : ""}With ${app.partner.label}` : "Run with partner…"}</button>
      <button onclick={() => (app.showPlan = true)} title="Match day: which of our autos to run with which partner, and a one-page sheet for the drive team">Match plan</button>
      <button class="manage" onclick={() => (app.showManage = true)} title="Manage autos, the robot repo and the files AutoTool wrote">Manage</button>
      <span class="sep"></span>
      <button class:on={app.mode === "add"} onclick={() => (app.mode = app.mode === "add" ? "select" : "add")} title="Click the field to add legs (A)">+ Leg</button>
      <button onclick={() => app.undo() || app.flash("Nothing to undo.", "warn")} title="Undo (Ctrl/Cmd+Z)">Undo</button>
      <label class="tog" title="Shooting zone and no-go areas (Z)"><input type="checkbox" checked={app.showZones} onchange={(e) => app.setView("showZones", e.currentTarget.checked)} /> Zones</label>
      <label class="tog" title="Staged POLLEN and NECTAR (E)"><input type="checkbox" checked={app.showElements} onchange={(e) => app.setView("showElements", e.currentTarget.checked)} /> Elements</label>
      <label class="tog" title="Show the route as the red robot runs it (R)"><input type="checkbox" bind:checked={app.redView} /> Red</label>
      <span class="grow"></span>
      <button class="primary" disabled={!canWrite || !!app.busy || app.autoName === "AutoPaths"} onclick={() => approve()} title={app.autoName === "AutoPaths" ? "The sample auto is the reference: AutoTool never writes it. Copy this auto (auto menu) to make your own." : canWrite ? `Compile check, then write ${[side, autoTag(app.autoName)].filter(Boolean).join("_")}.java: ${["Blue", side, autoTag(app.autoName)].filter(Boolean).join("_")} and ${["Red", side, autoTag(app.autoName)].filter(Boolean).join("_")} on the Driver Station (Enter)` : "Fix the errors (and legs marked for review) first"}>{app.proposal ? "Approve + write" : "Write"}</button>
      <button disabled={!canWrite || !!app.busy || app.autoName === "AutoPaths"} onclick={() => simCheck(app.redView ? "RED" : "BLUE")} title={`Run this auto in the robot repo's simulator as ${app.redView ? "Red" : "Blue"} (the repo is not changed)`}>Sim</button>
      {#if app.lastWrite}<button onclick={undoWrite} title="Restore the file as it was before this write">Undo write</button>{/if}
      <button onclick={() => (app.showSettings = true)}>Settings</button>
    </header>
    {#if app.busy}<div class="busy"><span></span>{app.busy}…</div>{/if}
    {#if codeChanges.length}
      <div class="changes" role="status">
        <span>The robot code changed, and AutoTool now uses: {codeChanges.map((c) => `${c.label} ${c.from} → ${c.to}`).join(" · ")}</span>
        <button onclick={dismissChanges}>OK</button>
      </div>
    {/if}

    <main class="main" class:aiclosed={!app.aiOpen}>
      <section class="fieldcol">
        <div class="fieldwrap">
          {#if shown && app.pack && app.model}
            <Field spec={shown.spec} features={shown.features} before={app.proposal && features && app.spec ? { spec: app.spec, features } : null} pack={app.pack} model={app.model} editable={!app.proposal && !app.busy} partner={pFeatures && pModel && comparison && app.partner ? { features: pFeatures, body: pModel.body, delayS: app.partner.opts.delayS, conflicts: comparison.conflicts, start: pStart } : null} />
          {/if}
          {#if app.proposal}<div class="overlaynote">Proposal shown · dashed = before · Enter approves, Esc rejects</div>{/if}
          {#if app.mode === "add"}<div class="overlaynote add">Click the field to add a leg after {app.selected ?? "the last stop"} · Esc to stop</div>{/if}
        </div>
        <Legend />
        {#if shown}<TimeBar features={shown.features} spec={shown.spec} partner={pFeatures && comparison && app.partner ? { name: app.partner.label, features: pFeatures, delayS: app.partner.opts.delayS, conflicts: comparison.conflicts } : null} />{/if}
      </section>

      <aside class="side">
        {#if problems.length}
          <details class="problems" open={problems.some((p) => p.level === "error")}>
            <summary>{problems.filter((p) => p.level === "error").length} errors · {problems.filter((p) => p.level === "warning").length} warnings</summary>
            <ul>{#each problems as p}<li class={p.level}><button class="plink" onclick={() => p.where.startsWith("leg:") && (app.selected = p.where.slice(4))}>{p.where.replace(/^leg:|^pose:/, "")}</button> {p.message}</li>{/each}</ul>
          </details>
        {/if}
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "legs"} class:on={tab === "legs"} onclick={() => (tab = "legs")}>Legs</button>
          <button role="tab" aria-selected={tab === "partner"} class:on={tab === "partner"} onclick={() => (tab = "partner")}>Partner{clashes ? ` (${clashes})` : ""}</button>
          <button role="tab" aria-selected={tab === "java"} class:on={tab === "java"} onclick={() => (tab = "java")}>Java</button>
        </div>
        <div class="tabbody">
          {#if tab === "legs" && shown && app.model && app.spec}
            <Legs spec={app.spec} features={features ?? shown.features} model={app.model} proposed={app.proposal?.spec ?? null} />
          {:else if tab === "partner" && app.model}
            <Partner {comparison} partnerFeatures={pFeatures} ourFeatures={shown?.features ?? null} model={app.model} />
          {:else if tab === "java"}
            <JavaPanel />
          {/if}
        </div>
      </aside>
      <AIPanel />
    </main>
  </div>
{/if}

{#if app.ask}
  <div class="scrim" role="presentation">
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="askTitle">
      <h2 id="askTitle">{app.ask.title}</h2>
      <p>{app.ask.text}</p>
      <div class="dlgrow">
        <button onclick={() => app.ask?.resolve(false)}>Cancel (Esc)</button>
        <button class="primary" onclick={() => app.ask?.resolve(true)}>{app.ask.yes} (Enter)</button>
      </div>
    </div>
  </div>
{/if}

{#if app.viewer}
  <div class="scrim" role="presentation" onclick={(e) => e.target === e.currentTarget && (app.viewer = null)}>
    <div class="viewer" role="dialog" aria-modal="true" aria-labelledby="viewTitle">
      <div class="vh"><h2 id="viewTitle">{app.viewer.path.split("/").pop()}</h2><span class="vpath">{app.viewer.path}</span><button onclick={() => (app.viewer = null)}>Close (Esc)</button></div>
      {#if app.viewer.note}<p class="vnote">{app.viewer.note}</p>{/if}
      <pre>{app.viewer.text}</pre>
    </div>
  </div>
{/if}

{#if app.toast}
  <div class="toast {app.toast.kind}" role="status">
    <div>{app.toast.text}</div>
    {#if app.toast.detail}<div class="detail">{app.toast.detail}</div>{/if}
    <button class="x" onclick={() => (app.toast = null)} aria-label="dismiss">×</button>
  </div>
{/if}

<style>
  .fatal {
    max-width: 640px;
    margin: 80px auto;
    padding: 0 20px;
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .pbtn {
    max-width: 230px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
    width: 1px;
    height: 22px;
    background: var(--line);
    margin: 0 4px;
  }
  .grow {
    flex: 1;
  }
  .tog {
    font-size: 12px;
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }
  button.on {
    background: var(--sel);
    color: #000;
  }
  .changes {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 4px 10px;
    font-size: 12px;
    background: #0f1d2a;
    border-bottom: 1px solid #2f5f86;
    color: #cfe6fb;
  }
  .changes span {
    flex: 1;
  }
  .busy {
    font-size: 12px;
    padding: 2px 10px;
    background: #0f1a24;
    color: var(--sel);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .busy span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sel);
  }
  .main {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 400px auto;
    min-height: 0;
  }
  .fieldcol {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .fieldwrap {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #000;
  }
  .overlaynote {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: #0f1a24;
    border: 1px solid var(--sel);
    color: var(--sel);
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 999px;
    pointer-events: none;
  }
  .overlaynote.add {
    top: auto;
    bottom: 8px;
  }
  .side {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }
  .problems {
    font-size: 12px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--line);
    max-height: 160px;
    overflow-y: auto;
  }
  .problems summary {
    cursor: pointer;
    color: var(--unsure);
  }
  .problems ul {
    margin: 4px 0;
    padding-left: 16px;
  }
  .problems li.error {
    color: #fca5a5;
  }
  .problems li.warning {
    color: #fcd34d;
  }
  .plink {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    font-family: var(--mono);
    text-decoration: underline;
    cursor: pointer;
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    flex: 1;
    border-radius: 0;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
  }
  .tabs button.on {
    border-bottom-color: var(--sel);
    color: #fff;
    background: none;
  }
  .tabbody {
    flex: 1 1 50%;
    overflow-y: auto;
    min-height: 120px;
  }
  .viewer {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    width: min(900px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
  }
  .vh {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  .vh h2 {
    font-size: 15px;
    margin: 0;
  }
  .vpath {
    flex: 1;
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vnote {
    margin: 8px 14px 0;
    font-size: 13px;
    color: var(--unsure);
  }
  .viewer pre {
    margin: 0;
    padding: 12px 14px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.6);
    display: grid;
    place-items: center;
    z-index: 20;
  }
  .dialog {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    max-width: 480px;
    font-size: 14px;
  }
  .dialog h2 {
    font-size: 16px;
    margin: 0 0 6px;
  }
  .dlgrow {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .toast {
    position: fixed;
    bottom: 16px;
    left: 16px;
    max-width: 560px;
    padding: 8px 32px 8px 12px;
    border-radius: 8px;
    font-size: 13px;
    background: #052e16;
    border: 1px solid var(--intake);
    z-index: 10;
  }
  .toast.warn {
    background: #2a1d05;
    border-color: var(--unsure);
  }
  .toast.error {
    background: #3f0d0d;
    border-color: var(--shoot);
  }
  .toast .detail {
    font-family: var(--mono);
    font-size: 12px;
    margin-top: 4px;
  }
  .x {
    position: absolute;
    top: 4px;
    right: 6px;
    background: none;
    border: 0;
    font-size: 16px;
  }
  @media (max-width: 1100px) {
    .main {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(420px, 60vh) auto auto;
      overflow-y: auto;
    }
  }
</style>
