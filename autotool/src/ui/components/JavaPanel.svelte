<script lang="ts">
  import type { DiffLine } from "../../shared/diff.ts";
  import type { Problem } from "../../shared/spec.ts";
  import { api } from "../api.ts";
  import { app } from "../state.svelte.ts";

  interface Preview {
    file: string;
    java: string;
    diff: (DiffLine | null)[];
    unchanged: boolean;
    problems: Problem[];
    writable: boolean;
    note: string | null;
    changedSinceWritten: boolean | null;
    files: { file: string; java: string; diff: (DiffLine | null)[]; created: boolean; removed?: boolean; unchanged: boolean; changedSinceWritten: boolean | null }[];
    needsHook: boolean;
  }
  let sel = $state(0);
  let preview = $state<Preview | null>(null);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  // refresh after edits settle (the server renders exactly what a write would write)
  $effect(() => {
    const s = app.proposal?.spec ?? app.spec;
    if (!s) return;
    const snap = $state.snapshot(s);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        preview = await api<Preview>("POST", "/api/preview", { spec: snap });
        error = null;
      } catch (e) {
        error = (e as Error).message;
      }
    }, 350);
  });
  // one auto can be several files (route + Blue/Red OpModes + the one-time AutoRunner hook)
  const f = $derived(preview ? (preview.files[sel] ?? preview.files[0] ?? null) : null);
</script>

<div class="java">
  {#if error}<p class="err">{error}</p>{/if}
  {#if preview}
    {#if preview.files.length > 1}
      <div class="tabs">
        {#each preview.files as x, i}<button class:on={x === f} onclick={() => (sel = i)}>{x.file.split("/").pop()}{x.removed ? " (removed)" : x.created ? " (new)" : x.unchanged ? "" : " *"}</button>{/each}
      </div>
    {/if}
    {#if preview.needsHook}<p class="warn">First write of a new auto: AutoRunner.java gets a small one-time change so each OpMode can pick its route (AutoPaths stays the default). You confirm it before anything is written.</p>{/if}
    {#if f}
    <div class="head">
      <code>{f!.file}</code>
      {#if f!.removed}<span class="chg">removed: this auto's older name; Undo write brings it back</span>{:else if f!.unchanged}<span class="ok">matches the file on disk</span>{:else if f!.created}<span class="chg">new file</span>{:else}<span class="chg">{f!.diff.filter((d) => d && d.op !== " ").length} changed lines</span>{/if}
      {#if f!.changedSinceWritten}<span class="warn">the file was edited by hand since AutoTool wrote it</span>{/if}
    </div>
    {#if preview.note}<p class="warn">{preview.note}</p>{/if}
    {#if app.lastCompile}
      <p class:ok={app.lastCompile.ok} class:err={!app.lastCompile.ok}>
        {!app.lastCompile.available ? `Compile check unavailable: ${app.lastCompile.why}` : app.lastCompile.ok ? `Last compile OK (javac, ${(app.lastCompile.ms / 1000).toFixed(1)} s)` : "Last compile failed:"}
      </p>
      {#each app.lastCompile.errors as e}<p class="err mono">{e.file.split("/").pop()}:{e.line}: {e.message}</p>{/each}
    {/if}
    <pre class="diff">{#each f!.diff as d}{#if d === null}<span class="gap">⋯</span>
{:else}<span class="l {d.op === '+' ? 'add' : d.op === '-' ? 'del' : ''}"><span class="n">{d.b ?? d.a}</span>{d.op} {d.text}</span>
{/if}{/each}</pre>
    {/if}
  {/if}
</div>

<style>
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .tabs button {
    font-size: 12px;
  }
  .tabs button.on {
    background: var(--sel);
    color: #000;
  }
  .java {
    padding: 6px 10px;
    font-size: 12px;
  }
  .head {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: baseline;
  }
  .diff {
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.45;
    background: #0b0c0e;
    border: 1px solid var(--line);
    padding: 6px;
    overflow-x: auto;
    max-height: 340px;
  }
  .l {
    display: block;
    white-space: pre;
  }
  .add {
    background: #052e16;
    color: #bbf7d0;
  }
  .del {
    background: #3f0d0d;
    color: #fecaca;
    text-decoration: line-through;
    text-decoration-color: #7f1d1d;
  }
  .n {
    display: inline-block;
    width: 34px;
    color: var(--muted);
    user-select: none;
  }
  .gap {
    color: var(--muted);
  }
  .ok {
    color: var(--intake);
  }
  .chg {
    color: var(--sel);
  }
  .warn {
    color: var(--unsure);
  }
  .err {
    color: #fca5a5;
  }
  .mono {
    font-family: var(--mono);
  }
</style>
