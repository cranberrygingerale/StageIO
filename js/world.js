// SG.World — owns the live SolarSystem and draws the background starfield, every
// celestial body, and each body's orbit path. Physics/SOI logic lives in
// bodies.js; this file is purely presentation + a thin wrapper.
window.SG = window.SG || {};

SG.World = class World {
  constructor(system) {
    this.system = system;             // SG.SolarSystem
    this._stars = this._makeStars(220);
  }

  update(t) {
    this.system.update(t);
  }

  // --- Starfield (screen-space parallax) ---
  _makeStars(n) {
    const stars = [];
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < n; i++) {
      stars.push({
        x: rand(), y: rand(),
        depth: 0.2 + rand() * 0.8,
        size: 0.5 + rand() * 1.5,
        b: 0.3 + rand() * 0.7,
      });
    }
    return stars;
  }

  drawStars(ctx, camera) {
    const w = camera.viewportW, h = camera.viewportH;
    ctx.save();
    for (const st of this._stars) {
      const ox = ((camera.x * st.depth * 0.05) % w + w) % w;
      const oy = ((camera.y * st.depth * 0.05) % h + h) % h;
      const px = (st.x * w - ox + w) % w;
      const py = (st.y * h - oy + h) % h;
      ctx.globalAlpha = st.b;
      ctx.fillStyle = "#cfe0ff";
      ctx.beginPath();
      ctx.arc(px, py, st.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- Orbit paths (faint circles around each parent) ---
  drawOrbits(ctx, camera) {
    ctx.save();
    ctx.setLineDash([3, 7]);
    ctx.lineWidth = 1;
    for (const b of this.system.bodies) {
      if (!b.parent || b.orbitRadius <= 0) continue;
      const c = camera.worldToScreen(b.parent.x, b.parent.y);
      const r = b.orbitRadius * camera.zoom;
      if (r < 4 || r > 60000) continue; // skip degenerate/huge screen circles
      ctx.beginPath();
      ctx.strokeStyle = "rgba(120,150,190,0.28)";
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // opts: { highlight, detail (surface texture), map (marker style) }
  drawBodies(ctx, camera, opts) {
    opts = opts || {};
    for (const b of this.system.bodies) this._drawBody(ctx, camera, b, opts);
  }

  // Dashed sphere-of-influence ring around a body (map view).
  drawSOI(ctx, camera, b) {
    if (!isFinite(b.soi)) return;
    const c = camera.worldToScreen(b.x, b.y);
    const r = b.soi * camera.zoom;
    if (r < 8 || r > 40000) return;
    ctx.save();
    ctx.setLineDash([2, 8]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(140,190,255,0.35)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawBody(ctx, camera, b, opts) {
    const highlight = b.name === opts.highlight;
    const c = camera.worldToScreen(b.x, b.y);
    const minR = opts.map ? 3 : 1.5;
    const rScreen = Math.max(minR, b.radius * camera.zoom);
    const atmScreen = (b.radius + b.atmosphere) * camera.zoom;

    // Atmosphere / corona halo.
    if (b.atmosphere > 0 && atmScreen > rScreen + 1) {
      const halo = ctx.createRadialGradient(c.x, c.y, rScreen, c.x, c.y, atmScreen);
      halo.addColorStop(0, this._rgba(b.color, 0.35));
      halo.addColorStop(1, this._rgba(b.color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(c.x, c.y, atmScreen, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body with a soft day/night gradient.
    const body = ctx.createRadialGradient(
      c.x - rScreen * 0.3, c.y - rScreen * 0.3, rScreen * 0.2,
      c.x, c.y, rScreen
    );
    body.addColorStop(0, this._lighten(b.color, 0.35));
    body.addColorStop(0.7, b.color);
    body.addColorStop(1, this._lighten(b.color, -0.45));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(c.x, c.y, rScreen, 0, Math.PI * 2);
    ctx.fill();

    // Procedural surface detail when we're close (craft view, big on screen).
    if (opts.detail && rScreen > 40) this._drawSurface(ctx, c, rScreen, b);

    ctx.lineWidth = highlight ? 2 : 1;
    ctx.strokeStyle = highlight ? "#ffffff" : this._rgba(this._lighten(b.color, 0.4), 0.5);
    ctx.beginPath();
    ctx.arc(c.x, c.y, rScreen, 0, Math.PI * 2);
    ctx.stroke();

    // Name label. In map view, show markers even when the disc is tiny.
    if (rScreen > (opts.map ? 2.5 : 6)) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#cfe0ff";
      ctx.font = "12px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(b.name, c.x, c.y - rScreen - 6);
      ctx.restore();
    }
  }

  // Deterministic craters/bands clipped to the body disc, for a sense of scale
  // and motion when flying close. Features are cached per body.
  _drawSurface(ctx, c, rScreen, b) {
    if (!b._features) b._features = this._makeFeatures(b);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x, c.y, rScreen, 0, Math.PI * 2);
    ctx.clip();
    for (const f of b._features) {
      const px = c.x + Math.cos(f.a) * f.d * rScreen;
      const py = c.y + Math.sin(f.a) * f.d * rScreen;
      ctx.beginPath();
      ctx.arc(px, py, f.s * rScreen, 0, Math.PI * 2);
      ctx.fillStyle = this._rgba(this._lighten(b.color, f.shade), 0.5);
      ctx.fill();
    }
    ctx.restore();
  }

  _makeFeatures(b) {
    // Seed a small PRNG from the body name so features are stable.
    let seed = 0;
    for (let i = 0; i < b.name.length; i++) seed = (seed * 31 + b.name.charCodeAt(i)) & 0x7fffffff;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const feats = [];
    const n = 14 + Math.floor(rand() * 12);
    for (let i = 0; i < n; i++) {
      feats.push({
        a: rand() * Math.PI * 2,
        d: rand() * 0.85,
        s: 0.05 + rand() * 0.18,
        shade: (rand() < 0.5 ? -1 : 1) * (0.12 + rand() * 0.22),
      });
    }
    return feats;
  }

  // --- tiny color helpers (hex #rrggbb only) ---
  _parse(hex) {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  _rgba(hex, a) {
    const [r, g, b] = this._parse(hex);
    return `rgba(${r},${g},${b},${a})`;
  }
  _lighten(hex, amt) {
    const [r, g, b] = this._parse(hex);
    const f = (c) => Math.max(0, Math.min(255, Math.round(c + amt * (amt > 0 ? 255 - c : c))));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }
};
