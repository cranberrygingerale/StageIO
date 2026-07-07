// SG.Aero — atmosphere, drag, and reentry heating.
//
// Density: exponential profile ρ(h) = rho0 · exp(-h/H), zero above the
// atmosphere top. Scale height H = top/12 (Earth: 140 km top → H ≈ 11.7 km,
// close to the real 8.5 km and it keeps user-authored atmospheres sane).
//
// Drag: F = ½·ρ·v²·Cd·A against velocity RELATIVE to the body, using the
// assembly's cross-section (+ a huge extra area when parachutes are open).
//
// Heating uses a SCALE-FREE flux so difficulty (world scale) doesn't change
// the feel: qNorm = (ρ/rho0_earth) · (v / vOrbitSurface)³. Reentering at
// orbital speed looks identical on a 1/10-scale world and the real one.
window.SG = window.SG || {};

SG.Aero = {
  // Tunables (heat is normalized, so these hold at every difficulty scale).
  // The reentry heat pulse is short (drag sheds speed fast in the dense
  // arcade atmosphere), so the rate must win that race unshielded.
  HEAT_RATE: 300,         // heat gained per second at qNorm = 1
  COOL_RATE: 0.25,        // fraction of heat radiated away per second
  SHIELD_FACTOR: 0.06,    // heating multiplier when a heat shield is fitted
  PLASMA_THRESHOLD: 0.004, // qNorm above which reentry plasma shows
  REF_RHO: 1.225,          // reference density for qNorm (Earth sea level)

  scaleHeight(body) { return body.atmosphere > 0 ? body.atmosphere / 12 : 0; },

  // Atmospheric density at a given altitude above `body` (kg/m^3).
  density(body, altitude) {
    if (!body.atmosphere || !body.rho0 || altitude >= body.atmosphere || altitude < 0) {
      return altitude < 0 ? body.rho0 || 0 : 0;
    }
    return body.rho0 * Math.exp(-altitude / this.scaleHeight(body));
  },

  inAtmosphere(body, altitude) {
    return body.atmosphere > 0 && body.rho0 > 0 && altitude < body.atmosphere;
  },

  // Drag acceleration + heating for one physics step. Mutates ship.heat and
  // returns { ax, ay, rho, q, qNorm, vRel } for the integrator/HUD/effects.
  // Burn-up (heat exceeding capacity) is signalled via the return, decided
  // by the caller (game) so it can run the crash flow.
  step(ship, body, dt) {
    const out = { ax: 0, ay: 0, rho: 0, q: 0, qNorm: 0, vRel: 0, burning: false };
    const asm = ship.assembly;

    const dx = ship.x - body.x, dy = ship.y - body.y;
    const alt = Math.hypot(dx, dy) - body.radius;
    const rho = this.density(body, alt);

    // Velocity relative to the (non-rotating) body.
    const rvx = ship.vx - body.vx, rvy = ship.vy - body.vy;
    const v = Math.hypot(rvx, rvy);
    out.vRel = v;
    out.rho = rho;

    if (rho <= 0) {
      // Vacuum: just radiate residual heat away.
      ship.heat = Math.max(0, (ship.heat || 0) - this.COOL_RATE * (ship.heat || 0) * dt);
      return out;
    }

    // --- Drag ---
    if (v > 1e-3) {
      const area = asm.dragArea(ship.chuteDeployed);
      const mass = asm.mass();
      const f = 0.5 * rho * v * v * area;          // Cd folded into dragArea
      const a = mass > 0 ? f / mass : 0;
      out.ax = -a * (rvx / v);
      out.ay = -a * (rvy / v);
      out.q = 0.5 * rho * v * v;                   // dynamic pressure (Pa)
    }

    // --- Heating (scale-free) ---
    const vOrb = Math.sqrt(body.mu / body.radius); // surface orbital speed
    const qNorm = (rho / this.REF_RHO) * Math.pow(v / vOrb, 3);
    out.qNorm = qNorm;

    const shielded = asm.hasShield();
    const rate = this.HEAT_RATE * qNorm * (shielded ? this.SHIELD_FACTOR : 1);
    ship.heat = Math.max(0, (ship.heat || 0) + (rate - this.COOL_RATE * (ship.heat || 0)) * dt);
    if (ship.heat >= 1) out.burning = true;        // exceeded thermal limit

    return out;
  },
};
