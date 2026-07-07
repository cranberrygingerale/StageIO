// SG.Parts — the part catalog for the ship builder.
//
// Every value is real-ish SI: metres, kilograms, newtons, m/s exhaust velocity.
// A part type is pure data; SG.Assembly instantiates placed copies and derives
// the ship's flight characteristics (mass, thrust, TWR, delta-v) from them.
//
// Attachment nodes are implied by hasTop / hasBottom:
//   top node    = (0, -h/2)   bottom node = (0, +h/2)   in part-local metres.
// A part's BOTTOM node stacks onto another part's TOP node (and vice-versa).
window.SG = window.SG || {};

SG.Parts = {
  // Categories: pod | tank | engine | nose | decoupler
  catalog: {
    pod: {
      id: "pod", name: "Command Pod", category: "pod",
      w: 2.0, h: 2.2, dryMass: 800,
      color: "#c7d2dc", hasTop: true, hasBottom: true,
      desc: "Cockpit + control. Every ship needs one.",
    },
    nose: {
      id: "nose", name: "Nose Cone", category: "nose",
      w: 2.0, h: 1.6, dryMass: 100,
      color: "#b9c4cf", hasTop: false, hasBottom: true,
      desc: "Aerodynamic tip.",
    },
    tankS: {
      id: "tankS", name: "Fuel Tank (S)", category: "tank",
      w: 2.0, h: 3.0, dryMass: 250, fuel: 2250,
      color: "#8f9aa6", hasTop: true, hasBottom: true,
      desc: "2.25 t of propellant.",
    },
    tankL: {
      id: "tankL", name: "Fuel Tank (L)", category: "tank",
      w: 3.0, h: 4.0, dryMass: 500, fuel: 4500,
      color: "#828d99", hasTop: true, hasBottom: true,
      desc: "4.5 t of propellant.",
    },
    engineS: {
      id: "engineS", name: "Engine (S)", category: "engine",
      w: 2.0, h: 1.8, dryMass: 300, thrust: 60000, ve: 3400,
      color: "#6c7682", hasTop: true, hasBottom: true,
      desc: "60 kN, efficient upper-stage engine.",
    },
    engineL: {
      id: "engineL", name: "Engine (L)", category: "engine",
      w: 3.0, h: 2.6, dryMass: 1500, thrust: 400000, ve: 3200,
      color: "#5c6672", hasTop: true, hasBottom: true,
      desc: "400 kN booster engine.",
    },
    decoupler: {
      id: "decoupler", name: "Decoupler", category: "decoupler",
      w: 2.2, h: 0.6, dryMass: 50,
      color: "#caa14a", hasTop: true, hasBottom: true,
      desc: "Stage separator — jettisons everything below it.",
    },
  },

  get(id) { return this.catalog[id]; },
  list() { return Object.values(this.catalog); },

  // Local attachment nodes for a part type.
  nodes(type) {
    const n = [];
    if (type.hasTop) n.push({ x: 0, y: -type.h / 2, kind: "top" });
    if (type.hasBottom) n.push({ x: 0, y: type.h / 2, kind: "bottom" });
    return n;
  },
};

// --- Shared part renderer (builder AND flight use this, so they can't drift) --
// Draws one part centred at (cx, cy) in screen px, `scale` px per metre.
// opts: { dead: tint red (crashed), flame: {throttle, phase} exhaust when firing }
SG.PartRender = {
  draw(ctx, t, cx, cy, scale, opts) {
    opts = opts || {};
    const w = t.w * scale, h = t.h * scale;
    const col = opts.dead ? "#7a3b3b" : t.color;
    ctx.save();
    ctx.translate(cx, cy);

    if (t.category === "engine") {
      // Exhaust flame first (under the bell), throttle-scaled with flicker.
      if (opts.flame) {
        const flicker = 0.6 + 0.4 * Math.abs(Math.sin(opts.flame.phase || 0));
        const fl = h * (0.6 + 2.0 * (opts.flame.throttle || 1)) * flicker;
        ctx.beginPath();
        ctx.moveTo(-w * 0.28, h / 2); ctx.lineTo(w * 0.28, h / 2); ctx.lineTo(0, h / 2 + fl);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, h / 2, 0, h / 2 + fl);
        g.addColorStop(0, "rgba(255,230,120,0.95)"); g.addColorStop(1, "rgba(255,80,30,0)");
        ctx.fillStyle = g; ctx.fill();
      }
      // Bell: trapezoid narrowing upward.
      ctx.beginPath();
      ctx.moveTo(-w * 0.3, -h / 2); ctx.lineTo(w * 0.3, -h / 2);
      ctx.lineTo(w * 0.5, h / 2); ctx.lineTo(-w * 0.5, h / 2);
      ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
    } else if (t.category === "nose") {
      ctx.beginPath();
      ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
    } else if (t.category === "pod") {
      // Capsule (trapezoid wider at bottom) with a window.
      ctx.beginPath();
      ctx.moveTo(-w * 0.32, -h / 2); ctx.lineTo(w * 0.32, -h / 2);
      ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
      ctx.fillStyle = "#3a78c2";
      ctx.beginPath(); ctx.arc(0, -h * 0.05, Math.max(1.2, w * 0.16), 0, Math.PI * 2); ctx.fill();
    } else if (t.category === "decoupler") {
      ctx.fillStyle = col;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(-w / 2, -h * 0.1, w, h * 0.2);
    } else {
      // Tank: body with fuel-band seams.
      ctx.fillStyle = col;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = Math.max(0.5, scale * 0.12);
      for (let i = 1; i < 3; i++) {
        const yy = -h / 2 + (h * i) / 3;
        ctx.beginPath(); ctx.moveTo(-w / 2, yy); ctx.lineTo(w / 2, yy); ctx.stroke();
      }
      ctx.lineWidth = Math.max(0.75, scale * 0.2);
      ctx.strokeStyle = "rgba(20,30,45,0.6)";
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }

    ctx.restore();
  },
};
