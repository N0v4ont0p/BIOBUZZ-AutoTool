import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Digest, yamlConstants } from "../src/server/digest.ts";
import { factsFromDigest } from "../src/server/ingest.ts";
import { computeFeatures } from "../src/shared/features.ts";
import { defaultFacts, robotModel } from "../src/shared/profile.ts";
import type { SeasonPack } from "../src/shared/season.ts";
import { sampleSpec } from "./fixtures/sample.ts";

const here = new URL(".", import.meta.url).pathname;
const pack: SeasonPack = JSON.parse(readFileSync(`${here}../season/biobuzz-2026-27.json`, "utf8"));

// the entries as team-config.yaml writes them (flow mappings under tuning: <section>:)
const YAML = (v: string) => `tuning_constants:
  intake:
    intakeReachIn: {value: ${v}, origin: untuned, source: asked, confirmed: true, units: in}
    intakeWidthIn: {value: ${v === "null" ? "null" : "14"}, origin: untuned, source: asked, confirmed: true, units: in}
    elementsPerShot: {value: null, origin: untuned, source: asked, confirmed: true, units: count}
  drive_motion:
    driveAccelInS2: {value: ${v === "null" ? "null" : "48.5"}, origin: untuned, source: asked, confirmed: true, units: in/s^2}
`;

const digestOf = (cfg: string): Digest => {
  const constants: Digest["constants"] = {};
  for (const c of yamlConstants(cfg)) constants[c.name] = c;
  return { constants, shotTables: { front: { rows: 0, min: null, max: null, line: null }, back: { rows: 0, min: null, max: null, line: null } }, facts: [], symbols: {}, files: [] } as unknown as Digest;
};

test("team-config entries only AutoTool reads: null stays assumed, a number becomes a measured fact", () => {
  const empty = yamlConstants(YAML("null"));
  assert.deepEqual(empty.map((c) => [c.name, c.value]), [["Config.intakeReachIn", null], ["Config.intakeWidthIn", null], ["Config.elementsPerShot", null], ["Config.driveAccelInS2", null]]);
  assert.equal(empty[0].line, 3);
  const f0 = factsFromDigest(digestOf(YAML("null")), pack);
  assert.equal(f0.intakeReachIn.status, "assumed");
  assert.match(f0.intakeReachIn.source, /team-config\.yaml:3 intakeReachIn is not filled in yet/);

  const f1 = factsFromDigest(digestOf(YAML("5.5")), pack);
  assert.deepEqual([f1.intakeReachIn.value, f1.intakeReachIn.status], [5.5, "measured"]);
  assert.deepEqual([f1.intakeWidthIn.value, f1.accel.value, f1.accel.status], [14, 48.5, "measured"]);
  assert.equal(f1.elementsPerShot.value, "all"); // blank = all held
  assert.equal(f1.decel.value, 30); // not in the yaml sample: the default stays
});

test("the intake mouth width and reach decide what an INTAKE leg picks up", () => {
  const picked = (width: number) => {
    const s = sampleSpec();
    const facts = defaultFacts();
    facts.intakeWidthIn.value = width;
    return computeFeatures(s, pack, robotModel(facts)).legs.reduce((n, l) => n + l.picked.length, 0);
  };
  assert.ok(picked(18) >= picked(2), "a narrower mouth never picks up more");
  assert.ok(picked(18) > 0);
});
