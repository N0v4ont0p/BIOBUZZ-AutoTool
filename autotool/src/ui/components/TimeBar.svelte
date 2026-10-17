<script lang="ts">
  import type { Conflict } from "../../shared/compare.ts";
  import type { AutoFeatures } from "../../shared/features.ts";
  import { heldAt, poseAtTime, rampOutAt } from "../../shared/features.ts";
  import type { AutoSpec } from "../../shared/spec.ts";
  import { legLook } from "../draw.ts";
  import { app } from "../state.svelte.ts";

  let { features, spec, partner = null }: { features: AutoFeatures; spec: AutoSpec; partner?: { name: string; features: AutoFeatures; delayS: number; conflicts: Conflict[] } | null } = $props();
  // a lane for the ramp when the auto uses it, and a second row for the partner
  const rampLane = $derived(features.ramp.used);
  const RY = 33; // ramp lane top
  const RH = 9; // ramp lane height (full height = fully out)
  const dy = $derived(rampLane ? 12 : 0);
  const H = $derived((partner ? 60 : 46) + dy);
  const tickY = $derived((partner ? 58 : 44) + dy);

  let width = $state(1000);
  const W = $derived(Math.max(300, width));
  const L = 14;
  const R = 14;
  const span = $derived(Math.max(30, Math.ceil(Math.max(features.timeline.nominalS, partner ? partner.features.timeline.nominalS + partner.delayS : 0))));
  const bands = $derived(partner?.conflicts.filter((c) => c.kind === "collision" || c.kind === "nearMiss" || c.kind === "park" || (c.kind === "start" && c.gapIn !== Infinity)) ?? []);

  // Play: both robots move in real time from where the scrubber is
  let last = 0;
  function frame(now: number) {
    if (!app.playing) return;
    if (last) app.scrubT = Math.min(span, app.scrubT + (now - last) / 1000);
    last = now;
    if (app.scrubT >= span) app.playing = false;
    else requestAnimationFrame(frame);
  }
  function play() {
    if (app.playing) return void (app.playing = false);
    if (app.scrubT >= span - 0.05) app.scrubT = 0;
    app.playing = true;
    last = 0;
    requestAnimationFrame(frame);
  }
  const X = (t: number) => L + (t / span) * (W - 20 - L - R);
  // the drive times use the profile's speed, acceleration and braking: say so while any of them is a guess
  const guessed = $derived.by(() => {
    const f = app.server?.profile?.facts;
    if (!f) return "";
    const g = ["maxVel", "accel", "decel"].filter((k) => f[k] && f[k].status === "assumed");
    return g.length ? g.map((k) => `${f[k].label.toLowerCase()} ${f[k].value} ${f[k].unit}`).join(", ") : "";
  });
  let bar: SVGSVGElement | undefined = $state();
  let dragging = false;

  function tFrom(e: PointerEvent) {
    const r = bar!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * (W - 20);
    return Math.max(0, Math.min(span, ((x - L) / (W - 20 - L - R)) * span));
  }
  function down(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    app.scrubT = Math.round(tFrom(e) * 10) / 10;
  }
  function move(e: PointerEvent) {
    if (dragging) app.scrubT = Math.round(tFrom(e) * 10) / 10;
  }
  function key(e: KeyboardEvent) {
    if (e.key === "ArrowRight") app.scrubT = Math.min(span, Math.round((app.scrubT + (e.shiftKey ? 1 : 0.1)) * 10) / 10);
    else if (e.key === "ArrowLeft") app.scrubT = Math.max(0, Math.round((app.scrubT - (e.shiftKey ? 1 : 0.1)) * 10) / 10);
    else if (e.key === "Home") app.scrubT = 0;
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  const at = $derived(poseAtTime(features, app.scrubT));
  const held = $derived(heldAt(features, app.scrubT));
  const rampNow = $derived(rampLane ? rampOutAt(features.ramp.moves, features.ramp, app.scrubT) : 0);
  const rampWord = $derived.by(() => {
    if (!rampLane) return "";
    const seg = features.ramp.segments.find((s) => app.scrubT >= s.fromS - 1e-9 && app.scrubT < s.toS - 1e-9);
    const state = seg?.state ?? (rampNow >= 0.999 ? "out" : "in");
    return state === "deploying" || state === "stowing" ? `${state} ${Math.round(rampNow * 100)}%` : state;
  });
  // the ramp lane as an area: its height is how far out the ramp is
  const rampArea = $derived.by(() => {
    if (!rampLane) return "";
    const base = RY + RH;
    const pts: string[] = [`${X(0)},${base}`];
    for (const s of features.ramp.segments) {
      pts.push(`${X(Math.min(span, s.fromS))},${base - RH * s.fromOut}`, `${X(Math.min(span, s.toS))},${base - RH * s.toOut}`);
    }
    const end = features.ramp.segments.at(-1);
    pts.push(`${X(Math.min(span, end?.toS ?? 0))},${base}`);
    return pts.join(" ");
  });
  const segTitle = (s: (typeof features.ramp.segments)[number]) =>
    `ramp ${s.state} ${s.fromS.toFixed(2)}–${s.toS.toFixed(2)} s${s.state === "deploying" || s.state === "stowing" ? ` (${Math.round(s.fromOut * 100)}% → ${Math.round(s.toOut * 100)}%)` : ""}`;
  const rampGuessed = $derived(["rampOutS", "rampInS"].some((k) => app.server?.profile?.facts?.[k]?.status === "assumed"));
  const fill: Record<string, string> = { drive: "#8b8f97", intake: "var(--intake)", ramp: "#a3e635", reposition: "var(--repo)", unsure: "var(--unsure)" };
</script>

<div class="timebar" bind:clientWidth={width}>
  <div class="readout" aria-live="polite">
    <button class="play" onclick={play} aria-label={app.playing ? "Pause" : "Play"} title={partner ? "Play both robots together" : "Play the auto"}>{app.playing ? "❚❚" : "▶"}</button>
    <strong>t = {app.scrubT.toFixed(1)} s</strong>
    {#if at}<span>{at.legId ?? "done"} · {at.phase === "action" ? "at the stop" : at.phase === "travel" ? "driving" : "finished"} · holding {held}{#if rampLane}{" · "}<span class="rampword" class:out={rampNow >= 0.999} class:moving={rampNow > 0.001 && rampNow < 0.999} class:off={!features.ramp.calibrated} title={features.ramp.calibrated ? "" : "the ramp times are not measured in the robot code yet: the robot keeps it stowed"}>ramp {rampWord}{features.ramp.calibrated ? "" : " (times not measured)"}</span>{/if}</span>{/if}
    <span class="tot" class:over={features.timeline.nominalS > features.timeline.autoS}>total {features.timeline.nominalS.toFixed(1)} s · worst {features.timeline.worstS.toFixed(1)} s</span>
    {#if guessed}<span class="guess" title="Measured by program 5 (top speed) once the robot is tuned; until then the drive times are a safe guess">drive times assume {guessed}</span>{/if}
  </div>
  <svg
    bind:this={bar}
    viewBox="0 0 {W - 20} {H}"
    style:height="{H}px"
    role="slider"
    tabindex="0"
    aria-label="Time scrubber"
    aria-valuemin="0"
    aria-valuemax={span}
    aria-valuenow={app.scrubT}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={() => (dragging = false)}
    onkeydown={key}
  >
    <defs>
      <pattern id="tbhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#000" stroke-opacity="0.45" stroke-width="2" /></pattern>
    </defs>
    <rect x={L} y="12" width={W - 20 - L - R} height="18" fill="#1b1d21" />
    {#each features.legs as l}
      {@const leg = spec.legs[l.index]}
      {@const look = leg ? legLook(leg) : "drive"}
      {@const x0 = X(l.startS)}
      {@const x1 = X(l.startS + l.travelS)}
      {@const x2 = X(l.endS)}
      <g class:sel={app.selected === l.id} class:cut={l.cut !== "none"}>
        <rect x={x0} y="12" width={Math.max(0.5, x1 - x0)} height="18" fill={fill[look]} class="seg" />
        {#if look === "reposition" || look === "unsure"}<rect x={x0} y="12" width={Math.max(0.5, x1 - x0)} height="18" fill="url(#tbhatch)" />{/if}
        {#if l.endActionS > 0}
          <rect x={x1} y="12" width={Math.max(0.5, x2 - x1)} height="18" fill="var(--shoot)" class="seg"><title>{l.id} {l.end} {l.endActionS.toFixed(2)} s{l.endActionText ? `: ${l.endActionText}` : ""}</title></rect>
          <rect x={x1} y="12" width={Math.max(0.5, x2 - x1)} height="18" fill="url(#tbhatch)" />
        {/if}
        {#if x2 - x0 > 34}<text x={(x0 + x2) / 2} y="24.5" text-anchor="middle" class="segtext">{l.id}</text>{/if}
        <line x1={x2} y1="10" x2={x2} y2="32" stroke="#000" stroke-width="1.5" />
      </g>
    {/each}
    {#if rampLane}
      <!-- the ramp: height = how far out (AutoRunner's commands at the measured out / in times) -->
      <rect x={L} y={RY} width={W - 20 - L - R} height={RH} class="ramptrack" />
      <polygon points={rampArea} class="ramparea" class:off={!features.ramp.calibrated} />
      {#each features.ramp.segments as s}
        {#if s.state !== "in"}<rect x={X(Math.min(span, s.fromS))} y={RY} width={Math.max(0.5, X(Math.min(span, s.toS)) - X(Math.min(span, s.fromS)))} height={RH} class="rampseg"><title>{segTitle(s)}</title></rect>{/if}
      {/each}
      {#each features.ramp.moves as m}
        <line x1={X(Math.min(span, m.t))} y1={RY - 1} x2={X(Math.min(span, m.t))} y2={RY + RH + 1} class="rampmove"><title>{m.t.toFixed(2)} s: {m.out ? "out" : "in"} ({m.why})</title></line>
      {/each}
      <text x="2" y={RY + RH - 0.5} class="plabel ramplabel">R<title>Ramp: {features.ramp.calibrated ? "" : "times not measured in the robot code yet (program 4), so the robot keeps it stowed; "}out {features.ramp.outS} s, in {features.ramp.inS} s{rampGuessed ? " (assumed until program 4 times it)" : ""}</title></text>
    {/if}
    <!-- worst case -->
    <line x1={X(Math.min(span, features.timeline.worstS))} y1="8" x2={X(Math.min(span, features.timeline.worstS))} y2="34" class="worst" />
    <!-- abort and the end of auto -->
    <line x1={X(features.timeline.abortAtS)} y1="4" x2={X(features.timeline.abortAtS)} y2="38" class="abort" />
    <text x={X(features.timeline.abortAtS) - 3} y="9" text-anchor="end" class="abortText">abort {features.timeline.abortAtS} s</text>
    <line x1={X(30)} y1="4" x2={X(30)} y2="38" class="end" />
    {#if partner}
      <!-- the partner's run, below ours -->
      {#each partner.features.legs as l}
        {@const x0 = X(l.startS + partner.delayS)}
        {@const x2 = X(l.endS + partner.delayS)}
        <rect x={x0} y={36 + dy} width={Math.max(0.5, x2 - x0)} height="10" class="pseg" />
        <line x1={x2} y1={35 + dy} x2={x2} y2={47 + dy} stroke="#000" stroke-width="1.5" />
        {#if x2 - x0 > 30}<text x={(x0 + x2) / 2} y={43.5 + dy} text-anchor="middle" class="segtext small">{l.id}</text>{/if}
      {/each}
      {#if partner.delayS > 0}<rect x={X(0)} y={36 + dy} width={X(partner.delayS) - X(0)} height="10" class="pwait" />{/if}
      <text x="2" y={44 + dy} class="plabel">P</text>
      {#each bands as c}
        <rect x={X(c.from) - 1} y="10" width={Math.max(2, X(c.to) - X(c.from) + 2)} height={38 + dy} class="band" class:near={c.kind === "nearMiss"}><title>{c.text}</title></rect>
      {/each}
    {/if}
    {#each Array.from({ length: Math.floor(span / 5) + 1 }, (_, i) => i * 5) as t}
      <text x={X(t)} y={tickY} text-anchor="middle" class="tick">{t}</text>
    {/each}
    <!-- scrubber -->
    <line x1={X(app.scrubT)} y1="2" x2={X(app.scrubT)} y2={(partner ? 48 : 36) + dy} class="scrub" />
    <rect x={X(app.scrubT) - 4} y="0" width="8" height="8" rx="2" class="scrubknob" />
  </svg>
</div>

<style>
  .timebar {
    padding: 4px 10px 6px;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  .readout {
    display: flex;
    gap: 14px;
    font-size: 13px;
    align-items: baseline;
    color: var(--muted);
  }
  .readout strong,
  .readout .tot,
  .rampword {
    white-space: nowrap;
  }
  .readout strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .play {
    width: 28px;
    height: 22px;
    padding: 0;
    font-size: 11px;
  }
  .tot {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .guess {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .tot.over {
    color: var(--shoot);
    font-weight: 700;
  }
  svg {
    width: 100%;
    display: block;
    cursor: ew-resize;
    outline: none;
  }
  svg:focus-visible {
    outline: 2px solid var(--sel);
  }
  .seg {
    opacity: 0.95;
  }
  g.sel .seg {
    stroke: #fff;
    stroke-width: 2;
  }
  g.cut {
    opacity: 0.35;
  }
  .segtext {
    font-size: 11px;
    font-weight: 700;
    fill: #000;
  }
  .abort {
    stroke: var(--unsure);
    stroke-width: 2;
    stroke-dasharray: 4 3;
  }
  .abortText {
    font-size: 10px;
    fill: var(--unsure);
  }
  .end {
    stroke: #fff;
    stroke-width: 2;
  }
  .worst {
    stroke: #fff;
    stroke-opacity: 0.6;
    stroke-dasharray: 2 2;
  }
  .tick {
    font-size: 10px;
    fill: var(--muted);
  }
  .scrub {
    stroke: var(--sel);
    stroke-width: 2;
  }
  .scrubknob {
    fill: var(--sel);
  }
  .pseg {
    fill: var(--partner);
    fill-opacity: 0.55;
  }
  .pwait {
    fill: url(#tbhatch);
    stroke: var(--partner);
    stroke-opacity: 0.5;
  }
  .plabel {
    font-size: 9px;
    font-weight: 900;
    fill: var(--partner);
  }
  .segtext.small {
    font-size: 9px;
  }
  .band {
    fill: rgb(239 68 68 / 0.35);
    stroke: var(--shoot);
    stroke-width: 1;
  }
  .ramptrack {
    fill: #1b1d21;
  }
  .ramparea {
    fill: #a3e635;
    fill-opacity: 0.85;
    stroke: #a3e635;
    stroke-width: 1;
  }
  .ramparea.off {
    fill-opacity: 0.4;
    stroke-dasharray: 3 2;
  }
  .rampseg {
    fill: transparent;
  }
  .rampmove {
    stroke: #fff;
    stroke-opacity: 0.55;
    stroke-width: 1;
  }
  .ramplabel {
    fill: #a3e635;
  }
  .rampword {
    color: var(--muted);
  }
  .rampword.out {
    color: #a3e635;
    font-weight: 700;
  }
  .rampword.moving {
    color: var(--unsure);
    font-weight: 700;
  }
  .rampword.off {
    opacity: 0.75;
  }
  .band.near {
    fill: rgb(245 158 11 / 0.3);
    stroke: var(--unsure);
  }
</style>
