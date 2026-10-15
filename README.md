# BIOBUZZ AutoTool

**Made by FTC Team 19859.**

Draw or drag an autonomous route, see exactly what the robot will do and when, change it by typing a
request, and get compile-checked `AutoRunner` code in the robot repo. Built on top of
a fork of [Pedro-Pathing/visualizer](https://github.com/Pedro-Pathing/visualizer) (Apache-2.0; see
`NOTICE`). The plan it implements is [`PLAN.md`](PLAN.md); what was built and measured is at its end.

Everything runs on the team's laptop at `127.0.0.1`. The AI is Claude Haiku 5.5 (`claude-haiku-5-5`),
used only for judgement (labels, typed edits, explanations); every number comes from code and every
number the AI writes is checked against it. The AI never writes Java: a deterministic generator does.

## Quick start (with the BIOBUZZ Robot Simulator)

The fastest way to try it: AutoTool needs a robot code repo to read and write autos into. The
**BIOBUZZ Robot Simulator** repo is one, ready to use.

1. Install **Node.js 22.18 or newer** (`node --version`) and **Java 17+** (`java -version`). For the compile check,
   open the robot repo in Android Studio once and build it (this downloads the FTC SDK jars).
2. Put the two folders side by side, with these exact names:

   ```
   FTC/
     BIOBUZZ-AutoTool/          <- this repo
     BIOBUZZ-Robot-Simulator/   <- the robot code + simulator
   ```

3. From the simulator folder:

   ```bash
   ./autotool.sh
   ```

   The first run installs packages (about 90 MB) and builds the page, then opens **http://localhost:4791**.
4. Setup screen: the AI step is optional. Press **Skip: AI off for now** to use it without an API key (the
   "Use the code rules" button still decides each leg offline). Point it at the robot repo, scan, review the
   robot profile.
5. **+ New** starts an auto, drag the stops, press **Write**. The auto appears in
   `TeamCode/.../opmodes/<Name>.java` as `Blue_<Name>` and `Red_<Name>`. Test it in the simulator:
   `python3 sim/tests/test_autos_tuned.py` from the simulator folder.

Robot facts AutoTool does not know yet (size, intake width, turret pivots, drive speed) show as **assumed** in
Settings until the robot repo's `team-config.yaml` has them.

## Set up (once per robot repo)

1. Put this repo next to the robot code as a submodule, and the launcher in the robot repo root:

   ```bash
   git submodule add <url of this repo> tools/autotool
   ```

   ```bash
   cp tools/autotool/autotool.sh ./autotool.sh
   ```

   No submodule yet? Point at a copy instead: `AUTOTOOL_HOME=/path/to/biobuzz-autotool ./autotool.sh`.
2. Node.js 22.18+ or 23.6+ (it runs the TypeScript server directly). Java 17+ and the Android SDK that
   Android Studio already installed are used for the compile check.
3. Run it from the robot repo root:

   ```bash
   ./autotool.sh
   ```

   The first run installs the packages (about 90 MB, internet needed once) and builds the UI. The
   browser opens on a one-screen setup: AI connection, robot repo, scan, team profile review, "is this
   your auto?". About 10 minutes; Windows needs Git Bash or WSL.

   AutoTool keeps running after the terminal closes, always at **http://localhost:4791** (bookmark it).
   `./autotool.sh stop`, `status`, `open`, `log`; `./autotool.sh fg` runs it in the terminal instead.

## Use

- **Pick the auto** (top left). **+ New** starts one from scratch (a legal start, a shot, a park);
  **Copy this auto** in the menu copies the open one. The sample auto (`SampleAutoPaths`) is the
  reference: AutoTool reads it but never writes it.
- **Edit on the field**: drag a stop; drag the small knob to turn it (Shift = 15° steps, Alt = fine
  moves); double-click a leg to add a stop; **+ Leg** (A) then click the field to add legs.
- **Legs** (right): a leg is the robot code's `AutoRunner.Leg`: a path, what the robot does **while
  driving** (intake on, ramp out) and **at the end** (go on, shoot, wait, park), plus options (timeout,
  carry intake, shot timeout, wait time). Click a leg to open it; click it again, Esc or the empty field
  closes it. **Persistent intake** runs the intake all auto except during shots.
