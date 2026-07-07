// Verify craft view is ship-relative and map view supports focus switching.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.window = global;
const gradientStub = { addColorStop() {} };
const ctx = new Proxy({ canvas: {} }, {
  get(t, k) { if (k === "createLinearGradient" || k === "createRadialGradient") return () => gradientStub; if (k in t) return t[k]; return () => {}; },
  set(t, k, v) { t[k] = v; return true; },
});
global.addEventListener = () => {};
global.devicePixelRatio = 1; global.innerWidth = 1280; global.innerHeight = 720;
global.requestAnimationFrame = () => 0;
let stored = {};
global.localStorage = { getItem: (k) => stored[k] || null, setItem: (k, v) => (stored[k] = v), removeItem: (k) => delete stored[k] };
global.document = { getElementById: () => ({ getContext: () => ctx, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, set textContent(v) {} }) };
function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "aero", "kepler", "bodies", "systems", "parts", "assembly", "ship", "world", "game", "shipbuilder", "systembuilder"].forEach((m) => load("js/" + m + ".js"));
const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

const game = new SG.Game(document.getElementById("game"));

// 1) Craft default zoom frames the SHIP (~28% of viewport height), not the planet.
game.reset();
const shipH = game.ship.height();
const shipPx = shipH * game.craftZoom;
const view = Math.min(1280, 720);
ok(shipPx > view * 0.15 && shipPx < view * 0.6, `craft default frames the ship (${shipPx.toFixed(0)} px tall on a ${view}px view)`);
// Planet-fill zoom would have made the ship a sub-pixel speck:
const planetFillZoom = (view * 0.42) / game.world.system.homeBody().radius;
ok(game.craftZoom > planetFillZoom * 50, "craft zoom is far closer than the old planet-filling zoom");

// 2) Entering map focuses the ship's SOI body and centers on it.
SG.Input.consumePressed = (() => { let q = []; SG.Input._q = q; return () => { const p = q.slice(); q.length = 0; return p; }; })();
const press = (a) => SG.Input._q.push(a);
press("toggleMap"); game._handleDiscreteInput(); game._frame(16);
ok(game.viewMode === "map" && game.mapTarget === game.dominant, `map focuses ship's body first (${game.mapTarget.name})`);
ok(Math.abs(game.camera.x - game.mapTarget.x) < 1 && Math.abs(game.camera.y - game.mapTarget.y) < 1, "camera centers on the focus target");

// 3) Focus cycling changes the target and re-centers.
const before = game.mapTarget.name;
press("focusNext"); game._handleDiscreteInput();
const after = game.mapTarget.name;
ok(after !== before, `] cycles focus to another body (${before} -> ${after})`);
game._frame(32);
ok(Math.abs(game.camera.x - game.mapTarget.x) < 1, "camera re-centers on the new focus target");
press("focusPrev"); game._handleDiscreteInput();
ok(game.mapTarget.name === before, `[ cycles focus back (${game.mapTarget.name})`);

// 4) Click-to-focus picks the body nearest the click point.
const target = game.world.system.byName("Mars") || game.world.system.bodies[3];
game.mapTarget = game.world.system.homeBody(); game.frameMap();
const sp = game.camera.worldToScreen(target.x, target.y);
const picked = game._bodyAtScreen(sp.x, sp.y);
ok(picked === target, `click-to-focus selects the clicked body (${picked ? picked.name : "null"})`);

// 5) Map renders with a foreign focus target without throwing.
let threw = null;
try { game.mapTarget = target; game.frameMap(); game._frame(48); } catch (e) { threw = e; }
ok(!threw, "map renders with a non-dominant focus" + (threw ? " — " + threw.message : ""));

console.log(`\n${failures === 0 ? "VIEW CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
