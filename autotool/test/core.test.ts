import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeFeatures, poseAtTime, solveAim } from "../src/shared/features.ts";
import { bezierPoint, sampleBeziers, wrapDeg } from "../src/shared/geometry.ts";
import { equivalentJava, parseFile } from "../src/shared/java/lexer.ts";
import { importAutoPaths, renderAutoPaths } from "../src/shared/java/autorunner.ts";
import { autoStops, decideStop, legKey, stopKey } from "../src/shared/stops.ts";
import { defaultFacts, profileContradictions, robotModel } from "../src/shared/profile.ts";
import { type SeasonPack, validatePack } from "../src/shared/season.ts";
import { type AutoSpec, cloneSpec, stableStringify, validateSpec, writable } from "../src/shared/spec.ts";
import { readAuto, relevantVars, solveFor } from "../src/shared/java/reader.ts";
import { applyAssumptions, readToSpec } from "../src/shared/readspec.ts";
import { importAutoTool, renderAutoFile, routeNames, writeAutoFile } from "../src/shared/java/autorunner.ts";
import { addControl, insertStopBefore, moveStop, removeControl } from "../src/ui/edit.ts";
import { sampleSpec } from "./fixtures/sample.ts";

const here = new URL(".", import.meta.url).pathname;
const pack: SeasonPack = JSON.parse(readFileSync(`${here}../season/biobuzz-2026-27.json`, "utf8"));
const model = robotModel(defaultFacts());
const placeholder = readFileSync(`${here}fixtures/AutoPaths.placeholder.java.txt`, "utf8");

function tunedSymbols(): Map<string, number | null> {
  const src = readFileSync(`${here}fixtures/Tuned.java.txt`, "utf8");
  const m = new Map<string, number | null>();
  for (const x of src.matchAll(/public static double (\w+) = ([^;]+);/g)) m.set(`Tuned.${x[1]}`, x[2].trim() === "Double.NaN" ? null : Number(x[2]));
  return m;
}
const symbols = tunedSymbols();

test("season pack is complete and point-symmetric", () => {
  assert.deepEqual(validatePack(pack), []);
  assert.equal(pack.manual.version, "TU03");
});

test("profile defaults have no contradictions", () => {
  assert.deepEqual(profileContradictions(defaultFacts()), []);
});

test("geometry: bezier ends, line length, angle wrap", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 20 },
    { x: 30, y: 0 },
  ];
  assert.deepEqual(bezierPoint(pts, 0), { x: 0, y: 0 });
  assert.deepEqual(bezierPoint(pts, 1), { x: 30, y: 0 });
  const line = sampleBeziers([[{ x: 0, y: 0 }, { x: 30, y: 40 }]], 1);
  assert.ok(Math.abs(line.length - 50) < 1e-6);
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-180), 180);
});

test("aim: robot facing the CELL needs ~0 deg of turret; facing away is out of travel", () => {
  const facing = solveAim({ x: 118, y: 90, headingDeg: 187.95 }, model);
  assert.ok(Math.abs(facing.turretCmdDeg) < 1, `cmd ${facing.turretCmdDeg}`);
  assert.equal(facing.cell, "far");
  const away = solveAim({ x: 118, y: 90, headingDeg: 7.95 }, model);
  assert.equal(away.reachable, false);
});

test("features: sample auto has the expected stops, inventory and time", () => {
  const spec = sampleSpec();
  assert.deepEqual(validateSpec(spec), []);
  const f = computeFeatures(spec, pack, model);
  assert.ok(f.drawable);
  assert.deepEqual(Object.values(f.start!), [true, true, true, true, true, true]);
  const inv = f.junctions.map((j) => [j.inventory.before, j.inventory.after]);
  assert.deepEqual(inv, [
    [4, 0],
    [0, 0],
    [4, 4],
    [4, 0],
    [0, 0],
  ]);
  assert.deepEqual(f.legs[2].picked.map((p) => p.id).sort(), ["gB1", "gB2", "gB3", "gB4"]);
  assert.ok(f.timeline.nominalS > 8 && f.timeline.nominalS < 20, `time ${f.timeline.nominalS}`);
  assert.equal(f.problems.filter((p) => p.level === "error").length, 0);
  const mid = poseAtTime(f, f.legs[1].startS + f.legs[1].travelS / 2);
  assert.ok(mid && mid.legId === "L2");
});

const SAMPLE_LEGS = ["NONE/SHOOT", "NONE/NONE", "INTAKE/NONE", "NONE/SHOOT", "NONE/PARK"];

test("rubric: reproduces what the sample's legs do, also from an undecided drawing", () => {
  const spec = sampleSpec();
  const f = computeFeatures(spec, pack, model);
  assert.deepEqual(
    f.junctions.map((j) => stopKey(decideStop(j, f.legs[j.index], model))),
    SAMPLE_LEGS,
  );
  const drawn = cloneSpec(spec);
  for (const l of drawn.legs) {
    l.during = "NONE";
    l.end = "NONE";
    l.carryIntakeS = 0;
    l.junction = { source: "none", evidence: [] };
  }
  const r = autoStops(drawn, pack, model);
  assert.deepEqual(r.spec.legs.map(legKey), SAMPLE_LEGS);
});

test("rubric: empty preload is no shot, outside the zone never ends in SHOOT", () => {
  const spec = sampleSpec();
  spec.preload.POLLEN = 0;
  const f = computeFeatures(spec, pack, model);
  assert.notEqual(decideStop(f.junctions[0], f.legs[0], model).end, "SHOOT");
  const far = sampleSpec();
  far.poses.find((p) => p.name === "shot1")!.x = 140; // 55 in from the CELL, heading 180: still in band...
  far.poses.find((p) => p.name === "shot1")!.headingDeg = 0; // ...but facing away: turret cannot reach
  const f2 = computeFeatures(far, pack, model);
  assert.notEqual(decideStop(f2.junctions[0], f2.legs[0], model).end, "SHOOT");
});

test("adapter: the robot repo's placeholder AutoPaths round-trips byte for byte", () => {
  const r = importAutoPaths(placeholder, symbols);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) return;
  assert.equal(r.rendered, placeholder);
  assert.equal(r.spec.legs.length, 1);
  assert.equal(r.spec.legs[0].end, "PARK");
  assert.equal(r.spec.poses[0].x, null); // Tuned.blueStartX is NaN
  assert.equal(r.spec.poses[0].expr?.x, "Tuned.blueStartX");
});

