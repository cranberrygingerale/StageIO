// SG.Physics — Newtonian point-mass gravity + orbital math.
//
// We work relative to a single dominant body (the planet). `mu = G*M` is the
// standard gravitational parameter; we never need G and M separately.
//
// Integration is semi-implicit (symplectic) Euler: update velocity from the
// acceleration at the *current* position, then move using the *new* velocity.
// This conserves orbital energy far better than explicit Euler, which would
// spiral a circular orbit outward over time.
window.SG = window.SG || {};

SG.Physics = (function () {
  // Gravitational acceleration on a body at (x,y) due to a body at (bx,by).
  // Returns {ax, ay}. Softened denominator avoids a singularity at r=0.
  function gravityAccel(x, y, body) {
    const dx = body.x - x;
    const dy = body.y - y;
    const r2 = dx * dx + dy * dy;
    const r = Math.sqrt(r2);
    if (r < 1e-6) return { ax: 0, ay: 0 };
    const a = body.mu / r2;      // magnitude
    return { ax: a * (dx / r), ay: a * (dy / r) };
  }

  // Advance a {x,y,vx,vy} state by dt under gravity from `body`, plus an
  // optional constant thrust acceleration {ax,ay}. Mutates and returns state.
  function integrate(state, body, dt, thrust) {
    const g = gravityAccel(state.x, state.y, body);
    let ax = g.ax;
    let ay = g.ay;
    if (thrust) {
      ax += thrust.ax;
      ay += thrust.ay;
    }
    // Semi-implicit Euler.
    state.vx += ax * dt;
    state.vy += ay * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;
    return state;
  }

  // Compute the orbit of a body relative to `planet` from position+velocity.
  // Returns apoapsis/periapsis *altitudes* (distance above the surface),
  // eccentricity, and whether the orbit is bound. All distances in world units.
  //
  // `bodyVel` (optional) is the planet's own velocity — passed when the planet
  // is itself moving (orbiting a star), so the orbit is measured in the
  // planet's reference frame. Defaults to a stationary body.
  //
  // Uses the vis-viva / specific-orbital-energy formulation:
  //   energy = v^2/2 - mu/r
  //   a (semi-major axis) = -mu / (2*energy)          [negative energy => bound]
  //   eccentricity from the eccentricity vector magnitude
  //   apo/peri radius = a*(1 ± e)
  function orbit(state, planet, bodyVel) {
    const bvx = bodyVel ? bodyVel.vx : 0;
    const bvy = bodyVel ? bodyVel.vy : 0;
    const dx = state.x - planet.x;
    const dy = state.y - planet.y;
    const r = Math.hypot(dx, dy);
    const rvx = state.vx - bvx;      // velocity relative to the planet
    const rvy = state.vy - bvy;
    const v2 = rvx * rvx + rvy * rvy;
    const mu = planet.mu;

    const energy = v2 / 2 - mu / r;

    // Eccentricity vector: e_vec = ((v^2 - mu/r) * r_vec - (r·v) * v_vec) / mu
    const rdotv = dx * rvx + dy * rvy;
    const c = v2 - mu / r;
    const ex = (c * dx - rdotv * rvx) / mu;
    const ey = (c * dy - rdotv * rvy) / mu;
    const ecc = Math.hypot(ex, ey);

    const bound = energy < 0;
    let apoAlt, periAlt, semiMajor;

    if (bound) {
      semiMajor = -mu / (2 * energy);
      const apoR = semiMajor * (1 + ecc);
      const periR = semiMajor * (1 - ecc);
      apoAlt = apoR - planet.radius;
      periAlt = periR - planet.radius;
    } else {
      // Hyperbolic/parabolic escape: no apoapsis. Periapsis still defined.
      semiMajor = Infinity;
      apoAlt = Infinity;
      const periR = (mu / v2) * (ecc - 1); // valid for e>1; fall back if needed
      periAlt = isFinite(periR) ? periR - planet.radius : r - planet.radius;
    }

    return {
      radius: r,
      altitude: r - planet.radius,
      speed: Math.sqrt(v2),
      eccentricity: ecc,
      apoapsis: apoAlt,
      periapsis: periAlt,
      semiMajor,
      bound,
    };
  }

  // Circular-orbit speed at radius r: v = sqrt(mu/r). Used for tuning & tests.
  function circularSpeed(r, planet) {
    return Math.sqrt(planet.mu / r);
  }

  return { gravityAccel, integrate, orbit, circularSpeed };
})();

// --- Numerical self-test -----------------------------------------------------
// A body launched at exactly circular-orbit speed should hold a near-constant
// altitude for a full revolution. If the integrator or math is wrong, altitude
// drifts. Runs once at load and logs PASS/FAIL to the console.
SG.Physics.selfTest = function () {
  const planet = { x: 0, y: 0, mu: 1e9, radius: 600 };
  const r0 = 1200;
  const v = SG.Physics.circularSpeed(r0, planet); // tangential (in +y)
  const state = { x: r0, y: 0, vx: 0, vy: v };

  const period = 2 * Math.PI * Math.sqrt((r0 * r0 * r0) / planet.mu);
  const dt = 1 / 120;
  const steps = Math.round(period / dt);

  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (let i = 0; i < steps; i++) {
    SG.Physics.integrate(state, planet, dt, null);
    const alt = Math.hypot(state.x, state.y) - planet.radius;
    if (alt < minAlt) minAlt = alt;
    if (alt > maxAlt) maxAlt = alt;
  }
  const nominalAlt = r0 - planet.radius;
  const drift = (maxAlt - minAlt) / nominalAlt;
  const pass = drift < 0.02; // < 2% altitude wobble over one orbit
  console.log(
    `[SG.Physics.selfTest] circular-orbit drift = ${(drift * 100).toFixed(2)}% ` +
      `over one revolution — ${pass ? "PASS ✅" : "FAIL ❌"}`
  );
  return pass;
};
