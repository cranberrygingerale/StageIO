// SG.Assembly — a built spacecraft: a set of placed parts plus all derived
// flight characteristics (mass, thrust, TWR, staged delta-v, centre of mass)
// and runtime state (per-tank fuel, staging).
//
// A placed part is { id, x, y, fuel } where (x,y) is the part centre in
// build-space metres (y increases DOWNWARD, matching the ship's local frame:
// the nose is up = negative y, engines are down = positive y).
window.SG = window.SG || {};

SG.Assembly = class Assembly {
  constructor(placed) {
    // Deep-ish copy so runtime fuel edits don't mutate a saved design.
    this.parts = (placed || []).map((p) => ({
      id: p.id, x: p.x, y: p.y, sx: p.sx || 1, sy: p.sy || 1, fuel: p.fuel,
    }));
    this.fillFuel();
  }

  static fromDefs(defs) { return new SG.Assembly(defs); }
  toDefs() { return this.parts.map((p) => ({ id: p.id, x: p.x, y: p.y, sx: p.sx, sy: p.sy })); }

  type(p) { return SG.Parts.get(p.id); }
  // Effective (parametrically scaled) stats for a placed part.
  eff(p) { return SG.Parts.effective(this.type(p), p); }

  fillFuel() {
    for (const p of this.parts) p.fuel = this.eff(p).fuel;
  }

  // --- Composition queries ---
  isEmpty() { return this.parts.length === 0; }
  hasPod() { return this.parts.some((p) => this.type(p).category === "pod"); }
  engines() { return this.parts.filter((p) => this.type(p).category === "engine"); }
  tanks() { return this.parts.filter((p) => this.type(p).category === "tank"); }
  chutes() { return this.parts.filter((p) => this.type(p).category === "chute"); }
  hasShield() { return this.parts.some((p) => this.type(p).category === "shield"); }
  finCount() { return this.parts.filter((p) => this.type(p).category === "fin").length; }

  // --- Aerodynamics ---
  maxWidth() {
    return this.parts.reduce((w, p) => Math.max(w, this.eff(p).w), 0);
  }
  // Effective drag area (Cd·A, m²). Cross-section from the widest part; a
  // nose cone on top streamlines the stack. Open parachutes dominate.
  dragArea(chutesOpen) {
    const r = this.maxWidth() / 2;
    const topPart = this.parts.reduce((a, b) => (a && a.y <= b.y ? a : b), null);
    const cd = topPart && ["nose", "chute"].includes(this.type(topPart).category) ? 0.6 : 1.1;
    let area = Math.PI * r * r * cd;
    if (chutesOpen) {
      area += this.chutes().reduce(
        (s, p) => s + (this.type(p).chuteArea || 0) * (p.sx || 1) * (p.sx || 1) * 1.5, 0
      );
    }
    return area;
  }
  // Turn-authority multiplier from fins (control surfaces / gimbal upgrade).
  finAuthority() {
    return Math.min(2, 1 + 0.35 * this.finCount());
  }

  // --- Mass ---
  dryMass() { return this.parts.reduce((m, p) => m + this.eff(p).dryMass, 0); }
  fuelMass() { return this.parts.reduce((m, p) => m + (p.fuel || 0), 0); }
  fuelCapacity() { return this.parts.reduce((m, p) => m + this.eff(p).fuel, 0); }
  mass() { return this.dryMass() + this.fuelMass(); }

  // --- Propulsion (STAGE-SCOPED: only the active — lowest — stage fires) ---
  // Fuel lives per stage: the active stage's engines drink only its own tanks.
  // When the active stage runs dry, thrust drops to zero — stage (G) to shed
  // it and light the next stage's engines.
  activeGroup() {
    const groups = this.stageGroups();
    return groups.length ? groups[0] : [];
  }
  activeEngines() {
    return this.activeGroup().filter((p) => this.type(p).category === "engine");
  }
  activeFuel() {
    return this.activeGroup().reduce((m, p) => m + (p.fuel || 0), 0);
  }
  activeFuelCapacity() {
    return this.activeGroup().reduce((m, p) => m + this.eff(p).fuel, 0);
  }
  hasFuel() { return this.activeFuel() > 1e-6; }

  thrust() {
    if (!this.hasFuel()) return 0;
    return this.activeEngines().reduce((t, p) => t + this.eff(p).thrust, 0);
  }
  // Mass flow (kg/s) at full throttle across the active stage's engines.
  massFlow() {
    if (!this.hasFuel()) return 0;
    return this.activeEngines().reduce((f, p) => {
      const e = this.eff(p);
      return f + e.thrust / e.ve;
    }, 0);
  }

  // TWR against a reference surface gravity (m/s^2).
  twr(g) {
    const m = this.mass();
    return m > 0 ? this.thrust() / (m * g) : 0;
  }

  // Burn `kg` of propellant from the ACTIVE stage only, lowest tanks first.
  drainFuel(kg) {
    let need = kg;
    const order = this.activeGroup()
      .filter((p) => (p.fuel || 0) > 0)
      .sort((a, b) => b.y - a.y);               // largest y (bottom) first
    for (const p of order) {
      if (need <= 0) break;
      const take = Math.min(p.fuel, need);
      p.fuel -= take;
      need -= take;
    }
  }

  // Per-stage stats from the CURRENT fuel state, bottom-up (index 0 = active).
  // dv is the Tsiolkovsky delta-v remaining in that stage given the mass it
  // still has to push (itself + everything above it).
  stageStats() {
    const groups = this.stageGroups();
    let massAbove = this.mass();
    const stats = [];
    for (const g of groups) {
      const dry = g.reduce((m, p) => m + this.eff(p).dryMass, 0);
      const fuel = g.reduce((m, p) => m + (p.fuel || 0), 0);
      const capacity = g.reduce((m, p) => m + this.eff(p).fuel, 0);
      const engs = g.filter((p) => this.type(p).category === "engine");
      const thr = engs.reduce((t, p) => t + this.eff(p).thrust, 0);
      const flow = engs.reduce((f, p) => { const e = this.eff(p); return f + e.thrust / e.ve; }, 0);
      const ve = flow > 0 ? thr / flow : 0;
      const m1 = massAbove - fuel;
      const dv = ve > 0 && fuel > 0 && m1 > 0 ? ve * Math.log(massAbove / m1) : 0;
      stats.push({ parts: g, dry, fuel, capacity, thrust: thr, ve, dv });
      massAbove -= dry + fuel;
    }
    return stats;
  }

  // --- Geometry ---
  bounds() {
    if (this.isEmpty()) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of this.parts) {
      const e = this.eff(p);
      minX = Math.min(minX, p.x - e.w / 2); maxX = Math.max(maxX, p.x + e.w / 2);
      minY = Math.min(minY, p.y - e.h / 2); maxY = Math.max(maxY, p.y + e.h / 2);
    }
    return { minX, maxX, minY, maxY };
  }
  height() { const b = this.bounds(); return b.maxY - b.minY; }

  // Centre of mass in build-space (uses current fuel).
  com() {
    let m = 0, cx = 0, cy = 0;
    for (const p of this.parts) {
      const pm = this.eff(p).dryMass + (p.fuel || 0);
      m += pm; cx += pm * p.x; cy += pm * p.y;
    }
    return m > 0 ? { x: cx / m, y: cy / m } : { x: 0, y: 0 };
  }

  // Distance from the centre of mass down to the lowest point (for pad placement).
  bottomOffset() { return this.bounds().maxY - this.com().y; }

  // --- Staging ---
  // Split parts bottom-to-top into stage groups, cut at each decoupler. Returns
  // arrays of placed parts, index 0 = bottom (fires first).
  stageGroups() {
    const ordered = this.parts.slice().sort((a, b) => b.y - a.y); // bottom-up
    const groups = [];
    let cur = [];
    for (const p of ordered) {
      cur.push(p);
      if (this.type(p).category === "decoupler") { groups.push(cur); cur = []; }
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  // Total delta-v (m/s) remaining, summing each stage's contribution. Uses
  // current fuel, so in flight this is live "delta-v left".
  deltaV() {
    return this.stageStats().reduce((s, st) => s + st.dv, 0);
  }

  stageCount() { return this.stageGroups().length; }

  // Jettison the lowest stage group (everything up to & including the lowest
  // decoupler). Returns the removed parts (for a visual poof), or null if the
  // last stage. Preserves remaining tanks' current fuel.
  jettisonStage() {
    const groups = this.stageGroups();
    if (groups.length <= 1) return null;
    const drop = new Set(groups[0]);
    const removed = this.parts.filter((p) => drop.has(p));
    this.parts = this.parts.filter((p) => !drop.has(p));
    return removed;
  }

  clone() {
    const a = new SG.Assembly(this.toDefs());
    // preserve live fuel
    for (let i = 0; i < a.parts.length; i++) a.parts[i].fuel = this.parts[i].fuel;
    return a;
  }
};

// --- Node / snapping helpers (build-space) ----------------------------------
SG.AssemblyBuild = {
  // World-space nodes of a placed part (respects its parametric scale).
  worldNodes(placed) {
    const t = SG.Parts.get(placed.id);
    return SG.Parts.nodes(t, placed.sx, placed.sy)
      .map((n) => ({ x: placed.x + n.x, y: placed.y + n.y, kind: n.kind }));
  },

  // Is a node position already occupied by ANOTHER part's node? `excludes` is a
  // part or array of parts to ignore (always ignore the node's own owner).
  nodeOccupied(parts, excludes, x, y, eps) {
    const skip = Array.isArray(excludes) ? excludes : [excludes];
    for (const p of parts) {
      if (skip.includes(p)) continue;
      for (const n of this.worldNodes(p)) {
        if (Math.hypot(n.x - x, n.y - y) < eps) return true;
      }
    }
    return false;
  },

  // Build a vertical stack top-to-bottom, centred on x=0, nodes flush.
  // Entries are part ids or {id, sx, sy} for parametric sizing.
  stack(entries) {
    const placed = [];
    let prevBottom = null;
    for (const e of entries) {
      const def = typeof e === "string" ? { id: e } : e;
      const t = SG.Parts.get(def.id);
      if (!t) continue;
      const h = t.h * (def.sy || 1);
      const cy = prevBottom === null ? 0 : prevBottom + h / 2;
      placed.push({ id: def.id, x: 0, y: cy, sx: def.sx || 1, sy: def.sy || 1 });
      prevBottom = cy + h / 2;
    }
    return placed;
  },

  // Given existing parts and a held part type, find the best snap position for
  // the held part near (cursorX, cursorY). Returns {x,y} or null if no snap.
  // `eps` is the snap tolerance in build metres. `exclude` = part being moved.
  // `heldScale` = {sx, sy} of the held/dragged part (defaults to 1).
  snap(parts, heldType, cursorX, cursorY, eps, exclude, heldScale) {
    const hs = heldScale || {};
    const heldNodes = SG.Parts.nodes(heldType, hs.sx, hs.sy); // complementary matching below
    let best = null, bestD = Infinity;
    for (const p of parts) {
      if (p === exclude) continue;
      for (const en of this.worldNodes(p)) {
        // The node is taken only if some OTHER part (not p, not the moving part) sits on it.
        if (this.nodeOccupied(parts, [p, exclude], en.x, en.y, eps * 0.5)) continue;
        for (const hn of heldNodes) {
          // Complementary kinds connect (held bottom -> existing top, etc.).
          if (hn.kind === en.kind) continue;
          // Position held so its node hn lands on existing node en.
          const px = en.x - hn.x, py = en.y - hn.y;
          const d = Math.hypot(px - cursorX, py - cursorY);
          if (d < bestD && d < eps) { bestD = d; best = { x: px, y: py }; }
        }
      }
    }
    return best;
  },
};

// --- Stock ship + persistence -----------------------------------------------
SG.Ships = {
  // A flyable two-stage rocket, top-to-bottom.
  default() {
    return SG.AssemblyBuild.stack([
      "nose", "pod", "tankS", "engineS",     // upper stage
      "decoupler",
      "tankL", "tankL", "engineL",           // lower (booster) stage
    ]);
  },
};

SG.ShipStore = {
  KEY: "stageio.ship.v1",
  save(defs) {
    try { localStorage.setItem(this.KEY, JSON.stringify(defs)); return true; }
    catch (e) { console.warn("[SG.ShipStore] save failed:", e); return false; }
  },
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return null;
      const defs = JSON.parse(raw);
      return Array.isArray(defs) && defs.length ? defs : null;
    } catch (e) { console.warn("[SG.ShipStore] load failed:", e); return null; }
  },
  clear() { try { localStorage.removeItem(this.KEY); } catch (e) {} },
};
