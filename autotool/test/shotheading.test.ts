import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { solveAim } from "../src/shared/features.ts";
import { defaultFacts, robotModel } from "../src/shared/profile.ts";
import { bestShotHeading } from "../src/shared/shotHeading.ts";
import { fixShotHeadings } from "../src/ui/edit.ts";

// The robot's own answers (robot repo: ShotHeadingParityTest writes this fixture from subsystems/ShotHeading.java):
// AutoTool must turn every shot exactly as the robot will at INIT.
const here = new URL(".", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(`${here}fixtures/shotheading.json`, "utf8"));

function fixtureModel() {
  const facts = defaultFacts();
  const set = (k: string, v: number) => (facts[k].value = v);
  const m = fx.model;
  set("frontPivotX", m.frontPivot[0]);
  set("frontPivotY", m.frontPivot[1]);
  set("backPivotX", m.backPivot[0]);
  set("backPivotY", m.backPivot[1]);
  set("frontYawMinDeg", m.front[0]);
  set("frontYawMaxDeg", m.front[1]);
  set("frontYawCenterDeg", m.front[2]);
  set("backYawMinDeg", m.back[0]);
  set("backYawMaxDeg", m.back[1]);
  set("backYawCenterDeg", m.back[2]);
  set("centerToFront", m.body[0]);
  set("centerToBack", m.body[1]);
  set("centerToLeft", m.body[2]);
  set("centerToRight", m.body[3]);
  set("teammateGoals", 1);
  set("teammateRedX", m.redGoal[0]);
  set("teammateRedFarY", m.redGoal[1]);
  set("teammateRedAudienceY", m.redGoal[2]);
  return robotModel(facts);
}

test("shot headings: the same turn as the robot for every fixture pose", () => {
  const model = fixtureModel();
  assert.ok(fx.cases.length > 100);
  for (const c of fx.cases) {
    const p = bestShotHeading({ x: c.x, y: c.y, headingDeg: c.h }, model, c.need);
    const where = `(${c.x}, ${c.y}, ${c.h}) ${c.need}`;
    assert.equal(p.ok, c.ok, where);
    assert.ok(Math.abs(p.changeDeg - c.change) <= 0.02, `${where}: turn ${p.changeDeg} vs the robot's ${c.change}`);
    assert.ok(Math.abs(p.backMarginDeg - c.back) <= 0.02, `${where}: back margin ${p.backMarginDeg} vs ${c.back}`);
    assert.ok(Math.abs(p.frontMarginDeg - c.front) <= 0.02, `${where}: front margin ${p.frontMarginDeg} vs ${c.front}`);
  }
});

test("turrets: 0 is straight back, so facing the CELL is out of the back turret's reach", () => {
  const model = fixtureModel();
  // blue audience goal = the red far one turned: (141.17 - 60, 141.17 - 91)
  const goal = { x: 141.17 - 60, y: 141.17 - 91 };
  const at = { x: goal.x, y: goal.y - 40 };
  const facing = solveAim({ ...at, headingDeg: 90 }, model);
  const backTo = solveAim({ ...at, headingDeg: -90 }, model);
  assert.equal(facing.backReachable, false);
  assert.equal(backTo.backReachable, true);
  assert.ok(Math.abs(backTo.backYawDeg) < 1);
});

test("Fix shot headings draws the robot's turn, rounded away from the drawn heading", () => {
  const model = fixtureModel();
  const feats = {
    junctions: [{ id: "L1", end: "SHOOT", headingInDeg: 90, target: { headingFixDeg: 12.34 } }],
  } as unknown as Parameters<typeof fixShotHeadings>[1];
  const spec = {
    legs: [{ id: "L1", end: "SHOOT", path: { type: "line", from: "a", to: "b" }, heading: { mode: "linear", from: "a", to: "b" } }],
    poses: [{ name: "a", x: 1, y: 1, headingDeg: 0, role: "waypoint" }, { name: "b", x: 2, y: 2, headingDeg: 90, role: "waypoint" }],
  } as unknown as Parameters<typeof fixShotHeadings>[0];
  const r = fixShotHeadings(spec, feats);
  assert.deepEqual(r.fixed, ["L1 +12.4 deg"]);
  assert.equal(r.spec.poses.find((p) => p.name === "b")?.headingDeg, 102.4);
  void model;
});

test("shot flags: .keepHeading() / .bothTurrets() round-trip; the hand-written reader still reads the leg", async () => {
  const { renderAutoPaths, importAutoPaths } = await import("../src/shared/java/autorunner.ts");
  const { readAuto } = await import("../src/shared/java/reader.ts");
  const { sampleSpec } = await import("./fixtures/sample.ts");
  const s = sampleSpec();
  s.legs[0] = { ...s.legs[0], keepHeading: true };
  s.legs[3] = { ...s.legs[3], bothTurrets: true, shotTimeoutS: 3 };
  const java = renderAutoPaths(s);
  assert.ok(/End\.SHOOT\)\.keepHeading\(\)/.test(java), java);
  assert.ok(/End\.SHOOT\)\.shotTimeout\(3\.0\)\.bothTurrets\(\)/.test(java), java);
  const back = importAutoPaths(java, new Map());
  assert.ok(back.ok, JSON.stringify(!back.ok && back.errors));
  if (back.ok) {
    assert.deepEqual([back.spec.legs[0].keepHeading, back.spec.legs[3].bothTurrets, back.spec.legs[3].shotTimeoutS], [true, true, 3]);
    assert.equal(renderAutoPaths(back.spec), java);
  }
  const r = readAuto([{ path: "AutoPaths.java", text: java }], "AutoPaths.java");
  assert.equal(r.steps.length, s.legs.length);
});
