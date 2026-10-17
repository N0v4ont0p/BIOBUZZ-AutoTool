<script lang="ts">
  import type { Conflict } from "../../shared/compare.ts";
  import type { AutoFeatures } from "../../shared/features.ts";
  import { poseAtTime, rampOutAt, rampPolygon } from "../../shared/features.ts";
  import { DEG, footprint, toField as bodyToField } from "../../shared/geometry.ts";
  import type { RobotModel } from "../../shared/profile.ts";
  import type { SeasonPack } from "../../shared/season.ts";
  import type { AutoSpec } from "../../shared/spec.ts";
  import fieldImage from "../../../../public/fields/biobuzz.webp";
  import { annulus, carryStretch, chevrons, fromSvg, legLook, midpoint, pointsAttr, rectAttrs, svgAngle, sx, turnArc } from "../draw.ts";
  import { addLegAt, movePose, setHeading, splitLeg } from "../edit.ts";
  import { app } from "../state.svelte.ts";

  interface Props {
    spec: AutoSpec;
    features: AutoFeatures;
    before?: { spec: AutoSpec; features: AutoFeatures } | null; // shown faint under a proposal
    pack: SeasonPack;
    model: RobotModel;
    editable: boolean;
    // the alliance partner's auto, run together with ours
    partner?: { features: AutoFeatures; body: RobotModel["body"]; delayS: number; conflicts: Conflict[]; start: { x: number; y: number; headingDeg: number } | null } | null;
  }
  let { spec, features, before = null, pack, model, editable, partner = null }: Props = $props();

  let svg: SVGSVGElement | undefined = $state();
  const red = $derived(app.redView);
  const poseMap = $derived(new Map(spec.poses.map((p) => [p.name, p])));
  const robotAt = $derived(app.scrubT > 0 ? poseAtTime(features, app.scrubT) : null);
  const partnerAt = $derived(partner && app.scrubT > 0 ? poseAtTime(partner.features, app.scrubT - partner.delayS) : null);
  const pfp = (p: { x: number; y: number; headingDeg: number }) => pointsAttr(footprint(p, partner!.body), red);
  // the ramp, as far out as it is at the scrubber time (AutoRunner's commands at the measured out / in times)
  const rampNow = $derived(robotAt ? rampOutAt(features.ramp.moves, features.ramp, app.scrubT) : 0);
  const partnerRampNow = $derived(partner && partnerAt ? rampOutAt(partner.features.ramp.moves, partner.features.ramp, app.scrubT - partner.delayS) : 0);
  const rampPts = (p: { x: number; y: number; headingDeg: number }, out: number, m: RobotModel = model) => pointsAttr(rampPolygon(p, m, out), red);
  const marks = $derived(partner?.conflicts.filter((c) => c.kind === "collision" || c.kind === "nearMiss" || c.kind === "park" || (c.kind === "start" && c.gapIn !== Infinity)) ?? []);

  // drag state
  let drag: { kind: "pose" | "heading"; name: string } | null = $state(null);
  let raf = 0;
  let pendingMove: PointerEvent | null = null;

  function svgPoint(e: PointerEvent | MouseEvent) {
    const pt = svg!.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = svg!.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return fromSvg(p.x, p.y, red);
  }

  function startDrag(e: PointerEvent, kind: "pose" | "heading", name: string) {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag = { kind, name };
    app.selectedPose = name;
    app.beginDrag();
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    pendingMove = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev = pendingMove;
      if (!ev || !drag || !app.spec) return;
      const p = svgPoint(ev);
      const cur = app.snapshot();
      if (drag.kind === "pose") app.live(movePose(cur, drag.name, p.x, p.y, ev.altKey));
      else {
        const pose = cur.poses.find((q) => q.name === drag!.name);
        if (pose && pose.x !== null && pose.y !== null) app.live(setHeading(cur, drag.name, Math.atan2(p.y - pose.y, p.x - pose.x) / DEG, ev.shiftKey));
      }
    });
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    app.endDrag();
  }

  function onFieldClick(e: MouseEvent) {
    if (!editable || !app.spec) return;
    if (app.mode === "add") {
      const p = svgPoint(e);
      app.change(addLegAt(app.snapshot(), p.x, p.y, app.selected));
      const legs = app.spec.legs;
      app.selected = legs[Math.min(legs.length - 1, (app.selected ? legs.findIndex((l) => l.id === app.selected) : legs.length - 2) + 1)]?.id ?? null;
      return;
    }
    app.selected = null;
    app.selectedPose = null;
  }

  function onLegDblClick(e: MouseEvent, legId: string) {
    if (!editable || !app.spec) return;
    e.stopPropagation();
    const p = svgPoint(e);
    app.change(splitLeg(app.snapshot(), legId, p.x, p.y));
  }

  function selectLeg(e: MouseEvent, id: string) {
    e.stopPropagation();
    if (app.mode === "add") return onFieldClick(e);
    app.selected = id;
  }

  // the curve being edited (selected, or one of its control points dragged / selected): the other legs go gray so it
  // and its control points stand out; the partner's route keeps its own colour
  const focusLeg = $derived.by(() => {
    if (!editable) return null;
    const pose = drag?.kind === "pose" ? drag.name : app.selectedPose;
    const byControl = pose ? spec.legs.find((l) => l.path.type === "curve" && l.path.controls.includes(pose)) : undefined;
    if (byControl) return byControl.id;
    const sel = spec.legs.find((l) => l.id === app.selected);
    return sel && sel.path.type === "curve" ? sel.id : null;
  });

  const lookColor: Record<string, string> = { drive: "var(--drive)", intake: "var(--drive)", ramp: "var(--drive)", reposition: "var(--repo)", unsure: "var(--unsure)" };

  function fp(x: number, y: number, h: number) {
    return pointsAttr(footprint({ x, y, headingDeg: h }, model.body), red);
  }
  function arrowPts(x: number, y: number, h: number, len: number) {
    const tip = bodyToField({ x, y, headingDeg: h }, len, 0);
    const l = bodyToField({ x, y, headingDeg: h }, len - 2.2, 1.4);
    const r = bodyToField({ x, y, headingDeg: h }, len - 2.2, -1.4);
    return pointsAttr([l, tip, r], red);
  }
  function knob(x: number, y: number, h: number) {
    return sx(bodyToField({ x, y, headingDeg: h }, model.body.front + 4, 0).x, bodyToField({ x, y, headingDeg: h }, model.body.front + 4, 0).y, red);
  }
  const lz = $derived(rectAttrs(pack.loadingZone.BLUE, red));
  const st = $derived(poseMap.get(spec.start));
  const cells = $derived([pack.cells.BLUE.far, pack.cells.BLUE.audience].map((c, i) => ({ ...c, half: i === 0 ? "far" : "audience" })));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (a drawing canvas; the keyboard works through the global shortcuts) -->
