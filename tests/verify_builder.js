// Verify the spacecraft construction system against the real source files.
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
let stored = {};
global.localStorage = { getItem: (k) => stored[k] || null, setItem: (k, v) => (stored[k] = v), removeItem: (k) => delete stored[k] };
global.document = {
  getElementById: () => ({ getContext: () => ctx, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, set textContent(v) {} }),
};

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "kepler", "bodies", "systems", "parts", "assembly", "ship", "world", "game", "shipbuilder", "systembuilder"].forEach((m) => load("js/" + m + ".js"));

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

// 1) Default ship assembles with correct aggregate mass.
const a = new SG.Assembly(SG.Ships.default());
const expectDry = 100 + 800 + 250 + 300 + 50 + 500 + 500 + 1500; // nose,pod,tankS,engS,dec,tankL,tankL,engL
const expectFuel = 2250 + 4500 + 4500;
ok(Math.abs(a.dryMass() - expectDry) < 1e-6, `dry mass sums parts (${a.dryMass()} kg)`);
ok(Math.abs(a.fuelMass() - expectFuel) < 1e-6, `fuel mass sums tanks (${a.fuelMass()} kg)`);
ok(Math.abs(a.mass() - (expectDry + expectFuel)) < 1e-6, "total mass = dry + fuel");

// 2) Thrust is STAGE-SCOPED: only the active (lowest) stage's engine fires.
ok(a.thrust() === 400000, `thrust = active stage's engine only (${a.thrust()} N)`);
const gE = 3.986e14 / (6.371e6 * 6.371e6); // Earth-ish
ok(a.twr(gE) > 1, `TWR at Earth surface > 1 (${a.twr(gE).toFixed(2)})`);

// 3) Two stages detected (one decoupler), staged dv positive and larger than
//    a single-stage Tsiolkovsky of the whole stack (staging helps).
ok(a.stageCount() === 2, `default has 2 stages (${a.stageCount()})`);
const dv = a.deltaV();
const veAvg = a.thrust() / a.massFlow();
const singleStageDv = veAvg * Math.log(a.mass() / a.dryMass());
ok(dv > 0 && dv > singleStageDv, `staged dv (${Math.round(dv)}) beats single-stage (${Math.round(singleStageDv)})`);

// 4) Burning fuel lowers mass and raises acceleration (rocket behaviour).
{
  const ship = new SG.Ship(SG.Config, new SG.Assembly(SG.Ships.default()));
  ship.resetToPad({ x: 0, y: 0, radius: 6.371e6, mu: 3.986e14, vx: 0, vy: 0 });
  ship.engineOn = true; ship.setThrottle(1);
  const m0 = ship.mass();
  const acc0 = Math.hypot(...Object.values(ship.control({ isDown: () => false }, 0.001)));
  for (let i = 0; i < 400; i++) ship.control({ isDown: () => false }, 0.05); // burn ~20 s (fuel lasts ~79 s)
  const m1 = ship.mass();
  const acc1 = Math.hypot(...Object.values(ship.control({ isDown: () => false }, 0.001)));
  ok(m1 < m0, `mass drops as fuel burns (${(m0/1000).toFixed(1)} t -> ${(m1/1000).toFixed(1)} t)`);
  ok(acc1 > acc0, `acceleration rises as mass drops (${acc0.toFixed(2)} -> ${acc1.toFixed(2)} m/s^2)`);

  // 4b) Per-stage fuel: the pad burn drained ONLY the lower stage's tanks —
  // the upper stage's tankS must still be full.
  const tankS = ship.assembly.parts.find((p) => p.id === "tankS");
  ok(Math.abs(tankS.fuel - 2250) < 1e-6, `upper-stage tank untouched during stage-1 burn (${tankS.fuel} kg)`);

  // 4c) Burn stage 1 dry: thrust cuts to zero (engines starve, don't cross-feed).
  for (let i = 0; i < 2000 && ship.assembly.hasFuel(); i++) ship.control({ isDown: () => false }, 0.05);
  ok(ship.assembly.thrust() === 0 && !ship.isThrusting(), "dry stage => zero thrust until staged");

  // 4d) Stage (G): lower stage drops, upper engine lights with its own full tank.
  ship.stage();
  ok(ship.assembly.thrust() === 60000 && ship.assembly.activeFuel() === 2250,
     `after staging, upper engine fires on its own fuel (${ship.assembly.thrust()} N, ${ship.assembly.activeFuel()} kg)`);
}

// 5) Node snapping: a tank snaps flush under the pod's bottom node.
{
  const pod = SG.Parts.get("pod");
  const defs = [{ id: "pod", x: 0, y: 0 }];
  const tankT = SG.Parts.get("tankS");
  // Cursor just below the pod; expect snap so tank.top meets pod.bottom.
  const snap = SG.AssemblyBuild.snap(defs, tankT, 0.1, pod.h / 2 + 0.2, 3, null);
  const expectedY = pod.h / 2 + tankT.h / 2; // tank centre
  ok(snap && Math.abs(snap.x) < 1e-6 && Math.abs(snap.y - expectedY) < 1e-6,
     `tank snaps flush under pod (y=${snap ? snap.y.toFixed(2) : "null"}, expected ${expectedY.toFixed(2)})`);
}

// 6) Staging jettisons the lowest group and reduces mass/part count.
{
  const asm = new SG.Assembly(SG.Ships.default());
  const before = asm.parts.length, m0 = asm.mass();
  const removed = asm.jettisonStage();
  ok(removed && asm.parts.length < before && asm.mass() < m0,
     `jettisonStage drops lower stage (${before} -> ${asm.parts.length} parts, removed ${removed.length})`);
  ok(asm.hasPod(), "upper stage retains the command pod after staging");
}

// 7) Full launch flow through the game + a rendered build frame.
{
  const game = new SG.Game(document.getElementById("game"));
  game.buildMode = true;
  const design = SG.AssemblyBuild.stack(["pod", "tankL", "engineL"]);
  let threw = null;
  try {
    game.launchShip(design);            // installs ship, resets to pad
  } catch (e) { threw = e; }
  ok(!threw && game.ship.assembly.parts.length === 3 && !game.buildMode,
     "launchShip installs the design on the pad" + (threw ? " — " + threw.message : ""));
  // Ship should sit on the home surface (landed) after reset.
  const home = game.world.system.homeBody();
  const alt = Math.hypot(game.ship.x - home.x, game.ship.y - home.y) - home.radius;
  ok(alt >= -1 && alt < home.radius, `ship starts on the pad (alt ${alt.toFixed(1)} m)`);
}

console.log(`\n${failures === 0 ? "BUILDER CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
