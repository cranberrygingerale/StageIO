// SG.Maneuver — a single maneuver node: a planned velocity change (Δv) at a
// point on the ship's current orbit, plus the analytic prediction of the orbit
// it produces and whether that orbit runs into a moon's sphere of influence.
//
// Everything is done in the dominant body's reference frame (the same frame the
// on-rails propagation and the trajectory preview already use), so the drawn
// prediction matches how the ship will actually move.
//
// The node stores { t, pro, rad }:
//   t   — absolute sim-time of the burn (seconds)
//   pro — prograde Δv (m/s, +ve speeds up along velocity)
//   rad — radial Δv   (m/s, +ve pushes away from the body)
// In 2D that's a full description of an in-plane burn.
window.SG = window.SG || {};

SG.Maneuver = {
  TAU: Math.PI * 2,

  // Position of a body RELATIVE TO ITS PARENT at absolute time t. Bodies ride a
  // circular rail (bodies.js), so this is exact and needs no live state — which
  // is what lets us look into the future to find an encounter.
  relToParent(body, t) {
    const th = body.phase + body.omega * t;
    return { x: body.orbitRadius * Math.cos(th), y: body.orbitRadius * Math.sin(th) };
  },

  // A sensible default node: the ship's NEXT periapsis, where a prograde burn
  // most efficiently raises apoapsis (the Moon-transfer burn).
  makeNode(game) {
    const dom = game.dominant, s = game.ship;
    const el = SG.Kepler.elements(s.x - dom.x, s.y - dom.y, s.vx - dom.vx, s.vy - dom.vy, dom.mu);
    let lead = 60;
    if (el.bound && el.n > 0) lead = SG.Kepler.wrap(-el.M) / el.n; // time to periapsis
    return { t: game.simTime + lead, pro: 0, rad: 0 };
  },

  // Everything the game needs to draw/execute the node. Returns null if there's
  // no node; `.valid` is false when the current orbit isn't a closed ellipse
  // (can't plan a Kepler prediction from an escape trajectory in the basic model).
  compute(game) {
    const node = game.node;
    if (!node) return null;
    const dom = game.dominant, s = game.ship;
    const el = SG.Kepler.elements(
      s.x - dom.x, s.y - dom.y, s.vx - dom.vx, s.vy - dom.vy, dom.mu
    );
    const info = {
      dom, node,
      dt: Math.max(0, node.t - game.simTime),
      dvRemaining: Math.hypot(node.pro, node.rad),
      valid: el.bound,
    };
    if (!el.bound) return info;

    // Ship state at the node (coasting the current orbit until then).
    const ns = SG.Kepler.propagate(el, dom.mu, info.dt);
    const vsp = Math.hypot(ns.vx, ns.vy) || 1;
    const rsp = Math.hypot(ns.x, ns.y) || 1;
    const prU = { x: ns.vx / vsp, y: ns.vy / vsp };   // prograde (along velocity)
    const radU = { x: ns.x / rsp, y: ns.y / rsp };    // radial-out (away from body)
    const bx = node.pro * prU.x + node.rad * radU.x;  // burn vector (frame-relative)
    const by = node.pro * prU.y + node.rad * radU.y;
    const bmag = Math.hypot(bx, by);

    info.nodeRel = { x: ns.x, y: ns.y };
    info.prU = prU; info.radU = radU;
    info.burnUnit = bmag > 1e-6 ? { x: bx / bmag, y: by / bmag } : prU;

    // Orbit produced by the burn, in the dominant body's frame.
    info.postEl = SG.Kepler.elements(ns.x, ns.y, ns.vx + bx, ns.vy + by, dom.mu);
    info.encounter = this._findEncounter(game, dom, info.postEl, node.t);
    return info;
  },

  // Walk the predicted orbit forward one revolution; report the first time it
  // enters a child body's SOI (e.g. Earth-orbit → the Moon). Ship and moon are
  // both measured relative to the shared parent, so the comparison is exact.
  _findEncounter(game, dom, postEl, t0) {
    if (!postEl.bound || !(postEl.n > 0)) return null;
    const targets = game.world.system.bodies.filter(
      (b) => b.parent === dom && isFinite(b.soi)
    );
    if (!targets.length) return null;

    const period = this.TAU / postEl.n;
    const N = 360, step = period / N;
    for (let i = 1; i <= N; i++) {
      const tau = i * step;
      const rs = SG.Kepler.propagate(postEl, dom.mu, tau);   // ship rel. parent
      for (const b of targets) {
        const mp = this.relToParent(b, t0 + tau);            // moon rel. parent
        const d = Math.hypot(rs.x - mp.x, rs.y - mp.y);
        if (d < b.soi) {
          return { body: b, t: t0 + tau, tau, shipRel: { x: rs.x, y: rs.y }, bodyRel: mp };
        }
      }
    }
    return null;
  },
};
