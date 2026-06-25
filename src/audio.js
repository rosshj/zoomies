// Procedural audio for Zoomies. Every sound effect is synthesized on the fly
// with the Web Audio API — no asset files — so it ships with zero downloads and
// matches the toy/cel-shaded look where everything else is procedural too.
// Background music is the one thing that loads real files (drop them in
// assets/music/ — see registerMusic); until then the music layer stays silent.
//
// Browsers block audio until a user gesture, so nothing is created until
// unlock() runs inside a click/tap. setListener() is fed the player's pose each
// frame so rival-kart sounds can be distance-attenuated and panned.

const SETTINGS_KEY = "zoomies-audio-v2";

// Default mix: SFX sit loud and clear, music well underneath them.
const DEFAULT_MUSIC_VOL = 0.25;
const DEFAULT_SFX_VOL = 1.0;

// How long the music takes to ease up from silence when a track starts.
const MUSIC_FADE_SEC = 1.8;

// Stereo pan + distance falloff for a sound emitted at a world position, heard
// from the listener pose. Beyond MAX_DIST it's inaudible; pan follows the
// listener's right vector. Returns null if the source is out of range.
const MAX_DIST = 130;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null; // everything routes here
    this.sfxGain = null; // one-shot + engine SFX bus
    this.musicGain = null; // background music bus
    // Independent music + SFX controls (on/off and 0..1 volume), persisted.
    const s = this._loadSettings();
    this.musicOn = s.musicOn;
    this.sfxOn = s.sfxOn;
    this.musicVol = s.musicVol;
    this.sfxVol = s.sfxVol;
    this._noise = null; // shared white-noise buffer

    // Engine loop nodes (created on first race).
    this._engine = null;
    // Drift skid loop nodes.
    this._skid = null;

    // Listener pose (player kart), updated each frame.
    this._lx = 0;
    this._lz = 0;
    this._rx = 1; // listener right-vector (for stereo pan)
    this._rz = 0;

    // Music: HTMLAudioElements per named track, routed through musicGain.
    this._tracks = {}; // name -> { el, source }
    this._curTrack = null;

    // Debounce timestamps for spammy one-shots.
    this._lastBump = 0;
  }

  _loadSettings() {
    const def = { musicOn: true, sfxOn: true, musicVol: DEFAULT_MUSIC_VOL, sfxVol: DEFAULT_SFX_VOL };
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (raw && typeof raw === "object") {
        return {
          musicOn: raw.musicOn !== false,
          sfxOn: raw.sfxOn !== false,
          musicVol: typeof raw.musicVol === "number" ? raw.musicVol : DEFAULT_MUSIC_VOL,
          sfxVol: typeof raw.sfxVol === "number" ? raw.sfxVol : DEFAULT_SFX_VOL,
        };
      }
    } catch {
      /* ignore */
    }
    return def;
  }

  _saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          musicOn: this.musicOn,
          sfxOn: this.sfxOn,
          musicVol: this.musicVol,
          sfxVol: this.sfxVol,
        })
      );
    } catch {
      /* ignore */
    }
  }

  // Build the AudioContext + bus graph. Must be called from a user gesture
  // (e.g. the START button). Safe to call repeatedly.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxOn ? this.sfxVol : 0;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicOn ? this.musicVol : 0;
      this.musicGain.connect(this.master);

      // One reusable second of white noise for skids, splashes, impacts, etc.
      const n = this.ctx.sampleRate;
      this._noise = this.ctx.createBuffer(1, n, n);
      const d = this._noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  get ready() {
    return !!this.ctx;
  }

  // --- Music controls ---
  setMusicOn(on) {
    this.musicOn = on;
    this._applyMusicGain();
    // Pause/resume the element so an off track doesn't keep streaming.
    const cur = this._curTrack && this._tracks[this._curTrack];
    if (cur) {
      if (on) cur.el.play().catch(() => {});
      else cur.el.pause();
    }
    this._saveSettings();
  }

  setMusicVolume(v) {
    this.musicVol = Math.max(0, Math.min(1, v));
    this._applyMusicGain();
    this._saveSettings();
  }

  _applyMusicGain() {
    if (!this.musicGain) return;
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setTargetAtTime(this.musicOn ? this.musicVol : 0, t, 0.04);
  }

  // --- SFX controls ---
  setSfxOn(on) {
    this.sfxOn = on;
    this._applySfxGain();
    this._saveSettings();
  }

  setSfxVolume(v) {
    this.sfxVol = Math.max(0, Math.min(1, v));
    this._applySfxGain();
    this._saveSettings();
  }

  _applySfxGain() {
    if (!this.sfxGain) return;
    const t = this.ctx.currentTime;
    this.sfxGain.gain.cancelScheduledValues(t);
    this.sfxGain.gain.setTargetAtTime(this.sfxOn ? this.sfxVol : 0, t, 0.04);
  }

  // Feed the listener (player) pose so spatial SFX can pan/attenuate.
  // forward is the kart's heading direction; right is derived from it.
  setListener(x, z, fwdX, fwdZ) {
    this._lx = x;
    this._lz = z;
    // Right vector = forward rotated -90° in XZ.
    this._rx = fwdZ;
    this._rz = -fwdX;
  }

  // Compute { gain, pan } for a world-space source, or null if out of range.
  _spatial(pos) {
    if (!pos) return { gain: 1, pan: 0 };
    const dx = pos.x - this._lx;
    const dz = pos.z - this._lz;
    const dist = Math.hypot(dx, dz);
    if (dist > MAX_DIST) return null;
    const gain = 1 - dist / MAX_DIST; // linear falloff (squared below)
    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = Math.max(-1, Math.min(1, (dx * this._rx + dz * this._rz) * inv));
    return { gain: gain * gain, pan };
  }

  // Route a node through optional spatial pan + the SFX bus. Returns the gain
  // node to schedule the envelope on, or null if the source is out of range.
  _route(node, pos, baseGain) {
    const s = this._spatial(pos);
    if (!s) return null;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    node.connect(g);
    if (s.pan !== 0 && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = s.pan;
      g.connect(p);
      p.connect(this.sfxGain);
    } else {
      g.connect(this.sfxGain);
    }
    g._peak = Math.max(0.0002, baseGain * s.gain); // exp ramps can't target 0
    return g;
  }

  // --- one-shot helpers ------------------------------------------------------

  _osc(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  _noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.loop = true;
    return s;
  }

  // ===========================================================================
  //  SOUND EFFECTS
  // ===========================================================================

  // The boost: a punchy POP (pitched transient) followed by a rising WHOOSH
  // (noise swept up through a bandpass). Satisfying and turbo-y.
  toot(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // POP — a quick pitched thump with a fast decay.
    const o = this._osc("triangle", 440);
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(130, t + 0.07);
    const pg = this._route(o, pos, 0.5);
    if (pg) {
      pg.gain.setValueAtTime(0.0001, t);
      pg.gain.exponentialRampToValueAtTime(pg._peak, t + 0.006);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.start(t);
      o.stop(t + 0.15);
    }

    // WHOOSH — bandpassed noise sweeping upward, swelling then fading.
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(450, t);
    bp.frequency.exponentialRampToValueAtTime(4200, t + 0.3);
    src.connect(bp);
    const wg = this._route(bp, pos, 0.5);
    if (wg) {
      wg.gain.setValueAtTime(0.0001, t);
      wg.gain.linearRampToValueAtTime(wg._peak, t + 0.08);
      wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      src.start(t);
      src.stop(t + 0.42);
    }
  }

  // Drift-release mini-turbo: a bright rising whoosh (filtered noise sweep).
  boost(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + 0.25);
    src.connect(bp);
    const g = this._route(bp, pos, 0.4);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g._peak, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.start(t);
    src.stop(t + 0.32);
  }

  // Hairball launch: a quick "pwip" — a falling triangle plus a noise spit.
  shoot(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc("triangle", 700);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.12);
    const g = this._route(o, pos, 0.22);
    if (g) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(g._peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.start(t);
      o.stop(t + 0.16);
    }
    // Spit of noise on top.
    const src = this._noiseSource();
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1500;
    src.connect(hp);
    const ng = this._route(hp, pos, 0.16);
    if (ng) {
      ng.gain.setValueAtTime(ng._peak, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      src.start(t);
      src.stop(t + 0.1);
    }
  }

  // Getting spun out by a hairball: a comedic "bonk" wobble down.
  hit(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc("sine", 420);
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    const o2 = this._osc("square", 210);
    o2.frequency.exponentialRampToValueAtTime(60, t + 0.3);
    const mix = this.ctx.createGain();
    mix.gain.value = 0.5;
    o.connect(mix);
    o2.connect(mix);
    const g = this._route(mix, pos, 0.4);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g._peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.36);
    o2.stop(t + 0.36);
  }

  // Kart-to-kart bump: a soft low thud. Debounced so sustained contact doesn't
  // machine-gun. `strength` 0..1 scales volume/pitch.
  bump(pos = null, strength = 0.5) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this._lastBump < 0.08) return;
    this._lastBump = now;
    const o = this._osc("sine", 150 + strength * 60);
    o.frequency.exponentialRampToValueAtTime(60, now + 0.14);
    const g = this._route(o, pos, 0.18 + strength * 0.22);
    if (!g) return;
    g.gain.setValueAtTime(g._peak, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    o.start(now);
    o.stop(now + 0.18);
  }

  // Wall scrape: a brief metallic noise hiss.
  scrape(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 2;
    src.connect(bp);
    const g = this._route(bp, pos, 0.12);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(g._peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.start(t);
    src.stop(t + 0.14);
  }

  // Driving through a puddle: a short watery splash.
  splash(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.12);
    bp.Q.value = 0.7;
    src.connect(bp);
    const g = this._route(bp, pos, 0.2);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g._peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.start(t);
    src.stop(t + 0.22);
  }

  // Countdown tick. n>0 = the 3/2/1 beeps (low), n===0 = the GO! chirp (high).
  countdownBeep(n) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc("square", n > 0 ? 440 : 880);
    const g = this.ctx.createGain();
    o.connect(g);
    g.connect(this.sfxGain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (n > 0 ? 0.18 : 0.5));
    o.start(t);
    o.stop(t + (n > 0 ? 0.2 : 0.55));
  }

  // Crossing the finish line: a little ascending fanfare.
  finish() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const notes = [523, 659, 784, 1047]; // C E G C
    notes.forEach((f, i) => {
      const t = t0 + i * 0.12;
      const o = this._osc("triangle", f);
      const g = this.ctx.createGain();
      o.connect(g);
      g.connect(this.sfxGain);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t);
      o.stop(t + 0.32);
    });
  }

  // A lap-complete chime (two quick rising notes).
  lap() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const t = t0 + i * 0.1;
      const o = this._osc("sine", f);
      const g = this.ctx.createGain();
      o.connect(g);
      g.connect(this.sfxGain);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.start(t);
      o.stop(t + 0.22);
    });
  }

  // Menu/UI click — a soft tick. Works even before a race (lazy unlock).
  uiClick() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc("sine", 600);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.05);
    const g = this.ctx.createGain();
    o.connect(g);
    g.connect(this.sfxGain);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.start(t);
    o.stop(t + 0.09);
  }

  // ===========================================================================
  //  CONTINUOUS LOOPS: engine + drift skid
  // ===========================================================================

  startEngine() {
    if (!this.ctx || this._engine) return;
    const t = this.ctx.currentTime;
    // A soft, detuned hum through a NON-resonant lowpass. The old version used a
    // resonant filter (Q 4) which whined — that's gone. Quiet by design: this is
    // a background hum, not a drone.
    const osc1 = this._osc("sawtooth", 58);
    const osc2 = this._osc("triangle", 59); // triangle = far fewer harsh harmonics
    const sub = this._osc("triangle", 29);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380;
    lp.Q.value = 0.6; // no resonant peak -> no whine
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    osc1.connect(lp);
    osc2.connect(lp);
    sub.connect(g); // sub bypasses the filter
    lp.connect(g);
    g.connect(this.sfxGain);
    osc1.start(t);
    osc2.start(t);
    sub.start(t);
    g.gain.setTargetAtTime(0.022, t, 0.4);
    this._engine = { osc1, osc2, sub, lp, g };
  }

  // freq tracks speed (0..1). boosting opens the filter + lifts the gain a touch.
  setEngine(speedFrac, boosting) {
    const e = this._engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 50 + speedFrac * 110; // ~50Hz idle -> ~160Hz redline
    e.osc1.frequency.setTargetAtTime(f, t, 0.06);
    e.osc2.frequency.setTargetAtTime(f * 1.008, t, 0.06);
    e.sub.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    const cut = 300 + speedFrac * 950 + (boosting ? 700 : 0);
    e.lp.frequency.setTargetAtTime(cut, t, 0.08);
    // Roughly half the old loudness, and it leans on speed rather than sitting loud.
    e.g.gain.setTargetAtTime(0.015 + speedFrac * 0.02 + (boosting ? 0.01 : 0), t, 0.1);
  }

  stopEngine() {
    const e = this._engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    e.g.gain.setTargetAtTime(0.0001, t, 0.15);
    [e.osc1, e.osc2, e.sub].forEach((o) => o.stop(t + 0.6));
    this._engine = null;
  }

  // Drift skid: a sustained tire SCREECH. A broadband friction hiss plus a
  // sharp resonant squeal whose pitch wobbles (LFO) for that live-rubber warble.
  // Call each frame with whether the player is drifting; the level eases in/out.
  setSkid(on, intensity = 1) {
    if (!this.ctx) return;
    if (on && !this._skid) {
      const t = this.ctx.currentTime;
      const src = this._noiseSource();
      // Friction hiss.
      const hiss = this.ctx.createBiquadFilter();
      hiss.type = "bandpass";
      hiss.frequency.value = 2800;
      hiss.Q.value = 1.1;
      // The squeal: a tight resonant peak that the LFO wobbles around.
      const squeal = this.ctx.createBiquadFilter();
      squeal.type = "bandpass";
      squeal.frequency.value = 1500;
      squeal.Q.value = 7;
      const lfo = this._osc("sine", 7.5);
      const lfoG = this.ctx.createGain();
      lfoG.gain.value = 240; // ± wobble of the squeal pitch
      lfo.connect(lfoG);
      lfoG.connect(squeal.frequency);
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(hiss);
      hiss.connect(g);
      src.connect(squeal);
      squeal.connect(g);
      g.connect(this.sfxGain);
      src.start(t);
      lfo.start(t);
      this._skid = { src, g };
    }
    if (this._skid) {
      const t = this.ctx.currentTime;
      this._skid.g.gain.setTargetAtTime(on ? 0.1 * intensity : 0.0001, t, 0.05);
    }
  }

  // ===========================================================================
  //  MUSIC (real files, loaded lazily; silent until provided)
  // ===========================================================================

  // Register a named track by URL. Call once at startup for each track; the file
  // doesn't need to exist yet — a missing file just leaves that track silent.
  registerMusic(name, url) {
    const el = new Audio();
    el.src = url;
    el.loop = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.addEventListener("error", () => {
      // File not present (yet) — disable this track quietly.
      this._tracks[name] = null;
    });
    this._tracks[name] = { el, source: null };
  }

  // Switch background music to a registered track (crossfades via the element).
  // No-op if the track wasn't registered or failed to load.
  playMusic(name) {
    if (!this.ctx) return;
    if (this._curTrack === name) {
      // Already selected — but a first-gesture play() can be rejected, leaving it
      // paused. Make sure it's actually rolling (cheap to call when already playing).
      const cur = this._tracks[name];
      if (cur && this.musicOn && cur.el.paused) cur.el.play().catch(() => {});
      return;
    }
    // Stop whatever's currently playing.
    const prev = this._curTrack && this._tracks[this._curTrack];
    if (prev) {
      prev.el.pause();
      prev.el.currentTime = 0;
    }
    this._curTrack = name;
    const track = this._tracks[name];
    if (!track) return;
    // Route the element through a per-track fade gain into the music bus once
    // (the fade gain does the fade-in; the music bus handles volume/mute).
    if (!track.source && this.ctx.createMediaElementSource) {
      try {
        track.source = this.ctx.createMediaElementSource(track.el);
        track.fade = this.ctx.createGain();
        track.fade.gain.value = 0;
        track.source.connect(track.fade);
        track.fade.connect(this.musicGain);
      } catch {
        // Some browsers throw if the element is reused; fall back to el.volume.
        track.source = null;
      }
    }
    // Fade the track up from silence so it eases in rather than blasting on.
    if (track.fade) {
      const t = this.ctx.currentTime;
      track.fade.gain.cancelScheduledValues(t);
      track.fade.gain.setValueAtTime(0, t);
      track.fade.gain.linearRampToValueAtTime(1, t + MUSIC_FADE_SEC);
    }
    if (this.musicOn) track.el.play().catch(() => {});
  }

  // Whether a music track is actually rolling right now (not just selected).
  get musicPlaying() {
    const cur = this._curTrack && this._tracks[this._curTrack];
    return !!(cur && !cur.el.paused);
  }

  stopMusic() {
    const cur = this._curTrack && this._tracks[this._curTrack];
    if (cur) {
      cur.el.pause();
      cur.el.currentTime = 0;
    }
    this._curTrack = null;
  }
}

export const audio = new AudioEngine();
