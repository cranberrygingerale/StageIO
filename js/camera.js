// SG.Camera — follows a target in world space, supports zoom, and converts
// between world and screen coordinates. The canvas center is the focal point.
window.SG = window.SG || {};

SG.Camera = class Camera {
  constructor() {
    this.x = 0;             // world position the camera is centered on
    this.y = 0;
    this.zoom = 1;          // pixels-per-world-unit
    this.minZoom = 0.06;
    this.maxZoom = 2.5;
    this.viewportW = 0;
    this.viewportH = 0;
  }

  setViewport(w, h) {
    this.viewportW = w;
    this.viewportH = h;
  }

  // Snap instantly (used on reset so we don't glide across the whole map).
  snapTo(x, y) {
    this.x = x;
    this.y = y;
  }

  // Smoothly ease toward the target each frame. `smooth` in [0,1].
  follow(x, y, smooth = 0.12) {
    this.x += (x - this.x) * smooth;
    this.y += (y - this.y) * smooth;
  }

  // Multiplicative zoom, clamped. `factor` > 1 zooms in.
  zoomBy(factor) {
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.viewportW / 2,
      y: (wy - this.y) * this.zoom + this.viewportH / 2,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewportW / 2) / this.zoom + this.x,
      y: (sy - this.viewportH / 2) / this.zoom + this.y,
    };
  }
};
