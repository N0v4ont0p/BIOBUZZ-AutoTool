package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.api.Paths;
import com.pedropathing.follower.Follower;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.qualcomm.hardware.gobilda.GoBildaPinpointDriver;
import com.qualcomm.hardware.lynx.LynxModule;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.util.ElapsedTime;

import org.firstinspires.ftc.teamcode.config.DeviceNames;
import org.firstinspires.ftc.teamcode.config.LiveResults;
import org.firstinspires.ftc.teamcode.config.Field;
import org.firstinspires.ftc.teamcode.config.MatchState;
import org.firstinspires.ftc.teamcode.config.Tuned;
import org.firstinspires.ftc.teamcode.pedro.Constants;
import org.firstinspires.ftc.teamcode.subsystems.AutoAim;
import org.firstinspires.ftc.teamcode.subsystems.Intake;
import org.firstinspires.ftc.teamcode.subsystems.Launcher;
import org.firstinspires.ftc.teamcode.subsystems.Ramp;
import org.firstinspires.ftc.teamcode.subsystems.Yaw;

import java.util.List;

/**
 * The engine every autonomous OpMode of this robot runs on: it drives a list of {@link Leg}s in order. An auto
 * only says WHERE to go and WHAT to do on the way and at the end; this class owns all the hardware and the
 * safety rules, so every auto shoots, collects and parks the same tested way.
 *
 * <h2>A leg is the whole story</h2>
 * A {@link Leg} is a path (or a target pose), what the robot does while it drives that path ({@link During}),
 * what it does when it gets there ({@link End}), and a few options:
 * <pre>
 * new Leg(gateToRow(), During.INTAKE, End.SHOOT).timeout(3.5)   // collect on the way, shoot at the end
 * new Leg(toFlower(), During.RAMP, End.WAIT).waitFor(1.5)       // ramp out, hold at the FLOWER 1.5 s
 * new Leg(park, During.NONE, End.PARK)                          // straight to park from wherever it is
 * </pre>
 * The older two-argument form {@code new Leg(path, Action.SHOOT)} still works: each {@link Action} is a
 * shortcut for one During/End pair (see {@link Action}).
 *
 * <h2>How an auto uses it</h2>
 * <pre>
 * public class Near_9 {
 *     &#64;Autonomous(name = "Blue_Near_9", group = "AutoTool")
 *     public static class Blue extends AutoRunner {
 *         protected MatchState.Alliance alliance() { return MatchState.Alliance.BLUE; }
 *         protected Route route() { return new Plan(); }   // start() + legs()
 *     }
 *     &#64;Autonomous(name = "Red_Near_9", group = "AutoTool")
 *     public static class Red extends Blue { ... alliance() returns RED ... }
 *     static class Plan implements Route { ... }
 * }
 * </pre>
 * Red overrides only {@link #alliance()}: every pose is built through {@code MatchState.poseFactory()}, which
 * reflects the blue route through the field centre for red.
 *
 * <h2>What happens in each OpMode phase</h2>
 * <ul>
 *   <li><b>INIT</b> ({@link #init()}): restores tuned numbers, checks every device in the configuration, zeroes the
 *   turret (it must point straight forward), creates the follower, reads the route and puts the robot on the
 *   start pose. Nothing moves (R102). Any problem is shown as "WILL NOT DRIVE" and the auto does nothing.</li>
 *   <li><b>INIT loop</b> ({@link #init_loop()}): shows the alliance, turret zero, pose and Pinpoint health.</li>
 *   <li><b>START</b> ({@link #start()}): starts the match clock, closes both gates, starts leg 1.</li>
 *   <li><b>LOOP</b> ({@link #loop()}): updates the follower, aims (turret + flywheels) every loop, runs the current
 *   leg, aborts at {@link #ABORT_AT_S}, warns if the robot centre crosses to the opponent side (G402).</li>
 *   <li><b>STOP</b> ({@link #stop()}): publishes the final pose for TeleOp and stops every mechanism.</li>
 * </ul>
 *
 * <h2>A leg, step by step</h2>
 * <ol>
 *   <li>The robot follows the leg's path (or a straight line to its target pose from wherever it is).</li>
 *   <li>While it drives: {@link During#INTAKE} runs the intake for the whole path, {@link During#RAMP} also
 *   deploys the ramp. The intake also runs during the previous leg's {@link Leg#carryIntake} time, and on every
 *   leg when the route asks for persistent intake ({@link Route#intakeAlways()}).</li>
 *   <li>The drive ends when the path is done or the leg's {@link Leg#timeout} passes.</li>
 *   <li>Then the end: {@link End#SHOOT} holds the pose and fires (below), {@link End#WAIT} holds still for
 *   {@link Leg#waitFor} seconds (the intake and ramp keep doing what they did while driving), {@link End#PARK}
 *   holds and finishes the auto, {@link End#NONE} goes straight on.</li>
 * </ol>
 *
 * <h2>A shot (End.SHOOT)</h2>
 * Phase 1: hold the pose, intake off, ramp stowed; wait until the robot is stopped ({@link #STOPPED_SPEED},
 * {@link #STOPPED_TURN_DEG}), the aim is locked and both flywheels are at speed, all for {@link #SETTLE_S}. If
 * that does not happen within {@link #READY_TIMEOUT_S} but the robot is stopped and aimed, fire anyway; if it
 * never stops or has no aim within the leg's {@link Leg#shotTimeout} (default {@link #SHOT_TIMEOUT_S}), skip the
 * shot. Phase 2: open both gates, wait {@code Tuned.gateTravelS}, then feed at the shot-table feed power,
 * counting only time while both flywheels are at speed, until {@link #FEED_S}. Then close the gates and go on.
 *
 * <h2>Safety the autos get for free</h2>
 * Never fires while moving or without an aim solution; feeds only at speed; the intake is off during shots;
 * the whole auto stops at {@link #ABORT_AT_S}; the ramp is stowed on every leg that is not RAMP; TeleOp gets
 * the alliance and the last pose through {@link MatchState}.
 *
 * <p>Not here yet (add to the Leg, and to SampleAutoPaths, when a real auto or the CAD needs them): firing one
 * launcher only and counting elements. Both would be options on an End.SHOOT leg.</p>
 *
 * <p>Generated by refract-suite ftc-construct; restructured around the Leg (path + during + end + options) for
 * AutoTool, from the DECODE 19859 command-based autos, and documented.</p>
 */
