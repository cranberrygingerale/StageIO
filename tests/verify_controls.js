// Verify throttle/engine model + view modes against the real source files,
// driving a real SG.Game against a mock canvas.
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
global.devicePixelRatio = 1;
global.innerWidth = 1280; global.innerHeight = 720;
global.requestAnimationFrame = () => 0;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = {
  getElementById: () => ({ getContext: () => ctx, style: {}, classList: { add() {}, remove() {} }, addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, set textContent(v) {}, set className(v) {} }),
};

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "kepler", "bodies", "systems", "parts", "assembly", "ship", "world", "game", "shipbuilder", "systembuilder"].forEach((m) => load("js/" + m + ".js"));

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

// Controllable input mock.
const down = new Set();
let pressedQ = [];
SG.Input.isDown = (a) => down.has(a);
SG.Input.consumePressed = () => { const p = pressedQ; pressedQ = []; return p; };
SG.Input.consumeWheel = () => 0;
const press = (a) => pressedQ.push(a);

const game = new SG.Game(document.getElementById("game"));
const ship = game.ship;

// 1) Engine starts OFF; toggling ignites it.
ok(!ship.engineOn, "engine starts OFF on the pad");
press("engineToggle"); game._handleDiscreteInput();
ok(ship.engineOn, "Space/engineToggle ignites the engine");

// 2) Throttle at 0 => no thrust even with engine on.
ship.setThrottle(0);
ok(!ship.isThrusting(), "engine on but 0% throttle => not thrusting");

// 3) Accel = thrust/mass (part-based); half throttle => half accel.
press("throttleMax"); game._handleDiscreteInput();
ok(Math.abs(ship.throttle - 1) < 1e-9, "Z sets throttle to 100%");
const expectFull = ship.assembly.thrust() / ship.assembly.mass();
let acc = ship.control(SG.Input, 0.001);
let aMag = Math.hypot(acc.ax, acc.ay);
ok(Math.abs(aMag - expectFull) < 1e-2, `full throttle => thrust/mass (${aMag.toFixed(1)} m/s^2)`);
ship.setThrottle(0.5);
acc = ship.control(SG.Input, 0.001);
const aHalf = Math.hypot(acc.ax, acc.ay);
ok(Math.abs(aHalf - aMag * 0.5) < 1e-2, `50% throttle => half accel (${aHalf.toFixed(1)} m/s^2)`);

// 4) Fuel burn (kg) scales with throttle and lowers assembly mass.
ship.assembly.fillFuel(); ship.setThrottle(1);
const f0 = ship.assembly.fuelMass(); ship.control(SG.Input, 1.0);
const burnFull = f0 - ship.assembly.fuelMass();
ship.assembly.fillFuel(); ship.setThrottle(0.25);
const f1 = ship.assembly.fuelMass(); ship.control(SG.Input, 1.0);
const burnQuarter = f1 - ship.assembly.fuelMass();
ok(burnFull > 0 && Math.abs(burnQuarter - burnFull * 0.25) < 1e-6,
   `fuel burn scales with throttle (full ${burnFull.toFixed(1)} kg, quarter ${burnQuarter.toFixed(1)} kg)`);

// 5) Cut throttle.
press("throttleZero"); game._handleDiscreteInput();
ok(ship.throttle === 0, "X cuts throttle to 0%");

// 6) A running engine forces time warp back to 1x.
ship.fuel = 100; ship.setThrottle(1); ship.engineOn = true;
game.warpIndex = 5;
game._frame(1000);
ok(game.warpIndex === 0, "running engine forces warp to 1x");

// 7) View toggle: craft <-> map, with distinct zooms.
game.reset();
ok(game.viewMode === "craft", "starts in craft view");
const craftZoom = game.camera.zoom;
// Put ship in a real orbit so map framing has an orbit to frame.
const E = game.world.system.byName("Earth"); game.world.update(game.simTime);
const rO = E.radius + 4e5, vC = Math.sqrt(E.mu / rO);
ship.x = E.x + rO; ship.y = E.y; ship.vx = E.vx; ship.vy = E.vy + vC; game.landed = false;
game.dominant = E;
press("toggleMap"); game._handleDiscreteInput();
ok(game.viewMode === "map", "M switches to map view");
ok(game.mapZoom && game.mapZoom !== craftZoom, `map view frames its own zoom (map ${game.mapZoom.toExponential(2)} vs craft ${craftZoom.toExponential(2)})`);
press("toggleMap"); game._handleDiscreteInput();
ok(game.viewMode === "craft" && Math.abs(game.camera.zoom - craftZoom) < craftZoom * 1e-9, "M returns to craft view with its zoom restored");

// 8) Both views render a full frame without throwing.
let threw = null;
try {
  game._frame(1016); // craft
  press("toggleMap"); game._handleDiscreteInput();
  game._frame(1032); // map (with Ap/Pe markers + SOI ring)
} catch (e) { threw = e; }
ok(!threw, "craft + map frames render without throwing" + (threw ? " — " + threw.message : ""));

console.log(`\n${failures === 0 ? "CONTROL/VIEW CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
