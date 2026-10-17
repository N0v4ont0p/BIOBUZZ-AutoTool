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
  { key: "nectarMax", label: "Most NECTAR held", value: 2, unit: "NECTAR", group: "robot", note: "NECTAR is the backup; POLLEN (back launcher) comes first" },
  { key: "pollenWithNectar", label: "Most POLLEN held with NECTAR aboard", value: 2, unit: "POLLEN", group: "robot", note: "4 POLLEN with no NECTAR, or at most 2 NECTAR + 2 POLLEN" },
  { key: "preloadPollen", label: "Preload POLLEN", value: 4, unit: "POLLEN", group: "auto" },
  { key: "preloadOnTiles", label: "Preload placed on the tiles (TU03)", value: 0, unit: "POLLEN", group: "auto" },
  { key: "intakeEnd", label: "Intake end of the robot", value: "front", unit: "", group: "robot" },
  { key: "intakeMotors", label: "Intake motors", value: 2, unit: "motors", group: "robot", note: "the main intake (also feeds NECTAR to the front launcher) and the POLLEN feeder (2 wheels feeding the back launcher): collecting and firing POLLEN run both, firing NECTAR runs the main intake" },
  { key: "intakeReachIn", label: "Intake reach past the front edge", value: 2, unit: "in", group: "robot" },
  { key: "intakeWidthIn", label: "Intake mouth width", value: 18, unit: "in", group: "robot", note: "the part of the front that takes elements; the full robot width until the CAD gives it" },
  { key: "rampReachIn", label: "Ramp reach past the front edge (deployed)", value: 2, unit: "in", group: "robot", note: "same as the intake until the CAD gives the ramp length (R105: the ramp stays inside 18 x 24 in)" },
  { key: "rampOutS", label: "Ramp time, stowed to fully out", value: 0.55, unit: "s", group: "robot", note: "2 continuous servos wind the strings; AutoRunner runs them this long (program 4 times it from slow motion)" },
  { key: "rampInS", label: "Ramp time, fully out to stowed", value: 0.55, unit: "s", group: "robot", note: "program 4 times it from slow motion" },
  { key: "rampHoldPower", label: "Ramp holding power while stowed", value: "not set", unit: "power", group: "robot", note: "keeps the stowed ramp up (gravity would let it sag into the field); shown only, AutoTool does not model it" },
  { key: "rampCarryS", label: "Ramp stays out into the next leg", value: 0.5, unit: "s", group: "auto", note: "AutoRunner folds the ramp this long after the next leg starts, so the robot backs out of the FLOWER first; Leg.carryRamp(s) sets it per leg" },
  { key: "elementsPerShot", label: "Elements one SHOOT sends", value: "all", unit: "", group: "shooter", note: "AutoRunner feeds for FEED_S with both gates open" },
  { key: "centerToFront", label: "Robot centre to front edge", value: 9, unit: "in", group: "robot" },
  { key: "centerToBack", label: "Robot centre to back edge", value: 9, unit: "in", group: "robot" },
  { key: "centerToLeft", label: "Robot centre to left edge", value: 9, unit: "in", group: "robot" },
  { key: "centerToRight", label: "Robot centre to right edge", value: 9, unit: "in", group: "robot" },
  { key: "frontPivotX", label: "Front turret pivot x (forward)", value: 0, unit: "in", group: "shooter" },
  { key: "frontPivotY", label: "Front turret pivot y (left)", value: 0, unit: "in", group: "shooter" },
  { key: "backPivotX", label: "Back turret pivot x (forward)", value: 0, unit: "in", group: "shooter" },
  { key: "backPivotY", label: "Back turret pivot y (left)", value: 0, unit: "in", group: "shooter" },
  { key: "frontYawMinDeg", label: "Front turret travel, right limit", value: -90, unit: "deg", group: "shooter" },
  { key: "frontYawMaxDeg", label: "Front turret travel, left limit", value: 90, unit: "deg", group: "shooter" },
  { key: "backYawMinDeg", label: "Back turret travel, right limit", value: -90, unit: "deg", group: "shooter" },
  { key: "backYawMaxDeg", label: "Back turret travel, left limit", value: 90, unit: "deg", group: "shooter" },
  { key: "yawDegPerS", label: "Turret turn speed (the slower turret)", value: "not set", unit: "deg/s", group: "shooter", note: "each turret has its own servo and aims on its own; until program 3 times it the shot time has no turret wait" },
  { key: "frontLaunchDeg", label: "Front launch angle (fixed, no hood)", value: "not set", unit: "deg", group: "shooter" },
  { key: "backLaunchDeg", label: "Back launch angle (fixed, no hood)", value: "not set", unit: "deg", group: "shooter" },
  { key: "frontReleaseHeightIn", label: "Front release height", value: "not set", unit: "in", group: "shooter", note: "element centre at release, above the floor" },
  { key: "backReleaseHeightIn", label: "Back release height", value: "not set", unit: "in", group: "shooter", note: "element centre at release, above the floor" },
  { key: "shotMinIn", label: "Shortest shot in the shot table", value: 30, unit: "in", group: "shooter" },
  { key: "shotMaxIn", label: "Longest shot in the shot table", value: 100, unit: "in", group: "shooter" },
  { key: "gateTravelS", label: "Gate open time", value: 0.25, unit: "s", group: "shooter", note: "the slowest of the 3 gate servos (front gate, and the back gate's 2 mirrored servos)" },
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
  { key: "cellHeightIn", label: "CELL opening centre height", value: 46, unit: "in", group: "field", note: "the launch angle reach check aims at it" },
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
  out.cellHeightIn.status = "pack";
  out.cellHeightIn.source = "simulator: sim/src/org/biobuzz/sim/phys/Shots.java:263 field.cellZ is 44-48 in (CELL opening centre); the middle";
  for (const k of ["wallMarginIn", "tinyMoveIn", "intakeLeadMaxDeg", "sharpTurnDeg"]) {
    out[k].status = "assumed";
    out[k].source = "rubric threshold, tuned by evaluation";
  }
  return out;
}