public abstract class AutoRunner extends OpMode {

    /** What the robot does while it drives a leg's path. */
    public enum During {
        /** Just drive. */
        NONE,
        /** Run the intake for the whole path (and {@link Leg#carryIntake} into the next leg). */
        INTAKE,
        /** Like INTAKE, with the POLLEN ramp deployed (FLOWER bottom, G418); stowed when a leg that is not RAMP starts. */
        RAMP
    }

    /** What the robot does when it reaches the end of a leg's path. */
    public enum End {
        /** Go straight on to the next leg. */
        NONE,
        /** Hold the pose and fire (see the class comment for the shot sequence). */
        SHOOT,
        /** Hold the end pose and finish the auto (every later leg is skipped). */
        PARK,
        /** Hold still for {@link Leg#waitFor} seconds, intake and ramp as they were while driving. */
        WAIT
    }

    /**
     * The older one-word form of a leg, kept so autos written before During/End still compile. Each is one
     * During/End pair: NONE = (NONE, NONE), INTAKE = (INTAKE, NONE), RAMP = (RAMP, NONE), SHOOT = (NONE, SHOOT),
     * PARK = (NONE, PARK).
     */
    public enum Action {
        NONE(During.NONE, End.NONE),
        INTAKE(During.INTAKE, End.NONE),
        RAMP(During.RAMP, End.NONE),
        SHOOT(During.NONE, End.SHOOT),
        PARK(During.NONE, End.PARK);

        final During during;
        final End end;

        Action(During during, End end) {
            this.during = during;
            this.end = end;
        }
    }

    /**
     * One step of an auto: a path (or a target pose), what happens while driving it, what happens at its end, and
     * options set with the builder methods below, for example
     * {@code new Leg(rowToShot(), During.INTAKE, End.SHOOT).timeout(3.5).carryIntake(0.3)}. Times are in seconds.
     */
    public static final class Leg {
        /** The path to follow, or null for a {@link #target} leg. */
        final Path path;
        /** For a target leg: drive in a straight line from wherever the robot is to this pose. */
        final Pose target;
        /** While driving. */
        final During during;
        /** At the end of the path. */
        final End end;
        /** Give up driving after this long (default {@link #LEG_TIMEOUT_S}). */
        double timeoutS = LEG_TIMEOUT_S;
        /** INTAKE/RAMP: keep the intake running this long into the next leg. */
        double carryS = 0;
        /** SHOOT: skip the shot if the robot is not stopped and aimed within this long (default {@link #SHOT_TIMEOUT_S}). */
        double shotTimeoutS = SHOT_TIMEOUT_S;
        /** WAIT: how long to hold still at the end of the path. */
        double waitS = 0;

