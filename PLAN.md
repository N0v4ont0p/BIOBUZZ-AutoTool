# AutoTool: plan

Status (2026-10-08): built in this repository (fork of Pedro-Pathing/visualizer at f0b063a). Milestones 0-4 are
done; 5 and 6 are built and pass every offline check; the live AI evaluation waits for the API key and the timed
student test is the team's to run. Section 21 says what was built, what changed from the sketch, and what is
still unmeasured. The repository name `biobuzz-autotool` and its GitHub location are still the team's to create.

## 1. Why this exists

Auto routines are inconsistent between matches, and a team has only minutes between matches to change them. Editing
auto code by hand under time pressure causes mistakes. The tool lets a student draw or drag a path, see exactly what
the robot will do and when, change it by typing a request, and get working, compile-checked code in the robot repo.

What makes it different from the stock Pedro Pathing Visualizer:

- It is linked to the team's code: it imports the existing autos and writes new ones into the repo.
- An AI (Claude Haiku 5.5) reads the path together with code-computed geometry and decides where the robot
  intakes, shoots, repositions or waits. It understands turns, shooting zones, how many elements the robot holds, and
  whether a pause is a shot or a positioning move.
- It runs on the team's own laptop (localhost), started by one shell script from the robot repo root.

## 2. Decisions made (with the team)

| # | Decision |
|---|---|
| 1 | Separate GitHub repo, a fork of `Pedro-Pathing/Visualizer`. The team pushes to GitHub itself; the tool never pushes. |
| 2 | Model: `claude-haiku-5-5` only. No model escalation switch. |
| 3 | No simulator integration. Deployment (`adb`) is not part of the tool; it only works on the codebase. |
| 4 | The AI writes code only from the **hand-drawn path**. It does not invent autos from a goal such as "max score". |
| 5 | Onboarding includes entering the API key. Onboarding creates a team profile. The key, profile and caches are stored on that computer, in the OS config folder, not in the repo and not in the browser. |
| 6 | Spend cap: $15 per session, continuable with one click. |
| 7 | Capacity (max elements held) is asked in the profile. Default 4 (rule G407). |
| 8 | UI bar is very high: one screen, no gimmicks, the robot route must show clearly when it fires, intakes, waits and parks. |
| 9 | No hand labeling for evaluation. All checks use labels code can verify. |
| 10 | The DECODE repo's autos may be used as a cross-team test set. |
| 11 | An evaluation spend budget of about $5 is approved. It is spent while building, not before. |
| 12 | The team differs from every other team, so the first thing the system does is analyze the existing autos and codebase and build a team profile that goes into the system prompt. |

## 3. Scope and non-goals

In scope:

- Draw and edit a path; see it as a clear timeline on the field.
- Import existing autos from the robot repo into the editor.
- AI annotation of each stop (junction) with the action and the evidence for it.
- Chat edits ("move shot 2 closer", "add a park") that change the spec.
- Deterministic Java generation into the robot repo, plus a compile check.
- Local profile, caches, history, undo, spend meter.

Out of scope for v1:

- Generating autos from goals. Simulating the robot. Deploying to the robot. Pushing to GitHub.
- Any code dialect other than this repo's `AutoRunner` leg API for **writing** code (see section 8).
- Hosting anywhere except `127.0.0.1`.

## 4. The core idea

The source of truth is a JSON **auto spec**. Three things work on it:

1. **The route UI** edits it visually.
2. **The AI** proposes patches to it (annotations and edits). It never writes Java.
3. **A deterministic generator** turns the spec into Java.

Code, not the AI, computes every fact that can be computed: distances, angles, zone membership, element counts, times,
rule checks. The AI is used for what needs judgement: reading a team's conventions, deciding the intent of an
ambiguous stop, understanding a typed request, and explaining. Every number the AI quotes is checked against the
computed value.

## 5. Architecture

```
browser (Svelte UI, 127.0.0.1)  <-->  local server (Node)  <-->  Anthropic API (Haiku 5.5)
                                         |
                                         +-- reads/writes the robot repo (ROBOT_REPO), autos folder only
                                         +-- config folder: key, profile, caches, history, ledger
                                         +-- Gradle compile check in the robot repo
```

