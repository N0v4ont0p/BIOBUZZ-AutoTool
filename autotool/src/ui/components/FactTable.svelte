<script lang="ts">
  import type { Fact } from "../../shared/profile.ts";
  import { api } from "../api.ts";
  import { type ServerState, app } from "../state.svelte.ts";

  const GROUPS: [Fact["group"], string][] = [
    ["robot", "Robot"],
    ["auto", "Auto behaviour (AutoRunner)"],
    ["shooter", "Shooter and turret"],
    ["motion", "Driving speeds (time estimate)"],
    ["field", "Field and rules"],
    ["rubric", "Label rubric thresholds"],
  ];
  const facts = $derived(Object.values(app.server?.profile?.facts ?? {}));
  let error = $state<string | null>(null);

  async function put(key: string, body: { value?: string; confirmed?: boolean }) {
    error = null;
    try {
      app.server = await api<ServerState>("PUT", "/api/profile/fact", { key, ...body });
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function confirmAll() {
    app.server = await api<ServerState>("POST", "/api/profile/confirm-all", {});
  }
  function srcShort(s: string) {
    return s.replace(/TeamCode\/src\/main\/java\/org\/firstinspires\/ftc\/teamcode\//g, "");
  }
</script>

<div class="facts">
  <div class="bar">
    <span>{facts.filter((f) => f.confirmed).length} of {facts.length} confirmed · profile v{app.server?.profile?.profileVersion}</span>
    <button class="primary" onclick={confirmAll}>Confirm all as shown</button>
  </div>
  {#if error}<div class="err">{error}</div>{/if}
  {#if app.server?.profileContradictions.length}<div class="err">{app.server.profileContradictions.join("; ")}</div>{/if}
  <table>
    <thead><tr><th>Fact</th><th>Value</th><th>Where it comes from</th><th>OK</th></tr></thead>
    {#each GROUPS as [g, title]}
      <tbody>
        <tr class="group"><td colspan="4">{title}</td></tr>
        {#each facts.filter((f) => f.group === g) as f (f.key)}
          <tr class:unconfirmed={!f.confirmed}>
            <td><div>{f.label}</div><div class="key">{f.key}</div></td>
            <td class="val">
              <input value={String(f.value)} onchange={(e) => put(f.key, { value: e.currentTarget.value })} aria-label={f.label} />
              <span class="unit">{f.unit}</span>
            </td>
            <td><span class="status {f.status}">{f.status}</span> <span class="src">{srcShort(f.source)}</span>{#if f.note}<div class="note">{f.note}</div>{/if}</td>
            <td><input type="checkbox" checked={f.confirmed} onchange={(e) => put(f.key, { confirmed: e.currentTarget.checked })} aria-label={`confirm ${f.label}`} /></td>
          </tr>
        {/each}
      </tbody>
    {/each}
  </table>
</div>

<style>
  .facts {
    font-size: 13px;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
    padding: 4px;
  }
  td {
    padding: 4px;
    border-top: 1px solid var(--line);
    vertical-align: top;
  }
  tr.group td {
    font-weight: 700;
    color: var(--sel);
    padding-top: 10px;
  }
  tr.unconfirmed td:first-child {
    box-shadow: inset 3px 0 0 var(--unsure);
  }
  .key {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .val {
    white-space: nowrap;
  }
  .val input {
    width: 96px;
  }
  .unit {
    color: var(--muted);
    font-size: 12px;
  }
  .status {
    font-size: 11px;
    padding: 0 5px;
    border-radius: 3px;
    border: 1px solid var(--line);
  }
  .status.assumed {
    color: #000;
    background: var(--unsure);
  }
  .status.code,
  .status.measured {
    color: #04220f;
    background: var(--intake);
  }
  .status.rule,
  .status.pack {
    color: #fff;
    background: #334155;
  }
  .status.user {
    color: #000;
    background: var(--sel);
  }
  .src {
    font-size: 12px;
    color: #cbd5e1;
    word-break: break-word;
  }
  .note {
    font-size: 11px;
    color: var(--muted);
  }
  .err {
    color: #fca5a5;
    margin: 4px 0;
  }
</style>
