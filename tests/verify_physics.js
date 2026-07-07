// Core physics verification: integrator stability, gravity, real-scale sanity.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.window = global;
global.addEventListener = () => {};
global.devicePixelRatio = 1;

function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["js/physics.js", "js/kepler.js", "js/bodies.js", "js/systems.js", "js/game.js"].forEach(load);

const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

// 1) Built-in numerical self-test: circular orbit holds altitude.
ok(SG.Physics.selfTest(), "circular-orbit integrator stability (selfTest)");

// 2) Real-scale sanity from the stock system's Earth.
const earthDef = SG.Systems.default.find((d) => d.name === "Earth");
ok(!!earthDef, "stock system defines Earth");
const earth = { x: 0, y: 0, mu: earthDef.mu, radius: earthDef.radius };
const g = earth.mu / (earth.radius * earth.radius);
ok(g > 9.5 && g < 10.1, `Earth surface gravity ≈ 9.8 (${g.toFixed(2)} m/s²)`);
ok(SG.Config.thrustAccel > g * 1.5, `stock thrust beats surface gravity (${SG.Config.thrustAccel} vs g=${g.toFixed(1)})`);

// 3) LEO circular speed ≈ 7.8 km/s at 200 km.
const vLeo = SG.Physics.circularSpeed(earth.radius + 2e5, earth);
ok(vLeo > 7000 && vLeo < 8500, `LEO circular speed sane (${Math.round(vLeo)} m/s)`);

// 4) A dropped ship falls under gravity.
{
  const s = { x: 0, y: -(earth.radius + 3000), vx: 0, vy: 0 };
  const a0 = Math.hypot(s.x, s.y) - earth.radius;
  for (let i = 0; i < 240; i++) SG.Physics.integrate(s, earth, SG.Config.fixedDt, null);
  const a1 = Math.hypot(s.x, s.y) - earth.radius;
  ok(a1 < a0, `dropped ship falls (${a0.toFixed(0)} m -> ${a1.toFixed(0)} m)`);
}

// 5) A 500 m free-fall exceeds the landing-speed threshold (crash, not landing).
{
  const s = { x: 0, y: -(earth.radius + 500), vx: 0, vy: 0 };
  let impact = 0;
  for (let i = 0; i < 20000; i++) {
    SG.Physics.integrate(s, earth, SG.Config.fixedDt, null);
    if (Math.hypot(s.x, s.y) < earth.radius) { impact = Math.hypot(s.vx, s.vy); break; }
  }
  ok(impact > SG.Config.landingSpeed, `500 m free-fall is a crash (${impact.toFixed(1)} m/s > ${SG.Config.landingSpeed})`);
}

console.log(`\n${failures === 0 ? "PHYSICS CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