test("adapter: moving one pose changes only that line", () => {
  const r = importAutoPaths(placeholder, symbols);
  assert.ok(r.ok);
  if (!r.ok) return;
  const s = cloneSpec(r.spec);
  const park = s.poses.find((p) => p.name === "park")!;
  park.x = 128;
  park.y = 36;
  park.headingDeg = 180;
  delete park.expr;
  const out = renderAutoPaths(s);
  const a = placeholder.split("\n");
  const b = out.split("\n");
  const changed = b.filter((l, i) => l !== a[i]);
  assert.ok(changed.some((l) => l.includes("poseFactory.of(128.0, 36.0, 180.0)")), out);
  // ready() now lists only the start pose's Tuned values
  assert.ok(out.includes("Tuned.blueStartHeading);") || out.includes("Tuned.blueStartHeading)"), out);
  assert.ok(!out.includes("Tuned.blueParkX"));
});

test("adapter: a new spec renders to Java that imports back to the same spec", () => {
  const spec = sampleSpec();
  const java = renderAutoPaths(spec);
  const r = importAutoPaths(java, symbols);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) return;
  assert.equal(r.rendered, java);
  // the leg is a direct copy: everything but the evidence (which stays in the tool) comes back
  const strip = (s: AutoSpec) => stableStringify({ poses: s.poses.map((p) => ({ ...p, comment: undefined })), legs: s.legs.map((l) => ({ ...l, junction: undefined })) });
  assert.equal(strip(r.spec), strip(spec));
});

const VARIANT = `package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.api.Paths;
import com.pedropathing.api.PoseFactory;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;

import org.firstinspires.ftc.teamcode.config.MatchState;

import java.util.List;

/* Close auto: preload, garden, park. */
public class AutoPaths {
    private final PoseFactory poseFactory = MatchState.poseFactory();

    // where we start
    private final Pose start = poseFactory.of(135, 72, 180);
    private final Pose shot1 = poseFactory.of(118.0, 90.0, 180.0);
    private final Pose bend = poseFactory.of(124, 120, 0);
    private final Pose garden = poseFactory.of(134.0, 134.5, 0.0);
    private final Pose park = poseFactory.of(144 - 16, 36, 180);
    private static final double SPARE = 2.5;

    public static boolean ready() {
        return true;
    }

    public Pose start() {
        return start;
    }

    public Path toShot() {
        return Paths.line(start, shot1).linear(start, shot1);
    }

    public Path sweep() {
        return Paths.curve(shot1, bend, garden).tangent();
    }

    public Path unused() {
        return Paths.line(shot1, park).constant(shot1);
    }

    private double helper(double v) {
        return v * SPARE; // custom code the tool must keep
    }

    public List<AutoRunner.Leg> legs() {
        return List.of(
                new AutoRunner.Leg(toShot(), AutoRunner.Action.SHOOT),
                // into the garden
                new AutoRunner.Leg(sweep(), AutoRunner.Action.INTAKE).carryIntake(0.4).timeout(3),
                new AutoRunner.Leg(shot1, AutoRunner.Action.SHOOT).timeout(2.5),
                new AutoRunner.Leg(Paths.line(shot1, park).linear(shot1, park), AutoRunner.Action.PARK));
    }
}
`;

test("adapter: variants (comments, List.of, option order, toPoint, inline, curve, expressions, opaque members) round-trip", () => {
  const r = importAutoPaths(VARIANT, symbols);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) return;
  assert.equal(r.rendered, VARIANT);
  assert.equal(r.spec.legs.length, 4);
  assert.deepEqual(
    r.spec.legs.map((l) => l.path.type),
    ["line", "curve", "toPoint", "line"],
  );
  assert.deepEqual(r.spec.legs[1].optOrder, ["carryIntake", "timeout"]);
  assert.deepEqual(r.spec.legs.map(stopKey), ["NONE/SHOOT", "INTAKE/NONE", "NONE/SHOOT", "NONE/PARK"]);
  assert.equal(r.spec.legs[1].comment, "// into the garden");
  assert.equal(r.spec.legs[3].inline, true);
  assert.equal(r.spec.poses.find((p) => p.name === "bend")!.role, "control");
  assert.equal(r.spec.poses.find((p) => p.name === "park")!.x, 128);
  assert.equal(r.spec.opaque.length, 3); // SPARE, unused(), helper()
  // editing a leg keeps the custom code
  const s = cloneSpec(r.spec);
  s.legs[2].legTimeoutS = 3.5;
  const out = renderAutoPaths(s);
  assert.ok(out.includes("return v * SPARE; // custom code the tool must keep"));
  assert.ok(out.includes(".timeout(3.5)"));
  assert.ok(equivalentJava(out, out).equal);
  assert.ok(!equivalentJava(out, VARIANT).equal);
  // a file written with the Action shortcut keeps it where it fits; a pair it cannot say is During/End
  s.legs[2].during = "INTAKE";
  const both = renderAutoPaths(s);
  assert.ok(both.includes("new AutoRunner.Leg(toShot(), AutoRunner.Action.SHOOT)"), both);
  assert.ok(both.includes("new AutoRunner.Leg(shot1, AutoRunner.During.INTAKE, AutoRunner.End.SHOOT).timeout(3.5)"), both);
});

test("adapter: unreadable legs fail with a line number instead of guessing", () => {
  const bad = VARIANT.replace("new AutoRunner.Leg(toShot(), AutoRunner.Action.SHOOT)", "new AutoRunner.Leg(mystery(), AutoRunner.Action.SHOOT)");
  const r = importAutoPaths(bad, symbols);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.errors[0].message, /mystery\(\)/);
  assert.ok(r.errors[0].line > 1);
  const heading = VARIANT.replace(".tangent()", ".heading(Interpolator.tangent)");
  const r2 = importAutoPaths(heading, symbols);
  assert.equal(r2.ok, false);
});

test("lexer: member splitting handles initializer braces and blocks", () => {
  const f = parseFile(`package a;\nclass X {\n  int[] a = {1, 2};\n  Runnable r = new Runnable() { public void run() {} };\n  static { System.out.println(1); }\n  void m() { if (true) { } }\n}\n`);
  assert.deepEqual(
    f.members.map((m) => [m.kind, m.name]),
    [
      ["field", "a"],
      ["field", "r"],
      ["other", ""],
      ["method", "m"],
    ],
  );
});

