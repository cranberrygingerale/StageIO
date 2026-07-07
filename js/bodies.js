// SG.Body / SG.SolarSystem — the celestial-body model.
//
// Design (patched conics, like KSP):
//  - Every non-root body moves on an ANALYTIC circular rail around its parent.
//    That keeps the system perfectly stable regardless of time warp and is cheap.
//  - Each body has a SPHERE OF INFLUENCE (SOI). The ship feels gravity from
//    exactly ONE body — the deepest SOI it currently sits inside. This gives
//    clean, stable orbits and a meaningful apo/peri readout.
window.SG = window.SG || {};

SG.Body = class Body {
  constructor(def) {
    this.name = def.name;
    this.radius = def.radius;
    this.mu = def.mu;                       // G*M
    this.color = def.color || "#8899aa";
    this.atmosphere = def.atmosphere || 0;   // atmosphere top altitude (m)
    // Sea-level density (kg/m^3). Defaults earthlike when an atmosphere exists.
    this.rho0 = def.rho0 !== undefined ? def.rho0 : (this.atmosphere > 0 ? 1.225 : 0);
    this.isHome = !!def.isHome;

    // Orbit around parent (ignored for the root body).
    this.parentName = def.parent || null;   // resolved to a Body by the factory
    this.parent = null;
    this.orbitRadius = def.orbitRadius || 0;
    this.phase = def.phase || 0;            // initial angle (radians)

    // Derived by the factory once parents are linked.
    this.omega = 0;                         // angular velocity (rad/s)
    this.soi = Infinity;                    // sphere-of-influence radius

    // Live state, filled by update().
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
  }

  get depth() {
    let d = 0, p = this.parent;
    while (p) { d++; p = p.parent; }
    return d;
  }

  // Position + velocity at absolute sim-time t. Parent MUST be updated first
  // (SolarSystem.update walks bodies shallow-to-deep to guarantee this).
  update(t) {
    if (!this.parent) {
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
      return;
    }
    const th = this.phase + this.omega * t;
    const cos = Math.cos(th), sin = Math.sin(th);
    this.x = this.parent.x + this.orbitRadius * cos;
    this.y = this.parent.y + this.orbitRadius * sin;
    // d/dt of the position (parent velocity + rotation term).
    this.vx = this.parent.vx - this.orbitRadius * this.omega * sin;
    this.vy = this.parent.vy + this.orbitRadius * this.omega * cos;
  }
};

SG.SolarSystem = class SolarSystem {
  constructor(bodies) {
    this.bodies = bodies;                         // array of SG.Body
    // Cache a shallow-to-deep ordering so parents update before children.
    this._order = bodies.slice().sort((a, b) => a.depth - b.depth);
    this.time = 0;
    this.update(0);
  }

  update(t) {
    this.time = t;
    for (const b of this._order) b.update(t);
  }

  root() {
    return this.bodies.find((b) => !b.parent) || this.bodies[0];
  }

  homeBody() {
    return this.bodies.find((b) => b.isHome) || this.root();
  }

  byName(name) {
    return this.bodies.find((b) => b.name === name) || null;
  }

  // The body whose gravity governs a point: the deepest SOI containing it.
  // "Deepest" = smallest SOI among containers (moon beats planet beats star).
  dominantBody(x, y) {
    let best = this.root();
    let bestSoi = Infinity;
    for (const b of this.bodies) {
      const dx = x - b.x, dy = y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < b.soi && b.soi <= bestSoi) {
        best = b;
        bestSoi = b.soi;
      }
    }
    return best;
  }

  // Serialize back to plain definitions (for save/export).
  toDefs() {
    return this.bodies.map((b) => ({
      name: b.name,
      parent: b.parentName,
      radius: b.radius,
      mu: b.mu,
      color: b.color,
      atmosphere: b.atmosphere,
      rho0: b.rho0,
      orbitRadius: b.orbitRadius,
      phase: b.phase,
      isHome: b.isHome,
    }));
  }
};
