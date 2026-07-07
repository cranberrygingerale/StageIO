// SG.Systems — default solar-system definitions + the factory that turns a flat
// list of body definitions into a live SG.SolarSystem (linking parents and
// computing angular velocity + sphere-of-influence radii).
window.SG = window.SG || {};

// A "definition" is plain data (JSON-friendly) so the system builder can
// create/edit/export/import them freely.
//
// The stock system is the REAL solar system in SI units:
//   radius        = mean body radius, metres
//   mu            = standard gravitational parameter G·M, m^3/s^2 (real values)
//   orbitRadius   = orbital semi-major axis around the parent, metres
//   atmosphere    = visual halo thickness, metres (cosmetic; no drag modelled)
//   phase         = starting angle, spread out so bodies aren't collinear
// Planet orbits are modelled as circular at their real semi-major axis (real
// eccentricities are small) which keeps the on-rails body math simple.
SG.Systems = {
  default: [
    { name: "Sun",     parent: null,     radius: 6.9634e8, mu: 1.32712440018e20, color: "#ffc234", atmosphere: 2.0e8 },

    { name: "Mercury", parent: "Sun",    radius: 2.4397e6, mu: 2.2032e13,  color: "#9c8b7d", atmosphere: 0,
      orbitRadius: 5.791e10,  phase: 0.3 },
    { name: "Venus",   parent: "Sun",    radius: 6.0518e6, mu: 3.24859e14, color: "#c9a969", atmosphere: 2.5e5,
      orbitRadius: 1.0821e11, phase: 1.9 },

    { name: "Earth",   parent: "Sun",    radius: 6.371e6,  mu: 3.986004418e14, color: "#3d6fb0", atmosphere: 1.4e5,
      orbitRadius: 1.496e11,  phase: 0.0, isHome: true },
    { name: "Moon",    parent: "Earth",  radius: 1.7374e6, mu: 4.9048695e12, color: "#9aa1a8", atmosphere: 0,
      orbitRadius: 3.844e8,   phase: 0.6 },

    { name: "Mars",    parent: "Sun",    radius: 3.3895e6, mu: 4.282837e13, color: "#c1552f", atmosphere: 6.0e4,
      orbitRadius: 2.2794e11, phase: 3.4 },
    { name: "Phobos",  parent: "Mars",   radius: 1.1e4,    mu: 7.11e5,     color: "#7a6a5c", atmosphere: 0,
      orbitRadius: 9.376e6,   phase: 0.2 },
    { name: "Deimos",  parent: "Mars",   radius: 6.2e3,    mu: 9.6e4,      color: "#8a7a6a", atmosphere: 0,
      orbitRadius: 2.346e7,   phase: 2.7 },

    { name: "Jupiter", parent: "Sun",    radius: 6.9911e7, mu: 1.26686534e17, color: "#c8a06a", atmosphere: 6.0e6,
      orbitRadius: 7.7857e11, phase: 5.1 },
    { name: "Io",      parent: "Jupiter", radius: 1.8216e6, mu: 5.959916e12, color: "#d8c56a", atmosphere: 0,
      orbitRadius: 4.217e8,   phase: 0.1 },
    { name: "Europa",  parent: "Jupiter", radius: 1.5608e6, mu: 3.202739e12, color: "#b8a68c", atmosphere: 0,
      orbitRadius: 6.711e8,   phase: 1.3 },
    { name: "Ganymede",parent: "Jupiter", radius: 2.6341e6, mu: 9.887834e12, color: "#8f8478", atmosphere: 0,
      orbitRadius: 1.0704e9,  phase: 2.6 },
    { name: "Callisto",parent: "Jupiter", radius: 2.4103e6, mu: 7.179289e12, color: "#6d635a", atmosphere: 0,
      orbitRadius: 1.8827e9,  phase: 4.0 },

    { name: "Saturn",  parent: "Sun",    radius: 5.8232e7, mu: 3.7931187e16, color: "#d8c288", atmosphere: 5.0e6,
      orbitRadius: 1.4335e12, phase: 2.1 },
    { name: "Titan",   parent: "Saturn", radius: 2.5747e6, mu: 8.978e12,    color: "#c9973f", atmosphere: 4.0e5,
      orbitRadius: 1.2219e9,  phase: 0.9 },

    { name: "Uranus",  parent: "Sun",    radius: 2.5362e7, mu: 5.793939e15, color: "#a9d6e0", atmosphere: 3.0e6,
      orbitRadius: 2.8725e12, phase: 4.6 },
    { name: "Neptune", parent: "Sun",    radius: 2.4622e7, mu: 6.836529e15, color: "#3a5fc8", atmosphere: 3.0e6,
      orbitRadius: 4.4951e12, phase: 0.7 },
    { name: "Triton",  parent: "Neptune", radius: 1.3534e6, mu: 1.427e12,   color: "#b7c4c9", atmosphere: 0,
      orbitRadius: 3.5476e8,  phase: 1.5 },
  ],
};

// Build a live SG.SolarSystem from an array of definitions.
// Robust to arbitrary user-authored systems (from the builder / import).
SG.buildSystem = function (defs) {
  const bodies = defs.map((d) => new SG.Body(d));
  const byName = {};
  for (const b of bodies) byName[b.name] = b;

  // Link parents.
  for (const b of bodies) {
    if (b.parentName && byName[b.parentName]) b.parent = byName[b.parentName];
    else b.parent = null; // dangling/absent parent -> treat as a root body
  }

  // Compute omega + SOI shallow-to-deep so a parent's mu is available first.
  const ordered = bodies.slice().sort((a, b) => a.depth - b.depth);
  for (const b of ordered) {
    if (b.parent && b.orbitRadius > 0) {
      // Circular-orbit angular velocity: omega = sqrt(mu_parent / r^3).
      b.omega = Math.sqrt(b.parent.mu / Math.pow(b.orbitRadius, 3));
      // SOI radius: r * (mu / mu_parent)^(2/5).
      b.soi = b.orbitRadius * Math.pow(b.mu / b.parent.mu, 0.4);
    } else {
      b.omega = 0;
      b.soi = Infinity; // root body dominates everything outside child SOIs
    }
  }

  return new SG.SolarSystem(bodies);
};

// --- Persistence (localStorage) ---------------------------------------------
SG.SystemStore = {
  KEY: "stageio.system.v1",

  save(defs) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(defs));
      return true;
    } catch (e) {
      console.warn("[SG.SystemStore] save failed:", e);
      return false;
    }
  },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return null;
      const defs = JSON.parse(raw);
      return Array.isArray(defs) && defs.length ? defs : null;
    } catch (e) {
      console.warn("[SG.SystemStore] load failed:", e);
      return null;
    }
  },

  clear() {
    try { localStorage.removeItem(this.KEY); } catch (e) {}
  },
};
