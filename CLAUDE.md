# StageIO — project guide

KSP-inspired orbital sandbox io game. Vanilla JS + Canvas, **no build step, no
dependencies** — classic `<script>` tags sharing one global namespace `SG`.
Runs from `file://` or any static host.

- **Live:** https://cranberrygingerale.github.io/StageIO/ (GitHub Pages, legacy
  build from `main` root — **`git push` = deploy**)
- **Repo:** https://github.com/cranberrygingerale/StageIO
- **Roadmap:** see `ROADMAP.md` (milestones M0–M7; M0 done)

## Commands
- `npm test` — runs every `tests/verify_*.js` headlessly in Node (no browser
  needed). Keep it green; every feature lands with checks.
- `npm start` — zero-dependency static dev server (`tools/serve.js`, :8080).
- No linter/formatter configured. Match existing style (2-space, semicolons,
  `//` comments explaining *why*).

## Game loop
**MENU → BUILD → FLY.** `js/menu.js` shows difficulty cards at boot; picking
one calls `game.applyDifficulty(preset)` then opens the ship builder; Launch
puts the craft on the pad. Esc walks ship-builder → system-builder → menu ⇄
flight. Flight HUD/legend are CSS-hidden unless `game.uiMode === "flight"`
(`body.no-flight-ui`, set via `game.setUiMode`).

## Architecture (load order matters — see index.html)
| File | Owns |
|---|---|
| `js/input.js` | Key → logical action mapping; held-set + rising-edge presses |
| `js/camera.js` | World↔screen transforms, zoom |
| `js/physics.js` | Gravity, symplectic Euler `integrate`, orbit elements for HUD, `selfTest()` |
| `js/kepler.js` | Analytic Kepler: elements/propagate/sampleEllipse/stateAtNu (rails warp, trajectory) |
| `js/bodies.js` | `SG.Body`, `SG.SolarSystem` (on-rails motion, SOI `dominantBody`) |
| `js/systems.js` | Real solar-system defs, `buildSystem`, **`scaleSystem`**, `SystemStore` (+save-scale) |
| `js/parts.js` | Part catalog, **`Parts.effective`** (parametric stats), **`SG.PartRender`** (shared renderer) |
| `js/assembly.js` | `SG.Assembly`: mass/thrust/Δv/staging/**stageStats**, node snapping, `SG.Ships`, `ShipStore` |
| `js/ship.js` | Flight state + controls (throttle/engine), renders via PartRender |
| `js/world.js` | Starfield, orbit paths, body rendering (craft detail vs map markers), SOI rings |
| `js/game.js` | `SG.Config`, game loop (fixed substeps + rails warp), views, HUD, difficulty |
| `js/shipbuilder.js` | VAB: palette, node-snap placement, resize sliders, staging panel, launch |
| `js/systembuilder.js` | Planet/system editor (B key), JSON import/export |
| `js/menu.js` | `SG.Difficulty` presets + start menu |

Singletons wired on DOMContentLoaded: `SG.game`, `SG.shipBuilder`,
`SG.builder`, `SG.menu` (registration order = script order).

## Core models — don't break these invariants
- **Units are SI** (m, kg, N, m/s). The real solar system at full scale.
- **Difficulty = world scale `s`** (`SG.scaleSystem`): lengths ×s, **mu ×s²**
  → surface gravity constant, orbital speed ×√s. Explorer 0.1 / Advanced 0.25
  / Realistic 1. `scaleSystem(defs, 1/s)` exactly inverts; `SystemStore`
  records its save-scale so difficulty switches never double-scale.
- **Patched conics:** ship feels ONE body's gravity — `system.dominantBody()`
  (deepest SOI containing the point). Bodies move analytically on circular
  rails. HUD orbit info is relative to the dominant body (subtract body vel).
- **Time warp:** numeric integration ≤ `physicsWarpMax` (100×); above that the
  ship is propagated analytically via `SG.Kepler` (rails) — only valid on
  bound orbits; thrusting forces warp 1×.
- **Camera SNAPS to the ship in craft view** — never ease/lerp it: the ship
  moves ~30 km/s in the heliocentric frame, so a lagging camera puts the ship
  thousands of pixels off-screen at close zoom. (This was a real bug.)
- **Parametric parts:** placed parts carry `sx`/`sy` (defaults 1). All stats
  flow through `Parts.effective`: tanks/structure mass&fuel ∝ sx²·sy;
  engines thrust&mass ∝ sx² (UI locks engines uniform → constant TWR).
  Never read `type.dryMass/fuel/thrust/w/h` directly for a *placed* part —
  use `assembly.eff(p)`.
- **Staging is fuel-scoped:** `stageGroups()` splits parts bottom-up at each
  decoupler; **only the active (index 0) stage's engines fire and only its
  tanks drain**. Dry stage → thrust 0 → G (`ship.stage()`) jettisons it.
  `stageStats()` (current-fuel Tsiolkovsky per stage) is the single source of
  truth for Δv — builder panel and flight HUD both use it; `deltaV()` is its
  sum, so in flight it means "Δv remaining".
- Ship physics point = assembly centre of mass; pad placement uses
  `assembly.bottomOffset()`.

## Testing pattern
Harnesses in `tests/` load the real sources with
`new Function("window", src)(global)` against small DOM/canvas mocks
(`global.window = global` because browser `window` IS the global; a Proxy
no-op 2D context; `getElementById` stub). They construct the real `SG.Game`
and drive `_frame(t)` with fake timestamps. When adding DOM access to game
code, guard it (`document.body && ...`) or extend the mocks. New feature ⇒
add checks to an existing suite or a new `tests/verify_<name>.js` (runner
auto-discovers).

## Gotchas
- **No ES modules** — Chrome blocks them on `file://`. Keep classic scripts +
  `SG` namespace.
- `Date.now()` is fine in-game but sim time is `game.simTime` (seconds),
  advanced by warp — never wall-clock.
- localStorage keys: `stageio.ship.v1`, `stageio.system.v1`,
  `stageio.system.scale.v1`, `stageio.difficulty.v1`.
- The one-time GitHub setup used `gh` CLI auth as **cranberrygingerale**;
  local git identity is machine-global, not project-specific.
- Rendering: craft view draws the ship at TRUE world scale; map view passes
  `minShipPx` so it stays a visible marker. Keep that distinction.

## Where we are / what's next
Done through **M0 + game-loop work**: menu/difficulty, parametric builder,
stage-scoped fuel + per-stage HUD. Next per `ROADMAP.md`: **M1 — atmosphere,
drag, reentry heating, parachutes, sound/particles**; then M2 maneuver nodes.