- **Stack:** the fork's Svelte + TypeScript + Vite front end (remove the Cloudflare Workers parts) and a small Node
  server using the Anthropic TypeScript SDK. Apache-2.0: keep `LICENSE` and `NOTICE`, mark changes.
- **Launch:** `autotool.sh` in the robot repo root. It checks Node, loads the stored key, installs on first run, starts
  the server with `ROBOT_REPO=$PWD`, and opens the browser. On Windows this needs Git Bash or WSL.
- **Repo link:** the tool repo is added to the robot repo as a git submodule (proposed: `tools/autotool`).

## 6. Onboarding and local storage

Runs once per computer, target 10 minutes.

1. **API key.** Pasted into a masked field. Validated with a no-token call (a model lookup). Saved server-side in a
   user-only file in the OS config folder (macOS `~/Library/Application Support`, Linux `~/.config`, Windows
   `%APPDATA%`). The browser only learns "key set" and the last four characters. The key is never in the repo, in
   browser storage, or in logs.
2. **Pick the robot repo.** Default from `ROBOT_REPO`.
3. **Ingest scan** with a progress bar: parse existing autos, build the codebase digest, load the season pack.
4. **Profile review**, one screen. Every fact shows its source file and line and can be confirmed or edited:
   - capacity (default 4), preload (default 4 POLLEN), abort time, stopped limits
   - intake end of the robot, shooter range, turret limits, pivot positions
   - start poses, parking region
   - human feed (default none)
   - code conventions found in the existing autos
5. **Sanity check.** The tool redraws one real auto from the profile; the user confirms "that is my auto".

Stored on that computer only:

| Data | Notes |
|---|---|
| API key | user-only file |
| Team profile | confirmed facts with sources, versioned |
| Digest cache | keyed by content hash; rebuilt when the repo changes |
| Parsed autos | specs imported from the repo |
| Spec history | for undo |
| Usage ledger | per request tokens and estimated cost |
| UI settings | zoom, last open auto (the only thing in browser storage) |

Export/import profile: one small button, so a second laptop on match day does not need a full re-onboarding.
Re-onboarding is offered when the key is invalid or the repo changed in ways the profile covers; only the changed
digests are re-ingested.

## 7. Season pack and the rules it carries

A data file per season: field dimensions and frame, element types, staged positions (editable overlay), scoring
zones, parking regions, and the rule limits the checks need. It names the manual version it came from. The AI never
reads the manual.

BIOBUZZ facts gathered from the rules corpus (Competition Manual V1, Team Update 0):

- HUMAN PLAYER is defined as "a SCORING ELEMENT manager". Drive team members stay in their alliance area (G422).
- Each alliance area starts with 5 NECTAR of that color (10 total). Humans may enter NECTAR only through the
  LOADING ZONE, by hand with no tool, so it touches the tile inside the zone before touching a robot or field
  element (G427).
- Entry is allowed only (a) once each time the alliance's HIVE is tipped, or (b) for all remaining NECTAR when 60 s or
  less remain (G426). Early entry is a minor foul per NECTAR.
- Humans may not score into a HIVE or FLOWER (G427, G202), may not remove elements from the field (G428), may not
  touch a robot or an element touching a robot or tile (G425), and may not touch the controls (G423).
- Starting layout (section 10.3.2): 40 POLLEN (4 in each of the 4 FLOWERS, 4 in each GARDEN, 4 preloaded in each robot)
  and 8 red and 8 blue NECTAR (3 in each upward-facing CELL of its color, 5 in each alliance area). The robot must start
  touching 4 preloaded POLLEN (10.3.4).
- A robot may not control more than 4 elements at once (G407). NECTAR may not enter a FLOWER scoring volume until the
  last 60 s (G410).

Implications for the tool:

- In a 30 s auto the 60 s release can never apply, and a human can add NECTAR only after a HIVE tip. The default for
  auto planning is **no human feed**. An optional "expected feed after a tip" can sit in the profile, but the AI must
  not count on it.
- Element positions are an editable overlay with defaults from the pack. The AI never guesses positions.

Caveat: the rules corpus used here is three Team Updates behind the live manual (it stops at Team Update 0; the live
manual is at 3). The pack must be refreshed against the live manual before it is trusted (milestone 0).

## 8. Code ingestion and adapters