test("spec: a leg can collect on the way and shoot at the end; options must fit the leg", () => {
  const spec = sampleSpec();
  spec.legs[0].during = "INTAKE";
  assert.ok(writable(validateSpec(spec)));
  const carry = sampleSpec();
  carry.legs[0].carryIntakeS = 0.5; // during NONE: nothing to carry
  assert.ok(validateSpec(carry).some((x) => x.code === "leg.carry" && x.level === "error"));
  const wait = sampleSpec();
  wait.legs[1].end = "WAIT"; // no time given
  assert.ok(validateSpec(wait).some((x) => x.code === "leg.wait" && x.level === "error"));
  wait.legs[1].waitS = 1.5;
  assert.ok(writable(validateSpec(wait)));
  const review = sampleSpec();
  review.legs[1].junction.review = true;
  assert.equal(writable(validateSpec(review)), false);
});

test("adapter: a new auto written over the placeholder keeps the helper, drops stale imports, compiles-shaped", () => {
  const r = importAutoPaths(placeholder, symbols);
  assert.ok(r.ok);
  if (!r.ok) return;
  const s = sampleSpec();
  s.java = r.spec.java; // what the server's prepareForWrite carries over from the file on disk
  s.opaque = r.spec.opaque;
  const out = renderAutoPaths(s);
  assert.ok(!out.includes("import org.firstinspires.ftc.teamcode.config.Tuned;"), "stale Tuned import kept");
  assert.ok(out.includes("DECODE 19859 needed 1-3 in"), "the team's redTrim comment was lost");
  assert.match(out, /poseFactory\(\);\n\n {4}private final Pose start/);
  assert.match(out, /public static boolean ready\(\) \{\n {8}return true;/);
  const back = importAutoPaths(out, symbols);
  assert.ok(back.ok && back.rendered === out);
});

test("features: an auto past the abort time is cut where AutoRunner cuts it, as a warning", () => {
  const s = sampleSpec();
  // a slow robot: every leg takes far longer
  const slow = robotModel({ ...defaultFacts(), maxVel: { ...defaultFacts().maxVel, value: 6 } });
  const f = computeFeatures(s, pack, slow);
  assert.ok(f.timeline.nominalS > slow.abortAtS);
  const cut = f.legs.filter((l) => l.cut !== "none").map((l) => l.id);
  assert.ok(cut.length > 0 && cut.includes("L5"));
  const p = f.problems.find((x) => x.code === "time.abort");
  assert.ok(p && p.level === "warning", JSON.stringify(f.problems));
  assert.ok(!f.problems.some((x) => x.code === "time.auto"));
});

test("edit: several control points per leg, Pedro style: Paths.curve(a, c1, c2, c3, b), imports back, removable", () => {
  let s = sampleSpec();
  for (let i = 0; i < 3; i++) s = addControl(s, "L1");
  const leg = s.legs.find((l) => l.id === "L1")!;
  assert.equal(leg.path.type, "curve");
  const controls = leg.path.type === "curve" ? leg.path.controls : [];
  assert.equal(controls.length, 3);
  const java = renderAutoPaths(s);
  assert.ok(java.includes(`Paths.curve(start, ${controls.join(", ")}, shot1)`), java);
  const back = importAutoPaths(java, new Map());
  assert.ok(back.ok);
  const bl = back.ok ? back.spec.legs[0].path : null;
  assert.deepEqual(bl && bl.type === "curve" ? bl.controls : null, controls);
  const f = computeFeatures(s, pack, model);
  assert.ok(f.geometry[0].drawable && f.geometry[0].length > 0);
  s = removeControl(s, "L1", controls[1]);
  const mid = s.legs[0].path;
  assert.deepEqual(mid.type === "curve" ? mid.controls : null, [controls[0], controls[2]]);
  assert.ok(!s.poses.some((p) => p.name === controls[1]));
  s = removeControl(removeControl(s, "L1", controls[0]), "L1", controls[2]);
  assert.equal(s.legs[0].path.type, "line");
});

test("one file per auto: Blue and Red OpModes, AutoTool writes only between the route markers", () => {
  const n = routeNames("Near", "9");
  const spec = { ...sampleSpec(), name: "close_9" };
  spec.legs[2] = { ...spec.legs[2], end: "SHOOT" }; // collect on the way, shoot at the end
  spec.legs[1] = { ...spec.legs[1], end: "WAIT", waitS: 1.5 };
  spec.legs[3] = { ...spec.legs[3], during: "RAMP", carryRampS: 0.8 };
  const java = renderAutoFile(spec, n, "BIOBUZZ TeleOp");
  assert.match(java, /public class Near_9 \{/);
  assert.match(java, /@Autonomous\(name = "Blue_Near_9", group = "AutoTool", preselectTeleOp = "BIOBUZZ TeleOp"\)\n {4}public static class Blue extends AutoRunner/);
  assert.match(java, /@Autonomous\(name = "Red_Near_9"[^)]*\)\n {4}public static class Red extends Blue/);
  assert.ok(java.includes("new Leg(sweepGarden(), During.INTAKE, End.SHOOT).timeout(3.0).carryIntake(0.4)"), java);
  assert.ok(java.includes("new Leg(shot1ToGarden(), During.NONE, End.WAIT).waitFor(1.5)"), java);
  assert.ok(java.includes("During.RAMP, End.SHOOT).carryRamp(0.8)"), java);
  // the leg is a direct copy both ways
  const back = importAutoTool(java, new Map());
  assert.ok(back.ok, JSON.stringify(!back.ok && back.errors));
  if (!back.ok) return;
  assert.equal(back.spec.name, "close_9");
  const legs = (x: AutoSpec) => stableStringify(x.legs.map((l) => ({ ...l, junction: undefined })));
  assert.equal(legs(back.spec), legs(spec));
  // the team's code outside the markers survives a rewrite; the route inside is replaced
  const custom = java.replace("    static class Plan implements Route {", "    // our own helper\n    static int laps = 2;\n\n    static class Plan implements Route {");
  const moved = cloneSpec(spec);
  moved.poses.find((p) => p.name === "park")!.x = 126;
  const again = writeAutoFile(custom, moved, n, null);
  assert.ok(again.includes("static int laps = 2;"));
  assert.ok(again.includes("poseFactory.of(126.0, 36.0, 180.0)"));
  assert.equal(again.replace(/poseFactory\.of\(126\.0/, "poseFactory.of(128.0"), custom);
  // code put inside the markers would be lost on the next write: reading refuses it
  const stray = java.replace("        public Pose start() {", "        int extra = 1;\n\n        public Pose start() {");
  const bad = importAutoTool(stray, new Map());
  assert.equal(bad.ok, false);
  // an auto from before the one-file format (Blue_Near_9.java with a nested Plan, Action legs) still reads
  const old = `package org.firstinspires.ftc.teamcode.opmodes;\n\n// AutoTool auto: close_9\npublic class Blue_Near_9 extends AutoRunner {\n    static class Plan implements Route {\n        private final PoseFactory poseFactory = MatchState.poseFactory();\n        private final Pose a = poseFactory.of(130.0, 60.0, 180.0);\n        private final Pose b = poseFactory.of(118.0, 90.0, 180.0);\n\n        public boolean isReady() {\n            return true;\n        }\n\n        public Pose start() {\n            return a;\n        }\n\n        public Path ab() {\n            return Paths.line(a, b).linear(a, b);\n        }\n\n        public List<AutoRunner.Leg> legs() {\n            return Arrays.asList(new Leg(ab(), Action.INTAKE), new Leg(a, Action.PARK));\n        }\n    }\n}\n`;
  const o = importAutoTool(old, new Map());
  assert.ok(o.ok, JSON.stringify(!o.ok && o.errors));
  assert.deepEqual(o.ok ? o.spec.legs.map(stopKey) : null, ["INTAKE/NONE", "NONE/PARK"]);
});

test("reader: an AutoRunner route with helper methods, unset Tuned values, every leg and action", () => {
  const files = [
    { path: "Tuned.java", text: "public class Tuned {\n  public static double sx = Double.NaN, sy = Double.NaN, sh = Double.NaN, px = Double.NaN, py = Double.NaN, ph = Double.NaN;\n}" },
    {
      path: "Route.java",
      text: `public class Route {
  private final PoseFactory poseFactory = MatchState.poseFactory();
  private final Pose start = along(0);
  private final Pose mid = along(0.5);
  private final Pose park = along(1);
  private Pose along(double t) {
    return redTrim(poseFactory.of(Tuned.sx + t * (Tuned.px - Tuned.sx), Tuned.sy + t * (Tuned.py - Tuned.sy), Tuned.sh + t * (Tuned.ph - Tuned.sh)), 0, 0, 0);
  }
  private static Pose redTrim(Pose pose, double dx, double dy, double dh) {
    if (MatchState.alliance != MatchState.Alliance.RED) return pose;
    return new Pose(pose.x() + dx, pose.y() + dy, pose.heading());
  }
  public Pose start() { return start; }
  private static Path line(Pose a, Pose b) { return Paths.line(a, b).linear(a, b); }
  public List<AutoRunner.Leg> legs() {
    return Arrays.asList(
        new AutoRunner.Leg(line(start, mid), AutoRunner.Action.SHOOT),
        new AutoRunner.Leg(line(mid, park), AutoRunner.During.RAMP, AutoRunner.End.WAIT).timeout(4).carryIntake(0.5).waitFor(1).carryRamp(0.7),
        new AutoRunner.Leg(park, AutoRunner.Action.PARK));
  }
}`,
    },
    { path: "MatchState.java", text: "public class MatchState {\n  public enum Alliance { BLUE, RED }\n  public static Alliance alliance = Alliance.BLUE;\n  public static PoseFactory poseFactory() { return alliance == Alliance.RED ? PoseFactory.degrees().mirrorAroundPoint(72, 72) : PoseFactory.degrees(); }\n}" },
  ];
  const r = readAuto(files, "Route.java");
  assert.equal(r.framework, "AutoRunner legs");
  assert.deepEqual(r.steps.map((s) => `${s.during}/${s.end}`), ["NONE/SHOOT", "RAMP/WAIT", "NONE/PARK"]);
  assert.deepEqual([r.steps[1].timeoutS, r.steps[1].carryS], [4, 0.5]);
  assert.equal(r.start?.name, "start");
  assert.deepEqual(r.unknowns.sort(), ["Tuned.ph", "Tuned.px", "Tuned.py", "Tuned.sh", "Tuned.sx", "Tuned.sy"]);
  const spec = readToSpec(r, "sample", "Route.java");
  assert.deepEqual(spec.legs.map(stopKey), ["NONE/SHOOT", "RAMP/WAIT", "NONE/PARK"]);
  assert.deepEqual([spec.legs[1].waitS, spec.legs[1].carryIntakeS, spec.legs[1].carryRampS], [1, 0.5, 0.7]);
  // unset start and park get a first guess, so everything draws at once; the rest follows from them
  assert.deepEqual(spec.reader!.guessed!.sort(), ["Tuned.ph", "Tuned.px", "Tuned.py", "Tuned.sh", "Tuned.sx", "Tuned.sy"]);
  assert.ok(spec.poses.every((p) => p.x !== null && p.y !== null && p.headingDeg !== null));
  const start = spec.poses.find((p) => p.name === "start")!;
  const park = spec.poses.find((p) => p.name === "park")!;
  assert.equal(start.src, "along(0)"); // the code's own words, not the helper's body
  // along(1) = start + 1 * (park - start) moves only with park
  assert.deepEqual(relevantVars(park.formula!.x), ["Tuned.px"]);
  // dragging start and park moves the pose between them
  const env = { ...spec.assume! };
  for (const [p, x] of [[start, 130], [park, 100]] as const) {
    const e = { ...env };
    delete e[relevantVars(p.formula!.x)[0]];
    const r = solveFor(p.formula!.x, x, e);
    assert.ok(r);
    env[r!.name] = r!.value;
  }
  assert.equal(applyAssumptions({ ...spec, assume: env }).poses.find((p) => p.name === "mid")!.x, 115);
});

test("reader: an FTCLib command auto with constants in another file, path chains and timed steps", () => {
  const files = [
    { path: "K.java", text: "public class K {\n  public static Pose START = new Pose(18.4, 123.5, Math.toRadians(-48));\n  public static Pose SHOOT = new Pose(48.7, 97.7, Math.toRadians(180));\n  public static Pose ROW_END = new Pose(20, 64.5, Math.toRadians(180));\n  public static Pose ROW_CTRL = new Pose(48, 52);\n}" },
    { path: "Chains.java", text: "public class Chains {\n  PathChain ROW;\n  public Chains(Follower f) {\n    ROW = f.pathBuilder().addPath(new BezierCurve(new Pose(K.SHOOT.getX(), K.SHOOT.getY()), new Pose(K.ROW_CTRL.getX(), K.ROW_CTRL.getY()), new Pose(K.ROW_END.getX(), K.ROW_END.getY()))).setLinearHeadingInterpolation(K.SHOOT.getHeading(), K.ROW_END.getHeading()).addPath(new BezierLine(new Pose(K.ROW_END.getX(), K.ROW_END.getY()), new Pose(K.SHOOT.getX(), K.SHOOT.getY()))).build();\n  }\n  public PathChain getROW() { return ROW; }\n}" },
    { path: "DrivePointToPoint.java", text: "public class DrivePointToPoint extends CommandBase {\n  public DrivePointToPoint(Object f, Pose a, Pose b) { }\n}" },
    {
      path: "Auto.java",
      text: `import static K.START;
@Autonomous
public class Auto extends OpMode {
  Chains chains;
  public void init() { follower.setStartingPose(START.copy()); chains = new Chains(follower); }
  public void start() {
    CommandScheduler.getInstance().schedule(new SequentialCommandGroup(
        new InstantCommand(() -> robot.intake.gateOpen()),
        new DrivePointToPoint(follower, K.START, K.SHOOT),
        new InstantCommand(() -> robot.intake.intakeFire(0.8)),
        new WaitCommand(350),
        new ParallelCommandGroup(
            new FollowPathCommand(follower, chains.getROW()),
            new SequentialCommandGroup(new WaitCommand(150), new InstantCommand(() -> robot.intake.intakeIn()))),
        new InstantCommand(() -> robot.intake.intakeFire(0.8))));
  }
}`,
    },
  ];
  const r = readAuto(files, "Auto.java");
  assert.equal(r.framework, "FTCLib commands");
  const spec = readToSpec(r, "decode", "Auto.java");
  assert.equal(spec.start, "START");
  assert.deepEqual(spec.legs.map((l) => [l.path.type, stopKey(l)]), [["line", "NONE/SHOOT"], ["curve", "INTAKE/NONE"], ["line", "INTAKE/SHOOT"]]); // the intake still runs on the way back, then it fires
  const rowEnd = spec.poses.find((p) => p.name === "ROW_END")!;
  assert.deepEqual([rowEnd.x, rowEnd.y, rowEnd.headingDeg], [20, 64.5, 180]); // the heading comes from the constant, not the rebuilt copy
  assert.ok(spec.legs[0].steps!.some((s) => s.when === "before" && /gateOpen/.test(s.text)));
  assert.ok(spec.legs[1].steps!.some((s) => s.when === "during" && s.ms === 150 && /intakeIn/.test(s.text)));
  assert.equal(validateSpec(spec).filter((p) => p.level === "error").length, 0);
});

test("leg options (timeout, carryIntake, shotTimeout, waitFor) round-trip, read back and time right", () => {
  const s = sampleSpec();
  s.legs[1] = { ...s.legs[1], end: "WAIT", waitS: 2 };
  s.legs[3] = { ...s.legs[3], shotTimeoutS: 3 };
  const java = renderAutoPaths(s);
  assert.ok(java.includes("During.INTAKE, AutoRunner.End.NONE).timeout(3.0).carryIntake(0.4)") || java.includes("During.INTAKE, End.NONE).timeout(3.0).carryIntake(0.4)"), java);
  assert.ok(java.includes("End.WAIT).waitFor(2.0)"), java);
  assert.ok(java.includes("End.SHOOT).shotTimeout(3.0)"), java);
  const back = importAutoPaths(java, new Map());
  assert.ok(back.ok, JSON.stringify(!back.ok && back.errors));
  if (back.ok) {
    assert.deepEqual([back.spec.legs[1].end, back.spec.legs[1].waitS, back.spec.legs[3].shotTimeoutS], ["WAIT", 2, 3]);
    assert.equal(renderAutoPaths(back.spec), java);
  }
  // the reader sees them too (hand-written code)
  const r = readAuto([{ path: "AutoPaths.java", text: java }], "AutoPaths.java");
  assert.deepEqual(r.steps[1].opts, { waitS: 2 });
  assert.deepEqual(r.steps[3].opts, { shotTimeoutS: 3 });
  // timing: the WAIT adds its 2 s
  const f0 = computeFeatures(sampleSpec(), pack, model);
  const f1 = computeFeatures(s, pack, model);
  assert.ok(f1.timeline.nominalS >= f0.timeline.nominalS + 2);
});

test("stops: one slotted in between, stops moved with what they do; persistent intake round-trips", () => {
  const s = sampleSpec();
  s.legs[2] = { ...s.legs[2], during: "RAMP" };
  // slot a stop in before L2: halfway along it
  const ins = insertStopBefore(s, "L2")!;
  assert.equal(ins.spec.legs.length, 6);
  assert.equal(ins.legId, "L2");
  assert.equal(ins.spec.legs[1].path.to, ins.spec.legs[2].path.type === "toPoint" ? "" : (ins.spec.legs[2].path as { from: string }).from);
  // move the park stop to the front: the stops keep what they do
  const moved = moveStop(s, 4, 0);
  assert.equal(moved.legs[0].path.to, "park");
  assert.equal(moved.legs[0].end, "PARK");
  assert.equal(moved.legs[3].during, "RAMP");
  // persistent intake: written as intakeAlways() in the route, read back by the importer and the reader
  const n = routeNames("Near", "9");
  const java = renderAutoFile({ ...s, name: "close_9", intakeAlways: true }, n, null);
  assert.ok(/public boolean intakeAlways\(\) \{\s*return true;/.test(java), java);
  assert.ok(java.includes("During.RAMP, End.NONE"));
  const back = importAutoTool(java, new Map());
  assert.ok(back.ok && back.spec.intakeAlways === true);
  const r = readAuto([{ path: "Near_9.java", text: java }], "Near_9.java");
  assert.equal(r.intakeAlways, true);
  const f = computeFeatures({ ...s, intakeAlways: true }, pack, model);
  assert.ok(f.legs.every((l) => l.intakeRuns));
  // persistent intake: only legs set to intake are checked for the intake leading
  const always = computeFeatures({ ...sampleSpec(), intakeAlways: true }, pack, model);
  assert.deepEqual(always.legs.map((l) => l.intakeLeads !== null), sampleSpec().legs.map((l) => l.during !== "NONE"));
});

// The robot repo's own AutoRunner and its sample route, copied from the robot repo (refresh with the cp lines in
// test/fixtures/robot/README.txt after the robot's Leg changes). The reader opens the real Leg class here, which
// it does not when only the route file is given.
const robotFiles = (): { path: string; text: string }[] => [
  { path: "AutoRunner.java", text: readFileSync(`${here}fixtures/robot/AutoRunner.java.txt`, "utf8") },
  { path: "SampleAutoPaths.java", text: readFileSync(`${here}fixtures/robot/SampleAutoPaths.java.txt`, "utf8") },
];

test("reader: the robot's sample route, with the real Leg class, is read exactly (options on the right field)", () => {
  const r = readAuto(robotFiles(), "SampleAutoPaths.java", "SampleAutoPaths");
  const legs = r.steps.filter((s) => s.kind === "drive");
  assert.deepEqual(legs.map((s) => `${s.during}/${s.end}`), ["NONE/SHOOT", "INTAKE/WAIT", "INTAKE/SHOOT", "RAMP/NONE", "NONE/PARK"]);
  // .timeout(4).waitFor(0.5) | .shotTimeout(3) is not the leg timeout | .timeout(4).carryIntake(0.5)
  assert.deepEqual(legs.map((s) => s.timeoutS), [undefined, 4, undefined, 4, undefined]);
  assert.deepEqual(legs.map((s) => s.carryS), [undefined, undefined, undefined, 0.5, undefined]);
  assert.deepEqual(legs.map((s) => s.opts), [undefined, { waitS: 0.5 }, { shotTimeoutS: 3 }, undefined, undefined]);
  const spec = readToSpec(r, "SampleAutoPaths", "SampleAutoPaths.java");
  assert.deepEqual(spec.legs.map((l) => [l.legTimeoutS, l.carryIntakeS, l.waitS, l.shotTimeoutS]), [
    [null, 0, undefined, undefined],
    [4, 0, 0.5, undefined],
    [null, 0, undefined, 3],
    [4, 0.5, undefined, undefined],
    [null, 0, undefined, undefined],
  ]);
});

// Runs only when AUTOTOOL_ROBOT_REPO points at the robot repo: the live route must read the way its Java says.
test("reader: the live robot repo's default route reads without guesses (AUTOTOOL_ROBOT_REPO)", { skip: !process.env.AUTOTOOL_ROBOT_REPO }, async () => {
  const { RobotRepo } = await import("../src/server/repo.ts");
  const { readRepoAuto } = await import("../src/server/ingest.ts");
  const repo = RobotRepo.open(process.env.AUTOTOOL_ROBOT_REPO!);
  const spec = readRepoAuto(repo, repo.autoPathsRel(), "AutoPaths");
  assert.ok(spec && spec.legs.length > 0);
  const java = repo.readText(repo.autoPathsRel()).replace(/\/\/.*$/gm, ""); // without comments
  const written = (java.match(/new (?:AutoRunner\.)?Leg\(/g) ?? []).length;
  assert.equal(spec!.legs.length, written);
});

test("features: a RAMP leg takes POLLEN from a FLOWER stack, an INTAKE leg does not, a short RAMP leg says how far", () => {
  const withRamp = (during: "RAMP" | "INTAKE", reachIn: number) => {
    const s = sampleSpec();
    s.preload.POLLEN = 0;
    const p = s.poses.find((x) => x.name === "shot1")!;
    Object.assign(p, { x: 129, y: 96, headingDeg: 0 }); // 12.5 in from the F3 stack at (141.46, 96)
    Object.assign(s.poses.find((x) => x.name === "start")!, { x: 110, y: 96, headingDeg: 0 }); // a straight approach
    s.legs[0] = { ...s.legs[0], during, end: "NONE" };
    const facts = defaultFacts();
    facts.rampReachIn.value = reachIn;
    facts.intakeReachIn.value = reachIn;
    return computeFeatures(s, pack, robotModel(facts));
  };
  const ok = withRamp("RAMP", 4);
  assert.equal(ok.legs[0].picked.length, 4);
  assert.ok(ok.legs[0].picked.every((x) => !x.confirmed), "a stack is unconfirmed until the ramp is measured");
  assert.equal(ok.junctions[0].inventory.after, 4);
  assert.ok(ok.junctions[0].flags.some((f) => /FLOWER by the ramp/.test(f)), ok.junctions[0].flags.join("|"));
  const intake = withRamp("INTAKE", 4);
  assert.equal(intake.legs[0].picked.length, 0);
  assert.deepEqual(intake.legs[0].flowerReached, ["F3s"]);
  const short = withRamp("RAMP", 0);
  assert.equal(short.legs[0].picked.length, 0);
  assert.ok(short.junctions[0].flags.some((f) => /RAMP leg takes nothing: it ends 12\.5 in from the FLOWER F3/.test(f)), short.junctions[0].flags.join("|"));
});

test("ramp: AutoRunner's commands at the servo's travel time; late, waited-for, never out; positions; R105", async () => {
  const { rampOutAt } = await import("../src/shared/features.ts");
  // reversing mid-swing turns back from where it is
  const moves = [
    { t: 0, out: true, why: "", legId: null },
    { t: 0.2, out: false, why: "", legId: null },
  ];
  assert.ok(Math.abs(rampOutAt(moves, 0.5, 0.2) - 0.4) < 1e-9);
  assert.ok(Math.abs(rampOutAt(moves, 0.5, 0.3) - 0.2) < 1e-9);
  assert.equal(rampOutAt(moves, 0.5, 1), 0);

  // a RAMP leg straight at the F3 stack: start `fromX`, stop at x = 129 (the ramp reaches it, the intake does not)
  const run = (fromX: number, end: "NONE" | "WAIT" | "SHOOT", waitS: number | null, set: Record<string, number | string> = {}) => {
    const s = sampleSpec();
    s.preload.POLLEN = 0;
    Object.assign(s.poses.find((x) => x.name === "shot1")!, { x: 129, y: 96, headingDeg: 0 });
    Object.assign(s.poses.find((x) => x.name === "start")!, { x: fromX, y: 96, headingDeg: 0 });
    s.legs[0] = { ...s.legs[0], during: "RAMP", end, ...(waitS !== null ? { waitS } : {}) };
    const facts = defaultFacts();
    facts.rampReachIn.value = 4;
    facts.intakeReachIn.value = 1;
    facts.rampTravelS.value = 0.55;
    for (const [k, v] of Object.entries(set)) facts[k].value = v;
    return computeFeatures(s, pack, robotModel(facts));
  };
  // a long approach: out before it gets there, so it takes the stack
  const far = run(110, "NONE", null);
  assert.equal(far.legs[0].picked.length, 4);
  assert.deepEqual(far.ramp.moves.map((m) => `${m.legId}:${m.out ? "out" : "in"}`), ["L1:out", "L2:in"]);
  assert.equal(far.ramp.moves[0].t, 0);
  // it folds RAMP_CARRY_S into L2 (the robot backs out of the FLOWER first), not the moment L1 ends
  assert.ok(Math.abs(far.ramp.moves[1].t - (far.legs[1].startS + 0.5)) < 1e-9, JSON.stringify(far.ramp.moves));
  assert.equal(far.ramp.moves[1].why, "L1's ramp folds 0.5 s into L2");
  assert.equal(far.legs[1].ramp.atStart, 1);
  // carryRamp on the leg overrides the default; 0 folds it the moment the next leg starts
  const carried = run(110, "NONE", null);
  const longer = (() => {
    const s = sampleSpec();
    s.preload.POLLEN = 0;
    Object.assign(s.poses.find((x) => x.name === "shot1")!, { x: 129, y: 96, headingDeg: 0 });
    Object.assign(s.poses.find((x) => x.name === "start")!, { x: 110, y: 96, headingDeg: 0 });
    s.legs[0] = { ...s.legs[0], during: "RAMP", end: "NONE", carryRampS: 1.2 };
    return computeFeatures(s, pack, model);
  })();
  assert.ok(Math.abs(longer.ramp.moves[1].t - (longer.legs[1].startS + 1.2)) < 1e-9);
  assert.ok(carried.ramp.moves[1].t < longer.ramp.moves[1].t);
  assert.equal(far.legs[0].ramp.outAtS, 0.55);
  assert.equal(far.legs[0].ramp.atArrival, 1);
  // a 2 in hop gets there in about 0.5 s: the ramp is not out yet, and L2 folds it back in
  const near = run(127, "NONE", null);
  assert.ok(near.legs[0].ramp.atArrival < 1 && near.legs[0].ramp.atArrival > 0.8, String(near.legs[0].ramp.atArrival));
  assert.equal(near.legs[0].picked.length, 0);
  assert.deepEqual(near.legs[0].ramp.late, ["F3s"]);
  assert.ok(near.problems.some((p) => p.code === "ramp.late" && p.where === "leg:L1"), near.problems.map((p) => p.code).join(","));
  // ...a WAIT long enough lets it come out and take the stack, at the moment it is out
  const waited = run(127, "WAIT", 0.3);
  assert.equal(waited.legs[0].picked.length, 4);
  assert.equal(waited.legs[0].picked[0].atS, 0.55);
  assert.deepEqual(waited.legs[0].ramp.late, []);
  assert.ok(!waited.problems.some((p) => p.code.startsWith("ramp.late")));
  // ...a SHOOT ending a RAMP leg keeps it out through the shot (it folds once L2 has backed away)
  const shot = run(127, "SHOOT", null);
  assert.ok(shot.legs[0].ramp.outAtS !== null, JSON.stringify(shot.legs[0].ramp));
  assert.ok(Math.abs(shot.ramp.moves[1].t - (shot.legs[1].startS + 0.5)) < 1e-9);
  // a SHOOT on the next (not RAMP) leg folds it at its path end if the carry is still running
  const s3 = sampleSpec();
  s3.legs[0] = { ...s3.legs[0], during: "RAMP", end: "NONE", carryRampS: 3 };
  s3.legs[1] = { ...s3.legs[1], end: "SHOOT" };
  const shotNext = computeFeatures(s3, pack, model);
  const next = shotNext.legs[1];
  assert.ok(next.travelS < 3, String(next.travelS));
  assert.ok(Math.abs(shotNext.ramp.moves[1].t - (next.startS + next.travelS)) < 1e-9, JSON.stringify(shotNext.ramp.moves));
  assert.equal(shotNext.ramp.moves[1].why, "L2 stows it to shoot");
  // the robot never moves it until program 4 has put both positions in the code
  assert.ok(far.problems.some((p) => p.code === "ramp.positions"));
  assert.ok(!run(110, "NONE", null, { rampPositions: "set" }).problems.some((p) => p.code === "ramp.positions"));
  // out, the ramp makes the robot longer: over 18 x 24 in breaks R105
  assert.ok(!far.problems.some((p) => p.code === "rule.R105"));
  const long = run(110, "NONE", null, { rampReachIn: 7 });
  assert.equal(long.ramp.expanded?.lengthIn, 25);
  assert.ok(long.problems.some((p) => p.code === "rule.R105" && p.level === "error"));
  // a RAMP leg that starts at an odd time (after a shot): out 0.55 s after its own start, never "never out"
  const s2 = sampleSpec();
  s2.legs[1] = { ...s2.legs[1], during: "RAMP" };
  const odd = computeFeatures(s2, pack, model);
  const l2 = odd.legs[1];
  assert.ok(l2.startS % 0.001 > 1e-6, String(l2.startS));
  assert.ok(Math.abs(l2.ramp.outAtS! - (Math.round((l2.startS + 0.55) * 100) / 100)) < 1e-9, JSON.stringify(l2.ramp));
  assert.ok(!odd.problems.some((p) => p.code === "ramp.neverOut"), odd.problems.map((p) => p.message).join("|"));
  // an auto without a RAMP leg never moves it
  const none = computeFeatures(sampleSpec(), pack, model);
  assert.equal(none.ramp.used, false);
  assert.deepEqual(none.ramp.moves, []);
});

test("partner: two autos of one alliance run together; collisions, near misses, shared elements, one-click fixes", async () => {
  const { DEFAULT_PARTNER, compareRuns, findFix, partnerModel, addWait } = await import("../src/shared/compare.ts");
  const ours = sampleSpec();
  const fo = computeFeatures(ours, pack, model);
  const pm = partnerModel(model, DEFAULT_PARTNER);
  // a partner that stays in its own corner: never close
  const corner: AutoSpec = {
    ...sampleSpec(),
    name: "corner",
    start: "s",
    poses: [
      { name: "s", x: 108, y: 9, headingDeg: 90, role: "waypoint" },
      { name: "e", x: 108, y: 14, headingDeg: 90, role: "waypoint" },
    ],
    legs: [{ id: "L1", method: "se", path: { type: "line", from: "s", to: "e" }, heading: { mode: "linear", from: "s", to: "e" }, during: "NONE", end: "PARK", carryIntakeS: 0, legTimeoutS: null, junction: { source: "user", evidence: [] } }],
  };
  const clear = compareRuns(fo, model, computeFeatures(corner, pack, pm), pm, DEFAULT_PARTNER);
  assert.deepEqual(clear.conflicts.filter((c) => c.kind !== "start"), []);
  assert.ok(clear.closest!.gapIn > DEFAULT_PARTNER.marginIn);
  // the same route as ours: the starts overlap, they collide, and both pick up the same GARDEN POLLEN
  const same = compareRuns(fo, model, computeFeatures(sampleSpec(), pack, pm), pm, DEFAULT_PARTNER);
  assert.equal(same.conflicts[0].kind, "start");
  assert.ok(same.conflicts.some((c) => c.kind === "elements" && /gB1/.test(c.text)));
  // a partner that starts 11 s late cuts across our park leg: one collision, on our L5, and a WAIT on L3 clears it
  const crossing: AutoSpec = {
    ...corner,
    poses: [
      { name: "s", x: 135, y: 60, headingDeg: 180, role: "waypoint" },
      { name: "e", x: 104, y: 24, headingDeg: 225, role: "waypoint" },
    ],
  };
  const opts = { ...DEFAULT_PARTNER, delayS: 11 };
  const tf = computeFeatures(crossing, pack, pm);
  const run = compareRuns(fo, model, tf, pm, opts);
  const hits = run.conflicts.filter((c) => c.kind === "collision" || c.kind === "nearMiss");
  assert.equal(hits.length, 1, JSON.stringify(run.conflicts));
  assert.deepEqual([hits[0].kind, hits[0].ourLeg, hits[0].theirLeg], ["collision", "L5", "L1"]);
  const fix = findFix(ours, model, tf, pm, pack, opts, hits[0]);
  assert.ok(fix.kind === "wait" && fix.legId === "L3" && fix.addS > 0, JSON.stringify(fix));
  if (fix.kind === "wait") {
    assert.deepEqual([fix.spec.legs[2].end, fix.spec.legs[2].waitS], ["WAIT", fix.addS]);
    const after = compareRuns(computeFeatures(fix.spec, pack, model), model, tf, pm, opts);
    assert.deepEqual(after.conflicts.filter((c) => c.kind === "collision" || c.kind === "nearMiss"), []);
  }
  // a WAIT fix goes on a leg that can hold: NONE becomes WAIT, a WAIT gets longer, SHOOT/PARK legs cannot
  assert.equal(addWait(ours, "L1", 1), null);
  const w = addWait(ours, "L2", 0.5)!;
  assert.deepEqual([w.legs[1].end, w.legs[1].waitS], ["WAIT", 0.5]);
  assert.equal(addWait(w, "L2", 0.25)!.legs[1].waitS, 0.75);
});

test("points: LEAVE, PARK and HIVE TIP by Table 10-2; the CELL that faces down scores nothing; the alliance shares the HIVE", async () => {
  const { autoPoints } = await import("../src/shared/points.ts");
  const f = computeFeatures(sampleSpec(), pack, model);
  const p = autoPoints(pack, f);
  // 4 preload POLLEN into the up-facing (NECTAR) CELL tip it at L1; L4 then launches at the CELL that faces down
  assert.deepEqual([p.leave, p.park, p.tipPoints, p.total], [3, 5, 20, 28]);
  assert.deepEqual(p.tips.map((t) => t.legId), ["L1"]);
  assert.deepEqual(p.perLeg, { L1: 20, L5: 8 });
  assert.ok(p.notes.some((n) => /L4: launches at the far CELL, which faces down/.test(n)), p.notes.join("\n"));
  // no preload: nothing to launch, no TIP
  const empty = sampleSpec();
  empty.preload = { POLLEN: 0, NECTAR: 0, onTiles: 0 };
  const pe = autoPoints(pack, computeFeatures(empty, pack, model));
  assert.equal(pe.tipPoints, 20); // the GARDEN POLLEN picked on L3 still reach the up CELL at L4
  assert.deepEqual(pe.tips.map((t) => t.legId), ["L4"]);
  // a park outside the LOADING ZONE and an auto cut by the abort time lose PARK
  const out = sampleSpec();
  out.poses.find((x) => x.name === "park")!.x = 100;
  assert.equal(autoPoints(pack, computeFeatures(out, pack, model)).park, 0);
  const slow = robotModel({ ...defaultFacts(), maxVel: { ...defaultFacts().maxVel, value: 6 } });
  const ps = autoPoints(pack, computeFeatures(sampleSpec(), pack, slow));
  assert.equal(ps.park, 0);
  // two robots of one alliance: LEAVE and PARK each, one HIVE (the second robot's shot at the turned-over CELL scores nothing)
  const both = autoPoints(pack, f, { features: f, delayS: 0 });
  assert.deepEqual([both.leave, both.park, both.tipPoints, both.total], [6, 10, 20, 36]);
});

test("profile merge: code values confirm themselves; the team is asked only about assumed values and its own overrides", async () => {
  const { mergeFacts } = await import("../src/server/ingest.ts");
  const base = defaultFacts();
  const f = (key: string, over: Partial<(typeof base)[string]>) => ({ ...base[key], ...over });
  const old = {
    abortAtS: f("abortAtS", { value: 28.5, status: "code", repoValue: 28.5, confirmed: true }),
    legTimeoutS: f("legTimeoutS", { value: 6, status: "user", repoValue: 7, confirmed: true }),
    settleS: f("settleS", { value: 0.3, status: "code", repoValue: 0.3, confirmed: true }),
    feedS: f("feedS", { value: 0.55, status: "code", repoValue: 0.55, confirmed: true }),
  };
  const fresh = {
    abortAtS: f("abortAtS", { value: 28, status: "code", repoValue: 28, confirmed: false }), // the code changed it
    legTimeoutS: f("legTimeoutS", { value: 8, status: "code", repoValue: 8, confirmed: false }), // the code changed what the team overrode
    settleS: f("settleS", { value: 0.3, status: "assumed", repoValue: undefined, confirmed: false }), // the code no longer has it
    feedS: f("feedS", { value: 0.55, status: "code", repoValue: 0.55, confirmed: false }), // unchanged
  };
  const r = mergeFacts(old, fresh);
  assert.deepEqual([r.facts.abortAtS.value, r.facts.abortAtS.confirmed], [28, true]);
  assert.deepEqual([r.facts.legTimeoutS.value, r.facts.legTimeoutS.status, r.facts.legTimeoutS.confirmed], [6, "user", false]);
  assert.deepEqual([r.facts.settleS.status, r.facts.settleS.confirmed], ["assumed", false]);
  assert.equal(r.facts.feedS.confirmed, true);
  assert.deepEqual(r.changed.map((c) => [c.key, c.needsYou]), [["abortAtS", false], ["legTimeoutS", true], ["settleS", true]]);
  // a fact a newer AutoTool reads (here the ramp travel time) is in use at once and announced, not a new setup
  const added = mergeFacts(old, { ...fresh, rampTravelS: f("rampTravelS", { status: "assumed", confirmed: false }) });
  assert.equal(added.facts.rampTravelS.confirmed, true);
  assert.deepEqual(added.changed.find((c) => c.key === "rampTravelS"), { key: "rampTravelS", label: "Ramp travel time (folded in to out)", from: "new", to: "assumed 0.55 s", needsYou: false });
  // the first scan confirms nothing by itself (setup asks once)
  assert.equal(mergeFacts(undefined, fresh).facts.abortAtS.confirmed, false);
});
