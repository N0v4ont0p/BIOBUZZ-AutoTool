<script lang="ts">
  import { approve, codeLabel, continueAI, rejectProposal, runAI } from "../actions.ts";
  import { type During, type End, stopText } from "../../shared/spec.ts";
  import { app } from "../state.svelte.ts";

  let text = $state("");
  let log: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();
  const ai = $derived(app.server?.ai);
  const spend = $derived(app.server?.spend);
  // legs nobody has decided yet (new ones) or marked for review
  const unlabeled = $derived(app.spec?.legs.filter((l) => l.junction.source === "none" || l.junction.review).map((l) => l.id) ?? []);
  const p = $derived(app.proposal);
  const thinking = $derived(!!app.busy && app.busy.startsWith("AI"));
  const model = $derived((app.server?.model ?? "").replace(/^claude-/, "").replace(/ via your Claude account$/, "").replace(/-(\d)-(\d)/, " $1.$2"));
  const ideas = ["Make L1 end in a shot", "Run the intake on L3 and put the ramp out", "Add a park in the LOADING ZONE at the end", "Why is L3 not in the shooting zone?", "Pick up the GARDEN POLLEN after the first shot"];

  $effect(() => {
    void app.chat.length;
    void app.proposal;
    void app.busy;
    if (log) queueMicrotask(() => log && (log.scrollTop = log.scrollHeight));
  });
  // a new proposal always shows, even when the panel was folded away
  $effect(() => {
    if (app.proposal && !app.aiOpen) app.setAiOpen(true);
  });

  function send() {
    const t = text.trim();
    if (!t) return;
    text = "";
    runAI("chat", t);
  }
  function useIdea(i: string) {
    text = i;
    input?.focus();
  }
  const opText = (op: Record<string, unknown>) =>
    op.op === "move_pose"
      ? `Move ${op.pose} to (${op.x}, ${op.y})${op.headingDeg !== undefined ? `, facing ${op.headingDeg}°` : ""}`
      : op.op === "set_heading"
        ? `Turn ${op.pose} to ${op.headingDeg}°`
        : op.op === "add_leg"
          ? `Add a leg after ${op.after} to (${(op.pose as { x: number }).x}, ${(op.pose as { y: number }).y}): ${stopText({ during: op.during as During, end: op.end as End, waitS: op.waitS as number | undefined })}`
          : op.op === "delete_leg"
            ? `Delete leg ${op.leg}`
            : op.op === "set_leg"
              ? `Leg ${op.leg}: ${[
                  op.legTimeoutS !== undefined ? `timeout ${op.legTimeoutS ?? "default"} s` : "",
                  op.carryIntakeS !== undefined ? `carry ${op.carryIntakeS} s` : "",
                  op.heading ? `heading ${op.heading}` : "",
                  op.shotTimeoutS !== undefined ? `shot timeout ${op.shotTimeoutS ?? "default"} s` : "",
                ]
                  .filter(Boolean)
                  .join(", ") || "no change"}`
              : op.op === "set_preload"
                ? `Preload ${op.POLLEN} POLLEN (${op.onTiles} on the tiles)`
                : String(op.op);
</script>

