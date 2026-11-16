/* global io */
(() => {
  'use strict';

  const MULTIPLIER_GROWTH_RATE = 0.068;
  const PK_PHONE_REGEX = /^03[0-9]{9}$/;

  // ==========================================================================
  // Application State
  // ==========================================================================
  const state = {
    token: localStorage.getItem('skywing_token') || '',
    user: null,
    currencyMode: localStorage.getItem('skywing_mode') === 'real' ? 'real' : 'fun',
    publicSettings: {
      whatsappSupportNumber: '923001234567',
      whatsappChannelUrl: 'https://whatsapp.com/channel/0029VaSkyWingOfficial',
      paymentAccounts: null,
    },
    soundEnabled: localStorage.getItem('skywing_sound') !== 'off',
    sidebarTab: 'live', // 'live' | 'mine' | 'wallet'
    transactions: [],
    depositScreenshotData: '',
    deferredInstallPrompt: null,

    game: {
      phase: 'BETTING',
      roundNumber: 0,
      bettingEndsAt: Date.now() + 5000,
      flightStartedAt: 0,
      currentMultiplier: 1.0,
      crashPoint: 1.0,
      serverSeedHash: '',
      serverSeed: '',
      clientSeed: '',
      nonce: 0,
      bets: [],
      history: [],
    },

    panels: {
      1: { mode: 'manual', placedBet: null, queued: false, autoBet: false },
      2: { mode: 'manual', placedBet: null, queued: false, autoBet: false },
    },
  };

  // ==========================================================================
  // Web Audio API Synthesizer (Zero External Assets)
  // ==========================================================================
  class SoundEngine {
    constructor() {
      this.ctx = null;
      this.tensionOsc = null;
      this.tensionHarmonic = null;
      this.tensionFilter = null;
      this.tensionGain = null;
      this.lastFlapAt = 0;
    }

    ensureContext() {
      if (!state.soundEnabled) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    playClick() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(580, now);
      osc.frequency.exponentialRampToValueAtTime(290, now + 0.055);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }

    playWingFlap() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = performance.now();
      if (now - this.lastFlapAt < 320) return;
      this.lastFlapAt = now;

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
      filter.frequency.setValueAtTime(520, t);
      filter.frequency.exponentialRampToValueAtTime(280, t + 0.1);
      filter.Q.value = 1.8;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.065, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.11);

      noise.connect(filter).connect(gain).connect(ctx.destination);
      noise.start(t);

      const thump = ctx.createOscillator();
      const thumpGain = ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(110, t);
      thump.frequency.exponentialRampToValueAtTime(55, t + 0.07);
      thumpGain.gain.setValueAtTime(0.035, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      thump.connect(thumpGain).connect(ctx.destination);
      thump.start(t);
      thump.stop(t + 0.09);
    }

    startTension() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      this.stopTension();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const harmonic = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(165, now);

      harmonic.type = 'sine';
      harmonic.frequency.setValueAtTime(330, now);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(480, now);
      filter.Q.value = 2.2;

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.034, now + 0.25);

      osc.connect(filter);
      harmonic.connect(filter);
      filter.connect(gain).connect(ctx.destination);

      osc.start(now);
      harmonic.start(now);
      this.tensionOsc = osc;
      this.tensionHarmonic = harmonic;
      this.tensionFilter = filter;
      this.tensionGain = gain;
    }

    updateTension(mult) {
      if (!this.tensionOsc || !this.ctx || !state.soundEnabled) return;
      const t = this.ctx.currentTime;
      const baseFreq = Math.min(680, 165 + (mult - 1) * 44);
      const cutoff = Math.min(2600, 480 + (mult - 1) * 220);
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

    playCashout() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const notes = [523.25, 659.25, 783.99, 987.77, 1046.5];
      const base = ctx.currentTime;
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const shimmer = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        shimmer.type = 'triangle';
        const start = base + idx * 0.045;
        osc.frequency.setValueAtTime(freq, start);
        shimmer.frequency.setValueAtTime(freq * 2, start);
        gain.gain.setValueAtTime(0.085, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
        osc.connect(gain);
        shimmer.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        shimmer.start(start);
        osc.stop(start + 0.3);
        shimmer.stop(start + 0.3);
      });
    }

    playCrash() {
      this.stopTension();
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;

      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(140, t);
      sub.frequency.exponentialRampToValueAtTime(34, t + 0.38);
      subGain.gain.setValueAtTime(0.22, t);
      subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
      sub.connect(subGain).connect(ctx.destination);
      sub.start(t);
      sub.stop(t + 0.43);

      const bufferSize = Math.floor(ctx.sampleRate * 0.36);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.5);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(1800, t);
      noiseFilter.frequency.exponentialRampToValueAtTime(160, t + 0.34);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.16, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
      noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
      noise.start(t);

      const sweep = ctx.createOscillator();
      const sweepGain = ctx.createGain();
      sweep.type = 'sawtooth';
      sweep.frequency.setValueAtTime(420, t);
      sweep.frequency.exponentialRampToValueAtTime(58, t + 0.44);
      sweepGain.gain.setValueAtTime(0.075, t);
      sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      sweep.connect(sweepGain).connect(ctx.destination);
      sweep.start(t);
      sweep.stop(t + 0.46);
    }
  }

  const audio = new SoundEngine();

  // ==========================================================================
  // DOM References
  // ==========================================================================
  const el = {
    modeFunBtn: document.getElementById('modeFunBtn'),
    modeRealBtn: document.getElementById('modeRealBtn'),
    walletBalance: document.getElementById('walletBalanceDisplay'),
    walletModeLabel: document.getElementById('walletModeLabel'),
    installAppBtn: document.getElementById('installAppBtn'),
    soundToggleBtn: document.getElementById('soundToggleBtn'),
    soundOnIcon: document.getElementById('soundOnIcon'),
    soundOffIcon: document.getElementById('soundOffIcon'),
    soundStatusLabel: document.getElementById('soundStatusLabel'),
    authTriggerBtn: document.getElementById('authTriggerBtn'),
    funModeNotice: document.getElementById('funModeNotice'),
    realModeNotice: document.getElementById('realModeNotice'),
    realWalletActions: document.getElementById('realWalletActions'),
    openDepositBtn: document.getElementById('openDepositBtn'),
    openWithdrawBtn: document.getElementById('openWithdrawBtn'),
    officialAppBanner: document.getElementById('officialAppBanner'),
    onlineCount: document.getElementById('onlinePlayersCount'),
    userAccountLabel: document.getElementById('userAccountLabel'),
    historyList: document.getElementById('historyList'),

    canvas: document.getElementById('flightCanvas'),
    hudRoundNumber: document.getElementById('hudRoundNumber'),
    hudSeedShort: document.getElementById('hudSeedShort'),
    roundSeedHudBtn: document.getElementById('roundSeedHudBtn'),
    toastContainer: document.getElementById('toastContainer'),

    bettingOverlay: document.getElementById('bettingOverlay'),
    countdownTimerText: document.getElementById('countdownTimerText'),
    countdownBarFill: document.getElementById('countdownBarFill'),
    bettingModeHint: document.getElementById('bettingModeHint'),
    flyingOverlay: document.getElementById('flyingOverlay'),
    liveMultiplierText: document.getElementById('liveMultiplierText'),
    crashBannerText: document.getElementById('crashBannerText'),

    tabLiveBets: document.getElementById('tabLiveBets'),
    tabMyBets: document.getElementById('tabMyBets'),
    tabWalletHistory: document.getElementById('tabWalletHistory'),
    sidebarTableHead: document.getElementById('sidebarTableHead'),
    activeBetsCount: document.getElementById('activeBetsCount'),
    totalRoundWager: document.getElementById('totalRoundWager'),
    sidebarBetsList: document.getElementById('sidebarBetsList'),

    // Auth Modal
    authModal: document.getElementById('authModal'),
    authTabLogin: document.getElementById('authTabLogin'),
    authTabRegister: document.getElementById('authTabRegister'),
    authErrorBox: document.getElementById('authErrorBox'),
    loginForm: document.getElementById('loginForm'),
    loginPhone: document.getElementById('loginPhone'),
    loginPassword: document.getElementById('loginPassword'),
    forgotPasswordBtn: document.getElementById('forgotPasswordBtn'),
    registerForm: document.getElementById('registerForm'),
    regPhone: document.getElementById('regPhone'),
    regName: document.getElementById('regName'),
    regPassword: document.getElementById('regPassword'),

    // Profile Modal
    profileModal: document.getElementById('profileModal'),
    profilePhone: document.getElementById('profilePhone'),
    profileName: document.getElementById('profileName'),
    profileFunBalance: document.getElementById('profileFunBalance'),
    profileRealBalance: document.getElementById('profileRealBalance'),
    profileDeposited: document.getElementById('profileDeposited'),
    profileWithdrawn: document.getElementById('profileWithdrawn'),
    profileDepositBtn: document.getElementById('profileDepositBtn'),
    profileWithdrawBtn: document.getElementById('profileWithdrawBtn'),
    profileChannelBtn: document.getElementById('profileChannelBtn'),
    logoutBtn: document.getElementById('logoutBtn'),

    // Deposit Modal
    depositModal: document.getElementById('depositModal'),
    depositAccountsList: document.getElementById('depositAccountsList'),
    depositErrorBox: document.getElementById('depositErrorBox'),
    depositSuccessBox: document.getElementById('depositSuccessBox'),
    depositForm: document.getElementById('depositForm'),
    depMethod: document.getElementById('depMethod'),
    depAmount: document.getElementById('depAmount'),
    depTid: document.getElementById('depTid'),
    depScreenshot: document.getElementById('depScreenshot'),
    depPreviewWrap: document.getElementById('depPreviewWrap'),
    depPreviewImg: document.getElementById('depPreviewImg'),
    depClearImgBtn: document.getElementById('depClearImgBtn'),
    depSubmitBtn: document.getElementById('depSubmitBtn'),

    // Withdraw Modal
    withdrawModal: document.getElementById('withdrawModal'),
    withdrawAvailBalance: document.getElementById('withdrawAvailBalance'),
    withdrawErrorBox: document.getElementById('withdrawErrorBox'),
    withdrawSuccessBox: document.getElementById('withdrawSuccessBox'),
    withdrawForm: document.getElementById('withdrawForm'),
    wdMethod: document.getElementById('wdMethod'),
    wdAmount: document.getElementById('wdAmount'),
    wdBankNameGroup: document.getElementById('wdBankNameGroup'),
    wdBankName: document.getElementById('wdBankName'),
    wdAccountTitle: document.getElementById('wdAccountTitle'),
    wdAccountNumber: document.getElementById('wdAccountNumber'),
    wdSubmitBtn: document.getElementById('wdSubmitBtn'),

    channelModal: document.getElementById('channelModal'),
    whatsappChannelDirectLink: document.getElementById('whatsappChannelDirectLink'),

    fairModal: document.getElementById('fairModal'),
    fairRoundHeading: document.getElementById('fairRoundHeading'),
    fairSeedDetails: document.getElementById('fairSeedDetails'),
    fairVerifyResult: document.getElementById('fairVerifyResult'),

    howToModal: document.getElementById('howToModal'),
  };

  // ==========================================================================
  // Helpers & Modals
  // ==========================================================================
  function unitLabel(mode = state.currencyMode) {
    return mode === 'real' ? 'PKR' : 'FC';
  }

  function fmtMoney(val, mode = state.currencyMode) {
    return `${Number(val || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${unitLabel(mode)}`;
  }

  function normalizePakPhone(raw) {
    return String(raw || '')
      .replace(/[\s\-()]/g, '')
      .trim();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('open');
  }

  function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('open');
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.remove('open');
    });
  });

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = 'cashout-toast';
    if (isError) {
      toast.style.background = 'rgba(239, 68, 68, 0.94)';
      toast.style.color = '#fff';
      toast.style.boxShadow = '0 10px 28px rgba(239, 68, 68, 0.35)';
    }
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  // ==========================================================================
  // PWA Service Worker & App Installation
  // ==========================================================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  function isStandaloneMode() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function syncInstallButton() {
    if (!el.installAppBtn) return;
    if (isStandaloneMode()) {
      el.installAppBtn.classList.add('hidden');
    } else {
      el.installAppBtn.classList.remove('hidden');
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    syncInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    syncInstallButton();
    showToast('SkyWing app installed on your device!');
  });

  if (el.installAppBtn) {
    el.installAppBtn.addEventListener('click', async () => {
      if (state.deferredInstallPrompt) {
        state.deferredInstallPrompt.prompt();
        const choice = await state.deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          state.deferredInstallPrompt = null;
          syncInstallButton();
        }
      } else {
        openModal('iosInstallModal');
      }
    });
  }
  syncInstallButton();

  // ==========================================================================
  // Sound Toggle
  // ==========================================================================
  function updateSoundUI() {
    el.soundToggleBtn.classList.toggle('active', state.soundEnabled);
    el.soundToggleBtn.setAttribute('aria-pressed', String(state.soundEnabled));
    el.soundOnIcon.classList.toggle('hidden', !state.soundEnabled);
    el.soundOffIcon.classList.toggle('hidden', state.soundEnabled);
    if (el.soundStatusLabel) {
      el.soundStatusLabel.textContent = state.soundEnabled ? 'SFX On' : 'Muted';
    }
  }

  el.soundToggleBtn.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('skywing_sound', state.soundEnabled ? 'on' : 'off');
    if (state.soundEnabled) {
      audio.ensureContext();
      audio.playClick();
      if (state.game.phase === 'FLYING') audio.startTension();
    } else {
      audio.stopTension();
    }
    updateSoundUI();
  });
  updateSoundUI();

  // ==========================================================================
  // Currency Mode Switcher (Fun Mode FC <-> Real Money Mode PKR)
  // ==========================================================================
  function setCurrencyMode(mode) {
    state.currencyMode = mode === 'real' ? 'real' : 'fun';
    localStorage.setItem('skywing_mode', state.currencyMode);
    updateModeAndWalletUI();
    updatePanelButtons();
    renderSidebar();
  }

  function updateModeAndWalletUI() {
    const isReal = state.currencyMode === 'real';
    el.modeFunBtn.className = `mode-btn ${!isReal ? 'active-fun' : ''}`;
    el.modeRealBtn.className = `mode-btn ${isReal ? 'active-real' : ''}`;

    el.funModeNotice.classList.toggle('hidden', isReal);
    el.realModeNotice.classList.toggle('hidden', !isReal);
    el.realWalletActions.classList.toggle('hidden', !isReal);

    el.walletBalance.classList.toggle('real-active', isReal);
    el.walletModeLabel.textContent = isReal ? 'Real PKR' : 'Fun Credits';
    el.bettingModeHint.textContent = isReal
      ? 'Place your Real Money (PKR) bets'
      : 'Place your Fun Credits (FC) bets';

    if (state.user) {
      const bal = isReal ? state.user.realBalance : state.user.funBalance;
      el.walletBalance.textContent = fmtMoney(bal, state.currencyMode);
    } else {
      el.walletBalance.textContent = isReal ? '0.00 PKR' : '0.00 FC';
    }
  }

  el.modeFunBtn.addEventListener('click', () => {
    audio.playClick();
    setCurrencyMode('fun');
  });
  el.modeRealBtn.addEventListener('click', () => {
    audio.playClick();
    setCurrencyMode('real');
  });

  // ==========================================================================
  // Public Settings & Admin Payment Accounts
  // ==========================================================================
  async function loadPublicSettings() {
    try {
      const res = await fetch('/api/public-settings');
      if (res.ok) {
        const data = await res.json();
        state.publicSettings = {
          whatsappSupportNumber: data.whatsappSupportNumber || '923001234567',
          whatsappChannelUrl: data.whatsappChannelUrl || '#',
          paymentAccounts: data.paymentAccounts || null,
        };
        syncChannelLinks();
        renderPaymentAccounts();
      }
    } catch {
      // ignore
    }
  }

  function syncChannelLinks() {
    el.whatsappChannelDirectLink.href = state.publicSettings.whatsappChannelUrl || '#';
  }

  function renderPaymentAccounts() {
    const acc = state.publicSettings.paymentAccounts;
    if (!acc) {
      el.depositAccountsList.innerHTML =
        '<span class="form-hint">Payment accounts not configured yet. Contact Admin.</span>';
      return;
    }

    const cards = [];
    if (acc.easypaisa?.enabled) {
      cards.push({
        label: 'EasyPaisa',
        title: acc.easypaisa.accountTitle,
        number: acc.easypaisa.accountNumber,
        color: '#34d399',
      });
    }
    if (acc.jazzcash?.enabled) {
      cards.push({
        label: 'JazzCash',
        title: acc.jazzcash.accountTitle,
        number: acc.jazzcash.accountNumber,
        color: '#f87171',
      });
    }
    if (acc.bank?.enabled) {
      cards.push({
        label: acc.bank.bankName ? `Bank (${acc.bank.bankName})` : 'Bank Account',
        title: acc.bank.accountTitle,
        number: acc.bank.accountNumber,
        color: '#38bdf8',
      });
    }

    if (!cards.length) {
      el.depositAccountsList.innerHTML =
        '<span class="form-hint">Deposits are currently paused by Admin.</span>';
      return;
    }

    el.depositAccountsList.innerHTML = cards
      .map(
        (c) => `
      <div class="pay-account-card">
        <div class="pay-account-row">
          <strong style="color: ${c.color}; font-size: 0.88rem;">${escapeHtml(c.label)}</strong>
          <span style="font-size: 0.78rem; color: var(--text-secondary);">Title: <strong style="color: var(--text-primary);">${escapeHtml(c.title)}</strong></span>
        </div>
        <div class="pay-account-row">
          <span class="tabular-nums" style="font-size: 0.9rem; font-weight: 700; color: var(--text-primary);">${escapeHtml(c.number)}</span>
          <button type="button" class="copy-btn" data-copy="${escapeHtml(c.number)}">Copy</button>
        </div>
      </div>
    `
      )
      .join('');

    el.depositAccountsList.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const val = btn.dataset.copy;
        try {
          await navigator.clipboard.writeText(val);
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = 'Copy';
          }, 1400);
        } catch {
          showToast(`Account: ${val}`);
        }
      });
    });
  }

  document.getElementById('openHowToBtn').addEventListener('click', () => openModal('howToModal'));
  document.getElementById('footerHowToBtn').addEventListener('click', () => openModal('howToModal'));
  document.getElementById('openChannelBtn').addEventListener('click', () => {
    syncChannelLinks();
    openModal('channelModal');
  });
  document.getElementById('footerChannelBtn').addEventListener('click', () => {
    syncChannelLinks();
    openModal('channelModal');
  });
  el.profileChannelBtn.addEventListener('click', () => {
    closeModal('profileModal');
    syncChannelLinks();
    openModal('channelModal');
  });

  // ==========================================================================
  // Provably Fair Verification Modal
  // ==========================================================================
  async function inspectFairRound(roundObj) {
    const r = roundObj || {
      roundNumber: state.game.roundNumber,
      serverSeedHash: state.game.serverSeedHash,
      serverSeed: state.game.serverSeed,
      clientSeed: state.game.clientSeed,
      nonce: state.game.nonce,
      crashPoint: state.game.phase === 'CRASHED' ? state.game.crashPoint : null,
    };

    el.fairRoundHeading.textContent = `Flight #${r.roundNumber || '---'}`;
    el.fairSeedDetails.innerHTML = `
      <div><strong>Server Seed Hash (SHA-256):</strong><br/>${r.serverSeedHash || '---'}</div>
      <div style="margin-top:8px;"><strong>Revealed Server Seed:</strong><br/>${r.serverSeed || 'Hidden until flight finishes'}</div>
      <div style="margin-top:8px;"><strong>Client Seed:</strong> ${r.clientSeed || '---'}</div>
      <div style="margin-top:4px;"><strong>Nonce:</strong> ${r.nonce || '---'}</div>
      ${r.crashPoint ? `<div style="margin-top:4px;"><strong>Crash Point:</strong> ${Number(r.crashPoint).toFixed(2)}x</div>` : ''}
    `;

    el.fairVerifyResult.classList.add('hidden');
    if (r.serverSeed && window.crypto?.subtle) {
      try {
        const enc = new TextEncoder();
        const digest = await crypto.subtle.digest('SHA-256', enc.encode(r.serverSeed));
        const hexHash = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const matched = hexHash === r.serverSeedHash;
        el.fairVerifyResult.textContent = matched
          ? 'Verified: SHA-256(ServerSeed) matches the pre-round commitment hash.'
          : 'Hash mismatch detected.';
        el.fairVerifyResult.className = matched ? 'alert-success' : 'alert-error';
        el.fairVerifyResult.classList.remove('hidden');
      } catch {
        // ignore if non-secure context
      }
    }

    openModal('fairModal');
  }

  document.getElementById('openFairBtn').addEventListener('click', () => inspectFairRound(null));
  document.getElementById('footerFairBtn').addEventListener('click', () => inspectFairRound(null));
  el.roundSeedHudBtn.addEventListener('click', () => inspectFairRound(null));

  // ==========================================================================
  // Authentication & User Profile
  // ==========================================================================
  function updateUserUI() {
    if (state.user) {
      el.authTriggerBtn.textContent = state.user.displayName || state.user.phoneNumber;
      el.authTriggerBtn.classList.remove('btn-primary');
      el.authTriggerBtn.classList.add('btn-secondary');
      el.userAccountLabel.textContent = `Logged in · ${state.user.phoneNumber}`;

      el.profilePhone.textContent = state.user.phoneNumber;
      el.profileName.textContent = state.user.displayName;
      el.profileFunBalance.textContent = fmtMoney(state.user.funBalance, 'fun');
      el.profileRealBalance.textContent = fmtMoney(state.user.realBalance, 'real');
      el.profileDeposited.textContent = fmtMoney(state.user.totalDeposited, 'real');
      el.profileWithdrawn.textContent = fmtMoney(state.user.totalWithdrawn, 'real');
      el.withdrawAvailBalance.textContent = fmtMoney(state.user.realBalance, 'real');
    } else {
      el.authTriggerBtn.textContent = 'Log In / Join';
      el.authTriggerBtn.classList.remove('btn-secondary');
      el.authTriggerBtn.classList.add('btn-primary');
      el.userAccountLabel.textContent = 'Guest Mode';
    }
    if (el.officialAppBanner) {
      el.officialAppBanner.classList.toggle('hidden', !state.user);
    }
    updateModeAndWalletUI();
    if (state.sidebarTab !== 'live') renderSidebar();
    updatePanelButtons();
  }

  async function fetchCurrentUser() {
    if (!state.token) {
      state.user = null;
      state.transactions = [];
      updateUserUI();
      return;
    }
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!res.ok) {
        state.token = '';
        state.user = null;
        localStorage.removeItem('skywing_token');
        updateUserUI();
        return;
      }
      const data = await res.json();
      state.user = data.user;
      if (data.publicSettings) {
        state.publicSettings = data.publicSettings;
        syncChannelLinks();
        renderPaymentAccounts();
      }
      updateUserUI();
    } catch {
      // silent on network hiccup
    }
  }

  async function fetchMyTransactions() {
    if (!state.token) {
      state.transactions = [];
      renderSidebar();
      return;
    }
    try {
      const res = await fetch('/api/transactions/my', {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        state.transactions = data.transactions || [];
        if (state.sidebarTab === 'wallet') renderSidebar();
      }
    } catch {
      // ignore
    }
  }

  el.authTriggerBtn.addEventListener('click', () => {
    if (state.user) {
      openModal('profileModal');
    } else {
      el.authErrorBox.classList.add('hidden');
      openModal('authModal');
    }
  });

  el.authTabLogin.addEventListener('click', () => {
    el.authTabLogin.classList.add('active');
    el.authTabRegister.classList.remove('active');
    el.loginForm.classList.remove('hidden');
    el.registerForm.classList.add('hidden');
    el.authErrorBox.classList.add('hidden');
  });

  el.authTabRegister.addEventListener('click', () => {
    el.authTabRegister.classList.add('active');
    el.authTabLogin.classList.remove('active');
    el.registerForm.classList.remove('hidden');
    el.loginForm.classList.add('hidden');
    el.authErrorBox.classList.add('hidden');
  });

  function showAuthError(msg) {
    el.authErrorBox.textContent = msg;
    el.authErrorBox.classList.remove('hidden');
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.authErrorBox.classList.add('hidden');
    const cleanPhone = normalizePakPhone(el.loginPhone.value);
    if (!cleanPhone) {
      showAuthError('Enter your mobile number or username.');
      return;
    }
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          password: el.loginPassword.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthError(data.error || 'Login failed.');
        return;
      }
      if (data.isAdmin && data.adminToken) {
        localStorage.setItem('skywing_admin_token', data.adminToken);
        closeModal('authModal');
        showToast('Admin authenticated — opening Operations Console...');
        setTimeout(() => {
          window.location.href = data.redirectUrl || '/admin';
        }, 350);
        return;
      }
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('skywing_token', data.token);
      if (data.whatsappChannelUrl) {
        state.publicSettings.whatsappChannelUrl = data.whatsappChannelUrl;
        syncChannelLinks();
      }
      socket.emit('auth:identify', { token: state.token });
      updateUserUI();
      fetchMyTransactions();
      closeModal('authModal');
      showToast(`Welcome back, ${state.user.displayName}!`);
    } catch {
      showAuthError('Network error. Please try again.');
    }
  });

  el.registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.authErrorBox.classList.add('hidden');
    const cleanPhone = normalizePakPhone(el.regPhone.value);
    if (!PK_PHONE_REGEX.test(cleanPhone)) {
      showAuthError('Enter a valid 11-digit Pakistani mobile number starting with 03 (e.g. 03001234567).');
      return;
    }
    if ((el.regPassword.value || '').length < 6) {
      showAuthError('Password must be at least 6 characters.');
      return;
    }
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          displayName: el.regName.value,
          password: el.regPassword.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthError(data.error || 'Registration failed.');
        return;
      }
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('skywing_token', data.token);
      if (data.whatsappChannelUrl) {
        state.publicSettings.whatsappChannelUrl = data.whatsappChannelUrl;
        syncChannelLinks();
      }
      socket.emit('auth:identify', { token: state.token });
      updateUserUI();
      fetchMyTransactions();
      closeModal('authModal');
      openModal('channelModal');
    } catch {
      showAuthError('Network error. Please try again.');
    }
  });

  el.forgotPasswordBtn.addEventListener('click', () => {
    const cleanPhone = normalizePakPhone(el.loginPhone.value);
    const supportNum = String(state.publicSettings.whatsappSupportNumber || '923001234567').replace(
      /\D/g,
      ''
    );
    const phoneDisplay = cleanPhone || '[My 03XX Mobile Number]';
    const text = `Assalam-o-Alaikum Admin, please reset my password for SkyWing Crash. Registered Mobile Number: ${phoneDisplay}`;
    const url = `https://wa.me/${supportNum}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  el.logoutBtn.addEventListener('click', () => {
    state.token = '';
    state.user = null;
    state.transactions = [];
    localStorage.removeItem('skywing_token');
    socket.emit('auth:identify', { token: '' });
    closeModal('profileModal');
    updateUserUI();
    showToast('Logged out successfully.');
  });

  // ==========================================================================
  // Real Money PKR Deposit & Withdrawal Flows
  // ==========================================================================
  function openDepositFlow() {
    if (!state.user) {
      openModal('authModal');
      return;
    }
    el.depositErrorBox.classList.add('hidden');
    el.depositSuccessBox.classList.add('hidden');
    renderPaymentAccounts();
    openModal('depositModal');
  }

  function openWithdrawFlow() {
    if (!state.user) {
      openModal('authModal');
      return;
    }
    el.withdrawErrorBox.classList.add('hidden');
    el.withdrawSuccessBox.classList.add('hidden');
    el.withdrawAvailBalance.textContent = fmtMoney(state.user.realBalance, 'real');
    openModal('withdrawModal');
  }

  el.openDepositBtn.addEventListener('click', openDepositFlow);
  el.openWithdrawBtn.addEventListener('click', openWithdrawFlow);
  el.profileDepositBtn.addEventListener('click', () => {
    closeModal('profileModal');
    openDepositFlow();
  });
  el.profileWithdrawBtn.addEventListener('click', () => {
    closeModal('profileModal');
    openWithdrawFlow();
  });

  // Compress uploaded payment screenshot cleanly into JPEG base64
  el.depScreenshot.addEventListener('change', () => {
    const file = el.depScreenshot.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      el.depositErrorBox.textContent = 'Please select an image file (JPG/PNG).';
      el.depositErrorBox.classList.remove('hidden');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const off = document.createElement('canvas');
        off.width = width;
        off.height = height;
        const octx = off.getContext('2d');
        octx.drawImage(img, 0, 0, width, height);
        const compressed = off.toDataURL('image/jpeg', 0.78);
        state.depositScreenshotData = compressed;
        el.depPreviewImg.src = compressed;
        el.depPreviewWrap.classList.remove('hidden');
        el.depositErrorBox.classList.add('hidden');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  el.depClearImgBtn.addEventListener('click', () => {
    state.depositScreenshotData = '';
    el.depScreenshot.value = '';
    el.depPreviewImg.src = '';
    el.depPreviewWrap.classList.add('hidden');
  });

  el.depositForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.depositErrorBox.classList.add('hidden');
    el.depositSuccessBox.classList.add('hidden');

    const amount = Number(el.depAmount.value);
    const method = el.depMethod.value;
    const transactionId = el.depTid.value.trim();
    const screenshotData = state.depositScreenshotData;

    if (!transactionId && !screenshotData) {
      el.depositErrorBox.textContent =
        'Please attach EITHER a Payment Screenshot OR enter a Transaction ID (TID).';
      el.depositErrorBox.classList.remove('hidden');
      return;
    }

    el.depSubmitBtn.disabled = true;
    try {
      const res = await fetch('/api/transactions/deposit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ amount, method, transactionId, screenshotData }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.depositErrorBox.textContent = data.error || 'Failed to submit deposit.';
        el.depositErrorBox.classList.remove('hidden');
        return;
      }

      el.depositSuccessBox.textContent =
        'Deposit proof submitted! Admin has been notified for instant verification.';
      el.depositSuccessBox.classList.remove('hidden');
      el.depositForm.reset();
      state.depositScreenshotData = '';
      el.depPreviewWrap.classList.add('hidden');
      fetchMyTransactions();
      showToast('Deposit request sent to Admin!');
    } catch {
      el.depositErrorBox.textContent = 'Network error. Please try again.';
      el.depositErrorBox.classList.remove('hidden');
    } finally {
      el.depSubmitBtn.disabled = false;
    }
  });

  el.wdMethod.addEventListener('change', () => {
    const isBank = el.wdMethod.value === 'Bank Account';
    el.wdBankNameGroup.classList.toggle('hidden', !isBank);
    el.wdBankName.required = isBank;
  });

  el.withdrawForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.withdrawErrorBox.classList.add('hidden');
    el.withdrawSuccessBox.classList.add('hidden');

    el.wdSubmitBtn.disabled = true;
    try {
      const res = await fetch('/api/transactions/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          method: el.wdMethod.value,
          amount: Number(el.wdAmount.value),
          bankName: el.wdBankName.value.trim(),
          accountTitle: el.wdAccountTitle.value.trim(),
          accountNumber: el.wdAccountNumber.value.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.withdrawErrorBox.textContent = data.error || 'Withdrawal failed.';
        el.withdrawErrorBox.classList.remove('hidden');
        return;
      }

      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      el.withdrawSuccessBox.textContent =
        'Withdrawal request submitted! Amount is reserved and will be processed by Admin.';
      el.withdrawSuccessBox.classList.remove('hidden');
      el.withdrawForm.reset();
      el.wdBankNameGroup.classList.add('hidden');
      fetchMyTransactions();
      showToast('Withdrawal request submitted!');
    } catch {
      el.withdrawErrorBox.textContent = 'Network error. Please try again.';
      el.withdrawErrorBox.classList.remove('hidden');
    } finally {
      el.wdSubmitBtn.disabled = false;
    }
  });

  // ==========================================================================
  // Dual Betting Panels (Side-by-Side Bet 1 & Bet 2, Auto Cashout Default OFF)
  // ==========================================================================
  function getPanelElements(slot) {
    return {
      amountInput: document.getElementById(`betAmount${slot}`),
      actionBtn: document.getElementById(`betActionBtn${slot}`),
      autoBetToggle: document.getElementById(`autoBetToggle${slot}`),
      autoCashoutToggle: document.getElementById(`autoCashoutToggle${slot}`),
      autoCashoutValue: document.getElementById(`autoCashoutValue${slot}`),
    };
  }

  function getBetAmount(slot) {
    const { amountInput } = getPanelElements(slot);
    const val = Math.round(Number(amountInput.value) * 100) / 100;
    return Number.isFinite(val) && val >= 1 ? val : 10;
  }

  function updatePanelButtons() {
    [1, 2].forEach((slot) => {
      const p = state.panels[slot];
      const { actionBtn, amountInput, autoCashoutToggle, autoCashoutValue } = getPanelElements(slot);
      const amt = getBetAmount(slot);
      const phase = state.game.phase;

      // Dim target input slightly when Auto Cashout is OFF for visual clarity
      if (autoCashoutValue) {
        autoCashoutValue.style.opacity = autoCashoutToggle.checked ? '1' : '0.45';
      }

      const activeBetMode = p.placedBet?.currencyMode || state.currencyMode;
      let stateClass = 'state-place';
      let mainText = 'PLACE BET';
      let subText = fmtMoney(amt, state.currencyMode);

      if (phase === 'BETTING') {
        if (p.placedBet) {
          stateClass = 'state-cancel';
          mainText = 'CANCEL';
          subText = fmtMoney(p.placedBet.amount, activeBetMode);
        } else {
          stateClass = 'state-place';
          mainText = 'PLACE BET';
          subText = fmtMoney(amt, state.currencyMode);
        }
      } else if (phase === 'FLYING') {
        if (p.placedBet && !p.placedBet.cashedOut) {
          const liveReturn = p.placedBet.amount * state.game.currentMultiplier;
          stateClass = 'state-cashout';
          mainText = 'CASH OUT';
          subText = fmtMoney(liveReturn, activeBetMode);
        } else if (p.queued) {
          stateClass = 'state-queued';
          mainText = 'QUEUED (CANCEL)';
          subText = fmtMoney(amt, state.currencyMode);
        } else {
          stateClass = 'state-place';
          mainText = 'BET NEXT';
          subText = fmtMoney(amt, state.currencyMode);
        }
      } else {
        if (p.queued) {
          stateClass = 'state-queued';
          mainText = 'QUEUED (CANCEL)';
          subText = fmtMoney(amt, state.currencyMode);
        } else {
          stateClass = 'state-wait';
          mainText = 'BET NEXT';
          subText = fmtMoney(amt, state.currencyMode);
        }
      }

      const targetClass = `bet-action-btn ${stateClass}`;
      if (actionBtn.className !== targetClass) {
        actionBtn.className = targetClass;
      }

      const mainEl = actionBtn.querySelector('.bet-action-main');
      const subEl = actionBtn.querySelector('.bet-action-sub');
      if (mainEl && subEl) {
        if (mainEl.textContent !== mainText) mainEl.textContent = mainText;
        if (subEl.textContent !== subText) subEl.textContent = subText;
      }

      const shouldDisable = Boolean(p.placedBet && phase === 'BETTING');
      if (amountInput.disabled !== shouldDisable) {
        amountInput.disabled = shouldDisable;
      }
    });
  }

  function placeBet(slot) {
    if (!state.user) {
      openModal('authModal');
      return;
    }
    const { autoCashoutToggle, autoCashoutValue } = getPanelElements(slot);
    const amount = getBetAmount(slot);
    // Strict ON/OFF behavior: ONLY send autoCashout if toggle is ON (checked)
    const autoCashout = autoCashoutToggle.checked ? Number(autoCashoutValue.value) : null;

    socket.emit(
      'bet:place',
      { slot, amount, autoCashout, currencyMode: state.currencyMode },
      (res) => {
        if (!res?.ok) {
          showToast(res?.error || 'Could not place bet.', true);
          return;
        }
        audio.playClick();
        state.panels[slot].placedBet = res.bet;
        state.panels[slot].queued = false;
        if (state.user) {
          if (res.funBalance !== undefined) state.user.funBalance = res.funBalance;
          if (res.realBalance !== undefined) state.user.realBalance = res.realBalance;
          updateUserUI();
        }
        updatePanelButtons();
      }
    );
  }

  function cancelBet(slot) {
    socket.emit('bet:cancel', { slot }, (res) => {
      if (!res?.ok) {
        showToast(res?.error || 'Cannot cancel bet.', true);
        return;
      }
      audio.playClick();
      state.panels[slot].placedBet = null;
      if (state.user) {
        if (res.funBalance !== undefined) state.user.funBalance = res.funBalance;
        if (res.realBalance !== undefined) state.user.realBalance = res.realBalance;
        updateUserUI();
      }
      updatePanelButtons();
    });
  }

  function cashOutBet(slot) {
    socket.emit('bet:cashout', { slot }, (res) => {
      if (!res?.ok) {
        showToast(res?.error || 'Cashout missed.', true);
        return;
      }
      audio.playCashout();
      if (state.panels[slot].placedBet) {
        state.panels[slot].placedBet.cashedOut = true;
        state.panels[slot].placedBet.cashoutMultiplier = res.cashoutMultiplier;
        state.panels[slot].placedBet.payout = res.payout;
      }
      showToast(
        `Cashed out ${res.cashoutMultiplier.toFixed(2)}x (+${fmtMoney(res.payout, res.currencyMode)})`
      );
      updatePanelButtons();
    });
  }

  [1, 2].forEach((slot) => {
    const { actionBtn, amountInput, autoBetToggle, autoCashoutToggle } = getPanelElements(slot);

    // Explicitly guarantee Auto Cashout starts OFF
    autoCashoutToggle.checked = false;

    actionBtn.addEventListener('click', () => {
      audio.ensureContext();
      const p = state.panels[slot];
      const phase = state.game.phase;

      if (phase === 'BETTING') {
        if (p.placedBet) cancelBet(slot);
        else placeBet(slot);
      } else if (phase === 'FLYING') {
        if (p.placedBet && !p.placedBet.cashedOut) {
          cashOutBet(slot);
        } else {
          if (!state.user) {
            openModal('authModal');
            return;
          }
          p.queued = !p.queued;
          audio.playClick();
          updatePanelButtons();
        }
      } else {
        if (!state.user) {
          openModal('authModal');
          return;
        }
        p.queued = !p.queued;
        audio.playClick();
        updatePanelButtons();
      }
    });

    amountInput.addEventListener('input', () => updatePanelButtons());
    autoCashoutToggle.addEventListener('change', () => updatePanelButtons());
    autoBetToggle.addEventListener('change', () => {
      state.panels[slot].autoBet = autoBetToggle.checked;
    });
  });

  document.querySelectorAll('.seg-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.dataset.panel);
      const mode = btn.dataset.mode;
      document
        .querySelectorAll(`.seg-btn[data-panel="${slot}"]`)
        .forEach((b) => b.classList.toggle('active', b === btn));
      state.panels[slot].mode = mode;
      const { autoBetToggle } = getPanelElements(slot);
      if (mode === 'auto' && !autoBetToggle.checked) {
        autoBetToggle.checked = true;
        state.panels[slot].autoBet = true;
      }
    });
  });

  document.querySelectorAll('.step-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.dataset.panel);
      const delta = Number(btn.dataset.step);
      const { amountInput } = getPanelElements(slot);
      const next = Math.max(
        1,
        Math.min(100000, Math.round((Number(amountInput.value || 0) + delta) * 100) / 100)
      );
      amountInput.value = next;
      updatePanelButtons();
    });
  });

  document.querySelectorAll('.preset-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.dataset.panel);
      const preset = btn.dataset.preset;
      const { amountInput } = getPanelElements(slot);
      let val = Number(amountInput.value || 50);
      if (preset === 'half') val = Math.max(1, Math.floor(val / 2));
      else if (preset === 'double') val = Math.min(100000, Math.round(val * 2));
      else val = Number(preset);
      amountInput.value = val;
      updatePanelButtons();
    });
  });

  // ==========================================================================
  // History & Sidebar Rendering (Live Bets | My Bets | Wallet History)
  // ==========================================================================
  function renderHistory() {
    const items = state.game.history.slice(0, 15);
    if (!items.length) {
      el.historyList.innerHTML =
        '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for flight history...</span>';
      return;
    }

    el.historyList.innerHTML = '';
    items.forEach((item) => {
      const mult = Number(item.crashPoint || 1);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `history-chip ${
        mult >= 10 ? 'mult-high' : mult >= 2 ? 'mult-med' : 'mult-low'
      }`;
      chip.textContent = `${mult.toFixed(2)}x`;
      chip.title = `Round #${item.roundNumber} — Click to verify Provably Fair seed`;
      chip.addEventListener('click', () => inspectFairRound(item));
      el.historyList.appendChild(chip);
    });
  }

  function renderSidebar() {
    if (state.sidebarTab === 'live') {
      el.sidebarTableHead.classList.remove('hidden');
      const bets = state.game.bets || [];
      const totalFun = bets
        .filter((b) => b.currencyMode !== 'real')
        .reduce((s, b) => s + Number(b.amount || 0), 0);
      const totalReal = bets
        .filter((b) => b.currencyMode === 'real')
        .reduce((s, b) => s + Number(b.amount || 0), 0);

      el.activeBetsCount.textContent = `${bets.length} Active Bet${bets.length === 1 ? '' : 's'}`;
      el.totalRoundWager.textContent =
        totalReal > 0 ? `${totalReal.toFixed(0)} PKR` : `${totalFun.toFixed(0)} FC`;

      if (!bets.length) {
        el.sidebarBetsList.innerHTML =
          '<div class="empty-state">No bets placed yet in this flight.</div>';
        return;
      }

      const sorted = bets.slice().sort((a, b) => b.amount - a.amount);
      el.sidebarBetsList.innerHTML = sorted
        .map((b) => {
          const isMe = state.user && String(b.userId) === String(state.user.id);
          const u = b.currencyMode === 'real' ? 'PKR' : 'FC';
          const multText =
            b.cashedOut && b.cashoutMultiplier ? `${b.cashoutMultiplier.toFixed(2)}x` : '-';
          const winText = b.cashedOut ? `+${b.payout.toFixed(2)}` : '-';
          return `
            <div class="bet-row ${b.cashedOut ? 'won' : ''} ${isMe ? 'is-me' : ''}">
              <span class="bet-player">${escapeHtml(b.player)}${isMe ? ' (You)' : ''}</span>
              <span class="tabular-nums">${Number(b.amount).toFixed(0)} ${u}</span>
              <span class="bet-mult tabular-nums">${multText}</span>
              <span class="bet-payout tabular-nums">${winText}</span>
            </div>
          `;
        })
        .join('');
    } else if (state.sidebarTab === 'mine') {
      el.sidebarTableHead.classList.remove('hidden');
      const history = state.user?.recentBets || [];
      el.activeBetsCount.textContent = `${history.length} Recent`;
      el.totalRoundWager.textContent = state.user
        ? fmtMoney(
            state.currencyMode === 'real' ? state.user.totalWonReal : state.user.totalWonFun,
            state.currencyMode
          )
        : 'Guest';

      if (!state.user) {
        el.sidebarBetsList.innerHTML =
          '<div class="empty-state">Log in to view your personal flight history.</div>';
        return;
      }
      if (!history.length) {
        el.sidebarBetsList.innerHTML =
          '<div class="empty-state">You have not placed any bets yet.</div>';
        return;
      }

      el.sidebarBetsList.innerHTML = history
        .map((h) => {
          const won = h.payout > 0;
          const u = h.currencyMode === 'real' ? 'PKR' : 'FC';
          const multText = h.cashoutMultiplier
            ? `${Number(h.cashoutMultiplier).toFixed(2)}x`
            : `Crash ${Number(h.crashedAt).toFixed(2)}x`;
          const payoutText = won
            ? `+${Number(h.payout).toFixed(2)}`
            : `-${Number(h.betAmount).toFixed(2)}`;
          return `
            <div class="bet-row ${won ? 'won' : ''}">
              <span class="bet-player">#${h.roundNumber}</span>
              <span class="tabular-nums">${Number(h.betAmount).toFixed(0)} ${u}</span>
              <span class="bet-mult tabular-nums" style="font-size:0.72rem;">${multText}</span>
              <span class="bet-payout tabular-nums" style="color:${won ? '#34d399' : '#f87171'};">${payoutText}</span>
            </div>
          `;
        })
        .join('');
    } else {
      // Wallet History Tab (Deposits & Withdrawals with Approval/Rejection Status & Reason)
      el.sidebarTableHead.classList.add('hidden');
      el.activeBetsCount.textContent = `${state.transactions.length} Transactions`;
      el.totalRoundWager.textContent = state.user
        ? fmtMoney(state.user.realBalance, 'real')
        : 'Guest';

      if (!state.user) {
        el.sidebarBetsList.innerHTML =
          '<div class="empty-state">Log in to view your PKR deposit & withdrawal history.</div>';
        return;
      }
      if (!state.transactions.length) {
        el.sidebarBetsList.innerHTML =
          '<div class="empty-state">No PKR deposits or withdrawals yet.</div>';
        return;
      }

      el.sidebarBetsList.innerHTML = state.transactions
        .map((t) => {
          const statusClass =
            t.status === 'approved'
              ? 'tx-status-approved'
              : t.status === 'rejected'
                ? 'tx-status-rejected'
                : 'tx-status-pending';
          const typeLabel = t.type === 'deposit' ? 'Deposit' : 'Withdraw';
          return `
            <div class="tx-card">
              <div class="tx-card-top">
                <strong>${typeLabel} · ${escapeHtml(t.method)}</strong>
                <span class="tabular-nums" style="font-weight:700;">${Number(t.amount).toLocaleString()} PKR</span>
              </div>
              <div class="tx-card-top" style="font-size: 0.72rem; color: var(--text-muted);">
                <span>${t.transactionId ? `TID: ${escapeHtml(t.transactionId)}` : new Date(t.createdAt).toLocaleString()}</span>
                <span class="${statusClass}">${t.status.toUpperCase()}</span>
              </div>
              ${
                t.status === 'rejected' && t.rejectionReason
                  ? `<div style="font-size: 0.74rem; color: #fca5a5; margin-top: 2px;">Reason: ${escapeHtml(t.rejectionReason)}</div>`
                  : ''
              }
            </div>
          `;
        })
        .join('');
    }
  }

  function setSidebarTab(tab) {
    state.sidebarTab = tab;
    el.tabLiveBets.classList.toggle('active', tab === 'live');
    el.tabMyBets.classList.toggle('active', tab === 'mine');
    el.tabWalletHistory.classList.toggle('active', tab === 'wallet');
    if (tab === 'wallet' && state.user) {
      fetchMyTransactions();
    }
    renderSidebar();
  }

  el.tabLiveBets.addEventListener('click', () => setSidebarTab('live'));
  el.tabMyBets.addEventListener('click', () => setSidebarTab('mine'));
  el.tabWalletHistory.addEventListener('click', () => setSidebarTab('wallet'));

  // ==========================================================================
  // HTML5 Canvas Flight Graphics & Cyber-Golden Bird Animation
  // ==========================================================================
  const ctx = el.canvas.getContext('2d');
  let canvasWidth = 800;
  let canvasHeight = 410;
  const exhaustParticles = [];
  const crashParticles = [];
  const shockwaveRings = [];
  const birdHistory = [];
  const starNodes = [];
  let screenShake = 0;

  function initStarNetwork() {
    starNodes.length = 0;
    const colors = [
      { r: 56, g: 189, b: 248 },
      { r: 251, g: 191, b: 36 },
      { r: 226, g: 232, b: 240 },
    ];
    for (let i = 0; i < 48; i++) {
      const c = colors[i % colors.length];
      starNodes.push({
        x: Math.random() * canvasWidth,
        y: Math.random() * canvasHeight,
        vx: -(0.18 + Math.random() * 0.42),
        vy: 0.06 + Math.random() * 0.22,
        radius: 0.9 + Math.random() * 1.9,
        baseAlpha: 0.22 + Math.random() * 0.45,
        phase: Math.random() * Math.PI * 2,
        color: c,
      });
    }
  }

  function resizeCanvas() {
    const parent = el.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const prevW = canvasWidth;
    const prevH = canvasHeight;

    canvasWidth = Math.max(240, Math.round(rect.width));
    canvasHeight = Math.max(220, Math.round(rect.height));

    el.canvas.style.width = '100%';
    el.canvas.style.height = '100%';
    el.canvas.width = Math.round(canvasWidth * dpr);
    el.canvas.height = Math.round(canvasHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (starNodes.length === 0) {
      initStarNetwork();
    } else if (prevW > 0 && prevH > 0 && (prevW !== canvasWidth || prevH !== canvasHeight)) {
      const sx = canvasWidth / prevW;
      const sy = canvasHeight / prevH;
      for (let i = 0; i < starNodes.length; i++) {
        starNodes[i].x *= sx;
        starNodes[i].y *= sy;
      }
    }
  }

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 80));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resizeCanvas);
  }
  if (typeof ResizeObserver !== 'undefined' && el.canvas.parentElement) {
    const ro = new ResizeObserver(() => resizeCanvas());
    ro.observe(el.canvas.parentElement);
  }
  resizeCanvas();

  function drawStarParticleNetwork(nowMs, mult, birdPos, isFlying) {
    const speedScale = isFlying ? 1 + Math.min(7.5, (mult - 1) * 0.72) : 0.65;
    const linkDist = isFlying ? Math.min(120, 82 + (mult - 1) * 4) : 82;

    for (let i = 0; i < starNodes.length; i++) {
      const n = starNodes[i];
      n.x += n.vx * speedScale;
      n.y += n.vy * speedScale;

      if (n.x < -12) n.x = canvasWidth + 12;
      if (n.x > canvasWidth + 12) n.x = -12;
      if (n.y > canvasHeight + 12) n.y = -12;
      if (n.y < -12) n.y = canvasHeight + 12;

      const twinkle = 0.72 + 0.28 * Math.sin(nowMs * 0.003 + n.phase);
      let proximityBoost = 0;
      if (isFlying && birdPos) {
        const dx = n.x - birdPos.x;
        const dy = n.y - birdPos.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 140) {
          proximityBoost = (1 - dist / 140) * 0.48;
        }
      }

      const alpha = Math.min(0.95, n.baseAlpha * twinkle + proximityBoost);
      ctx.fillStyle = `rgba(${n.color.r}, ${n.color.g}, ${n.color.b}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + proximityBoost * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineWidth = 0.8;
    for (let i = 0; i < starNodes.length; i++) {
      const a = starNodes[i];
      for (let j = i + 1; j < starNodes.length; j++) {
        const b = starNodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < linkDist * linkDist) {
          const dist = Math.sqrt(d2);
          let lineAlpha = (1 - dist / linkDist) * (isFlying ? 0.14 : 0.07);
          if (isFlying && birdPos) {
            const bDist = Math.hypot((a.x + b.x) * 0.5 - birdPos.x, (a.y + b.y) * 0.5 - birdPos.y);
            if (bDist < 150) {
              lineAlpha += (1 - bDist / 150) * 0.18;
            }
          }
          ctx.strokeStyle =
            isFlying && mult >= 3
              ? `rgba(251, 191, 36, ${lineAlpha})`
              : `rgba(56, 189, 248, ${lineAlpha})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }

  function spawnCrashBurst(x, y) {
    crashParticles.length = 0;
    shockwaveRings.push(
      { x, y, radius: 10, maxRadius: 150, alpha: 0.9, color: '#ef4444' },
      { x, y, radius: 4, maxRadius: 105, alpha: 0.85, color: '#fbbf24' }
    );
    screenShake = 11;
    for (let i = 0; i < 54; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.0 + Math.random() * 7.4;
      const isFeather = i % 3 === 0;
      crashParticles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.6,
        size: isFeather ? 7 + Math.random() * 6 : 2.5 + Math.random() * 3.8,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.25,
        alpha: 1,
        isFeather,
        color: i % 4 === 0 ? '#ef4444' : i % 2 === 0 ? '#fbbf24' : '#38bdf8',
      });
    }
  }

  function drawCyberBird(x, y, angleRad, timeMs, scale = 1) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleRad);
    if (scale !== 1) ctx.scale(scale, scale);

    const wingFlap = Math.sin(timeMs * 0.018);

    const flameGrad = ctx.createLinearGradient(-42, 0, -14, 0);
    flameGrad.addColorStop(0, 'rgba(56, 189, 248, 0)');
    flameGrad.addColorStop(0.5, 'rgba(245, 158, 11, 0.7)');
    flameGrad.addColorStop(1, 'rgba(254, 240, 138, 0.95)');
    ctx.fillStyle = flameGrad;
    ctx.beginPath();
    ctx.moveTo(-16, -4);
    ctx.lineTo(-42 - Math.random() * 10, 0);
    ctx.lineTo(-16, 4);
    ctx.closePath();
    ctx.fill();

    const aura = ctx.createRadialGradient(0, 0, 4, 0, 0, 44);
    aura.addColorStop(0, 'rgba(251, 191, 36, 0.35)');
    aura.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, 44, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.rotate(wingFlap * 0.45 - 0.25);
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.moveTo(-4, -3);
    ctx.quadraticCurveTo(-16, -28, -30, -20);
    ctx.quadraticCurveTo(-18, -8, -8, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(-14, -2);
    ctx.lineTo(-28, -9);
    ctx.lineTo(-22, 0);
    ctx.lineTo(-28, 8);
    ctx.lineTo(-14, 4);
    ctx.closePath();
    ctx.fill();

    const bodyGrad = ctx.createLinearGradient(-18, -10, 22, 10);
    bodyGrad.addColorStop(0, '#f59e0b');
    bodyGrad.addColorStop(0.55, '#fde047');
    bodyGrad.addColorStop(1, '#ffffff');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(-16, 2);
    ctx.quadraticCurveTo(-4, -13, 16, -7);
    ctx.quadraticCurveTo(26, -2, 30, 1);
    ctx.quadraticCurveTo(22, 8, 6, 9);
    ctx.quadraticCurveTo(-8, 9, -16, 2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.moveTo(26, -3);
    ctx.lineTo(36, 1);
    ctx.lineTo(25, 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#06b6d4';
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.ellipse(18, -2.5, 4, 2, -0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.rotate(-wingFlap * 0.58);
    const wingGrad = ctx.createLinearGradient(-10, -26, 8, 2);
    wingGrad.addColorStop(0, '#fef08a');
    wingGrad.addColorStop(0.6, '#f59e0b');
    wingGrad.addColorStop(1, '#b45309');
    ctx.fillStyle = wingGrad;
    ctx.beginPath();
    ctx.moveTo(4, 0);
    ctx.quadraticCurveTo(-8, -32, -26, -24);
    ctx.quadraticCurveTo(-18, -8, -4, 3);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-3, -6);
    ctx.lineTo(-19, -19);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  let lastKnownBirdPos = { x: 80, y: canvasHeight - 60 };

  function renderCanvas(nowMs) {
    ctx.save();

    if (screenShake > 0.2) {
      const dx = (Math.random() - 0.5) * screenShake;
      const dy = (Math.random() - 0.5) * screenShake;
      ctx.translate(dx, dy);
      screenShake *= 0.88;
    } else {
      screenShake = 0;
    }

    ctx.clearRect(-20, -20, canvasWidth + 40, canvasHeight + 40);

    const isCompact = canvasWidth < 480;
    const birdScale = isCompact ? 0.82 : 1;
    const padLeft = isCompact ? 38 : 48;
    const padRight = isCompact ? 16 : 24;
    const padTop = isCompact ? 26 : 32;
    const padBottom = isCompact ? 28 : 36;
    const plotW = Math.max(120, canvasWidth - padLeft - padRight);
    const plotH = Math.max(120, canvasHeight - padTop - padBottom);

    let elapsedSec = 0;
    if (state.game.phase === 'FLYING' && state.game.flightStartedAt > 0) {
      elapsedSec = Math.max(0, (Date.now() - state.game.flightStartedAt) / 1000);
      const smoothMult = Math.max(1.0, Math.exp(MULTIPLIER_GROWTH_RATE * elapsedSec));
      state.game.currentMultiplier = Math.max(
        state.game.currentMultiplier,
        Math.floor(smoothMult * 100) / 100
      );
      el.liveMultiplierText.textContent = `${state.game.currentMultiplier.toFixed(2)}x`;
      audio.updateTension(state.game.currentMultiplier);
      audio.playWingFlap();
      updatePanelButtons();
    } else if (state.game.phase === 'BETTING') {
      const remMs = Math.max(0, state.game.bettingEndsAt - Date.now());
      const remSec = (remMs / 1000).toFixed(1);
      el.countdownTimerText.textContent = `${remSec}s`;
      const pct = Math.max(0, Math.min(100, (remMs / 5000) * 100));
      el.countdownBarFill.style.width = `${pct}%`;
    }

    drawStarParticleNetwork(
      nowMs,
      state.game.currentMultiplier,
      lastKnownBirdPos,
      state.game.phase === 'FLYING'
    );

    const maxDisplayMult = Math.max(2.0, state.game.currentMultiplier * 1.18);
    const maxDisplaySec = Math.max(10, elapsedSec * 1.15);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const ratio = i / ySteps;
      const y = padTop + plotH - ratio * plotH;
      const multLabel = 1 + (maxDisplayMult - 1) * ratio;

      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${multLabel.toFixed(1)}x`, padLeft - 8, y);
    }

    const xSteps = 5;
    for (let i = 0; i <= xSteps; i++) {
      const ratio = i / xSteps;
      const x = padLeft + ratio * plotW;
      const secLabel = Math.round(maxDisplaySec * ratio);

      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${secLabel}s`, x, padTop + plotH + 8);
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop);
    ctx.lineTo(padLeft, padTop + plotH);
    ctx.lineTo(padLeft + plotW, padTop + plotH);
    ctx.stroke();

    if (state.game.phase === 'FLYING') {
      const progressX = Math.min(0.92, elapsedSec / maxDisplaySec);
      const progressY = Math.min(
        0.92,
        (state.game.currentMultiplier - 1) / (maxDisplayMult - 1)
      );

      const endX = padLeft + progressX * plotW;
      const endY = padTop + plotH - progressY * plotH;
      const startX = padLeft;
      const startY = padTop + plotH;

      const cpX = startX + (endX - startX) * 0.58;
      const cpY = startY - (startY - endY) * 0.14;

      const areaGrad = ctx.createLinearGradient(0, endY, 0, startY);
      areaGrad.addColorStop(0, 'rgba(245, 158, 11, 0.28)');
      areaGrad.addColorStop(0.6, 'rgba(56, 189, 248, 0.06)');
      areaGrad.addColorStop(1, 'rgba(245, 158, 11, 0.01)');
      ctx.fillStyle = areaGrad;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(cpX, cpY, endX, endY);
      ctx.lineTo(endX, startY);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3.5;
      ctx.shadowColor = 'rgba(251, 191, 36, 0.7)';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(cpX, cpY, endX, endY);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const tx = endX - cpX;
      const ty = endY - cpY;
      const angle = Math.atan2(ty, tx);

      birdHistory.push({ x: endX, y: endY, angle });
      if (birdHistory.length > 14) birdHistory.shift();

      if (birdHistory.length > 2) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 1; i < birdHistory.length; i++) {
          const prev = birdHistory[i - 1];
          const curr = birdHistory[i];
          const t = i / birdHistory.length;
          ctx.strokeStyle =
            i > birdHistory.length - 5
              ? `rgba(254, 240, 138, ${t * 0.48})`
              : `rgba(56, 189, 248, ${t * 0.34})`;
          ctx.lineWidth = 2 + t * 10;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(curr.x, curr.y);
          ctx.stroke();
        }
        ctx.restore();
      }

      const exhaustCount = state.game.currentMultiplier > 3 ? 3 : 2;
      for (let k = 0; k < exhaustCount; k++) {
        const backAngle = angle + Math.PI + (Math.random() - 0.5) * 0.55;
        const speed = 1.6 + Math.random() * 2.8;
        const isCyan = Math.random() < 0.35;
        exhaustParticles.push({
          x: endX - Math.cos(angle) * 18 + (Math.random() - 0.5) * 6,
          y: endY - Math.sin(angle) * 18 + (Math.random() - 0.5) * 6,
          vx: Math.cos(backAngle) * speed,
          vy: Math.sin(backAngle) * speed,
          radius: 1.6 + Math.random() * 2.8,
          alpha: 0.95,
          isCyan,
        });
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = exhaustParticles.length - 1; i >= 0; i--) {
        const pt = exhaustParticles[i];
        pt.x += pt.vx;
        pt.y += pt.vy;
        pt.vx *= 0.97;
        pt.vy *= 0.97;
        pt.alpha -= 0.032;
        pt.radius *= 0.97;
        if (pt.alpha <= 0.02) {
          exhaustParticles.splice(i, 1);
          continue;
        }
        ctx.fillStyle = pt.isCyan
          ? `rgba(56, 189, 248, ${pt.alpha})`
          : `rgba(251, 191, 36, ${pt.alpha})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      lastKnownBirdPos = { x: endX, y: endY };
      drawCyberBird(endX, endY, angle, nowMs, birdScale);
    } else if (state.game.phase === 'BETTING') {
      exhaustParticles.length = 0;
      crashParticles.length = 0;
      shockwaveRings.length = 0;
      birdHistory.length = 0;
      const hoverY = padTop + plotH - 18 + Math.sin(nowMs * 0.005) * 4;
      lastKnownBirdPos = { x: padLeft + 22, y: hoverY };
      drawCyberBird(padLeft + 22, hoverY, -0.18, nowMs, birdScale);
    }

    for (let i = shockwaveRings.length - 1; i >= 0; i--) {
      const ring = shockwaveRings[i];
      ring.radius += 4.2;
      ring.alpha -= 0.028;
      if (ring.alpha <= 0 || ring.radius >= ring.maxRadius) {
        shockwaveRings.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = ring.alpha;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    for (let i = crashParticles.length - 1; i >= 0; i--) {
      const p = crashParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.14;
      p.rot += p.vRot;
      p.alpha -= 0.018;
      if (p.alpha <= 0) {
        crashParticles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.isFeather) {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
    requestAnimationFrame(renderCanvas);
  }

  requestAnimationFrame(renderCanvas);

  // ==========================================================================
  // Socket.io Real-Time Client Sync
  // ==========================================================================
  const socket = io({
    transports: ['websocket', 'polling'],
    auth: { token: state.token },
  });

  function syncPhaseOverlays() {
    const phase = state.game.phase;
    el.hudRoundNumber.textContent = `Round #${state.game.roundNumber}`;
    el.hudSeedShort.textContent = `SHA-256: ${(state.game.serverSeedHash || '').slice(0, 10)}...`;

    if (phase === 'BETTING') {
      el.bettingOverlay.classList.remove('hidden');
      el.flyingOverlay.classList.add('hidden');
      el.crashBannerText.classList.add('hidden');
      el.liveMultiplierText.classList.remove('crashed');
    } else if (phase === 'FLYING') {
      el.bettingOverlay.classList.add('hidden');
      el.flyingOverlay.classList.remove('hidden');
      el.crashBannerText.classList.add('hidden');
      el.liveMultiplierText.classList.remove('crashed');
    } else {
      el.bettingOverlay.classList.add('hidden');
      el.flyingOverlay.classList.remove('hidden');
      el.crashBannerText.classList.remove('hidden');
      el.liveMultiplierText.classList.add('crashed');
      el.liveMultiplierText.textContent = `${Number(state.game.crashPoint || 1).toFixed(2)}x`;
    }
  }

  socket.on('game:init', (data) => {
    state.game.phase = data.phase;
    state.game.roundNumber = data.roundNumber;
    state.game.bettingEndsAt = data.bettingEndsAt;
    state.game.flightStartedAt = data.flightStartedAt;
    state.game.currentMultiplier = data.currentMultiplier || 1.0;
    state.game.crashPoint = data.currentMultiplier || 1.0;
    state.game.serverSeedHash = data.serverSeedHash;
    state.game.clientSeed = data.clientSeed;
    state.game.nonce = data.nonce;
    state.game.bets = data.bets || [];
    state.game.history = data.history || [];
    el.onlineCount.textContent = `${data.onlineCount || 1} Online`;

    if (state.user) {
      [1, 2].forEach((slot) => {
        const mine = state.game.bets.find(
          (b) => String(b.userId) === String(state.user.id) && b.slot === slot
        );
        state.panels[slot].placedBet = mine || null;
      });
    }

    syncPhaseOverlays();
    renderHistory();
    renderSidebar();
    updatePanelButtons();
  });

  socket.on('players:online', ({ count }) => {
    el.onlineCount.textContent = `${count} Online`;
  });

  socket.on('settings:updated', (data) => {
    state.publicSettings = {
      whatsappSupportNumber: data.whatsappSupportNumber || state.publicSettings.whatsappSupportNumber,
      whatsappChannelUrl: data.whatsappChannelUrl || state.publicSettings.whatsappChannelUrl,
      paymentAccounts: data.paymentAccounts || state.publicSettings.paymentAccounts,
    };
    syncChannelLinks();
    renderPaymentAccounts();
  });

  socket.on('balance:update', ({ funBalance, realBalance, funCredits }) => {
    if (state.user) {
      if (funBalance !== undefined) state.user.funBalance = funBalance;
      else if (funCredits !== undefined) state.user.funBalance = funCredits;
      if (realBalance !== undefined) state.user.realBalance = realBalance;
      updateUserUI();
    }
  });

  socket.on('transaction:updated', (tx) => {
    const idx = state.transactions.findIndex((t) => String(t.id) === String(tx.id));
    if (idx >= 0) {
      state.transactions[idx] = tx;
    } else {
      state.transactions.unshift(tx);
    }
    if (state.sidebarTab === 'wallet') renderSidebar();

    const kind = tx.type === 'deposit' ? 'Deposit' : 'Withdrawal';
    if (tx.status === 'approved') {
      showToast(`${kind} of ${Number(tx.amount).toLocaleString()} PKR Approved!`);
    } else if (tx.status === 'rejected') {
      showToast(`${kind} Rejected: ${tx.rejectionReason || 'Contact Admin'}`, true);
    }
    fetchCurrentUser();
  });

  socket.on('account:banned', ({ reason }) => {
    showToast(reason || 'Account suspended.', true);
    state.token = '';
    state.user = null;
    localStorage.removeItem('skywing_token');
    updateUserUI();
  });

  socket.on('round:betting', (data) => {
    audio.stopTension();
    state.game.phase = 'BETTING';
    state.game.roundNumber = data.roundNumber;
    state.game.bettingEndsAt = data.bettingEndsAt;
    state.game.currentMultiplier = 1.0;
    state.game.serverSeedHash = data.serverSeedHash;
    state.game.serverSeed = '';
    state.game.clientSeed = data.clientSeed;
    state.game.nonce = data.nonce;
    state.game.bets = [];
    if (data.history) state.game.history = data.history;

    [1, 2].forEach((slot) => {
      state.panels[slot].placedBet = null;
    });

    syncPhaseOverlays();
    renderHistory();
    renderSidebar();
    updatePanelButtons();

    if (state.user) {
      [1, 2].forEach((slot) => {
        if (state.panels[slot].queued || state.panels[slot].autoBet) {
          state.panels[slot].queued = false;
          setTimeout(() => placeBet(slot), slot * 120);
        }
      });
    }
  });

  socket.on('round:flying', (data) => {
    state.game.phase = 'FLYING';
    state.game.flightStartedAt = data.flightStartedAt || Date.now();
    state.game.currentMultiplier = 1.0;
    state.game.bets = data.bets || state.game.bets;
    syncPhaseOverlays();
    audio.startTension();
    updatePanelButtons();
  });

  socket.on('round:tick', (data) => {
    if (state.game.phase === 'FLYING') {
      state.game.currentMultiplier = Math.max(state.game.currentMultiplier, data.multiplier);
    }
  });

  socket.on('round:crashed', (data) => {
    state.game.phase = 'CRASHED';
    state.game.crashPoint = data.crashPoint;
    state.game.currentMultiplier = data.crashPoint;
    state.game.serverSeed = data.serverSeed;
    if (data.history) state.game.history = data.history;

    audio.playCrash();
    spawnCrashBurst(lastKnownBirdPos.x, lastKnownBirdPos.y);

    syncPhaseOverlays();
    renderHistory();
    renderSidebar();
    updatePanelButtons();

    if (state.user) fetchCurrentUser();
  });

  socket.on('bet:placed', (bet) => {
    if (!state.game.bets.some((b) => b.id === bet.id)) {
      state.game.bets.push(bet);
      renderSidebar();
    }
  });

  socket.on('bet:cancelled', ({ betId }) => {
    state.game.bets = state.game.bets.filter((b) => b.id !== betId);
    renderSidebar();
  });

  socket.on('bet:cashedOut', (data) => {
    const bet = state.game.bets.find((b) => b.id === data.betId);
    if (bet) {
      bet.cashedOut = true;
      bet.cashoutMultiplier = data.cashoutMultiplier;
      bet.payout = data.payout;
      renderSidebar();
    }
    if (state.user && String(data.userId) === String(state.user.id)) {
      const slot = data.slot === 2 ? 2 : 1;
      if (state.panels[slot].placedBet && !state.panels[slot].placedBet.cashedOut) {
        state.panels[slot].placedBet.cashedOut = true;
        audio.playCashout();
        showToast(
          `Auto Cashout ${data.cashoutMultiplier.toFixed(2)}x (+${fmtMoney(data.payout, data.currencyMode)})`
        );
      }
      updatePanelButtons();
    }
  });

  // ==========================================================================
  // Initial Load
  // ==========================================================================
  updateModeAndWalletUI();
  loadPublicSettings();
  fetchCurrentUser();
  if (state.token) fetchMyTransactions();
})();
