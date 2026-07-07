// SG.SystemBuilder — the in-game planet maker + solar system maker.
//
// An editor overlay (toggle with B) that edits the working list of body
// definitions: add/edit/delete planets & moons, rebuild the live system, frame
// it in view, and export / import / save systems as JSON. Editing pauses the
// simulation so you can see the whole system while you work.
window.SG = window.SG || {};

SG.SystemBuilder = class SystemBuilder {
  constructor(root) {
    this.root = root;                 // container element (#builder)
    this.open = false;
    this.selected = null;             // selected body name
    // Work on a copy of whatever the game currently has loaded.
    this.defs = SG.game.world.system.toDefs();
    this._build();
    this._refresh();
  }

  isOpen() { return this.open; }
  selectedName() { return this.selected; }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.defs = SG.game.world.system.toDefs(); // sync with live system
    SG.game.paused = true;
    SG.game.frameSystem();
    this.root.classList.add("visible");
    this._refresh();
  }

  close() {
    this.open = false;
    SG.game.paused = false;
    this.root.classList.remove("visible");
  }

  // --- DOM construction ------------------------------------------------------
  _build() {
    this.root.innerHTML = `
      <div class="builder-head">
        <span>SYSTEM BUILDER</span>
        <button data-act="close" class="x">✕</button>
      </div>
      <div class="builder-cols">
        <div class="builder-list">
          <div class="sub-title">BODIES</div>
          <ul id="body-list"></ul>
          <div class="row-btns">
            <button data-act="add-planet">+ Planet</button>
            <button data-act="add-moon">+ Moon</button>
            <button data-act="delete" class="danger">Delete</button>
          </div>
        </div>
        <div class="builder-form" id="body-form"></div>
      </div>
      <div class="builder-foot">
        <button data-act="frame">Frame (F)</button>
        <button data-act="save">Save</button>
        <button data-act="export">Export</button>
        <button data-act="import">Import</button>
        <button data-act="reset" class="danger">Stock</button>
        <span id="builder-msg"></span>
      </div>
      <textarea id="builder-json" placeholder="Paste system JSON here, then press Import" spellcheck="false"></textarea>
    `;

    this.root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      this._action(btn.dataset.act);
    });
  }

  _action(act) {
    switch (act) {
      case "close": this.close(); break;
      case "add-planet": this._addBody(false); break;
      case "add-moon": this._addBody(true); break;
      case "delete": this._deleteSelected(); break;
      case "frame": SG.game.frameSystem(); break;
      case "save": this._save(); break;
      case "export": this._export(); break;
      case "import": this._import(); break;
      case "reset": this._loadStock(); break;
    }
  }

  // --- Body operations -------------------------------------------------------
  _uniqueName(base) {
    let n = base, i = 2;
    const taken = (nm) => this.defs.some((d) => d.name === nm);
    while (taken(n)) n = base + i++;
    return n;
  }

  _addBody(asMoon) {
    // Parent = currently selected body (as a moon) or the root (as a planet).
    const root = this.defs.find((d) => !d.parent) || this.defs[0];
    let parentName = root ? root.name : null;
    if (asMoon && this.selected) parentName = this.selected;
    const parentDef = this.defs.find((d) => d.name === parentName);
    // Real-scale defaults: an Earth-like planet or a Moon-like satellite, placed
    // at a sensible multiple of the parent's radius.
    const baseOrbit = parentDef ? (parentDef.radius || 6e6) * (asMoon ? 60 : 20000) : 1.5e11;

    const def = {
      name: this._uniqueName(asMoon ? "Moon" : "Planet"),
      parent: parentName,
      radius: asMoon ? 1.7e6 : 6.0e6,
      mu: asMoon ? 5.0e12 : 4.0e14,
      color: asMoon ? "#9aa3ad" : "#4a8fd0",
      atmosphere: asMoon ? 0 : 1.0e5,
      orbitRadius: baseOrbit,
      phase: 0,
      isHome: false,
    };
    this.defs.push(def);
    this.selected = def.name;
    this._apply();
  }

  _deleteSelected() {
    if (!this.selected) return;
    const target = this.defs.find((d) => d.name === this.selected);
    if (!target) return;
    if (!target.parent) { this._msg("Can't delete the root body."); return; }
    // Re-parent any children of the deleted body up to its parent.
    for (const d of this.defs) if (d.parent === target.name) d.parent = target.parent;
    this.defs = this.defs.filter((d) => d.name !== this.selected);
    this.selected = null;
    this._apply();
  }

  // Rebuild the live system from the working defs and refresh the UI.
  _apply() {
    // Guarantee exactly one home body.
    if (!this.defs.some((d) => d.isHome)) {
      const firstPlanet = this.defs.find((d) => d.parent) || this.defs[0];
      if (firstPlanet) firstPlanet.isHome = true;
    }
    SG.game.rebuildSystem(this.defs.map((d) => ({ ...d })));
    SG.game.paused = true;        // rebuildSystem->reset doesn't unpause us
    SG.game.frameSystem();
    this._refresh();
  }

  // --- Rendering the editor --------------------------------------------------
  _refresh() {
    const list = this.root.querySelector("#body-list");
    if (!list) return;
    list.innerHTML = "";
    // Show as an indented tree (parents before children).
    const depth = (d) => {
      let n = 0, cur = d;
      while (cur && cur.parent) { cur = this.defs.find((x) => x.name === cur.parent); n++; if (n > 20) break; }
      return n;
    };
    for (const d of this.defs) {
      const li = document.createElement("li");
      li.textContent = (d.isHome ? "★ " : "") + d.name;
      li.style.paddingLeft = 8 + depth(d) * 14 + "px";
      if (d.name === this.selected) li.classList.add("sel");
      li.addEventListener("click", () => { this.selected = d.name; this._refresh(); });
      list.appendChild(li);
    }
    this._renderForm();
  }

  _renderForm() {
    const form = this.root.querySelector("#body-form");
    if (!form) return;
    const d = this.defs.find((x) => x.name === this.selected);
    if (!d) { form.innerHTML = `<div class="hint">Select a body, or add one.</div>`; return; }

    const isRoot = !d.parent;
    const parentOpts = this.defs
      .filter((x) => x.name !== d.name)
      .map((x) => `<option value="${x.name}" ${x.name === d.parent ? "selected" : ""}>${x.name}</option>`)
      .join("");

    form.innerHTML = `
      <label>Name <input data-f="name" value="${d.name}"></label>
      <label>Parent
        <select data-f="parent" ${isRoot ? "disabled" : ""}>
          <option value="">— (root)</option>${parentOpts}
        </select>
      </label>
      <label>Radius <input data-f="radius" type="number" value="${d.radius}"></label>
      <label>Mass μ (G·M) <input data-f="mu" type="number" value="${d.mu}"></label>
      <label>Atmosphere <input data-f="atmosphere" type="number" value="${d.atmosphere || 0}"></label>
      <label>Orbit radius <input data-f="orbitRadius" type="number" value="${d.orbitRadius || 0}" ${isRoot ? "disabled" : ""}></label>
      <label>Start angle <input data-f="phase" type="number" step="0.1" value="${d.phase || 0}" ${isRoot ? "disabled" : ""}></label>
      <label>Color <input data-f="color" type="color" value="${d.color}"></label>
      <label class="check"><input data-f="isHome" type="checkbox" ${d.isHome ? "checked" : ""}> Home (spawn here)</label>
      <div class="soi-hint" id="soi-hint"></div>
    `;

    form.querySelectorAll("[data-f]").forEach((el) => {
      el.addEventListener("change", () => this._onField(d, el));
    });
    this._updateSoiHint(d);
  }

  _onField(d, el) {
    const f = el.dataset.f;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "number") v = parseFloat(el.value);
    else v = el.value;

    if (f === "name") {
      const newName = (v || "").trim();
      if (!newName || this.defs.some((x) => x !== d && x.name === newName)) { this._msg("Name must be unique."); this._refresh(); return; }
      // Keep children pointing at the renamed parent.
      for (const c of this.defs) if (c.parent === d.name) c.parent = newName;
      d.name = newName;
      this.selected = newName;
    } else if (f === "isHome") {
      if (v) for (const x of this.defs) x.isHome = false; // only one home
      d.isHome = v;
    } else if (f === "mu" || f === "radius" || f === "orbitRadius") {
      d[f] = Math.max(f === "orbitRadius" ? 0 : 1, v || 0);
    } else if (f === "parent") {
      d.parent = v || null;
    } else {
      d[f] = v;
    }
    this._apply();
  }

  _updateSoiHint(d) {
    const el = this.root.querySelector("#soi-hint");
    if (!el) return;
    const body = SG.game.world.system.byName(d.name);
    if (!body) { el.textContent = ""; return; }
    const soi = isFinite(body.soi) ? Math.round(body.soi).toLocaleString() : "∞ (dominant)";
    const g = (body.mu / (body.radius * body.radius)).toFixed(2);
    el.textContent = `SOI ≈ ${soi} m · surface g ≈ ${g} u/s²`;
  }

  // --- Persistence / IO ------------------------------------------------------
  _save() {
    const ok = SG.SystemStore.save(this.defs);
    this._msg(ok ? "Saved to browser." : "Save failed.");
  }
  _export() {
    const ta = this.root.querySelector("#builder-json");
    ta.value = JSON.stringify(this.defs, null, 2);
    ta.focus();
    ta.select();
    this._msg("Exported JSON below — copy it.");
  }
  _import() {
    const ta = this.root.querySelector("#builder-json");
    try {
      const defs = JSON.parse(ta.value);
      if (!Array.isArray(defs) || !defs.length) throw new Error("expected a non-empty array");
      this.defs = defs;
      this.selected = null;
      this._apply();
      this._msg("Imported.");
    } catch (e) {
      this._msg("Import failed: " + e.message);
    }
  }
  _loadStock() {
    this.defs = SG.Systems.default.map((d) => ({ ...d }));
    this.selected = null;
    SG.SystemStore.clear();
    this._apply();
    this._msg("Reset to stock system.");
  }

  _msg(text) {
    const el = this.root.querySelector("#builder-msg");
    if (el) el.textContent = text;
  }
};

// Boot after the game exists (game.js sets SG.game on DOMContentLoaded; this
// listener is registered later in load order, so it runs after that one).
window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("builder");
  if (root && SG.game) SG.builder = new SG.SystemBuilder(root);
});
