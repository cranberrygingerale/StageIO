// SG.Kepler — 2D two-body orbital mechanics (analytic).
//
// Used for two things:
//   1. "On-rails" time warp: at high warp we can't numerically integrate through
//      months of transfer time, so we convert the ship's state to orbital
//      elements and advance it ANALYTICALLY by any dt (KSP's rails warp).
//   2. Drawing the predicted orbit as a mathematically exact ellipse at any
//      scale, with no integration drift.
//
// All vectors are relative to the focus (the dominant body) in that body's
// reference frame. Elliptic orbits only (e < 1); callers fall back to numeric
// integration / clamp warp on hyperbolic (escape) trajectories.
window.SG = window.SG || {};

SG.Kepler = (function () {
  const TAU = Math.PI * 2;

  // Wrap an angle into [0, TAU).
  function wrap(a) {
    a %= TAU;
    return a < 0 ? a + TAU : a;
  }

  // Solve Kepler's equation M = E - e·sin(E) for eccentric anomaly E (Newton).
  function solveE(M, e) {
    M = wrap(M);
    let E = e < 0.8 ? M : Math.PI;      // good starting guesses
    for (let i = 0; i < 60; i++) {
      const f = E - e * Math.sin(E) - M;
      const fp = 1 - e * Math.cos(E);
      const d = f / fp;
      E -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return E;
  }

  // State vector (relative pos+vel) -> orbital elements.
  // Returns { a, e, omega, M, n, p, bound }.
  function elements(rx, ry, vx, vy, mu) {
    const r = Math.hypot(rx, ry);
    const v2 = vx * vx + vy * vy;
    const energy = v2 / 2 - mu / r;
    const a = -mu / (2 * energy);              // <0 for unbound orbits

    // Eccentricity vector.
    const rdotv = rx * vx + ry * vy;
    const c = v2 - mu / r;
    const ex = (c * rx - rdotv * vx) / mu;
    const ey = (c * ry - rdotv * vy) / mu;
    const e = Math.hypot(ex, ey);

    const bound = energy < 0 && e < 1;
    const omega = Math.atan2(ey, ex);          // argument of periapsis
    const theta = Math.atan2(ry, rx);          // current position angle
    const nu = theta - omega;                   // true anomaly now

    // True -> eccentric -> mean anomaly.
    const E = 2 * Math.atan2(
      Math.sqrt(Math.max(0, 1 - e)) * Math.sin(nu / 2),
      Math.sqrt(Math.max(0, 1 + e)) * Math.cos(nu / 2)
    );
    const M = E - e * Math.sin(E);
    const n = a > 0 ? Math.sqrt(mu / (a * a * a)) : 0; // mean motion

    return { a, e, omega, M, n, p: a * (1 - e * e), bound };
  }

  // Relative state at true anomaly nu, given elements + mu.
  function stateAtNu(el, mu, nu) {
    const r = el.p / (1 + el.e * Math.cos(nu));
    const cw = Math.cos(el.omega), sw = Math.sin(el.omega);
    const cn = Math.cos(nu), sn = Math.sin(nu);
    // Perifocal position + velocity.
    const xp = r * cn, yp = r * sn;
    const k = Math.sqrt(mu / el.p);
    const vxp = -k * sn, vyp = k * (el.e + cn);
    return {
      x: xp * cw - yp * sw,
      y: xp * sw + yp * cw,
      vx: vxp * cw - vyp * sw,
      vy: vxp * sw + vyp * cw,
    };
  }

  // Advance elliptic elements by dt seconds -> new relative state {x,y,vx,vy}.
  function propagate(el, mu, dt) {
    const M2 = el.M + el.n * dt;
    const E2 = solveE(M2, el.e);
    const nu2 = 2 * Math.atan2(
      Math.sqrt(Math.max(0, 1 + el.e)) * Math.sin(E2 / 2),
      Math.sqrt(Math.max(0, 1 - el.e)) * Math.cos(E2 / 2)
    );
    return stateAtNu(el, mu, nu2);
  }

  // Sample the full ellipse as relative points {x,y} for drawing (bound orbits).
  function sampleEllipse(el, mu, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const nu = (i / n) * TAU;
      const r = el.p / (1 + el.e * Math.cos(nu));
      const cw = Math.cos(el.omega), sw = Math.sin(el.omega);
      const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
      pts.push({ x: xp * cw - yp * sw, y: xp * sw + yp * cw });
    }
    return pts;
  }

  return { elements, propagate, stateAtNu, sampleEllipse, wrap };
})();