        /** Follow {@code path}; {@code during} while driving it, {@code end} when it is done. */
        public Leg(Path path, During during, End end) {
            this.path = path;
            this.target = null;
            this.during = during == null ? During.NONE : during;
            this.end = end == null ? End.NONE : end;
        }

        /**
         * Straight line from wherever the robot is when the leg starts to {@code target} (DECODE 19859
         * DriveCurrentToPoint). Use after a leg that ends pressed into elements or a wall, where the planned end
         * pose is not where the robot actually stopped.
         */
        public Leg(Pose target, During during, End end) {
            this.path = null;
            this.target = target;
            this.during = during == null ? During.NONE : during;
            this.end = end == null ? End.NONE : end;
        }

        /** Shortcut: {@code new Leg(path, Action.SHOOT)} = {@code new Leg(path, During.NONE, End.SHOOT)}. */
        public Leg(Path path, Action action) {
            this(path, action.during, action.end);
        }

        /** Shortcut for a target leg: {@code new Leg(park, Action.PARK)} = {@code new Leg(park, During.NONE, End.PARK)}. */
        public Leg(Pose target, Action action) {
            this(target, action.during, action.end);
        }

        /** Stop driving after {@code seconds} even if the path is not done: for legs that end pressing into elements or a wall. */
        public Leg timeout(double seconds) {
            timeoutS = Math.max(0, seconds);
            return this;
        }

        /** INTAKE and RAMP legs: keep the intake running this long into the next leg to pull in the last element (DECODE ran 0.2-0.7 s). */
        public Leg carryIntake(double seconds) {
            carryS = Math.max(0, seconds);
            return this;
        }

        /** SHOOT legs: give up on the shot if the robot is not stopped and aimed within this long. */
        public Leg shotTimeout(double seconds) {
            shotTimeoutS = Math.max(0, seconds);
            return this;
        }

        /** WAIT legs: hold still this long at the end of the path (DECODE held 3 s at the gate with the intake on). */
        public Leg waitFor(double seconds) {
            waitS = Math.max(0, seconds);
            return this;
        }
    }

    // ---- tuning constants (start values carried from DECODE's far auto; tune in practice) ----

    /** Robot counts as stopped below this speed (in/s). */
    public static final double STOPPED_SPEED = 1.0;
    /** ... and below this turn rate (deg/s). */
    public static final double STOPPED_TURN_DEG = 2.0;
    /** Ready (stopped + aimed + at speed) must hold this long before firing (s). */
    private static final double SETTLE_S = 0.3;
    /** Fire anyway after this long if stopped and aimed but not fully ready (s). */
    private static final double READY_TIMEOUT_S = 2.0;
    /** Seconds of feeding (counted only while the launcher(s) are at speed) per shot. */
    public static final double FEED_S = 0.55;
    /** Default {@link Leg#shotTimeout}: skip a shot that is not ready within this long; also the most a feed takes (s). */
    private static final double SHOT_TIMEOUT_S = 4.0;
    /** Default leg timeout (s). */
    private static final double LEG_TIMEOUT_S = 7.0;
    /** Stop everything at this match time so nothing moves after AUTO (s). */
    private static final double ABORT_AT_S = 28.5;

    /** The alliance this OpMode plays (Red autos override this; everything else follows from it). */
    protected abstract MatchState.Alliance alliance();

    /** An auto's route: where it starts and its legs. */
    public interface Route {
        /** False while a pose is still an unset Tuned value (NaN): the auto then refuses to drive. */
        boolean isReady();

        /** The start pose (the robot is placed here at INIT). */
        Pose start();

        /** The legs, in order. */
        List<Leg> legs();

        /**
         * Persistent intake: true runs the intake for the whole auto (every leg, every wait), except while a shot
         * is aiming and feeding, when the shot owns it. Use when the robot should pick up anything it drives over.
         * The ramp still only comes out on RAMP legs. Default: false (the intake runs only on INTAKE/RAMP legs).
         */
        default boolean intakeAlways() {
            return false;
        }
    }

