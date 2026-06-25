// Procedural audio for Zoomies. Every sound effect is synthesized on the fly
// with the Web Audio API — no asset files — so it ships with zero downloads and
// matches the toy/cel-shaded look where everything else is procedural too.
// Background music is the one thing that loads real files (drop them in
// assets/music/ — see registerMusic); until then the music layer stays silent.
//
// Browsers block audio until a user gesture, so nothing is created until
// unlock() runs inside a click/tap. setListener() is fed the player's pose each
// frame so rival-kart sounds can be distance-attenuated and panned.

const MUTE_KEY = "zoomies-muted-v1";

// Stereo pan + distance falloff for a sound emitted at a world position, heard
// from the listener pose. Beyond MAX_DIST it's inaudible; pan follows the
// listener's right vector. Returns null if the source is out of range.
const MAX_DIST = 130;

// --- Procedural background music: a Don Toliver–style melodic trap loop -------
// 4 bars of 16th notes (16 steps/bar). Dreamy minor chords in F minor with an
// echoing lead, syncopated 808s and trap drums. It's synthesized live, so no
// audio files are needed.
const MUSIC_BPM = 142;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12); // MIDI note -> frequency

// Per-step drum patterns (one bar = 16 steps), reused for all 4 bars.
const PAT_KICK = [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0];
const PAT_SNARE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]; // half-time backbeat
// 0 none · 1 soft · 2 accent · 3 roll (triplet burst)
const PAT_HAT = [2, 0, 1, 0, 2, 0, 1, 3, 2, 0, 1, 0, 2, 0, 1, 3];
// 808 bass root (MIDI) per bar: Fm – Db – Ab – Eb  (i – VI – III – VII)
const MUSIC_ROOTS = [41, 37, 44, 39];
const PAT_BASS = [0, 6, 10]; // steps within a bar to (re)hit the 808
// Pad chord tones (MIDI) per bar.
const MUSIC_PADS = [
  [53, 56, 60],
  [49, 53, 56],
  [56, 60, 63],
  [51, 55, 58],
];
// Lead phrase: [bar, step, MIDI, durationInSteps] — sparse + dreamy.
const MUSIC_LEAD = [
  [0, 0, 72, 4], [0, 6, 75, 2], [0, 10, 72, 3],
  [1, 2, 70, 3], [1, 8, 68, 4],
  [2, 0, 75, 3], [2, 6, 77, 2], [2, 10, 75, 4],
  [3, 2, 72, 3], [3, 8, 70, 3], [3, 12, 68, 3],
];

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null; // everything routes here
    this.sfxGain = null; // one-shot + engine SFX bus
    this.musicGain = null; // background music bus
    this.muted = this._loadMuted();
    this._noise = null; // shared white-noise buffer
    this._music = null; // procedural beat scheduler state

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

  _loadMuted() {
    try {
      return localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      return false;
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
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.9;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.55;
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

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(m) {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(m ? 0 : 1, t, 0.05);
    }
    // Pause/resume the music element so a muted track doesn't keep streaming.
    const cur = this._curTrack && this._tracks[this._curTrack];
    if (cur) {
      if (m) cur.el.pause();
      else cur.el.play().catch(() => {});
    }
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

  // The signature cat "toot" boost: a buzzy square that swoops down then up a
  // touch, with a little vibrato — comic, not rude.
  toot(pos = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this._osc("square", 240);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1200;
    o.connect(lp);
    const g = this._route(lp, pos, 0.32);
    if (!g) return;
    const peak = g._peak;
    o.frequency.setValueAtTime(250, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.16);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.34);
    // Vibrato for the "brrrp" texture.
    const lfo = this._osc("sine", 22);
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 30;
    lfo.connect(lfoG);
    lfoG.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.4);
    lfo.stop(t + 0.4);
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
    // Two detuned saws + a sub for body, through a lowpass whose cutoff and
    // pitch track speed. Gain stays low — it's a background hum, not a drone.
    const osc1 = this._osc("sawtooth", 60);
    const osc2 = this._osc("sawtooth", 61.5); // slight detune = movement
    const sub = this._osc("triangle", 30);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    lp.Q.value = 4;
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
    g.gain.setTargetAtTime(0.05, t, 0.4);
    this._engine = { osc1, osc2, sub, lp, g };
  }

  // freq tracks speed (0..1). boosting opens the filter + lifts the gain.
  setEngine(speedFrac, boosting) {
    const e = this._engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 55 + speedFrac * 130; // ~55Hz idle -> ~185Hz redline
    e.osc1.frequency.setTargetAtTime(f, t, 0.06);
    e.osc2.frequency.setTargetAtTime(f * 1.01, t, 0.06);
    e.sub.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    const cut = 500 + speedFrac * 1800 + (boosting ? 1400 : 0);
    e.lp.frequency.setTargetAtTime(cut, t, 0.08);
    e.g.gain.setTargetAtTime(0.045 + speedFrac * 0.03 + (boosting ? 0.025 : 0), t, 0.1);
  }

  stopEngine() {
    const e = this._engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    e.g.gain.setTargetAtTime(0.0001, t, 0.15);
    [e.osc1, e.osc2, e.sub].forEach((o) => o.stop(t + 0.6));
    this._engine = null;
  }

  // Drift skid: a sustained tire screech (bandpassed noise). Call each frame
  // with whether the player is drifting; the level eases in/out.
  setSkid(on, intensity = 1) {
    if (!this.ctx) return;
    if (on && !this._skid) {
      const src = this._noiseSource();
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800;
      bp.Q.value = 3.5;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(bp);
      bp.connect(g);
      g.connect(this.sfxGain);
      src.start(this.ctx.currentTime);
      this._skid = { src, bp, g };
    }
    if (this._skid) {
      const t = this.ctx.currentTime;
      this._skid.g.gain.setTargetAtTime(on ? 0.05 * intensity : 0.0001, t, 0.05);
    }
  }

  // ===========================================================================
  //  PROCEDURAL MUSIC — a Don Toliver–style melodic trap loop
  // ===========================================================================

  // Start (or re-target) the background beat. mode "race" is the full beat;
  // mode "menu" is a mellow version (pads + lead, sparse percussion).
  playBeat(mode = "race") {
    if (!this.ctx) return;
    if (this._music) {
      this._music.mode = mode;
      // Lift the bus back up in case it was fading out.
      this._music.bus.gain.setTargetAtTime(mode === "race" ? 0.9 : 0.7, this.ctx.currentTime, 0.4);
      return;
    }
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.0001;
    bus.connect(this.musicGain);
    // A feedback delay (dotted-eighth) gives the lead/pads that spacey echo.
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = (60 / MUSIC_BPM) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(bus);

    const stepDur = 60 / MUSIC_BPM / 4; // 16th note
    this._music = {
      mode,
      bus,
      echo: delay, // melodic voices also feed this for the echo
      step: 0,
      nextTime: ctx.currentTime + 0.06,
      stepDur,
      timer: null,
    };
    bus.gain.setTargetAtTime(mode === "race" ? 0.9 : 0.7, ctx.currentTime, 0.5);
    // Lookahead scheduler: queue any steps that fall in the next 0.1s.
    this._music.timer = setInterval(() => this._beatTick(), 25);
    this._beatTick();
  }

  stopBeat() {
    const m = this._music;
    if (!m) return;
    clearInterval(m.timer);
    const t = this.ctx.currentTime;
    m.bus.gain.cancelScheduledValues(t);
    m.bus.gain.setTargetAtTime(0.0001, t, 0.25); // fade out tail (incl. echo)
    setTimeout(() => {
      try {
        m.bus.disconnect();
      } catch {
        /* already gone */
      }
    }, 1200);
    this._music = null;
  }

  _beatTick() {
    const m = this._music;
    if (!m) return;
    const ahead = 0.1;
    while (m.nextTime < this.ctx.currentTime + ahead) {
      this._scheduleStep(m.step, m.nextTime);
      m.nextTime += m.stepDur;
      m.step = (m.step + 1) % 64; // 4 bars × 16 steps
    }
  }

  _scheduleStep(globalStep, t) {
    const m = this._music;
    const race = m.mode === "race";
    const bar = (globalStep >> 4) & 3;
    const s = globalStep & 15;
    const sd = m.stepDur;

    // Drums (race only; menu stays mellow).
    if (race) {
      if (PAT_KICK[s]) this._mKick(t);
      if (PAT_SNARE[s]) this._mSnare(t);
    }
    const hv = PAT_HAT[s];
    if (hv && (race || s % 4 === 0)) this._mHat(t, race ? hv : 1, sd);

    // 808 bass (octave below the chord root). Menu only hits the downbeat.
    if (PAT_BASS.includes(s) && (race || s === 0)) {
      this._m808(t, mtof(MUSIC_ROOTS[bar] - 12), (race ? 0.55 : 1.4) * (s === 0 ? 1 : 0.8));
    }

    // Sustained pad chord at each bar start.
    if (s === 0) this._mPad(t, MUSIC_PADS[bar].map(mtof), sd * 16);

    // Lead melody.
    for (const [lb, ls, midi, dur] of MUSIC_LEAD) {
      if (lb === bar && ls === s) this._mLead(t, mtof(midi), sd * dur);
    }
  }

  // --- music voices ----------------------------------------------------------

  _mKick(t) {
    const o = this._osc("sine", 150);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const g = this.ctx.createGain();
    o.connect(g);
    g.connect(this._music.bus);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.start(t);
    o.stop(t + 0.22);
  }

  _m808(t, freq, dur) {
    const o = this._osc("sine", freq * 1.5);
    o.frequency.setValueAtTime(freq * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.06); // pitch "pluck"
    const sh = this.ctx.createWaveShaper();
    sh.curve = this._satCurve();
    const g = this.ctx.createGain();
    o.connect(sh);
    sh.connect(g);
    g.connect(this._music.bus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _mSnare(t) {
    // Clap-ish: a few quick noise bursts + a little tonal body.
    for (let i = 0; i < 3; i++) {
      const ts = t + i * 0.012;
      const src = this._noiseSource();
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1900;
      bp.Q.value = 1.2;
      const g = this.ctx.createGain();
      src.connect(bp);
      bp.connect(g);
      g.connect(this._music.bus);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.linearRampToValueAtTime(0.32, ts + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.12);
      src.start(ts);
      src.stop(ts + 0.14);
    }
  }

  _mHat(t, vel, sd) {
    // vel 3 = a triplet roll across this step; otherwise one tick.
    const hits = vel === 3 ? 3 : 1;
    const level = vel === 2 ? 0.3 : vel === 3 ? 0.22 : 0.16;
    for (let i = 0; i < hits; i++) {
      const ts = t + (i * sd) / hits;
      const src = this._noiseSource();
      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 7000;
      const g = this.ctx.createGain();
      src.connect(hp);
      hp.connect(g);
      g.connect(this._music.bus);
      g.gain.setValueAtTime(level, ts);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.04);
      src.start(ts);
      src.stop(ts + 0.05);
    }
  }

  _mLead(t, freq, dur) {
    const o1 = this._osc("triangle", freq);
    const o2 = this._osc("triangle", freq * 1.005); // gentle detune
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2600;
    const g = this.ctx.createGain();
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(g);
    g.connect(this._music.bus);
    g.connect(this._music.echo); // send to the delay for the dreamy echo
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.4);
    o1.start(t);
    o2.start(t);
    o1.stop(t + dur + 0.3);
    o2.stop(t + dur + 0.3);
  }

  _mPad(t, freqs, dur) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1300;
    const g = this.ctx.createGain();
    lp.connect(g);
    g.connect(this._music.bus);
    g.connect(this._music.echo);
    const peak = 0.05;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.4); // slow swell
    g.gain.setTargetAtTime(0.0001, t + dur * 0.7, dur * 0.25);
    for (const f of freqs) {
      const a = this._osc("sawtooth", f);
      const b = this._osc("sawtooth", f * 1.008);
      a.connect(lp);
      b.connect(lp);
      a.start(t);
      b.start(t);
      a.stop(t + dur + 0.4);
      b.stop(t + dur + 0.4);
    }
  }

  // A soft saturation curve for the 808 (adds warmth/grit).
  _satCurve() {
    if (this._sat) return this._sat;
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 2);
    }
    return (this._sat = c);
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
    if (this._curTrack === name) return;
    // Stop whatever's currently playing.
    const prev = this._curTrack && this._tracks[this._curTrack];
    if (prev) {
      prev.el.pause();
      prev.el.currentTime = 0;
    }
    this._curTrack = name;
    const track = this._tracks[name];
    if (!track) return;
    // Route the element through the music bus once (for unified volume/mute).
    if (!track.source && this.ctx.createMediaElementSource) {
      try {
        track.source = this.ctx.createMediaElementSource(track.el);
        track.source.connect(this.musicGain);
      } catch {
        // Some browsers throw if the element is reused; fall back to el.volume.
        track.source = null;
      }
    }
    if (!this.muted) track.el.play().catch(() => {});
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
