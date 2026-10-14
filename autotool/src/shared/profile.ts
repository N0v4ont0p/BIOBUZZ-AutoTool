// The team profile: confirmed facts about this robot and its code, each with where it came from.
// It is built by the ingest scan (server/ingest.ts), reviewed by the team, and goes into the system prompt.

export type FactStatus = "code" | "measured" | "rule" | "pack" | "assumed" | "user";

export interface Fact {
  key: string;
  label: string;
  value: number | string;
  unit: string;
  status: FactStatus;
  source: string; // "TeamCode/.../AutoRunner.java:73", "G407", "assumed: ..."
  confirmed: boolean;
  group: "robot" | "auto" | "shooter" | "motion" | "field" | "rubric";
  note?: string;
  repoValue?: number | string | null; // what the repo said when this fact was built (detects repo changes)
}

export interface Conventions {
  indent: string;
  poseWrap: "redTrim" | "plain";
  numberDecimals: number;
  pathMethodStyle: string; // e.g. "camelCase verbs: startToShot1"
  legListStyle: "Arrays.asList" | "List.of";
  found: string[]; // one line each, with file:line
}

export interface Profile {
  profileVersion: number;
  team: string;
  season: string;
  repo: { path: string; autosDir: string };
  createdAt: string;
  updatedAt: string;
  facts: Record<string, Fact>;
  conventions: Conventions;
  startingBalanceUsd: number | null;
  sanityConfirmed: boolean;
  sanityFor?: string; // sha256 of the sample auto the team confirmed ("is this your auto")
  changes?: { key: string; label: string; from: string; to: string; needsYou: boolean; at: string }[]; // shown until dismissed
}

