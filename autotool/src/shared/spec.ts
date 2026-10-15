// The auto spec: the single source of truth. The route UI edits it, the AI proposes patches to it,
// the generator turns it into Java. Poses are named (they become Java fields); legs reference them.

export const SPEC_VERSION = 2;

// A leg is the robot code's AutoRunner.Leg, field for field: a path (or a target pose), what the robot does
// while driving it, what it does when it gets there, and options. Java -> spec -> Java is a direct copy.
export const DURINGS = ["NONE", "INTAKE", "RAMP"] as const; // AutoRunner.During
export type During = (typeof DURINGS)[number];
export const ENDS = ["NONE", "SHOOT", "PARK", "WAIT"] as const; // AutoRunner.End
export type End = (typeof ENDS)[number];

// AutoRunner.Action: the older one-word leg, a shortcut for one During/End pair (read, never written)
export const ACTIONS: Record<string, { during: During; end: End }> = {
  NONE: { during: "NONE", end: "NONE" },
  INTAKE: { during: "INTAKE", end: "NONE" },
  RAMP: { during: "RAMP", end: "NONE" },
  SHOOT: { during: "NONE", end: "SHOOT" },
  PARK: { during: "NONE", end: "PARK" },
};

export interface PoseDef {
  name: string; // Java field name
  x: number | null; // null = symbolic and not resolvable (e.g. a Tuned value that is NaN)
  y: number | null;
  headingDeg: number | null;
  // symbolic Java expressions kept verbatim (e.g. "Tuned.blueStartX"); rendered instead of the number
  expr?: { x?: string; y?: string; h?: string };
  // redTrim(pose, dx, dy, dHeadingDeg) wrapper from AutoPaths; undefined = not wrapped
  redTrim?: [number, number, number];
  role: "waypoint" | "control";
  comment?: string;
  // read from hand-written code: how each number follows from the code (unknowns named, e.g. Tuned.blueStartX)
  formula?: { x: Formula; y: Formula; h: Formula };
  src?: string; // the code that makes this pose
}

// A number that may depend on values the code does not know yet (see shared/java/reader.ts).
export type Formula = { k: "c"; v: number } | { k: "v"; name: string } | { k: "op"; op: string; a: Formula[] };

// A step the code does during or after a leg (read from hand-written code), in the code's own words.
export interface LegStep {
  when: "before" | "during" | "after";
  text: string;
  line: number;
  ms?: number; // after the leg starts (during) or in order after it (after)
  kind: "action" | "wait";
}

export type PathGeom =
  | { type: "line"; from: string; to: string }
  | { type: "curve"; from: string; controls: string[]; to: string }
  | { type: "through"; from: string; via: string[]; to: string }
  // AutoRunner.Leg(Pose target, action): straight line from wherever the robot is when the leg starts
  | { type: "toPoint"; to: string };

export type HeadingDef =
  | { mode: "linear"; from: string; to: string }
  | { mode: "constant"; pose: string }
  | { mode: "tangent" }
  | { mode: "reverseTangent" }
  | { mode: "facingPoint"; pose: string }
  // toPoint legs: AutoRunner builds Paths.line(current, target).linear(current, target)
  | { mode: "toTarget" };

export type LegSource = "imported" | "ai" | "user" | "none";

// Why a leg does what it does: who decided, and the evidence (zones, inventory) the AI used. Stays in the
// tool; never reaches the robot code.
export interface Junction {
  source: LegSource;
  evidence: string[];
  note?: string;
  review?: boolean; // the evidence conflicts: the team decides before writing
}

export interface Leg {
  id: string; // stable id, "L1", "L2", ...
  method?: string; // Java method returning the Path (path legs)
  inline?: boolean; // the Path expression was written inside legs() (kept on round trip)
  path: PathGeom;
  heading: HeadingDef;
  during: During; // while driving the path
  end: End; // when it gets there
  legTimeoutS: number | null; // Leg.timeout(s); null = AutoRunner's LEG_TIMEOUT_S
  carryIntakeS: number; // Leg.carryIntake(s); 0 = not set
  shotTimeoutS?: number; // Leg.shotTimeout(s), SHOOT; absent = AutoRunner's SHOT_TIMEOUT_S
  waitS?: number; // Leg.waitFor(s), WAIT: how long it holds at the end
  carryRampS?: number; // Leg.carryRamp(s), RAMP: the ramp stays out this long into the next leg; absent = AutoRunner's RAMP_CARRY_S
  junction: Junction; // why (the AI's evidence for this stop)
  comment?: string;
  optOrder?: string[]; // the order the code wrote the options in (kept on round trip)
  steps?: LegStep[]; // read from hand-written code: everything it does on this leg
  fromCurrent?: boolean; // the code drives from wherever the robot is, not from the previous pose
}

