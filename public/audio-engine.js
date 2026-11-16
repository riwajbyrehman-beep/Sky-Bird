(() => {
  'use strict';

  class SkyWingAudioEngine {
    constructor() {
      this.ctx = null;
      this.compressor = null;
      this.masterGain = null;
      this.muted = false;
      this.config = {
        bgmEnabled: true,
        soundPreset: 'cyber-flight',
        masterVolume: 75,
      };

      this.tensionOsc = null;
      this.tensionHarmonic = null;
      this.tensionFilter = null;
      this.tensionGain = null;

      this.bgmTimer = null;
      this.bgmStep = 0;
      this.bgmRunning = false;
      this.lastFlapAt = 0;
    }

    ensureContext() {
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
      const ctx = this.ensureContext();
      if (!ctx) return null;
      return this.compressor || ctx.destination;
    }

    applyMasterGain() {
      if (!this.masterGain || !this.ctx) return;
      const vol = this.muted ? 0 : Math.max(0, Math.min(1, Number(this.config.masterVolume ?? 75) / 100));
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.04);
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      this.applyMasterGain();
      if (this.muted) {
        this.stopTension();
        this.stopBGM();
      } else if (this.config.bgmEnabled && this.ctx) {
        this.startBGM();
      }
    }

    setConfig(nextConfig = {}, autoStartBgm = true) {
      const prevPreset = this.config.soundPreset;
      const prevBgm = this.config.bgmEnabled;
      this.config = {
        bgmEnabled: nextConfig.bgmEnabled !== undefined ? Boolean(nextConfig.bgmEnabled) : this.config.bgmEnabled,
        soundPreset: nextConfig.soundPreset || this.config.soundPreset || 'cyber-flight',
        masterVolume:
          nextConfig.masterVolume !== undefined
            ? Math.max(0, Math.min(100, Number(nextConfig.masterVolume)))
            : this.config.masterVolume,
      };
      this.applyMasterGain();

      if (!this.config.bgmEnabled || this.muted) {
        this.stopBGM();
      } else if (autoStartBgm && this.ctx && (!this.bgmRunning || prevPreset !== this.config.soundPreset || !prevBgm)) {
        this.startBGM();
      }
    }

    // ========================================================================
    // Background Music Sequencer (4 Synthesized Presets)
    // ========================================================================
    startBGM(forcePreset = null) {
      if (this.muted) return;
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
            : this.config.soundPreset === 'stealth-minimal'
              ? 240
              : 175;

      const tick = () => {
        if (!this.bgmRunning || this.muted || !this.ctx || this.ctx.state !== 'running') return;
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

      if (preset === 'cyber-flight') {
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
    // Game Sound Effects
    // ========================================================================
    playClick() {
      if (this.muted) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(620, now);
      osc.frequency.exponentialRampToValueAtTime(310, now + 0.05);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.065);
    }

    // High-Energy Casino Chime (Bet placed / Admin test)
    playCasinoChime() {
      if (this.muted) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const now = ctx.currentTime;
      const notes = [880, 1174.66, 1318.51];
      notes.forEach((freq, i) => {
        const start = now + i * 0.055;
        this.playTone(freq, 'sine', start, 0.24, 0.11);
        this.playTone(freq * 2, 'triangle', start, 0.14, 0.035);
      });
    }

    playWingFlap() {
      if (this.muted) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const nowMs = performance.now();
      if (nowMs - this.lastFlapAt < 310) return;
      this.lastFlapAt = nowMs;

      const t = ctx.currentTime;
      const bufferSize = Math.floor(ctx.sampleRate * 0.11);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(540, t);
      filter.frequency.exponentialRampToValueAtTime(280, t + 0.1);
      filter.Q.value = 1.8;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.075, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.11);

      noise.connect(filter).connect(gain).connect(dest);
      noise.start(t);

      const thump = ctx.createOscillator();
      const thumpGain = ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(115, t);
      thump.frequency.exponentialRampToValueAtTime(56, t + 0.07);
      thumpGain.gain.setValueAtTime(0.04, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      thump.connect(thumpGain).connect(dest);
      thump.start(t);
      thump.stop(t + 0.09);
    }

    startTension() {
      if (this.muted) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      this.stopTension();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const harmonic = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = this.config.soundPreset === 'turbo-arcade' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(165, now);

      harmonic.type = 'sine';
      harmonic.frequency.setValueAtTime(330, now);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(480, now);
      filter.Q.value = 2.4;

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.042, now + 0.25);

      osc.connect(filter);
      harmonic.connect(filter);
      filter.connect(gain).connect(dest);

      osc.start(now);
      harmonic.start(now);
      this.tensionOsc = osc;
      this.tensionHarmonic = harmonic;
      this.tensionFilter = filter;
      this.tensionGain = gain;
    }

    updateTension(mult) {
      if (!this.tensionOsc || !this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const baseFreq = Math.min(720, 165 + (mult - 1) * 46);
      const cutoff = Math.min(2900, 480 + (mult - 1) * 235);
      this.tensionOsc.frequency.setTargetAtTime(baseFreq, t, 0.05);
      this.tensionHarmonic?.frequency.setTargetAtTime(baseFreq * 1.5, t, 0.05);
      this.tensionFilter?.frequency.setTargetAtTime(cutoff, t, 0.06);
    }

    stopTension() {
      if (this.tensionGain && this.ctx) {
        try {
          const t = this.ctx.currentTime;
          this.tensionGain.gain.setTargetAtTime(0.0001, t, 0.03);
          this.tensionOsc?.stop(t + 0.09);
          this.tensionHarmonic?.stop(t + 0.09);
        } catch {
          // ignore
        }
      }
      this.tensionOsc = null;
      this.tensionHarmonic = null;
      this.tensionFilter = null;
      this.tensionGain = null;
    }

    // Victory Arpeggio (Cashout Win)
    playCashout() {
      if (this.muted) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const notes = [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98];
      const base = ctx.currentTime;
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const shimmer = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        shimmer.type = 'triangle';
        const start = base + idx * 0.042;
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

    // Crash Explosion 2.0 (4-layer fly-away blast)
    playCrash() {
      this.stopTension();
      if (this.muted) return;
      const ctx = this.ensureContext();
      const dest = this.getDestination();
      if (!ctx || !dest) return;
      const t = ctx.currentTime;

      // 1. Sub-bass impact drop
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(165, t);
      sub.frequency.exponentialRampToValueAtTime(30, t + 0.44);
      subGain.gain.setValueAtTime(0.28, t);
      subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
      sub.connect(subGain).connect(dest);
      sub.start(t);
      sub.stop(t + 0.5);

      // 2. Filtered explosion roar burst
      const bufferSize = Math.floor(ctx.sampleRate * 0.42);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.35);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(2400, t);
      noiseFilter.frequency.exponentialRampToValueAtTime(140, t + 0.4);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.2, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
      noise.connect(noiseFilter).connect(noiseGain).connect(dest);
      noise.start(t);

      // 3. Descending turbine fly-away sweep
      const sweep = ctx.createOscillator();
      const sweepGain = ctx.createGain();
      sweep.type = 'sawtooth';
      sweep.frequency.setValueAtTime(480, t);
      sweep.frequency.exponentialRampToValueAtTime(52, t + 0.48);
      sweepGain.gain.setValueAtTime(0.095, t);
      sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      sweep.connect(sweepGain).connect(dest);
      sweep.start(t);
      sweep.stop(t + 0.52);

      // 4. Metallic shatter transient
      [1480, 1975].forEach((freq, idx) => {
        this.playTone(freq, 'triangle', t + idx * 0.02, 0.14, 0.06);
      });
    }
  }

  window.SkyWingAudioEngine = SkyWingAudioEngine;
})();
