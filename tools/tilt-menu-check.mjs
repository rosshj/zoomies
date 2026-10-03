import assert from "node:assert/strict";
import { Input } from "../src/input.js";
globalThis.screen = { orientation: { angle: 90 } };
globalThis.window = {};
const input = Object.create(Input.prototype);
input._motionActive = true;
const motion = (degrees) => {
  const a = (degrees * Math.PI) / 180;
  input._onMotion({ accelerationIncludingGravity: { x: -9.81 * Math.cos(a), y: 9.81 * Math.sin(a), z: 0 } });
};
const settle = (degrees) => {
  for (let i = 0; i < 8; i++) motion(degrees);
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
// Handheld (portrait) frame: the phone is upright, so gravity sits on device y
// and a left lean (screen-left = device -x going down) drops g.x. The stage
// layout sets the axis; the roll gain and polarity must match the landscape grip.
screen.orientation.angle = 0;
input.setTiltPortrait(true);
assert.equal(input._steerTarget, 0, "switching the tilt axis while live must re-centre");
const upright = (degrees) => {
  const a = (degrees * Math.PI) / 180;
  input._onMotion({ accelerationIncludingGravity: { x: -9.81 * Math.sin(a), y: -9.81 * Math.cos(a), z: 0 } });
};
for (let i = 0; i < 8; i++) upright(0);
upright(10);
const portraitLean = input._steerTarget;
assert.ok(portraitLean > 0.2, "an upright left lean must steer left");
screen.orientation.angle = 90;
input.setTiltPortrait(false);
input.calibrate();
settle(0);
motion(10);
assert.ok(Math.abs(input._steerTarget - portraitLean) < 1e-9, "portrait and landscape leans must share one gain");
input.setTiltPortrait(true);
input.setMotionActive(false);
input.setMotionActive(true);
for (let i = 0; i < 8; i++) upright(0);
upright(-10);
assert.ok(input._steerTarget < -0.2, "an upright right lean must steer right");
console.log("PASS: menu motion isolation, resume neutral, steering response and calibration reset");