export interface OpaqueBlock {
  anchor: string; // "member:<n>" = position among class members, "after-legs", "file-end"
  code: string; // written back verbatim
  why: string; // why the spec cannot represent it
}

// How the auto's Java file looked when it was imported, so regenerating keeps everything the spec
// does not model: member order, untouched members byte for byte, imports, helpers, custom ready().
export interface JavaShape {
  packageName: string;
  imports: string[];
  headerText: string; // package + imports exactly as written
  classDecl: string;
  factory: string; // the poseFactory field, verbatim
  redTrimHelper?: string; // the redTrim(...) helper with its comment, verbatim
  readyCustom?: string; // ready() verbatim when it is not the one the tool derives
  order: string[]; // member keys in file order: factory, pose:x, method:ready, method:redTrim, method:start, path:m, method:legs, opaque:i
  originals: Record<string, { text: string; leading: string; norm: string; blankBefore: boolean }>;
  trailing: string; // comments before the closing brace
  after: string; // text after the class
  legNew: string; // "AutoRunner.Leg" or "Leg"
  enumPrefix: string; // "AutoRunner." or "" (before During/End/Action)
  legForm: "during" | "action"; // new Leg(p, During.X, End.Y), or the older new Leg(p, Action.X) (kept where it fits)
  listCall: string; // "Arrays.asList" or "List.of"
  route?: boolean; // a generated route class (implements AutoRoute, instance isReady())
}

export interface AutoSpec {
  specVersion: 2;
  name: string;
  drawnFor: "BLUE";
  javadoc?: string; // the comment above the class, kept verbatim
  start: string; // pose name returned by start()
  preload: { POLLEN: number; NECTAR: number; onTiles: number };
  poses: PoseDef[];
  legs: Leg[];
  opaque: OpaqueBlock[];
  source?: { file: string; hash: string };
  java?: JavaShape;
  // read (not imported) from hand-written code: AutoTool shows and labels it but does not rewrite that file
  reader?: { file: string; framework: string; unknowns: string[]; skipped: { line: number; text: string }[]; at: string; v?: number; guessed?: string[] };
  assume?: Record<string, number>; // values for the unknowns, placed on the field by the team
  intakeAlways?: boolean; // persistent intake: AutoRunner.Route.intakeAlways() (the intake runs all auto except during shots)
}

// What a leg does, in a few words ("INTAKE -> SHOOT", "WAIT 1.5 s", "drive").
export function stopText(leg: Pick<Leg, "during" | "end" | "waitS">): string {
  const end = leg.end === "WAIT" ? `WAIT${leg.waitS ? ` ${leg.waitS} s` : ""}` : leg.end;
  if (leg.during === "NONE") return leg.end === "NONE" ? "drive" : end;
  return leg.end === "NONE" ? leg.during : `${leg.during} -> ${end}`;
}

// Sets what a leg does (the team, the AI or the import decided); options that no longer apply go.
export function withStop(leg: Leg, during: During, end: End, source: LegSource, evidence: string[], extra: { note?: string; review?: boolean; waitS?: number } = {}): Leg {
  const out: Leg = { ...leg, during, end, junction: { source, evidence, ...(extra.note ? { note: extra.note } : {}), ...(extra.review ? { review: true } : {}) } };
  if (during === "NONE") out.carryIntakeS = 0;
  if (during !== "RAMP") delete out.carryRampS;
  if (end !== "SHOOT") delete out.shotTimeoutS;
  if (end !== "WAIT") delete out.waitS;
  else out.waitS = extra.waitS ?? leg.waitS ?? 1;
  return out;
}

