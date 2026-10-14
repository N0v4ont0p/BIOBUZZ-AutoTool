<script lang="ts">
  import { computeFeatures } from "../../shared/features.ts";
  import { type AutoSpec, stopText } from "../../shared/spec.ts";
  import { ApiError, api } from "../api.ts";
  import { type ServerState, app } from "../state.svelte.ts";
  import ClaudeAccount from "./ClaudeAccount.svelte";
  import StyleSetup from "./StyleSetup.svelte";
  import FactTable from "./FactTable.svelte";
  import Field from "./Field.svelte";

  let { onDone, startAt }: { onDone: () => void; startAt?: number } = $props();

  const ob = $derived(app.server!.onboarding);
  // svelte-ignore state_referenced_locally
  let step = $state(startAt ?? (!app.server!.onboarding.key ? 1 : !app.server!.onboarding.repo ? 2 : !app.server!.onboarding.scanned ? 3 : !app.server!.onboarding.style ? 4 : !app.server!.onboarding.profileConfirmed ? 5 : 6));
  let key = $state("");
  let workspaceId = $state(app.server!.key.workspace ?? "");
  let keyMsg = $state<string | null>(null);
  let keyOffline = $state(false);
  let balance = $state<string>("100");
  let repoPath = $state(app.server!.repo?.root ?? "");
  let repoMsg = $state<string | null>(app.server!.repoError);
  let scanning = $state(false);
  interface ScanResult {
    steps: string[];
    changedFacts: string[];
    autos: { file: string; ok: boolean; errors?: { line: number; message: string }[]; warnings: { line: number; message: string }[] }[];
  }
  let scan = $state<ScanResult | null>(null);
  let sanitySpec = $state<AutoSpec | null>(null);
  let busy = $state(false);

  async function saveKey(skipCheck = false) {
    busy = true;
    keyMsg = null;
    keyOffline = false;
    try {
      const r = await api<{ message: string }>("POST", "/api/key", { key, workspaceId, skipCheck });
      keyMsg = r.message;
      key = "";
      await app.refresh();
      step = 2;
    } catch (e) {
      keyMsg = (e as Error).message;
      keyOffline = e instanceof ApiError && e.status === 503;
    } finally {
      busy = false;
    }
  }
  async function useRepo() {
    busy = true;
    repoMsg = null;
    try {
      app.server = await api<ServerState>("POST", "/api/repo", { path: repoPath.trim() });
      step = 3;
    } catch (e) {
      repoMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function runScan() {
    scanning = true;
    scan = null;
    try {
      const r = await api<ScanResult & { state: ServerState }>("POST", "/api/ingest", {});
      scan = r;
      app.server = r.state;
      const b = Number(balance);
      if (Number.isFinite(b) && b >= 0) app.server = await api<ServerState>("POST", "/api/profile/balance", { usd: b });
    } catch (e) {
      repoMsg = (e as Error).message;
    } finally {
      scanning = false;
    }
  }
  async function loadSanity() {
    try {
      sanitySpec = await api<AutoSpec>("POST", "/api/autos/get", { name: "AutoPaths" });
    } catch {
      sanitySpec = null;
    }
  }
  async function sanity(ok: boolean) {
    app.server = await api<ServerState>("POST", "/api/profile/sanity", { confirmed: ok });
    onDone();
  }
  $effect(() => {
    if (step === 6 && !sanitySpec) loadSanity();
  });
  const sanityFeatures = $derived(sanitySpec && app.pack && app.model ? computeFeatures(sanitySpec, app.pack, app.model) : null);
</script>

<div class="ob">
  <header>
    <div class="toprow">
      <h1>AutoTool setup</h1>
      {#if app.redoSetup}<button onclick={() => (app.redoSetup = false)}>Leave setup</button>{/if}
    </div>
    <ol class="steps">
      {#each ["Connect the AI", "Robot repo", "Scan the code", "Reference auto", "Team profile", "Check your auto"] as s, i}
        <li class:on={step === i + 1} class:done={[ob.key, ob.repo, ob.scanned, ob.style, ob.profileConfirmed, ob.sanityConfirmed][i]}><button onclick={() => (step = i + 1)}>{i + 1}. {s}</button></li>
      {/each}
    </ol>
  </header>

  <main>
    {#if step === 1}
      <h2>1. Connect the AI</h2>
      <ClaudeAccount />
      <h3>Or an Anthropic API key</h3>
      <p>The key stays on this computer, in a file only your user can read ({navigator.platform.startsWith("Mac") ? "~/Library/Application Support/biobuzz-autotool" : "the OS config folder"}). The browser never sees it; AutoTool shows only its last 4 characters.</p>
      {#if app.server!.key.set}<p class="ok">A key ending in …{app.server!.key.last4} is saved.</p>{/if}
      <form onsubmit={(e) => (e.preventDefault(), saveKey())}>
        <input type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" bind:value={key} aria-label="API key" class="wide" />
        <button class="primary" disabled={busy || !key}>Save and check</button>
        <div class="ws">
          <input placeholder="Workspace ID (only for organization-wide keys): wrkspc_…" bind:value={workspaceId} aria-label="workspace ID" class="wide" />
        </div>
      </form>
      <p class="muted">A key made inside one workspace needs no workspace ID. An organization-wide (admin) key does: it also manages the organization, so a normal workspace key is the safer choice.</p>
      <p class="muted">The check is a model lookup: it costs nothing.</p>
      {#if keyMsg}<p class:err={!keyMsg.startsWith("Key works") && !keyMsg.startsWith("Saved")}>{keyMsg}</p>{/if}
      {#if keyOffline || (keyMsg && !keyMsg.startsWith("Key works") && !keyMsg.startsWith("Saved") && key)}<button onclick={() => saveKey(true)} disabled={busy || !key}>Save anyway (AI stays unchecked)</button>{/if}
      <label class="bal">Starting API credit, for the spend estimate: $<input type="number" min="0" step="1" bind:value={balance} /> <span class="muted">(the real balance is in the Anthropic console)</span></label>
      <div class="nav"><button onclick={() => (step = 2)}>{app.server!.ai.enabled ? "Next" : "Skip: AI off for now"}</button></div>
    {:else if step === 2}
      <h2>2. Robot repo</h2>
      <p>The folder with TeamCode and AutoRunner.java. AutoTool reads the whole repo and writes only in the autos folder: one <code>&lt;Name&gt;.java</code> per auto, holding its Blue and Red OpModes (plus a one-time, confirmed hook in <code>AutoRunner.java</code>).</p>
      <input class="wide" bind:value={repoPath} aria-label="robot repo path" />
      <button class="primary" onclick={useRepo} disabled={busy || !repoPath.trim()}>Use this repo</button>
      {#if repoMsg}<p class="err">{repoMsg}</p>{/if}
      {#if app.server!.repo}<p class="ok">Using {app.server!.repo.root} (autos in {app.server!.repo.autosDir}).</p>{/if}
      <div class="nav"><button onclick={() => (step = 1)}>Back</button><button disabled={!ob.repo} onclick={() => (step = 3)}>Next</button></div>
    {:else if step === 3}
      <h2>3. Scan the robot code</h2>
      <p>Reads the autos, the AutoRunner rules, the tuned constants and the docs; loads the BIOBUZZ season pack ({app.server!.pack.manual}, {app.server!.pack.lastModified}).</p>
      <button class="primary" onclick={runScan} disabled={scanning}>{scanning ? "Scanning…" : ob.scanned ? "Scan again" : "Scan"}</button>
      {#if scanning}<div class="progress"><div></div></div>{/if}
      {#if scan}
        <ul class="steps-done">{#each scan.steps as s}<li>✓ {s}</li>{/each}</ul>
        {#each scan.autos as a}
          <p class:ok={a.ok} class:err={!a.ok}>{a.ok ? `Imported ${a.file}: round trip OK (Java → spec → the same Java).` : `${a.file} could not be imported:`}</p>
          {#each a.errors ?? [] as e}<p class="err">line {e.line}: {e.message}</p>{/each}
          {#each a.warnings as w}<p class="muted">{w.message}</p>{/each}
        {/each}
        {#if scan.changedFacts.length}<p class="warn">The repo changed: re-confirm {scan.changedFacts.join(", ")}.</p>{/if}
      {/if}
      <div class="nav"><button onclick={() => (step = 2)}>Back</button><button disabled={!ob.scanned} onclick={() => (step = 4)}>Next</button></div>
    {:else if step === 4}
      <h2>4. Reference auto</h2>
      <StyleSetup onConfirmed={() => (step = 5)} />
      <div class="nav"><button onclick={() => (step = 3)}>Back</button><button disabled={!ob.style} onclick={() => (step = 5)}>Next</button></div>
    {:else if step === 5}
      <h2>5. Team profile</h2>
      <p>Every fact AutoTool uses, with where it came from. <span class="assumed">assumed</span> means the robot code does not have it yet (NaN in Tuned): edit it if you know better, then confirm.</p>
      <FactTable />
      <div class="nav"><button onclick={() => (step = 4)}>Back</button><button class="primary" disabled={!ob.profileConfirmed} onclick={() => (step = 6)}>Next</button></div>
    {:else}
      <h2>6. Is this your auto?</h2>
      {#if sanitySpec && sanityFeatures && app.pack && app.model}
        <p>This is <code>{(sanitySpec.source?.file ?? "AutoPaths.java").split("/").pop()}</code> redrawn from the profile: {sanitySpec.legs.length} leg{sanitySpec.legs.length === 1 ? "" : "s"}: {sanitySpec.legs.map((l) => `${l.id} ${stopText(l)}`).join(", ")}.</p>
        {#if sanitySpec.reader?.guessed?.length}<p class="warn">Read from the hand-written {sanitySpec.reader.file.split("/").pop()}. Its start and park are Tuned values the robot code does not have yet, so AutoTool drew them at assumed spots ({sanitySpec.reader.guessed.map((k) => `${k.replace(/^Tuned\./, "")} = ${sanitySpec!.assume?.[k]}`).join(", ")}); the poses in between follow from them. Drag them in the editor; the robot code is not changed.</p>{/if}
        {#if !sanityFeatures.drawable}<p class="warn">Some poses are Tuned values that are not set yet (NaN), so the route cannot be drawn: {sanitySpec.poses.filter((p) => p.x === null).map((p) => `${p.name} = ${p.expr?.x ?? "?"}`).join(", ")}. That is expected for the placeholder auto.</p>{/if}
        <div class="mini"><Field spec={sanitySpec} features={sanityFeatures} pack={app.pack} model={app.model} editable={false} /></div>
      {:else}
        <p class="muted">No auto was imported.</p>
      {/if}
      <div class="nav">
        <button onclick={() => (step = 5)}>Back</button>
        <button onclick={() => sanity(false)}>Not quite — continue, flagged</button>
        <button class="primary" onclick={() => sanity(true)}>That is my auto</button>
      </div>
    {/if}
  </main>
</div>

<style>
  .ob {
    max-width: 980px;
    margin: 0 auto;
    padding: 16px 20px 40px;
  }
  .toprow {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 8px;
  }
  h2 {
    font-size: 17px;
  }
  .steps {
    display: flex;
    gap: 6px;
    list-style: none;
    padding: 0;
    flex-wrap: wrap;
  }
  .steps li button {
    border-radius: 999px;
    font-size: 12px;
  }
  .steps li.done button {
    border-color: var(--intake);
  }
  .steps li.on button {
    background: var(--sel);
    color: #000;
  }
  .wide {
    width: min(560px, 100%);
  }
  .nav {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  .ok {
    color: var(--intake);
  }
  .err {
    color: #fca5a5;
  }
  .warn {
    color: var(--unsure);
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .assumed {
    background: var(--unsure);
    color: #000;
    padding: 0 4px;
    border-radius: 3px;
  }
  .ws {
    margin-top: 6px;
  }
  .bal {
    display: block;
    margin-top: 12px;
  }
  .bal input {
    width: 80px;
  }
  .progress {
    height: 4px;
    background: var(--line);
    margin: 8px 0;
    overflow: hidden;
  }
  .progress div {
    height: 100%;
    width: 40%;
    background: var(--sel);
    animation: slide 0.9s linear infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }
  .steps-done {
    list-style: none;
    padding: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .mini {
    width: min(520px, 100%);
    aspect-ratio: 1;
  }
</style>
