<script lang="ts">
  import { api } from "../api.ts";
  import { type ServerState, app } from "../state.svelte.ts";

  let token = $state("");
  let busy = $state(false);
  let msg = $state<{ text: string; ok: boolean } | null>(null);
  const ai = $derived(app.server?.ai);

  async function connect() {
    busy = true;
    msg = null;
    try {
      const r = await api<{ message: string }>("POST", "/api/claude-token", { token });
      msg = { text: r.message, ok: true };
      token = "";
      await app.refresh();
    } catch (e) {
      msg = { text: (e as Error).message, ok: false };
    } finally {
      busy = false;
    }
  }
  async function disconnect() {
    await api("DELETE", "/api/claude-token");
    await app.refresh();
  }
  async function useModel(model: string) {
    app.server = await api<ServerState>("POST", "/api/claude-model", { model });
  }
  async function useMode(mode: "claude" | "api") {
    app.server = await api<ServerState>("POST", "/api/ai-mode", { mode });
  }
</script>

<div class="acct">
  <h3>Use my Claude account (no API key)</h3>
  <p>The AI runs through Claude Code on this laptop with your Claude plan: no API credit needed; it counts toward your plan's usage.</p>
  {#if ai?.claude}
    <p class="ok">Connected.{ai.mode === "claude" ? " AutoTool uses your Claude account." : ""}</p>
    <label class="model">
      Model:
      <select value={ai.claudeModel} onchange={(e) => useModel(e.currentTarget.value)}>
        {#each ai.claudeModels as m}<option value={m}>{m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2")}{m.includes("opus") ? " (smartest, slower)" : m.includes("haiku") ? " (fastest)" : ""}</option>{/each}
      </select>
      <span class="muted">Runs on your plan's usage, not API credit.</span>
    </label>
    <div class="row">
      {#if ai.mode !== "claude"}<button onclick={() => useMode("claude")}>Use the Claude account</button>{/if}
      {#if ai.mode === "claude" && app.server?.key.set}<button onclick={() => useMode("api")}>Use the API key instead</button>{/if}
      <button onclick={disconnect}>Disconnect</button>
    </div>
  {:else}
    <ol>
      <li>In a terminal run <code>claude setup-token</code> and sign in when the browser opens.</li>
      <li>Paste the token it prints (it starts with <code>sk-ant-oat</code>) here.</li>
    </ol>
    <form onsubmit={(e) => (e.preventDefault(), connect())}>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-oat…" bind:value={token} aria-label="Claude Code token" class="wide" />
      <button class="primary" disabled={busy || !token}>{busy ? "Checking (about 10 s)…" : "Connect"}</button>
    </form>
    <p class="muted">The token stays in a user-only file on this computer and goes only to the claude command. The check is one tiny request on your plan.</p>
  {/if}
  {#if msg}<p class:ok={msg.ok} class:err={!msg.ok}>{msg.text}</p>{/if}
</div>

<style>
  .acct {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    margin: 8px 0 14px;
  }
  h3 {
    font-size: 15px;
    margin: 2px 0 4px;
  }
  .model {
    display: block;
    margin: 6px 0;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .wide {
    width: min(520px, 100%);
  }
  ol {
    margin: 4px 0;
    padding-left: 20px;
    font-size: 13px;
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
