// Maneuver nodes: create/clear, predicted-orbit math (prograde raises apoapsis),
// execution (burning along the node spends it), and Moon-encounter detection.
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
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = {
  getElementById: () => ({ getContext: () => ctx, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, set textContent(v) {}, set className(v) {} }),
};

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "aero", "kepler", "maneuver", "bodies", "systems", "parts", "assembly", "ship", "world", "effects", "game"].forEach((m) => load("js/" + m + ".js"));

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };
const apoR = (el) => el.a * (1 + el.e);   // apoapsis radius from elements

SG.Input.isDown = () => false;
SG.Input.consumePressed = () => [];
SG.Input.consumeWheel = () => 0;

const game = new SG.Game(document.getElementById("game"));
const Earth = game.world.system.byName("Earth");
const Moon = game.world.system.byName("Moon");
game.world.update(game.simTime);

// Drop the ship into a clean circular low orbit around Earth (prograde/CCW).
const r1 = Earth.radius * 1.3;
function circularize() {
  const s = game.ship;
  s.x = Earth.x + r1; s.y = Earth.y;
  s.vx = Earth.vx; s.vy = Earth.vy + Math.sqrt(Earth.mu / r1);
  s.alive = true; s.landed = false; s.dominant = Earth;
}
circularize();

// --- 1) N creates a node from a valid orbit; N again clears it -----------------
ok(game.node === null, "no maneuver node to start");
game._toggleNode();
ok(game.node && game.node.pro === 0 && game.node.rad === 0, "N plots a fresh (zero-Δv) node");
ok(game.node.t > game.simTime, "the node sits in the future (next periapsis)");
game._toggleNode();
ok(game.node === null, "N again clears the node");

// A landed ship can't plot a node (no orbit to plan from).
{
  const s = game.ship; const wasLanded = s.landed; s.landed = true;
  game._toggleNode();
  ok(game.node === null, "no node while landed");
  s.landed = wasLanded;
}

// --- 2) Prediction: a prograde burn raises the predicted apoapsis --------------
circularize();
game._toggleNode();
{
  const info0 = SG.Maneuver.compute(game);
  ok(info0.valid && Math.abs(apoR(info0.postEl) - r1) < r1 * 0.02,
     "zero-Δv node predicts (almost) the current circular orbit");
  game.node.pro = 250;                       // burn prograde
  const info1 = SG.Maneuver.compute(game);
  ok(apoR(info1.postEl) > apoR(info0.postEl) * 1.05,
     `prograde Δv raises predicted apoapsis (${(apoR(info0.postEl)/1e3).toFixed(0)} km -> ${(apoR(info1.postEl)/1e3).toFixed(0)} km)`);
  game.node.pro = -250;                       // burn retrograde
  const info2 = SG.Maneuver.compute(game);
  ok(apoR(info2.postEl) < apoR(info0.postEl),
     "retrograde Δv lowers the predicted orbit");
}
game._clearNode();

// --- 3) Executing the burn (thrusting along it) spends the node ----------------
{
  circularize();
  game._toggleNode();
  game.node.pro = 300; game.node.rad = 0;
  game._nodeInfo = SG.Maneuver.compute(game);
  game._burnUnit = game._nodeInfo.burnUnit;
  const before = Math.hypot(game.node.pro, game.node.rad);
  // Burn ~120 m/s worth of Δv along the planned direction.
  game._consumeNode(game._burnUnit.x * 120, game._burnUnit.y * 120);
  const mid = Math.hypot(game.node.pro, game.node.rad);
  ok(mid < before - 100, `burning shrinks the remaining node Δv (${before.toFixed(0)} -> ${mid.toFixed(0)} m/s)`);
  // Finish the burn — the node auto-clears when essentially complete.
  game._consumeNode(game._burnUnit.x * 300, game._burnUnit.y * 300);
  ok(game.node === null, "the node clears itself once the burn is done");
}

// Burning the WRONG way earns no credit.
{
  circularize();
  game._toggleNode();
  game.node.pro = 200;
  game._nodeInfo = SG.Maneuver.compute(game);
  game._burnUnit = game._nodeInfo.burnUnit;
  const before = Math.hypot(game.node.pro, game.node.rad);
  game._consumeNode(-game._burnUnit.x * 100, -game._burnUnit.y * 100);
  ok(Math.abs(Math.hypot(game.node.pro, game.node.rad) - before) < 1e-6,
     "thrusting away from the node doesn't spend it");
  game._clearNode();
}

// --- 4) A Hohmann-style prograde burn produces a Moon intercept ----------------
{
  ok(Moon && Moon.parent === Earth && isFinite(Moon.soi), "the Moon orbits Earth with a finite SOI");
  const r2 = Moon.orbitRadius, mu = Earth.mu;
  const apoTarget = r2 * 1.08;                              // reach just past the Moon's orbit
  const vPeri = Math.sqrt(mu * (2 / r1 - 2 / (r1 + apoTarget)));
  const dv = vPeri - Math.sqrt(mu / r1);                    // prograde Δv at periapsis

  circularize();
  game._toggleNode();
  game.node.pro = dv; game.node.rad = 0;

  // Sweep the burn point around the orbit (via node time) to aim the apoapsis at
  // wherever the Moon will be on arrival — an intercept should exist somewhere.
  const T1 = 2 * Math.PI * Math.sqrt((r1 * r1 * r1) / mu);
  let hit = null;
  for (let k = 0; k < 720 && !hit; k++) {
    game.node.t = game.simTime + (k / 720) * T1;
    const info = SG.Maneuver.compute(game);
    if (info.encounter && info.encounter.body === Moon) hit = info.encounter;
  }
  ok(hit, "sweeping the burn timing finds a Moon SOI intercept");
  if (hit) {
    const d = Math.hypot(hit.shipRel.x - hit.bodyRel.x, hit.shipRel.y - hit.bodyRel.y);
    ok(d < Moon.soi, `intercept really is inside the Moon's SOI (${(d/1e3).toFixed(0)} km < ${(Moon.soi/1e3).toFixed(0)} km)`);
    ok(hit.t > game.node.t, "the encounter happens after the burn");
  }
  game._clearNode();
}

console.log(`\n${failures === 0 ? "MANEUVER CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
