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
    // Controls.
    this.throttle = 0;
    this.engineOn = false;
    this.thrusting = false;
    this.alive = true;
    this._flame = 0;
  }

  // Install a fresh runtime copy of a design (full tanks) for a new flight.
  setAssembly(assembly) { this.assembly = assembly; }

  // --- Derived / delegated stats ---
  mass() { return this.assembly.mass(); }
  height() { return this.assembly.height(); }
  bottomOffset() { return this.assembly.bottomOffset(); }
  fuelFraction() {
    const cap = this.assembly.fuelCapacity();
    return cap > 0 ? this.assembly.fuelMass() / cap : 0;
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
    this.assembly.fillFuel();
    this.throttle = 0;
    this.engineOn = false;
    this.thrusting = false;
    this.alive = true;
  }

  // Jettison the lowest stage. Returns removed parts (for a visual poof).
  stage() {
    const removed = this.assembly.jettisonStage();
    if (removed && !this.assembly.hasPod()) this.alive = this.alive; // (still flyable as debris-less)
    return removed;
  }

  // Apply rotation + throttle-scaled thrust. Returns accel {ax,ay} for gravity
  // integration. Acceleration = (thrust * throttle) / current mass.
  control(input, dt) {
    if (input.isDown("left")) this.angle -= this.cfg.turnRate * dt;
    if (input.isDown("right")) this.angle += this.cfg.turnRate * dt;
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
