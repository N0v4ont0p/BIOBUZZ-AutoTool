import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Store } from "../src/server/store.ts";
import { sampleSpec } from "./fixtures/sample.ts";

const here = new URL(".", import.meta.url).pathname;
const TOKEN = "test-token-0123456789";
const PORT = 4700 + Math.floor(Math.random() * 90);
let srv: ChildProcess;
let repoRoot: string;
let cfgDir: string;
let partnersDir: string;

const RUNNER = `package org.firstinspires.ftc.teamcode.opmodes;
public abstract class AutoRunner {
    public enum During { NONE, INTAKE, RAMP }
    public enum End { NONE, SHOOT, PARK, WAIT }
    public enum Action { NONE, INTAKE, RAMP, SHOOT, PARK }
    private static final double ABORT_AT_S = 28.5;
    protected abstract MatchState.Alliance alliance();

    public void init() {
        if (!AutoPaths.ready()) {
            problem = "auto poses not set";
            return;
        }
        AutoPaths paths = new AutoPaths();
        start(paths.start());
    }
}
`;

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "autotool-srv-repo-"));
  const base = join(root, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode");
  mkdirSync(join(base, "opmodes"), { recursive: true });
  mkdirSync(join(base, "config"), { recursive: true });
  writeFileSync(join(base, "opmodes", "AutoRunner.java"), RUNNER);
  writeFileSync(join(base, "opmodes", "AutoPaths.java"), readFileSync(`${here}fixtures/AutoPaths.placeholder.java.txt`, "utf8"));
  writeFileSync(join(base, "config", "Tuned.java"), readFileSync(`${here}fixtures/Tuned.java.txt`, "utf8"));
  return root;
}