"Each team differs" means the tool cannot assume a code style. The first thing it does is analyze.

- **Parse** the team's existing autos into facts, each with file and line: poses, path segments, leg lists, actions,
  timeouts, alliance handling.
- **Digest** (generated by code, never hand-written, hashed): the leg and action semantics, the field model, tuned
  constants, shot-table range, speeds, naming and style conventions.
- **Adapters:** one `parse`/`render` pair per code style.
  - v1 adapter: this repo's `AutoRunner` (`Action { NONE, INTAKE, SHOOT, PARK }`, `Leg(path | target, action)`,
    `.timeout()`, `.carryIntake()`, `AutoPaths`, `MatchState.poseFactory()` where red is the 180 degree rotation of
    the blue-drawn path).
  - Later: FTCLib timeline style (the DECODE repo), read-only first, as an example source and cross-team test set.
  - For an unsupported style the tool still works for new autos in a supported target, but cannot import.
- **Round trip:** Java to spec to Java must give equivalent code, or the importer is wrong. Tested on every
  import.
- **Opaque blocks:** anything the spec cannot represent is imported as an opaque block and written back unchanged.
  Regenerating never destroys custom code.

## 9. The auto spec (sketch)

```json
{
  "specVersion": 1,
  "name": "close_9",
  "drawnFor": "BLUE",
  "start": { "x": 0, "y": 0, "headingDeg": 0 },
  "preload": { "POLLEN": 4 },
  "legs": [
    {
      "id": "L1",
      "path": { "type": "line", "from": [0, 0], "to": [0, 0] },
      "heading": { "mode": "linear", "startDeg": 0, "endDeg": 0 },
      "during": ["intake"],
      "end": { "action": "SHOOT", "timeoutS": 0 },
      "carryIntakeS": 0,
      "legTimeoutS": 7,
      "junction": {
        "label": "SHOOT",
        "source": "imported | ai | user",
        "evidence": ["zone.in", "inventory.before=3", "shot.in.code"]
      }
    }
  ],
  "opaque": [{ "anchor": "after:L3", "code": "..." }]
}
```

- Travel actions (`during`: intake running, pre-spin) and end-of-leg actions (`end`: the shot, a wait, with timeouts)
  are separate fields.
- For imported autos the junction label comes from the code. For drawn paths it is the AI's proposal.
- The exact mapping from `AutoRunner` actions to junction labels is defined in milestone 3 by reading `AutoRunner`.

## 10. Computations done by code

For every leg and every junction the AI receives these numbers, not raw coordinates:

| Feature | Use |
|---|---|
| Signed turn angle at each waypoint, heading in and out | sharp reversal versus gentle curve |
| Heading change during travel | does the intake or shooter side face the target |
| Arc length, curvature peak, estimated time (from measured speeds) | fits the auto, time bar |
| Which robot end faces the next element cluster | the intake side must lead |
| Distance and bearing to the CELL from each pose; turret angle needed | shot feasibility |
| Wall proximity, distance to no-go areas | safe stopping spots |
| Speed at the end of each leg | stopped or on the move (this robot never fires on the move) |
| Zone membership of each waypoint and path stretch, distance to the zone edge | shooting zones |
| Inventory timeline | do we hold elements |
| Dwell time found in the code | pause evidence |

**Shooting zones** are built from the team's own numbers: the distance band of the shot table around the correct CELL,
minus unreachable turret angles ("CELL outside yaw travel"), minus wall margins, no-go areas and places the robot
cannot stop.

**Inventory timeline:** start with the preload; add elements on legs that pass over element positions, capped by intake
capacity and the controlled-element limit; subtract what each shot sends. The AI must reference the timeline. A shot with
zero held elements is flagged "empty shot"; an intake leg while full is flagged; elements the field map does not
confirm are "unconfirmed".

**Claim checker:** any number or count the AI cites is compared with the computed value; a mismatch is logged as a
hallucination and fails the evaluation.

## 11. The AI layer

### Junction labels

Exactly one per junction: `SHOOT`, `INTAKE_DWELL`, `REPOSITION`, `SETTLE`, `PARK`, or `NEEDS_REVIEW`. Evidence
comes first, then the label.

Evidence tuple per junction: in or out of the zone and the distance to its edge, turret reachability, inventory
before and after, stopped or not, shot in code, dwell in code, facing and distance to the next target.

