// SG.Ship — the flyable spacecraft. Its flight characteristics now come from a
// built SG.Assembly (parts): acceleration = thrust / mass, and mass drops as
// fuel burns. The ship's physics point (x,y) is the craft's centre of mass.
window.SG = window.SG || {};

SG.Ship = class Ship {
  constructor(cfg, assembly) {
    this.cfg = cfg;                 // SG.Config
    this.assembly = assembly || new SG.Assembly(SG.Ships.default());
    // Physics state (world units / SI).
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.angle = 0;                 // heading in radians; 0 = pointing +x
    this.angVel = 0;                // angular velocity (rad/s) — torque model
    // Controls.
    this.throttle = 0;
    this.engineOn = false;
    this.thrusting = false;
    this.alive = true;
    // Aero state.
    this.heat = 0;                  // 0..1 (1 = thermal limit → burn-up)
    this.chuteDeployed = false;
    this.burnedUp = false;
    this._flame = 0;

    // Per-vessel simulation state (the game owns a LIST of vessels — the
    // command craft plus any jettisoned stages still tumbling through the
    // world). These used to live on the game as singletons.
    this.landed = false;            // resting on the dominant body's surface
    this.dominant = null;           // SOI body currently governing this vessel
    this.aero = null;               // last SG.Aero.step() result (drag/heat/HUD)
    this.crashTimer = 0;            // seconds since death (for cleanup / relaunch)
    this.isCraft = true;            // the player's command craft (vs debris)
    this.debris = false;            // a jettisoned stage flying on its own
  }

  // Install a fresh runtime copy of a design (full tanks) for a new flight.
  setAssembly(assembly) { this.assembly = assembly; }

  // --- Derived / delegated stats ---
  mass() { return this.assembly.mass(); }
  height() { return this.assembly.height(); }
  bottomOffset() { return this.assembly.bottomOffset(); }
  // Fuel fraction of the ACTIVE stage (what the engines can actually drink).
  fuelFraction() {
    const cap = this.assembly.activeFuelCapacity();
    return cap > 0 ? this.assembly.activeFuel() / cap : 0;
  }

  isThrusting() {
    return this.engineOn && this.throttle > 0 && this.assembly.hasFuel()
      && this.assembly.thrust() > 0 && this.alive;
  }
  toggleEngine() { if (this.alive) this.engineOn = !this.engineOn; }
  setThrottle(v) { this.throttle = Math.max(0, Math.min(1, v)); }

  // Reset onto the launch pad, bottom of the craft on the body surface, nose up.
  resetToPad(body) {
    const padAngle = -Math.PI / 2;
    const dist = body.radius + this.assembly.bottomOffset();
    this.x = body.x + Math.cos(padAngle) * dist;
    this.y = body.y + Math.sin(padAngle) * dist;
    this.vx = body.vx || 0;
    this.vy = body.vy || 0;
    this.angle = padAngle;
    this.angVel = 0;
    this.assembly.fillFuel();
    this.throttle = 0;
    this.engineOn = false;
    this.thrusting = false;
    this.alive = true;
    this.heat = 0;
    this.chuteDeployed = false;
    this.burnedUp = false;
    this.landed = false;
    this.aero = null;
    this.crashTimer = 0;
    this.dominant = body;
  }

  // Deploy parachutes (P). Only opens if fitted, not already out, and slow
  // enough that the canopy survives. Returns "ok" | "none" | "fast".
  deployChute(relSpeed) {
    if (this.chuteDeployed || !this.alive) return "none";
    if (this.assembly.chutes().length === 0) return "none";
    if (relSpeed > this.cfg.chuteMaxOpenSpeed) return "fast";
    this.chuteDeployed = true;
    return "ok";
  }

  // Jettison the lowest stage. Returns removed parts (for a visual poof).
  stage() {
    const removed = this.assembly.jettisonStage();
    if (removed && !this.assembly.hasPod()) this.alive = this.alive; // (still flyable as debris-less)
    return removed;
  }

  // Angular acceleration available: heavier craft turn slower, fins help.
  turnAuthority() {
    const mass = this.assembly.mass() || 1;
    const massFactor = Math.max(0.3, Math.min(2, Math.pow(8000 / mass, 0.3)));
    return this.cfg.turnAccel * massFactor * this.assembly.finAuthority();
  }

  // Apply rotation (torque model) + throttle-scaled thrust. Returns accel
  // {ax,ay} for gravity integration. Acceleration = thrust·throttle / mass.
  control(input, dt) {
    const auth = this.turnAuthority();
    const steering = input.isDown("left") || input.isDown("right");
    if (input.isDown("left")) this.angVel -= auth * dt;
    if (input.isDown("right")) this.angVel += auth * dt;
    if (!steering) this.angVel *= Math.exp(-3 * dt);        // SAS-style damping
    this.angVel = Math.max(-this.cfg.maxAngVel, Math.min(this.cfg.maxAngVel, this.angVel));
    this.angle += this.angVel * dt;

    if (input.isDown("throttleUp")) this.setThrottle(this.throttle + this.cfg.throttleRate * dt);
    if (input.isDown("throttleDown")) this.setThrottle(this.throttle - this.cfg.throttleRate * dt);

    this.thrusting = false;
    if (this.isThrusting()) {
      this.thrusting = true;
      const mass = this.assembly.mass();
      const a = mass > 0 ? (this.assembly.thrust() * this.throttle) / mass : 0;
      this.assembly.drainFuel(this.assembly.massFlow() * this.throttle * dt);
      return { ax: Math.cos(this.angle) * a, ay: Math.sin(this.angle) * a };
    }
    return { ax: 0, ay: 0 };
  }

  // --- Rendering: draw the assembled craft around its centre of mass ---
  // `minPx` (optional) enforces a minimum on-screen height — used in MAP view so
  // the craft stays a visible marker. In CRAFT view it's omitted, so the craft
  // is drawn at true world scale: large when zoomed in, small when zoomed out.
  draw(ctx, camera, dt, minPx) {
    const s = camera.worldToScreen(this.x, this.y);
    const com = this.assembly.com();
    const h = Math.max(this.assembly.height(), 1);
    const scale = minPx ? Math.max(camera.zoom, minPx / h) : camera.zoom;

    this._flame += dt * 30;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(this.angle + Math.PI / 2); // local +y (down) -> along -heading

    // Reentry glow: envelope brightens with accumulated heat.
    if (this.heat > 0.12) {
      const hgt = this.assembly.height() * scale;
      const glowR = Math.max(hgt * 0.9, 14);
      const k = Math.min(1, this.heat);
      const g = ctx.createRadialGradient(0, 0, glowR * 0.2, 0, 0, glowR);
      g.addColorStop(0, `rgba(255,${Math.round(190 - 120 * k)},60,${0.35 * k})`);
      g.addColorStop(1, "rgba(255,90,20,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, glowR, 0, Math.PI * 2); ctx.fill();
    }

    // Open parachute canopy above the craft (local -y = nose direction).
    if (this.chuteDeployed) {
      const top = (this.assembly.bounds().minY - com.y) * scale;
      const r = Math.max(10, 7 * scale);          // ~7 m canopy radius
      const cy = top - r * 1.6;
      ctx.strokeStyle = "rgba(210,140,90,0.9)";
      ctx.lineWidth = Math.max(1, scale * 0.12);
      ctx.beginPath();                              // shroud lines
      ctx.moveTo(-r * 0.9, cy + r * 0.28); ctx.lineTo(0, top);
      ctx.moveTo(r * 0.9, cy + r * 0.28); ctx.lineTo(0, top);
      ctx.moveTo(0, cy); ctx.lineTo(0, top);
      ctx.stroke();
      ctx.beginPath();                              // canopy
      ctx.arc(0, cy + r * 0.3, r, Math.PI, 0);
      ctx.quadraticCurveTo(r * 0.5, cy + r * 0.55, 0, cy + r * 0.3);
      ctx.quadraticCurveTo(-r * 0.5, cy + r * 0.55, -r, cy + r * 0.3);
      ctx.fillStyle = "rgba(201,106,63,0.9)";
      ctx.fill();
    }

    for (const p of this.assembly.parts) {
      const t = this.assembly.type(p);
      // Part position relative to COM, in screen pixels.
      const px = (p.x - com.x) * scale;
      const py = (p.y - com.y) * scale;
      SG.PartRender.draw(ctx, t, px, py, scale, {
        sx: p.sx, sy: p.sy,
        dead: !this.alive,
        flame: t.category === "engine" && this.thrusting
          ? { throttle: this.throttle, phase: this._flame }
          : null,
      });
    }

    ctx.restore();
  }

  // (Per-part drawing lives in SG.PartRender — js/parts.js — shared with the builder.)
};