// raw HTTP so the Host header can be set (fetch forbids it)
function call(method: string, path: string, opts: { body?: unknown; token?: string | null; host?: string; origin?: string; type?: string } = {}): Promise<{ status: number; json: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? "" : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${PORT}` };
    if (opts.token !== null) headers["x-autotool-token"] = opts.token ?? TOKEN;
    if (opts.origin) headers.origin = opts.origin;
    if (data) {
      headers["content-type"] = opts.type ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(data));
    }
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        let j: unknown = null;
        try {
          j = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json: j, text: t });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

before(async () => {
  repoRoot = fixtureRepo();
  const cfg = mkdtempSync(join(tmpdir(), "autotool-srv-cfg-"));
  cfgDir = cfg;
  partnersDir = mkdtempSync(join(tmpdir(), "autotool-srv-partners-"));
  srv = spawn(process.execPath, [`${here}../src/server/main.ts`, "--repo", repoRoot, "--port", String(PORT), "--token", TOKEN], { env: { ...process.env, AUTOTOOL_CONFIG_DIR: cfg, AUTOTOOL_PARTNERS_DIR: partnersDir }, stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await call("GET", "/api/state");
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => srv.kill());

test("security: token, host, origin and JSON-only checks", async () => {
  assert.equal((await call("GET", "/api/state", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/state", { token: "wrong-token-0123456789" })).status, 401);
  assert.equal((await call("GET", "/api/state", { host: "evil.example:80" })).status, 421);
  assert.equal((await call("GET", "/api/state", { host: `localhost:${PORT}` })).status, 200);
  assert.equal((await call("GET", "/api/state", { origin: "http://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/ingest", { body: "a=1", type: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await call("POST", "/api/key", { body: { key: "not-a-key" } })).status, 400);
  // the API never returns a key
  const s = (await call("GET", "/api/state")).json as { key: { set: boolean; last4: string | null; workspace: string | null } };
  assert.deepEqual(s.key, { set: false, last4: null, workspace: null });
});

test("onboarding: scan imports the placeholder auto and builds the profile", async () => {
  const r = await call("POST", "/api/ingest", { body: {} });
  assert.equal(r.status, 200, r.text);
  const j = r.json as { autos: { ok: boolean }[]; state: { onboarding: Record<string, boolean>; unconfirmedFacts: number; ai: { enabled: boolean; why: string } } };
  assert.equal(j.autos[0].ok, true);
  assert.equal(j.state.onboarding.scanned, true);
  assert.equal(j.state.onboarding.profileConfirmed, false);
  assert.ok(j.state.unconfirmedFacts > 0);
  assert.equal(j.state.ai.enabled, false);
  assert.match(j.state.ai.why, /Claude account or add an API key/);
  const fact = await call("PUT", "/api/profile/fact", { body: { key: "capacity", value: 3, confirmed: true } });
  assert.equal(fact.status, 200);
  const bad = await call("PUT", "/api/profile/fact", { body: { key: "shotMinIn", value: 500 } });
  assert.equal(bad.status, 400); // contradicts shotMaxIn
  assert.equal((await call("POST", "/api/profile/confirm-all", { body: {} })).status, 200);
  const st = (await call("GET", "/api/state")).json as { onboarding: Record<string, boolean>; profile: { facts: Record<string, { value: unknown; status: string }> } };
  assert.equal(st.onboarding.profileConfirmed, true);
  assert.equal(st.profile.facts.capacity.value, 3);
  assert.equal(st.profile.facts.capacity.status, "user");
  const exp = (await call("GET", "/api/profile/export")).text;
  assert.ok(!/sk-ant/.test(exp));
});

test("autos: autolabel decides a drawing's legs, the sample route is never rewritten", async () => {
  const autos = (await call("GET", "/api/autos")).json as { name: string }[];
  assert.deepEqual(autos.map((a) => a.name), ["AutoPaths"]);
  const spec = sampleSpec();
  for (const l of spec.legs) Object.assign(l, { during: "NONE", end: "NONE", junction: { source: "none", evidence: [] } });
  const lab = (await call("POST", "/api/autolabel", { body: { spec } })).json as { spec: { legs: { during: string; end: string }[] } };
  assert.deepEqual(lab.spec.legs.map((l) => `${l.during}/${l.end}`), ["NONE/SHOOT", "NONE/NONE", "INTAKE/NONE", "NONE/SHOOT", "NONE/PARK"]);
  const prev = (await call("POST", "/api/preview", { body: { spec: { ...sampleSpec(), name: "AutoPaths" } } })).json as { writable: boolean; file: string; note: string };
  assert.equal(prev.writable, false);
  assert.match(prev.note, /sample auto/);
  const ff = await call("POST", "/api/features", { body: { spec: sampleSpec() } });
  assert.equal(ff.status, 200);
  // AI endpoints refuse cleanly without a key
  const ai = await call("POST", "/api/ai/annotate", { body: { spec: sampleSpec() } });
  assert.equal(ai.status, 409);
});

test("static: nothing outside the built UI is served", async () => {
  for (const path of ["/../../etc/passwd", "/..%2f..%2f..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/hosts"]) {
    const r = await call("GET", path, { token: null });
    assert.ok(!/root:|localhost/.test(r.text), `${path} leaked a system file`);
    assert.ok(r.status === 403 || r.status === 503 || /<div id="app">/.test(r.text), `${path}: ${r.status}`);
  }
});

test("reference auto: the AI waits for a confirmed house style", async () => {
  assert.equal((await call("POST", "/api/ai/chat", { body: { spec: sampleSpec(), text: "x" } })).status, 409);
  assert.equal((await call("POST", "/api/style/save", { body: { confirmed: true } })).status, 409); // nothing analyzed yet
  // a confirmed style that writes AutoTool's fixed format (no AI in the tests)
  const st = (await call("GET", "/api/state")).json as { repo: { root: string } };
  const dir = new Store(cfgDir).repoDir(st.repo.root);
  writeFileSync(join(dir, "house-style.json"), JSON.stringify({ sampleRoot: repoRoot, autoFile: "x", files: [], targetFiles: [], style: { summary: "t", sections: [], mapping: [], rules: [], gaps: [] }, notes: "", confirmed: false, writer: "fixed", at: "t", model: "test" }));
  const ok = (await call("POST", "/api/style/save", { body: { confirmed: true } })).json as { onboarding: { style: boolean } };
  assert.equal(ok.onboarding.style, true);
});

test("write: one file per auto, the AutoRunner hook is confirmed first, the team's code survives, undo removes it", async () => {
  const opmodes = join(repoRoot, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode", "opmodes");
  const spec = { ...sampleSpec(), name: "close_9" };
  const prev = (await call("POST", "/api/preview", { body: { spec } })).json as { file: string; needsHook: boolean; files: { file: string; created: boolean }[] };
  assert.match(prev.file, /\/Near_9\.java$/); // starts at y = 72: the NECTAR CELL's half
  assert.equal(prev.needsHook, true);
  assert.deepEqual(prev.files.map((f) => f.file.split("/").pop()), ["Near_9.java", "AutoRunner.java"]); // one file per auto (+ the one-time hook)
  const first = (await call("POST", "/api/write", { body: { spec } })).json as { written: boolean; needsHook?: boolean };
  assert.deepEqual([first.written, first.needsHook], [false, true]);
  assert.equal(existsSync(join(opmodes, "Near_9.java")), false); // nothing written before the confirm
  const w = await call("POST", "/api/write", { body: { spec, allowHook: true } });
  const wj = w.json as { written: boolean; opModes: string[] };
  assert.equal(wj.written, true, w.text);
  assert.deepEqual(wj.opModes, ["Blue_Near_9", "Red_Near_9"]);
  const file = readFileSync(join(opmodes, "Near_9.java"), "utf8");
  assert.match(file, /@Autonomous\(name = "Blue_Near_9"[\s\S]*@Autonomous\(name = "Red_Near_9"[\s\S]*>>> AutoTool route[\s\S]*<<< AutoTool route/);
  assert.match(readFileSync(join(opmodes, "AutoRunner.java"), "utf8"), /public interface Route[\s\S]*Route paths = route\(\);/);
  assert.equal(readFileSync(join(opmodes, "AutoPaths.java"), "utf8"), readFileSync(`${here}fixtures/AutoPaths.placeholder.java.txt`, "utf8")); // the sample is untouched
  // a second write of the same auto is a no-op; the scan imports it back under its name
  assert.equal(((await call("POST", "/api/write", { body: { spec, allowHook: true } })).json as { unchanged?: boolean }).unchanged, true);
  await call("POST", "/api/ingest", { body: {} });
  const autos = (await call("GET", "/api/autos")).json as { name: string }[];
  assert.ok(autos.some((a) => a.name === "close_9"));
  const second = (await call("POST", "/api/preview", { body: { spec: { ...sampleSpec(), name: "near_9" } } })).json as { file: string };
  assert.match(second.file, /\/Near_9_2\.java$/);
  // the auto picker sees both OpModes of the one file
  const listed = ((await call("GET", "/api/state")).json as { autos: { name: string; file: string | null; opModes: { name: string; alliance: string }[] }[] }).autos.find((a) => a.name === "close_9");
  assert.deepEqual(listed?.opModes, [{ name: "Blue_Near_9", alliance: "BLUE" }, { name: "Red_Near_9", alliance: "RED" }]);
  assert.match(listed?.file ?? "", /Near_9\.java$/);
  // the team's code outside the route lines survives the next write
  writeFileSync(join(opmodes, "Near_9.java"), file.replace("    static class Plan implements Route {", "    static int ours = 1; // the team's\n\n    static class Plan implements Route {"));
  await call("POST", "/api/ingest", { body: {} });
  const moved = { ...spec, poses: spec.poses.map((p) => (p.name === "park" ? { ...p, x: 126 } : p)) };
  assert.equal(((await call("POST", "/api/write", { body: { spec: moved, allowOverwriteChanged: true } })).json as { written: boolean }).written, true);
  const after = readFileSync(join(opmodes, "Near_9.java"), "utf8");
  assert.ok(after.includes("static int ours = 1; // the team's") && after.includes("poseFactory.of(126.0, 36.0, 180.0)"), after);
  // undo the last write, then the first: the file is gone, AutoRunner restored
  assert.equal(((await call("POST", "/api/write/undo", { body: {} })).json as { restored: boolean }).restored, true);
  assert.ok(readFileSync(join(opmodes, "Near_9.java"), "utf8").includes("static int ours = 1"));
  // the start moves to the Far half: one write renames the file (and keeps the team's code), undo brings Near back
  const far = { ...moved, poses: moved.poses.map((p) => (p.name === moved.start ? { ...p, y: 40 } : p)) };
  assert.equal(((await call("POST", "/api/write", { body: { spec: far, allowOverwriteChanged: true } })).json as { written: boolean }).written, true);
  assert.deepEqual(["Far_9.java", "Near_9.java"].map((f) => existsSync(join(opmodes, f))), [true, false]);
  const farFile = readFileSync(join(opmodes, "Far_9.java"), "utf8");
  assert.ok(farFile.includes("static int ours = 1") && farFile.includes('name = "Red_Far_9"') && farFile.includes("public class Far_9 {"), farFile);
  assert.equal(((await call("POST", "/api/write/undo", { body: {} })).json as { restored: boolean }).restored, true);
  assert.deepEqual(["Far_9.java", "Near_9.java"].map((f) => existsSync(join(opmodes, f))), [false, true]);
  // an auto from before the one-file format (Blue_/Red_ pair) is replaced by its one file on the next write
  writeFileSync(join(opmodes, "Blue_Near_5.java"), `package org.firstinspires.ftc.teamcode.opmodes;\n\n// AutoTool auto: close_5\n@Autonomous(name = "Blue_Near_5", group = "AutoTool")\npublic class Blue_Near_5 extends AutoRunner {\n    static class Plan implements Route {\n        private final PoseFactory poseFactory = MatchState.poseFactory();\n        private final Pose start = poseFactory.of(135.0, 72.0, 180.0);\n        private final Pose b = poseFactory.of(118.0, 90.0, 180.0);\n\n        public boolean isReady() {\n            return true;\n        }\n\n        public Pose start() {\n            return start;\n        }\n\n        public Path ab() {\n            return Paths.line(start, b).linear(start, b);\n        }\n\n        public List<AutoRunner.Leg> legs() {\n            return Arrays.asList(new Leg(ab(), Action.SHOOT));\n        }\n    }\n}\n`);
  writeFileSync(join(opmodes, "Red_Near_5.java"), `package org.firstinspires.ftc.teamcode.opmodes;\n@Autonomous(name = "Red_Near_5", group = "AutoTool")\npublic class Red_Near_5 extends Blue_Near_5 {\n}\n`);
  await call("POST", "/api/ingest", { body: {} });
  const old = (await call("POST", "/api/autos/get", { body: { name: "close_5" } })).json as { legs: { end: string }[] };
  assert.deepEqual(old.legs.map((l) => l.end), ["SHOOT"]);
  const mig = (await call("POST", "/api/preview", { body: { spec: old } })).json as { files: { file: string; removed: boolean }[] };
  assert.deepEqual(mig.files.map((f) => [f.file.split("/").pop(), f.removed]), [["Near_5.java", false], ["Blue_Near_5.java", true], ["Red_Near_5.java", true]]);
});

