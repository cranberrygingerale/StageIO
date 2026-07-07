// SG.ShipBuilder — the VAB / hangar: a build scene where you assemble a
// spacecraft from parts (like SFS / Juno / KSP). It renders on the main canvas
// while its DOM panels host the palette, live stats, and actions. Parts snap
// together at their attachment nodes. Launch converts the design into the
// flight ship on the pad.
window.SG = window.SG || {};

SG.ShipBuilder = class ShipBuilder {
  constructor(root, canvas) {
    this.root = root;
    this.canvas = canvas;
    this.open = false;

    // Working design: placed parts [{id,x,y}] in build metres.
    const saved = SG.ShipStore.load();
    this.defs = saved || SG.Ships.default();

    this.heldId = null;       // part type picked from the palette (ghost)
    this.selected = -1;       // index of a selected placed part
    this.dragIndex = -1;      // index of a part being dragged
    this.dragStart = null;    // original pos while dragging
    this.scale = 12;          // px per metre (auto-fit on open)
    this.cursor = { x: 0, y: 0 };   // cursor in build coords
    this.snapPos = null;      // current valid snap {x,y} for held/dragged part

    this._build();
    this._bindCanvas();
    this._refresh();
  }

  isOpen() { return this.open; }
  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    SG.game.buildMode = true;
    SG.game.paused = true;
    SG.game.setUiMode("build");        // flight HUD hidden while building
    // Start from whatever the flight ship currently is, so edits are continuous.
    this.defs = SG.game.ship.assembly.toDefs();
    this._autoFit();
    this.root.classList.add("visible");
    this._refresh();
  }

  close() {
    this.open = false;
    SG.game.buildMode = false;
    SG.game.paused = false;
    SG.game.setUiMode("flight");
    this.heldId = null;
    this.root.classList.remove("visible");
  }

  // --- View transforms (build metres <-> screen px) ---
  _midY() {
    if (!this.defs.length) return 0;
    const a = new SG.Assembly(this.defs);
    const b = a.bounds();
    return (b.minY + b.maxY) / 2;
  }
  _vw() { return SG.game.camera.viewportW; }
  _vh() { return SG.game.camera.viewportH; }
  toScreen(bx, by) {
    return { x: this._vw() / 2 + bx * this.scale, y: this._vh() / 2 + (by - this._midY()) * this.scale };
  }
  toBuild(sx, sy) {
    return { x: (sx - this._vw() / 2) / this.scale, y: (sy - this._vh() / 2) / this.scale + this._midY() };
  }

  _autoFit() {
    const a = new SG.Assembly(this.defs);
    const h = Math.max(a.height(), 6);
    const b = a.bounds();
    const w = Math.max(b.maxX - b.minX, 4);
    const sh = (this._vh() * 0.7) / h;
    const sw = (this._vw() * 0.42) / w;
    this.scale = Math.max(3, Math.min(60, Math.min(sh, sw)));
  }

  // --- Canvas interaction ---
  _bindCanvas() {
    const rel = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return this.toBuild(e.clientX - r.left, e.clientY - r.top);
    };

    this.canvas.addEventListener("mousemove", (e) => {
      if (!this.open) return;
      this.cursor = rel(e);
      if (this.dragIndex >= 0) this._updateDragSnap();
      else if (this.heldId) this._updateHeldSnap();
    });

    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.open) return;
      if (e.button === 2) { this.heldId = null; this.selected = -1; this._refresh(); return; }
      this.cursor = rel(e);
      if (this.heldId) { this._placeHeld(); return; }
      // Otherwise pick a part to select / drag.
      const i = this._partAt(this.cursor.x, this.cursor.y);
      this.selected = i;
      if (i >= 0) { this.dragIndex = i; this.dragStart = { ...this.defs[i] }; }
      this._refresh();
    });

    window.addEventListener("mouseup", () => {
      if (!this.open || this.dragIndex < 0) return;
      // Commit drag if snapped (or if it's the only part); else revert.
      if (this.snapPos) { this.defs[this.dragIndex].x = this.snapPos.x; this.defs[this.dragIndex].y = this.snapPos.y; }
      else if (this.defs.length > 1 && this.dragStart) { this.defs[this.dragIndex] = this.dragStart; }
      this.dragIndex = -1; this.dragStart = null; this.snapPos = null;
      this._refresh();
    });

    this.canvas.addEventListener("wheel", (e) => {
      if (!this.open) return;
      e.preventDefault();
      this.scale = Math.max(3, Math.min(60, this.scale * Math.pow(1.0015, -e.deltaY)));
    }, { passive: false });

    this.canvas.addEventListener("contextmenu", (e) => { if (this.open) e.preventDefault(); });

    window.addEventListener("keydown", (e) => {
      if (!this.open) return;
      if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); this._deleteSelected(); }
    });
  }

  _eps() { return 44 / this.scale; }   // snap tolerance in metres

  _updateHeldSnap() {
    const t = SG.Parts.get(this.heldId);
    if (this.defs.length === 0) { this.snapPos = { x: 0, y: 0 }; return; }
    this.snapPos = SG.AssemblyBuild.snap(this.defs, t, this.cursor.x, this.cursor.y, this._eps(), null);
  }

  _updateDragSnap() {
    const held = this.defs[this.dragIndex];
    const t = SG.Parts.get(held.id);
    const others = this.defs.filter((_, i) => i !== this.dragIndex);
    if (others.length === 0) { this.snapPos = { x: this.cursor.x, y: this.cursor.y }; return; }
    this.snapPos = SG.AssemblyBuild.snap(
      this.defs, t, this.cursor.x, this.cursor.y, this._eps(), held, { sx: held.sx, sy: held.sy }
    );
  }

  _placeHeld() {
    this._updateHeldSnap();
    if (!this.snapPos) { this._msg("No attachment point here."); return; }
    this.defs.push({ id: this.heldId, x: this.snapPos.x, y: this.snapPos.y, sx: 1, sy: 1 });
    this.selected = this.defs.length - 1;
    // Keep the tool active for placing multiples (like SFS). Shift-less = keep.
    this._refresh();
  }

  _partAt(bx, by) {
    // Topmost part whose (parametric) box contains the point.
    for (let i = this.defs.length - 1; i >= 0; i--) {
      const p = this.defs[i];
      const e = SG.Parts.effective(SG.Parts.get(p.id), p);
      if (bx >= p.x - e.w / 2 && bx <= p.x + e.w / 2 && by >= p.y - e.h / 2 && by <= p.y + e.h / 2) return i;
    }
    return -1;
  }

  // Resize the selected part and re-flow the vertical stack so nodes stay
  // flush: parts above shift up by half the height change, parts below down.
  _resizeSelected(sx, sy) {
    const p = this.defs[this.selected];
    if (!p) return;
    const t = SG.Parts.get(p.id);
    const lim = SG.Parts.scaleLimits(t);
    sx = Math.max(lim.min, Math.min(lim.max, sx));
    sy = lim.uniform ? sx : Math.max(lim.min, Math.min(lim.max, sy));
    const oldH = t.h * (p.sy || 1);
    const newH = t.h * sy;
    const dh = (newH - oldH) / 2;
    for (const o of this.defs) {
      if (o === p) continue;
      if (o.y < p.y - 1e-9) o.y -= dh;        // above: push up
      else if (o.y > p.y + 1e-9) o.y += dh;   // below: push down
    }
    p.sx = sx; p.sy = sy;
    this._renderStats();
  }

  _deleteSelected() {
    if (this.selected < 0) return;
    this.defs.splice(this.selected, 1);
    this.selected = -1;
    this._refresh();
  }

  // --- Rendering on the main canvas ---
  render(ctx) {
    const W = this._vw(), H = this._vh();
    // Background + ground line + grid.
    ctx.fillStyle = "#0a1220";
    ctx.fillRect(0, 0, W, H);
    this._drawGrid(ctx, W, H);

    // Open attachment nodes (guides).
    for (const p of this.defs) {
      for (const n of SG.AssemblyBuild.worldNodes(p)) {
        if (SG.AssemblyBuild.nodeOccupied(this.defs, p, n.x, n.y, this._eps() * 0.4)) continue;
        const s = this.toScreen(n.x, n.y);
        ctx.fillStyle = "rgba(120,200,120,0.5)";
        ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Placed parts.
    for (let i = 0; i < this.defs.length; i++) this._drawPart(ctx, this.defs[i], i === this.selected, 1);

    // Ghost (held part or dragged part) with snap feedback.
    if (this.heldId && this.dragIndex < 0) {
      const pos = this.snapPos || this.cursor;
      this._drawGhost(ctx, this.heldId, pos, !!this.snapPos);
    }
    if (this.dragIndex >= 0) {
      const d = this.defs[this.dragIndex];
      const pos = this.snapPos || this.cursor;
      this._drawGhost(ctx, d.id, pos, !!this.snapPos, { sx: d.sx, sy: d.sy });
    }

    // Centre-of-mass marker.
    const a = new SG.Assembly(this.defs);
    if (!a.isEmpty()) {
      const com = a.com();
      const s = this.toScreen(com.x, com.y);
      ctx.strokeStyle = "#ffcc44"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y);
      ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8); ctx.stroke();
    }
  }

  _drawGrid(ctx, W, H) {
    ctx.save();
    ctx.strokeStyle = "rgba(90,150,220,0.08)";
    ctx.lineWidth = 1;
    const step = this.scale; // 1 m grid
    const ox = (W / 2) % step, oy = (H / 2) % step;
    for (let x = ox; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = oy; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // Centre column guide.
    ctx.strokeStyle = "rgba(90,150,220,0.2)";
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.restore();
  }

  _drawPart(ctx, p, selected, alpha) {
    const t = SG.Parts.get(p.id);
    const s = this.toScreen(p.x, p.y);
    SG.PartRender.draw(ctx, t, s.x, s.y, this.scale, { alpha, sx: p.sx, sy: p.sy });
    if (selected) {
      const e = SG.Parts.effective(t, p);
      const w = e.w * this.scale, h = e.h * this.scale;
      ctx.save();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(s.x - w / 2 - 2, s.y - h / 2 - 2, w + 4, h + 4);
      ctx.restore();
    }
  }

  _drawGhost(ctx, id, pos, valid, scaleXY) {
    const t = SG.Parts.get(id);
    const s = this.toScreen(pos.x, pos.y);
    const sx = (scaleXY && scaleXY.sx) || 1, sy = (scaleXY && scaleXY.sy) || 1;
    ctx.save();
    ctx.globalAlpha = 0.55;
    SG.PartRender.draw(ctx, t, s.x, s.y, this.scale, { sx, sy });
    const w = t.w * sx * this.scale, h = t.h * sy * this.scale;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = valid ? "#5dff9b" : "#ff5d6c";
    ctx.lineWidth = 2;
    ctx.strokeRect(s.x - w / 2, s.y - h / 2, w, h);
    ctx.restore();
  }

  // --- DOM panels ---
  _build() {
    const palette = SG.Parts.list().map((t) =>
      `<button class="part-btn" data-part="${t.id}" title="${t.desc}">
         <span class="pn">${t.name}</span>
         <span class="pm">${(t.dryMass / 1000).toFixed(2)} t${t.fuel ? " · " + (t.fuel / 1000).toFixed(1) + "t fuel" : ""}${t.thrust ? " · " + (t.thrust / 1000) + " kN" : ""}</span>
       </button>`).join("");

    this.root.innerHTML = `
      <div class="sb-head"><span>🚀 SHIP BUILDER</span><button data-act="menu" class="mini">Menu</button><button data-act="close" class="x" title="Fly (Esc)">✕</button></div>
      <div class="sb-palette">
        <div class="sub-title">PARTS</div>
        ${palette}
        <div class="hint">Click a part, then click a green node to attach. Drag to move, right-click to cancel, Del to remove.</div>
      </div>
      <div class="sb-stats">
        <div class="sub-title">VEHICLE</div>
        <div id="sb-stat-rows"></div>
        <div id="sb-part"></div>
        <div class="sb-actions">
          <button data-act="launch" class="primary">🚀 Launch</button>
          <button data-act="save">Save</button>
          <button data-act="clear" class="danger">Clear</button>
          <button data-act="stock">Stock</button>
        </div>
        <div id="sb-msg"></div>
      </div>
    `;

    this.root.addEventListener("click", (e) => {
      const partBtn = e.target.closest("[data-part]");
      if (partBtn) { this.heldId = partBtn.dataset.part; this.selected = -1; this._refresh(); return; }
      const act = e.target.closest("[data-act]");
      if (act) this._action(act.dataset.act);
    });
  }

  _action(act) {
    switch (act) {
      case "close": this.close(); break;
      case "launch": this._launch(); break;
      case "save": {
        const ok = SG.ShipStore.save(this.defs);
        this._msg(ok ? "Ship saved to browser." : "Save failed.");
        break;
      }
      case "clear": this.defs = []; this.selected = -1; this.heldId = null; this._refresh(); break;
      case "stock": this.defs = SG.Ships.default(); this.selected = -1; this._autoFit(); this._refresh(); break;
      case "del-part": this._deleteSelected(); break;
      case "menu": this.close(); if (SG.menu) SG.menu.show(); break;
    }
  }

  _validity() {
    const a = new SG.Assembly(this.defs);
    if (!a.hasPod()) return "Needs a Command Pod.";
    if (a.engines().length === 0) return "Needs at least one Engine.";
    if (a.thrust() === 0 || a.fuelCapacity() === 0) return "Needs fuel + thrust.";
    return null;
  }

  _launch() {
    const problem = this._validity();
    if (problem) { this._msg(problem); return; }
    SG.ShipStore.save(this.defs);
    SG.game.launchShip(this.defs);
    this.close();
  }

  _refresh() {
    if (this.dragIndex < 0 && this.heldId) this._updateHeldSnap();
    this._renderStats();
    this._renderPartPanel();
    // Reflect held/selected in the palette.
    this.root.querySelectorAll(".part-btn").forEach((b) => {
      b.classList.toggle("held", b.dataset.part === this.heldId);
    });
  }

  // Parametric controls for the selected part (Juno/SFS-style resizing).
  _renderPartPanel() {
    const el = this.root.querySelector("#sb-part");
    if (!el) return;
    const p = this.defs[this.selected];
    if (!p) { el.innerHTML = ""; return; }
    const t = SG.Parts.get(p.id);
    const lim = SG.Parts.scaleLimits(t);
    const slider = (label, field, val) =>
      `<label class="sb-slider">${label} <span class="sv">${(val * 100).toFixed(0)}%</span>
         <input type="range" data-f="${field}" min="${lim.min * 100}" max="${lim.max * 100}" value="${val * 100}">
       </label>`;
    el.innerHTML =
      `<div class="sub-title" style="margin-top:12px">PART · ${t.name}</div>` +
      (lim.uniform
        ? slider("Size", "s", p.sx || 1)
        : slider("Width", "sx", p.sx || 1) + slider("Height", "sy", p.sy || 1)) +
      `<div class="sb-row" id="sb-part-info"></div>` +
      `<button data-act="del-part" class="danger" style="margin-top:6px">Delete part</button>`;

    el.querySelectorAll("input[type=range]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value) / 100;
        const f = inp.dataset.f;
        const sx = f === "sy" ? (p.sx || 1) : v;
        const sy = f === "sx" ? (p.sy || 1) : v;
        this._resizeSelected(sx, sy);
        const lbl = inp.closest("label").querySelector(".sv");
        if (lbl) lbl.textContent = (v * 100).toFixed(0) + "%";
        this._renderPartInfo();
      });
    });
    this._renderPartInfo();
  }

  _renderPartInfo() {
    const el = this.root.querySelector("#sb-part-info");
    const p = this.defs[this.selected];
    if (!el || !p) return;
    const e = SG.Parts.effective(SG.Parts.get(p.id), p);
    let text = ((e.dryMass + e.fuel) / 1000).toFixed(2) + " t";
    if (e.fuel) text += " · " + (e.fuel / 1000).toFixed(2) + " t fuel";
    if (e.thrust) text += " · " + Math.round(e.thrust / 1000) + " kN";
    el.innerHTML = `<span>Stats</span><span>${text}</span>`;
  }

  _renderStats() {
    const el = this.root.querySelector("#sb-stat-rows");
    if (!el) return;
    const a = new SG.Assembly(this.defs);
    const home = SG.game.world.system.homeBody();
    const g = home ? home.mu / (home.radius * home.radius) : 9.81;
    const twr = a.twr(g);
    const row = (k, v) => `<div class="sb-row"><span>${k}</span><span>${v}</span></div>`;
    const problem = this._validity();
    el.innerHTML =
      row("Parts", a.parts.length) +
      row("Mass", (a.mass() / 1000).toFixed(2) + " t") +
      row("Dry / Fuel", (a.dryMass() / 1000).toFixed(2) + " / " + (a.fuelMass() / 1000).toFixed(2) + " t") +
      row("Thrust", (a.thrust() / 1000).toFixed(0) + " kN") +
      row("TWR (home)", (twr).toFixed(2) + (twr >= 1 ? " ✅" : " ⚠️")) +
      row("Δv", Math.round(a.deltaV()).toLocaleString() + " m/s") +
      this._stagingHtml(a) +
      (problem ? `<div class="sb-warn">⚠ ${problem}</div>` : `<div class="sb-ok">✔ Ready to launch</div>`);
  }

  // The staging stack: decouplers split the rocket into stages that fire
  // bottom-first. Shows each stage's engines/tanks so you can plan drops.
  _stagingHtml(a) {
    const groups = a.stageGroups();          // bottom (fires first) -> top
    if (!groups.length) return "";
    let html = `<div class="sub-title" style="margin-top:12px">STAGING · fires bottom→top</div>`;
    // Show last-firing at the top of the list (KSP-style), so number = fire order.
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const counts = {};
      for (const p of g) { const n = SG.Parts.get(p.id).name; counts[n] = (counts[n] || 0) + 1; }
      const items = Object.entries(counts).map(([n, c]) => (c > 1 ? c + "× " : "") + n).join(", ");
      const dv = this._stageDv(a, groups, i);
      html += `<div class="sb-stage"><span class="sn">${i + 1}</span>` +
              `<span class="si">${items}<span class="sdv">${Math.round(dv).toLocaleString()} m/s</span></span></div>`;
    }
    return html;
  }

  // Delta-v contributed by stage `idx` (Tsiolkovsky with mass of it + all above).
  _stageDv(a, groups, idx) {
    let massAbove = a.mass();
    for (let i = 0; i < idx; i++)
      for (const p of groups[i]) { const e = a.eff(p); massAbove -= e.dryMass + e.fuel; }
    const g = groups[idx];
    const fuel = g.reduce((m, p) => m + a.eff(p).fuel, 0);
    const engs = g.filter((p) => SG.Parts.get(p.id).category === "engine");
    const thr = engs.reduce((t, p) => t + a.eff(p).thrust, 0);
    const flow = engs.reduce((f, p) => { const e = a.eff(p); return f + e.thrust / e.ve; }, 0);
    const ve = flow > 0 ? thr / flow : 0;
    const m1 = massAbove - fuel;
    return ve > 0 && fuel > 0 && m1 > 0 ? ve * Math.log(massAbove / m1) : 0;
  }

  _msg(t) { const el = this.root.querySelector("#sb-msg"); if (el) el.textContent = t; }
};

// (Part rendering lives in SG.PartRender — js/parts.js — shared with flight.)

// Boot after the game exists.
window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("shipbuilder");
  if (root && SG.game) SG.shipBuilder = new SG.ShipBuilder(root, SG.game.canvas);
});
