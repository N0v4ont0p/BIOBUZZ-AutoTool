<script lang="ts">
  import { blankAuto, importPpText, newAuto, viewFile } from "../actions.ts";
  import { api } from "../api.ts";
  import { app } from "../state.svelte.ts";

  let open = $state(false);
  let query = $state("");
  let root: HTMLDivElement | undefined = $state();
  let search: HTMLInputElement | undefined = $state();
  let ppInput: HTMLInputElement | undefined = $state();

  const autos = $derived(app.server?.autos ?? []);
  const current = $derived(autos.find((a) => a.name === app.autoName));
  const currentLabel = $derived.by(() => {
    const o = current?.opModes.find((m) => (m.alliance === "RED") === app.redView) ?? current?.opModes[0];
    return o ? o.name.replace(/_/g, " ") : app.autoName;
  });
  const q = $derived(query.trim().toLowerCase());
  const hit = (...s: (string | null | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q));
  // one row per Driver Station entry: "Blue Near 9" and "Red Near 9" are the same route, seen per alliance
  const show = (n: string) => n.replace(/_/g, " ");
  const rows = $derived(
    autos
      .filter((a) => a.file)
      .flatMap((a) => (a.opModes.length ? a.opModes.map((o) => ({ auto: a, label: show(o.name), red: o.alliance === "RED" })) : [{ auto: a, label: a.name, red: false }]))
      .filter((r) => hit(r.label, r.auto.name, r.auto.file)),
  );
  const drafts = $derived(autos.filter((a) => !a.file && hit(a.name)));
  const pp = $derived((app.server?.folder.pp ?? []).filter((f) => hit(f)));
  const other = $derived((app.server?.folder.other ?? []).filter((o) => hit(o.name, o.file)));
  const base = (f: string) => f.split("/").pop();

  async function toggle() {
    open = !open;
    if (open) {
      query = "";
      queueMicrotask(() => search?.focus());
      await app.refresh(); // picks up files added or changed in Android Studio
    }
  }
  async function pick(name: string, red = false) {
    open = false;
    if (name !== app.autoName) await app.openAuto(name);
    app.redView = red;
  }
  async function openPp(file: string) {
    open = false;
    const r = await api<{ text: string }>("POST", "/api/file", { path: file });
    await importPpText(file, r.text);
  }
  async function openOther(file: string, name: string) {
    open = false;
    try {
      const r = await api<{ name: string; legs: number; framework: string }>("POST", "/api/autos/read", { file, name });
      await app.refresh();
      await app.openAuto(r.name);
      app.flash(`Read ${base(file)}: ${r.legs} legs (${r.framework}).`);
    } catch (e) {
      app.flash((e as Error).message, "error");
    }
  }
  function onDocClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:document onclick={onDocClick} />
<svelte:window onfocus={() => app.refresh()} />