test("auto picker: finds autos by their OpModes, hand-written autos as view only, and .pp files", async () => {
  const opmodes = join(repoRoot, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode", "opmodes");
  writeFileSync(join(opmodes, "AutoBlue.java"), 'package x;\n@Autonomous(name = "BIOBUZZ Auto Blue", group = "19859")\npublic class AutoBlue extends AutoRunner {\n}\n');
  writeFileSync(join(opmodes, "OldAuto.java"), 'package x;\n@Autonomous(name = "Old timed auto")\npublic class OldAuto extends LinearOpMode {\n}\n');
  writeFileSync(join(repoRoot, "paths.pp"), JSON.stringify({ startPoint: { x: 56, y: 8 }, lines: [] }));
  const st = (await call("GET", "/api/state")).json as { autos: { name: string; opModes: { name: string }[] }[]; folder: { other: { name: string }[]; pp: string[] } };
  assert.deepEqual(st.autos.find((a) => a.name === "AutoPaths")?.opModes.map((o) => o.name), ["BIOBUZZ Auto Blue"]);
  assert.deepEqual(st.folder.other.map((o) => o.name), ["Old timed auto"]);
  assert.deepEqual(st.folder.pp, ["paths.pp"]);
  const f = await call("POST", "/api/file", { body: { path: "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/opmodes/OldAuto.java" } });
  assert.match((f.json as { text: string }).text, /LinearOpMode/);
  assert.equal((await call("POST", "/api/file", { body: { path: "../../etc/passwd" } })).status >= 400, true);
});

test("manage: duplicate, rename and delete drafts; an AutoTool auto on the robot is removed as one undoable write", async () => {
  const opmodes = join(repoRoot, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode", "opmodes");
  const spec = { ...sampleSpec(), name: "close_7" };
  assert.equal(((await call("POST", "/api/write", { body: { spec, allowHook: true } })).json as { written: boolean }).written, true);
  assert.ok(existsSync(join(opmodes, "Near_7.java")));
  const m = (await call("GET", "/api/manage")).json as { autos: { name: string; kind: string; generated: boolean }[]; written: { file: string }[]; repo: { hooked: boolean } };
  assert.deepEqual(m.autos.find((a) => a.name === "close_7") && [m.autos.find((a) => a.name === "close_7")!.kind, m.autos.find((a) => a.name === "close_7")!.generated], ["robot", true]);
  assert.equal(m.repo.hooked, true);
  // duplicate is a draft; rename and delete drafts
  assert.equal((await call("POST", "/api/autos/duplicate", { body: { name: "close_7", to: "mgr_copy" } })).status, 200);
  assert.equal((await call("POST", "/api/autos/rename", { body: { from: "mgr_copy", to: "mgr_copy2" } })).status, 200);
  assert.equal(((await call("POST", "/api/autos/get", { body: { name: "mgr_copy2" } })).json as { name: string }).name, "mgr_copy2");
  assert.equal(((await call("POST", "/api/autos/delete", { body: { name: "mgr_copy2" } })).json as { deleted: boolean }).deleted, true);
  assert.equal((await call("POST", "/api/autos/get", { body: { name: "mgr_copy2" } })).status, 404);
  // on the robot: asks first, then removes its one file as a write; Undo write brings it back
  const ask = (await call("POST", "/api/autos/delete", { body: { name: "close_7" } })).json as { needsConfirm: boolean; files: string[] };
  assert.equal(ask.needsConfirm, true);
  assert.equal(ask.files.length, 1);
  const del = (await call("POST", "/api/autos/delete", { body: { name: "close_7", removeFiles: true } })).json as { deleted: boolean };
  assert.equal(del.deleted, true);
  assert.equal(existsSync(join(opmodes, "Near_7.java")), false);
  assert.equal(((await call("POST", "/api/write/undo", { body: {} })).json as { restored: boolean }).restored, true);
  assert.equal(existsSync(join(opmodes, "Near_7.java")), true);
});

test("launcher: the ping answers without the key and says which repo; nothing private in it", async () => {
  const r = await call("GET", "/api/ping", { token: null });
  assert.equal(r.status, 200);
  const j = r.json as { app: string; pid: number; repo: string };
  assert.equal(j.app, "biobuzz-autotool");
  assert.ok(j.pid > 0);
  assert.match(j.repo, /^[0-9a-f]{16}$/);
  assert.ok(!r.text.includes(repoRoot));
  assert.equal((await call("GET", "/api/ping", { token: null, host: "evil.example:80" })).status, 421);
});

test("profile: a value the robot code changes is used and reported, without reopening setup", async () => {
  const runner = join(repoRoot, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode", "opmodes", "AutoRunner.java");
  assert.equal((await call("POST", "/api/profile/sanity", { body: { confirmed: true } })).status, 200);
  const before = (await call("GET", "/api/state")).json as { onboarding: Record<string, boolean>; profile: { facts: Record<string, { value: number }> } };
  assert.equal(before.onboarding.profileConfirmed, true);
  assert.equal(before.profile.facts.abortAtS.value, 28.5);
  writeFileSync(runner, readFileSync(runner, "utf8").replace("ABORT_AT_S = 28.5", "ABORT_AT_S = 28.0"));
  await call("POST", "/api/ingest", { body: {} });
  const after = (await call("GET", "/api/state")).json as { onboarding: Record<string, boolean>; profile: { facts: Record<string, { value: number; confirmed: boolean }>; changes: { key: string; from: string; to: string; needsYou: boolean }[] } };
  assert.equal(after.profile.facts.abortAtS.value, 28);
  assert.equal(after.profile.facts.abortAtS.confirmed, true);
  assert.deepEqual([after.onboarding.profileConfirmed, after.onboarding.sanityConfirmed], [true, true]);
  assert.deepEqual(after.profile.changes.map((c) => [c.key, c.from, c.to, c.needsYou]), [["abortAtS", "28.5", "28", false]]);
  // seen: the notice goes
  const d = (await call("POST", "/api/profile/changes/dismiss", { body: {} })).json as { profile: { changes: unknown[] } };
  assert.deepEqual(d.profile.changes, []);
  writeFileSync(runner, readFileSync(runner, "utf8").replace("ABORT_AT_S = 28.0", "ABORT_AT_S = 28.5"));
  await call("POST", "/api/ingest", { body: {} });
});

test("partner library: routes by team number from a drawn auto or a .pp file, versions, notes, export and import", async () => {
  const spec = sampleSpec();
  const a = await call("POST", "/api/partners/add", { body: { team: "12345", name: "Bee Bots", robot: { body: { front: 8, back: 8, left: 7, right: 7 }, maxVel: 50 }, event: "Qualifier 1", autoName: "far 6", side: "Far", confidence: "told", notes: "parks left", spec } });
  assert.equal(a.status, 200, a.text);
  const pp = { startPoint: { x: 120, y: 30, heading: "linear", startDeg: 90, endDeg: 90 }, lines: [{ endPoint: { x: 120, y: 50, heading: "linear", startDeg: 90, endDeg: 90 }, controlPoints: [], color: "#fff" }] };
  const b = await call("POST", "/api/partners/add", { body: { team: "12345", pp: JSON.stringify(pp), autoName: "far 6 v2" } });
  assert.equal(b.status, 200, b.text);
  const list = (await call("GET", "/api/partners")).json as { teams: { team: string; name: string; robot: { maxVel: number }; versions: { id: string; autoName: string; source: string; confidence: string }[] }[] };
  assert.equal(list.teams.length, 1);
  assert.deepEqual([list.teams[0].name, list.teams[0].robot.maxVel], ["Bee Bots", 50]);
  assert.deepEqual(list.teams[0].versions.map((v) => [v.autoName, v.source]), [["far 6 v2", "pp"], ["far 6", "drawn"]]); // newest first
  assert.ok(existsSync(join(partnersDir, "12345", `${list.teams[0].versions[0].id}.pp`))); // the .pp file is kept as it was
  // the newest by default, with its route
  const g = (await call("POST", "/api/partners/get", { body: { team: "12345" } })).json as { version: { autoName: string; spec: { legs: unknown[] } }; team: { name: string } };
  assert.deepEqual([g.version.autoName, g.version.spec.legs.length, g.team.name], ["far 6 v2", 1, "Bee Bots"]);
  const old = list.teams[0].versions[1];
  assert.equal(((await call("POST", "/api/partners/update", { body: { team: "12345", id: old.id, notes: "parks left, sometimes misses" } })).json as { notes: string }).notes, "parks left, sometimes misses");
  // bad input is the team's mistake: 400, nothing written outside the library
  assert.equal((await call("POST", "/api/partners/add", { body: { team: "../etc", spec } })).status, 400);
  assert.equal((await call("POST", "/api/partners/add", { body: { team: "123", pp: "not json" } })).status, 400);
  assert.equal((await call("POST", "/api/partners/get", { body: { team: "12345", id: "../../x" } })).status, 404);
  // export, delete, import back
  const bundle = (await call("POST", "/api/partners/export", { body: {} })).json;
  assert.equal((await call("POST", "/api/partners/delete", { body: { team: "12345" } })).status, 200);
  assert.deepEqual(((await call("GET", "/api/partners")).json as { teams: unknown[] }).teams, []);
  const imp = (await call("POST", "/api/partners/import", { body: { bundle } })).json as { added: number; kept: number };
  assert.deepEqual([imp.added, imp.kept], [2, 0]);
  const again = (await call("POST", "/api/partners/import", { body: { bundle } })).json as { added: number; kept: number };
  assert.deepEqual([again.added, again.kept], [0, 2]);
  assert.equal(((await call("GET", "/api/partners")).json as { teams: { versions: { notes: string }[] }[] }).teams[0].versions[1].notes, "parks left, sometimes misses");
});

test("match plans: saved, listed newest first, cleaned on the way in, deleted", async () => {
  assert.equal((await call("POST", "/api/plans/save", { body: { plan: { match: "Q1" } } })).status, 400);
  const a = (await call("POST", "/api/plans/save", { body: { plan: { match: "Q1", alliance: "RED", ourAuto: "close_9", partnerRef: "lib:12345/v-20261010-090000", partnerTeam: "12345", delayS: 99, notes: "they park left" } } })).json as { id: string; delayS: number; alliance: string };
  assert.deepEqual([a.delayS, a.alliance], [10, "RED"]); // a delay is 0-10 s
  const b = (await call("POST", "/api/plans/save", { body: { plan: { match: "Q2", ourAuto: "close_9", partnerRef: "far_6" } } })).json as { id: string; alliance: string };
  assert.equal(b.alliance, "BLUE");
  const list = (await call("GET", "/api/plans")).json as { id: string; match: string }[];
  assert.deepEqual(list.map((p) => p.match), ["Q2", "Q1"]);
  // saving with the same id replaces it
  await call("POST", "/api/plans/save", { body: { plan: { id: a.id, match: "Q1b", ourAuto: "close_9", partnerRef: "far_6" } } });
  assert.deepEqual(((await call("GET", "/api/plans")).json as { match: string }[]).map((p) => p.match), ["Q1b", "Q2"]);
  await call("POST", "/api/plans/delete", { body: { id: b.id } });
  assert.deepEqual(((await call("GET", "/api/plans")).json as { match: string }[]).map((p) => p.match), ["Q1b"]);
});

test("reset: needs the explicit confirm, then forgets the profile and autos but keeps the repo", async () => {
  writeFileSync(join(cfgDir, "session-token"), "kept-token-0123456789abcdefgh");
  assert.equal((await call("POST", "/api/reset", { body: {} })).status, 400);
  const before = (await call("GET", "/api/state")).json as { onboarding: { scanned: boolean } };
  assert.equal(before.onboarding.scanned, true);
  const r = await call("POST", "/api/reset", { body: { confirm: "RESET" } });
  assert.equal(r.status, 200, r.text);
  const s = r.json as { onboarding: Record<string, boolean>; profile: unknown; repo: { root: string } | null };
  assert.deepEqual([s.onboarding.key, s.onboarding.scanned, s.profile], [false, false, null]);
  assert.ok(s.repo); // the repo itself is never touched
  assert.ok(existsSync(join(cfgDir, "session-token"))); // the page's saved key stays, so bookmarks still work
  assert.ok(existsSync(join(repoRoot, "TeamCode", "src", "main", "java", "org", "firstinspires", "ftc", "teamcode", "opmodes", "AutoPaths.java")));
});