// Every fact the tool reads, with the value used when the repo does not have it yet.
// Keys are stable: the prompt, features and eval refer to them.
export const FACT_DEFAULTS: Omit<Fact, "status" | "source" | "confirmed">[] = [
  { key: "capacity", label: "Max elements held", value: 4, unit: "elements", group: "robot", note: "G407 caps CONTROL at 4" },
  { key: "preloadPollen", label: "Preload POLLEN", value: 4, unit: "POLLEN", group: "auto" },
  { key: "preloadOnTiles", label: "Preload placed on the tiles (TU03)", value: 0, unit: "POLLEN", group: "auto" },
  { key: "intakeEnd", label: "Intake end of the robot", value: "front", unit: "", group: "robot" },
  { key: "intakeReachIn", label: "Intake reach past the front edge", value: 2, unit: "in", group: "robot" },
  { key: "intakeWidthIn", label: "Intake mouth width", value: 18, unit: "in", group: "robot", note: "the part of the front that takes elements; the full robot width until the CAD gives it" },
  { key: "rampReachIn", label: "Ramp reach past the front edge (deployed)", value: 2, unit: "in", group: "robot", note: "same as the intake until the CAD gives the ramp length (R105: the ramp stays inside 18 x 24 in)" },
  { key: "elementsPerShot", label: "Elements one SHOOT sends", value: "all", unit: "", group: "shooter", note: "AutoRunner feeds for FEED_S with both gates open" },
  { key: "centerToFront", label: "Robot centre to front edge", value: 9, unit: "in", group: "robot" },
  { key: "centerToBack", label: "Robot centre to back edge", value: 9, unit: "in", group: "robot" },
  { key: "centerToLeft", label: "Robot centre to left edge", value: 9, unit: "in", group: "robot" },
  { key: "centerToRight", label: "Robot centre to right edge", value: 9, unit: "in", group: "robot" },
  { key: "frontPivotX", label: "Front turret pivot x (forward)", value: 0, unit: "in", group: "shooter" },
  { key: "frontPivotY", label: "Front turret pivot y (left)", value: 0, unit: "in", group: "shooter" },
  { key: "backPivotX", label: "Back turret pivot x (forward)", value: 0, unit: "in", group: "shooter" },
  { key: "backPivotY", label: "Back turret pivot y (left)", value: 0, unit: "in", group: "shooter" },
  { key: "yawBackPerFront", label: "Back turret degrees per front turret degree", value: 1, unit: "deg/deg", group: "shooter", note: "Yaw.frontToBackDeg = yawTicksPerDegFront / yawTicksPerDegBack" },
  { key: "yawMinDeg", label: "Turret travel, right limit", value: -90, unit: "deg", group: "shooter" },
  { key: "yawMaxDeg", label: "Turret travel, left limit", value: 90, unit: "deg", group: "shooter" },
  { key: "shotMinIn", label: "Shortest shot in the shot table", value: 30, unit: "in", group: "shooter" },
  { key: "shotMaxIn", label: "Longest shot in the shot table", value: 100, unit: "in", group: "shooter" },
  { key: "gateTravelS", label: "Gate open time", value: 0.25, unit: "s", group: "shooter" },
  { key: "abortAtS", label: "Auto stops new legs at", value: 28.5, unit: "s", group: "auto" },
  { key: "legTimeoutS", label: "Default leg timeout", value: 7, unit: "s", group: "auto" },
  { key: "settleS", label: "Shot settle time", value: 0.3, unit: "s", group: "auto" },
  { key: "readyTimeoutS", label: "Shot ready timeout", value: 2, unit: "s", group: "auto" },
  { key: "feedS", label: "Shot feed time", value: 0.55, unit: "s", group: "auto" },
  { key: "shotAbandonS", label: "Shot abandon time", value: 4, unit: "s", group: "auto" },
  { key: "stoppedSpeed", label: "Stopped below", value: 1, unit: "in/s", group: "auto" },
  { key: "stoppedTurnDeg", label: "Stopped turning below", value: 2, unit: "deg/s", group: "auto" },
  { key: "maxVel", label: "Top drive speed", value: 40, unit: "in/s", group: "motion" },
  { key: "accel", label: "Acceleration", value: 30, unit: "in/s^2", group: "motion" },
  { key: "decel", label: "Braking", value: 30, unit: "in/s^2", group: "motion" },
  { key: "latAccel", label: "Cornering limit", value: 30, unit: "in/s^2", group: "motion" },
  { key: "maxTurnDegS", label: "Top turn rate", value: 180, unit: "deg/s", group: "motion" },
  { key: "cellRedFarX", label: "Red far CELL x", value: 59.25, unit: "in", group: "field" },
  { key: "cellRedFarY", label: "Red far CELL y", value: 85.37, unit: "in", group: "field" },
  { key: "cellRedAudienceX", label: "Red audience CELL x", value: 59.25, unit: "in", group: "field" },
  { key: "cellRedAudienceY", label: "Red audience CELL y", value: 58.63, unit: "in", group: "field" },
  { key: "parkRegion", label: "Parking region", value: "LOADING ZONE", unit: "", group: "field" },
  { key: "humanFeedAfterTip", label: "NECTAR a human adds after a HIVE TIP in auto", value: 0, unit: "NECTAR", group: "field", note: "the AI never counts on it" },
  { key: "wallMarginIn", label: "Keep stops this far from walls", value: 1, unit: "in", group: "rubric" },
  { key: "tinyMoveIn", label: "A move this short is a settle", value: 6, unit: "in", group: "rubric" },
  { key: "intakeLeadMaxDeg", label: "Intake leads if heading is within", value: 45, unit: "deg", group: "rubric" },
  { key: "sharpTurnDeg", label: "A turn this sharp is drawn as an arc", value: 60, unit: "deg", group: "rubric" },
];

export function defaultFacts(): Record<string, Fact> {
  const out: Record<string, Fact> = {};
  for (const f of FACT_DEFAULTS) {
    out[f.key] = { ...f, status: "assumed", source: "assumed: not in the repo yet", confirmed: false };
  }
  out.capacity.status = "rule";
  out.capacity.source = "G407 (no more than 4 at a time)";
  out.preloadPollen.status = "rule";
  out.preloadPollen.source = "10.3.4 / G304.G (TU03)";
  out.preloadOnTiles.status = "rule";
  out.preloadOnTiles.source = "TU03 10.3.4: may sit on the tiles touching the robot; default held";
  out.parkRegion.status = "rule";
  out.parkRegion.source = "10.5.4 PARK: at least partially in the LOADING ZONE";
  out.humanFeedAfterTip.status = "rule";
  out.humanFeedAfterTip.source = "G426 (TU02): only after a HIVE TIP in a 30 s auto; default none";
  for (const k of ["cellRedFarX", "cellRedFarY", "cellRedAudienceX", "cellRedAudienceY"]) {
    out[k].status = "pack";
    out[k].source = "season pack (owner CAD); H-1 not entered";
  }
  for (const k of ["wallMarginIn", "tinyMoveIn", "intakeLeadMaxDeg", "sharpTurnDeg"]) {
    out[k].status = "assumed";
    out[k].source = "rubric threshold, tuned by evaluation";
  }
  return out;
}