<svg
  bind:this={svg}
  class="field"
  class:adding={app.mode === "add"}
  viewBox="-3 -3 150 150"
  role="application"
  aria-label="Field: route editor"
  onpointermove={onMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onclick={onFieldClick}
>
  <defs>
    <pattern id="hatch" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="2" stroke="var(--nogo)" stroke-width="0.7" />
    </pattern>
    <pattern id="zonehatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
      <line x1="0" y1="0" x2="0" y2="3" stroke="var(--zone)" stroke-width="0.35" />
    </pattern>
    <clipPath id="farHalf"><rect x={red ? 0 : 72} y="0" width="72" height="72" /></clipPath>
    <clipPath id="audHalf"><rect x={red ? 0 : 72} y="72" width="72" height="72" /></clipPath>
    <marker id="arrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#fff" /></marker>
  </defs>

  <!-- the field never turns: as red, the route moves to the red side (reflected through the centre) -->
  <image href={fieldImage} x="0" y="0" width="144" height="144" opacity="0.92" />
  <rect x="0" y="0" width="144" height="144" fill="none" stroke="#000" stroke-width="0.6" />
  <!-- alliance line (G402) -->
  <line x1="72" y1="0" x2="72" y2="144" stroke="var(--mid)" stroke-width="0.35" stroke-dasharray="2 2" />

  {#if app.showZones}
    {#each cells as c}
      <path d={annulus(c.x, c.y, model.shotMinIn, model.shotMaxIn, red)} fill="url(#zonehatch)" fill-rule="evenodd" clip-path={c.half === "far" ? "url(#farHalf)" : "url(#audHalf)"} opacity="0.75" />
    {/each}
  {/if}
  {#each cells as c}
    {@const p = sx(c.x, c.y, red)}
    <g class="cell"><circle cx={p.x} cy={p.y} r="2.2" /><line x1={p.x - 2.2} y1={p.y} x2={p.x + 2.2} y2={p.y} /><line x1={p.x} y1={p.y - 2.2} x2={p.x} y2={p.y + 2.2} /></g>
  {/each}

  {#each pack.obstacles as o}
    <rect {...rectAttrs(o.rect, red)} fill="url(#hatch)" stroke="var(--nogo)" stroke-width="0.3"><title>{o.name}: no-go</title></rect>
  {/each}
  <rect {...lz} fill="none" stroke="var(--lz)" stroke-width="0.6" stroke-dasharray="1.6 1" />
  <text x={lz.x + lz.width / 2} y={lz.y + lz.height / 2} class="lztext" text-anchor="middle" dominant-baseline="middle">PARK</text>

  {#if app.showElements}
    {#each features.elementsLeft.concat([]) as e}
      {@const p = sx(e.x, e.y, red)}
      <g class="element" class:unconfirmed={e.unconfirmed}>
        <circle cx={p.x} cy={p.y} r={e.count ? 2.1 : 1.4} />
        {#if e.count}<text x={p.x} y={p.y} text-anchor="middle" dominant-baseline="central">{e.count}</text>{/if}
        <title>{e.where} ({e.type}){e.access === "flowerBottom" ? ": only with the ramp (not in AutoRunner)" : ""}</title>
      </g>
    {/each}
    {#each features.legs.flatMap((l) => l.picked) as pk}
      {@const e = pack.staged.find((s) => s.id === pk.id)}
      {#if e}
        {@const p = sx(e.x, e.y, red)}
        <circle class="picked" cx={p.x} cy={p.y} r="1.4"><title>{e.where}: picked at {pk.atS} s</title></circle>
      {/if}
    {/each}
  {/if}

  <!-- the route before a proposal, faint -->
  {#if before}
    {#each before.features.geometry as g}
      {#if g.drawable}<polyline points={pointsAttr(g.samples, red)} class="before" />{/if}
    {/each}
  {/if}

  <!-- legs -->
  <!-- the alliance partner: its route, start, and where the two robots meet -->
  {#if partner}
    {#each partner.features.geometry as g}
      {#if g.drawable}<polyline points={pointsAttr(g.samples, red)} class="pleg" />{/if}
    {/each}
    {#each partner.features.junctions as j}
      {@const p = sx(j.pose.x, j.pose.y, red)}
      <polygon points={pfp(j.pose)} class="pstop" /><circle cx={p.x} cy={p.y} r="1.3" class="pdot" />
    {/each}
    {#if partner.start}
      {@const ps = sx(partner.start.x, partner.start.y, red)}
      <polygon points={pfp(partner.start)} class="pstop start" /><text x={ps.x} y={ps.y + 0.1} class="ptext" text-anchor="middle" dominant-baseline="central">P</text>
    {/if}
  {/if}

  {#each features.geometry as g, i}
    {#if g.drawable}
      {@const leg = spec.legs[i]}
      {@const lf = features.legs[i]}
      {@const look = legLook(leg)}
      {@const pts = pointsAttr(g.samples, red)}
      <g class="legg" class:dim={focusLeg !== null && focusLeg !== leg.id}>{#if g.drawable}
      {#if leg.during !== "NONE"}
        <polyline points={pts} class="intakeband" class:ramp={leg.during === "RAMP"}><title>{leg.during === "RAMP" ? "intake + ramp out" : "intake on"} the whole leg</title></polyline>
        {#each chevrons(g.samples, red) as c}
          <path d="M -1.1 -1.3 L 0.4 0 L -1.1 1.3" transform={`translate(${c.x} ${c.y}) rotate(${c.rot})`} class="chev" />
        {/each}
      {/if}
      {#if leg.carryIntakeS > 0 && features.geometry[i + 1]?.drawable}
        {@const carry = carryStretch(features.geometry[i + 1].samples, leg.carryIntakeS)}
        {#if carry.length > 1}<polyline points={pointsAttr(carry, red)} class="intakeband carry"><title>intake carries {leg.carryIntakeS} s into the next leg</title></polyline>{/if}
      {/if}
      <polyline
        points={pts}
        class="leg {look}"
        class:selected={app.selected === leg.id}
        class:cut={lf?.cut === "never"}
        stroke={lookColor[look]}
      />
      <polyline points={pts} class="hit" role="button" tabindex="-1" aria-label={`leg ${leg.id}`} onclick={(e) => selectLeg(e, leg.id)} ondblclick={(e) => onLegDblClick(e, leg.id)} onkeydown={() => {}} />
      {@const mid = midpoint(g.samples)}
      {#if mid && g.length > 3}
        {@const mp = sx(mid.x, mid.y, red)}
        <path d="M -1.3 -1.2 L 1.2 0 L -1.3 1.2 z" transform={`translate(${mp.x} ${mp.y}) rotate(${svgAngle(mid.tangentDeg, red)})`} class="dir" fill={lookColor[look]} />
        {#if g.length > 10}<text class="leglabel" x={mp.x} y={mp.y - 2.4} text-anchor="middle">{leg.id} · {lf?.travelS.toFixed(1)} s</text>{/if}
      {/if}
      {#if g.approx}
        <text class="note" x={sx(g.samples[0].x, g.samples[0].y, red).x} y={sx(g.samples[0].x, g.samples[0].y, red).y + 3}>approx. curve</text>
      {/if}
      <!-- curve controls -->
      {#if leg.path.type === "curve" && editable}
        <!-- the control polygon, as in Pedro: start, each control point in order, end -->
        {@const hull = [leg.path.from, ...leg.path.controls, leg.path.to].map((n) => poseMap.get(n))}
        {#if hull.every((q) => q && q.x !== null && q.y !== null)}
          <polyline points={hull.map((q) => { const v = sx(q!.x!, q!.y!, red); return `${v.x},${v.y}`; }).join(" ")} class="ctrlline" fill="none" />
        {/if}
        {#each leg.path.controls as cn, ci}
          {@const c = poseMap.get(cn)}
          {#if c && c.x !== null && c.y !== null}
            {@const cp = sx(c.x, c.y, red)}
            {#if leg.path.controls.length > 1}<text class="ctrlnum" x={cp.x + 1.8} y={cp.y - 1.4}>{ci + 1}</text>{/if}
            <rect x={cp.x - 1.2} y={cp.y - 1.2} width="2.4" height="2.4" transform={`rotate(45 ${cp.x} ${cp.y})`} class="ctrl" role="button" tabindex="-1" aria-label={`control ${cn}`} onpointerdown={(e) => startDrag(e, "pose", cn)} />
          {/if}
        {/each}
      {/if}
      {/if}</g>
    {/if}
  {/each}

  <!-- stops -->
  {#each features.junctions as j}
    {@const leg = spec.legs[j.index]}
    {@const p = sx(j.pose.x, j.pose.y, red)}
    <g class="stop" class:selected={app.selected === j.id}>
      <polygon points={fp(j.pose.x, j.pose.y, j.pose.headingDeg)} class="footprint" />
      {#if leg.during === "RAMP"}
        {@const lr = features.legs[j.index]?.ramp}
        {#if lr}
          <g class="rampstop" class:late={lr.late.length > 0 || lr.outAtS === null} class:off={!features.ramp.calibrated}>
            <polygon points={rampPts(j.pose, 1)} class="rampreach" />
            {#if lr.atArrival > 0.02}<polygon points={rampPts(j.pose, lr.atArrival)} class="rampfill" />{/if}
            <title>ramp {Math.round(lr.atArrival * 100)}% out on arrival{lr.outAtS !== null ? `, fully out at ${lr.outAtS} s` : ", never fully out on this leg"}{lr.late.length ? `; reaches ${lr.late.join(", ")} before it is out` : ""}{features.ramp.calibrated ? "" : " (ramp times not measured in the robot code yet: the robot keeps it stowed)"}</title>
          </g>
        {/if}
      {/if}
      <polyline points={arrowPts(j.pose.x, j.pose.y, j.pose.headingDeg, model.body.front)} class="heading" />
      {#if j.turnDeg !== null && Math.abs(j.turnDeg) >= model.sharpTurnDeg}
        <path d={turnArc(j.pose.x, j.pose.y, features.geometry[j.index].samples.at(-1)?.tangentDeg ?? 0, j.turnDeg, 5.5, red)} class="turnarc" marker-end="url(#arrow)"><title>sharp turn {j.turnDeg.toFixed(0)}°</title></path>
      {/if}
      {#if leg.junction.review}
        <circle cx={p.x} cy={p.y} r="2.4" class="unsurestop" /><text x={p.x} y={p.y + 0.1} class="unsuretext" text-anchor="middle" dominant-baseline="central">?</text>
      {:else if leg.end === "SHOOT"}
        {@const cp = sx(j.target.x, j.target.y, red)}
        <!-- each turret aims on its own: a dashed amber line is a turret that cannot reach (its gate stays shut) -->
        {#each [[model.frontPivot, j.target.frontReachable, "front"], [model.backPivot, j.target.backReachable, "back"]] as const as [pivot, ok, side]}
          {@const pv = bodyToField({ x: j.pose.x, y: j.pose.y, headingDeg: j.pose.headingDeg }, pivot.x, pivot.y)}
          {@const pp = sx(pv.x, pv.y, red)}
          <line x1={pp.x} y1={pp.y} x2={cp.x} y2={cp.y} class="aim" class:bad={!ok}><title>{side} turret {Math.round(side === "front" ? j.target.frontYawDeg : j.target.backYawDeg)}°{ok ? "" : ": cannot reach, does not fire"}</title></line>
        {/each}
        <circle cx={p.x} cy={p.y} r="5.2" class="zonering" class:out={!j.zone.in} />
        <circle cx={p.x} cy={p.y} r="3" class="target" /><circle cx={p.x} cy={p.y} r="1.6" class="target" /><circle cx={p.x} cy={p.y} r="0.5" class="targetdot" />
        <text x={p.x + 3.6} y={p.y - 3.2} class="fired">−{j.inventory.fired}</text>
        {#if !j.zone.in}<text x={p.x} y={p.y + 8.2} class="warn" text-anchor="middle">OUT OF ZONE</text>{/if}
      {:else if leg.end === "PARK"}
        <rect x={p.x - 2.4} y={p.y - 2.4} width="4.8" height="4.8" class="park" /><text x={p.x} y={p.y + 0.1} class="parktext" text-anchor="middle" dominant-baseline="central">P</text>
      {:else if leg.end === "WAIT"}
        <circle cx={p.x} cy={p.y} r="2.3" class="settle" /><path d={`M ${p.x} ${p.y} L ${p.x} ${p.y - 1.5} M ${p.x} ${p.y} L ${p.x + 1.1} ${p.y}`} class="clock" /><text x={p.x + 3.6} y={p.y - 3.2} class="fired">{leg.waitS ?? 0} s</text>
      {:else if leg.during !== "NONE"}
        <circle cx={p.x} cy={p.y} r="2" class="intakestop" /><text x={p.x} y={p.y + 0.1} class="intext" text-anchor="middle" dominant-baseline="central">{leg.during === "RAMP" ? "R" : "IN"}</text>
      {:else}
        <circle cx={p.x} cy={p.y} r="1.6" class="repostop" />
      {/if}
      <g transform={`translate(${p.x + 3.4} ${p.y + 2.6})`} class="badge"><rect x="0" y="-1.8" width="11" height="3.6" rx="1.2" /><text x="5.5" y="0" text-anchor="middle" dominant-baseline="central">holding {j.inventory.after}</text></g>
    </g>
  {/each}

  <!-- start -->
  {#if st && st.x !== null && st.y !== null && st.headingDeg !== null}
    <polygon points={fp(st.x, st.y, st.headingDeg)} class="footprint start" />
    <polyline points={arrowPts(st.x, st.y, st.headingDeg, model.body.front)} class="heading" />
    <text x={sx(st.x, st.y, red).x} y={sx(st.x, st.y, red).y + 0.1} class="starttext" text-anchor="middle" dominant-baseline="central">S</text>
    <g transform={`translate(${sx(st.x, st.y, red).x + 3.4} ${sx(st.x, st.y, red).y + 2.6})`} class="badge"><rect x="0" y="-1.8" width="11" height="3.6" rx="1.2" /><text x="5.5" y="0" text-anchor="middle" dominant-baseline="central">holding {spec.preload.POLLEN - spec.preload.onTiles}</text></g>
  {/if}

  <!-- handles -->
  {#if editable}
    {#each spec.poses.filter((q) => q.role === "waypoint") as q}
      {#if q.x !== null && q.y !== null && q.headingDeg !== null}
        {@const p = sx(q.x, q.y, red)}
        {@const k = knob(q.x, q.y, q.headingDeg)}
        <line x1={p.x} y1={p.y} x2={k.x} y2={k.y} class="knobline" />
        <circle cx={k.x} cy={k.y} r="1.2" class="knob" role="button" tabindex="-1" aria-label={`turn ${q.name}`} onpointerdown={(e) => startDrag(e, "heading", q.name)}><title>{q.name}: drag to turn ({q.headingDeg.toFixed(0)}°, Shift = 15° steps)</title></circle>
        <circle cx={p.x} cy={p.y} r="3.7" class="handle" class:sel={app.selectedPose === q.name} role="button" tabindex="-1" aria-label={`move ${q.name}`} onpointerdown={(e) => startDrag(e, "pose", q.name)}><title>{q.name} ({q.x}, {q.y}) · Alt = 0.1 in steps</title></circle>
      {/if}
    {/each}
  {/if}

  {#each marks as c}
    {@const m = sx(c.at.x, c.at.y, red)}
    <g class="clash" class:near={c.kind === "nearMiss"} role="button" tabindex="-1" aria-label={c.text} onclick={(e) => (e.stopPropagation(), (app.scrubT = c.t))} onkeydown={() => {}}>
      <circle cx={m.x} cy={m.y} r="4" /><path d={`M ${m.x - 2} ${m.y - 2} L ${m.x + 2} ${m.y + 2} M ${m.x - 2} ${m.y + 2} L ${m.x + 2} ${m.y - 2}`} />
      <title>{c.text}</title>
    </g>
  {/each}
  {#if partnerAt}
    {#if partnerRampNow > 0.02}<polygon points={rampPts(partnerAt, partnerRampNow, { ...model, body: partner!.body })} class="rampghost partner" />{/if}
    <polygon points={pfp(partnerAt)} class="ghost partner" />
    <polyline points={arrowPts(partnerAt.x, partnerAt.y, partnerAt.headingDeg, partner!.body.front)} class="heading ghostarrow partner" />
  {/if}

  <!-- scrubber robot -->
  {#if robotAt}
    {#if rampNow > 0.02}<polygon points={rampPts(robotAt, rampNow)} class="rampghost" class:moving={rampNow < 0.999} class:off={!features.ramp.calibrated}><title>ramp {rampNow >= 0.999 ? "out" : `${Math.round(rampNow * 100)}% out`}</title></polygon>{/if}
    <polygon points={fp(robotAt.x, robotAt.y, robotAt.headingDeg)} class="ghost" />
    <polyline points={arrowPts(robotAt.x, robotAt.y, robotAt.headingDeg, model.body.front)} class="heading ghostarrow" />
  {/if}
</svg>

<style>
  .field {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    user-select: none;
    background: #000;
  }
  .field.adding {
    cursor: crosshair;
  }
  /* editing one curve: every other leg of ours (line, intake band, arrows, label, control points) goes gray */
  .legg.dim {
    filter: grayscale(1);
    opacity: 0.28;
  }
  .field :global(*:focus) {
    outline: none;
  }
  /* only the leg hit lines and the handles take the pointer; everything drawn is click-through */
  .field :global(:is(image, .cell, .element, .picked, .before, .leg, .intakeband, .chev, .dir, .leglabel, .note, .ctrlline, .ctrlnum, .stop, .footprint, .heading, .badge, .starttext, .knobline, .ghost, .ghostarrow, .rampghost, .lztext)) {
    pointer-events: none;
  }
  .cell circle {
    fill: none;
    stroke: var(--cell);
    stroke-width: 0.5;
  }
  .cell line {
    stroke: var(--cell);
    stroke-width: 0.4;
  }
  .lztext {
    fill: var(--lz);
    font-size: 2.6px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }
  .element circle {
    fill: var(--pollen);
    stroke: #000;
    stroke-width: 0.35;
  }
  .element text {
    font-size: 2.2px;
    font-weight: 800;
    fill: #000;
  }
  .element.unconfirmed circle {
    stroke-dasharray: 0.6 0.4;
    fill-opacity: 0.5;
  }
  .picked {
    fill: none;
    stroke: var(--pollen);
    stroke-width: 0.35;
    stroke-dasharray: 0.5 0.5;
  }
  .before {
    fill: none;
    stroke: #fff;
    stroke-opacity: 0.45;
    stroke-width: 0.5;
    stroke-dasharray: 1 1;
  }
  .leg {
    fill: none;
    stroke-width: 0.7;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .leg.reposition {
    stroke-dasharray: 2.2 1.4;
    stroke-width: 0.9;
  }
  .leg.unsure {
    stroke-dasharray: 1.6 1;
    stroke-width: 0.9;
  }
  .leg.selected {
    stroke-width: 1.4;
    filter: drop-shadow(0 0 0.8px #fff);
  }
  .leg.cut {
    stroke-opacity: 0.35;
  }
  .dir {
    stroke: #000;
    stroke-width: 0.25;
  }
  .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 4;
    cursor: pointer;
    pointer-events: stroke;
  }
  .intakeband {
    fill: none;
    stroke: var(--intake);
    stroke-opacity: 0.55;
    stroke-width: 4.2;
    stroke-linecap: round;
  }
  .intakeband.ramp {
    stroke: #a3e635;
    stroke-dasharray: 3 1;
  }
  .intakeband.carry {
    stroke-opacity: 0.3;
    stroke-dasharray: 1.4 0.8;
  }
  .chev {
    fill: none;
    stroke: #04220f;
    stroke-width: 0.55;
  }
  .leglabel {
    font-size: 2.3px;
    fill: #fff;
    paint-order: stroke;
    stroke: #000;
    stroke-width: 0.7px;
    font-weight: 600;
  }
  .note {
    font-size: 1.8px;
    fill: var(--unsure);
  }
  .ctrlline {
    stroke: #fff;
    stroke-opacity: 0.5;
    stroke-width: 0.25;
    stroke-dasharray: 0.6 0.6;
  }
  .ctrlnum {
    font-size: 2.6px;
    fill: var(--muted);
  }
  .ctrl {
    fill: #000;
    stroke: #fff;
    stroke-width: 0.35;
    cursor: grab;
  }
  .footprint {
    fill: none;
    stroke: #fff;
    stroke-opacity: 0.7;
    stroke-width: 0.3;
  }
  .footprint.start {
    stroke-dasharray: 0.8 0.5;
  }
  .heading {
    fill: none;
    stroke: #fff;
    stroke-width: 0.45;
  }
  .turnarc {
    fill: none;
    stroke: #fff;
    stroke-width: 0.35;
  }
  .aim {
    stroke: var(--shoot);
    stroke-width: 0.35;
    stroke-dasharray: 1 0.6;
  }
  .aim.bad {
    stroke: var(--unsure);
  }
  .zonering {
    fill: none;
    stroke: var(--zone);
    stroke-width: 0.35;
  }
  .zonering.out {
    stroke: var(--shoot);
    stroke-dasharray: 0.8 0.6;
  }
  .target {
    fill: none;
    stroke: var(--shoot);
    stroke-width: 0.55;
  }
  .targetdot {
    fill: var(--shoot);
  }
  .fired {
    font-size: 2.8px;
    font-weight: 800;
    fill: var(--shoot);
    paint-order: stroke;
    stroke: #000;
    stroke-width: 0.6px;
  }
  .warn {
    font-size: 2px;
    font-weight: 800;
    fill: var(--unsure);
    paint-order: stroke;
    stroke: #000;
    stroke-width: 0.6px;
  }
  .park {
    fill: #fff;
    stroke: #000;
    stroke-width: 0.3;
  }
  .parktext {
    font-size: 3.4px;
    font-weight: 900;
    fill: #000;
  }
  .settle {
    fill: #111;
    stroke: #fff;
    stroke-width: 0.45;
  }
  .clock {
    stroke: #fff;
    stroke-width: 0.35;
    fill: none;
  }
  .intakestop {
    fill: var(--intake);
    stroke: #000;
    stroke-width: 0.3;
  }
  .intext {
    font-size: 1.7px;
    font-weight: 900;
    fill: #04220f;
  }
  .repostop {
    fill: var(--repo);
    stroke: #000;
    stroke-width: 0.3;
  }
  .unsurestop {
    fill: var(--unsure);
    stroke: #000;
    stroke-width: 0.3;
  }
  .unsuretext {
    font-size: 3px;
    font-weight: 900;
    fill: #000;
  }
  .starttext {
    font-size: 2.6px;
    font-weight: 900;
    fill: #fff;
    paint-order: stroke;
    stroke: #000;
    stroke-width: 0.6px;
  }
  .badge rect {
    fill: #000;
    fill-opacity: 0.8;
    stroke: #fff;
    stroke-opacity: 0.5;
    stroke-width: 0.2;
  }
  .badge text {
    font-size: 2px;
    fill: #fff;
    font-weight: 600;
  }
  .stop.selected .footprint {
    stroke: var(--sel);
    stroke-opacity: 1;
    stroke-width: 0.5;
  }
  /* a hollow ring: the stop's own marker stays visible inside it; the whole disc still takes the pointer */
  .handle {
    fill: transparent;
    stroke: #fff;
    stroke-opacity: 0.7;
    stroke-width: 0.35;
    cursor: grab;
    pointer-events: all;
    paint-order: stroke;
  }
  .handle:hover {
    stroke: var(--sel);
  }
  .handle.sel {
    stroke: var(--sel);
    stroke-opacity: 1;
    stroke-width: 0.7;
  }
  .knobline {
    stroke: #fff;
    stroke-opacity: 0.4;
    stroke-width: 0.2;
  }
  .knob {
    fill: #000;
    stroke: #fff;
    stroke-width: 0.35;
    cursor: crosshair;
  }
  .ghost {
    fill: var(--sel);
    fill-opacity: 0.22;
    stroke: var(--sel);
    stroke-width: 0.45;
  }
  .ghostarrow {
    stroke: var(--sel);
  }
  .rampghost {
    fill: #a3e635;
    fill-opacity: 0.75;
    stroke: #ecfccb;
    stroke-width: 0.35;
  }
  .rampghost.moving {
    fill-opacity: 0.45;
    stroke-dasharray: 0.8 0.6;
  }
  .rampghost.off {
    fill: #8b8f97;
  }
  .rampghost.partner {
    fill: var(--partner);
    stroke: var(--partner);
  }
  .rampreach {
    fill: none;
    stroke: #a3e635;
    stroke-width: 0.3;
    stroke-dasharray: 0.8 0.6;
    stroke-opacity: 0.9;
  }
  .rampfill {
    fill: #a3e635;
    fill-opacity: 0.6;
    stroke: none;
  }
  .rampstop.late .rampreach {
    stroke: var(--unsure);
  }
  .rampstop.late .rampfill {
    fill: var(--unsure);
  }
  .rampstop.off .rampfill {
    fill: #8b8f97;
  }
  .ghost.partner {
    fill: var(--partner);
    stroke: var(--partner);
  }
  .ghostarrow.partner {
    stroke: var(--partner);
  }
  .pleg {
    fill: none;
    stroke: var(--partner);
    stroke-width: 0.9;
    stroke-dasharray: 2.2 1.4;
    stroke-linecap: round;
    pointer-events: none;
  }
  .pstop {
    fill: var(--partner);
    fill-opacity: 0.08;
    stroke: var(--partner);
    stroke-width: 0.3;
    stroke-dasharray: 1 0.8;
    pointer-events: none;
  }
  .pstop.start {
    fill-opacity: 0.18;
  }
  .pdot {
    fill: var(--partner);
    pointer-events: none;
  }
  .ptext {
    font-size: 3.6px;
    font-weight: 900;
    fill: var(--partner);
    pointer-events: none;
  }
  .clash {
    cursor: pointer;
  }
  .clash circle {
    fill: rgb(239 68 68 / 0.25);
    stroke: var(--shoot);
    stroke-width: 0.6;
  }
  .clash path {
    stroke: #fff;
    stroke-width: 0.7;
  }
  .clash.near circle {
    fill: rgb(245 158 11 / 0.22);
    stroke: var(--unsure);
  }
</style>
