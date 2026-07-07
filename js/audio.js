// SG.Audio — fully synthesized WebAudio sound: engine rumble, wind/reentry
// roar, staging thunk, explosion, parachute pop. No audio assets.
//
// Browsers require a user gesture before audio can start, so init is deferred
// to the first keydown/pointerdown. Every entry point is guarded — in tests
// (no AudioContext) this module is inert.
window.SG = window.SG || {};

SG.Audio = {
  ctx: null,
  started: false,

  // --- Boot ---------------------------------------------------------------------
  init() {
    if (this.started) return;
    const AC = typeof AudioContext !== "undefined" ? AudioContext
      : (typeof webkitAudioContext !== "undefined" ? webkitAudioContext : null);
    if (!AC) return;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(ctx.destination);

      // Shared looping noise buffer (2s of white noise).
      const len = 2 * ctx.sampleRate;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuf = buf;

      // Engine: noise -> lowpass -> gain (rumble).
      this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = "lowpass"; this.engineFilter.frequency.value = 160;
      this._loop(buf).connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);

      // Wind/reentry: noise -> bandpass -> gain (roar rises with q).
      this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = "bandpass"; this.windFilter.frequency.value = 400;
      this.windFilter.Q.value = 0.6;
      this._loop(buf).connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windGain.connect(this.master);

      this.started = true;
    } catch (e) { /* audio unavailable — stay silent */ }
  },

  _loop(buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.start();
    return src;
  },

  // --- Continuous layers (called every frame from the game loop) -----------------
  update(ship, aero) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    // Engine rumble tracks throttle.
    const eng = ship && ship.thrusting ? 0.25 + 0.45 * ship.throttle : 0;
    this.engineGain.gain.setTargetAtTime(eng, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(140 + (ship ? ship.throttle * 240 : 0), t, 0.1);
    // Wind roar tracks normalized heating flux + dynamic pressure.
    const wind = aero ? Math.min(0.5, aero.qNorm * 30 + Math.min(0.2, aero.q / 40000)) : 0;
    this.windGain.gain.setTargetAtTime(wind, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(300 + Math.min(1500, (aero ? aero.qNorm : 0) * 90000), t, 0.2);
  },

  // --- One-shots ------------------------------------------------------------------
  _burst(duration, freq, gain, type) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type || "lowpass"; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); src.stop(t + duration + 0.05);
  },

  thunk() {
    this._burst(0.18, 220, 0.5);
    // Low "clunk" body.
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 65;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(t + 0.3);
  },

  explosion() { this._burst(1.1, 300, 0.9); },
  chutePop() { this._burst(0.12, 1200, 0.35, "highpass"); },
};

// Start audio on the first user gesture (browser autoplay policy).
window.addEventListener("DOMContentLoaded", () => {
  const kick = () => {
    SG.Audio.init();
    if (SG.Audio.ctx && SG.Audio.ctx.state === "suspended") SG.Audio.ctx.resume();
    window.removeEventListener("keydown", kick);
    window.removeEventListener("pointerdown", kick);
  };
  window.addEventListener("keydown", kick);
  window.addEventListener("pointerdown", kick);
});
