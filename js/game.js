// SG.Game — bootstraps everything, runs the warp-aware fixed-substep loop over a
// multi-body solar system (patched-conic / SOI gravity), draws the predicted
// trajectory, and updates the HUD.
window.SG = window.SG || {};

// --- Tunable constants -------------------------------------------------------
// The world is now in real SI units (metres, m/s, m^3/s^2). See systems.js.
SG.Config = {
  // Ship (placeholder). Sizes in metres; thrust/gravity in m/s^2.
  shipLength: 60,
  shipWidth: 24,
  minShipPx: 18,            // never draw the ship smaller than this on screen
  maxFuel: 100,
  fuelBurn: 0.12,           // fuel/sec while thrusting (~830s total burn)
  thrustAccel: 60,          // m/s^2 at full throttle (TWR ~6 at Earth's surface)
  turnRate: 1.8,            // rad/sec
  throttleRate: 0.6,        // throttle change per second (Shift up / Ctrl down)

  // Landing / crashing (measured RELATIVE to the dominant body)
  landingSpeed: 15,         // m/s

  // Simulation
  fixedDt: 1 / 120,         // target physics substep (s)
  maxSubSteps: 180,         // cap on numeric substeps per frame
  // Discrete time-warp multipliers. Levels up to physicsWarpMax use numeric
  // integration (thrust allowed); higher levels use analytic on-rails Kepler
  // propagation so interplanetary transfers finish in seconds.
  warpLevels: [1, 2, 5, 10, 50, 100, 1000, 10000, 100000, 1000000],
  physicsWarpMax: 100,      // the largest numerically-integrated warp
  railsSubsteps: 8,         // analytic substeps per frame during rails warp

  // Camera (huge zoom range: from a ship on the ground to Neptune's orbit)
  minZoom: 2.0e-11,
  maxZoom: 120,
  zoomKeyRate: 1.9,
};

