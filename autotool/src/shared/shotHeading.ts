// The robot heading for a shot so the turret reaches the CELL: the same rule as the robot's ShotHeading.best (robot
// repo, subsystems/ShotHeading.java, team 2026-11-05). The smallest turn from the drawn heading that leaves the back
// turret (both with "both") REACH_MARGIN_DEG inside its travel, the robot's outline no further past the walls than the
// drawn heading's. The robot also folds in its learned yaw corrections, which AutoTool cannot see: it may still turn
// a degree or two more at INIT. test/shotheading.test.ts checks this against the Java answers.

import { footprint } from "./geometry.ts";
import { FIELD } from "./season.ts";
import type { RobotModel } from "./profile.ts";
import { solveAim } from "./features.ts";

export const REACH_MARGIN_DEG = 10;
const RESOLUTION_DEG = 0.01;
const WALL_SLACK_IN = 0.25;

export type Need = "back" | "both";
export interface ShotHeadingPick {
  headingDeg: number; // the heading to shoot from (the drawn one when it already reaches)
  changeDeg: number; // turn from the drawn heading, + = counter-clockwise; 0 = as drawn
  frontMarginDeg: number; // each turret's margin inside its travel there (negative = cannot reach)
  backMarginDeg: number;
  ok: boolean; // false: no heading gives the needed turret(s) the margin
}

type Pose = { x: number; y: number; headingDeg: number };

export function margins(pose: Pose, model: RobotModel): { front: number; back: number } {
  const a = solveAim(pose, model);
  const m = (deg: number, l: { minDeg: number; maxDeg: number }) => Math.min(deg - l.minDeg, l.maxDeg - deg);
  return { front: m(a.frontYawDeg, model.yaw.front), back: m(a.backYawDeg, model.yaw.back) };
}

export function wallOverlap(pose: Pose, model: RobotModel): number {
  let worst = 0;
  for (const c of footprint(pose, model.body)) worst = Math.max(worst, -c.x, c.x - FIELD, -c.y, c.y - FIELD);
  return worst;
}

const wrap = (deg: number) => {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};

export function bestShotHeading(pose: Pose, model: RobotModel, need: Need = "back", margin = REACH_MARGIN_DEG): ShotHeadingPick {
  const wallLimit = wallOverlap(pose, model) + WALL_SLACK_IN;
  const good = (h: number) => {
    const p = { x: pose.x, y: pose.y, headingDeg: h };
    const m = margins(p, model);
    return (need === "both" ? Math.min(m.front, m.back) : m.back) >= margin && wallOverlap(p, model) <= wallLimit;
  };
  let change = 0;
  let ok = good(pose.headingDeg);
  if (!ok) {
    for (let d = 1; d <= 180 && !ok; d++) {
      for (const sign of [1, -1]) {
        if (d === 180 && sign < 0) continue;
        if (!good(pose.headingDeg + sign * d)) continue;
        let lo = d - 1;
        let hi = d;
        while (hi - lo > RESOLUTION_DEG) {
          const mid = (lo + hi) / 2;
          if (good(pose.headingDeg + sign * mid)) hi = mid;
          else lo = mid;
        }
        if (!ok || hi < Math.abs(change)) {
          change = sign * hi;
          ok = true;
        }
      }
    }
  }
  const headingDeg = wrap(pose.headingDeg + change);
  const m = margins({ ...pose, headingDeg }, model);
  return { headingDeg, changeDeg: change, frontMarginDeg: m.front, backMarginDeg: m.back, ok };
}