Draft decision order for a drawn path (thresholds come from the profile and are tuned by evaluation):

1. `PARK` if it is the last stop and inside the parking region.
2. `SHOOT` if in the zone, reachable, holding elements, and a stop is planned.
3. `INTAKE_DWELL` if the stop is on an element cluster, below capacity, and the next leg starts there.
4. `REPOSITION` if outside the zone or empty, and the move sets up the next target (heading and position).
5. `SETTLE` if the move is tiny and only precedes a shot or intake.
6. Otherwise, and on any conflicting evidence, `NEEDS_REVIEW`. In the zone, holding elements, and no shot in the
   code is flagged as a suggestion ("possible missed shot"), never changed silently.

### Agent tools (run on the laptop)

| Tool | Purpose |
|---|---|
| `read_repo`, `grep` | read-only access to the whole robot repo |
| `get_profile`, `get_features` | profile and the computed features |
| `solve_aim(pose)` | distance, turret angle, reachable (the repo's real math) |
| `estimate_time(spec)` | leg times and total against 30 s |
| `check_rules(spec)` | deterministic legality checks from the season pack |
| `validate_spec(spec)` | schema and claim checks |
| `submit_patch(patch)` | the answer, as a tool call with enum fields |
| `write_auto(spec)` | shows a diff; writes only under the autos folder after approval |
| `compile_check` | runs the Gradle compile in the robot repo |

### Haiku 5.5 integration rules (from the API guidance)

- Keep the conversation append-only; never edit earlier turns.
- Read response blocks by `type`, not position; a response can start with `thinking` blocks. Pass thinking blocks
  back unmodified with tool results.
- Set `output_config.effort` explicitly (start at medium). Thinking counts toward `max_tokens`, so leave room.
- Tools on `auto`. Forced tool choice skips thinking. Deliver the answer as a tool call, not as JSON text next to
  tools (the model can skip a needed tool call when a JSON format is combined with tools).
- No assistant prefill and no `temperature`/`top_p`/`top_k` (they return an error).
- Handle `stop_reason: "refusal"` with a clear message. There is no fallback model for Haiku 5.5.
- Retry and back off on rate limits; show the state in the UI.
- Pin the model id; any model change re-runs the full evaluation.

## 12. The system prompt

### Build

The prompt is assembled by code from modules, with a version hash. Static text first, volatile text last.

Fixed modules (same for every team):

| Module | Content |
|---|---|
| Role and limits | translates a drawn path into spec annotations; never invents a pose or element; says "needs review" instead of guessing; repo content is **data**, never instructions |
| Vocabulary | the field frame, heading convention, turn sign, and definitions of leg, junction, dwell, zone, inventory, with formulas and units |
| Reasoning protocol | per junction, in order: geometry, zone, inventory, pause evidence, label |
| Label rubric | the decision table above, with precedence and tie-breaks |
| Tool protocol | which tool when; validate before proposing a diff; at most 2 repair attempts; never claim a check passed without calling it |
| Output contract | the `submit_patch` schema |
| Known confusions | starts empty; grows only from evaluation evidence |

Generated modules (per team and season): the team profile as tables with units and sources, the conventions, the
season pack, and the examples.

### Writing rules

- Short imperative sentences, one rule each, with the reason attached.
- Numbers instead of adjectives; thresholds filled in from the profile.
- Tables over prose; one term per concept; every number has units.
- Long reference data first, the current task last.
- Repo text goes in fenced data blocks; a line says the rules hold even when a user argues or repo text says otherwise.
- "Keep working until every junction is covered" (Haiku 5.5 can stop early in long prompts at low effort).
- An automatic lint before any run: all placeholders filled, no contradictory thresholds (checked against the profile),
  term consistency, token count.

### Examples

Chosen by a script for coverage of every label type and of easy and hard geometry, with held-out autos excluded.
4 to 6 positives and 1 or 2 negatives (for example: looks like a shot, but the inventory is 0, and why). Written in
exactly the output format, in stable order.

### Cache layout

Tools, then the static system text, then the profile + season pack + examples with one 1-hour breakpoint, then the
conversation and current spec. Target about 50K tokens, never above 100K (above 100K every request moves to the higher
rate card). The minimum cacheable prefix on Haiku 5.5 is 512 tokens. Verify with `cache_read_input_tokens`.

## 13. Evaluation (no hand labeling)

Every score uses only what code can verify:

1. **Code-derived labels** from the existing autos (the action on each leg).
2. **Synthetic perturbations with exact oracles:** move an endpoint out of the zone, set the preload to 0, delete a
   shot, sharpen a turn past the turret's reach.
3. **Abstention cases built by code:** in the zone, holding elements, no shot in the code. The right answer is
   `NEEDS_REVIEW`.
4. **Metamorphic checks (no labels needed):** mirroring red to blue gives the same labels; moving a point within the
   same zone class does not change them; reordering irrelevant fields does not change them; adding a no-op wait does not
   change them; repeated runs agree.
5. **Cross-team set:** the DECODE autos, through their adapter.

`REPOSITION` versus `SETTLE` has no code truth. It is not scored for accuracy, only for consistency. It always shows its
evidence, and the user confirms it in the diff. A "Wrong?" link on each evidence line saves the case locally as a new
check.

Process: build the eval before the prompt, baseline with a naive prompt, then change one thing at a time, with train,
validation and test splits kept separate. Ablations to settle with data: number of examples (0/2/4/6), with versus
without a rule-based candidate-label hint (it may anchor the model), effort low versus medium versus high, rubric as table
versus prose. Each recurring miss is sorted into: unclear rubric, missing feature, bad example, or model limit; a model
limit moves into code. A regression command re-runs everything and gates any prompt, template or model change.
Robustness runs: mutated profiles (different capacity, intake side, zone range), injection tests (instructions hidden in
code comments of imported files), cache-stability test, token-budget test.

Targets (proposals): label accuracy of at least 95% on real autos and 90% on synthetic cases; schema validity 100%;
invented-fact rate under 1% in model output and 0 reaching files; cost under about $0.01 per annotation; cache hit over
90% after the first call. The approved evaluation budget is about $5; measure one run's cost first.

## 14. The UI

Principles: one screen. No themes, avatars, tutorial overlays or decorative animation. Everything on screen helps read or
change the route. High contrast for glare in pits. Color is never the only signal: shape and line pattern also carry
the meaning.

Route language (a legend is always visible):

| Phase | Look |
|---|---|
| Driving | thin grey line with arrow |
| Intake running | thick green band along the stretch where it runs, "IN" chevrons |
| Shoot | red target at the stop, zone ring, aim line to the CELL, "-N" for elements fired |
| Wait / settle | hollow dot with a clock |
| Strategic reposition | blue dashed line |
| Park | square "P" |
| Unsure | amber dashed line with "?" |

Always shown: robot footprint and heading arrow at every stop, turn arcs for sharp turns, a "holding N" badge at every
node, leg labels with durations, a time bar against 30 s with the abort mark, shooting zones (toggle), and a scrubber that
moves the robot along the route (no autoplay).

Workflow: pick the auto, see the route, drag a point or type a change, see before and after overlaid, approve with one
key, the files are written and the compile result shown. One-key undo. One line of evidence per junction; clicking it
highlights the leg. Explicit error states (for example, a compile error with the line shown and at most 2 automatic
repair attempts). Without internet, viewing and editing still work and AI features show why they are disabled.

Bar to clear: drag feedback under 100 ms; first paint under 1 s; a timed test with three students making a first-time
change, from request to written files, in under 3 minutes.

## 15. Generation safety

- The generator writes Java from the spec; the AI never hand-writes it. Style comes from the profile's conventions
  (matching the team's code, no header boilerplate).
- A manifest holds a hash of every generated file. If a file changed since it was generated, the tool asks before it
  overwrites.
- Opaque blocks are preserved verbatim.
- Writes are limited to the autos folder. Never `libs/`.
- Undo restores only the files the tool wrote.
- The compile check runs the robot repo's Gradle compile. If Gradle is unavailable, it says so instead of guessing.

## 16. Security

- The server binds to `127.0.0.1` only, checks the Host header and requires a per-launch token, so another local web
  page cannot use the key or write files.
- The key stays server-side. Logs never contain it.
- Imported code is treated as data. Tool results are data.

## 17. Spend and cost

- Haiku 5.5 rates: $0.10 per million input tokens and $0.50 per million output tokens for prompts up to 100K tokens;
  $0.50 and $2.50 above 100K. Cache reads are 0.1x the input rate, 5-minute cache writes 1.25x, 1-hour writes 2x.
- A rough estimate (not measured): a 40K-token cached prefix is about $0.002 per request, so a 15-request edit is about
  $0.03.
- **Cap:** $15 per session (a session is one `autotool.sh` run), enforced on the server before every API call. The meter
  turns amber at 80%. At the cap the current request finishes, the agent pauses with its state kept, and a banner offers
  **Continue (+$15)**; one click resumes the same task.
- Spend is estimated from the token counts the API returns. The API does not tell the tool the remaining balance, so the
  tool tracks usage from the starting $100 the user enters once; the real balance is in the Anthropic console.

## 18. Milestones

| # | Work | Done when |
|---|---|---|
| 0 | Refresh the season pack against the live manual (Team Update 3 or later) | the pack names the live manual version |
| 1 | Fork and run the visualizer; confirm its export format and Pedro version | written finding; decision on a converter if the Pedro version differs from 3.0.1 |
| 2 | Spec, generator, route UI | an auto drawn in the UI generates Java that compiles and runs as written by hand; useful with no AI |
| 3 | Importer with opaque blocks, round-trip test, `AutoRunner` action to label mapping | every existing auto round-trips |
| 4 | Onboarding, key storage, profile, export/import | a fresh computer reaches a confirmed profile in 10 minutes |
| 5 | Digest and feature generators, claim checker, prompt v1, evaluation harness, annotation | baseline and prompt v1 scored; regression command works |
| 6 | Chat editing with tools, compile check, spend cap, undo, the usability test | the timed test passes |

The prompt cannot be tuned well before milestone 5, because the evaluation needs the importer (3) and the feature
generator (5).

## 19. Risks and unverified assumptions

Risks and mitigations:

- The visualizer may target a different Pedro version than 3.0.1 (milestone 1).
- The rules snapshot is stale (milestone 0).
- Haiku may misjudge a pause. The checks, the claim checker and the diff approval limit the damage; the evaluation measures
  how often it happens.
- Overfitting the prompt to one team's autos. Defense: the synthetic, metamorphic and cross-team sets.
- Prompt bloat. Defense: the token budget check on every build.
- A second dialect is real work: the `AutoRunner` adapter is the only writer in v1.

Not verified yet (checked in the milestone shown):

- The visualizer's README, export formats and Pedro version (1).
- How `AutoRunner` actions map to junction labels (3).
- Whether the no-token key check works for the team's account tier (4).
- The exact element positions for the BIOBUZZ field (0, from the manual figures).
- Cost figures in section 17 are estimates.

## 20. Open items

- Confirm the new repo name and location.
- Windows support depends on Git Bash or WSL for `autotool.sh`.
- Whether to add an FTCLib adapter after v1.

## 21. Build status (2026-10-08)

### Milestones

| # | Status | Evidence |
|---|---|---|
| 0 | Done | Live manual is TU03 (last modified 2026-10-01); `tu-04` returns 404 (checked 2026-10-08). The pack (`autotool/season/biobuzz-2026-27.json`) names it, lists what TU01-TU03 change for autos (TU03: the 4 preload POLLEN may sit on the tiles touching the robot), and gives a source for every number. Element and CELL positions: owner CAD via the DSIM model, converted to the Pedro frame (`pedro = dsim + 72`) and checked against the field image. |
| 1 | Done | Fork of upstream f0b063a. The visualizer emits the Pedro 3.0 API (`Paths.line/curve/through`, `PoseFactory`, `Interpolator`), which matches the robot's `com.pedropathing` 3.0.1 (checked with `javap` on the jars): no converter. Finding: the visualizer scales its field image to 141.5 in (`src/config/defaults.ts FIELD_SIZE`); the manual (9.1) and the robot code (`Field.SIZE = 144`, red = rotation about 72,72) use 144, and the BIOBUZZ image is 6 x 6 tiles. AutoTool draws at 144; a `.pp` import keeps the numbers and warns. |
| 2 | Done | Spec, generator and route UI. A drawn auto renders to `AutoPaths.java` that compiles with javac on the repo's real dependency jars (about 1 s), checked on a copy of the robot repo. |
| 3 | Done | Importer with opaque blocks; the repo's real `AutoPaths.java` imports and re-renders byte for byte, and so does a variant file with comments, `List.of`, option order, straight-to-point, inline and curve legs, expressions and custom members. Label mapping below. |
| 4 | Done | Onboarding (key, repo, scan, profile review, sanity check), key in a 0600 file, versioned profile with a source per fact, export/import. The no-token key check (`models.retrieve`) is written but not yet run against the team's account. |
| 5 | Built, offline-scored | Digest, features, rubric, claim checker, prompt v1 (about 6.2K cached tokens), 284 evaluation cases, runner, example picker, regression gate (all offline gates pass). The live baseline and prompt v1 runs need the key (about $0.15 per validation run). |
| 6 | Built | Chat edits with tools, compile check before every write, spend cap with Continue, undo (edits and writes). Checked in the browser end to end with the test model. The three-student timed test is the team's. |

### Decisions taken while building

- Generated autos (2026-10-08): Write gives each new auto its own files, named by the half it starts in. Near is
  the half with the CELL that holds the NECTAR at the start (BLUE y >= 72); the rotation to red keeps the half.
  The files are `AutoNearPaths.java` and `AutoBlueNear.java` / `AutoRedNear.java`, which show as "Blue_Near" and
  "Red_Near" on the Driver Station. A second auto in the same half gets `Near2` / "Blue_Near_2". AutoPaths keeps
  writing `AutoPaths.java`. A one-time `route()` hook in AutoRunner is confirmed before it is written. Write
  creates Blue first, then offers the Red auto (alliance flip: the reflection through (72, 72), applied by
  `MatchState.poseFactory`). The Red file joins the same Undo write.
- AI reliability (2026-10-08): the model writes measured values as `{L3.dist}` and code fills them in. A wrong
  number is corrected to the computed value; a number with no source becomes "[?]" and is logged. Neither throws
  away the answer any more: repairs are only for invalid ops, missing labels or unknown keys. The prompt now
  includes a text field map, a geometry module (sides, Near/Far, HIVE, CELLs, aim formula, clearance, intake)
  and the route drawn on the map with each stop described in words. Claude-account mode defaults to Opus 5.5
  (effort high; it can be changed in Settings). It keeps the chat history of each auto and uses the newest
  `claude` on the computer. Live check on the team's placeholder auto: annotate finished in 28 s with 0 repairs.
  A heading edit finished with 1 repair; its new heading was exactly the bearing to the CELL.

- The spec is pose-centric: named poses are the Java fields and legs reference them, so Java round-trips exactly
  and the AI edits by name (`move_pose shot2`). The `end.timeoutS` of the sketch is dropped: AutoRunner's shot
  timeouts are constants (`READY_TIMEOUT_S`, `SHOT_ABANDON_S`). Per-leg `legTimeoutS` and `carryIntakeS` stay.
- Label mapping (milestone 3, from `AutoRunner.runLeg/nextLeg`): SHOOT = `SHOOT`, PARK = `PARK`, INTAKE_DWELL =
  `INTAKE` (the intake runs during the leg into the junction, plus `carryIntake`), REPOSITION and SETTLE = `NONE`
  (no code truth between them: consistency only; imported `NONE` stops are split by move length),
  NEEDS_REVIEW or no label = not writable. AutoRunner has one action per leg, so "intake on the way and shoot at
  the end" is refused with a hint (split the leg or use carryIntake).
- AutoRunner reads `new AutoPaths()`, so v1 writes one auto slot. Other autos live as specs on the laptop and
  become the robot's auto when written. Several autos on the Driver Station need a small AutoRunner hook: a
  team decision, not done.
- Features follow AutoRunner exactly: every leg starts and ends at rest; an unreachable CELL makes the shot
  skip after `SHOT_ABANDON_S` and fire nothing; FLOWER stacks need the ramp, which AutoRunner never deploys, so
  they are never counted (flagged). Pedro facts checked with `javap`: linear heading is the shortest signed
  turn spread over the arc-length fraction.
- Compile check: javac on TeamCode with the new file swapped in, against the jars Gradle downloaded for
  `build.dependencies.gradle` (POMs followed) and `android.jar`. The full Gradle compile is a button.
- The claim checker is strict: every number in the AI's text must be declared in `claims` with a feature key
  and match the computed value; ordinals ("rule 6", "shot 2") are exempt. Hallucinations are counted over every
  submit attempt, accepted or not.
- The rubric also runs in code: the offline "Label with the code rubric" button, the optional candidate hint
  (an ablation), and the oracle of the synthetic cases.
- Leg ids are positional (renumbered L1..Ln after adding or removing legs).
- `AUTOTOOL_FAKE_MODEL=1` answers AI requests with the rubric (testing only, no API calls).

### Evaluation so far

| Check | Result |
|---|---|
| Cases | 284 code-labelled: 32 synthetic autos, 91 perturbations, 32 abstention, 128 metamorphic, 1 injection; split 106 train / 46 validation / 132 test |
| Rubric reference | 100% of 730 scored junctions, 0 must-not violations, 32/32 metamorphic groups consistent |
| Harness, scripted perfect model through the real agent and tools | 100%, schema valid first try, 0 invented numbers |
| Harness, bad model (all SHOOT, a wrong number) | every attempt flagged, nothing reached an answer |
| Prompt | lint clean, version stable, about 6.2K cached tokens + about 260 per task turn |

Not measured yet (needs the key; the approved evaluation budget is about $5, one validation run is about $0.15):

```bash
cd autotool && node eval/run.ts --model ai --prompt naive --split validation --budget 0.5 --out baseline-naive
```

```bash
cd autotool && node eval/run.ts --model ai --prompt v1 --split validation --budget 0.5 --out prompt-v1
```

Then the ablations (`--examples 0|2|4|6`, `--hint`, `--effort low|medium|high`, `--rubric prose`), `--repeat 3` for
agreement, and `node eval/regress.ts --live` to record the accepted baseline. The real-auto accuracy target needs
real autos: today the robot repo has only the placeholder (one PARK leg, poses not set). The DECODE cross-team
set needs the FTCLib adapter (section 20; not built).

### Checked against the robot repo and the simulator (2026-10-09)

- The route `Near_9` (8 legs) round-trips byte for byte and compiles with javac on the robot repo's real jars.
- Time model against the BIOBUZZ simulator, same route: with the defaults (40 in/s top, 30 in/s^2) the tool says
  27.1 s and the sim parked at 23.1 s (17% slow, the safe side). With the sim's measured top speed (69.3 in/s,
  what program 5 records) and 45 in/s^2 it says 22.7 s (2% off; every leg within about 1.5 s). So the model is sound
  and the error is the unmeasured speed and acceleration: the time bar says when they are still guesses. The profile
  reads the top speed from `Constants.maxAchievableForwardVelocity` as soon as program 5 has set it.
- RAMP legs count the POLLEN they take from a FLOWER bottom (G418 B) as unconfirmed items; the ramp reach is a
  profile fact (`rampReachIn`, 2 in until the CAD gives the ramp length). A RAMP leg that ends short says how far
  from the stack it ended.

### Robot data from team-config.yaml (2026-10-10)

The tool reads the CAD-dependent facts that have no Java field straight from `team-config.yaml`: `intakeReachIn`,
`intakeWidthIn`, `elementsPerShot`, `rampReachIn` and the test-drive numbers `driveAccelInS2`, `driveDecelInS2`,
`driveLatAccelInS2`, `driveMaxTurnDegS`. A `value: null` entry keeps the fact assumed and the profile says which line
of the yaml is empty; a number makes it measured. The intake mouth width is a profile fact of its own (it used to be
the robot width). Rescan picks the values up. The robot repo's `docs/BIOBUZZ_PLAN.md` ("When the CAD arrives") maps each
CAD item to its entry.

### Still open

- Run the live evaluation above; fill "Known confusions" (`autotool/eval/known-confusions.md`) from its misses.
- The timed test: three students, a first-time change, request to written files under 3 minutes.
- Robot dimensions, pivots, turret limits, shot range and drive speeds are assumed until the setup programs
  measure them; the profile marks each one and the AI is told.
- Create the GitHub repo, push, add it to the robot repo as `tools/autotool`, copy `autotool.sh` to the root.
