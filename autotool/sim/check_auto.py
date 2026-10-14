"""Runs one AutoTool auto in the robot repo's simulator (sim/ in the robot repo) as a check, before or after Write.

The simulator builds the robot code from its own sandbox copy of the repo, so the auto's file goes into that copy
only: the robot repo is never touched. The robot gets the tuned values the setup programs would find, stands on the
auto's start pose, and the auto runs like on the Driver Station. Prints one JSON line: what each leg did, where the
robot ended, and anything that went wrong.

    python3 check_auto.py --repo <robot repo> --file <Near_9.java> --opmode Blue_Near_9 --start 135,72,180 \
        [--alliance BLUE|RED] [--remove Blue_Near_9.java,Red_Near_9.java] [--park 128,36]
"""
import argparse
import json
import os
import re
import shutil
import sys
import time

p = argparse.ArgumentParser()
p.add_argument("--repo", required=True)
p.add_argument("--file", required=True)
p.add_argument("--opmode", required=True)
p.add_argument("--start", required=True, help="x,y,heading as drawn (blue)")
p.add_argument("--alliance", default="BLUE")
p.add_argument("--remove", default="", help="files in the auto's folder the write would remove")
p.add_argument("--park", default="", help="x,y of the last stop as drawn, to check where the robot ends")
p.add_argument("--seed", type=int, default=7)
p.add_argument("--max", type=float, default=32.0, help="seconds of auto to watch")
a = p.parse_args()

sim_tests = os.path.join(a.repo, "sim", "tests")
if not os.path.isdir(sim_tests):
    print(json.dumps({"ok": False, "error": "the robot repo has no simulator (sim/tests)"}))
    sys.exit(0)
sys.path.insert(0, sim_tests)
from harness import running_sim  # noqa: E402
from launcher_student import tuned_robot  # noqa: E402

red = a.alliance.upper() == "RED"


def as_alliance(x, y, h=None):
    # red runs the drawn route turned 180 degrees about the field centre (MatchState.poseFactory)
    if not red:
        return (x, y, h)
    return (144 - x, 144 - y, None if h is None else h + 180)


out = {"ok": False, "opmode": a.opmode, "alliance": "RED" if red else "BLUE", "legs": [], "events": [], "status": None, "end": None}
work = None
try:
    with running_sim(seed=a.seed) as s:
        s.preset_config()
        values = tuned_robot(s)
        # the auto's file into the simulator's copy of the repo (never the repo itself)
        work = os.path.join(a.repo, "sim", "work", f"test-{s.url.rsplit(':', 1)[1]}")
        rel = None
        for root, _, files in os.walk(os.path.join(work, "sandbox", "TeamCode")):
            if "AutoRunner.java" in files:
                rel = root
                break
        if rel is None:
            raise RuntimeError("AutoRunner.java not found in the simulator's copy of the repo")
        for f in [x for x in a.remove.split(",") if x]:
            if os.path.exists(os.path.join(rel, f)):
                os.remove(os.path.join(rel, f))
        shutil.copy(a.file, os.path.join(rel, os.path.basename(a.file)))
        s.set_values(values)  # builds and installs the sandbox code
        sx, sy, sh = (float(v) for v in a.start.split(","))
        x, y, h = as_alliance(sx, sy, sh)
        s.hand("robot", "onFloor")
        s.hand("drive", "place", x=x, y=y, headingDeg=h, exact=True)
        try:
            s.init(a.opmode)
        except Exception as e:  # not on the Driver Station: the build failed or the name is wrong
            st = s.state()
            raise RuntimeError(f"{a.opmode} is not on the Driver Station ({e}); {' '.join(st['ds'].get('telemetry') or [])[:400]}")
        s.wait_text("Alliance", timeout=20)
        tel = s.telemetry()
        if "WILL NOT DRIVE" in tel:
            raise RuntimeError(re.search(r"WILL NOT DRIVE\s*:\s*(.*)", tel).group(1))
        s.start()
        t0 = time.time()
        seen = set()
        last = None
        while time.time() - t0 < a.max + 8:
            tel = s.telemetry()
            m = re.search(r"Status\s*:\s*(.*)", tel)
            status = m.group(1).strip() if m else ""
            mt = re.search(r"Time\s*:\s*([\d.]+)", tel)
            t = float(mt.group(1)) if mt else time.time() - t0
            if status and status != last:
                last = status
                lm = re.match(r"leg (\d+): (\w+) -> (\w+)", status)
                if lm and lm.group(1) not in seen:
                    seen.add(lm.group(1))
                    out["legs"].append({"leg": int(lm.group(1)), "during": lm.group(2), "end": lm.group(3), "at": round(t, 1)})
                elif not lm:
                    out["events"].append({"at": round(t, 1), "status": status})
            if re.match(r"(parked|done|abort)", status):
                break
            if t > a.max:
                break
            time.sleep(0.2)
        time.sleep(0.6)
        d = s.world()["drive"]
        out["status"] = last
        out["end"] = {"x": round(d["x"], 1), "y": round(d["y"], 1), "headingDeg": round(d.get("headingDeg", 0.0), 1)}
        out["timeS"] = round(t, 1)
        problems = [e["status"] for e in out["events"] if "skipped" in e["status"] or "not set" in e["status"]]
        if a.park:
            px, py = (float(v) for v in a.park.split(","))
            px, py, _ = as_alliance(px, py)
            miss = ((d["x"] - px) ** 2 + (d["y"] - py) ** 2) ** 0.5
            out["endMissIn"] = round(miss, 1)
            if miss > 4:
                problems.append(f"ended {miss:.1f} in from the last stop")
        if not (last and re.match(r"(parked|done)", last)):
            problems.append(f"did not finish: {last}")
        out["problems"] = problems
        out["ok"] = not problems
except Exception as e:
    out["error"] = str(e)
finally:
    # this check's own simulator folder and log (a few MB each) go; nothing else in sim/work is touched
    if work and os.path.basename(work).startswith("test-"):
        shutil.rmtree(work, ignore_errors=True)
        try:
            os.remove(work + ".log")
        except OSError:
            pass
print(json.dumps(out))