<div class="picker" bind:this={root} onkeydowncapture={onKey}>
  <button class="trigger" aria-haspopup="listbox" aria-expanded={open} onclick={toggle} title="Switch auto">
    <span class="brand">AutoTool</span>
    <span class="cur">
      <span class="name">{currentLabel}</span>
      <span class="ds">{current?.file ? `${app.autoName}, ${base(current.file)}` : "draft, not written yet"}</span>
    </span>
    <svg class="chev" class:up={open} viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
  </button>

  {#if open}
    <div class="pop" role="listbox" aria-label="Autos">
      <input class="find" bind:this={search} bind:value={query} placeholder="Find an auto, file or Driver Station name" aria-label="Find" />
      <div class="scroll">
        {#if rows.length}
          <h4>On the robot</h4>
          {#each rows as r}
            {@const on = r.auto.name === app.autoName && r.red === app.redView}
            <button class="row" class:on role="option" aria-selected={on} onclick={() => pick(r.auto.name, r.red)}>
              <span class="dot" class:blue={!r.red} class:red={r.red}></span>
              <span class="txt">
                <span class="t">{r.label}</span>
                <span class="s">{r.red ? `the ${r.auto.name} route reflected for red` : `${r.auto.name}, ${base(r.auto.file!)}`}</span>
              </span>
              <span class="n">{r.auto.legs} leg{r.auto.legs === 1 ? "" : "s"}{r.auto.points !== null ? ` · ${r.auto.points} pts` : ""}</span>
            </button>
          {/each}
        {/if}
        {#if drafts.length}
          <h4>Drafts</h4>
          {#each drafts as a}
            <button class="row" class:on={a.name === app.autoName} role="option" aria-selected={a.name === app.autoName} onclick={() => pick(a.name)}>
              <span class="dot draft"></span>
              <span class="txt"><span class="t">{a.name}</span><span class="s">not written yet; Write puts it on the robot</span></span>
              <span class="n">{a.legs} leg{a.legs === 1 ? "" : "s"}</span>
            </button>
          {/each}
        {/if}
        {#if pp.length}
          <h4>Pedro paths in the repo</h4>
          {#each pp as f}
            <button class="row" onclick={() => openPp(f)}>
              <span class="dot pp"></span>
              <span class="txt"><span class="t">{base(f)}</span><span class="s">{f}; opens as a new draft</span></span>
            </button>
          {/each}
        {/if}
        {#if other.length}
          <h4>Other autos</h4>
          {#each other as o}
            <div class="rowpair">
              <button class="row" onclick={() => openOther(o.file, o.name)}>
                <span class="dot other"></span>
                <span class="txt"><span class="t">{o.name}</span><span class="s">{base(o.file)}; hand-written, opens read-only with every pose and action</span></span>
              </button>
              <button class="code" onclick={() => ((open = false), viewFile(o.file, o.why))} title="Show the Java">Code</button>
            </div>
          {/each}
        {/if}
        {#if !rows.length && !drafts.length && !pp.length && !other.length}
          <p class="none">{q ? `Nothing matches "${query}".` : "No autos found in the repo yet."}</p>
        {/if}
      </div>
      <div class="foot">
        <button class="mg" onclick={() => ((open = false), (app.showManage = true))}>Manage all autos…</button>
        <button class="primary" onclick={() => ((open = false), blankAuto())}>+ New auto</button>
        <button onclick={() => ((open = false), newAuto())} title="A copy of the open auto under a new name">Copy this auto</button>
        <button onclick={() => ppInput?.click()}>Open a .pp file</button>
        {#if current?.file}<button onclick={() => ((open = false), viewFile(current.file!))}>View {base(current.file)}</button>{/if}
      </div>
      <input type="file" accept=".pp,.json,application/json" hidden bind:this={ppInput} onchange={async (e) => { const f = e.currentTarget.files?.[0]; if (f) { open = false; await importPpText(f.name, await f.text()); } }} />
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
  }
  .trigger {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px 4px 8px;
    border-radius: 8px;
    background: transparent;
    border: 1px solid transparent;
    text-align: left;
  }
  .trigger:hover,
  .trigger[aria-expanded="true"] {
    background: #1b1e23;
    border-color: var(--line);
  }
  .brand {
    font-weight: 700;
    letter-spacing: -0.01em;
    padding-right: 10px;
    border-right: 1px solid var(--line);
  }
  .cur {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ds {
    font-size: 11px;
    color: var(--muted);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.6;
    transition: transform 0.15s ease;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    width: min(440px, calc(100vw - 24px));
    background: #16191d;
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.55);
    z-index: 30;
    display: flex;
    flex-direction: column;
    max-height: min(70vh, 560px);
    transform-origin: top left;
    animation: pop 0.14s ease-out;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
    }
  }
  .find {
    margin: 10px 10px 4px;
    padding: 7px 10px;
    border-radius: 8px;
    background: #0f1114;
    border: 1px solid var(--line);
  }
  .scroll {
    overflow-y: auto;
    padding: 0 6px 6px;
  }
  h4 {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    margin: 10px 8px 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 8px;
    border-radius: 8px;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .rowpair {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .rowpair .row {
    flex: 1;
  }
  .code {
    font-size: 11px;
    padding: 2px 8px;
  }
  .row:hover,
  .row:focus-visible {
    background: #20242a;
  }
  .row.on {
    background: #13283a;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .dot.blue {
    background: #3b82f6;
  }
  .dot.red {
    background: #ef4444;
  }
  .dot.draft {
    background: transparent;
    border: 1.5px solid var(--unsure);
  }
  .dot.pp {
    background: var(--repo);
  }
  .dot.other {
    background: var(--line);
  }
  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .t {
    font-weight: 600;
  }
  .s {
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .none {
    color: var(--muted);
    font-size: 13px;
    padding: 12px 8px;
  }
  .foot {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
  }
  .foot button {
    font-size: 12px;
  }
  .foot .mg {
    border-color: #2f5f86;
    color: #dbeefe;
  }
  @media (prefers-reduced-motion: reduce) {
    .pop {
      animation: none;
    }
    .chev {
      transition: none;
    }
  }
</style>