    /**
     * The route this OpMode runs. The default is SampleAutoPaths (the reference route); AutoTool's autos
     * (Blue_Near, Red_Far, ...) override this and bring their own. Built after the alliance is set, so its
     * poses come out rotated for red.
     */
    protected Route route() {
        return new Route() {
            private SampleAutoPaths p; // built after the ready check, as before

            private SampleAutoPaths p() {
                if (p == null) p = new SampleAutoPaths();
                return p;
            }

            @Override
            public boolean isReady() {
                return SampleAutoPaths.ready();
            }

            @Override
            public Pose start() {
                return p().start();
            }

            @Override
            public List<Leg> legs() {
                return p().legs();
            }
        };
    }

    // ---- hardware and state ----

    private Follower follower;
    private GoBildaPinpointDriver pinpoint;
    private Yaw yaw;
    private Intake intake;
    private Ramp ramp;
    private Launcher front, back;
    private List<Leg> legs;
    /** The route's {@link Route#intakeAlways()}: the intake runs all auto except during shots. */
    private boolean intakeAlways = false;
    /** Set when INIT finds something wrong: the auto then never drives. */
    private String problem = null;
    private String status = "init";
    private int legIndex = -1;
    /** 0 = driving the leg, 1 = shot: waiting until ready, 2 = shot: gate travel + feeding, 3 = End.WAIT: holding at the path end. */
    private int shotPhase = 0;
    /** Match time until which the previous leg's carryIntake keeps the intake running. */
    private double carryUntilS = 0;
    private double fedS = 0, lastFeedS = 0;
    private boolean anchored = false, wasReady = false, frozen = false;
    private final ElapsedTime matchTimer = new ElapsedTime();
    private final ElapsedTime legTimer = new ElapsedTime();
    private final ElapsedTime shotTimer = new ElapsedTime();
    private final ElapsedTime settleTimer = new ElapsedTime();
    private final ElapsedTime waitTimer = new ElapsedTime();
    private AutoAim.Solution aim = new AutoAim.Solution();
    private Pose startPose;

    /** INIT: checks devices, zeroes the turret, builds the follower and the route, places the robot. Nothing moves. */
    @Override
    public void init() {
        // a setup program run before this one may have put numbers from the results file in place
        LiveResults.restore();
        for (LynxModule hub : hardwareMap.getAll(LynxModule.class)) hub.setBulkCachingMode(LynxModule.BulkCachingMode.AUTO);
        MatchState.alliance = alliance();
        MatchState.pose = null;
        MatchState.teleOpPoseMs = 0;
        String missing = DeviceNames.missing(hardwareMap, DeviceNames.ALL);
        if (!missing.isEmpty()) {
            problem = "MISSING DEVICES: " + missing + " — fix Configure Robot (setup step D-1)";
            return;
        }
        yaw = new Yaw(hardwareMap);
        yaw.zero();
        MatchState.yawZeroed = true;
        intake = new Intake(hardwareMap);
        ramp = new Ramp(hardwareMap);
        front = Launcher.front(hardwareMap);
        back = Launcher.back(hardwareMap);
        try {
            follower = Constants.create(hardwareMap);
            pinpoint = Constants.pinpoint(hardwareMap);
        } catch (IllegalStateException e) {
            problem = e.getMessage();
            return;
        }
        Route paths = route();
        if (!paths.isReady()) {
            problem = "auto poses not set: blueStart/bluePark (H-2) for the sample, or the route is incomplete";
            return;
        }
        legs = paths.legs();
        intakeAlways = paths.intakeAlways();
        startPose = paths.start();
        follower.setPose(startPose);
    }

    /** INIT loop: alliance, turret zero, pose and Pinpoint health on the Driver Station. */
    @Override
    public void init_loop() {
        if (follower != null) follower.update();
        telemetry.addData("Alliance", alliance());
        if (yaw != null && yaw.hasIndex()) {
            telemetry.addLine(yaw.indexZero() ? String.format(java.util.Locale.US, "Turret zero: INDEXED (from the index switch), front turret at %.1f deg", yaw.frontDeg())
                    : "Turret zero: turn the turrets slowly LEFT through forward until this says INDEXED" + (yaw.indexTooFast() ? " (too fast: back right past it, then slower)" : ""));
        } else if (yaw != null) {
            telemetry.addLine("Both turrets pointing straight forward? They are zeroed now. If not: STOP, turn them forward by hand, INIT again.");
        }
        if (problem != null) telemetry.addData("WILL NOT DRIVE", problem);
        if (follower != null) addPose(follower.pose());
        if (pinpoint != null) telemetry.addData("Pinpoint", Constants.pinpointHealth(pinpoint));
        telemetry.update();
    }

