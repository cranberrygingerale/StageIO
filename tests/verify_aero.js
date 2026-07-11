// M1 acceptance: atmosphere density, drag (apoapsis loss, terminal velocity),
// parachute descent, reentry heating (unshielded burns / shielded survives),
// and the in-atmosphere time-warp clamp.
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
global.document = {
  getElementById: () => ({ getContext: () => ctx, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, set textContent(v) {} }),
};

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "aero", "kepler", "maneuver", "bodies", "systems", "parts", "assembly", "ship", "world", "game"].forEach((m) => load("js/" + m + ".js"));

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

// Raw (full-scale) Earth as a static body.
const E = { x: 0, y: 0, vx: 0, vy: 0, radius: 6.371e6, mu: 3.986004418e14, atmosphere: 1.4e5, rho0: 1.225 };

// --- 1) Density profile -------------------------------------------------------
ok(Math.abs(SG.Aero.density(E, 0) - 1.225) < 1e-9, "sea-level density = rho0");
ok(SG.Aero.density(E, 20e3) < SG.Aero.density(E, 5e3), "density decays with altitude");
ok(SG.Aero.density(E, 1.5e5) === 0, "vacuum above the atmosphere top");

// Helper: fly a ship state with gravity (+ optional drag/thrust) for `secs`.
function makeShip(defsList) {
  const ship = new SG.Ship(SG.Config, new SG.Assembly(SG.AssemblyBuild.stack(defsList)));
  ship.heat = 0;
  return ship;
}
function fly(ship, body, secs, opts) {
  const dt = 1 / 60;
  const steps = Math.round(secs / dt);
  let peak = { heat: 0, qNorm: 0 };
  for (let i = 0; i < steps; i++) {
    let ax = 0, ay = 0;
    if (opts.throttle && ship.assembly.hasFuel()) {
      const m = ship.assembly.mass();
      const a = (ship.assembly.thrust() * opts.throttle) / m;
      ax += Math.cos(ship.angle) * a; ay += Math.sin(ship.angle) * a;
      ship.assembly.drainFuel(ship.assembly.massFlow() * opts.throttle * dt);
    }
    if (opts.drag) {
      const out = SG.Aero.step(ship, body, dt);
      ax += out.ax; ay += out.ay;
      if (out.qNorm > peak.qNorm) peak.qNorm = out.qNorm;
      if (ship.heat > peak.heat) peak.heat = ship.heat;
      if (out.burning) { peak.burned = true; break; }
    }
    SG.Physics.integrate(ship, body, dt, { ax, ay });
    const alt = Math.hypot(ship.x - body.x, ship.y - body.y) - body.radius;
    if (alt <= 0) { peak.landedSpeed = Math.hypot(ship.vx, ship.vy); break; }
  }
  return peak;
}

// --- 2) Drag lowers apoapsis on ascent -----------------------------------------
{
  const mk = () => {
    const s = makeShip(["nose", "pod", "tankS", "engineS", "decoupler", "tankL", "tankL", "engineL"]);
    s.x = 0; s.y = -(E.radius + 10); s.vx = 0; s.vy = 0; s.angle = -Math.PI / 2; // straight up
    return s;
  };
  const vac = mk(); fly(vac, E, 40, { throttle: 1, drag: false });
  const atm = mk(); fly(atm, E, 40, { throttle: 1, drag: true });
  const apVac = SG.Physics.orbit(vac, E).apoapsis;
  const apAtm = SG.Physics.orbit(atm, E).apoapsis;
  ok(apAtm < apVac, `drag lowers ascent apoapsis (${Math.round(apAtm / 1000)} km < ${Math.round(apVac / 1000)} km)`);
  ok(atm.heat < 1, `normal ascent does not overheat (heat ${atm.heat.toFixed(2)})`);
}

// --- 3) Terminal velocity + parachute -------------------------------------------
{
  const pod = makeShip(["pod"]);
  pod.x = 0; pod.y = -(E.radius + 3000); pod.vx = 0; pod.vy = 0;
  const res = fly(pod, E, 300, { drag: true });
  ok(res.landedSpeed !== undefined && res.landedSpeed > 30 && res.landedSpeed < 120,
     `bare pod falls at a lethal terminal velocity (${res.landedSpeed ? res.landedSpeed.toFixed(0) : "?"} m/s)`);

  const soft = makeShip(["chute", "pod"]);
  soft.x = 0; soft.y = -(E.radius + 3000); soft.vx = 0; soft.vy = 0;
  soft.chuteDeployed = true;
  const res2 = fly(soft, E, 600, { drag: true });
  ok(res2.landedSpeed !== undefined && res2.landedSpeed < SG.Config.landingSpeed,
     `parachute caps descent below landing speed (${res2.landedSpeed ? res2.landedSpeed.toFixed(1) : "?"} m/s < ${SG.Config.landingSpeed})`);
}

// --- 4) Reentry: unshielded burns up, shielded survives --------------------------
{
  const entry = (defsList) => {
    const s = makeShip(defsList);
    const alt0 = 7e4;
    s.x = 0; s.y = -(E.radius + alt0);
    s.vx = 7800; s.vy = 150;                     // orbital speed, descending
    return fly(s, E, 400, { drag: true });
  };
  const bare = entry(["pod"]);
  ok(bare.burned === true, `unshielded reentry at 7.8 km/s burns up (peak heat ${bare.heat.toFixed(2)})`);

  const shielded = entry(["chute", "pod", "shield"]);
  ok(!shielded.burned, `heat-shielded capsule survives the same entry (peak heat ${shielded.heat.toFixed(2)})`);
}

// --- 5) Chute refuses to open at high speed --------------------------------------
{
  const s = makeShip(["chute", "pod"]);
  ok(s.deployChute(500) === "fast" && !s.chuteDeployed, "chute won't open above the rip speed");
  ok(s.deployChute(200) === "ok" && s.chuteDeployed, "chute opens once slow enough");
}

// --- 6) Time warp clamps inside an atmosphere ------------------------------------
{
  const game = new SG.Game(document.getElementById("game"));
  const home = game.world.system.homeBody();
  game.world.update(game.simTime);
  // Park the ship deep in the home atmosphere, then ask for max warp.
  game.ship.x = home.x; game.ship.y = home.y - (home.radius + home.atmosphere * 0.3);
  game.ship.vx = home.vx + 100; game.ship.vy = home.vy;
  game.landed = false;
  game.warpIndex = SG.Config.warpLevels.length - 1;
  game._advanceWorld(0.016);
  ok(SG.Config.warpLevels[game.warpIndex] <= SG.Config.atmoWarpMax,
     `warp clamps to ≤${SG.Config.atmoWarpMax}x inside the atmosphere (now ${SG.Config.warpLevels[game.warpIndex]}x)`);
}

console.log(`\n${failures === 0 ? "AERO CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
