import assert from "node:assert/strict";
import { Input } from "../src/input.js";
globalThis.screen = { orientation: { angle: 90 } };
globalThis.window = {};
const input = Object.create(Input.prototype);
input._motionActive = true;
input.heldLandscape = null;
input._turnN = 0;
input.tiltPortrait = false;
input._frameSign = null;
// Landscape grip (angle 90): gravity on device x, a lean of `degrees` rolls it onto y.
const motion = (degrees) => {
  const a = (degrees * Math.PI) / 180;
  input._onMotion({ accelerationIncludingGravity: { x: -9.81 * Math.cos(a), y: 9.81 * Math.sin(a), z: 0 } });
};
// Re-centring waits for a steady grip (20 still samples) then averages 8 more.
const settle = (degrees) => {
  for (let i = 0; i < 40; i++) motion(degrees);
};
input.calibrate();
settle(0);
motion(10);
assert.ok(input._steerTarget > 0.2, "a deliberate lean should steer");
input.setMotionActive(false);
settle(85);
assert.equal(input._steerTarget, 0, "portrait menu motion must not steer");
input.setMotionActive(true);
settle(4);
assert.equal(input._steerTarget, 0, "resuming should center the current driving grip");
motion(14);
assert.ok(input._steerTarget > 0.2, "steering sensitivity must survive pause/resume");
input.calibrate();
assert.equal(input._steerTarget, 0, "recalibration must clear stale full-lock steering");
screen.orientation.angle = 270;
input.calibrate();
settle(0);
motion(10);
assert.ok(input._steerTarget < -0.2, "the opposite landscape grip must retain its steering polarity");

// --- Steady-grip re-centring: an unsettled hand is not "level" ---
screen.orientation.angle = 90;
input.calibrate();
for (let i = 0; i < 60; i++) motion(i % 2 ? 9 : -9); // jittering ±9° for a second
assert.equal(input._neutralRoll, null, "a jittering grip must not be taken as level");
assert.equal(input._steerTarget, 0, "steering stays neutral until the grip settles");
settle(6); // then holds still, leaning 6°
assert.ok(Math.abs(Math.abs(input._neutralRoll) - (6 * Math.PI) / 180) < 0.01, "the steady grip becomes level");
motion(6);
assert.equal(input._steerTarget, 0, "holding the settled grip steers straight");
motion(16);
assert.ok(input._steerTarget > 0.2, "a lean off the settled grip steers");
input.calibrate();
for (let i = 0; i < 95; i++) motion(i % 2 ? 3 : -3); // a ride that never settles
assert.notEqual(input._neutralRoll, null, "a bumpy ride still centres after the cap");

// --- Hold detection: a lean never flips it, a turn does after a beat ---
settle(0);
assert.equal(input.heldLandscape, true, "the landscape grip is read from gravity");
for (let i = 0; i < 200; i++) motion(55); // a wild 55° lean, held
assert.equal(input.heldLandscape, true, "a hard lean must not read as turning the phone upright");
for (let i = 0; i < 19; i++) motion(80); // turned upright, but not for long enough yet
assert.equal(input.heldLandscape, true, "a turn needs a beat before the hold changes");
motion(80);
assert.equal(input.heldLandscape, false, "a sustained turn upright changes the hold");
for (let i = 0; i < 200; i++) motion(35); // upright now; a 35° lean from upright (55° from sideways)
assert.equal(input.heldLandscape, false, "nor does a lean flip it back");
for (let i = 0; i < 20; i++) motion(0);
assert.equal(input.heldLandscape, true, "turning back sideways restores the landscape hold");

// --- Handheld (portrait) frame: the phone is upright, so gravity sits on device y
// and a left lean (screen-left = device -x going down) drops g.x. The stage
// hands over the axis AND the sign; the roll gain must match the landscape grip.
input.setTiltFrame(true, 1);
assert.equal(input._steerTarget, 0, "switching the tilt frame while live must re-centre");
assert.equal(input._neutralRoll, null, "...and re-capture the grip");
const upright = (degrees) => {
  const a = (degrees * Math.PI) / 180;
  input._onMotion({ accelerationIncludingGravity: { x: -9.81 * Math.sin(a), y: -9.81 * Math.cos(a), z: 0 } });
};
for (let i = 0; i < 40; i++) upright(0);
upright(10);
const portraitLean = input._steerTarget;
assert.ok(portraitLean > 0.2, "an upright left lean must steer left");
input.setTiltFrame(false, -1); // back to the sideways frame (angle 90's sign)
input.calibrate();
settle(0);
motion(10);
assert.ok(Math.abs(input._steerTarget - portraitLean) < 1e-9, "portrait and landscape leans must share one gain");
input.setTiltFrame(false, 1); // the stage drew the other way up: the sign follows the stage, not the screen angle
settle(0);
motion(10);
assert.ok(input._steerTarget < -0.2, "the steering sign comes from the stage frame");
input.setTiltFrame(true, 1);
input.setMotionActive(false);
input.setMotionActive(true);
for (let i = 0; i < 40; i++) upright(0);
upright(-10);
assert.ok(input._steerTarget < -0.2, "an upright right lean must steer right");
console.log(
  "PASS: menu motion isolation, resume neutral, steady-grip centring, lean-vs-turn hold, steering response and frame sign",
);
