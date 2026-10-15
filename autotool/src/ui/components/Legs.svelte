<script lang="ts">
  // The route as a list of legs, each exactly the robot code's AutoRunner.Leg: a path, what the robot does
  // while driving it, what it does at the end, and options. Click a leg to open it here; click it again
  // (or Esc, or the empty field) to close it.
  import type { AutoFeatures } from "../../shared/features.ts";
  import { relevantVars } from "../../shared/java/reader.ts";
  import { applyPatch } from "../../shared/patch.ts";
  import type { RobotModel } from "../../shared/profile.ts";
  import { type AutoSpec, type During, type End, type HeadingDef, type Leg, stopText } from "../../shared/spec.ts";
  import { autoPoints } from "../../shared/points.ts";
  import { decideStop, legKey, stopKey } from "../../shared/stops.ts";
  import { api } from "../api.ts";
  import { evidenceLine } from "../draw.ts";
  import { addControl, appendStop, insertStopBefore, moveStop, placePose, removeControl, renamePose, setOption, setStop, straighten } from "../edit.ts";
  import { app } from "../state.svelte.ts";

  let { spec, features, model, proposed = null }: { spec: AutoSpec; features: AutoFeatures; model: RobotModel; proposed?: AutoSpec | null } = $props();

  const ENDS: { v: End; label: string; hint: string }[] = [
    { v: "NONE", label: "Go on", hint: "drive straight into the next leg" },
    { v: "SHOOT", label: "Shoot", hint: "hold, wait until still + aimed + at speed, fire" },
    { v: "WAIT", label: "Wait", hint: "hold still; the intake and ramp keep doing what they did while driving" },
    { v: "PARK", label: "Park", hint: "hold here and end the auto" },
  ];

  let startOpen = $state(false);
  let renameTo = $state("");
  let wrongFor = $state<string | null>(null);
  let wrongDuring = $state<During>("NONE");
  let wrongEnd = $state<End>("NONE");
  let wrongNote = $state("");
  let dragFrom = $state<number | null>(null);
  let dropAt = $state<string | null>(null);
  const MIME = "application/x-autotool-leg";

  const pts = $derived(app.pack && features.drawable ? autoPoints(app.pack, features) : null);
  const st = $derived(spec.poses.find((p) => p.name === spec.start));
  const unresolved = $derived(spec.poses.filter((p) => p.x === null || p.y === null || p.headingDeg === null));
  const placeable = (p: (typeof spec.poses)[number]) => !p.formula || [p.formula.x, p.formula.y].every((f) => relevantVars(f, spec.assume ?? {}).length <= 1);

  function edit(fn: (s: AutoSpec) => AutoSpec) {
    app.change(fn(app.snapshot()));
  }
  function num(v: string): number | null {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? null : n;
  }
  function toggle(id: string) {
    app.selected = app.selected === id ? null : id;
    renameTo = "";
    wrongFor = null;
  }

  // ---- while driving: the intake, and the ramp on top of it ----
  function setIntake(leg: Leg, on: boolean) {
    edit((s) => setStop(s, leg.id, on ? (leg.during === "NONE" ? "INTAKE" : leg.during) : "NONE", leg.end));
  }
  function setRamp(leg: Leg, on: boolean) {
    edit((s) => setStop(s, leg.id, on ? "RAMP" : leg.during === "RAMP" ? "INTAKE" : leg.during, leg.end));
  }
  // the ramp on a leg, in words, and the wait a RAMP leg needs for the ramp to be fully out before it moves on
  function rampLine(leg: Leg, lf: AutoFeatures["legs"][number]): { text: string; bad: boolean; needWaitS: number | null } | null {
    const r = lf.ramp;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    if (leg.during !== "RAMP") return r.maxOut > 0.02 ? { text: `folding in: ${pct(r.atStart)} out when this leg starts`, bad: false, needWaitS: null } : null;
    const swing = features.ramp.travelS;
    const head = `comes out at the leg start (${swing} s swing): ${pct(r.atArrival)} out on arrival`;
    if (r.late.length || r.outAtS === null) {
      const need = Math.ceil((1 - r.atArrival) * swing * 10) / 10;
      const canWait = leg.end === "NONE" || leg.end === "WAIT";
      return {
        text: `${head}, ${r.outAtS === null ? "never fully out on this leg" : `fully out at ${r.outAtS} s`}${r.late.length ? `; reaches ${r.late.join(", ")} before it is out` : ""}${canWait ? "" : " (the shot folds it in on arrival)"}`,
        bad: true,
        needWaitS: canWait && need > (leg.end === "WAIT" ? (leg.waitS ?? 0) : 0) ? need : null,
      };
    }
    return { text: `${head}, fully out at ${r.outAtS} s`, bad: false, needWaitS: null };
  }
  function waitForRamp(leg: Leg, s: number) {
    edit((sp) => setOption(setStop(sp, leg.id, leg.during, "WAIT"), leg.id, "waitS", s));
  }
  function setEnd(leg: Leg, end: End) {
    edit((s) => setStop(s, leg.id, leg.during, end));
  }

  // ---- the stop's pose, shape and heading ----
  const flip = (k: "x" | "y" | "headingDeg", v: number) => (k === "headingDeg" ? ((((v + 180 + 180) % 360) + 360) % 360) - 180 : 144 - v);
  function disp(p: { x: number | null; y: number | null; headingDeg: number | null }, k: "x" | "y" | "headingDeg"): number | "" {
    const v = p[k];
    if (v === null) return "";
    return app.redView ? Math.round(flip(k, v) * 100) / 100 : v;
  }
  function setPoseField(name: string, k: "x" | "y" | "headingDeg", v: string) {
    const typed = num(v);
    if (typed === null) return;
    const n = app.redView ? Math.round(flip(k, typed) * 100) / 100 : typed;
    edit((s) => ({
      ...s,
      poses: s.poses.map((p) => {
        if (p.name !== name) return p;
        const q = { ...p, [k]: k === "headingDeg" ? n : Math.max(0, Math.min(144, n)) };
        const ek = k === "headingDeg" ? "h" : k;
        if (q.expr?.[ek]) {
          const e = { ...q.expr };
          delete e[ek];
          q.expr = Object.keys(e).length ? e : undefined;
        }
        return q;
      }),
    }));
  }
  function setHeadingMode(leg: Leg, mode: string) {
    if (leg.path.type === "toPoint") return;
    const { from, to } = leg.path;
    const h: HeadingDef = mode === "linear" ? { mode: "linear", from, to } : mode === "constant" ? { mode: "constant", pose: from } : mode === "tangent" ? { mode: "tangent" } : { mode: "reverseTangent" };
    edit((s) => ({ ...s, legs: s.legs.map((l) => (l.id === leg.id ? { ...l, heading: h } : l)) }));
  }
  function rename(from: string) {
    if (!renameTo.trim()) return;
    const r = renamePose(app.snapshot(), from, renameTo.trim());
    if (typeof r === "string") return app.flash(r, "warn");
    app.change(r);
    renameTo = "";
  }
  function remove(leg: Leg) {
    const r = applyPatch(app.snapshot(), { summary: "", junctions: [], ops: [{ op: "delete_leg", leg: leg.id }], claims: [] }, "user");
    if (r.errors.length) return app.flash(r.errors.join("; "), "warn");
    app.change(r.spec);
    app.selected = null;
  }
  function place(name: string) {
    const isStart = name === spec.start;
    const isLastStop = spec.legs.at(-1)?.path.to === name;
    const d = isStart ? { x: 135, y: 72, h: 180 } : isLastStop ? { x: 128, y: 36, h: 180 } : { x: 110, y: 72, h: 180 };
    if (spec.poses.find((p) => p.name === name)?.formula) {
      api<{ spec: AutoSpec; solved: string[] }>("POST", "/api/autos/assume", { name: spec.name, pose: name, x: d.x, y: d.y, h: d.h })
        .then((r) => {
          app.change(r.spec);
          app.flash(`Placed ${name} (${r.solved.join(", ")}): drag it where it belongs. The robot code still has these unset; AutoTool only assumes them.`, "warn");
        })
        .catch((e) => app.flash((e as Error).message, "warn"));
      return;
    }
    edit((s) => placePose(s, name, d.x, d.y, d.h));
  }

  // ---- adding and moving legs ----
  function addAt(k: number) {
    const snap = app.snapshot();
    const r = k < snap.legs.length ? insertStopBefore(snap, snap.legs[k].id) : appendStop(snap);
    if (!r) return app.flash("Place the poses first: this stop has no position yet.", "warn");
    app.change(r.spec);
    app.selected = r.legId;
    app.flash(`Added ${r.legId}: drag its point on the field to where it goes.`);
  }
  function drop(e: DragEvent, to: number) {
    e.preventDefault();
    dropAt = null;
    const from = Number(e.dataTransfer?.getData(MIME));
    if (Number.isFinite(from) && from !== to) app.change(moveStop(app.snapshot(), from, from < to ? to - 1 : to));
  }
  function over(e: DragEvent, key: string) {
    if (!e.dataTransfer?.types.includes(MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dropAt = key;
  }

  function setIntakeAlways(on: boolean) {
    const s = app.snapshot();
    if (on) s.intakeAlways = true;
    else delete s.intakeAlways;
    app.change(s);
  }

  async function sendWrong(leg: Leg) {
    try {
      await api("POST", "/api/cases", { spec: app.snapshot(), junction: leg.id, shown: legKey(leg), expected: `${wrongDuring}/${wrongEnd}`, note: wrongNote });
      app.flash("Saved as a check for the next evaluation run.");
    } catch (e) {
      app.flash(`Not saved: ${(e as Error).message}`, "error");
    }
    wrongFor = null;
    wrongNote = "";
  }
</script>

{#if spec.reader}
  <div class="box read">
    <strong>Read from {spec.reader.file.split("/").pop()}</strong> ({spec.reader.framework}). AutoTool followed the code and shows every pose and leg; it does not rewrite hand-written code. "Copy as new auto" in the auto menu makes an AutoTool auto from it.
    {#if spec.assume && Object.keys(spec.assume).length}
      <p class="assumed">Not set in the robot code yet, so AutoTool assumed: {Object.entries(spec.assume).map(([k, v]) => `${k.replace(/^Tuned\./, "")} = ${v}`).join(", ")}. Drag the start and the last stop where they belong; every pose computed from them follows.</p>
    {/if}
    {#if spec.reader.skipped.length}
      <details><summary>{spec.reader.skipped.length} piece{spec.reader.skipped.length === 1 ? "" : "s"} of code it could not follow</summary><ul>{#each spec.reader.skipped as k}<li>line {k.line}: <code>{k.text}</code></li>{/each}</ul></details>
    {/if}
  </div>
{/if}
{#if unresolved.length}
  <div class="box warn">
    {#each unresolved as p}
      <div>
        <strong>{p.name}</strong>
        {#if p.formula}= <code>{p.src}</code> uses {[...new Set([p.formula.x, p.formula.y, p.formula.h].flatMap((f) => relevantVars(f, spec.assume ?? {})))].join(", ")}, not set in the robot code yet.{:else}is {[p.expr?.x, p.expr?.y, p.expr?.h].filter(Boolean).join(", ")}: not set in the robot code yet.{/if}
        {#if placeable(p)}<button onclick={() => place(p.name)}>Place on field</button>{/if}
      </div>
    {/each}
  </div>
{/if}

{#if pts}
  <details class="points">
    <summary>
      <strong>AUTO ≈ {pts.total} pts</strong>
      <span class="muted">LEAVE {pts.leave} · PARK {pts.park} · HIVE TIP {pts.tipPoints} · {pts.perSecond} pts/s</span>
    </summary>
    <ul>
      <li>Counted the way Table 10-2 counts AUTO: LEAVE 3, PARK 5, HIVE TIP 20. Only POLLEN launched into the upward-facing CELL tips the HIVE (3 for the staged NECTAR CELL; after a TIP the other CELL faces up and needs {app.pack?.scoring.tipPollenByNectar.table[0]}).</li>
      {#if pts.inUpCell}<li>{pts.inUpCell} element{pts.inUpCell === 1 ? "" : "s"} end up in the upward-facing CELL: 2 each at the end of the match if still there (not AUTO points).</li>{/if}
      {#each pts.notes as n}<li>{n}</li>{/each}
    </ul>
  </details>
{/if}

<div class="list" role="list" aria-label="Legs">
  <!-- start -->
  <div class="row" class:open={startOpen} role="listitem">
    <button class="head" aria-expanded={startOpen} onclick={() => (startOpen = !startOpen)}>
      <span class="chip start">S</span>
      <span class="name">Start <span class="pose">{spec.start}</span></span>
      <span class="what muted">holding {spec.preload.POLLEN - spec.preload.onTiles}</span>
      {#if features.start && Object.values(features.start).some((v) => !v)}<span class="flagdot" title="start not legal (G304)">!</span>{/if}
    </button>
    {#if startOpen && st}
      <div class="ed">
        <div class="f"><span class="k">x, y, heading</span>
          <span class="nums">
            <input type="number" step="0.5" value={disp(st, "x")} onchange={(e) => setPoseField(st.name, "x", e.currentTarget.value)} aria-label="start x (in)" />
            <input type="number" step="0.5" value={disp(st, "y")} onchange={(e) => setPoseField(st.name, "y", e.currentTarget.value)} aria-label="start y (in)" />
            <input type="number" step="1" value={disp(st, "headingDeg")} onchange={(e) => setPoseField(st.name, "headingDeg", e.currentTarget.value)} aria-label="start heading (deg)" />°
          </span>
        </div>
        <div class="f"><span class="k">Preload</span>
          <span class="nums">
            <input type="number" min="0" max="4" step="1" value={spec.preload.POLLEN} onchange={(e) => edit((s) => ({ ...s, preload: { ...s.preload, POLLEN: Math.max(0, Math.min(4, Math.round(Number(e.currentTarget.value)))) } }))} aria-label="preload POLLEN" /> POLLEN,
            <input type="number" min="0" max="4" step="1" value={spec.preload.onTiles} onchange={(e) => edit((s) => ({ ...s, preload: { ...s.preload, onTiles: Math.max(0, Math.min(s.preload.POLLEN, Math.round(Number(e.currentTarget.value)))) } }))} aria-label="preload on tiles" /> on the tiles
          </span>
        </div>
        {#if features.start}
          {@const bad = Object.entries(features.start).filter(([, v]) => !v).map(([k]) => k)}
          <div class="ev" class:flag={bad.length > 0}>{bad.length ? `start not legal (G304): ${bad.join(", ")}` : "legal start (G304)"}</div>
        {/if}
      </div>
    {/if}
  </div>

  <label class="always" title="Route.intakeAlways(): AutoRunner runs the intake for the whole auto, except while a shot aims and feeds">
    <input type="checkbox" checked={!!spec.intakeAlways} onchange={(e) => setIntakeAlways(e.currentTarget.checked)} /> Persistent intake <span class="muted">(intake on all auto, off only during shots)</span>
  </label>

  {#each spec.legs as leg, i (leg.id)}
    {@const j = features.junctions.find((x) => x.id === leg.id)}
    {@const lf = features.legs[i]}
    {@const end = spec.poses.find((p) => p.name === leg.path.to)}
    {@const prop = proposed?.legs.find((l) => l.id === leg.id)}
    {@const rubric = j ? decideStop(j, lf, model) : null}
    {@const open = app.selected === leg.id}
    <div class="slot" class:on={dropAt === `slot:${i}`} role="button" tabindex="0" title="Add a stop here (halfway along the next leg)" ondragover={(e) => over(e, `slot:${i}`)} ondragleave={() => (dropAt = null)} ondrop={(e) => drop(e, i)} onclick={() => addAt(i)} onkeydown={(e) => e.key === "Enter" && addAt(i)}><span>+</span></div>
    <div class="row" class:open class:cut={lf?.cut === "never"} class:dragging={dragFrom === i} role="listitem" draggable={!open} ondragstart={(e) => (e.dataTransfer?.setData(MIME, String(i)), (dragFrom = i))} ondragend={() => (dragFrom = null)}>
      <button class="head" aria-expanded={open} onclick={() => toggle(leg.id)} title={open ? "Close (Esc)" : "Open this leg"}>
        <span class="chip e-{leg.junction.review ? 'review' : leg.end}" class:intake={leg.during !== "NONE"}>{leg.junction.review ? "?" : leg.end === "SHOOT" ? "◎" : leg.end === "PARK" ? "P" : leg.end === "WAIT" ? "◷" : leg.during === "RAMP" ? "R" : leg.during === "INTAKE" ? "IN" : "→"}</span>
        <span class="name"><strong>{leg.id}</strong> <span class="pose">{leg.path.to}</span></span>
        {#if pts?.perLeg[leg.id]}<span class="pts" title="AUTO points this leg earns">+{pts.perLeg[leg.id]}</span>{/if}
        <span class="what">{stopText(leg)}</span>
        {#if lf}<span class="muted num">{lf.travelS.toFixed(1)}{lf.endActionS || (leg.end === "WAIT" && leg.waitS) ? `+${(lf.endActionS + (leg.end === "WAIT" ? (leg.waitS ?? 0) : 0)).toFixed(1)}` : ""} s</span>{/if}
        {#if j}<span class="muted num">{j.inventory.before}→{j.inventory.after}</span>{/if}
        {#if lf && (leg.during === "RAMP" || lf.ramp.maxOut > 0.02)}
          {@const rl = rampLine(leg, lf)}
          <span class="rampgauge" class:bad={rl?.bad} class:off={!features.ramp.calibrated} title={`ramp: ${rl?.text ?? ""}`}><span style:width="{Math.round((leg.during === "RAMP" ? lf.ramp.atArrival : lf.ramp.atStart) * 100)}%"></span></span>
        {/if}
        {#if j?.flags.length || leg.junction.review}<span class="flagdot" title={[...(j?.flags ?? []), ...(leg.junction.note ? [leg.junction.note] : [])].join("\n")}>!</span>{/if}
      </button>
      {#if prop && legKey(prop) !== legKey(leg)}<div class="proposal">proposed: <strong>{stopText(prop)}</strong></div>{/if}
      {#if lf?.cut === "never"}<div class="ev flag">never runs: after the abort time</div>{/if}

      {#if open}
        <div class="ed">
          <div class="f"><span class="k">While driving</span>
            <span class="checks">
              <label><input type="checkbox" checked={leg.during !== "NONE"} onchange={(e) => setIntake(leg, e.currentTarget.checked)} /> Intake on</label>
              <label title="POLLEN from a FLOWER bottom (G418); the intake runs too"><input type="checkbox" checked={leg.during === "RAMP"} onchange={(e) => setRamp(leg, e.currentTarget.checked)} /> Ramp out</label>
              {#if spec.intakeAlways && leg.during === "NONE"}<span class="muted">(persistent intake runs it anyway)</span>{/if}
            </span>
          </div>
          <div class="f"><span class="k">At the end</span>
            <span class="seg" role="radiogroup" aria-label="at the end">
              {#each ENDS as o}
                <button role="radio" aria-checked={leg.end === o.v} class:on={leg.end === o.v} title={o.hint} onclick={() => setEnd(leg, o.v)}>{o.label}</button>
              {/each}
            </span>
          </div>
          {#if lf && (leg.during === "RAMP" || lf.ramp.maxOut > 0.02)}
            {@const rl = rampLine(leg, lf)}
            {#if rl}
              <div class="f"><span class="k">Ramp</span>
                <span class:rampbad={rl.bad}>{rl.text}{#if !features.ramp.calibrated}<span class="muted"> · positions not in the robot code yet: the robot keeps it in</span>{/if}
                  {#if rl.needWaitS !== null}<button class="fixramp" onclick={() => waitForRamp(leg, rl.needWaitS!)} title="End this leg with a WAIT long enough for the ramp to be fully out">Wait {rl.needWaitS} s for it</button>{/if}
                </span>
              </div>
            {/if}
          {/if}
          {#if leg.end === "WAIT"}
            <div class="f"><span class="k">Wait</span><span><input type="number" step="0.1" min="0.1" max="30" value={leg.waitS ?? ""} onchange={(e) => edit((s) => setOption(s, leg.id, "waitS", num(e.currentTarget.value)))} aria-label="wait (s)" /> s</span></div>
          {/if}
          {#if leg.end === "SHOOT"}
            <div class="f"><span class="k">Shot timeout</span><span><input type="number" step="0.5" min="0.5" max="30" placeholder="4" value={leg.shotTimeoutS ?? ""} onchange={(e) => edit((s) => setOption(s, leg.id, "shotTimeoutS", num(e.currentTarget.value)))} aria-label="shot timeout (s)" /> s <span class="muted">skip the shot if not ready by then</span></span></div>
          {/if}
          {#if leg.during !== "NONE"}
            <div class="f"><span class="k">Carry intake</span><span><input type="number" step="0.1" min="0" max="3" value={leg.carryIntakeS || ""} placeholder="0" onchange={(e) => edit((s) => setOption(s, leg.id, "carryIntakeS", num(e.currentTarget.value)))} aria-label="carry intake (s)" /> s <span class="muted">into the next leg</span></span></div>
          {/if}
          <div class="f"><span class="k">Timeout</span><span><input type="number" step="0.5" min="0.5" max="30" placeholder="7" value={leg.legTimeoutS ?? ""} onchange={(e) => edit((s) => setOption(s, leg.id, "legTimeoutS", num(e.currentTarget.value)))} aria-label="leg timeout (s)" /> s <span class="muted">stop driving after this (legs that press into something)</span></span></div>

          {#if end}
            <div class="f"><span class="k">Stop</span>
              <span class="nums">
                <input class="pname" placeholder={end.name} bind:value={renameTo} onkeydown={(e) => e.key === "Enter" && (e.stopPropagation(), rename(end.name))} aria-label="rename stop" />{#if renameTo}<button onclick={() => rename(end.name)}>Rename</button>{/if}
                <input type="number" step="0.5" value={disp(end, "x")} onchange={(e) => setPoseField(end.name, "x", e.currentTarget.value)} aria-label="x (in)" />
                <input type="number" step="0.5" value={disp(end, "y")} onchange={(e) => setPoseField(end.name, "y", e.currentTarget.value)} aria-label="y (in)" />
                <input type="number" step="1" value={disp(end, "headingDeg")} onchange={(e) => setPoseField(end.name, "headingDeg", e.currentTarget.value)} aria-label="heading (deg)" />°
              </span>
            </div>
          {/if}
          {#if leg.path.type !== "toPoint"}
            <div class="f"><span class="k">Path</span>
              <span>
                {#if leg.path.type === "line" || leg.path.type === "curve"}<button onclick={() => edit((s) => addControl(s, leg.id))}>+ control point</button>{/if}
                {#if leg.path.type === "curve"}<button onclick={() => edit((s) => straighten(s, leg.id))}>Straight</button>{/if}
                <select value={leg.heading.mode} onchange={(e) => setHeadingMode(leg, e.currentTarget.value)} aria-label="heading">
                  <option value="linear">turn evenly</option>
                  <option value="constant">hold heading</option>
                  <option value="tangent">face travel</option>
                  <option value="reverseTangent">back into travel</option>
                  {#if leg.heading.mode === "facingPoint"}<option value="facingPoint">face a point</option>{/if}
                </select>
              </span>
            </div>
            {#if leg.path.type === "curve"}
              {#each leg.path.controls as cn, ci (cn)}
                {@const cp = spec.poses.find((p) => p.name === cn)}
                {#if cp}
                  <div class="f"><span class="k">Control {ci + 1}</span>
                    <span class="nums">
                      <input type="number" step="0.5" value={disp(cp, "x")} onchange={(e) => setPoseField(cn, "x", e.currentTarget.value)} aria-label={`control ${ci + 1} x`} />
                      <input type="number" step="0.5" value={disp(cp, "y")} onchange={(e) => setPoseField(cn, "y", e.currentTarget.value)} aria-label={`control ${ci + 1} y`} />
                      <button onclick={() => edit((s) => removeControl(s, leg.id, cn))} aria-label={`remove control ${ci + 1}`}>✕</button>
                    </span>
                  </div>
                {/if}
              {/each}
            {/if}
          {:else}
            <div class="f"><span class="k">Path</span><span class="muted">straight from wherever the robot is</span></div>
          {/if}

          {#if j}
            <div class="ev" title={rubric?.evidence.join(" | ")}>{evidenceLine(features, leg.id)}</div>
            {#each j.flags as f}<div class="ev flag">⚠ {f}</div>{/each}
            {#if rubric && (rubric.review || stopKey(rubric) !== stopKey(leg))}<div class="ev hint">the evidence points to {rubric.review ? "a review" : stopText(rubric)}{rubric.suggestion ? ` (${rubric.suggestion})` : ""}</div>{/if}
            {#if leg.junction.note}<div class="ev hint">{leg.junction.note}</div>{/if}
          {:else}
            <div class="ev flag">cannot be drawn yet: {features.geometry[i]?.problem ?? "missing pose"}</div>
          {/if}
          {#if leg.steps?.length || leg.comment}
            <details class="steps"><summary>What the code does on {leg.id}</summary>
              {#if leg.comment}<div class="muted">drive: {leg.comment}</div>{/if}
              <ol>{#each leg.steps ?? [] as stp}<li><span class="when">{stp.when === "during" ? (stp.ms ? `+${stp.ms} ms` : "during") : stp.when}</span><code>{stp.text}</code><span class="muted">line {stp.line}</span></li>{/each}</ol>
            </details>
          {/if}

          <div class="foot">
            {#if wrongFor === leg.id}
              <span class="wrong">should be
                <select bind:value={wrongDuring} aria-label="while driving">{#each ["NONE", "INTAKE", "RAMP"] as d}<option value={d}>{d}</option>{/each}</select>
                <select bind:value={wrongEnd} aria-label="at the end">{#each ENDS as o}<option value={o.v}>{o.v}</option>{/each}</select>
                <input placeholder="why (optional)" bind:value={wrongNote} />
                <button onclick={() => sendWrong(leg)}>Save check</button>
                <button class="link" onclick={() => (wrongFor = null)}>cancel</button>
              </span>
            {:else}
              <button class="link" onclick={() => ((wrongFor = leg.id), (wrongDuring = leg.during), (wrongEnd = leg.end))}>Wrong?</button>
              <span class="grow"></span>
              <button class="danger" onclick={() => remove(leg)}>Delete leg</button>
              <button onclick={() => (app.selected = null)}>Done</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/each}
  <div class="slot end" class:on={dropAt === `slot:${spec.legs.length}`} role="button" tabindex="0" title="Add a stop after the last one" ondragover={(e) => over(e, `slot:${spec.legs.length}`)} ondragleave={() => (dropAt = null)} ondrop={(e) => drop(e, spec.legs.length)} onclick={() => addAt(spec.legs.length)} onkeydown={(e) => e.key === "Enter" && addAt(spec.legs.length)}><span>+ leg at the end</span></div>
</div>

<style>
  .box {
    margin: 8px 10px 0;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 12px;
  }
  .box.read {
    border: 1px solid #2f5f86;
    background: #0f1d2a;
  }
  .box.warn {
    border: 1px solid #92400e;
    background: #2a1d05;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .assumed {
    margin: 6px 0 0;
    color: var(--unsure);
  }
  .list {
    padding: 6px 0 12px;
  }
  .points {
    margin: 8px 10px 0;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 12px;
  }
  .points summary {
    cursor: pointer;
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .points strong {
    font-size: 14px;
  }
  .points ul {
    margin: 6px 0 0;
    padding-left: 16px;
    color: #cbd5e1;
  }
  .pts {
    flex: none;
    font-size: 11px;
    font-weight: 700;
    color: #86efac;
  }
  .always {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
  }
  .row {
    border-left: 3px solid transparent;
  }
  .row.open {
    border-left-color: var(--sel);
    background: #10161d;
  }
  .row.cut {
    opacity: 0.55;
  }
  .row.dragging {
    opacity: 0.4;
  }
  .row[draggable="true"] .head {
    cursor: grab;
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: none;
    border: 0;
    border-radius: 0;
    text-align: left;
    font-size: 13px;
    color: var(--text);
  }
  .head:hover {
    background: #181d24;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .what {
    margin-left: auto;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .pose {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .num {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .chip {
    flex: none;
    width: 26px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 800;
    border: 1px solid var(--line);
    background: #1f242b;
  }
  .chip.intake {
    box-shadow: inset 0 -3px 0 var(--intake);
  }
  .chip.e-SHOOT {
    background: #3f0d0d;
    border-color: var(--shoot);
    color: #fecaca;
  }
  .chip.e-PARK {
    background: #fff;
    color: #000;
  }
  .chip.e-WAIT {
    color: #e5e7eb;
  }
  .chip.e-review {
    background: var(--unsure);
    color: #000;
  }
  .chip.start {
    background: #0f1d2a;
    color: var(--sel);
  }
  .flagdot {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--unsure);
    color: #000;
    font-size: 11px;
    font-weight: 900;
    display: grid;
    place-items: center;
  }
  .proposal {
    font-size: 12px;
    color: var(--sel);
    padding: 0 10px 4px 44px;
  }
  .ed {
    padding: 4px 10px 10px 44px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .f {
    display: grid;
    grid-template-columns: 92px 1fr;
    gap: 8px;
    align-items: center;
  }
  .k {
    color: var(--muted);
    font-size: 12px;
  }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    align-items: center;
  }
  .checks label {
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
    width: max-content;
  }
  .seg button {
    border: 0;
    border-radius: 0;
    padding: 4px 10px;
    background: none;
    font-size: 12px;
  }
  .seg button + button {
    border-left: 1px solid var(--line);
  }
  .seg button.on {
    background: var(--sel);
    color: #000;
    font-weight: 700;
  }
  input[type="number"] {
    width: 62px;
  }
  .nums {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .pname {
    font-family: var(--mono);
    width: 110px;
  }
  .ev {
    font-size: 12px;
    color: var(--muted);
  }
  .ev.flag {
    color: #fcd34d;
  }
  .ev.hint {
    color: #9cc9f5;
  }
  .steps {
    font-size: 12px;
  }
  .steps ol {
    list-style: none;
    padding: 0 0 0 8px;
    margin: 4px 0 0;
    border-left: 1px solid var(--line);
  }
  .steps li {
    display: grid;
    grid-template-columns: 60px 1fr auto;
    gap: 6px;
  }
  .when {
    color: #9cc9f5;
  }
  .foot {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 2px;
  }
  .grow {
    flex: 1;
  }
  .wrong {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    font-size: 12px;
  }
  .wrong input {
    width: 120px;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--muted);
    font-size: 12px;
    text-decoration: underline;
  }
  .danger {
    border-color: #7f1d1d;
    color: #fecaca;
  }
  .slot {
    height: 6px;
    margin: 0 10px;
    position: relative;
    cursor: pointer;
  }
  .slot span {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    font-size: 11px;
    line-height: 14px;
    padding: 0 8px;
    border-radius: 999px;
    background: var(--panel);
    border: 1px dashed var(--line);
    color: var(--muted);
    opacity: 0;
  }
  .slot:hover span,
  .slot:focus-visible span,
  .slot.on span,
  .slot.end span {
    opacity: 1;
  }
  .slot.on {
    background: var(--sel);
    border-radius: 3px;
  }
  .slot.end {
    height: 26px;
    margin-top: 6px;
  }
  .rampgauge {
    display: inline-block;
    width: 22px;
    height: 6px;
    border-radius: 2px;
    background: #1b1d21;
    border: 1px solid #a3e635;
    overflow: hidden;
    vertical-align: middle;
  }
  .rampgauge span {
    display: block;
    height: 100%;
    background: #a3e635;
  }
  .rampgauge.bad {
    border-color: var(--unsure);
  }
  .rampgauge.bad span {
    background: var(--unsure);
  }
  .rampgauge.off span {
    background: #8b8f97;
  }
  .rampbad {
    color: var(--unsure);
  }
  .fixramp {
    margin-left: 6px;
    font-size: 12px;
    padding: 1px 6px;
  }
</style>