export interface RobotModel {
  capacity: number;
  nectarMax: number;
  pollenWithNectar: number;
  preloadPollen: number;
  preloadOnTiles: number;
  intakeEnd: "front" | "back";
  intakeReachIn: number;
  intakeWidthIn: number;
  rampReachIn: number;
  rampOutS: number;
  rampInS: number;
  rampCarryS: number; // AutoRunner.RAMP_CARRY_S: default delay before the ramp folds in the leg after a RAMP leg
  rampCalibrated: boolean; // Tuned.rampOutS and rampInS set: AutoRunner can move the ramp
  elementsPerShot: number; // Infinity = all held
  body: { front: number; back: number; left: number; right: number };
  frontPivot: { x: number; y: number };
  backPivot: { x: number; y: number };
  yaw: { front: { minDeg: number; maxDeg: number }; back: { minDeg: number; maxDeg: number } };
  yawDegPerS: number; // NaN = not timed yet
  launch: { front: { deg: number; releaseIn: number }; back: { deg: number; releaseIn: number } }; // NaN = not in the CAD yet
  cellHeightIn: number;
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
  // facts that may be unknown: NaN, and the model says what it cannot compute
  const opt = (k: string): number => {
    const v = Number(facts[k]?.value);
    return Number.isFinite(v) ? v : NaN;
  };
  const inCode = (k: string) => typeof facts[k]?.repoValue === "number";
  const eps = facts.elementsPerShot?.value;
  return {
    capacity: n("capacity"),
    nectarMax: n("nectarMax"),
    pollenWithNectar: n("pollenWithNectar"),
    preloadPollen: n("preloadPollen"),
    preloadOnTiles: n("preloadOnTiles"),
    intakeEnd: facts.intakeEnd?.value === "back" ? "back" : "front",
    intakeReachIn: n("intakeReachIn"),
    intakeWidthIn: n("intakeWidthIn"),
    rampReachIn: n("rampReachIn"),
    rampOutS: n("rampOutS"),
    rampInS: n("rampInS"),
    rampCarryS: n("rampCarryS"),
    rampCalibrated: inCode("rampOutS") && inCode("rampInS"),
    elementsPerShot: eps === "all" || eps === undefined ? Infinity : Number(eps),
    body: { front: n("centerToFront"), back: n("centerToBack"), left: n("centerToLeft"), right: n("centerToRight") },
    frontPivot: { x: n("frontPivotX"), y: n("frontPivotY") },
    backPivot: { x: n("backPivotX"), y: n("backPivotY") },
    yaw: { front: { minDeg: n("frontYawMinDeg"), maxDeg: n("frontYawMaxDeg") }, back: { minDeg: n("backYawMinDeg"), maxDeg: n("backYawMaxDeg") } },
    yawDegPerS: opt("yawDegPerS"),
    launch: { front: { deg: opt("frontLaunchDeg"), releaseIn: opt("frontReleaseHeightIn") }, back: { deg: opt("backLaunchDeg"), releaseIn: opt("backReleaseHeightIn") } },
    cellHeightIn: opt("cellHeightIn"),
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
  for (const t of ["front", "back"]) if (v(`${t}YawMinDeg`) >= v(`${t}YawMaxDeg`)) out.push(`${t}YawMinDeg must be below ${t}YawMaxDeg`);
  if (v("capacity") > 4) out.push("capacity above 4 breaks G407");
  if (v("preloadOnTiles") > v("preloadPollen")) out.push("more preload on the tiles than preload");
  if (v("abortAtS") > 30) out.push("abort after the 30 s auto ends");
  for (const k of ["maxVel", "accel", "decel", "latAccel", "maxTurnDegS", "feedS", "rampOutS", "rampInS", "centerToFront", "centerToBack", "centerToLeft", "centerToRight"]) {
    if (!(v(k) > 0)) out.push(`${k} must be above 0`);
  }
  return out;
}
