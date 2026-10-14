<script lang="ts">
  import { api, download } from "../api.ts";
  import { type CompileInfo, type ServerState, app } from "../state.svelte.ts";
  import ClaudeAccount from "./ClaudeAccount.svelte";
  import FactTable from "./FactTable.svelte";
  import StyleSetup from "./StyleSetup.svelte";

  let key = $state("");
  let workspaceId = $state(app.server?.key.workspace ?? "");
  let msg = $state<string | null>(null);
  let repoPath = $state(app.server?.repo?.root ?? "");
  let balance = $state(String(app.server?.profile?.startingBalanceUsd ?? ""));
  let gradle = $state<CompileInfo | null>(null);
  let gradleBusy = $state(false);
  let file: HTMLInputElement | undefined = $state();

  async function act(fn: () => Promise<unknown>, ok: string) {
    msg = null;
    try {
      await fn();
      msg = ok;
      await app.refresh();
    } catch (e) {
      msg = (e as Error).message;
    }
  }
  const saveKey = () => act(() => api("POST", "/api/key", { key, workspaceId }).then(() => (key = "")), "Key saved and checked.");
  const removeKey = () => act(() => api("DELETE", "/api/key"), "Key removed: AI is off.");
  const setRepo = () => act(() => api<ServerState>("POST", "/api/repo", { path: repoPath }), "Repo set. Scan it again.");
  const rescan = () => act(() => api("POST", "/api/ingest", {}), "Scanned. Values read from the code are up to date; only values the code does not have need you.");
  const setSimAfterWrite = (on: boolean) => act(() => api("POST", "/api/settings/sim", { afterWrite: on }), on ? "Write now checks Blue and Red in the simulator." : "Write only compiles now.");
  const setBalance = () => act(() => api("POST", "/api/profile/balance", { usd: balance === "" ? null : Number(balance) }), "Balance saved.");
  async function exportProfile() {
    const p = await api<unknown>("GET", "/api/profile/export");
    download(`autotool-profile-${app.server?.profile?.team ?? "team"}.json`, p);
  }
  async function importProfile(f: File) {
    const doc = JSON.parse(await f.text());
    await act(() => api("POST", "/api/profile/import", doc), "Profile imported and checked against this repo.");
  }
  async function resetAll() {
    if (!(await app.confirm("Reset everything?", "AutoTool forgets everything it keeps on this computer: the API key, the Claude account token, the team profile, every saved auto and its history, the chat, the spend log and the caches. Setup starts again from step 1. The robot repo and the Java files already written are not touched. This cannot be undone.", "Reset everything"))) return;
    try {
      await api("POST", "/api/reset", { confirm: "RESET" });
      for (const k of Object.keys(localStorage)) if (k.startsWith("autotool.")) localStorage.removeItem(k);
    } catch (e) {
      app.flash((e as Error).message, "error");
      return;
    }
    location.reload();
  }
  async function runGradle() {
    gradleBusy = true;
    try {
      gradle = await api<CompileInfo>("POST", "/api/compile/gradle", {});
    } catch (e) {
      msg = (e as Error).message;
    } finally {
      gradleBusy = false;
    }
  }
</script>

