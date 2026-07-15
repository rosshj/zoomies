// Scripted ground-truth motion for netsim clients. A driver answers poseAt(tMs)
// with the TRUE pose of a kart following a fixed path — the reference the harness
// measures interpolated remote poses against. Heading and speed are derived by
// finite difference of the position path, so the pose is always self-consistent
// (heading points along actual motion, speed = actual ground speed), matching how
// a real kart's sender would stamp them. Pure math (Math.sin/cos only) → runs
// identically every time.

function fromPath(posFn) {
  return {
    poseAt(tMs) {
      const t = tMs / 1000;
      const eps = 0.001; // 1ms central difference for velocity
      const a = posFn(t - eps);
      const b = posFn(t + eps);
      const vx = (b.x - a.x) / (2 * eps);
      const vz = (b.z - a.z) / (2 * eps);
      const here = posFn(t);
      return {
        x: here.x,
        y: 0,
        z: here.z,
        h: Math.atan2(vx, vz), // game convention: velocity = (sin h, cos h) * s
        p: 0,
        s: Math.hypot(vx, vz),
      };
    },
  };
}

// A constant-speed circle of the given radius (units) at the given ground speed
// (units/sec). `phase` (radians) staggers karts around the loop so they don't
// stack.
export function circleDriver({ radius = 60, speed = 30, phase = 0 } = {}) {
  const omega = speed / radius; // rad/sec
  return fromPath((t) => {
    const th = phase + omega * t;
    return { x: radius * Math.sin(th), z: radius * Math.cos(th) };
  });
}

// A Gerono lemniscate (figure-eight): x = R sin θ, z = R sin θ cos θ. Speed
// varies over the loop (fast through the crossing, slow at the lobes), which
// stresses the interpolator's speed handling more than a constant-speed circle.
// `omega` is the parameter rate; average ground speed scales with radius*omega.
export function figureEightDriver({ radius = 60, speed = 30, phase = 0 } = {}) {
  const omega = speed / radius;
  return fromPath((t) => {
    const th = phase + omega * t;
    return { x: radius * Math.sin(th), z: radius * Math.sin(th) * Math.cos(th) };
  });
}
