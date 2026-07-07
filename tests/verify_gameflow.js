// Verify difficulty scaling, parametric parts, stack re-flow, orbit
// feasibility at Explorer scale, and flight-UI hiding.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.window = global;

const gradientStub = { addColorStop() {} };
const ctx = new Proxy({ canvas: {} }, {
  get(t, k) {
    if (k === "createLinearGradient" || k === "createRadialGradient") return () => gradientStub;
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
global.addEventListener = () => {};
global.devicePixelRatio = 1; global.innerWidth = 1280; global.innerHeight = 720;
global.requestAnimationFrame = () => 0;
let stored = {};
global.localStorage = { getItem: (k) => stored[k] || null, setItem: (k, v) => (stored[k] = String(v)), removeItem: (k) => delete stored[k] };
const bodyClasses = new Set();
const elStub = () => ({
  getContext: () => ctx, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
  querySelector: () => null, querySelectorAll: () => [],
  set innerHTML(v) {}, set textContent(v) {},
});
global.document = {
  getElementById: elStub,
  body: { classList: {
    add: (c) => bodyClasses.add(c),
    remove: (c) => bodyClasses.delete(c),
    toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)),
  } },
};

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "kepler", "bodies", "systems", "parts", "assembly", "ship", "world", "game", "shipbuilder", "systembuilder", "menu"].forEach((m) => load("js/" + m + ".js"));

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

// --- 1) Difficulty scaling invariants ---------------------------------------
{
  const earth = SG.Systems.default.find((d) => d.name === "Earth");
  const s = 0.1;
  const scaled = SG.scaleSystem(SG.Systems.default, s).find((d) => d.name === "Earth");
  const g0 = earth.mu / (earth.radius * earth.radius);
  const g1 = scaled.mu / (scaled.radius * scaled.radius);
  ok(Math.abs(g1 - g0) / g0 < 1e-12, `scaling preserves surface gravity (${g1.toFixed(2)} = ${g0.toFixed(2)})`);
  const v0 = Math.sqrt(earth.mu / earth.radius);
  const v1 = Math.sqrt(scaled.mu / scaled.radius);
  ok(Math.abs(v1 / v0 - Math.sqrt(s)) < 1e-12, `orbital speed scales by √s (${Math.round(v1)} = √0.1·${Math.round(v0)})`);
  // Round-trip normalization (the anti-double-scaling property).
  const back = SG.scaleSystem(SG.scaleSystem(SG.Systems.default, s), 1 / s).find((d) => d.name === "Earth");
  ok(Math.abs(back.radius - earth.radius) < 1e-3 && Math.abs(back.mu - earth.mu) / earth.mu < 1e-12,
     "scaleSystem(defs, 1/s) exactly inverts scaleSystem(defs, s)");
}

// --- 2) Parametric part math --------------------------------------------------
{
  const tank = SG.Parts.get("tankS");
  const e1 = SG.Parts.effective(tank, { sx: 1, sy: 2 });
  ok(Math.abs(e1.fuel - tank.fuel * 2) < 1e-9 && Math.abs(e1.dryMass - tank.dryMass * 2) < 1e-9,
     "tank height ×2 => fuel & dry mass ×2");
  const e2 = SG.Parts.effective(tank, { sx: 2, sy: 1 });
  ok(Math.abs(e2.fuel - tank.fuel * 4) < 1e-9, "tank width ×2 => fuel ×4 (volume ∝ w²)");
  const eng = SG.Parts.get("engineL");
  const e3 = SG.Parts.effective(eng, { sx: 2, sy: 2 });
  const twr0 = eng.thrust / eng.dryMass, twr3 = e3.thrust / e3.dryMass;
  ok(Math.abs(e3.thrust - eng.thrust * 4) < 1e-9 && Math.abs(twr3 - twr0) < 1e-9,
     "engine size ×2 => thrust ×4 with constant TWR");
}

// --- 3) Stretched assembly gains delta-v ---------------------------------------
{
  const base = new SG.Assembly(SG.AssemblyBuild.stack(["pod", "tankL", "engineL"]));
  const stretched = new SG.Assembly(SG.AssemblyBuild.stack(["pod", { id: "tankL", sy: 2.5 }, "engineL"]));
  ok(stretched.deltaV() > base.deltaV() * 1.3,
     `stretching the tank raises Δv (${Math.round(base.deltaV())} -> ${Math.round(stretched.deltaV())} m/s)`);
  // Nodes flush in a parametric stack: each part's bottom == next part's top.
  let flush = true;
  for (let i = 0; i + 1 < stretched.parts.length; i++) {
    const a = stretched.parts[i], b = stretched.parts[i + 1];
    const aBot = a.y + stretched.eff(a).h / 2, bTop = b.y - stretched.eff(b).h / 2;
    if (Math.abs(aBot - bTop) > 1e-9) flush = false;
  }
  ok(flush, "parametric stack() keeps nodes flush");
}

// --- 4) Builder resize re-flows the stack --------------------------------------
{
  const game = new SG.Game(global.document.getElementById("game"));
  const sb = new SG.ShipBuilder(elStub(), game.canvas);
  sb.defs = SG.Ships.default();
  // Select the first tankS and double its height.
  sb.selected = sb.defs.findIndex((p) => p.id === "tankS");
  sb._resizeSelected(1, 2);
  const a = new SG.Assembly(sb.defs);
  const ordered = a.parts.slice().sort((x, y) => x.y - y.y);
  let flush = true;
  for (let i = 0; i + 1 < ordered.length; i++) {
    const aBot = ordered[i].y + a.eff(ordered[i]).h / 2;
    const bTop = ordered[i + 1].y - a.eff(ordered[i + 1]).h / 2;
    if (Math.abs(aBot - bTop) > 1e-6) flush = false;
  }
  ok(flush, "resizing a mid-stack part keeps the whole stack flush");

  // --- 5) Orbit feasibility at Explorer scale ---
  const explorer = SG.Difficulty.byId("explorer");
  game.applyDifficulty(explorer);
  const home = game.world.system.homeBody();
  const vOrbit = Math.sqrt(home.mu / (home.radius * 1.05));
  const dv = game.ship.assembly.deltaV();
  ok(dv > vOrbit * 1.6,
     `stock rocket can orbit at Explorer scale (Δv ${Math.round(dv)} vs orbit ${Math.round(vOrbit)} m/s)`);
  ok(Math.abs(home.radius - 6.371e5) < 1, `Explorer Earth radius is 1/10 real (${Math.round(home.radius)} m)`);

  // No compounding: switch to realistic and back.
  game.applyDifficulty(SG.Difficulty.byId("realistic"));
  ok(Math.abs(game.world.system.homeBody().radius - 6.371e6) < 1, "Realistic restores full-size Earth");
  game.applyDifficulty(explorer);
  ok(Math.abs(game.world.system.homeBody().radius - 6.371e5) < 1, "re-applying Explorer doesn't compound scaling");

  // --- 6) Flight UI hidden outside flight ---
  game.setUiMode("build");
  ok(bodyClasses.has("no-flight-ui"), "build mode hides the flight HUD");
  game.setUiMode("menu");
  ok(bodyClasses.has("no-flight-ui"), "menu hides the flight HUD");
  game.setUiMode("flight");
  ok(!bodyClasses.has("no-flight-ui"), "flight mode shows the flight HUD");
}

console.log(`\n${failures === 0 ? "GAMEFLOW CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
