// SG.Effects — lightweight particle system + camera shake (craft view only).
// Particles live in WORLD space so they trail properly behind a moving ship.
// Everything is procedural; no assets. Spawning is skipped above 4x warp.
window.SG = window.SG || {};

SG.Effects = {
  particles: [],
  MAX: 600,
  _shake: 0,

  // --- Spawning ---------------------------------------------------------------
  _push(p) {
    if (this.particles.length >= this.MAX) this.particles.shift();
    this.particles.push(p);
  },

  // Engine exhaust: spawn from the craft's tail, kicked opposite the heading.
  emitExhaust(ship, dt) {
    const n = Math.max(1, Math.round(10 * ship.throttle * (dt * 60)));
    const back = ship.angle + Math.PI;                    // opposite heading
    const tail = ship.assembly.bottomOffset();
    const tx = ship.x + Math.cos(back) * tail;
    const ty = ship.y + Math.sin(back) * tail;
    for (let i = 0; i < n; i++) {
      const spread = (Math.random() - 0.5) * 0.5;
      const speed = 25 + Math.random() * 30;
      this._push({
        x: tx, y: ty,
        vx: ship.vx + Math.cos(back + spread) * speed,
        vy: ship.vy + Math.sin(back + spread) * speed,
        life: 0.5 + Math.random() * 0.4, age: 0,
        size: 1.2 + Math.random() * 1.8,
        kind: "exhaust",
      });
    }
  },

  // Reentry plasma streaks: shed behind the craft, opposite its air-velocity.
  emitPlasma(ship, body, qNorm, dt) {
    const rvx = ship.vx - body.vx, rvy = ship.vy - body.vy;
    const v = Math.hypot(rvx, rvy) || 1;
    const n = Math.min(6, Math.round(qNorm * 600 * (dt * 60)));
    for (let i = 0; i < n; i++) {
      const off = (Math.random() - 0.5) * ship.assembly.maxWidth() * 2;
      this._push({
        x: ship.x - (rvy / v) * off, y: ship.y + (rvx / v) * off,
        vx: ship.vx - rvx * (0.2 + Math.random() * 0.2),
        vy: ship.vy - rvy * (0.2 + Math.random() * 0.2),
        life: 0.3 + Math.random() * 0.3, age: 0,
        size: 1.5 + Math.random() * 2.5,
        kind: "plasma",
      });
    }
    this._shake = Math.max(this._shake, Math.min(6, qNorm * 250));
  },

  explosion(x, y, sizeM) {
    const s = Math.max(sizeM || 10, 6);
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random()) * s * 3;
      this._push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.8 + Math.random() * 0.9, age: 0,
        size: 2 + Math.random() * 4,
        kind: "fire",
      });
    }
    this._shake = Math.max(this._shake, 9);
  },

  // Separation puff at the craft's tail when a stage is dropped.
  stagePuff(ship) {
    const back = ship.angle + Math.PI;
    const tail = ship.assembly.bottomOffset() + 2;
    const tx = ship.x + Math.cos(back) * tail;
    const ty = ship.y + Math.sin(back) * tail;
    for (let i = 0; i < 14; i++) {
      const a = back + (Math.random() - 0.5) * 1.6;
      const sp = 6 + Math.random() * 14;
      this._push({
        x: tx, y: ty,
        vx: ship.vx + Math.cos(a) * sp, vy: ship.vy + Math.sin(a) * sp,
        life: 0.6 + Math.random() * 0.5, age: 0,
        size: 1.5 + Math.random() * 2,
        kind: "smoke",
      });
    }
  },

  // --- Simulation / rendering ---------------------------------------------------
  update(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) { ps.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 1.2 * dt;                          // gentle slow-down
      p.vy *= 1 - 1.2 * dt;
    }
    this._shake = Math.max(0, this._shake - 14 * dt); // shake decays fast
  },

  clear() { this.particles.length = 0; this._shake = 0; },

  shakeOffset() {
    if (this._shake <= 0.05) return { x: 0, y: 0 };
    return {
      x: (Math.random() - 0.5) * this._shake,
      y: (Math.random() - 0.5) * this._shake,
    };
  },

  draw(ctx, camera) {
    for (const p of this.particles) {
      const s = camera.worldToScreen(p.x, p.y);
      if (s.x < -20 || s.y < -20 || s.x > camera.viewportW + 20 || s.y > camera.viewportH + 20) continue;
      const t = 1 - p.age / p.life;                  // 1 → 0 over lifetime
      let color;
      if (p.kind === "exhaust") color = `rgba(255,${Math.round(150 + 90 * t)},70,${0.55 * t})`;
      else if (p.kind === "plasma") color = `rgba(255,${Math.round(120 + 100 * t)},40,${0.7 * t})`;
      else if (p.kind === "fire") color = `rgba(255,${Math.round(90 + 140 * t)},30,${0.8 * t})`;
      else color = `rgba(200,205,215,${0.4 * t})`;   // smoke
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.8, p.size * (0.6 + 0.6 * t)), 0, Math.PI * 2);
      ctx.fill();
    }
  },
};
