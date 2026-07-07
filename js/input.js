// SG.Input — tracks held keyboard keys and wheel deltas.
// Deliberately dumb: game logic asks "is this key down?" each frame.
window.SG = window.SG || {};

SG.Input = (function () {
  const held = new Set();      // normalized key names currently down
  let pressed = [];            // discrete presses (rising edge) since last consume
  let wheelDelta = 0;          // accumulated wheel movement, consumed by game

  // Map physical keys to logical actions so both WASD and arrows work.
  function normalize(e) {
    switch (e.code) {
      case "KeyA":
      case "ArrowLeft":  return "left";
      case "KeyD":
      case "ArrowRight": return "right";
      // --- Engine + throttle (KSP-style) ---
      case "KeyW":
      case "ArrowUp":
      case "Space":      return "engineToggle";  // discrete: ignite / shut down
      case "ShiftLeft":
      case "ShiftRight": return "throttleUp";     // held: increase power
      case "ControlLeft":
      case "ControlRight": return "throttleDown"; // held: decrease power
      case "KeyZ":       return "throttleMax";    // full throttle
      case "KeyX":       return "throttleZero";   // cut throttle
      case "KeyG":       return "stage";          // jettison the lowest stage
      // --- View / camera / time ---
      case "KeyM":       return "toggleMap";
      case "BracketRight": return "focusNext";   // map: cycle focus target
      case "BracketLeft":  return "focusPrev";
      case "KeyV":       return "toggleShipBuilder";
      case "KeyR":       return "reset";
      case "Equal":
      case "NumpadAdd":  return "zoomIn";
      case "Minus":
      case "NumpadSubtract": return "zoomOut";
      case "Period":     return "warpUp";
      case "Comma":      return "warpDown";
      case "KeyB":       return "toggleBuilder";
      case "Escape":     return "closeBuilder";
      case "KeyF":       return "frameSystem";
      default:           return null;
    }
  }

  function init() {
    window.addEventListener("keydown", (e) => {
      const action = normalize(e);
      if (action) {
        // Rising edge only (ignore OS key-repeat) -> discrete press event.
        if (!held.has(action)) pressed.push(action);
        held.add(action);
        // Stop arrows/space from scrolling the page.
        if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
      }
    });

    window.addEventListener("keyup", (e) => {
      const action = normalize(e);
      if (action) held.delete(action);
    });

    window.addEventListener(
      "wheel",
      (e) => {
        wheelDelta += e.deltaY;
        e.preventDefault();
      },
      { passive: false }
    );

    // Release everything if the window loses focus (avoids "stuck thrust").
    window.addEventListener("blur", () => held.clear());
  }

  return {
    init,
    isDown: (action) => held.has(action),
    // Discrete presses since the last call (rising edges), then clears them.
    consumePressed: () => {
      const p = pressed;
      pressed = [];
      return p;
    },
    // Returns accumulated wheel delta and resets it (edge-consumed each frame).
    consumeWheel: () => {
      const d = wheelDelta;
      wheelDelta = 0;
      return d;
    },
  };
})();
