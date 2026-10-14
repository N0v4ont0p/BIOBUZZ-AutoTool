<script lang="ts">
  import { computeFeatures } from "../../shared/features.ts";
  import { type AutoSpec, stopText } from "../../shared/spec.ts";
  import { api, apiStream } from "../api.ts";
  import Field from "./Field.svelte";
  import { type ServerState, type StyleRecord, app } from "../state.svelte.ts";

  let { onConfirmed }: { onConfirmed?: () => void } = $props();

  const rec = $derived(app.server?.style ?? null);
  // the team's own repo first: its sample auto (e.g. SampleAutoPaths) is the usual reference
  let root = $state(app.server?.style?.sampleRoot ?? app.server?.repo?.root ?? "");
  let autos = $state<{ file: string; name: string; lines: number }[] | null>(null);
  let pick = $state(app.server?.style?.autoFile ?? "");
  let busy = $state(false);
  let progress = $state<string[]>([]);
  let err = $state<string | null>(null);
  let notes = $state(app.server?.style?.notes ?? "");
  const ai = $derived(app.server?.ai);
  $effect(() => {
    if (root && autos === null && !busy) find();
  });

  async function find() {
    err = null;
    autos = null;
    try {
      const r = await api<{ root: string; autos: { file: string; name: string; lines: number }[] }>("POST", "/api/style/autos", { root: root.trim() });
      root = r.root;
      autos = r.autos;
      if (!r.autos.length) err = "No @Autonomous OpModes in that repo.";
      else if (!r.autos.some((a) => a.file === pick)) pick = r.autos[0].file;
    } catch (e) {
      err = (e as Error).message;
    }
  }
  // read a sample with the auto reader and draw it right here (read-only), with what it does on each leg
  let drawn = $state<AutoSpec | null>(null);
  const drawnF = $derived(drawn && app.pack && app.model ? computeFeatures(drawn, app.pack, app.model) : null);
  async function openDrawing(file: string, name: string) {
    err = null;
    try {
      const sameRepo = root === app.server?.repo?.root;
      const r = await api<{ name: string; legs: number; framework: string }>("POST", "/api/autos/read", { file, name: `sample_${name}`, ...(sameRepo ? {} : { root }) });
      drawn = await api<AutoSpec>("POST", "/api/autos/get", { name: r.name });
      await app.refresh();
    } catch (e) {
      err = (e as Error).message;
    }
  }
  // the analysis writes **bold**; show it as bold, everything else as text
  const md = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  async function analyze() {
    busy = true;
    err = null;
    progress = [];
    const t0 = Date.now();
    try {
      await apiStream("/api/style/analyze", { root, file: pick }, (e) => {
        if (e.type === "status") progress = [...progress, String(e.text)];
        else if (e.type === "error") err = String(e.message);
        else if (e.type === "done") progress = [...progress, `Done in ${Math.round((Date.now() - t0) / 1000)} s. Read it below, then confirm.`];
      });
      await app.refresh();
    } catch (e) {
      err = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function save(patch: Partial<Pick<StyleRecord, "confirmed" | "notes" | "writer">>) {
    app.server = await api<ServerState>("POST", "/api/style/save", patch);
    if (patch.confirmed) onConfirmed?.();
  }
</script>

<div class="setup">
  <p class="lead">Pick the auto AutoTool should learn from: your robot's own sample auto (listed first), or another repo's auto your team trusts, for example last season's <code>BLUE_CLOSE_18</code>. Opus 5.5 reads it and everything it uses (paths, shooting, intake, gates, turret, auto-aim, timing, the TeleOp hand-off), then reads this robot's code, and writes the house style: the rules every new auto follows, using only the classes this robot has. AI and Write unlock once you confirm it.</p>

  <div class="row">
    <input class="path" bind:value={root} placeholder="Robot repo folder (this robot, or another, e.g. ~/FTC/BIOBUZZ-Robot-Simulator)" aria-label="Sample repo folder" onkeydown={(e) => e.key === "Enter" && find()} />
    <button onclick={find} disabled={!root.trim() || busy}>Find autos</button>
    {#if app.server?.repo && root !== app.server.repo.root}<button onclick={() => ((root = app.server!.repo!.root), find())}>This robot's repo</button>{/if}
  </div>

  {#if autos?.length}
    <div class="autos" role="radiogroup" aria-label="Sample auto">
      {#each autos as a}
        <label class="auto" class:on={pick === a.file}>
          <input type="radio" name="sample" value={a.file} bind:group={pick} />
          <span class="an">{a.name}</span>
          <span class="af">{a.file.split("/").slice(-2).join("/")}, {a.lines} lines <button class="link" onclick={(e) => (e.preventDefault(), openDrawing(a.file, a.name))}>See it drawn</button></span>
        </label>
      {/each}
    </div>
    <div class="row">
      <button class="primary" onclick={analyze} disabled={busy || !pick || !ai?.enabled}>{busy ? "Studying the sample…" : rec ? "Analyze again" : "Analyze with Opus 5.5"}</button>
      {#if !ai?.enabled}<span class="warn">Connect the AI first (step 1).</span>{:else}<span class="muted">One careful read, a few minutes. {ai.mode === "claude" ? "It runs on your Claude plan." : "About $0.30 of API credit."}</span>{/if}
    </div>
  {/if}

  {#if drawn}
    <section class="drawn">
      <header>
        <div><h3>{drawn.name.replace(/^sample_/, "")}, as the reader sees it</h3><span class="muted">{drawn.reader?.framework}; {drawn.legs.length} legs; every pose and action from the code. It is also in the auto menu.</span></div>
        <button onclick={() => (drawn = null)}>Close</button>
      </header>
      <div class="dgrid">
        {#if drawnF && app.pack && app.model}<div class="dfield"><Field spec={drawn} features={drawnF} pack={app.pack} model={app.model} editable={false} /></div>{/if}
        <ol class="dlegs">
          {#each drawn.legs as l}
            <li>
              <strong>{l.id} {stopText(l).toLowerCase()}</strong> <span class="muted">{l.comment}</span>
              {#if l.steps?.length}<ul>{#each l.steps as st}<li><span class="when">{st.when === "during" ? (st.ms ? `+${st.ms} ms` : "during") : st.when}</span> <code>{st.text}</code></li>{/each}</ul>{/if}
            </li>
          {/each}
        </ol>
      </div>
    </section>
  {/if}

  {#if progress.length}<ul class="progress">{#each progress as p}<li>{p}</li>{/each}{#if busy}<li class="pulse">working</li>{/if}</ul>{/if}
  {#if err}<p class="err">{err}</p>{/if}

  {#if rec}
    <section class="style">
      <header>
        <div>
          <h3>House style from {rec.autoFile.split("/").pop()}</h3>
          <span class="muted">{rec.files.length} sample files and {rec.targetFiles.length} robot files read by {rec.model}, {new Date(rec.at).toLocaleString()}</span>
        </div>
        {#if rec.confirmed}<span class="ok">Confirmed</span>{:else}<span class="warn">Not confirmed yet</span>{/if}
      </header>
      {#if app.server?.styleStale}<p class="stale">Your robot code changed since this house style was learned (for example new AutoRunner options). Analyze again so new autos and the AI use what the code can do now.</p>{:else if !rec.targetHash}<p class="stale">This house style was learned before AutoTool tracked robot-code changes. If AutoRunner changed since, analyze again.</p>{/if}
      <p class="summary">{@html md(rec.style.summary)}</p>
      {#each rec.style.sections as s}
        <details><summary>{s.title}</summary><p class="body">{@html md(s.text)}</p></details>
      {/each}
      {#if rec.style.mapping.length}
        <details open>
          <summary>Sample call and this robot's equivalent ({rec.style.mapping.length})</summary>
          <table>
            <thead><tr><th>Sample</th><th>This robot</th><th>Note</th></tr></thead>
            <tbody>{#each rec.style.mapping as m}<tr><td><code>{m.sample}</code></td><td><code>{m.target}</code></td><td>{m.note}</td></tr>{/each}</tbody>
          </table>
        </details>
      {/if}
      <details open>
        <summary>Rules every new auto follows ({rec.style.rules.length})</summary>
        <ol class="rules">{#each rec.style.rules as r}<li>{@html md(r)}</li>{/each}</ol>
      </details>
      {#if rec.style.gaps.length}
        <details open><summary>What this robot's code does not have ({rec.style.gaps.length})</summary><ul class="gaps">{#each rec.style.gaps as g}<li>{@html md(g)}</li>{/each}</ul></details>
      {/if}

      <label class="notes">
        Your notes for the AI (optional): corrections or preferences
        <textarea rows="3" bind:value={notes} placeholder="For example: always start the intake 200 ms into the path; never shoot from more than 70 in"></textarea>
      </label>
      <div class="row">
      </div>
      <div class="row">
        <button class="primary" onclick={() => save({ notes, confirmed: true })}>{rec.confirmed ? "Save notes" : "This is our style: confirm"}</button>
        {#if rec.confirmed}<button onclick={() => save({ confirmed: false })}>Unconfirm</button>{/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .setup {
    max-width: 920px;
  }
  .lead {
    max-width: 72ch;
    color: #d6dbe1;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin: 8px 0;
  }
  .path {
    flex: 1;
    min-width: 280px;
  }
  .autos {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 6px;
    margin: 8px 0;
  }
  .auto {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 8px;
    align-items: center;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    cursor: pointer;
  }
  .auto.on {
    border-color: var(--sel);
    background: #10202d;
  }
  .link {
    background: none;
    border: 0;
    padding: 0 0 0 6px;
    color: var(--sel);
    font-size: 12px;
    text-decoration: underline;
    cursor: pointer;
  }
  .an {
    font-weight: 600;
  }
  .af {
    grid-column: 2;
    font-size: 12px;
    color: var(--muted);
  }
  .progress {
    list-style: none;
    padding: 0;
    font-size: 13px;
    color: var(--muted);
  }
  .progress li::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--sel);
    margin-right: 8px;
    vertical-align: middle;
  }
  .pulse {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .drawn {
    margin: 12px 0;
    border: 1px solid #2f5f86;
    border-radius: 12px;
    padding: 10px 12px;
    background: #0f1822;
  }
  .drawn header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .dgrid {
    display: grid;
    grid-template-columns: minmax(260px, 420px) 1fr;
    gap: 12px;
    margin-top: 8px;
  }
  .dfield {
    aspect-ratio: 1;
  }
  .dlegs {
    font-size: 12px;
    max-height: 420px;
    overflow-y: auto;
    margin: 0;
    padding-left: 18px;
  }
  .dlegs ul {
    list-style: none;
    padding-left: 6px;
    margin: 2px 0 6px;
  }
  .when {
    color: #9cc9f5;
  }
  @media (max-width: 760px) {
    .dgrid {
      grid-template-columns: 1fr;
    }
  }
  .style {
    margin-top: 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 14px;
    background: #12151a;
  }
  .style header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  h3 {
    margin: 0;
    font-size: 15px;
  }
  .stale {
    margin: 8px 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: #2a2108;
    color: #fde68a;
    font-size: 13px;
  }
  .summary {
    max-width: 75ch;
  }
  details {
    border-top: 1px solid var(--line);
    padding: 6px 0;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  .body {
    white-space: pre-wrap;
    max-width: 80ch;
    color: #d6dbe1;
    font-size: 13px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-top: 6px;
  }
  th,
  td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 600;
  }
  .rules,
  .gaps {
    font-size: 13px;
    max-width: 80ch;
  }
  .rules li,
  .gaps li {
    margin: 3px 0;
  }
  .notes {
    display: block;
    margin-top: 10px;
    font-size: 13px;
  }
  .notes textarea {
    display: block;
    width: 100%;
    margin-top: 4px;
    font: inherit;
  }
  .ok {
    color: var(--intake);
    font-weight: 600;
  }
  .warn {
    color: var(--unsure);
  }
  .err {
    color: #fca5a5;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
</style>
