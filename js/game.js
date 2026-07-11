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
  turnAccel: 1.1,           // rad/s^2 torque authority baseline (mass-scaled)
  maxAngVel: 1.4,           // rad/s rotation speed cap
  throttleRate: 0.6,        // throttle change per second (Shift up / Ctrl down)

  // Aero
  chuteMaxOpenSpeed: 350,   // m/s — canopy rips above this
  atmoWarpMax: 10,          // max time warp inside an atmosphere (drag needs small steps)

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
    // Multi-vessel world: `vessels` holds every flyable body — the player's
    // command craft (`primary`) plus jettisoned stages tumbling as debris.
    // `ship` is always `vessels[activeIndex]`, the one you're controlling.
    this.primary = this.ship;
    this.vessels = [this.ship];
    this.activeIndex = 0;
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

    // Maneuver node: a planned burn ({t, pro, rad}) and the cached prediction
    // (SG.Maneuver.compute) refreshed each frame. `_burnUnit` is the world-space
    // burn direction, used to steer + to spend the node while thrusting.
    this.node = null;
    this._nodeInfo = null;
    this._burnUnit = null;

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
      dv: document.getElementById("hud-dv"),
      heat: document.getElementById("hud-heat"),
      stageList: document.getElementById("hud-stage-list"),
      warp: document.getElementById("hud-warp"),
      throttle: document.getElementById("hud-throttle"),
      throttleBar: document.getElementById("hud-throttle-bar"),
      engine: document.getElementById("hud-engine"),
      mode: document.getElementById("hud-mode"),
      vessel: document.getElementById("hud-vessel"),
      status: document.getElementById("hud-status"),
      nodeInfo: document.getElementById("node-info"),
      nodeEta: document.getElementById("node-eta"),
      nodeDv: document.getElementById("node-dv"),
      nodeEnc: document.getElementById("node-enc"),
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

  // These four used to be game singletons; they now live on each vessel, so the
  // game just proxies the ACTIVE vessel's copy (keeps HUD/trajectory/tests
  // reading `game.dominant` etc. working unchanged).
  get dominant() { return this.ship ? this.ship.dominant : null; }
  set dominant(v) { if (this.ship) this.ship.dominant = v; }
  get landed() { return this.ship ? this.ship.landed : false; }
  set landed(v) { if (this.ship) this.ship.landed = v; }
  get aero() { return this.ship ? this.ship.aero : null; }
  set aero(v) { if (this.ship) this.ship.aero = v; }
  get crashTimer() { return this.ship ? this.ship.crashTimer : 0; }
  set crashTimer(v) { if (this.ship) this.ship.crashTimer = v; }

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
  // Always targets the primary craft — reset() rebuilds the vessel list from it.
  launchShip(defs) {
    this.primary.setAssembly(new SG.Assembly(defs));
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
    // Relaunch discards any debris: the world is just the primary craft again.
    const primary = this.primary || this.ship;
    primary.isCraft = true;
    primary.debris = false;
    primary.resetToPad(home);
    this.primary = primary;
    this.vessels = [primary];
    this.activeIndex = 0;
    this.ship = primary;
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
    this.aero = null;
    this._clearNode();
    if (SG.Effects) SG.Effects.clear();
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

  // --- Multiple vessels -------------------------------------------------------

  // Hand control to the next/previous LIVE vessel (command craft or debris).
  switchVessel(dir) {
    const n = this.vessels.length;
    if (n <= 1) return;
    let i = this.activeIndex;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (this.vessels[i].alive) break;
    }
    if (i === this.activeIndex) return;
    this.activeIndex = i;
    this.ship = this.vessels[i];
    this.warpIndex = 0;                     // new frame of reference; drop warp
    this.craftZoom = this.camera.zoom;      // keep the current zoom
    this.camera.snapTo(this.ship.x, this.ship.y);
    this._clearNode();                      // a node belongs to one vessel's orbit
  }

  // --- Maneuver node ----------------------------------------------------------

  // Create a node at the next periapsis (or clear the existing one). Needs a
  // closed orbit to plan from — no node from the pad or an escape trajectory.
  _toggleNode() {
    if (this.node) { this._clearNode(); return; }
    const s = this.ship;
    if (!s.alive || s.landed) return;
    const dom = this.dominant;
    const el = SG.Kepler.elements(s.x - dom.x, s.y - dom.y, s.vx - dom.vx, s.vy - dom.vy, dom.mu);
    if (!el.bound) return;
    this.node = SG.Maneuver.makeNode(this);
  }

  _clearNode() { this.node = null; this._nodeInfo = null; this._burnUnit = null; }

  // Held-key tuning of the planned burn (continuous, like throttle). Δv steps
  // start fine and grow with the burn size; the node slides in time relative to
  // the predicted orbit's period.
  _editNode(dt) {
    const n = this.node;
    if (!n) return;
    const dv = Math.hypot(n.pro, n.rad);
    const rate = (8 + 0.5 * dv);            // m/s per second held
    if (SG.Input.isDown("nodeProPlus")) n.pro += rate * dt;
    if (SG.Input.isDown("nodeProMinus")) n.pro -= rate * dt;
    if (SG.Input.isDown("nodeRadPlus")) n.rad += rate * dt;
    if (SG.Input.isDown("nodeRadMinus")) n.rad -= rate * dt;
    let per = 600;
    if (this._nodeInfo && this._nodeInfo.postEl && this._nodeInfo.postEl.n > 0)
      per = (Math.PI * 2) / this._nodeInfo.postEl.n;
    const trate = per / 12;                 // sweep the orbit in ~12s of holding
    if (SG.Input.isDown("nodeTimePlus")) n.t += trate * dt;
    if (SG.Input.isDown("nodeTimeMinus")) n.t = Math.max(this.simTime + 1, n.t - trate * dt);
  }

  // Spend the node as the active vessel thrusts along the planned direction:
  // shrink the Δv vector by the progress made, and delete it once (nearly) done.
  _consumeNode(dvx, dvy) {
    const dir = this._burnUnit, n = this.node;
    if (!dir || !n) return;
    const total = Math.hypot(n.pro, n.rad);
    if (total < 1e-6) return;
    const along = dvx * dir.x + dvy * dir.y;  // component along the planned burn
    if (along <= 0) return;                    // pointing the wrong way — no credit
    const f = Math.max(0, total - along) / total;
    n.pro *= f; n.rad *= f;
    if (Math.hypot(n.pro, n.rad) < 2) this._clearNode();
  }

  // Turn a jettisoned stage (`removed` placed parts) into an independent debris
  // vessel that keeps flying — feeling gravity and drag — so you watch it drop
  // away behind you. `preCom` is the parent's centre of mass BEFORE the drop.
  _spawnDebris(ship, removed, preCom) {
    if (!removed || !removed.length) return;

    const asm = new SG.Assembly(
      removed.map((p) => ({ id: p.id, x: p.x, y: p.y, sx: p.sx, sy: p.sy }))
    );
    // The Assembly constructor tops tanks off; keep the fuel they actually had.
    for (let i = 0; i < asm.parts.length; i++) asm.parts[i].fuel = removed[i].fuel || 0;

    const d = new SG.Ship(this.cfg, asm);
    d.isCraft = false;
    d.debris = true;
    d.angle = ship.angle;
    d.angVel = ship.angVel + (Math.random() - 0.5) * 0.7;   // a little tumble
    d.heat = ship.heat;
    d.dominant = ship.dominant || this.world.system.dominantBody(ship.x, ship.y);
    d.alive = true;
    d.landed = false;

    // Place the debris COM at the world spot it occupied inside the stack. The
    // renderer maps a build-space delta (relative to COM) into the world by
    // rotating it by angle+π/2, so we invert that here.
    const dcom = asm.com();
    const bx = dcom.x - preCom.x, by = dcom.y - preCom.y;
    const th = ship.angle + Math.PI / 2;
    const cos = Math.cos(th), sin = Math.sin(th);
    d.x = ship.x + (bx * cos - by * sin);
    d.y = ship.y + (bx * sin + by * cos);

    // Decoupler springs kick the spent stage aft (down the stack) and give the
    // remaining craft a much gentler forward nudge.
    const sep = 4 + Math.random() * 3;
    const tail = ship.angle + Math.PI;
    d.vx = ship.vx + Math.cos(tail) * sep;
    d.vy = ship.vy + Math.sin(tail) * sep;
    ship.vx += Math.cos(ship.angle) * sep * 0.12;
    ship.vy += Math.sin(ship.angle) * sep * 0.12;

    this.vessels.push(d);

    // Cap the vessel count: drop the oldest debris (never the primary/active).
    const MAX = 14;
    while (this.vessels.length > MAX) {
      const idx = this.vessels.findIndex(
        (v, i) => v !== this.primary && i !== this.activeIndex
      );
      if (idx < 0) break;
      this.vessels.splice(idx, 1);
      if (idx < this.activeIndex) this.activeIndex--;
    }
    this.ship = this.vessels[this.activeIndex];
  }

  // Remove burnt-up / crashed debris once its explosion has played. The primary
  // craft is never culled here — its death runs the relaunch flow instead.
  _cullVessels() {
    const active = this.vessels[this.activeIndex];
    const kept = this.vessels.filter(
      (v) => v === this.primary || v.alive || v.crashTimer <= 1.2
    );
    if (kept.length === this.vessels.length) return;
    this.vessels = kept;
    let idx = kept.indexOf(active);
    if (idx < 0) {                          // the vessel we were flying is gone
      idx = kept.indexOf(this.primary);
      if (idx < 0) idx = 0;
      this.camera.snapTo(kept[idx].x, kept[idx].y);
    }
    this.activeIndex = idx;
    this.ship = kept[idx];
  }

  // Destroy a vessel (crash or burn-up): explosion + shake, sound only for the
  // one you're flying so a shed booster burning up doesn't blast your speakers.
  _killVessel(v, isActive, burned) {
    v.alive = false;
    v.burnedUp = burned;
    v.crashTimer = 0;
    if (isActive) this.warpIndex = 0;
    if (SG.Effects) SG.Effects.explosion(v.x, v.y, v.assembly.height());
    if (SG.Audio && isActive) SG.Audio.explosion();
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

    // Live tuning of the planned burn (held keys).
    if (!this.paused) this._editNode(frameTime);

    // A running engine forces warp back to 1x (can't warp under acceleration).
    if (this.ship.isThrusting()) this.warpIndex = 0;

    // --- Advance the simulation (numeric physics warp OR analytic rails warp) ---
    // (_stepVessel spends the node while thrusting, using last frame's burn dir.)
    if (!this.paused) {
      this._advanceWorld(frameTime);
      this._cullVessels();                       // sweep up spent debris
    }

    // Refresh the maneuver prediction for drawing/HUD and next-frame execution.
    this._nodeInfo = this.node ? SG.Maneuver.compute(this) : null;
    this._burnUnit = this._nodeInfo && this._nodeInfo.burnUnit ? this._nodeInfo.burnUnit : null;

    // Particle effects + sound (real-time; skip spawning at high warp).
    if (SG.Effects) {
      const warp = this.cfg.warpLevels[this.warpIndex];
      if (!this.paused && warp <= 4) {
        if (this.ship.alive && this.ship.thrusting) SG.Effects.emitExhaust(this.ship, frameTime);
        // Reentry plasma for EVERY vessel — a shed booster streaking in looks great.
        for (const v of this.vessels) {
          if (v.alive && v.aero && v.aero.qNorm > SG.Aero.PLASMA_THRESHOLD)
            SG.Effects.emitPlasma(v, v.dominant, v.aero.qNorm, frameTime);
        }
      }
      SG.Effects.update(frameTime);
    }
    if (SG.Audio) SG.Audio.update(this.ship, this.aero);

    // The player's command craft dying triggers the relaunch flow (debris dying
    // is just cleaned up by _cullVessels above).
    if (!this.primary.alive && this.primary.crashTimer > 1.3) { this.reset(); return; }

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
        case "stage": {
          // COM of the whole stack BEFORE the drop, so the debris lines up with
          // where the lower stage was on screen a moment ago.
          const preCom = this.ship.assembly.com();
          const removed = this.ship.stage();
          if (removed) {
            this._spawnDebris(this.ship, removed, preCom);
            if (SG.Audio) SG.Audio.thunk();
            if (SG.Effects) SG.Effects.stagePuff(this.ship);
          }
          break;
        }
        case "chute": {
          const dom = this.dominant;
          const relSpeed = Math.hypot(this.ship.vx - dom.vx, this.ship.vy - dom.vy);
          const res = this.ship.deployChute(relSpeed);
          if (res === "ok" && SG.Audio) SG.Audio.chutePop();
          break;
        }
        case "toggleMap": this.toggleView(); break;
        // In map view [ ] cycle the focused body; in craft view they switch
        // which vessel you're flying (command craft ⇄ jettisoned debris).
        case "focusNext": if (this.viewMode === "map") this.cycleFocus(1); else this.switchVessel(1); break;
        case "focusPrev": if (this.viewMode === "map") this.cycleFocus(-1); else this.switchVessel(-1); break;
        case "nodeToggle": this._toggleNode(); break;
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

  // Largest warp index allowed inside an atmosphere (drag needs small steps
  // and rails propagation ignores drag entirely).
  _atmoWarpIndex() {
    let idx = 0;
    for (let i = 0; i < this.cfg.warpLevels.length; i++)
      if (this.cfg.warpLevels[i] <= this.cfg.atmoWarpMax) idx = i;
    return idx;
  }

  // Decide numeric vs rails advancement for this frame and run it.
  _advanceWorld(frameTime) {
    const ship = this.ship;

    // Inside an atmosphere, clamp warp hard (drag is integrated numerically).
    if (ship.alive && !this.landed) {
      const dom = this.world.system.dominantBody(ship.x, ship.y);
      const alt = Math.hypot(ship.x - dom.x, ship.y - dom.y) - dom.radius;
      if (SG.Aero.inAtmosphere(dom, alt))
        this.warpIndex = Math.min(this.warpIndex, this._atmoWarpIndex());
    }

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
    const vs = this.vessels;
    // Plan each live vessel's move against its CURRENT dominant body, before the
    // world advances (so the analytic step is relative to the old body position).
    const plans = [];
    for (const v of vs) {
      if (!v.alive) { v.crashTimer += dt; continue; }
      const dom = this.world.system.dominantBody(v.x, v.y);
      const relx = v.x - dom.x, rely = v.y - dom.y;
      if (v.landed) { plans.push({ v, dom, relx, rely, mode: "pin" }); continue; }
      const el = SG.Kepler.elements(relx, rely, v.vx - dom.vx, v.vy - dom.vy, dom.mu);
      if (el.bound) plans.push({ v, dom, ns: SG.Kepler.propagate(el, dom.mu, dt), mode: "orbit" });
      else plans.push({ v, dom, relx, rely, mode: "pin" }); // unbound debris: coast with body (rare)
    }

    this.simTime += dt;
    this.world.update(this.simTime);          // bodies move to their new positions

    for (const pl of plans) {
      const { v, dom } = pl;
      if (pl.mode === "pin") {
        // Landed / coasting: stay put relative to the (non-rotating) body.
        v.x = dom.x + pl.relx; v.y = dom.y + pl.rely;
        v.vx = dom.vx; v.vy = dom.vy;
        v.dominant = dom;
        continue;
      }
      v.x = dom.x + pl.ns.x; v.y = dom.y + pl.ns.y;
      v.vx = dom.vx + pl.ns.vx; v.vy = dom.vy + pl.ns.vy;

      // Dipped into an atmosphere while on rails: drop to physics warp so drag
      // takes over next frame (rails ignores it).
      const altNow = Math.hypot(v.x - dom.x, v.y - dom.y) - dom.radius;
      if (SG.Aero.inAtmosphere(dom, altNow))
        this.warpIndex = Math.min(this.warpIndex, this._atmoWarpIndex());

      // Surface impact while warping (e.g. a warped suborbital arc).
      const ddx = v.x - dom.x, ddy = v.y - dom.y;
      const dd = Math.hypot(ddx, ddy);
      const surf = dom.radius + v.bottomOffset();
      if (dd < surf) {
        const rvx = v.vx - dom.vx, rvy = v.vy - dom.vy;
        if (Math.hypot(rvx, rvy) < this.cfg.landingSpeed) {
          const nx = ddx / dd, ny = ddy / dd;
          v.x = dom.x + nx * surf; v.y = dom.y + ny * surf;
          v.vx = dom.vx; v.vy = dom.vy;
          v.landed = true;
        } else {
          this._killVessel(v, v === this.ship, false);
        }
      }
      // Re-resolve the governing body (handles SOI transitions for the HUD).
      v.dominant = this.world.system.dominantBody(v.x, v.y);
    }
  }

  _step(dt) {
    const vs = this.vessels;
    for (let k = 0; k < vs.length; k++) this._stepVessel(vs[k], dt, k === this.activeIndex);
  }

  // Advance ONE vessel by dt under gravity + drag. `isActive` gets pilot input;
  // debris just coast (and tumble). Death is handled via _killVessel.
  _stepVessel(v, dt, isActive) {
    if (!v.alive) { v.crashTimer += dt; return; }

    // Gravity comes from whichever body's SOI the vessel is inside.
    const dom = this.world.system.dominantBody(v.x, v.y);
    v.dominant = dom;

    let thrust;
    if (isActive) {
      thrust = v.control(SG.Input, dt);
      // Executing a maneuver: spend the node by the Δv burnt along its direction.
      if (this.node && this._burnUnit && v.thrusting)
        this._consumeNode(thrust.ax * dt, thrust.ay * dt);
    } else {
      thrust = { ax: 0, ay: 0 };
      v.angle += v.angVel * dt;             // debris coasts its spin
      v.angVel *= Math.exp(-0.1 * dt);      // ...settling very slowly
    }

    // Atmospheric drag + reentry heating (adds to the accel for this step).
    const aero = SG.Aero.step(v, dom, dt);
    v.aero = aero;
    thrust.ax += aero.ax;
    thrust.ay += aero.ay;
    if (aero.burning) { this._killVessel(v, isActive, true); return; }

    SG.Physics.integrate(v, dom, dt, thrust);

    // --- Surface interaction with the dominant body ---
    const dx = v.x - dom.x, dy = v.y - dom.y;
    const dist = Math.hypot(dx, dy);
    const surface = dom.radius + v.bottomOffset();
    if (dist < surface) {
      // Velocity relative to the (possibly moving) body.
      const rvx = v.vx - dom.vx, rvy = v.vy - dom.vy;
      const relSpeed = Math.hypot(rvx, rvy);
      if (relSpeed < this.cfg.landingSpeed) {
        const nx = dx / dist, ny = dy / dist;
        v.x = dom.x + nx * surface;
        v.y = dom.y + ny * surface;
        v.vx = dom.vx;                      // rest relative to the body
        v.vy = dom.vy;
        v.landed = true;
      } else {
        this._killVessel(v, isActive, false);
      }
    } else {
      v.landed = false;
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
    // Camera shake (reentry / explosions) offsets the whole craft scene.
    const sh = SG.Effects ? SG.Effects.shakeOffset() : { x: 0, y: 0 };
    ctx.save();
    ctx.translate(sh.x, sh.y);
    this.world.drawOrbits(ctx, this.camera);
    this.world.drawBodies(ctx, this.camera, { highlight, detail: true });
    this._drawTrajectory(ctx, false);
    this._drawVelocityVector(ctx);
    if (SG.Effects) SG.Effects.draw(ctx, this.camera);
    // Debris first, the vessel you're flying on top (true world scale).
    for (const v of this.vessels) if (v !== this.ship) v.draw(ctx, this.camera, dt);
    this.ship.draw(ctx, this.camera, dt);
    this._drawActiveMarker(ctx, false);
    this._drawManeuver(ctx, false);
    ctx.restore();
  }

  _renderMap(ctx, dt, highlight) {
    const focus = this.mapTarget || this.dominant;
    this.world.drawOrbits(ctx, this.camera);
    this.world.drawSOI(ctx, this.camera, focus);
    if (focus !== this.dominant) this.world.drawSOI(ctx, this.camera, this.dominant);
    this.world.drawBodies(ctx, this.camera, { highlight: focus.name, map: true });
    this._drawTrajectory(ctx, true);          // includes Ap/Pe markers
    this._drawManeuver(ctx, true);            // predicted orbit + node + encounter
    for (const v of this.vessels) if (v !== this.ship) v.draw(ctx, this.camera, dt, this.cfg.minShipPx);
    this.ship.draw(ctx, this.camera, dt, this.cfg.minShipPx);  // fixed-size marker
    this._drawActiveMarker(ctx, true);
    this._drawFocusLabel(ctx, focus);
  }

  // The maneuver node: in MAP view the full predicted orbit + node handle +
  // encounter marker; in CRAFT view just a burn-direction cue to point at.
  _drawManeuver(ctx, map) {
    const info = this._nodeInfo;
    if (!info) return;
    const dom = info.dom;
    const anchor = this.camera.worldToScreen(dom.x, dom.y);  // dom = ellipse focus

    if (!map) {
      // Craft view: a magenta burn-direction pip beyond the prograde marker.
      if (!info.valid || info.dvRemaining < 0.1 || !this.ship.alive) return;
      const bu = info.burnUnit;
      const s = this.camera.worldToScreen(this.ship.x, this.ship.y);
      const len = 78, ex = s.x + bu.x * len, ey = s.y + bu.y * len;
      ctx.save();
      ctx.strokeStyle = "rgba(210,130,255,0.9)";
      ctx.fillStyle = "rgba(210,130,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return;
    }

    ctx.save();
    // Predicted orbit (magenta dashed), anchored on the dominant body.
    if (info.valid && info.postEl && info.postEl.bound) {
      const pts = SG.Kepler.sampleEllipse(info.postEl, dom.mu, 180);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(210,130,255,0.65)";
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = this.camera.worldToScreen(dom.x + pts[i].x, dom.y + pts[i].y);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // Node handle on the current orbit.
    if (info.nodeRel) {
      const np = this.camera.worldToScreen(dom.x + info.nodeRel.x, dom.y + info.nodeRel.y);
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(230,170,255,0.95)";
      ctx.fillStyle = "rgba(210,130,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(np.x, np.y, 6, 0, Math.PI * 2); ctx.stroke();
      const bu = info.burnUnit;
      ctx.beginPath();
      ctx.moveTo(np.x, np.y);
      ctx.lineTo(np.x + bu.x * 22, np.y + bu.y * 22);
      ctx.stroke();
    }

    // Encounter: mark where the predicted orbit meets the moon's SOI, and ghost
    // the moon at that future moment so the intercept geometry is obvious.
    if (info.encounter) {
      const enc = info.encounter;
      const gp = this.camera.worldToScreen(dom.x + enc.bodyRel.x, dom.y + enc.bodyRel.y);
      const soiR = enc.body.soi * this.camera.zoom;
      ctx.setLineDash([2, 6]);
      ctx.strokeStyle = "rgba(120,235,165,0.7)";
      ctx.lineWidth = 1;
      if (soiR > 3 && soiR < 40000) { ctx.beginPath(); ctx.arc(gp.x, gp.y, soiR, 0, Math.PI * 2); ctx.stroke(); }
      const ep = this.camera.worldToScreen(dom.x + enc.shipRel.x, dom.y + enc.shipRel.y);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(120,235,165,0.95)";
      ctx.strokeStyle = "rgba(120,235,165,0.95)";
      ctx.beginPath();                          // diamond
      ctx.moveTo(ep.x, ep.y - 6); ctx.lineTo(ep.x + 6, ep.y);
      ctx.lineTo(ep.x, ep.y + 6); ctx.lineTo(ep.x - 6, ep.y);
      ctx.closePath(); ctx.stroke();
      ctx.font = "11px Consolas, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${enc.body.name} intercept`, ep.x + 9, ep.y - 6);
    }
    ctx.restore();
  }

  // Corner brackets around the vessel you're currently flying (only meaningful
  // once there's more than one in the world).
  _drawActiveMarker(ctx, map) {
    if (this.vessels.length <= 1 || !this.ship.alive) return;
    const s = this.camera.worldToScreen(this.ship.x, this.ship.y);
    const h = Math.max(this.ship.height(), 1);
    const scale = map ? Math.max(this.camera.zoom, this.cfg.minShipPx / h) : this.camera.zoom;
    const r = Math.max(h * scale * 0.75, 16);
    const k = r * 0.35;
    ctx.save();
    ctx.strokeStyle = "rgba(120,235,165,0.9)";
    ctx.lineWidth = 1.5;
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [cx, cy] of corners) {
      const x = s.x + cx * r, y = s.y + cy * r;
      ctx.beginPath();
      ctx.moveTo(x - cx * k, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y - cy * k);
      ctx.stroke();
    }
    ctx.restore();
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
    h.fuel.textContent = Math.round(this.ship.fuelFraction() * 100) + "% (" + (asm.activeFuel() / 1000).toFixed(1) + " t)";
    if (h.mass) h.mass.textContent = (asm.mass() / 1000).toFixed(1) + " t";
    if (h.dv) h.dv.textContent = Math.round(asm.deltaV()).toLocaleString() + " m/s";
    if (h.heat) {
      const pct = Math.round(Math.min(1, this.ship.heat) * 100);
      h.heat.textContent = pct + "%" + (this.ship.chuteDeployed ? " · ☂" : "");
      h.heat.style.color = pct > 75 ? "#ff5d6c" : pct > 40 ? "#ffb454" : "";
    }
    this._updateStageList(asm);
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
    if (h.vessel) {
      const total = this.vessels.length;
      const kind = this.ship === this.primary ? "Command" : "Debris";
      h.vessel.textContent = total > 1 ? `${this.activeIndex + 1}/${total} · ${kind}` : "1/1";
    }
    this._updateNodeHud();

    let label = "SUBORBITAL", cls = "status";
    if (!this.ship.alive) {
      label = this.ship.burnedUp ? "BURNED UP" : "CRASHED";
      cls = "status crashed";
    }
    else if (this.landed) label = "LANDED";
    else if (this.aero && this.aero.qNorm > SG.Aero.PLASMA_THRESHOLD) {
      label = "REENTRY"; cls = "status crashed";
    }
    else if (this.ship.engineOn && this.ship.throttle > 0 && !asm.hasFuel()) {
      // Engines starving: tell the pilot what to do about it.
      label = asm.stageCount() > 1 ? "STAGE SPENT — PRESS G" : "OUT OF FUEL";
      cls = "status";
    }
    else if (!info.bound) { label = "ESCAPE TRAJECTORY"; cls = "status stable"; }
    else if (info.periapsis > 0) { label = "STABLE ORBIT"; cls = "status stable"; }
    h.status.textContent = label;
    h.status.className = cls;
  }

  // Maneuver-node HUD block: shown only while a node exists (time-to-node, Δv,
  // and whether the plotted orbit intercepts a moon).
  _updateNodeHud() {
    const h = this._hud;
    if (!h.nodeInfo) return;
    const info = this._nodeInfo;
    if (!info) { h.nodeInfo.style.display = "none"; return; }
    h.nodeInfo.style.display = "";
    if (h.nodeEta) h.nodeEta.textContent = this._fmtDuration(info.dt);
    if (h.nodeDv) h.nodeDv.textContent = Math.round(info.dvRemaining).toLocaleString() + " m/s";
    if (h.nodeEnc) {
      if (!info.valid) { h.nodeEnc.textContent = "need an orbit"; h.nodeEnc.style.color = "#ffb454"; }
      else if (info.encounter) {
        h.nodeEnc.textContent = info.encounter.body.name + " ✓";
        h.nodeEnc.style.color = "#78eba5";
      } else { h.nodeEnc.textContent = "none"; h.nodeEnc.style.color = ""; }
    }
  }

  // Seconds -> compact "1h 03m" / "4m 12s" / "38s".
  _fmtDuration(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
  }

  // Per-stage HUD rows: fuel bar + remaining delta-v, top stage first (KSP
  // order — the active stage is the bottom row, highlighted).
  _updateStageList(asm) {
    const el = this._hud.stageList;
    if (!el) return;
    const stats = asm.stageStats();
    let html = "";
    for (let i = stats.length - 1; i >= 0; i--) {
      const s = stats[i];
      const pct = s.capacity > 0 ? Math.max(0, Math.min(100, (s.fuel / s.capacity) * 100)) : 0;
      html +=
        `<div class="stage-row${i === 0 ? " active" : ""}">` +
        `<span class="sg-n">S${i + 1}</span>` +
        `<span class="sg-bar"><span class="sg-fill" style="width:${pct.toFixed(1)}%"></span></span>` +
        `<span class="sg-dv">${Math.round(s.dv).toLocaleString()} m/s</span>` +
        `</div>`;
    }
    // Only touch the DOM when something changed (idle coasting = no rebuilds).
    if (html !== this._stageHtml) { el.innerHTML = html; this._stageHtml = html; }
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