SG.Game = class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = SG.Config;

    // Build the system: saved/edited defs (normalized back to raw scale) or
    // stock, then scaled by the chosen difficulty (world size).
    this.worldScale = (SG.Difficulty && SG.Difficulty.load() || { scale: 0.1 }).scale;
    this.world = new SG.World(SG.buildSystem(SG.scaleSystem(this._rawDefs(), this.worldScale)));
    this.uiMode = "flight";

    const shipDefs = SG.ShipStore.load() || SG.Ships.default();
    this.ship = new SG.Ship(this.cfg, new SG.Assembly(shipDefs));
    this.buildMode = false;        // set by the ship builder while assembling
    this.camera = new SG.Camera();
    this.camera.minZoom = this.cfg.minZoom;
    this.camera.maxZoom = this.cfg.maxZoom;

    // Index of the largest numerically-integrated warp level (rest are rails).
    this.physicsMaxIndex = this.cfg.warpLevels.reduce(
      (best, w, i) => (w <= this.cfg.physicsWarpMax ? i : best), 0
    );

    this.simTime = 0;
    this.warpIndex = 0;
    this.paused = false;           // set by the system builder while editing
    this.lastTime = 0;
    this.crashTimer = 0;
    this.landed = false;
    this.dominant = this.world.system.homeBody();

    // View state: "craft" (fly the ship) vs "map" (orbits & system). Each mode
    // keeps its own zoom so toggling feels natural.
    this.viewMode = "craft";
    this.craftZoom = 1;
    this.mapZoom = null;           // lazily framed on first map entry
    this.mapTarget = null;         // body the map view is focused on

    this._hud = {
      body: document.getElementById("hud-body"),
      altitude: document.getElementById("hud-altitude"),
      speed: document.getElementById("hud-speed"),
      vspeed: document.getElementById("hud-vspeed"),
      hspeed: document.getElementById("hud-hspeed"),
      apoapsis: document.getElementById("hud-apoapsis"),
      periapsis: document.getElementById("hud-periapsis"),
      fuel: document.getElementById("hud-fuel"),
      mass: document.getElementById("hud-mass"),
      stages: document.getElementById("hud-stages"),
      warp: document.getElementById("hud-warp"),
      throttle: document.getElementById("hud-throttle"),
      throttleBar: document.getElementById("hud-throttle-bar"),
      engine: document.getElementById("hud-engine"),
      mode: document.getElementById("hud-mode"),
      status: document.getElementById("hud-status"),
    };

    this._resize();
    window.addEventListener("resize", () => this._resize());

    // Click a body in map view to focus the camera on it.
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.viewMode !== "map" || this.buildMode || e.button !== 0) return;
      const r = this.canvas.getBoundingClientRect();
      const b = this._bodyAtScreen(e.clientX - r.left, e.clientY - r.top);
      if (b) { this.mapTarget = b; this.frameMap(); }
    });

    SG.game = this; // let the system builder reach the running game
    this.reset();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.setViewport(window.innerWidth, window.innerHeight);
  }

  // Saved (or stock) system defs, normalized back to raw (unscaled) values.
  _rawDefs() {
    const saved = SG.SystemStore.load();
    if (!saved) return SG.Systems.default;
    return SG.scaleSystem(saved, 1 / SG.SystemStore.loadScale());
  }

  // Rebuild the world at a new difficulty (world scale). Keeps any custom
  // system the player built, just rescaled.
  applyDifficulty(preset) {
    this.worldScale = preset.scale;
    this.rebuildSystem(SG.scaleSystem(this._rawDefs(), preset.scale));
  }

  // "menu" | "build" | "flight" — the flight HUD/legend only show in flight.
  setUiMode(mode) {
    this.uiMode = mode;
    if (typeof document !== "undefined" && document.body && document.body.classList)
      document.body.classList.toggle("no-flight-ui", mode !== "flight");
  }

  // Install a freshly-built ship design and put it on the pad (from the builder).
  launchShip(defs) {
    this.ship.setAssembly(new SG.Assembly(defs));
    this.buildMode = false;
    this.paused = false;
    this.reset();
  }

  // Rebuild the world from new body definitions (called by the builder).
  rebuildSystem(defs) {
    this.world = new SG.World(SG.buildSystem(defs));
    this.simTime = 0;
    this.warpIndex = 0;
    this.reset();
  }

  reset() {
    this.world.update(this.simTime);
    const home = this.world.system.homeBody();
    this.ship.resetToPad(home);
    this.dominant = home;
    this.camera.snapTo(this.ship.x, this.ship.y);
    // Craft view is ship-relative: default zoom frames the CRAFT (not the whole
    // planet) so you can see it well; wheel-zoom in/out from there.
    const view = Math.min(this.camera.viewportW, this.camera.viewportH) || 720;
    const shipH = Math.max(this.ship.height(), 1);
    this.craftZoom = Math.max(
      this.cfg.minZoom, Math.min(this.cfg.maxZoom, (view * 0.28) / shipH)
    );
    this.viewMode = "craft";
    this.camera.zoom = this.craftZoom;
    this.warpIndex = 0;
    this.crashTimer = 0;
    this.landed = false;
  }

  // Switch between craft view and map view, remembering each mode's zoom.
  toggleView() {
    if (this.viewMode === "craft") {
      this.craftZoom = this.camera.zoom;
      this.viewMode = "map";
      this.mapTarget = this.dominant;   // focus starts on the ship's SOI body
      this.frameMap();
    } else {
      this.mapZoom = this.camera.zoom;
      this.viewMode = "craft";
      this.camera.zoom = this.craftZoom;
      this.camera.snapTo(this.ship.x, this.ship.y);
    }
  }

  // Cycle the map focus target through the system's bodies.
  cycleFocus(dir) {
    const bodies = this.world.system.bodies;
    if (!bodies.length) return;
    let i = bodies.indexOf(this.mapTarget);
    if (i < 0) i = 0;
    this.mapTarget = bodies[(i + dir + bodies.length) % bodies.length];
    this.frameMap();
  }

  // Frame the current map target. When it's the ship's own body, fit the ship's
  // orbit; otherwise fit the body's sphere of influence (so its moons show too).
  frameMap() {
    const t = this.mapTarget || this.dominant;
    let R;
    if (t === this.dominant) {
      const el = SG.Kepler.elements(
        this.ship.x - t.x, this.ship.y - t.y,
        this.ship.vx - t.vx, this.ship.vy - t.vy, t.mu
      );
      if (el.bound) R = el.a * (1 + el.e);
      else R = Math.min(isFinite(t.soi) ? t.soi : Infinity, Math.hypot(this.ship.x - t.x, this.ship.y - t.y) * 2);
    } else {
      R = isFinite(t.soi) ? t.soi : t.radius * 8;
    }
    R = Math.max(R, t.radius * 3);
    const view = Math.min(this.camera.viewportW, this.camera.viewportH) || 720;
    this.mapZoom = Math.max(this.cfg.minZoom, Math.min(this.cfg.maxZoom, (view * 0.42) / R));
    this.camera.zoom = this.mapZoom;
    this.camera.snapTo(t.x, t.y);
  }

  // Nearest body to a screen point (for click-to-focus). Uses distance to the
  // body's edge so both a big disc and a tiny far marker are clickable.
  _bodyAtScreen(sx, sy) {
    let best = null, bestEdge = 40;    // px tolerance beyond the disc
    for (const b of this.world.system.bodies) {
      const p = this.camera.worldToScreen(b.x, b.y);
      const rPx = Math.max(b.radius * this.camera.zoom, 3);
      const edge = Math.hypot(p.x - sx, p.y - sy) - rPx;  // <=0 means inside
      if (edge < bestEdge) { bestEdge = edge; best = b; }
    }
    return best;
  }

  // Frame the whole system in view (used by the builder / F key).
  frameSystem() {
    const bodies = this.world.system.bodies;
    let maxR = 1000;
    for (const b of bodies) {
      const d = Math.hypot(b.x, b.y) + b.radius;
      if (d > maxR) maxR = d;
    }
    this.camera.snapTo(0, 0);
    this.camera.zoom = Math.max(
      this.cfg.minZoom,
      Math.min(this.cfg.maxZoom, (Math.min(this.camera.viewportW, this.camera.viewportH) * 0.45) / maxR)
    );
  }

  start() {
    const loop = (t) => { this._frame(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _frame(t) {
    if (!this.lastTime) this.lastTime = t;
    let frameTime = (t - this.lastTime) / 1000;
    this.lastTime = t;
    if (frameTime > 0.25) frameTime = 0.25; // clamp after tab-out

    this._handleDiscreteInput();

    // In the ship builder, the build scene owns the canvas; skip flight sim.
    if (this.buildMode) {
      if (SG.shipBuilder) SG.shipBuilder.render(this.ctx);
      return;
    }

    // Continuous camera controls.
    const wheel = SG.Input.consumeWheel();
    if (wheel) this.camera.zoomBy(Math.pow(1.0015, -wheel));
    if (SG.Input.isDown("zoomIn")) this.camera.zoomBy(Math.pow(this.cfg.zoomKeyRate, frameTime));
    if (SG.Input.isDown("zoomOut")) this.camera.zoomBy(Math.pow(this.cfg.zoomKeyRate, -frameTime));

    // A running engine forces warp back to 1x (can't warp under acceleration).
    if (this.ship.isThrusting()) this.warpIndex = 0;

    // --- Advance the simulation (numeric physics warp OR analytic rails warp) ---
    if (!this.paused) this._advanceWorld(frameTime);

    // Camera: craft view tracks the ship; map view stays on its focus target.
    // We SNAP (not ease) to the ship: it can be moving at tens of km/s in the
    // heliocentric frame, so an eased camera would lag thousands of metres —
    // invisible at planet zoom, but way off-screen at close ship zoom.
    if (this.viewMode === "map") {
      const t = this.mapTarget || this.dominant;
      this.camera.snapTo(t.x, t.y);
    } else if (!this.paused) {
      this.camera.snapTo(this.ship.x, this.ship.y);
    }

    this._render(frameTime);
    this._updateHud();
  }

  _handleDiscreteInput() {
    for (const action of SG.Input.consumePressed()) {
      // While building, only builder toggle / close are honoured.
      if (this.buildMode && !(action === "toggleShipBuilder" || action === "closeBuilder")) continue;
      switch (action) {
        case "toggleShipBuilder": if (SG.shipBuilder) SG.shipBuilder.toggle(); break;
        case "engineToggle": this.ship.toggleEngine(); break;
        case "throttleMax": this.ship.setThrottle(1); break;
        case "throttleZero": this.ship.setThrottle(0); break;
        case "stage": this.ship.stage(); break;
        case "toggleMap": this.toggleView(); break;
        case "focusNext": if (this.viewMode === "map") this.cycleFocus(1); break;
        case "focusPrev": if (this.viewMode === "map") this.cycleFocus(-1); break;
        case "reset": this.reset(); break;
        case "frameSystem":
          if (this.viewMode === "map") this.frameMap();
          else this.frameSystem();
          break;
        case "warpUp":
          // Don't allow warping up while the engine is producing thrust.
          if (!this.ship.isThrusting())
            this.warpIndex = Math.min(this.cfg.warpLevels.length - 1, this.warpIndex + 1);
          break;
        case "warpDown":
          this.warpIndex = Math.max(0, this.warpIndex - 1);
          break;
        case "toggleBuilder": if (SG.builder) SG.builder.toggle(); break;
        case "closeBuilder":
          // Esc walks up the chain: ship builder → system builder → menu ⇄ flight.
          if (SG.shipBuilder && SG.shipBuilder.isOpen()) SG.shipBuilder.close();
          else if (SG.builder && SG.builder.isOpen()) SG.builder.close();
          else if (SG.menu && SG.menu.isOpen()) {
            SG.menu.hide(); this.paused = false; this.setUiMode("flight");
          } else if (SG.menu) SG.menu.show();
          break;
      }
    }
  }

  // Decide numeric vs rails advancement for this frame and run it.
  _advanceWorld(frameTime) {
    const ship = this.ship;

    // Rails warp is only valid on a bound (or landed) trajectory. If the ship
    // is on an escape/hyperbolic path, drop back to the fastest physics warp.
    if (this.warpIndex > this.physicsMaxIndex && ship.alive && !this.landed) {
      const dom = this.world.system.dominantBody(ship.x, ship.y);
      const rx = ship.x - dom.x, ry = ship.y - dom.y;
      const rvx = ship.vx - dom.vx, rvy = ship.vy - dom.vy;
      const r = Math.hypot(rx, ry) || 1;
      const energy = (rvx * rvx + rvy * rvy) / 2 - dom.mu / r;
      if (energy >= 0) this.warpIndex = this.physicsMaxIndex; // unbound -> no rails
    }

    const warp = this.cfg.warpLevels[this.warpIndex];
    const target = frameTime * warp;
    if (this.warpIndex <= this.physicsMaxIndex) this._numericAdvance(target);
    else this._railsAdvance(target);
  }

  // Numeric integration over `target` sim-seconds using bounded fixed substeps.
  _numericAdvance(target) {
    let substeps = Math.round(target / this.cfg.fixedDt);
    substeps = Math.max(1, Math.min(this.cfg.maxSubSteps, substeps));
    const dt = target / substeps;
    for (let i = 0; i < substeps; i++) {
      this.simTime += dt;
      this.world.update(this.simTime);
      this._step(dt);
    }
  }

  // Analytic on-rails advancement: the ship follows a Kepler orbit around its
  // dominant body, so we can jump arbitrarily far in time with no drift.
  _railsAdvance(target) {
    const n = this.cfg.railsSubsteps;
    const dt = target / n;
    for (let i = 0; i < n; i++) this._railsSub(dt);
  }

  _railsSub(dt) {
    const ship = this.ship;
    if (!ship.alive) {                       // safety: shouldn't normally happen
      this.simTime += dt;
      this.world.update(this.simTime);
      this.crashTimer += dt;
      if (this.crashTimer > 1.3) this.reset();
      return;
    }

    const dom = this.world.system.dominantBody(ship.x, ship.y);

    if (this.landed) {
      // Stay pinned to the same spot on the (non-rotating) body as it moves.
      const relx = ship.x - dom.x, rely = ship.y - dom.y;
      this.simTime += dt;
      this.world.update(this.simTime);
      ship.x = dom.x + relx; ship.y = dom.y + rely;
      ship.vx = dom.vx; ship.vy = dom.vy;
      this.dominant = dom;
      return;
    }

    // Elements relative to the dominant body, propagated analytically.
    const el = SG.Kepler.elements(
      ship.x - dom.x, ship.y - dom.y, ship.vx - dom.vx, ship.vy - dom.vy, dom.mu
    );
    if (!el.bound) { this._numericAdvance(dt); return; }   // guarded upstream, but safe
    const ns = SG.Kepler.propagate(el, dom.mu, dt);

    this.simTime += dt;
    this.world.update(this.simTime);          // dom moves to its new position
    ship.x = dom.x + ns.x; ship.y = dom.y + ns.y;
    ship.vx = dom.vx + ns.vx; ship.vy = dom.vy + ns.vy;

    // Surface impact while warping (e.g. a warped suborbital arc).
    const ddx = ship.x - dom.x, ddy = ship.y - dom.y;
    const dd = Math.hypot(ddx, ddy);
    const surf = dom.radius + this.ship.bottomOffset();
    if (dd < surf) {
      const rvx = ship.vx - dom.vx, rvy = ship.vy - dom.vy;
      if (Math.hypot(rvx, rvy) < this.cfg.landingSpeed) {
        const nx = ddx / dd, ny = ddy / dd;
        ship.x = dom.x + nx * surf; ship.y = dom.y + ny * surf;
        ship.vx = dom.vx; ship.vy = dom.vy;
        this.landed = true;
      } else {
        ship.alive = false; this.crashTimer = 0; this.warpIndex = 0;
      }
    }
    // Re-resolve the governing body (handles SOI transitions for the HUD).
    this.dominant = this.world.system.dominantBody(ship.x, ship.y);
  }

  _step(dt) {
    const ship = this.ship;

    if (!ship.alive) {
      this.crashTimer += dt;
      if (this.crashTimer > 1.3) this.reset();
      return;
    }

    // Gravity comes from whichever body's SOI the ship is inside.
    const dom = this.world.system.dominantBody(ship.x, ship.y);
    this.dominant = dom;

    const thrust = ship.control(SG.Input, dt);
    SG.Physics.integrate(ship, dom, dt, thrust);

    // --- Surface interaction with the dominant body ---
    const dx = ship.x - dom.x, dy = ship.y - dom.y;
    const dist = Math.hypot(dx, dy);
    const surface = dom.radius + this.ship.bottomOffset();
    if (dist < surface) {
      // Velocity relative to the (possibly moving) body.
      const rvx = ship.vx - dom.vx, rvy = ship.vy - dom.vy;
      const relSpeed = Math.hypot(rvx, rvy);
      if (relSpeed < this.cfg.landingSpeed) {
        const nx = dx / dist, ny = dy / dist;
        ship.x = dom.x + nx * surface;
        ship.y = dom.y + ny * surface;
        ship.vx = dom.vx;                 // rest relative to the body
        ship.vy = dom.vy;
        this.landed = true;
      } else {
        ship.alive = false;
        this.crashTimer = 0;
      }
    } else {
      this.landed = false;
    }
  }

  _render(dt) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.camera.viewportW, this.camera.viewportH);
    this.world.drawStars(ctx, this.camera);
    const highlight = SG.builder && SG.builder.isOpen() ? SG.builder.selectedName() : null;
    if (this.viewMode === "map") this._renderMap(ctx, dt, highlight);
    else this._renderCraft(ctx, dt, highlight);
  }

  _renderCraft(ctx, dt, highlight) {
    this.world.drawOrbits(ctx, this.camera);
    this.world.drawBodies(ctx, this.camera, { highlight, detail: true });
    this._drawTrajectory(ctx, false);
    this._drawVelocityVector(ctx);
    this.ship.draw(ctx, this.camera, dt);      // true world scale (zoom-relative)
  }

  _renderMap(ctx, dt, highlight) {
    const focus = this.mapTarget || this.dominant;
    this.world.drawOrbits(ctx, this.camera);
    this.world.drawSOI(ctx, this.camera, focus);
    if (focus !== this.dominant) this.world.drawSOI(ctx, this.camera, this.dominant);
    this.world.drawBodies(ctx, this.camera, { highlight: focus.name, map: true });
    this._drawTrajectory(ctx, true);          // includes Ap/Pe markers
    this.ship.draw(ctx, this.camera, dt, this.cfg.minShipPx);  // fixed-size marker
    this._drawFocusLabel(ctx, focus);
  }

  _drawFocusLabel(ctx, focus) {
    ctx.save();
    ctx.font = "13px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "#cfe0ff";
    ctx.fillText(`◎ Focus: ${focus.name}`, this.camera.viewportW / 2, 26);
    ctx.fillStyle = "#6f8fb5";
    ctx.font = "11px Consolas, monospace";
    ctx.fillText("[ / ] cycle · click a body · M exit map", this.camera.viewportW / 2, 43);
    ctx.restore();
  }

  // Prograde (velocity) marker in craft view — points along motion relative to
  // the dominant body, the direction you're actually travelling.
  _drawVelocityVector(ctx) {
    const dom = this.dominant;
    const rvx = this.ship.vx - dom.vx, rvy = this.ship.vy - dom.vy;
    const sp = Math.hypot(rvx, rvy);
    if (sp < 1e-3) return;
    const s = this.camera.worldToScreen(this.ship.x, this.ship.y);
    const len = 58, ux = rvx / sp, uy = rvy / sp;
    const ex = s.x + ux * len, ey = s.y + uy * len;
    ctx.save();
    ctx.strokeStyle = "rgba(120,235,165,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.stroke();       // prograde circle
    ctx.beginPath();
    ctx.moveTo(ex - 8, ey); ctx.lineTo(ex - 5, ey);
    ctx.moveTo(ex + 5, ey); ctx.lineTo(ex + 8, ey);
    ctx.moveTo(ex, ey - 8); ctx.lineTo(ex, ey - 5);
    ctx.stroke();
    ctx.restore();
  }

  // Predicted orbit in the dominant body's reference frame (patched conic).
  // For bound orbits this is the EXACT Kepler ellipse (no integration drift, at
  // any scale); for unbound orbits we numerically sketch the near-term arc.
  _drawTrajectory(ctx, map) {
    const dom = this.dominant;
    const rx = this.ship.x - dom.x, ry = this.ship.y - dom.y;
    const rvx = this.ship.vx - dom.vx, rvy = this.ship.vy - dom.vy;
    const el = SG.Kepler.elements(rx, ry, rvx, rvy, dom.mu);

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);

    if (el.bound) {
      const periR = el.a * (1 - el.e);
      ctx.strokeStyle = periR > dom.radius ? "rgba(93,255,155,0.55)" : "rgba(255,180,84,0.55)";
      const pts = SG.Kepler.sampleEllipse(el, dom.mu, 180);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = this.camera.worldToScreen(dom.x + pts[i].x, dom.y + pts[i].y);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      // Apoapsis / periapsis markers in map view.
      if (map) {
        const pe = SG.Kepler.stateAtNu(el, dom.mu, 0);
        const ap = SG.Kepler.stateAtNu(el, dom.mu, Math.PI);
        this._drawApsis(ctx, dom.x + pe.x, dom.y + pe.y, "Pe", "#5dff9b", el.a * (1 - el.e) - dom.radius);
        this._drawApsis(ctx, dom.x + ap.x, dom.y + ap.y, "Ap", "#7fb4ff", el.a * (1 + el.e) - dom.radius);
      }
    } else {
      // Escape arc: short numeric sketch.
      const s = { x: rx, y: ry, vx: rvx, vy: rvy };
      const planet0 = { x: 0, y: 0, mu: dom.mu, radius: dom.radius };
      const horizon = Math.max(30, (dom.soi * 2) / Math.max(1, Math.hypot(rvx, rvy)));
      const dt = horizon / 400;
      ctx.strokeStyle = "rgba(255,180,84,0.5)";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < 400; i++) {
        SG.Physics.integrate(s, planet0, dt, null);
        const d = Math.hypot(s.x, s.y);
        if (d < dom.radius || d > dom.soi * 1.3) break;
        const p = this.camera.worldToScreen(dom.x + s.x, dom.y + s.y);
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // A small labelled marker (used for apoapsis/periapsis in map view).
  _drawApsis(ctx, wx, wy, label, color, altitude) {
    const p = this.camera.worldToScreen(wx, wy);
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.font = "11px Consolas, monospace";
    ctx.textAlign = "left";
    const km = isFinite(altitude) ? " " + Math.round(altitude / 1000).toLocaleString() + " km" : "";
    ctx.fillText(label + km, p.x + 7, p.y - 5);
    ctx.restore();
  }

  _updateHud() {
    const dom = this.dominant;
    const rel = {
      x: this.ship.x, y: this.ship.y,
      vx: this.ship.vx, vy: this.ship.vy,
    };
    const domObj = { x: dom.x, y: dom.y, mu: dom.mu, radius: dom.radius };
    const info = SG.Physics.orbit(rel, domObj, { vx: dom.vx, vy: dom.vy });
    const h = this._hud;

    // Radial (vertical) vs tangential (horizontal) velocity relative to body.
    const dx = this.ship.x - dom.x, dy = this.ship.y - dom.y;
    const r = Math.hypot(dx, dy) || 1;
    const nx = dx / r, ny = dy / r;
    const rvx = this.ship.vx - dom.vx, rvy = this.ship.vy - dom.vy;
    const vRad = rvx * nx + rvy * ny;
    const vTan = rvx * -ny + rvy * nx;

    const fmt = (v) => (isFinite(v) ? Math.round(v).toLocaleString() : "∞");

    if (h.body) h.body.textContent = dom.name;
    h.altitude.textContent = fmt(info.altitude) + " m";
    h.speed.textContent = fmt(info.speed) + " m/s";
    h.vspeed.textContent = (vRad >= 0 ? "+" : "") + fmt(vRad) + " m/s";
    h.hspeed.textContent = fmt(Math.abs(vTan)) + " m/s";
    h.apoapsis.textContent = info.bound ? fmt(info.apoapsis) + " m" : "escape";
    h.periapsis.textContent = fmt(info.periapsis) + " m";
    const asm = this.ship.assembly;
    h.fuel.textContent = Math.round(this.ship.fuelFraction() * 100) + "% (" + (asm.fuelMass() / 1000).toFixed(1) + " t)";
    if (h.mass) h.mass.textContent = (asm.mass() / 1000).toFixed(1) + " t";
    if (h.stages) h.stages.textContent = asm.stageCount() + "";
    if (h.warp) h.warp.textContent = this.cfg.warpLevels[this.warpIndex] + "×";

    // Throttle + engine + view mode.
    const pct = Math.round(this.ship.throttle * 100);
    if (h.throttle) h.throttle.textContent = pct + "%";
    if (h.throttleBar) h.throttleBar.style.width = pct + "%";
    if (h.engine) {
      h.engine.textContent = this.ship.engineOn ? "ON" : "OFF";
      h.engine.className = this.ship.engineOn ? "on" : "off";
    }
    if (h.mode) h.mode.textContent = this.viewMode === "map" ? "MAP" : "CRAFT";

    let label = "SUBORBITAL", cls = "status";
    if (!this.ship.alive) { label = "CRASHED"; cls = "status crashed"; }
    else if (this.landed) label = "LANDED";
    else if (!info.bound) { label = "ESCAPE TRAJECTORY"; cls = "status stable"; }
    else if (info.periapsis > 0) { label = "STABLE ORBIT"; cls = "status stable"; }
    h.status.textContent = label;
    h.status.className = cls;
  }
};

// --- Boot --------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  SG.Physics.selfTest();
  SG.Input.init();
  const canvas = document.getElementById("game");
  const game = new SG.Game(canvas);
  game.start();
});
