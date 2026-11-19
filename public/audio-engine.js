(() => {
  'use strict';

  class SkyWingAudioEngine {
    constructor(options = {}) {
      this.ctx = null;
      this.compressor = null;
      this.masterGain = null;
      this.muted = false;
      this.locked = Boolean(options && options.startLocked);
      this.config = {
        bgmEnabled: true,
        soundPreset: 'aviator-jet',
        masterVolume: 75,
      };

      this.tensionOsc = null;
      this.tensionHarmonic = null;
      this.tensionSub = null;
      this.tensionFilter = null;
      this.tensionGain = null;
      this.jetNoiseSrc = null;
      this.jetNoiseFilter = null;
      this.jetNoiseGain = null;

      this.bgmTimer = null;
      this.bgmStep = 0;
      this.bgmRunning = false;
      this.lastFlapAt = 0;
      this.lastTickMult = 1.0;
      this.activeGame = null;
    }

    setActiveGame(gameId) {
      const next = gameId || null;
      if (this.activeGame !== next && next !== 'skywing-crash') {
        this.stopTension();
      }
      this.activeGame = next;
    }

    ensureContext() {
      if (this.locked) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();

        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -16;
        this.compressor.knee.value = 18;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.005;
        this.compressor.release.value = 0.18;

        this.masterGain = this.ctx.createGain();
        this.applyMasterGain();

        this.compressor.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);
      }

      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    getDestination() {
      if (this.locked) return null;
      const ctx = this.ensureContext();
      if (!ctx) return null;
      return this.compressor || ctx.destination;
    }

    applyMasterGain() {
      if (!this.masterGain || !this.ctx) return;
      const vol =
        this.muted || this.locked
          ? 0
          : Math.max(0, Math.min(1, Number(this.config.masterVolume ?? 75) / 100));
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.04);
    }

    setLocked(locked) {
      this.locked = Boolean(locked);
      if (this.locked) {
        this.stopTension();
        this.stopBGM();
      }
      this.applyMasterGain();
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      this.applyMasterGain();
      if (this.muted) {
        this.stopTension();
        this.stopBGM();
      } else if (!this.locked && this.config.bgmEnabled && this.ctx) {
        this.startBGM();
      }
    }

    setConfig(nextConfig = {}, autoStartBgm = true) {
      const prevPreset = this.config.soundPreset;
      const prevBgm = this.config.bgmEnabled;
      this.config = {
        bgmEnabled: nextConfig.bgmEnabled !== undefined ? Boolean(nextConfig.bgmEnabled) : this.config.bgmEnabled,
        soundPreset: nextConfig.soundPreset || this.config.soundPreset || 'aviator-jet',
        masterVolume:
          nextConfig.masterVolume !== undefined
            ? Math.max(0, Math.min(100, Number(nextConfig.masterVolume)))
            : this.config.masterVolume,
      };
      this.applyMasterGain();

      if (!this.config.bgmEnabled || this.muted || this.locked) {
        this.stopBGM();
      } else if (autoStartBgm && this.ctx && (!this.bgmRunning || prevPreset !== this.config.soundPreset || !prevBgm)) {
        this.startBGM();
      }
    }

    // ========================================================================
    // Background Music Sequencer (5 Synthesized Presets incl. Aviator Jet)
    // ========================================================================
    startBGM(forcePreset = null) {
      if (this.muted || this.locked) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      if (forcePreset) {
        this.config.soundPreset = forcePreset;
      }
      this.stopBGM();
      this.bgmRunning = true;
      this.bgmStep = 0;

      const stepMs =
        this.config.soundPreset === 'turbo-arcade'
          ? 140
          : this.config.soundPreset === 'casino-chime'
            ? 165
            : this.config.soundPreset === 'aviator-jet'
              ? 185
              : this.config.soundPreset === 'stealth-minimal'
                ? 240
                : 175;

      const tick = () => {
        if (!this.bgmRunning || this.muted || this.locked || !this.ctx || this.ctx.state !== 'running') return;
        this.scheduleBgmStep(this.bgmStep++);
      };

      tick();
      this.bgmTimer = setInterval(tick, stepMs);
    }

    stopBGM() {
      this.bgmRunning = false;
      if (this.bgmTimer) {
        clearInterval(this.bgmTimer);
        this.bgmTimer = null;
      }
    }

    scheduleBgmStep(step) {
      const ctx = this.ctx;
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime + 0.015;
      const preset = this.config.soundPreset;

      if (preset === 'aviator-jet') {
        // Authentic Aviator / Avtix Lounge Groove: Warm sub pulse + aviation cockpit chimes
        const bass = [98.0, 98.0, 110.0, 130.81, 123.47, 110.0, 98.0, 87.31];
        const shimmer = [392.0, 493.88, 587.33, 659.25, 587.33, 493.88, 440.0, 392.0];
        if (step % 2 === 0) {
          this.playTone(bass[(step / 2) % bass.length], 'triangle', t, 0.24, 0.048, 340);
        }
        if (step % 4 === 0) {
          this.playKick(t, 0.055);
        }
        if (step % 2 === 1) {
          this.playHiHat(t, 0.012);
        }
        if (step % 4 === 2) {
          this.playTone(shimmer[(step / 2) % shimmer.length], 'sine', t, 0.22, 0.025);
        }
      } else if (preset === 'cyber-flight') {
        // Cyber Flight Synth: Pulsing sci-fi bass + crystalline arpeggio
        const bassNotes = [110, 110, 130.81, 164.81, 146.83, 146.83, 130.81, 98.0];
        const arpNotes = [220, 261.63, 329.63, 392.0, 440, 392.0, 329.63, 293.66];
        if (step % 2 === 0) {
          this.playTone(bassNotes[(step / 2) % bassNotes.length], 'sawtooth', t, 0.22, 0.045, 380);
        }
        this.playTone(arpNotes[step % arpNotes.length], 'triangle', t, 0.14, 0.032, 1600);
      } else if (preset === 'casino-chime') {
        // High-Energy Casino Chime: Upbeat chord bass + sparkling casino bell ticks
        const bass = [130.81, 196.0, 164.81, 146.83];
        const chimes = [523.25, 659.25, 783.99, 987.77, 1046.5, 783.99, 659.25, 587.33];
        if (step % 4 === 0) {
          this.playTone(bass[(step / 4) % bass.length], 'triangle', t, 0.34, 0.048, 520);
        }
        if (step % 2 === 0) {
          this.playTone(chimes[(step / 2) % chimes.length], 'sine', t, 0.19, 0.036);
        }
        if (step % 2 === 1) {
          this.playHiHat(t, 0.014);
        }
      } else if (preset === 'turbo-arcade') {
        // Turbo Arcade Pulse: Driving octave synthwave bass + lead
        const bass = [82.41, 164.81, 82.41, 164.81, 98.0, 196.0, 110.0, 220.0];
        const lead = [329.63, 392.0, 493.88, 659.25, 493.88, 392.0, 329.63, 293.66];
        this.playTone(bass[step % bass.length], 'square', t, 0.11, 0.028, 620);
        if (step % 2 === 0) {
          this.playTone(lead[(step / 2) % lead.length], 'sawtooth', t, 0.16, 0.024, 1800);
        }
        if (step % 4 === 0) {
          this.playKick(t, 0.065);
        }
      } else {
        // Minimal Pro: Subtle atmospheric pad pulses
        const pad = [146.83, 220.0, 174.61, 196.0];
        if (step % 4 === 0) {
          this.playTone(pad[(step / 4) % pad.length], 'sine', t, 0.45, 0.032);
        }
      }
    }

    playTone(freq, type, startTime, duration, peakGain, cutoffFreq = null) {
      const ctx = this.ctx;
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      if (cutoffFreq) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cutoffFreq, startTime);
        osc.connect(filter).connect(gain).connect(dest);
      } else {
        osc.connect(gain).connect(dest);
      }
      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    }

    playKick(startTime, peakGain) {
      const ctx = this.ctx;
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(125, startTime);
      osc.frequency.exponentialRampToValueAtTime(42, startTime + 0.12);
      gain.gain.setValueAtTime(peakGain, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.14);
      osc.connect(gain).connect(dest);
      osc.start(startTime);
      osc.stop(startTime + 0.15);
    }

    playHiHat(startTime, peakGain) {
      const ctx = this.ctx;
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const len = Math.floor(ctx.sampleRate * 0.035);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 6500;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(peakGain, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0005, startTime + 0.035);
      src.connect(filter).connect(gain).connect(dest);
      src.start(startTime);
    }

    // ========================================================================
    // Authentic Aviator / Avtix Game Sound Effects
    // ========================================================================
    playClick() {
      if (this.muted || this.locked) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(640, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.05);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.065);
    }

    // Crisp High-Energy Casino Chime (Bet Placed)
    playCasinoChime() {
      if (this.muted || this.locked) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const now = ctx.currentTime;
      const notes = [880, 1174.66, 1318.51, 1760];
      notes.forEach((freq, i) => {
        const start = now + i * 0.048;
        this.playTone(freq, 'sine', start, 0.22, 0.1);
        this.playTone(freq * 2, 'triangle', start, 0.12, 0.032);
      });
    }

    // Crisp Tension Tick as Multiplier Climbs
    playTensionTick(mult = 1.0) {
      if (this.muted || this.locked || this.activeGame !== 'skywing-crash') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      const tickFreq = Math.min(2200, 920 + (mult - 1) * 95);
      this.playTone(tickFreq, 'triangle', t, 0.045, 0.055);
      this.playTone(tickFreq * 1.5, 'sine', t, 0.03, 0.025);
    }

    playWingFlap() {
      if (this.muted || this.locked || this.activeGame !== 'skywing-crash') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const nowMs = performance.now();
      if (nowMs - this.lastFlapAt < 300) return;
      this.lastFlapAt = nowMs;

      const t = ctx.currentTime;
      const bufferSize = Math.floor(ctx.sampleRate * 0.1);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(560, t);
      filter.frequency.exponentialRampToValueAtTime(290, t + 0.095);
      filter.Q.value = 1.8;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

      noise.connect(filter).connect(gain).connect(dest);
      noise.start(t);

      const thump = ctx.createOscillator();
      const thumpGain = ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(115, t);
      thump.frequency.exponentialRampToValueAtTime(56, t + 0.065);
      thumpGain.gain.setValueAtTime(0.032, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
      thump.connect(thumpGain).connect(dest);
      thump.start(t);
      thump.stop(t + 0.085);
    }

    // Rising Jet Turbine / Propeller Acceleration Pitch + Air Rush
    startTension() {
      if (this.muted || this.locked || this.activeGame !== 'skywing-crash') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      this.stopTension();
      this.lastTickMult = 1.0;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const harmonic = ctx.createOscillator();
      const sub = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      const isAviator = this.config.soundPreset === 'aviator-jet';
      osc.type = isAviator || this.config.soundPreset === 'turbo-arcade' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(isAviator ? 135 : 165, now);

      harmonic.type = 'sine';
      harmonic.frequency.setValueAtTime(isAviator ? 270 : 330, now);

      sub.type = 'triangle';
      sub.frequency.setValueAtTime(68, now);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(420, now);
      filter.Q.value = isAviator ? 3.2 : 2.2;

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.044, now + 0.25);

      osc.connect(filter);
      harmonic.connect(filter);
      sub.connect(filter);
      filter.connect(gain).connect(dest);

      osc.start(now);
      harmonic.start(now);
      sub.start(now);

      // Filtered jet afterburner air rush noise layer
      const noiseLen = ctx.sampleRate * 2;
      const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
      const nData = noiseBuf.getChannelData(0);
      for (let i = 0; i < noiseLen; i++) {
        nData[i] = Math.random() * 2 - 1;
      }
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;
      noiseSrc.loop = true;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(380, now);
      noiseFilter.Q.value = 1.4;

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.001, now);
      noiseGain.gain.linearRampToValueAtTime(isAviator ? 0.032 : 0.018, now + 0.3);

      noiseSrc.connect(noiseFilter).connect(noiseGain).connect(dest);
      noiseSrc.start(now);

      this.tensionOsc = osc;
      this.tensionHarmonic = harmonic;
      this.tensionSub = sub;
      this.tensionFilter = filter;
      this.tensionGain = gain;
      this.jetNoiseSrc = noiseSrc;
      this.jetNoiseFilter = noiseFilter;
      this.jetNoiseGain = noiseGain;
    }

    updateTension(mult) {
      if (!this.tensionOsc || !this.ctx || this.muted || this.locked || this.activeGame !== 'skywing-crash') {
        if (this.activeGame !== 'skywing-crash' && this.tensionOsc) this.stopTension();
        return;
      }
      const t = this.ctx.currentTime;
      const baseFreq = Math.min(820, 140 + (mult - 1) * 52);
      const cutoff = Math.min(3400, 440 + (mult - 1) * 260);
      this.tensionOsc.frequency.setTargetAtTime(baseFreq, t, 0.05);
      this.tensionHarmonic?.frequency.setTargetAtTime(baseFreq * 1.98, t, 0.05);
      this.tensionSub?.frequency.setTargetAtTime(Math.min(220, 68 + (mult - 1) * 14), t, 0.06);
      this.tensionFilter?.frequency.setTargetAtTime(cutoff, t, 0.06);
      this.jetNoiseFilter?.frequency.setTargetAtTime(Math.min(2800, 380 + (mult - 1) * 185), t, 0.06);

      // Trigger crisp Aviator tension tick on key multiplier climb intervals
      const step = mult < 3 ? 0.25 : mult < 10 ? 0.5 : 1.0;
      if (mult - this.lastTickMult >= step) {
        this.lastTickMult = Math.floor(mult / step) * step;
        this.playTensionTick(mult);
      }
    }

    stopTension() {
      if (this.tensionGain && this.ctx) {
        try {
          const t = this.ctx.currentTime;
          this.tensionGain.gain.setTargetAtTime(0.0001, t, 0.03);
          this.jetNoiseGain?.gain.setTargetAtTime(0.0001, t, 0.03);
          this.tensionOsc?.stop(t + 0.09);
          this.tensionHarmonic?.stop(t + 0.09);
          this.tensionSub?.stop(t + 0.09);
          this.jetNoiseSrc?.stop(t + 0.09);
        } catch {
          // ignore
        }
      }
      this.tensionOsc = null;
      this.tensionHarmonic = null;
      this.tensionSub = null;
      this.tensionFilter = null;
      this.tensionGain = null;
      this.jetNoiseSrc = null;
      this.jetNoiseFilter = null;
      this.jetNoiseGain = null;
    }

    // Live Preview of Aviator Jet Takeoff Acceleration (Admin Test Bench)
    playTakeoffPreview() {
      if (this.muted || this.locked) return;
      this.startTension();
      let simMult = 1.0;
      const iv = setInterval(() => {
        simMult += 0.22;
        this.updateTension(simMult);
        if (simMult >= 3.2) {
          clearInterval(iv);
          this.stopTension();
        }
      }, 95);
    }

    // Victory Arpeggio / Avtix Cashout Chime
    playCashout() {
      if (this.muted || this.locked) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
      const base = ctx.currentTime;
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const shimmer = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        shimmer.type = 'triangle';
        const start = base + idx * 0.038;
        osc.frequency.setValueAtTime(freq, start);
        shimmer.frequency.setValueAtTime(freq * 2, start);
        gain.gain.setValueAtTime(0.11, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.34);
        osc.connect(gain);
        shimmer.connect(gain);
        gain.connect(dest);
        osc.start(start);
        shimmer.start(start);
        osc.stop(start + 0.36);
        shimmer.stop(start + 0.36);
      });
    }

    // Multi-Stage Dynamic Crash Explosion
    playCrash() {
      this.stopTension();
      if (this.muted || this.locked) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;

      // Stage 1: Heavy Sub-Bass Concussion Impact
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(175, t);
      sub.frequency.exponentialRampToValueAtTime(28, t + 0.48);
      subGain.gain.setValueAtTime(0.32, t);
      subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.52);
      sub.connect(subGain).connect(dest);
      sub.start(t);
      sub.stop(t + 0.54);

      // Stage 2: Roaring Afterburner Blast Burst
      const bufferSize = Math.floor(ctx.sampleRate * 0.48);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.25);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(2800, t);
      noiseFilter.frequency.exponentialRampToValueAtTime(120, t + 0.46);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.22, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
      noise.connect(noiseFilter).connect(noiseGain).connect(dest);
      noise.start(t);

      // Stage 3: Secondary Shockwave Thump (+75ms)
      this.playTone(95, 'triangle', t + 0.075, 0.24, 0.14, 240);

      // Stage 4: Descending Jet Turbine Spool-Down & Debris Shimmer
      const sweep = ctx.createOscillator();
      const sweepGain = ctx.createGain();
      sweep.type = 'sawtooth';
      sweep.frequency.setValueAtTime(540, t + 0.03);
      sweep.frequency.exponentialRampToValueAtTime(46, t + 0.54);
      sweepGain.gain.setValueAtTime(0.095, t + 0.03);
      sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      sweep.connect(sweepGain).connect(dest);
      sweep.start(t + 0.03);
      sweep.stop(t + 0.56);

      [1560, 2090, 1240].forEach((freq, idx) => {
        this.playTone(freq, 'triangle', t + idx * 0.025, 0.14, 0.055);
      });
    }

    // ========================================================================
    // Game-Specific Arcade SFX (Plinko, Golden Mines, Cyber Dice)
    // ========================================================================
    playPlinkoBounce() {
      if (this.muted || this.locked || this.activeGame !== 'cyber-plinko') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      const pitch = 680 + Math.random() * 240;
      this.playTone(pitch, 'sine', t, 0.055, 0.06);
      this.playTone(pitch * 1.5, 'triangle', t, 0.03, 0.02);
    }

    playPlinkoBucket(mult = 1) {
      if (this.muted || this.locked || this.activeGame !== 'cyber-plinko') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      if (mult >= 1.5) {
        [587.33, 783.99, 1046.5].forEach((f, i) => {
          this.playTone(f, 'sine', t + i * 0.04, 0.18, 0.09);
        });
      } else {
        this.playTone(mult >= 1 ? 520 : 280, 'triangle', t, 0.14, 0.075);
      }
    }

    playMinesTile() {
      if (this.muted || this.locked || this.activeGame !== 'golden-mines') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      this.playTone(540, 'triangle', ctx.currentTime, 0.06, 0.065);
    }

    playMinesDiamond() {
      if (this.muted || this.locked || this.activeGame !== 'golden-mines') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      this.playTone(880, 'sine', t, 0.14, 0.09);
      this.playTone(1318.51, 'sine', t + 0.045, 0.18, 0.085);
    }

    playDiceRoll() {
      if (this.muted || this.locked || this.activeGame !== 'cyber-dice') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      [340, 480, 410, 560].forEach((f, idx) => {
        this.playTone(f, 'triangle', t + idx * 0.042, 0.05, 0.06);
      });
    }

    playDiceWin() {
      if (this.muted || this.locked || this.activeGame !== 'cyber-dice') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      [587.33, 880, 1174.66].forEach((f, idx) => {
        this.playTone(f, 'sine', t + idx * 0.045, 0.22, 0.1);
      });
    }

    playLimboLaunch() {
      if (this.muted || this.locked || this.activeGame !== 'cyber-limbo') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(190, t);
      osc.frequency.exponentialRampToValueAtTime(680, t + 0.18);
      gain.gain.setValueAtTime(0.055, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.connect(gain).connect(dest);
      osc.start(t);
      osc.stop(t + 0.21);
    }

    playCoinFlip() {
      if (this.muted || this.locked || this.activeGame !== 'neon-flip') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      [1180, 1560, 1320, 1760].forEach((f, idx) => {
        this.playTone(f, 'sine', t + idx * 0.06, 0.09, 0.065);
      });
    }

    playWheelTick() {
      if (this.muted || this.locked || this.activeGame !== 'lucky-wheel') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      this.playTone(880, 'triangle', ctx.currentTime, 0.035, 0.065);
    }

    playCardDeal() {
      if (this.muted || this.locked || this.activeGame !== 'dragon-hilo') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      this.playTone(460, 'triangle', t, 0.055, 0.075);
      this.playTone(720, 'sine', t + 0.045, 0.07, 0.05);
    }

    playSlotReel(step = 0) {
      if (this.muted || this.locked || this.activeGame !== 'emerald-slots') return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const freqs = [440, 554.37, 659.25];
      this.playTone(freqs[step % freqs.length], 'square', ctx.currentTime, 0.05, 0.045, 1600);
    }

    playArcadeWin(gameId) {
      if (this.muted || this.locked || this.activeGame !== gameId) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        this.playTone(f, 'sine', t + i * 0.042, 0.22, 0.095);
      });
    }
  }

  window.SkyWingAudioEngine = SkyWingAudioEngine;
})();