<div class="settings">
  <div class="top"><h2>Settings</h2><button onclick={() => (app.showSettings = false)}>Close (Esc)</button></div>
  {#if msg}<p class="msg">{msg}</p>{/if}

  <section>
    <h3>AI</h3>
    <ClaudeAccount />
    <h3>API key</h3>
    <p>{app.server?.key.set ? `Saved key ends in …${app.server.key.last4}${app.server.key.workspace ? `, workspace ${app.server.key.workspace}` : ""}.` : "No key: AI is off."} It lives only in this computer's config folder.</p>
    <input type="password" autocomplete="off" placeholder="sk-ant-…" bind:value={key} aria-label="new API key" />
    <input placeholder="workspace ID (organization-wide keys only)" bind:value={workspaceId} aria-label="workspace ID" />
    <button disabled={!key} onclick={saveKey}>Save and check</button>
    {#if app.server?.key.set}<button onclick={removeKey}>Remove key</button>{/if}
  </section>

  <section>
    <h3>Spend</h3>
    <p>This session ${app.server?.spend.session.toFixed(3)} of the ${app.server?.spend.cap.toFixed(0)} cap · {app.server?.spend.requests} requests{app.server?.spend.cacheHitRate !== null && app.server?.spend.cacheHitRate !== undefined ? ` · cache hits ${(app.server.spend.cacheHitRate * 100).toFixed(0)}%` : ""} · all time ${app.server?.spend.allTime.toFixed(3)}{app.server?.spend.remainingEstimate !== null && app.server?.spend.remainingEstimate !== undefined ? ` · about $${app.server.spend.remainingEstimate.toFixed(2)} left` : ""}</p>
    <label>Starting balance $<input type="number" min="0" bind:value={balance} /></label> <button onclick={setBalance}>Save</button>
  </section>

  <section>
    <h3>Robot repo</h3>
    <input class="wide" bind:value={repoPath} aria-label="robot repo path" />
    <button onclick={setRepo}>Use</button>
    <button onclick={rescan}>Scan again</button>
    <button onclick={runGradle} disabled={gradleBusy}>{gradleBusy ? "Gradle running…" : "Full Gradle compile"}</button>
    {#if gradle}
      <p class:ok={gradle.ok} class:err={!gradle.ok}>{!gradle.available ? `Gradle unavailable: ${gradle.why}` : gradle.ok ? `Gradle compile OK (${(gradle.ms / 1000).toFixed(0)} s).` : `Gradle compile failed: ${gradle.errors.map((e) => `${e.file}:${e.line} ${e.message}`).join("; ") || "see the output"}`}</p>
    {/if}
  </section>

  <section>
    <h3>Simulator</h3>
    {#if app.server?.simulator.available}
      <label class="check"><input type="checkbox" checked={app.server.simulator.afterWrite} onchange={(e) => setSimAfterWrite(e.currentTarget.checked)} /> After every Write, run Blue and Red in the robot repo's simulator (about a minute; an unchanged file is not run again)</label>
    {:else}
      <p class="muted">This robot repo has no simulator (sim/), so Write only compiles.</p>
    {/if}
  </section>

  <section>
    <h3>Team profile</h3>
    <p>
      <button onclick={exportProfile}>Export profile</button>
      <button onclick={() => file?.click()}>Import profile</button>
      <input type="file" accept="application/json" bind:this={file} hidden onchange={(e) => e.currentTarget.files?.[0] && importProfile(e.currentTarget.files[0])} />
      <span class="muted">For a second laptop on match day. The key is never exported.</span>
    </p>
    <FactTable />
  </section>
  <section>
    <h3>Reference auto (house style)</h3>
    <StyleSetup />
  </section>
  <section>
    <h3>Setup</h3>
    <p class="muted">Go through the setup again: robot repo, scan, reference auto (pick or re-analyze), team profile and the auto check. The AI connection stays as it is.</p>
    <button onclick={() => ((app.showSettings = false), (app.redoSetup = true))}>Redo setup</button>
  </section>
  <section class="danger">
    <h3>Reset</h3>
    <p class="muted">Forget everything AutoTool keeps on this computer and run setup again. The robot repo is not touched.</p>
    <button class="reset" onclick={resetAll}>Reset everything</button>
  </section>
</div>

<style>
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 13px;
  }
  .danger {
    border-top: 1px solid var(--line);
    margin-top: 16px;
  }
  .reset {
    border-color: #f87171;
    color: #fca5a5;
  }
  .settings {
    padding: 12px 16px 40px;
    max-width: 980px;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  section {
    border-top: 1px solid var(--line);
    padding: 8px 0;
  }
  h3 {
    font-size: 14px;
    margin: 4px 0;
  }
  p {
    font-size: 13px;
  }
  .wide {
    width: min(520px, 100%);
  }
  .msg {
    color: var(--sel);
  }
  .ok {
    color: var(--intake);
  }
  .err {
    color: #fca5a5;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
</style>
