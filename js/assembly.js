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
    this.parts = (placed || []).map((p) => ({ id: p.id, x: p.x, y: p.y, fuel: p.fuel }));
    this.fillFuel();
  }

  static fromDefs(defs) { return new SG.Assembly(defs); }
  toDefs() { return this.parts.map((p) => ({ id: p.id, x: p.x, y: p.y })); }

  type(p) { return SG.Parts.get(p.id); }

  fillFuel() {
    for (const p of this.parts) {
      const t = this.type(p);
      p.fuel = t && t.fuel ? t.fuel : 0;
    }
  }

  // --- Composition queries ---
  isEmpty() { return this.parts.length === 0; }
  hasPod() { return this.parts.some((p) => this.type(p).category === "pod"); }
  engines() { return this.parts.filter((p) => this.type(p).category === "engine"); }
  tanks() { return this.parts.filter((p) => this.type(p).category === "tank"); }

  // --- Mass ---
  dryMass() { return this.parts.reduce((m, p) => m + this.type(p).dryMass, 0); }
  fuelMass() { return this.parts.reduce((m, p) => m + (p.fuel || 0), 0); }
  fuelCapacity() { return this.parts.reduce((m, p) => m + (this.type(p).fuel || 0), 0); }
  mass() { return this.dryMass() + this.fuelMass(); }

  // --- Propulsion (all engines fire while any fuel remains) ---
  hasFuel() { return this.fuelMass() > 1e-6; }
  thrust() {
    if (!this.hasFuel()) return 0;
    return this.engines().reduce((t, p) => t + this.type(p).thrust, 0);
  }
  // Mass flow (kg/s) at full throttle across all firing engines.
  massFlow() {
    if (!this.hasFuel()) return 0;
    return this.engines().reduce((f, p) => f + this.type(p).thrust / this.type(p).ve, 0);
  }

  // TWR against a reference surface gravity (m/s^2).
  twr(g) {
    const m = this.mass();
    return m > 0 ? this.thrust() / (m * g) : 0;
  }

  // Burn `kg` of propellant this step, drained bottom-up (lowest tanks first),
  // so the lowest stage empties first — the cue to stage it away.
  drainFuel(kg) {
    let need = kg;
    const order = this.tanks().sort((a, b) => b.y - a.y); // largest y (bottom) first
    for (const p of order) {
      if (need <= 0) break;
      const take = Math.min(p.fuel, need);
      p.fuel -= take;
      need -= take;
    }
  }

  // --- Geometry ---
  bounds() {
    if (this.isEmpty()) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of this.parts) {
      const t = this.type(p);
      minX = Math.min(minX, p.x - t.w / 2); maxX = Math.max(maxX, p.x + t.w / 2);
      minY = Math.min(minY, p.y - t.h / 2); maxY = Math.max(maxY, p.y + t.h / 2);
    }
    return { minX, maxX, minY, maxY };
  }
  height() { const b = this.bounds(); return b.maxY - b.minY; }

  // Centre of mass in build-space (uses current fuel).
  com() {
    let m = 0, cx = 0, cy = 0;
    for (const p of this.parts) {
      const pm = this.type(p).dryMass + (p.fuel || 0);
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

  // Total delta-v (m/s), summing each stage's Tsiolkovsky contribution.
  deltaV() {
    const groups = this.stageGroups();
    let massAbove = this.mass();
    let dv = 0;
    for (const g of groups) {
      const grpDry = g.reduce((m, p) => m + this.type(p).dryMass, 0);
      const grpFuel = g.reduce((m, p) => m + (this.type(p).fuel || 0), 0);
      const engs = g.filter((p) => this.type(p).category === "engine");
      const thr = engs.reduce((t, p) => t + this.type(p).thrust, 0);
      const flow = engs.reduce((f, p) => f + this.type(p).thrust / this.type(p).ve, 0);
      const ve = flow > 0 ? thr / flow : 0;
      const m0 = massAbove, m1 = massAbove - grpFuel;
      if (ve > 0 && grpFuel > 0 && m1 > 0) dv += ve * Math.log(m0 / m1);
      massAbove -= grpDry + grpFuel;                // jettison the whole group
    }
    return dv;
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
    const a = new SG.Assembly(this.parts.map((p) => ({ id: p.id, x: p.x, y: p.y })));
    // preserve live fuel
    for (let i = 0; i < a.parts.length; i++) a.parts[i].fuel = this.parts[i].fuel;
    return a;
  }
};

// --- Node / snapping helpers (build-space) ----------------------------------
SG.AssemblyBuild = {
  // World-space nodes of a placed part.
  worldNodes(placed) {
    const t = SG.Parts.get(placed.id);
    return SG.Parts.nodes(t).map((n) => ({ x: placed.x + n.x, y: placed.y + n.y, kind: n.kind }));
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

  // Build a vertical stack from a list of part ids, top-to-bottom, centred on x=0.
  // Returns placed-part defs [{id,x,y}] with nodes flush.
  stack(ids) {
    const placed = [];
    let y = 0;
    let prevBottom = null;
    for (const id of ids) {
      const t = SG.Parts.get(id);
      if (!t) continue;
      const cy = prevBottom === null ? 0 : prevBottom + t.h / 2;
      placed.push({ id, x: 0, y: cy });
      prevBottom = cy + t.h / 2;
    }
    return placed;
  },

  // Given existing parts and a held part type, find the best snap position for
  // the held part near (cursorX, cursorY). Returns {x,y} or null if no snap.
  // `eps` is the snap tolerance in build metres. `exclude` = part being moved.
  snap(parts, heldType, cursorX, cursorY, eps, exclude) {
    const heldNodes = SG.Parts.nodes(heldType); // local, complementary matching below
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