// Saved autos from before the Leg had during/end (spec v1: one action + a label per stop) and options
// AutoRunner no longer has.
export function migrateSpec(spec: AutoSpec): AutoSpec {
  const v = spec as unknown as { specVersion: number; legs: Record<string, unknown>[] };
  if (v.specVersion !== 1) return spec;
  const legs = v.legs.map((l) => {
    const old = l as { during: string[]; end: { action: string }; junction: { label: string | null; source: LegSource; evidence: string[]; note?: string }; dwellS?: number; waitAfterS?: number };
    const during: During = old.during?.includes("ramp") ? "RAMP" : old.during?.includes("intake") ? "INTAKE" : "NONE";
    let end = (old.end?.action ?? "NONE") as End;
    const hold = (old.dwellS ?? 0) + (old.waitAfterS ?? 0);
    const leg: Record<string, unknown> = { ...l, during, end };
    if (end === "NONE" && hold > 0) {
      end = "WAIT";
      leg.end = end;
      leg.waitS = hold;
    }
    for (const k of ["intakeFromS", "intakeUntilS", "dwellS", "waitAfterS", "turretDeg", "launcher", "carryFirst"]) delete leg[k];
    if (Array.isArray(leg.optOrder)) leg.optOrder = (leg.optOrder as string[]).filter((o) => ["timeout", "carryIntake", "carryRamp"].includes(o));
    const j = old.junction ?? { label: null, source: "none", evidence: [] };
    leg.junction = { source: j.source, evidence: j.evidence ?? [], ...(j.note ? { note: j.note } : {}), ...(j.label === "NEEDS_REVIEW" ? { review: true } : {}) };
    return leg as unknown as Leg;
  });
  const out = { ...spec, specVersion: SPEC_VERSION, legs } as AutoSpec;
  if (out.java) out.java = undefined; // the file shape is read again from the file
  return out;
}

// --- helpers ---------------------------------------------------------------------------------

export function poseMap(spec: AutoSpec): Map<string, PoseDef> {
  return new Map(spec.poses.map((p) => [p.name, p]));
}

export function endPoseName(leg: Leg): string {
  return leg.path.to;
}

export function startPoseName(spec: AutoSpec, index: number): string {
  if (index === 0) return spec.start;
  return spec.legs[index - 1].path.to;
}

// Poses a leg's geometry uses, in order (from, controls/via, to).
export function legPoseNames(spec: AutoSpec, index: number): string[] {
  const leg = spec.legs[index];
  const p = leg.path;
  switch (p.type) {
    case "line":
      return [p.from, p.to];
    case "curve":
      return [p.from, ...p.controls, p.to];
    case "through":
      return [p.from, ...p.via, p.to];
    case "toPoint":
      return [startPoseName(spec, index), p.to];
  }
}

const JAVA_KEYWORDS = new Set(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield".split(
    " ",
  ),
);
// AutoPaths' own members. Java keeps fields and methods apart, so a pose (field) may be called
// "start" next to the start() method (the placeholder does exactly that).
const RESERVED_FIELDS = new Set(["poseFactory"]);
const RESERVED_METHODS = new Set(["redTrim", "start", "ready", "legs"]);

export function isJavaIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !JAVA_KEYWORDS.has(name);
}

export interface Problem {
  level: "error" | "warning";
  code: string;
  where: string; // "spec", "pose:shot1", "leg:L2"
  message: string;
}

