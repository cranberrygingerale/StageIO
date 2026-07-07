// SG.Menu — the start screen: pick a difficulty (world scale), then build.
// The core game loop is  MENU → BUILD → FLY  (Esc returns up the chain).
//
// Difficulty = world scale. Lengths scale by s and gravity parameters by s²,
// which keeps surface gravity earthlike while orbital speed drops by √s —
// exactly why KSP's 1/10-size Kerbin is so much friendlier than real Earth.
window.SG = window.SG || {};

SG.Difficulty = {
  KEY: "stageio.difficulty.v1",
  presets: [
    {
      id: "explorer", name: "Explorer", scale: 0.1,
      blurb: "1/10 scale worlds. Reach orbit with the stock rocket — learn the gravity turn.",
      tag: "RECOMMENDED",
    },
    {
      id: "advanced", name: "Advanced", scale: 0.25,
      blurb: "1/4 scale. You'll need to stretch tanks and stage smartly.",
      tag: "",
    },
    {
      id: "realistic", name: "Realistic", scale: 1,
      blurb: "The real solar system. ~9.4 km/s to orbit. Godspeed.",
      tag: "HARD",
    },
  ],

  byId(id) { return this.presets.find((p) => p.id === id) || null; },
  save(id) { try { localStorage.setItem(this.KEY, id); } catch (e) {} },
  load() {
    try { return this.byId(localStorage.getItem(this.KEY)); } catch (e) { return null; }
  },
};

SG.Menu = class Menu {
  constructor(root) {
    this.root = root;
    this.open = false;
    this._build();
  }

  isOpen() { return this.open; }

  show() {
    this.open = true;
    SG.game.paused = true;
    SG.game.setUiMode("menu");
    SG.game.frameSystem();              // pretty solar-system backdrop
    this.root.classList.add("visible");
  }

  hide() {
    this.open = false;
    this.root.classList.remove("visible");
  }

  _orbitSpeed(scale) {
    // Home-body low-orbit speed at this scale: v = √s · sqrt(mu/r).
    const earth = SG.Systems.default.find((d) => d.isHome) || SG.Systems.default[0];
    return Math.sqrt(scale) * Math.sqrt(earth.mu / earth.radius);
  }

  _build() {
    const cards = SG.Difficulty.presets.map((p) => {
      const v = this._orbitSpeed(p.scale);
      return `
        <button class="menu-card" data-diff="${p.id}">
          ${p.tag ? `<span class="tag">${p.tag}</span>` : ""}
          <span class="mc-name">${p.name}</span>
          <span class="mc-scale">${p.scale === 1 ? "Full scale" : "1/" + Math.round(1 / p.scale) + " scale"}</span>
          <span class="mc-orbit">orbit ≈ ${(v / 1000).toFixed(1)} km/s</span>
          <span class="mc-blurb">${p.blurb}</span>
        </button>`;
    }).join("");

    this.root.innerHTML = `
      <div class="menu-inner">
        <h1 class="menu-title">STAGE<span>.IO</span></h1>
        <p class="menu-sub">build a rocket · reach orbit · go further</p>
        <div class="menu-cards">${cards}</div>
        <p class="menu-hint">Pick a world size to start building. You can return here any time with <kbd>Esc</kbd>.</p>
      </div>`;

    this.root.addEventListener("click", (e) => {
      const card = e.target.closest("[data-diff]");
      if (!card) return;
      this._start(SG.Difficulty.byId(card.dataset.diff));
    });
  }

  _start(preset) {
    if (!preset) return;
    SG.Difficulty.save(preset.id);
    SG.game.applyDifficulty(preset);
    this.hide();
    if (SG.shipBuilder) SG.shipBuilder.show();   // straight into the hangar
  }
};

// Boot after the game + builders exist, then open the menu (the game loop
// always starts at the menu).
window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("menu");
  if (root && SG.game) {
    SG.menu = new SG.Menu(root);
    SG.menu.show();
  }
});