- **Ramp**: the ramp is shown the way `AutoRunner` moves it: out at the start of a RAMP leg; after it, it stays out
  the leg's ramp carry (`carryRamp`, default `RAMP_CARRY_S` 0.5 s) into the next leg so the robot backs out of the
  FLOWER before it folds; a shot on any other leg, PARK, the end and the abort time fold it at once; it swings at the ramp travel time
  that setup program 4 measures from slow motion (assumed 0.55 s until then). The time bar has a ramp lane (height
  = how far out), the playback robot and every RAMP stop show it, and a FLOWER stack only counts once the ramp is
  fully out. Warnings say when a RAMP leg arrives before the ramp is out (one click adds the WAIT it needs), when it
  never gets out, when it reaches into a wall, when the robot code has no ramp positions yet (the robot then never
  moves it) and when the ramp makes the robot longer than 18 x 24 in (R105). Partner collision checks include it.
- **AUTO points**: the top of the Legs list counts the auto the way Table 10-2 does (LEAVE 3, PARK 5,
  HIVE TIP 20 when POLLEN reach the upward-facing CELL) and shows what each leg adds.
- **AI**: **Decide every leg** asks Claude what each leg should do from the field and the evidence;
  **Use the code rules** works offline. Type a change ("move shot 2 six inches closer"); the proposal
  is drawn over the old route, **Enter** approves and writes, **Esc** rejects.
- **Write** compiles first (javac on the robot repo's real dependency jars) and writes one file per auto
  (`Near_9.java`: `Blue_Near_9` and `Red_Near_9` on the Driver Station). AutoTool rewrites only the lines
  between `>>> AutoTool route` and `<<< AutoTool route`; your code outside them stays. **Undo write**
  restores the files. Settings can turn on **a simulator check after every Write** (Blue and Red in the
  robot repo's simulator; an unchanged file is not run again); **Sim** runs one alliance any time.
- **Run with partner**: pick your alliance partner's auto (one of yours, a `.pp` file, or the partner
  library) and both run together: collisions and near misses on the field and the time bar, **Fix** adds
  the smallest WAIT on our side (or tells you the start delay to agree on), and the alliance's AUTO
  points. ▶ on the time bar plays both robots.
- **Partner library** (Manage): other teams' routes by team number, with their robot size, speed and
  notes, in `partners/` in this repo. Commit it with git to share it with the team; export and import
  move it between laptops.
- **Match plan**: every pair of our autos with every partner route (collisions, closest approach,
  alliance points), and a one-page sheet for the drive team: both starts on our alliance's side, what was
  agreed, the points. Print it or show it full screen.
- **Ctrl/Cmd+Z** undoes edits. **Red** shows the red side (the robot code rotates the blue drawing 180°
  about the field centre).

## Safety

- The server binds `127.0.0.1` only, checks the Host header and Origin, and needs the page key on every
  API call. The key is kept in a user-only file in the OS config folder and in the page's own storage, so
  the plain address keeps working; `./autotool.sh open` hands a new browser the key once.
- The API key lives in a user-only file in the OS config folder; the browser only ever sees its last 4
  characters. It is never in the repo, in browser storage, in logs or in a profile export.
- Writes: only AutoTool's own auto files in the autos folder (and, once, the `AutoRunner.java` route
  hook after you confirm it), never `libs/`, never through a symlink, only after a compile check, and
  never over a file changed since AutoTool wrote it without asking.
- Values read from the robot code update the profile by themselves (shown once in the editor); setup
  only asks again about values the code does not have, or your own overrides the code has since changed.
- Repo text and tool results are data for the model, never instructions.
- Spend: $15 per session cap checked before every API call (amber at 80%, **Continue (+$15)** resumes).

## Develop

```bash
cd autotool && npm ci
```

```bash
npm run check
```

```bash
npm test
```

```bash
npm run eval:regress
```

- `autotool/src/shared`: spec, geometry, features, labels (the rubric), patch format and claim checker,
  Java adapter. Runs in the server and the browser.
- `autotool/src/server`: local server, digest/ingest/profile, compile check, AI prompt/tools/agent.
- `autotool/src/ui`: the Svelte one-screen UI. `autotool/season`: the BIOBUZZ season pack.
- `autotool/eval`: code-labelled evaluation cases, runner, prompt-example picker, regression gate.
  `node eval/run.ts --model ai --split validation --budget 0.5` runs Claude on the validation split.
- `AUTOTOOL_FAKE_MODEL=1` (testing only) answers AI requests with the code rubric: no API calls.

## Credit

Made by FTC Team 19859. If you use or build on it, please credit **FTC Team 19859**.