    /** START: the match clock starts, both gates close, leg 1 begins. */
    @Override
    public void start() {
        matchTimer.reset();
        if (problem != null) return;
        follower.setPose(startPose);
        front.setGate(false);
        back.setGate(false);
        nextLeg();
    }

    /** Every loop: follower, aim (turret + flywheels), the current leg, the abort time, telemetry. */
    @Override
    public void loop() {
        if (problem != null) {
            telemetry.addData("Not running", problem);
            telemetry.update();
            return;
        }
        follower.update();
        Pose pose = follower.pose();
        MatchState.pose = pose;

        double currentFrontDeg = Yaw.calibrated() ? yaw.frontDeg() : Double.NaN;
        aim = AutoAim.solve(pose, follower.velocity(), MatchState.alliance, currentFrontDeg, 0, 0);
        boolean active = legIndex < legs.size();
        Leg leg = active && legIndex >= 0 ? legs.get(legIndex) : null;
        // turret: held still during a shot, otherwise on the CELL
        if (!active) yaw.hold();
        else if (frozen) yaw.hold();
        else if (aim.valid) yaw.track(aim.commandFrontDeg, aim.rateFeedforwardDeg);
        else yaw.track(0, 0);
        // flywheels: always at the speed for the distance to the CELL, so a shot is ready when the robot stops
        if (active && aim.valid) {
            front.aim(aim.frontDistance, 0, 0);
            back.aim(aim.backDistance, 0, 0);
        } else if (active) {
            front.idle();
            back.idle();
        }

        if (matchTimer.seconds() > ABORT_AT_S && legIndex < legs.size()) {
            finish("abort at " + ABORT_AT_S + " s");
        } else if (leg != null) {
            runLeg(leg, pose);
        }

        boolean crossed = MatchState.alliance == MatchState.Alliance.RED ? pose.x() > Field.CENTER : pose.x() < Field.CENTER;
        if (crossed) telemetry.addLine("WARNING: robot centre on the opponent side (G402)");
        telemetry.addData("Time", "%.1f s", matchTimer.seconds());
        telemetry.addData("Leg", "%d / %d", Math.min(legIndex + 1, legs.size()), legs.size());
        telemetry.addData("Status", status);
        addPose(pose);
        telemetry.addData("Aim", aim.valid ? (aim.locked ? "LOCKED" : "tracking") : aim.problem);
        telemetry.addData("Pinpoint", Constants.pinpointHealth(pinpoint));
        telemetry.addData("Flywheels F/B", "%.0f/%.0f  %.0f/%.0f", front.velocity(), front.target(), back.velocity(), back.target());
        telemetry.update();
    }

    /** STOP: the last pose goes to TeleOp (MatchState.pose); every mechanism stops. */
    @Override
    public void stop() {
        if (follower != null) MatchState.pose = follower.pose();
        if (yaw == null) return;
        intake.stop();
        stowRamp();
        front.stop();
        back.stop();
        yaw.stop();
    }