export interface RobotModel {
  capacity: number;
  preloadPollen: number;
  preloadOnTiles: number;
  intakeEnd: "front" | "back";
  intakeReachIn: number;
  intakeWidthIn: number;
  rampReachIn: number;
  elementsPerShot: number; // Infinity = all held
  body: { front: number; back: number; left: number; right: number };
  frontPivot: { x: number; y: number };
  backPivot: { x: number; y: number };
  yawBackPerFront: number;
  yawMinDeg: number;
  yawMaxDeg: number;
  shotMinIn: number;
  shotMaxIn: number;
  gateTravelS: number;
  abortAtS: number;
  legTimeoutS: number;
  settleS: number;
  readyTimeoutS: number;
  feedS: number;
  shotAbandonS: number;
  maxVel: number;
  accel: number;
  decel: number;
  latAccel: number;
  maxTurnDegS: number;
  cells: { RED: { far: { x: number; y: number }; audience: { x: number; y: number } } };
  wallMarginIn: number;
  tinyMoveIn: number;
  intakeLeadMaxDeg: number;
  sharpTurnDeg: number;
}

export function robotModel(facts: Record<string, Fact>): RobotModel {
  const n = (k: string): number => {
    const f = facts[k];
    const v = typeof f?.value === "number" ? f.value : Number(f?.value);
    if (!Number.isFinite(v)) throw new Error(`profile fact ${k} is not a number`);
    return v;
  };
  const eps = facts.elementsPerShot?.value;
  return {
    capacity: n("capacity"),
    preloadPollen: n("preloadPollen"),
    preloadOnTiles: n("preloadOnTiles"),
    intakeEnd: facts.intakeEnd?.value === "back" ? "back" : "front",
    intakeReachIn: n("intakeReachIn"),
    intakeWidthIn: n("intakeWidthIn"),
    rampReachIn: n("rampReachIn"),
    elementsPerShot: eps === "all" || eps === undefined ? Infinity : Number(eps),
    body: { front: n("centerToFront"), back: n("centerToBack"), left: n("centerToLeft"), right: n("centerToRight") },
    frontPivot: { x: n("frontPivotX"), y: n("frontPivotY") },
    backPivot: { x: n("backPivotX"), y: n("backPivotY") },
    yawBackPerFront: n("yawBackPerFront"),
    yawMinDeg: n("yawMinDeg"),
    yawMaxDeg: n("yawMaxDeg"),
    shotMinIn: n("shotMinIn"),
    shotMaxIn: n("shotMaxIn"),
    gateTravelS: n("gateTravelS"),
    abortAtS: n("abortAtS"),
    legTimeoutS: n("legTimeoutS"),
    settleS: n("settleS"),
    readyTimeoutS: n("readyTimeoutS"),
    feedS: n("feedS"),
    shotAbandonS: n("shotAbandonS"),
    maxVel: n("maxVel"),
    accel: n("accel"),
    decel: n("decel"),
    latAccel: n("latAccel"),
    maxTurnDegS: n("maxTurnDegS"),
    cells: { RED: { far: { x: n("cellRedFarX"), y: n("cellRedFarY") }, audience: { x: n("cellRedAudienceX"), y: n("cellRedAudienceY") } } },
    wallMarginIn: n("wallMarginIn"),
    tinyMoveIn: n("tinyMoveIn"),
    intakeLeadMaxDeg: n("intakeLeadMaxDeg"),
    sharpTurnDeg: n("sharpTurnDeg"),
  };
}

// Facts whose values contradict each other (the prompt lint uses this too).
export function profileContradictions(facts: Record<string, Fact>): string[] {
  const out: string[] = [];
  const v = (k: string) => Number(facts[k]?.value);
  if (v("shotMinIn") >= v("shotMaxIn")) out.push("shotMinIn must be below shotMaxIn");
  if (v("yawMinDeg") >= v("yawMaxDeg")) out.push("yawMinDeg must be below yawMaxDeg");
  if (v("capacity") > 4) out.push("capacity above 4 breaks G407");
  if (v("preloadOnTiles") > v("preloadPollen")) out.push("more preload on the tiles than preload");
  if (v("abortAtS") > 30) out.push("abort after the 30 s auto ends");
  if (v("yawBackPerFront") === 0) out.push("yawBackPerFront cannot be 0");
  for (const k of ["maxVel", "accel", "decel", "latAccel", "maxTurnDegS", "feedS", "centerToFront", "centerToBack", "centerToLeft", "centerToRight"]) {
    if (!(v(k) > 0)) out.push(`${k} must be above 0`);
  }
  return out;
}
