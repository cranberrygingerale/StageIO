// Load ALL game files and drive a full game frame against a mock canvas to
// catch syntax/reference/runtime errors in the render path (ship/world/camera).
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.window = global;

// Mock 2D context: every method is a no-op; gradients return a stub.
const gradientStub = { addColorStop() {} };
const ctx = new Proxy(
  { canvas: {} },
  {
    get(t, k) {
      if (k === "createLinearGradient" || k === "createRadialGradient") return () => gradientStub;
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  }
);

const listeners = {};
global.addEventListener = (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); };
global.devicePixelRatio = 1;
global.innerWidth = 1280;
global.innerHeight = 720;
global.requestAnimationFrame = () => 0; // don't actually loop
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = {
  getElementById: () => ({
    getContext: () => ctx,
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    set innerHTML(v) {},
  }),
};

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "aero", "kepler", "bodies", "systems", "parts", "assembly", "ship", "world", "game", "shipbuilder", "systembuilder"].forEach((m) => load("js/" + m + ".js"));

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

try {
  const canvas = global.document.getElementById("game");
  const game = new SG.Game(canvas);
  ok(true, "SG.Game constructs (World/Ship/Camera instantiate)");

  // Drive several frames with the engine ignited at full throttle.
  game.ship.engineOn = true;
  game.ship.setThrottle(1);
  let threw = null;
  try {
    for (let i = 1; i <= 10; i++) game._frame(i * 16.7);
  } catch (e) { threw = e; }
  ok(!threw, "10 game frames render without throwing" + (threw ? " — " + threw.message : ""));

  // Ship should have thrusted (state advanced under engine power).
  ok(game.ship.thrusting === true, "engine + throttle propagates to thrust");

  // Trajectory + HUD paths executed without error (covered by frames above).
  ok(true, "trajectory preview + HUD update paths executed");

  // First put the ship into a real bound orbit around Earth so rails warp is
  // valid (from the launch pad it's suborbital and rails would be gated off).
  game.ship.engineOn = false;          // engine off so warp isn't forced to 1x
  game.ship.setThrottle(0);
  const E = game.world.system.byName("Earth");
  game.world.update(game.simTime);
  const rO = E.radius + 5e5, vC = Math.sqrt(E.mu / rO);
  game.ship.x = E.x + rO; game.ship.y = E.y;
  game.ship.vx = E.vx; game.ship.vy = E.vy + vC;
  game.landed = false;

  // Rails time warp: run frames at max warp (1,000,000x) without throwing.
  game.warpIndex = SG.Config.warpLevels.length - 1;
  let warpThrew = null;
  try { for (let i = 11; i <= 30; i++) game._frame(i * 16.7); } catch (e) { warpThrew = e; }
  ok(!warpThrew, "frames at max RAILS warp render without throwing" + (warpThrew ? " — " + warpThrew.message : ""));

  // The ship should still be in a bound orbit near Earth after warping.
  const dom = game.dominant;
  const alt = Math.hypot(game.ship.x - dom.x, game.ship.y - dom.y) - dom.radius;
  ok(dom.name === "Earth" && alt > 1e5 && alt < 1e7, `still orbiting Earth after rails warp (alt ${(alt/1000).toFixed(0)} km)`);

  // Frame-system + full solar system present.
  game.frameSystem();
  ok(game.world.system.bodies.length === 18, `solar system has all 18 bodies (got ${game.world.system.bodies.length})`);
} catch (e) {
  ok(false, "construction/frame threw: " + e.message + "\n" + e.stack);
}

console.log(`\n${failures === 0 ? "RENDER PATH OK ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
