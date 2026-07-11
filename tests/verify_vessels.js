// Multiple vessels + vessel switching + jettisoned stages become drag-affected
// debris. Drives a real SG.Game against the mock canvas/DOM.
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

// Deterministic input: a queue of discrete presses + no wheel / no held keys.
let pressQ = [];
SG.Input.isDown = () => false;
SG.Input.consumePressed = () => pressQ.splice(0);
SG.Input.consumeWheel = () => 0;

const game = new SG.Game(document.getElementById("game"));
const home = game.world.system.homeBody();
game.world.update(game.simTime);

// Park the whole craft high in space (above the atmosphere) so nothing crashes
// or drags during the plumbing checks below.
function parkPrimary() {
  const s = game.primary;
  s.x = home.x + home.radius + home.atmosphere + 5e5;
  s.y = home.y;
  s.vx = home.vx; s.vy = home.vy;
  s.angle = 0; s.angVel = 0; s.alive = true; s.landed = false;
  s.dominant = home;
}
parkPrimary();

// --- 1) One vessel to start; the stock rocket has two stages -------------------
ok(game.vessels.length === 1 && game.ship === game.primary, "world starts with a single command vessel");
const startStages = game.ship.assembly.stageCount();
ok(startStages === 2, `stock rocket has ${startStages} stages`);

// --- 2) Staging (G) spawns an independent debris vessel ------------------------
const preParts = game.ship.assembly.parts.length;
pressQ = ["stage"];
game._handleDiscreteInput();
ok(game.vessels.length === 2, `staging spawns a debris vessel (now ${game.vessels.length})`);
const debris = game.vessels[1];
ok(debris instanceof SG.Ship && debris.debris === true && debris.isCraft === false,
   "the shed stage is a real vessel flagged as debris (not the command craft)");
ok(game.ship === game.primary && game.ship.assembly.stageCount() === 1,
   "you keep flying the command craft, now one stage lighter");
ok(game.ship.assembly.parts.length + debris.assembly.parts.length === preParts,
   "no parts vanish — the stack splits between craft and debris");

// --- 3) The debris separates with its own velocity -----------------------------
const relSep = Math.hypot(debris.vx - game.ship.vx, debris.vy - game.ship.vy);
ok(relSep > 1, `decoupler imparts a separation velocity (${relSep.toFixed(1)} m/s)`);
const d0 = Math.hypot(debris.x - game.ship.x, debris.y - game.ship.y);
// Coast both a moment in vacuum: the gap should open up.
game._numericAdvance(0.5);
const d1 = Math.hypot(debris.x - game.ship.x, debris.y - game.ship.y);
ok(d1 > d0, `the spent stage drifts away from the craft (${d0.toFixed(0)} m -> ${d1.toFixed(0)} m)`);

// --- 4) Vessel switching cycles which vessel you control -----------------------
ok(game.activeIndex === 0, "you begin controlling the command craft");
game.switchVessel(1);
ok(game.activeIndex === 1 && game.ship === debris, "[ ] switches control to the debris");
ok(game.dominant === debris.dominant, "the HUD's dominant body follows the active vessel");
game.switchVessel(1);
ok(game.activeIndex === 0 && game.ship === game.primary, "switching again wraps back to the command craft");

// --- 4b) Craft + map frames render with several vessels present ----------------
{
  let threw = null;
  try {
    game.viewMode = "craft"; game._frame(2000);
    game.viewMode = "map"; game.mapTarget = game.dominant; game._frame(2016);
    game.viewMode = "craft";
  } catch (e) { threw = e; }
  ok(!threw, "craft + map render a multi-vessel scene without throwing" + (threw ? " — " + threw.message : ""));
}

// --- 5) Drag forces act on the shed stage in an atmosphere ---------------------
{
  const vOrb = Math.sqrt(home.mu / home.radius);
  debris.x = home.x; debris.y = home.y - (home.radius + home.atmosphere * 0.15);
  debris.vx = 0.08 * vOrb; debris.vy = 0;      // gentle: drag acts, no burn-up
  debris.heat = 0; debris.alive = true; debris.landed = false;
  const dom = game.world.system.dominantBody(debris.x, debris.y);
  const rvx = debris.vx - dom.vx, rvy = debris.vy - dom.vy;
  const out = SG.Aero.step(debris, dom, 1 / 60);
  const along = out.ax * rvx + out.ay * rvy;   // <0 means it opposes motion
  ok(out.rho > 0 && along < 0, "drag decelerates the debris (force opposes its velocity)");
}

// --- 6) Debris crashing/burning is swept up — it does NOT relaunch the game ----
{
  debris.alive = false; debris.crashTimer = 2.0;   // past the poof window
  const primaryBefore = game.primary;
  game._cullVessels();
  ok(game.vessels.length === 1 && game.vessels[0] === game.primary && game.primary === primaryBefore,
     "spent debris is culled without disturbing the command craft");
}

// --- 7) The command craft dying triggers a relaunch ----------------------------
{
  game.primary.alive = false;
  game.primary.crashTimer = 2.0;                   // exceeds the 1.3s crash delay
  game._frame(999999);
  ok(game.primary.alive && game.vessels.length === 1 && game.ship === game.primary,
     "command craft death relaunches a fresh single vessel");
}

console.log(`\n${failures === 0 ? "VESSEL CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
