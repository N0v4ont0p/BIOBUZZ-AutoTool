// Picks the prompt's examples by script: every kind of leg decision, easy and hard geometry, positives and
// negatives, from the TRAIN split only (validation and test autos never appear in the prompt).
// Written exactly in the output format, in a stable order. Run: node eval/examples.ts

import { readFileSync, writeFileSync } from "node:fs";
import { computeFeatures } from "../src/shared/features.ts";
import { decideStop, evidenceFor, stopKey } from "../src/shared/stops.ts";
import type { AutoSpec } from "../src/shared/spec.ts";
import { cloneSpec, withStop } from "../src/shared/spec.ts";
import type { PromptExample } from "../src/server/ai/prompt.ts";
import { evidenceLines } from "../src/server/ai/tools.ts";
import { type EvalCase, model, pack } from "./generate.ts";

const here = new URL(".", import.meta.url).pathname;

// decisions applied in route order up to (not including) leg i, so the evidence matches what
// get_features prints when the model reaches that junction
function upTo(spec: AutoSpec, i: number): AutoSpec {
  let s = cloneSpec(spec);
  for (let k = 0; k < i; k++) {
    const f = computeFeatures(s, pack, model);
    const j = f.junctions.find((x) => x.id === s.legs[k].id)!;
    const d = decideStop(j, f.legs[k], model);
    s.legs[k] = withStop(s.legs[k], d.during, d.end, "ai", [], { review: d.review });
  }
  return s;
}

interface Want {
  title: string;
  kind: "positive" | "negative";
  want: string; // "during/end", or "review"
  caseKind: EvalCase["kind"][];
  pred?: (c: EvalCase, i: number) => boolean;
  reason: string;
}

const WANT: Want[] = [
  { title: "a shot from the zone with the preload", kind: "positive", want: "NONE/SHOOT", caseKind: ["synthetic"], pred: (_c, i) => i === 0, reason: "In the zone, both turrets reach the CELL, holding the preload: end SHOOT." },
  { title: "looks like a shot, but neither turret can reach the CELL", kind: "negative", want: "NONE/NONE", caseKind: ["perturbed"], pred: (c) => c.id.endsWith("_turret"), reason: "In the distance band but the CELL is outside both turrets' travel, so AutoRunner would skip the shot: end NONE, not SHOOT." },
  { title: "the leg into the GARDEN runs over POLLEN", kind: "positive", want: "INTAKE/NONE", caseKind: ["synthetic"], reason: "The leg sweeps floor POLLEN and the robot held fewer than capacity when it started: during INTAKE." },
  { title: "the last stop is in the LOADING ZONE", kind: "positive", want: "NONE/PARK", caseKind: ["synthetic"], reason: "Last leg, footprint partly in the LOADING ZONE: end PARK." },
  { title: "imported code that does not shoot where it could", kind: "positive", want: "review", caseKind: ["abstention"], reason: "In the zone and holding elements, but the code has no shot here: possible missed shot, so review." },
  { title: "in the zone but holding 0", kind: "negative", want: "NONE/NONE", caseKind: ["perturbed"], pred: (c) => c.id.endsWith("_empty"), reason: "In the zone but holding 0 elements: a shot would be empty, so end NONE, not SHOOT." },
];

const cases: EvalCase[] = JSON.parse(readFileSync(`${here}cases.json`, "utf8"));
const train = cases.filter((c) => c.split === "train");
const out: PromptExample[] = [];
const used = new Set<string>();
for (const w of WANT) {
  let found: PromptExample | null = null;
  for (const c of train.filter((x) => w.caseKind.includes(x.kind) && !used.has(x.group ?? x.id))) {
    for (let i = 0; i < c.spec.legs.length && !found; i++) {
      if (w.pred && !w.pred(c, i)) continue;
      const s = c.kind === "abstention" ? c.spec : upTo(c.spec, i);
      const f = computeFeatures(s, pack, model);
      const j = f.junctions.find((x) => x.id === s.legs[i].id);
      if (!j) continue;
      const d = decideStop(j, f.legs[i], model);
      if ((d.review ? "review" : stopKey(d)) !== w.want) continue;
      const line = evidenceLines(f, model, false).split("\n").find((l) => l.startsWith(`${j.id} `))!;
      found = { title: w.title, kind: w.kind, features: line, answer: [{ junction: j.id, evidence: evidenceFor(j, f.legs[i], model), during: d.during, end: d.end, ...(d.review ? { review: true } : {}), reason: w.reason }] };
      used.add(c.group ?? c.id);
    }
    if (found) break;
  }
  if (!found) throw new Error(`no train example for: ${w.title}`);
  out.push(found);
}
writeFileSync(`${here}examples.json`, JSON.stringify(out, null, 1) + "\n");
console.log(out.map((e, i) => `${i + 1}. ${e.kind} ${e.answer[0].during}/${e.answer[0].end}: ${e.title}`).join("\n"));