{#if !app.aiOpen}
  <aside class="rail" aria-label="AI">
    <button class="railbtn" onclick={() => app.setAiOpen(true)} title="Open the AI panel (I)" aria-label="Open the AI panel">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" /><path d="M15.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></svg>
      {#if p || thinking}<span class="ping" class:busy={thinking}></span>{/if}
    </button>
    <span class="vert">AI</span>
  </aside>
{:else}
  <aside class="panel" aria-label="AI">
    <header>
      <div class="title">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" /><path d="M15.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></svg>
        <div>
          <h2>Route engineer</h2>
          <span class="status" class:off={!ai?.enabled}>
            {#if ai?.fake}Test model (code rubric){:else if ai?.enabled}{model || "AI"}{:else}Off: {ai?.why}{/if}
          </span>
        </div>
      </div>
      <button class="fold" onclick={() => app.setAiOpen(false)} title="Fold the AI panel away (I)" aria-label="Fold the AI panel away">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
      </button>
    </header>

    {#if app.server?.styleStale}<p class="stalebar">The robot code changed since the house style was learned. Settings, Reference auto: analyze again.</p>{/if}
    <div class="quick">
      <button class="lead" disabled={!ai?.enabled || !!app.busy} onclick={() => runAI("annotate", "", unlabeled.length ? unlabeled : undefined)} title="The AI decides what each leg does (while driving, at the end) from the field geometry and the computed evidence">
        Decide {unlabeled.length ? `${unlabeled.length} leg${unlabeled.length > 1 ? "s" : ""}` : "every leg"}
      </button>
      <button disabled={!!app.busy} onclick={() => codeLabel(true)} title="Works offline: the same rules as code">Use the code rules</button>
    </div>

    <div class="log" bind:this={log} aria-live="polite">
      {#if !app.chat.length && !p && !thinking}
        <div class="empty">
          <p>Ask for a change in plain words. The AI knows the field, the rules and this robot. It proposes an edit, you see it on the field, and Enter approves it.</p>
          <div class="ideas">
            {#each ideas as i}<button onclick={() => useIdea(i)} disabled={!ai?.enabled}>{i}</button>{/each}
          </div>
        </div>
      {/if}
      {#each app.chat as m}
        {#if m.kind === "user"}
          <div class="msg user">{m.text}</div>
        {:else if m.kind === "ai"}
          <div class="msg ai">{m.text}</div>
        {:else if m.kind === "error"}
          <div class="msg err">{m.text}</div>
        {:else}
          <div class="trace">{#if m.kind === "tool"}<span class="tool">{m.text}</span> {m.detail}{:else}{m.text}{/if}</div>
        {/if}
      {/each}
      {#if thinking}
        <div class="thinking" role="status"><span></span><span></span><span></span>{app.busy}</div>
      {/if}
    </div>

    {#if p}
      <section class="proposal" aria-label="Proposal">
        <div class="ph">
          <strong>Proposed change</strong>
          {#if p.repairs}<span class="muted">fixed itself {p.repairs}×</span>{/if}
        </div>
        <p class="sum">{p.patch.summary}</p>
        {#if p.patch.question}<p class="q">{p.patch.question}</p>{/if}
        <div class="detail">
          {#if p.patch.ops.length}
            <ul class="ops">{#each p.patch.ops as op}<li>{opText(op as unknown as Record<string, unknown>)}</li>{/each}</ul>
          {/if}
          {#if p.patch.junctions.length}
            <ul class="labels">{#each p.patch.junctions as j}<li><span class="lid">{j.junction}</span><span class="lab {j.review ? 'review' : j.end}">{j.review ? "review" : stopText(j)}</span><span class="why">{j.reason}</span></li>{/each}</ul>
          {/if}
          <p class="claims" class:bad={!p.claims.ok}>
            {p.claims.ok ? "Every number checked against the computed values." : `Numbers that do not match: ${[...p.claims.mismatches.map((m) => `${m.ref} ${m.claimed} (computed ${m.actual ?? "none"})`), ...p.claims.unverifiedNumbers].join(", ")}`}
          </p>
        </div>
        <div class="acts">
          <button class="primary" onclick={approve} disabled={!!app.busy}>Approve and write <kbd>Enter</kbd></button>
          <button onclick={() => rejectProposal()} disabled={!!app.busy}>Reject <kbd>Esc</kbd></button>
        </div>
      </section>
    {/if}

    {#if spend?.paused}
      <div class="paused">Paused at the ${spend.cap.toFixed(0)} session limit. <button onclick={continueAI}>Continue (+$15)</button></div>
    {/if}

    <form class="composer" onsubmit={(e) => (e.preventDefault(), send())}>
      <textarea
        bind:this={input}
        bind:value={text}
        rows="2"
        placeholder={ai?.enabled ? "Describe a change to this auto" : "AI is off. You can still drag points and set each leg."}
        disabled={!ai?.enabled || !!app.busy}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="Change request"
      ></textarea>
      <button type="submit" class="send" disabled={!ai?.enabled || !!app.busy || !text.trim()} aria-label="Send">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h10M8.5 4l4 4-4 4" /></svg>
      </button>
    </form>
    {#if spend}
      <div class="spend" class:warn={spend.warn} title={`${spend.requests} requests this session`}>
        <span class="meter"><span style={`width:${Math.min(100, (spend.session / spend.cap) * 100)}%`}></span></span>
        {ai?.mode === "claude" ? `About $${spend.session.toFixed(2)} of plan usage this session` : `$${spend.session.toFixed(2)} of $${spend.cap.toFixed(0)} this session`}
      </div>
    {/if}
  </aside>
{/if}

<style>
  .panel,
  .rail {
    position: relative;
    height: 100%;
    min-height: 0;
    background: #111418;
    border-left: 1px solid var(--line);
  }
  /* field tape: the alliance colors along the panel edge */
  .panel::before,
  .rail::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 0;
    bottom: 0;
    width: 3px;
    background: repeating-linear-gradient(180deg, #2563eb 0 14px, transparent 14px 20px, #dc2626 20px 34px, transparent 34px 40px);
    opacity: 0.85;
  }
  .rail {
    width: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding-top: 10px;
  }
  .railbtn {
    position: relative;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    padding: 0;
  }
  .railbtn svg,
  .title svg {
    width: 18px;
    height: 18px;
    fill: #9cc9f5;
  }
  .ping {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--sel);
    box-shadow: 0 0 0 2px #111418;
  }
  .ping.busy {
    animation: pulse 1.2s ease-in-out infinite;
  }
  .vert {
    writing-mode: vertical-rl;
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.08em;
  }
  .panel {
    width: 380px;
    display: flex;
    flex-direction: column;
    animation: slide 0.18s ease-out;
  }
  @keyframes slide {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 12px 10px 16px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  h2 {
    font-size: 15px;
    margin: 0;
    letter-spacing: -0.01em;
  }
  .status {
    font-size: 12px;
    color: #9cc9f5;
  }
  .status.off {
    color: var(--unsure);
  }
  .fold {
    width: 28px;
    height: 28px;
    padding: 0;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: transparent;
    border-color: transparent;
  }
  .fold:hover {
    background: #1d2127;
    border-color: var(--line);
  }
  .fold svg,
  .send svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .stalebar {
    margin: 8px 12px 0 16px;
    padding: 6px 8px;
    border-radius: 8px;
    background: #2a2108;
    color: #fde68a;
    font-size: 12px;
  }
  .quick {
    display: flex;
    gap: 6px;
    padding: 10px 12px 10px 16px;
  }
  .quick .lead {
    border-color: #2f5f86;
    background: #12273a;
    color: #dbeefe;
  }
  .quick .lead:hover:not(:disabled) {
    background: #173350;
  }
  .log {
    flex: 1;
    overflow-y: auto;
    padding: 4px 12px 10px 16px;
    font-size: 13px;
    line-height: 1.45;
    min-height: 80px;
  }
  .empty p {
    color: var(--muted);
    margin: 4px 0 10px;
    max-width: 36ch;
  }
  .ideas {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .ideas button {
    font-size: 12px;
    border-radius: 999px;
    padding: 4px 10px;
    background: #171b20;
    color: #cfd6df;
  }
  .ideas button:hover:not(:disabled) {
    border-color: #2f5f86;
    color: #fff;
  }
  .msg {
    margin: 8px 0;
    padding: 7px 10px;
    border-radius: 10px;
    max-width: 92%;
    white-space: pre-wrap;
  }
  .msg.user {
    margin-left: auto;
    background: #1d3a55;
    color: #eef6ff;
    border-bottom-right-radius: 3px;
  }
  .msg.ai {
    background: #1a1e24;
    color: #e5e7eb;
    border-bottom-left-radius: 3px;
  }
  .msg.err {
    background: #2a1212;
    color: #fecaca;
    border: 1px solid #5b1d1d;
  }
  .trace {
    font-size: 11px;
    color: var(--muted);
    padding-left: 10px;
    border-left: 1px solid var(--line);
    margin: 2px 0;
  }
  .tool {
    font-family: var(--mono);
    color: #93c5fd;
  }
  .thinking {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #9cc9f5;
    margin: 8px 0;
  }
  .thinking span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #9cc9f5;
    animation: pulse 1s ease-in-out infinite;
  }
  .thinking span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .thinking span:nth-child(3) {
    animation-delay: 0.3s;
    margin-right: 6px;
  }
  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }
  .proposal {
    margin: 0 12px 10px 16px;
    border: 1px solid #2f5f86;
    border-radius: 12px;
    background: linear-gradient(180deg, #13263a, #111a24);
    padding: 10px 12px;
    font-size: 13px;
    max-height: 46vh;
    display: flex;
    flex-direction: column;
    animation: slide 0.18s ease-out;
  }
  .ph {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    color: #cfe8ff;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .sum {
    margin: 6px 0;
  }
  .q {
    margin: 4px 0 6px;
    padding: 6px 8px;
    border-radius: 8px;
    background: #2a2108;
    color: #fde68a;
  }
  .detail {
    overflow-y: auto;
    min-height: 0;
  }
  ul {
    margin: 4px 0;
    padding-left: 0;
    list-style: none;
  }
  .ops li {
    padding: 2px 0 2px 12px;
    position: relative;
  }
  .ops li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0.65em;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--sel);
  }
  .labels li {
    display: grid;
    grid-template-columns: 26px auto 1fr;
    gap: 6px;
    align-items: baseline;
    padding: 3px 0;
    font-size: 12px;
  }
  .lid {
    font-family: var(--mono);
    color: var(--muted);
  }
  .lab {
    font-weight: 600;
    white-space: nowrap;
  }
  .lab.SHOOT {
    color: var(--shoot);
  }
  .lab.WAIT {
    color: var(--drive);
  }
  .lab.PARK {
    color: var(--lz);
  }
  .lab.review {
    color: var(--unsure);
  }
  .lab.NONE {
    color: var(--drive);
  }
  .why {
    color: #c3cad3;
  }
  .claims {
    font-size: 11px;
    color: var(--intake);
    margin: 6px 0 0;
  }
  .claims.bad {
    color: var(--shoot);
  }
  .acts {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  kbd {
    font-family: var(--mono);
    font-size: 10px;
    opacity: 0.7;
    margin-left: 4px;
  }
  .paused {
    margin: 0 12px 8px 16px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #3b2405;
    border: 1px solid #b45309;
    font-size: 13px;
  }
  .composer {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    margin: 0 12px 6px 16px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #0d1013;
  }
  .composer:focus-within {
    border-color: #2f5f86;
  }
  textarea {
    flex: 1;
    resize: none;
    font: inherit;
    font-size: 13px;
    border: 0;
    background: transparent;
    outline: none;
    padding: 4px 6px;
  }
  .send {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--sel);
    border-color: var(--sel);
    color: #04121c;
  }
  .send:disabled {
    background: #1d2127;
    border-color: var(--line);
    color: var(--muted);
  }
  .spend {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--muted);
    padding: 0 12px 10px 16px;
    font-variant-numeric: tabular-nums;
  }
  .spend.warn {
    color: var(--unsure);
  }
  .meter {
    width: 48px;
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--intake);
  }
  @media (prefers-reduced-motion: reduce) {
    .panel,
    .proposal,
    .ping.busy,
    .thinking span {
      animation: none;
    }
  }
  @media (max-width: 1100px) {
    .panel {
      width: 100%;
    }
  }
</style>
