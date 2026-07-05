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
    // Session policy gate, NOT persisted: "the player's own audio wins". When
    // the platform reports other audio already playing (podcast/music on iOS),
    // main.js clears this so game music stays silent while SFX keep working.
    // Explicitly re-enabling music in Settings overrides it (clear user intent).
    this.musicAllowed = true;
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

    // A backgrounded game must not keep DJ-ing: iOS treats a playing <audio>
    // element as background-capable media, so without this the music kept
    // going after leaving the app. Pause on hide, resume on return (only if
    // the policy says music should be audible).
    document.addEventListener("visibilitychange", () => {
      const cur = this._curTrack && this._tracks[this._curTrack];
      if (!cur) return;
      if (document.hidden) cur.el.pause();
      else if (this._musicAudible) cur.el.play().catch(() => {});
    });

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
      this.musicGain.gain.value = this._musicAudible ? this.musicVol : 0;
      this.musicGain.connect(this.master);

      // One reusable second of white noise for skids, splashes, impacts, etc.
      const n = this.ctx.sampleRate;
      this._noise = this.ctx.createBuffer(1, n, n);
      const d = this._noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

      // iOS: an audio-session interruption (a call, Siri, another app claiming
      // the session) parks the context in WebKit's non-standard "interrupted"
      // state. Checking only for "suspended" missed it, leaving the game
      // permanently silent. Nudge it back whenever the state changes or the
      // app returns to the foreground — resume() is a no-op when running and
      // rejects harmlessly while a real interruption (phone call) is active.
      const kick = () => {
        if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
      };
      this.ctx.addEventListener?.("statechange", kick);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
    }
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  get ready() {
    return !!this.ctx;
  }

  // --- Music controls ---
  // True when music should actually sound: the persisted user toggle AND the
  // session policy gate (suppressed when the player's own audio is playing).
  get _musicAudible() {
    return this.musicOn && this.musicAllowed;
  }

  setMusicOn(on) {
    this.musicOn = on;
    if (on) this.musicAllowed = true; // explicit user intent beats the policy gate
    this._applyMusicGain();
    // Pause/resume the element so an off track doesn't keep streaming.
    const cur = this._curTrack && this._tracks[this._curTrack];
    if (cur) {
      if (this._musicAudible) cur.el.play().catch(() => {});
      else cur.el.pause();
    }
    this._saveSettings();
  }

  // Session-only policy gate (see constructor). Not persisted.
  setMusicAllowed(allowed) {
    this.musicAllowed = allowed;
    this._applyMusicGain();
    const cur = this._curTrack && this._tracks[this._curTrack];
    if (cur) {
      if (this._musicAudible) cur.el.play().catch(() => {});
      else cur.el.pause();
    }
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
    this.musicGain.gain.setTargetAtTime(this._musicAudible ? this.musicVol : 0, t, 0.04);
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

  // The boost: a tire CHIRP (peel-out) + a punchy POP (pitched transient) + a
  // rising WHOOSH (noise swept up). Layered like a real turbo kick.
  toot(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // CHIRP — tires breaking loose as you launch.
    this._screech(pos, 0.16, 0.13);

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

  // Drift-release mini-turbo: a tire chirp + a bright rising whoosh.
  boost(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._screech(pos, 0.14, 0.11); // chirp as the drift releases
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

  // Getting spun out: a comedic "bonk" that wobbles down dizzily. (The spinning
  // tires screech is layered on at the call site via skidBurst.)
  hit(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc("sine", 440);
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.4);
    const o2 = this._osc("square", 210);
    o2.frequency.exponentialRampToValueAtTime(58, t + 0.4);
    // Dizzy vibrato so it reads as a comedic spin, not just a thud.
    const wob = this._osc("sine", 12);
    const wobG = this.ctx.createGain();
    wobG.gain.value = 45;
    wob.connect(wobG);
    wobG.connect(o.frequency);
    const mix = this.ctx.createGain();
    mix.gain.value = 0.5;
    o.connect(mix);
    o2.connect(mix);
    const g = this._route(mix, pos, 0.42);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g._peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.start(t);
    o2.start(t);
    wob.start(t);
    o.stop(t + 0.44);
    o2.stop(t + 0.44);
    wob.stop(t + 0.44);
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
    // Kart-racer style "whir" instead of a combustion drone: a soft low hum
    // (pure sines — no buzzy sawtooth, no detuned beating) plus a speed-driven
    // broadband air/tire rush that does most of the "going fast" work, with a
    // gentle tremolo so it breathes instead of droning. Deliberately quiet.
    const hum = this._osc("sine", 60);
    const sub = this._osc("sine", 30);
    // Air/tire rush: looping noise through a bandpass that opens up with speed.
    const rush = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.5;
    const rushGain = this.ctx.createGain();
    rushGain.gain.value = 0.0001;
    rush.connect(bp);
    bp.connect(rushGain);
    // Tremolo: a slow LFO wobbles the hum level for a subtle chug.
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.6;
    const trem = this._osc("sine", 6);
    const tremDepth = this.ctx.createGain();
    tremDepth.gain.value = 0.28;
    trem.connect(tremDepth);
    tremDepth.connect(humGain.gain);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 480;
    lp.Q.value = 0.4;
    const g = this.ctx.createGain(); // master engine level (driven by speed)
    g.gain.value = 0.0001;
    hum.connect(humGain);
    humGain.connect(lp);
    lp.connect(g);
    sub.connect(g);
    rushGain.connect(g);
    g.connect(this.sfxGain);
    hum.start(t);
    sub.start(t);
    rush.start(t);
    trem.start(t);
    g.gain.setTargetAtTime(0.02, t, 0.4);
    this._engine = { hum, sub, rush, bp, rushGain, trem, lp, g };
  }

  // speedFrac 0..1 drives pitch, the air rush, and tremolo rate; boosting opens
  // the filter and lifts the level a touch.
  setEngine(speedFrac, boosting) {
    const e = this._engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 55 + speedFrac * 95; // ~55Hz idle -> ~150Hz; gentle, never whiny
    e.hum.frequency.setTargetAtTime(f, t, 0.08);
    e.sub.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    e.trem.frequency.setTargetAtTime(5 + speedFrac * 9, t, 0.1); // chugs faster with speed
    e.bp.frequency.setTargetAtTime(700 + speedFrac * 2400 + (boosting ? 800 : 0), t, 0.1);
    e.rushGain.gain.setTargetAtTime(0.12 + speedFrac * 0.5, t, 0.1); // rush grows with speed
    e.lp.frequency.setTargetAtTime(380 + speedFrac * 600 + (boosting ? 500 : 0), t, 0.08);
    e.g.gain.setTargetAtTime(0.016 + speedFrac * 0.02 + (boosting ? 0.01 : 0), t, 0.1);
  }

  stopEngine() {
    const e = this._engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    e.g.gain.setTargetAtTime(0.0001, t, 0.15);
    [e.hum, e.sub, e.rush, e.trem].forEach((o) => o.stop(t + 0.6));
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

  // A one-shot tire screech voice: friction hiss + a wobbling resonant squeal,
  // enveloped over `dur`. Shared by the boost chirp, spin-out skid, etc.
  _screech(pos, dur, peak) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const hiss = this.ctx.createBiquadFilter();
    hiss.type = "bandpass";
    hiss.frequency.value = 2500;
    hiss.Q.value = 1.1;
    const squeal = this.ctx.createBiquadFilter();
    squeal.type = "bandpass";
    squeal.frequency.value = 1700;
    squeal.Q.value = 8;
    const lfo = this._osc("sine", 9);
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 280;
    lfo.connect(lfoG);
    lfoG.connect(squeal.frequency);
    const mix = this.ctx.createGain();
    mix.gain.value = 1;
    src.connect(hiss);
    hiss.connect(mix);
    src.connect(squeal);
    squeal.connect(mix);
    const g = this._route(mix, pos, peak);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g._peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.start(t);
    lfo.start(t);
    src.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  // A one-shot tire screech — for spin-outs, hard landings, peel-outs, etc.
  skidBurst(pos = null, dur = 0.5, intensity = 1) {
    this._screech(pos, dur, 0.17 * intensity);
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
    // NO crossOrigin: these files are same-origin on every target (https on the
    // web, capacitor://localhost in the app). Requesting CORS mode against the
    // app's custom scheme made the load fail outright — killing music (while
    // the synthesized SFX kept working) with only a silent error event.
    el.addEventListener("error", () => {
      // File not present / failed to load — disable this track, but say so:
      // a silently-nulled track made "no music" undiagnosable on device.
      console.warn(`[zoomies] music track "${name}" failed to load (${url}):`, el.error?.code, el.error?.message || "");
      this._tracks[name] = null;
    });
    this._tracks[name] = { el, source: null };
  }

  // Switch background music to a registered track (crossfades via the element).
  // No-op if the track wasn't registered or failed to load.
  // One de-duplicated console line per music state change, so a silent device
  // is diagnosable from the log (gated? blocked by autoplay? track missing?).
  _mlog(msg) {
    if (this._lastMlog === msg) return;
    this._lastMlog = msg;
    console.log("[zoomies] music:", msg);
  }

  _playEl(el, name) {
    el.play()
      .then(() => this._mlog(`playing "${name}"`))
      .catch((e) => this._mlog(`play blocked: ${e?.name || e}`));
  }

  playMusic(name) {
    if (!this.ctx) return;
    if (this._curTrack === name) {
      // Already selected — but a first-gesture play() can be rejected, leaving it
      // paused. Make sure it's actually rolling (cheap to call when already playing).
      const cur = this._tracks[name];
      if (!cur) { this._mlog(`track "${name}" unavailable (failed to load)`); return; }
      if (!this._musicAudible) this._mlog(`gated (musicOn=${this.musicOn}, allowed=${this.musicAllowed})`);
      else if (cur.el.paused) this._playEl(cur.el, name);
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
    if (!track) { this._mlog(`track "${name}" unavailable (failed to load)`); return; }
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
    if (this._musicAudible) this._playEl(track.el, name);
    else this._mlog(`gated (musicOn=${this.musicOn}, allowed=${this.musicAllowed})`);
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