// Schema, reference and adapter checks. Errors block writing; warnings are shown.
export function validateSpec(spec: AutoSpec, opts: { fieldSize: number } = { fieldSize: 144 }): Problem[] {
  const out: Problem[] = [];
  const err = (code: string, where: string, message: string) => out.push({ level: "error", code, where, message });
  const warn = (code: string, where: string, message: string) => out.push({ level: "warning", code, where, message });

  if (!spec || typeof spec !== "object") return [{ level: "error", code: "spec.type", where: "spec", message: "spec is not an object" }];
  if (spec.specVersion !== SPEC_VERSION) err("spec.version", "spec", `specVersion must be ${SPEC_VERSION}`);
  if (spec.drawnFor !== "BLUE") err("spec.drawnFor", "spec", "autos are drawn for BLUE (red is the 180-degree rotation)");
  if (typeof spec.name !== "string" || !/^[A-Za-z0-9_ -]{1,40}$/.test(spec.name)) err("spec.name", "spec", "name: 1-40 letters, digits, spaces, - or _");
  const pl = spec.preload;
  if (!pl || ![pl.POLLEN, pl.NECTAR, pl.onTiles].every((n) => Number.isInteger(n) && n >= 0 && n <= 8)) err("spec.preload", "spec", "preload counts must be whole numbers 0-8");
  else if (pl.onTiles > pl.POLLEN) err("spec.preload", "spec", "preload onTiles cannot exceed the POLLEN preload");

  const names = new Set<string>();
  for (const p of spec.poses ?? []) {
    const where = `pose:${p.name}`;
    if (!isJavaIdentifier(p.name)) err("pose.name", where, `"${p.name}" is not a Java identifier`);
    if (RESERVED_FIELDS.has(p.name)) err("pose.name", where, `"${p.name}" is already a field of AutoPaths`);
    if (names.has(p.name)) err("pose.dup", where, `two poses named "${p.name}"`);
    names.add(p.name);
    if (p.role !== "waypoint" && p.role !== "control") err("pose.role", where, "role must be waypoint or control");
    for (const [k, v, e] of [
      ["x", p.x, p.expr?.x],
      ["y", p.y, p.expr?.y],
      ["headingDeg", p.headingDeg, p.expr?.h],
    ] as const) {
      if (v === null) {
        if (!e) err("pose.value", where, `${k} is empty`);
        else warn("pose.unresolved", where, `${k} = ${e} has no value yet (NaN in Tuned); the route cannot be drawn there`);
      } else if (typeof v !== "number" || !Number.isFinite(v)) err("pose.value", where, `${k} is not a number`);
    }
    if (p.x !== null && p.y !== null && (p.x < 0 || p.x > opts.fieldSize || p.y < 0 || p.y > opts.fieldSize)) {
      err("pose.field", where, `(${p.x}, ${p.y}) is outside the ${opts.fieldSize} in field`);
    }
    if (p.redTrim && (p.redTrim.length !== 3 || !p.redTrim.every((n) => Number.isFinite(n)))) err("pose.redTrim", where, "redTrim needs 3 numbers");
  }
  if (!names.has(spec.start)) err("spec.start", "spec", `start pose "${spec.start}" does not exist`);

  const legIds = new Set<string>();
  const methods = new Set<string>();
  const needPose = (where: string, name: string, role: "waypoint" | "control" | "any") => {
    const p = (spec.poses ?? []).find((q) => q.name === name);
    if (!p) err("leg.ref", where, `pose "${name}" does not exist`);
    else if (role !== "any" && p.role !== role) warn("leg.role", where, `pose "${name}" is a ${p.role} point used as a ${role} point`);
  };
  if (!Array.isArray(spec.legs) || spec.legs.length === 0) err("spec.legs", "spec", "an auto needs at least one leg");
  (spec.legs ?? []).forEach((leg, i) => {
    const where = `leg:${leg.id}`;
    if (!/^L\d+$/.test(leg.id)) err("leg.id", where, "leg ids look like L1, L2, ...");
    if (legIds.has(leg.id)) err("leg.dup", where, "duplicate leg id");
    legIds.add(leg.id);
    const p = leg.path;
    if (p.type !== "toPoint") {
      if (!leg.inline) {
        if (!leg.method || !isJavaIdentifier(leg.method)) err("leg.method", where, "path legs need a Java method name");
        else if (methods.has(leg.method) || RESERVED_METHODS.has(leg.method)) err("leg.method", where, `method name "${leg.method}" is taken`);
        else methods.add(leg.method);
        if (leg.method && names.has(leg.method)) warn("leg.methodName", where, `method "${leg.method}" has the same name as a pose`);
      }
      needPose(where, p.from, "waypoint");
      const prev = i === 0 ? spec.start : spec.legs[i - 1].path.to;
      if (p.from !== prev) warn("leg.gap", where, `starts at "${p.from}" but the robot is at "${prev}" when it begins`);
    }
    if (p.type === "curve") p.controls.forEach((c) => needPose(where, c, "control"));
    if (p.type === "through") p.via.forEach((c) => needPose(where, c, "any"));
    needPose(where, p.to, "waypoint");
    const h = leg.heading;
    if (p.type === "toPoint" && h.mode !== "toTarget") err("leg.heading", where, "a straight-to-point leg turns linearly to the target heading (AutoRunner)");
    if (p.type !== "toPoint" && h.mode === "toTarget") err("leg.heading", where, "toTarget heading is only for straight-to-point legs");
    if (h.mode === "linear") {
      needPose(where, h.from, "any");
      needPose(where, h.to, "any");
    }
    if (h.mode === "constant") needPose(where, h.pose, "any");
    if (h.mode === "facingPoint") needPose(where, h.pose, "any");

    // AutoRunner.Leg: during, end and options (AutoRunner.java)
    if (!DURINGS.includes(leg.during)) err("leg.during", where, `while driving: ${DURINGS.join(", ")}`);
    if (!ENDS.includes(leg.end)) err("leg.end", where, `at the end: ${ENDS.join(", ")}`);
    if (!(leg.carryIntakeS >= 0 && leg.carryIntakeS <= 3)) err("leg.carry", where, "carryIntake must be 0-3 s");
    if (leg.carryIntakeS > 0 && leg.during === "NONE") err("leg.carry", where, "carryIntake keeps the intake on into the next leg: only for INTAKE and RAMP legs");
    if (leg.legTimeoutS !== null && !(leg.legTimeoutS > 0 && leg.legTimeoutS <= 30)) err("leg.timeout", where, "timeout must be 0-30 s");
    if (leg.shotTimeoutS !== undefined && !(leg.shotTimeoutS > 0 && leg.shotTimeoutS <= 30)) err("leg.shotTimeout", where, "shot timeout must be 0-30 s");
    if (leg.shotTimeoutS !== undefined && leg.end !== "SHOOT") warn("leg.shotTimeout", where, "shot timeout only matters when the leg ends in SHOOT");
    if (leg.end === "WAIT" && !(typeof leg.waitS === "number" && leg.waitS > 0 && leg.waitS <= 30)) err("leg.wait", where, "WAIT needs a time: 0-30 s");
    if (leg.waitS !== undefined && leg.end !== "WAIT") warn("leg.wait", where, "a wait time only matters when the leg ends in WAIT");
    if (leg.carryRampS !== undefined && !(leg.carryRampS >= 0 && leg.carryRampS <= 3)) err("leg.carryRamp", where, "carryRamp must be 0-3 s");
    if (leg.carryRampS !== undefined && leg.during !== "RAMP") warn("leg.carryRamp", where, "carryRamp only matters on a RAMP leg");
    if (leg.junction?.review) warn("junction.review", where, `needs review${leg.junction.note ? `: ${leg.junction.note}` : ""}: check what this leg does before writing`);
    if (leg.end === "PARK" && i !== spec.legs.length - 1) warn("leg.parkEarly", where, "PARK ends the auto: legs after it never run");
  });
  for (const pose of spec.poses ?? []) {
    const used = pose.name === spec.start || (spec.legs ?? []).some((l, i) => legPoseNames(spec, i).includes(pose.name) || ("from" in l.heading && l.heading.from === pose.name) || ("pose" in l.heading && l.heading.pose === pose.name));
    if (!used) warn("pose.unused", `pose:${pose.name}`, "not used by any leg");
  }
  return out;
}

export function writable(problems: Problem[]): boolean {
  return !problems.some((p) => p.level === "error" || p.code === "junction.review");
}

export function cloneSpec(spec: AutoSpec): AutoSpec {
  return JSON.parse(JSON.stringify(spec));
}

// Stable JSON (sorted keys) for hashing and metamorphic checks.
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function uniqueName(base: string, taken: Set<string>): string {
  const clean = base.replace(/[^A-Za-z0-9_$]/g, "") || "pose";
  if (!taken.has(clean) && isJavaIdentifier(clean)) return clean;
  for (let i = 2; ; i++) {
    const n = `${clean}${i}`;
    if (!taken.has(n)) return n;
  }
}

// Leg ids are positional (L1 = the first leg). After adding or removing legs, renumber in route order.
export function renumberLegs(spec: AutoSpec): AutoSpec {
  return { ...spec, legs: spec.legs.map((l, i) => ({ ...l, id: `L${i + 1}` })) };
}

export function nextLegId(spec: AutoSpec): string {
  let max = 0;
  for (const l of spec.legs) max = Math.max(max, Number(l.id.slice(1)) || 0);
  return `L${max + 1}`;
}