    /** One loop of the current leg: drive (phase 0), shot (1-2), or the wait at its end (3). */
    private void runLeg(Leg leg, Pose pose) {
        double t = legTimer.seconds();
        if (shotPhase == 3) {
            // End.WAIT: hold still; the intake keeps doing what it did while driving
            if (intakeWanted(leg)) intake.in();
            else intake.stop();
            if (waitTimer.seconds() >= leg.waitS) {
                shotPhase = 0;
                nextLeg();
            }
            return;
        }
        if (shotPhase == 0) {
            if (intakeWanted(leg)) intake.in();
            else intake.stop();
            boolean pathDone = !follower.following() || follower.atParametricEnd() || t > leg.timeoutS;
            if (!pathDone) return;
            switch (leg.end) {
                case SHOOT:
                    follower.hold(pose);
                    stowRamp();
                    shotPhase = 1;
                    anchored = false;
                    wasReady = false;
                    shotTimer.reset();
                    settleTimer.reset();
                    status = "shoot: parked, waiting";
                    break;
                case PARK:
                    follower.hold(pose);
                    finish("parked");
                    break;
                case WAIT:
                    follower.hold(pose);
                    shotPhase = 3;
                    waitTimer.reset();
                    status = String.format(java.util.Locale.US, "leg %d: waiting %.1f s", legIndex + 1, leg.waitS);
                    break;
                default:
                    nextLeg();
            }
            return;
        }
        if (shotPhase == 1) {
            intake.stop();
            if (!anchored && stopped()) {
                anchored = true;
                follower.hold(follower.pose());
            }
            boolean aimed = aim.valid && aim.locked;
            boolean ready = stopped() && aimed && front.ready() && back.ready();
            if (ready && !wasReady) settleTimer.reset();
            wasReady = ready;
            boolean settled = ready && settleTimer.seconds() >= SETTLE_S;
            // never fire while moving or with no aim solution (launchers would be at idle speed)
            boolean gaveUp = shotTimer.seconds() > READY_TIMEOUT_S + SETTLE_S && stopped() && aim.valid;
            if (settled || gaveUp) {
                frozen = true;
                shotPhase = 2;
                shotTimer.reset();
                fedS = 0;
                boolean gatesSet = front.setGate(true) & back.setGate(true);
                if (!gatesSet || Double.isNaN(Tuned.gateTravelS)) {
                    endShot();
                    status = "shot skipped (gate positions/travel not set, E-8), " + status;
                    return;
                }
                status = settled ? "shoot: firing" : "shoot: firing on timeout (not locked/at speed)";
            } else if (shotTimer.seconds() > leg.shotTimeoutS) {
                shotPhase = 0;
                nextLeg();
                status = "shot skipped (" + (aim.valid ? "never stopped" : aim.problem) + "), " + status;
            }
            return;
        }
        if (shotTimer.seconds() < Tuned.gateTravelS) {
            intake.stop();
            lastFeedS = shotTimer.seconds();
            return;
        }
        // feed only while both flywheels are back at speed, so every element leaves like a tuned shot
        double now = shotTimer.seconds();
        if (front.ready() && back.ready()) {
            if (!intake.feed(Math.min(front.feedPower(aim.frontDistance), back.feedPower(aim.backDistance)))) status = "shoot: feed power not set (G-5)";
            fedS += now - lastFeedS;
        } else {
            intake.stop();
        }
        lastFeedS = now;
        if (fedS >= FEED_S || now >= SHOT_TIMEOUT_S) endShot();
    }

    /** The intake runs on INTAKE/RAMP legs, during the previous leg's carry, and on every leg with persistent intake. */
    private boolean intakeWanted(Leg leg) {
        return intakeAlways || leg.during != During.NONE || matchTimer.seconds() < carryUntilS;
    }

    /** Ends a shot: intake off, gates closed, turret free again, then the next leg. */
    private void endShot() {
        intake.stop();
        front.setGate(false);
        back.setGate(false);
        frozen = false;
        shotPhase = 0;
        nextLeg();
    }

    /** Starts the next leg (or finishes the auto after the last one). */
    private void nextLeg() {
        if (legIndex >= 0 && legIndex < legs.size() && legs.get(legIndex).during != During.NONE) {
            carryUntilS = matchTimer.seconds() + legs.get(legIndex).carryS;
        }
        legIndex++;
        anchored = false;
        if (legIndex >= legs.size()) {
            finish("done");
            return;
        }
        Leg leg = legs.get(legIndex);
        boolean rampMissing = leg.during == During.RAMP && !ramp.set(true);
        if (leg.during != During.RAMP) stowRamp();
        Pose from = follower.pose();
        follower.follow(leg.path != null ? leg.path : Paths.line(from, leg.target).linear(from, leg.target));
        legTimer.reset();
        status = "leg " + (legIndex + 1) + ": " + leg.during + " -> " + leg.end + (rampMissing ? " (ramp positions not set, E-8)" : "");
    }

    /** Ends the auto: intake off, ramp stowed, gates closed, flywheels off, turret free. */
    private void finish(String why) {
        legIndex = legs.size();
        intake.stop();
        stowRamp();
        front.setGate(false);
        back.setGate(false);
        front.stop();
        back.stop();
        frozen = false;
        status = why;
    }

    /** Stows the ramp; only moves the servo if the ramp is out. */
    private void stowRamp() {
        if (ramp.deployed()) ramp.set(false);
    }

    /** Below the stopped speed and turn rate. */
    private boolean stopped() {
        return Math.hypot(follower.velocity().vx, follower.velocity().vy) <= STOPPED_SPEED
                && Math.abs(Math.toDegrees(follower.velocity().omega)) <= STOPPED_TURN_DEG;
    }

    private void addPose(Pose p) {
        telemetry.addData("Pose", "%.1f, %.1f, %.1f deg", p.x(), p.y(), Math.toDegrees(p.heading()));
    }
}
