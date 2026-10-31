import type { AutoSpec } from "../../src/shared/spec.ts";

// A plausible blue auto used by tests: preload shot, BLUE GARDEN intake, second shot, park.
// On the 141.17 in field: wall-flush poses 2.83 in in from the 144 ones, CELL-relative ones 1.415 in (the centre moved).
export function sampleSpec(): AutoSpec {
  return {
    specVersion: 2,
    name: "garden_4",
    drawnFor: "BLUE",
    start: "start",
    preload: { POLLEN: 4, NECTAR: 0, onTiles: 0 },
    poses: [
      { name: "start", x: 132.17, y: 70.585, headingDeg: 180, role: "waypoint", redTrim: [0, 0, 0] },
      { name: "shot1", x: 116.585, y: 88.585, headingDeg: 180, role: "waypoint", redTrim: [0, 0, 0] },
      { name: "gardenIn", x: 110, y: 131.67, headingDeg: 0, role: "waypoint", redTrim: [0, 0, 0] },
      { name: "gardenEnd", x: 131.17, y: 131.67, headingDeg: 0, role: "waypoint", redTrim: [0, 0, 0] },
      { name: "shot2", x: 116.585, y: 98.585, headingDeg: 180, role: "waypoint", redTrim: [0, 0, 0] },
      { name: "shot2Control", x: 122.585, y: 118.585, headingDeg: 0, role: "control", redTrim: [0, 0, 0] },
      { name: "park", x: 125.17, y: 36, headingDeg: 180, role: "waypoint", redTrim: [0, 0, 0] },
    ],
    legs: [
      { id: "L1", method: "startToShot1", path: { type: "line", from: "start", to: "shot1" }, heading: { mode: "linear", from: "start", to: "shot1" }, during: "NONE", end: "SHOOT", carryIntakeS: 0, legTimeoutS: null, junction: { source: "user", evidence: [] } },
      { id: "L2", method: "shot1ToGarden", path: { type: "line", from: "shot1", to: "gardenIn" }, heading: { mode: "linear", from: "shot1", to: "gardenIn" }, during: "NONE", end: "NONE", carryIntakeS: 0, legTimeoutS: null, junction: { source: "user", evidence: [] } },
      { id: "L3", method: "sweepGarden", path: { type: "line", from: "gardenIn", to: "gardenEnd" }, heading: { mode: "constant", pose: "gardenIn" }, during: "INTAKE", end: "NONE", carryIntakeS: 0.4, legTimeoutS: 3, junction: { source: "user", evidence: [] } },
      { id: "L4", method: "gardenToShot2", path: { type: "curve", from: "gardenEnd", controls: ["shot2Control"], to: "shot2" }, heading: { mode: "linear", from: "gardenEnd", to: "shot2" }, during: "NONE", end: "SHOOT", carryIntakeS: 0, legTimeoutS: null, junction: { source: "user", evidence: [] } },
      { id: "L5", method: "shot2ToPark", path: { type: "line", from: "shot2", to: "park" }, heading: { mode: "linear", from: "shot2", to: "park" }, during: "NONE", end: "PARK", carryIntakeS: 0, legTimeoutS: null, junction: { source: "user", evidence: [] } },
    ],
    opaque: [],
  };
}
