// Verify craft sprite scales with zoom (no clamp) while map clamps to a marker,
// and that the builder's per-stage dv sums to the assembly's total dv.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.window = global;

// Recording 2D context: capture the extent of drawn geometry so we can measure
// the rendered ship size in pixels.
function makeRecCtx() {
  const st = { maxExtent: 0 };
  const track = (x, y) => { st.maxExtent = Math.max(st.maxExtent, Math.abs(x), Math.abs(y)); };
  const grad = { addColorStop() {} };
  return {
    st,
    canvas: {}, save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, clip() {}, setLineDash() {}, arc() {}, fillText() {}, strokeRect() {}, setTransform() {}, clearRect() {},
    translate(x, y) { this._tx = x; this._ty = y; },   // ship translates to screen COM, then draws local coords
    rotate() {}, scale() {},
    createLinearGradient() { return grad; }, createRadialGradient() { return grad; },
    moveTo(x, y) { track(x - (this._tx || 0), y - (this._ty || 0)); },
    lineTo(x, y) { track(x - (this._tx || 0), y - (this._ty || 0)); },
    fillRect(x, y, w, h) { track(x, y); track(x + w, y + h); },   // local coords (post-translate)
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {}, set font(v) {}, set textAlign(v) {},
  };
}

global.addEventListener = () => {};
global.devicePixelRatio = 1; global.innerWidth = 1280; global.innerHeight = 720;
global.requestAnimationFrame = () => 0;
let stored = {};
global.localStorage = { getItem: (k) => stored[k] || null, setItem: (k, v) => (stored[k] = v), removeItem: (k) => delete stored[k] };
global.document = { getElementById: () => ({ getContext: () => makeRecCtx(), style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, set textContent(v) {} }) };
function load(f) { new Function("window", fs.readFileSync(path.join(ROOT, f), "utf8"))(global); }
["input", "camera", "physics", "kepler", "bodies", "systems", "parts", "assembly", "ship", "world", "game", "shipbuilder", "systembuilder"].forEach((m) => load("js/" + m + ".js"));
const SG = global.SG;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "PASS ✅" : "FAIL ❌"}  ${m}`); if (!c) failures++; };

const ship = new SG.Ship(SG.Config, new SG.Assembly(SG.Ships.default()));
const cam = new SG.Camera(); cam.setViewport(1280, 720);
ship.x = 0; ship.y = 0;

function drawExtent(zoom, minPx) {
  cam.zoom = zoom;
  const ctx = makeRecCtx();
  ship.draw(ctx, cam, 0.016, minPx);
  return ctx.st.maxExtent;
}

// 1) Craft view (no minPx): doubling zoom ~doubles the on-screen size.
const e1 = drawExtent(10, undefined);
const e2 = drawExtent(20, undefined);
ok(e1 > 0 && Math.abs(e2 / e1 - 2) < 0.05, `craft sprite scales with zoom (x10 -> ${e1.toFixed(0)}px, x20 -> ${e2.toFixed(0)}px)`);

// 2) Craft view zoomed out: sprite shrinks (small when zoomed out).
const eOut = drawExtent(0.5, undefined);
ok(eOut < e1, `craft sprite shrinks when zoomed out (${eOut.toFixed(2)}px at x0.5)`);

// 3) Map view (minPx clamp): at tiny zoom the marker holds a minimum size.
const eMapTiny = drawExtent(1e-6, SG.Config.minShipPx);
const eMapTiny2 = drawExtent(1e-9, SG.Config.minShipPx);
ok(Math.abs(eMapTiny - eMapTiny2) < 1e-6 && eMapTiny > 5, `map marker stays fixed size at any zoom (${eMapTiny.toFixed(1)}px)`);

// 4) Craft at the same tiny zoom would be sub-pixel (proves the clamp matters).
const eCraftTiny = drawExtent(1e-6, undefined);
ok(eCraftTiny < eMapTiny, "craft sprite would be sub-pixel where the map marker stays visible");

// 5) Builder staging: sum of per-stage dv equals the assembly total dv.
{
  const root = document.getElementById("shipbuilder");
  const game = new SG.Game(document.getElementById("game"));
  const sb = new SG.ShipBuilder(root, game.canvas);
  sb.defs = SG.Ships.default();
  const a = new SG.Assembly(sb.defs);
  const stats = a.stageStats();
  const sum = stats.reduce((s, st) => s + st.dv, 0);
  ok(Math.abs(sum - a.deltaV()) < 1e-6, `per-stage dv sums to total (${Math.round(sum)} = ${Math.round(a.deltaV())})`);
  ok(stats.length === 2, `stageStats shows ${stats.length} stages for the stock rocket`);
}

console.log(`\n${failures === 0 ? "SCALE/STAGING CHECKS PASSED ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
