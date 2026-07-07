# StageIO — Development Roadmap

An io-deliverable, KSP-inspired orbital sandbox: build rockets from parts, fly
them through a real-scale solar system with patched-conic physics, and (one
day) share that space with other players.

**Identity:** single-player sandbox + mission/career progression.
**Distribution:** publicly hosted web game (static, no build step).
**Multiplayer "io" layer:** late-stage stretch goal.

---

## Current state (v0.4)

| Area | Status |
|---|---|
| Physics | Patched conics/SOI, symplectic Euler, analytic Kepler rails, real SI scale |
| Time warp | 1×–1,000,000× (numeric ≤100×, rails above), engine gates warp |
| Solar system | Sun + 8 planets + 9 moons on rails; system builder edits/saves JSON |
| Ship | Part-based, throttle/engine, staging (G), thrust/mass physics |
| Builder | Stack snapping, live mass/TWR/staged-Δv, stage list, save/launch |
| Views | Craft (true-scale, snap-follow) / Map (markers, Ap/Pe, SOI, focus cycling) |
| Testing | Headless Node harnesses in `tests/` (`npm test`) |

Known debt: no sound/particles; planets don't rotate; rotation is instant
(no torque model).

---

## Milestone 0 — Foundations ✅ (this commit)
- Git repository, `.gitignore`, initial commit.
- Test harnesses live in `tests/`, run via `npm test` (`tests/run-all.js`).
- `npm start` serves the game locally (zero-dependency `tools/serve.js`).
- Part rendering consolidated into `SG.PartRender` (one renderer for builder
  and flight).
- **Next:** publish to itch.io / GitHub Pages / Vercel; every milestone ends
  with a deployed version.

## Milestone 1 — Flight Feel & Atmosphere ✅
- ✅ Exponential atmosphere density per body (`rho0` + scale height, js/aero.js);
  drag from cross-section (+nose streamlining); terminal velocity.
- ✅ Reentry heating (scale-free flux `(ρ/ρ0)·(v/vOrb)³`), burn-up, plasma
  particles + glow, camera shake; warp clamped ≤10× in atmosphere.
- ✅ New parts: parachute (P to deploy, rips >350 m/s), heat shield, fin ring.
  (Landing legs deferred to M3 — they want radial attachment.)
- ✅ Effects: engine exhaust, explosions, staging puff; synthesized WebAudio
  (engine rumble, wind roar, thunk, explosion, chute pop).
- ✅ Torque-based rotation: angular velocity + mass-scaled authority, fins help,
  SAS-style damping.

*Acceptance met (tests/verify_aero.js):* unshielded 7.8 km/s reentry burns up
(heat 1.00); shielded capsule survives (0.10) and lands under parachute at
~7 m/s; drag lowers ascent apoapsis; normal ascent never overheats.

## Milestone 2 — Navigation: Maneuver Nodes & Encounters
- Maneuver nodes on the map (prograde/retrograde/radial handles), burn timer
  + Δv readout on HUD.
- Trajectory prediction chained across SOI transitions (see the Moon
  encounter before you burn); closest-approach markers vs a target.
- Warp-to-node / warp-to-SOI-edge; orbit info panel.

*Acceptance:* plan and execute a Moon flyby entirely from map view with one
node. Harness: predicted post-burn Ap/Pe matches a simulated burn.

## Milestone 3 — Builder 2.0
- Radial attachment + mirror symmetry (side boosters!); part rotation;
  fairings.
- Expanded catalog: RCS, docking port, solar panel, battery, probe core,
  structural parts, vacuum engines (Isp matters).
- Named craft library; craft JSON export/import (shareable).
- Per-stage fuel flow; undo/redo; center-of-thrust vs center-of-mass warning.

*Acceptance:* two-booster symmetric rocket stages correctly; staged Δv
verifies; craft round-trips export/import.

## Milestone 4 — Missions & Progression
- JSON-driven missions: objectives (altitude, orbit params, land on X,
  return, dock), rewards, prerequisites.
- Campaign: sounding rocket → orbit → Moon flyby → Moon landing → return →
  Mars. Part unlocks in career; sandbox toggle keeps everything open.
- Mission tracker UI, completion toasts, persistent progress, contracts-lite
  procedural goals.

*Acceptance:* fresh save plays the sounding-rocket → Moon-landing chain;
unlock gates enforce; harness validates objective evaluation.

## Milestone 5 — Orbital Operations
- Multi-craft persistence (leave craft on rails, switch vessels).
- RCS translation mode; rendezvous tools (target marker, relative velocity,
  closest approach).
- Docking ports with soft-capture; assemblies merge on dock, split on undock.
- Station-assembly missions.

*Acceptance:* launch twice, rendezvous, dock, undock — combined craft physics
correct. Harness: merge/split conserves parts and fuel.

## Milestone 6 — Resources & Long-term Play
- Electricity (solar + battery, planet-shadow line-of-sight); probes need
  power.
- Fuel transfer between docked craft; mining/ISRU (drill + converter);
  life-support-lite consumables; surface colony modules.

*Acceptance:* Moon fuel-depot loop — mine → refine → transfer → return to
Earth on locally-produced fuel.

## Milestone 7 — Multiplayer "io" Layer (stretch)
- **A. Ghosts:** WebSocket server broadcasts craft states; others visible
  read-only; shared world time. Time-warp conflict solved with per-player
  time bubbles that re-sync on interaction (KSP-multiplayer approach).
- **B. Presence:** shared launch sites, chat, spectate, leaderboards.
- **C. Interaction:** cross-player docking, shared stations, race/economy
  modes — only if A/B prove fun.

## Cross-cutting (every milestone)
- Every feature lands with harness checks; `npm test` stays green.
- Performance: canvas layering/culling as particles and part counts grow.
- UX: first-run tutorial, control remapping, settings panel.
- Content polish: part art, per-body palettes, skybox.

## Sequencing rationale
M1 before M2 (aero changes what trajectory prediction must model). M3 before
M4 (missions gate parts, so the catalog must be rich first). M5 needs M2's
rendezvous tools and M3's docking port. M6 builds on M5. Multiplayer last —
by then the sim is stable and its hardest problem (time warp) has a known
design answer.
