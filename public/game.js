/* global io */
(() => {
  'use strict';

  const MULTIPLIER_GROWTH_RATE = 0.068;
  const PK_PHONE_REGEX = /^03[0-9]{9}$/;
  const CNIC_REGEX = /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/;
  const INACTIVITY_LIMIT_MS = 3 * 24 * 60 * 60 * 1000; // 72 hours

  const PLINKO_TABLES = {
    low: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
    medium: [13.0, 3.0, 1.3, 0.7, 0.4, 0.7, 1.3, 3.0, 13.0],
    high: [29.0, 4.0, 1.5, 0.3, 0.2, 0.3, 1.5, 4.0, 29.0],
  };

  const WHEEL_SEGMENTS = [
    { label: '0x', mult: 0, color: '#ef4444' },
    { label: '1.5x', mult: 1.5, color: '#06b6d4' },
    { label: '0.5x', mult: 0.5, color: '#64748b' },
    { label: '2x', mult: 2.0, color: '#10b981' },
    { label: '0x', mult: 0, color: '#ef4444' },
    { label: '1.2x', mult: 1.2, color: '#3b82f6' },
    { label: '5x', mult: 5.0, color: '#f59e0b' },
    { label: '0.5x', mult: 0.5, color: '#64748b' },
    { label: '1.5x', mult: 1.5, color: '#06b6d4' },
    { label: '0x', mult: 0, color: '#ef4444' },
    { label: '3x', mult: 3.0, color: '#8b5cf6' },
    { label: '10x', mult: 10.0, color: '#eab308' },
  ];

  const SLOT_SYMBOLS = ['777', '💎', '👑', '⚡', '🍒', '🍋'];

  const KENO_PAYTABLES = {
    1: { 1: 3.6 },
    2: { 1: 1.4, 2: 5.2 },
    3: { 2: 2.6, 3: 14.0 },
    4: { 2: 1.8, 3: 6.5, 4: 32.0 },
    5: { 2: 1.2, 3: 3.8, 4: 13.5, 5: 65.0 },
  };

  function lsGet(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, String(val));
    } catch {
      // ignore blocked storage
    }
  }
  function lsRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore blocked storage
    }
  }
  function ssSet(key, val) {
    try {
      sessionStorage.setItem(key, String(val));
    } catch {
      // ignore blocked storage
    }
  }
  function ssRemove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore blocked storage
    }
  }

  // Persistent LocalStorage & Cookie Session Vault (3-Day Inactivity Window)
  function setVaultCookie(name, value, days = 30) {
    try {
      const maxAge = days * 86400;
      document.cookie = `${name}=${encodeURIComponent(String(value || ''))}; path=/; max-age=${maxAge}; SameSite=Lax`;
    } catch {
      // ignore cookie write errors in restricted frames
    }
  }

  function getVaultCookie(name) {
    try {
      const prefix = `${name}=`;
      const parts = String(document.cookie || '').split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
          return decodeURIComponent(trimmed.slice(prefix.length));
        }
      }
    } catch {
      // ignore
    }
    return '';
  }

  function deleteVaultCookie(name) {
    try {
      document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
    } catch {
      // ignore
    }
  }

  function updateLastActive() {
    const now = String(Date.now());
    lsSet('skywing_last_active', now);
    setVaultCookie('skywing_last_active', now, 7);
  }

  function isSessionInactiveExpired() {
    const raw = lsGet('skywing_last_active') || getVaultCookie('skywing_last_active') || '';
    if (!raw) return false;
    const lastTs = Number(raw);
    if (!Number.isFinite(lastTs) || lastTs <= 0) return false;
    return Date.now() - lastTs > INACTIVITY_LIMIT_MS;
  }

  function readStoredToken() {
    if (isSessionInactiveExpired()) {
      clearSessionVault();
      return '';
    }
    const lsToken = lsGet('skywing_token');
    const ckToken = getVaultCookie('skywing_token') || '';
    const token = lsToken || ckToken;
    if (token) {
      if (!lsToken) lsSet('skywing_token', token);
      if (!ckToken) setVaultCookie('skywing_token', token);
      updateLastActive();
    }
    return token;
  }

  function readStoredUserCache() {
    let cached = null;
    try {
      const raw = lsGet('skywing_user_cache') || getVaultCookie('skywing_user_cache');
      if (raw) cached = JSON.parse(raw);
    } catch {
      cached = null;
    }
    if (cached && typeof cached === 'object') return cached;

    const uid = lsGet('skywing_user_id') || getVaultCookie('skywing_user_id') || '';
    const uname = lsGet('skywing_username') || getVaultCookie('skywing_username') || '';
    const phone = lsGet('skywing_phone') || getVaultCookie('skywing_phone') || '';
    if (uid || uname) {
      return {
        id: uid,
        displayName: uname || phone || 'Player',
        phoneNumber: phone || uname,
        funBalance: Number(lsGet('skywing_fun_balance') || 0),
        realBalance: Number(lsGet('skywing_real_balance') || 0),
        totalDeposited: 0,
        totalWithdrawn: 0,
      };
    }
    return null;
  }

  function saveSessionVault(token, user) {
    if (token) {
      lsSet('skywing_token', token);
      setVaultCookie('skywing_token', token);
      ssSet('skywing_tab_auth', '1');
      updateLastActive();
    }
    if (user && typeof user === 'object') {
      const uid = String(user.id || user._id || '');
      const uname = String(user.displayName || user.phoneNumber || '');
      const phone = String(user.phoneNumber || '');
      if (uid) {
        lsSet('skywing_user_id', uid);
        setVaultCookie('skywing_user_id', uid);
      }
      if (uname) {
        lsSet('skywing_username', uname);
        setVaultCookie('skywing_username', uname);
      }
      if (phone) {
        lsSet('skywing_phone', phone);
        setVaultCookie('skywing_phone', phone);
      }
      lsSet('skywing_fun_balance', String(Number(user.funBalance ?? 0)));
      lsSet('skywing_real_balance', String(Number(user.realBalance ?? 0)));
      try {
        const compactCache = JSON.stringify({
          id: uid,
          phoneNumber: phone,
          displayName: uname,
          funBalance: Number(user.funBalance ?? 0),
          realBalance: Number(user.realBalance ?? 0),
          totalDeposited: Number(user.totalDeposited ?? 0),
          totalWithdrawn: Number(user.totalWithdrawn ?? 0),
          totalWageredReal: Number(user.totalWageredReal ?? 0),
          remainingWagering: Number(user.remainingWagering ?? 0),
          wageringRequirementMet: Boolean(user.wageringRequirementMet),
          referralCode: user.referralCode || '',
          referralEarnings: Number(user.referralEarnings ?? 0),
          vip: user.vip || null,
          savedPayoutAccounts: Array.isArray(user.savedPayoutAccounts) ? user.savedPayoutAccounts : [],
        });
        lsSet('skywing_user_cache', compactCache);
        setVaultCookie('skywing_user_cache', compactCache);
      } catch {
        // ignore serialization quota errors
      }
    }
  }

  function clearSessionVault() {
    lsRemove('skywing_token');
    lsRemove('skywing_last_active');
    lsRemove('skywing_user_id');
    lsRemove('skywing_username');
    lsRemove('skywing_phone');
    lsRemove('skywing_fun_balance');
    lsRemove('skywing_real_balance');
    lsRemove('skywing_user_cache');
    ssRemove('skywing_tab_auth');
    deleteVaultCookie('skywing_token');
    deleteVaultCookie('skywing_last_active');
    deleteVaultCookie('skywing_user_id');
    deleteVaultCookie('skywing_username');
    deleteVaultCookie('skywing_phone');
    deleteVaultCookie('skywing_user_cache');
  }

  const urlParams = new URLSearchParams(window.location.search);
  const urlRefCode = String(urlParams.get('ref') || '').trim().toUpperCase().slice(0, 16);
  if (urlRefCode) {
    lsSet('skywing_ref', urlRefCode);
  }

  function getOrCreateDeviceFingerprint() {
    let fp = lsGet('skywing_device_id');
    if (!fp) {
      let tz = 'UTC';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        tz = 'UTC';
      }
      const scrW = typeof screen !== 'undefined' ? screen.width : 1024;
      const scrH = typeof screen !== 'undefined' ? screen.height : 768;
      const navPart = `${navigator.platform || 'x'}|${scrW}x${scrH}|${tz}`;
      let hash = 2166136261;
      for (let i = 0; i < navPart.length; i++) {
        hash ^= navPart.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const randHex = Math.random().toString(16).slice(2, 10);
      fp = `swfp-${(hash >>> 0).toString(16)}-${randHex}`;
      lsSet('skywing_device_id', fp);
    }
    return fp;
  }
  const DEVICE_FINGERPRINT = getOrCreateDeviceFingerprint();

  const initialRestoredToken = readStoredToken();
  const initialRestoredUser = initialRestoredToken ? readStoredUserCache() : null;

  // ==========================================================================
  // Application State
  // ==========================================================================
  const state = {
    token: initialRestoredToken,
    user: initialRestoredUser,
    currencyMode: lsGet('skywing_mode') === 'real' ? 'real' : 'fun',
    activeGameId: null,
    lobbyCategory: 'all',
    isFullscreen: false,
    publicSettings: {
      maskMasterAccounts: true,
      paymentAccounts: null,
      financialLimits: {
        minDeposit: 50,
        minWithdrawal: 100,
        withdrawalFeePct: 2,
        microDepositAutoApproveLimit: 1000,
      },
      withdrawalHours: {
        enabled: true,
        openTime: '09:00',
        closeTime: '17:00',
        currentlyOpen: true,
        noticeText: 'Withdrawals are only open from 9:00 AM to 5:00 PM.',
      },
      platformStatus: {
        mode: 'active',
        message: 'Platform is undergoing scheduled maintenance. Please check back shortly.',
      },
      gamesConfig: [
        { id: 'skywing-crash', name: 'SkyWing Crash', enabled: true, minBet: 10, maxBet: 100000, houseEdgePct: 4 },
        { id: 'cyber-plinko', name: 'Cyber Plinko', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'golden-mines', name: 'Golden Mines', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'cyber-dice', name: 'Cyber Dice', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'cyber-limbo', name: 'Limbo X', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'neon-flip', name: 'Neon Coin Flip', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'lucky-wheel', name: 'Lucky Wheel', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'dragon-hilo', name: 'Dragon Hi-Lo', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'emerald-slots', name: 'Emerald 777 Slots', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'crystal-keno', name: 'Crystal Keno', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'tower-climb', name: 'Sky Tower', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'dragon-tiger', name: 'Dragon Tiger', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'neon-baccarat', name: 'Neon Baccarat', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'triple-roulette', name: 'Royal Roulette', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
        { id: 'lucky-scratch', name: 'Golden Scratch', enabled: true, minBet: 10, maxBet: 50000, houseEdgePct: 4 },
      ],
      audioConfig: {
        bgmEnabled: true,
        soundPreset: 'aviator-jet',
        masterVolume: 75,
      },
    },
    soundEnabled: lsGet('skywing_sound') !== 'off',
    sidebarTab: 'live', // 'live' | 'mine' | 'wallet'
    transactions: [],
    depositScreenshotData: '',
    qrDepositRef: '',
    lastQrDataUrl: '',
    qrDownloadUrl: '',
    deferredInstallPrompt: null,
    supportTickets: [],
    activeTicketId: '',
    pendingNewTicketImg: '',
    pendingReplyTicketImg: '',
    pendingLaunchGameId: null,
    plinkoRisk: 'medium',
    plinkoBusy: false,
    diceDirection: 'under',
    diceTarget: 50,
    diceBusy: false,
    limboBusy: false,
    coinflipPick: 'heads',
    coinflipBusy: false,
    wheelRotation: 0,
    wheelBusy: false,
    hiloBaseRankIdx: 5,
    hiloBusy: false,
    slotsBusy: false,
    kenoPicks: [7, 14, 25],
    kenoBusy: false,
    tower: {
      active: false,
      currentFloor: 0,
      betAmount: 50,
      multiplier: 1.0,
      nextMultiplier: 1.44,
      revealed: [],
      traps: [],
      busy: false,
    },
    dtChoice: 'dragon',
    dtBusy: false,
    bacChoice: 'player',
    bacBusy: false,
    roulBetType: 'red',
    roulRotation: 0,
    roulBusy: false,
    scratch: {
      active: false,
      cells: [],
      scratched: [],
      matchSymbol: '',
      won: false,
      mult: 0,
      payout: 0,
      currencyMode: 'fun',
      pendingUser: null,
      pendingHistory: null,
      busy: false,
    },
    qrRequestSeq: 0,
    qrDebounceTimer: null,
    arcade: {
      plinkoHistory: [],
      minesHistory: [],
      diceHistory: [],
      limboHistory: [],
      coinflipHistory: [],
      wheelHistory: [],
      hiloHistory: [],
      slotsHistory: [],
      kenoHistory: [],
      towerHistory: [],
      dragonTigerHistory: [],
      baccaratHistory: [],
      rouletteHistory: [],
      scratchHistory: [],
    },
    mines: {
      active: false,
      revealed: [],
      minesCount: 3,
      betAmount: 50,
      multiplier: 1.0,
      nextMultiplier: 1.1,
      potentialPayout: 0,
      minesShown: [],
    },

    game: {
      phase: 'BETTING',
      flightState: 'betting',
      currentRoundId: 0,
      roundNumber: 0,
      bettingDurationMs: 5000,
      countdownRemainingMs: 5000,
      elapsedMs: 0,
      bettingEndsAt: 0,
      flightStartedAt: 0,
      serverTimestamp: 0,
      serverTickTimestamp: 0,
      lastSyncPerfMs: performance.now(),
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
  // Web Audio API Synthesizer (Shared Engine with Global Presets & BGM)
  // ==========================================================================
  const audio = new window.SkyWingAudioEngine({ startLocked: true });
  audio.setMuted(!state.soundEnabled);
  audio.setLocked(true);

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
    headerDepositBtn: document.getElementById('headerDepositBtn'),
    shareHeaderBtn: document.getElementById('shareHeaderBtn'),
    headerHelpBtn: document.getElementById('headerHelpBtn'),
    headerLogoutBtn: document.getElementById('headerLogoutBtn'),
    realWalletActions: document.getElementById('realWalletActions'),
    openWithdrawBtn: document.getElementById('openWithdrawBtn'),
    onlineCount: document.getElementById('onlinePlayersCount'),
    userAccountLabel: document.getElementById('userAccountLabel'),
    historyLabel: document.getElementById('historyLabel'),
    historyList: document.getElementById('historyList'),

    // Auth-First Gate, Visual Game Lobby, Home Hero & Active Arena Wrappers
    headerGameControls: document.getElementById('headerGameControls'),
    headerBackHomeBtn: document.getElementById('headerBackHomeBtn'),
    fullscreenToggleBtn: document.getElementById('fullscreenToggleBtn'),
    fullscreenBtnLabel: document.getElementById('fullscreenBtnLabel'),
    arenaFullscreenBtn: document.getElementById('arenaFullscreenBtn'),
    authEntryGate: document.getElementById('authEntryGate'),
    mainGameShell: document.getElementById('mainGameShell'),
    siteFooter: document.getElementById('siteFooter'),
    gateLoginBtn: document.getElementById('gateLoginBtn'),
    gateRegisterBtn: document.getElementById('gateRegisterBtn'),

    // Sticky Top Feature Navigation & Play Mode Selector
    topFeaturePane: document.getElementById('topFeaturePane'),
    playModeSelectModal: document.getElementById('playModeSelectModal'),
    playModeGameName: document.getElementById('playModeGameName'),
    playModeFunBtn: document.getElementById('playModeFunBtn'),
    playModeFunBal: document.getElementById('playModeFunBal'),
    playModeRealBtn: document.getElementById('playModeRealBtn'),
    playModeRealBal: document.getElementById('playModeRealBal'),
    playModeDepositBtn: document.getElementById('playModeDepositBtn'),

    // Maintenance & Operating Hours & Game Lobby
    maintenanceOverlay: document.getElementById('maintenanceOverlay'),
    maintenanceStatusPill: document.getElementById('maintenanceStatusPill'),
    maintenanceTitle: document.getElementById('maintenanceTitle'),
    maintenanceMessage: document.getElementById('maintenanceMessage'),
    helpWithdrawHoursText: document.getElementById('helpWithdrawHoursText'),
    gameLobbySection: document.getElementById('gameLobbySection'),
    homeQuickDepositBtn: document.getElementById('homeQuickDepositBtn'),
    homeQuickRewardsBtn: document.getElementById('homeQuickRewardsBtn'),
    homeWhatsappShareBtn: document.getElementById('homeWhatsappShareBtn'),
    homeFunBalStat: document.getElementById('homeFunBalStat'),
    homeRealBalStat: document.getElementById('homeRealBalStat'),
    homeVipStat: document.getElementById('homeVipStat'),
    lobbyCategoryFilters: document.getElementById('lobbyCategoryFilters'),
    gameLobbyBar: document.getElementById('gameLobbyBar'),
    activeGameWorkspace: document.getElementById('activeGameWorkspace'),
    backToLobbyBtn: document.getElementById('backToLobbyBtn'),
    activeArenaTitle: document.getElementById('activeArenaTitle'),
    crashArenaContainer: document.getElementById('crashArenaContainer'),
    plinkoArena: document.getElementById('plinkoArena'),
    minesArena: document.getElementById('minesArena'),
    diceArena: document.getElementById('diceArena'),
    limboArena: document.getElementById('limboArena'),
    coinflipArena: document.getElementById('coinflipArena'),
    wheelArena: document.getElementById('wheelArena'),
    hiloArena: document.getElementById('hiloArena'),
    slotsArena: document.getElementById('slotsArena'),
    kenoArena: document.getElementById('kenoArena'),
    towerArena: document.getElementById('towerArena'),
    dragonTigerArena: document.getElementById('dragonTigerArena'),
    baccaratArena: document.getElementById('baccaratArena'),
    rouletteArena: document.getElementById('rouletteArena'),
    scratchArena: document.getElementById('scratchArena'),

    // Plinko & Mines
    plinkoCanvas: document.getElementById('plinkoCanvas'),
    plinkoBucketsRow: document.getElementById('plinkoBucketsRow'),
    plinkoAmount: document.getElementById('plinkoAmount'),
    plinkoDropBtn: document.getElementById('plinkoDropBtn'),
    plinkoLastResultPill: document.getElementById('plinkoLastResultPill'),
    minesAmount: document.getElementById('minesAmount'),
    minesCountSelect: document.getElementById('minesCountSelect'),
    minesStartBtn: document.getElementById('minesStartBtn'),
    minesCashoutBtn: document.getElementById('minesCashoutBtn'),
    minesGrid: document.getElementById('minesGrid'),
    minesMultPill: document.getElementById('minesMultPill'),
    minesNextMult: document.getElementById('minesNextMult'),
    minesCurrentPayout: document.getElementById('minesCurrentPayout'),
    minesHintText: document.getElementById('minesHintText'),

    // Cyber Dice
    diceStatusPill: document.getElementById('diceStatusPill'),
    diceDieA: document.getElementById('diceDieA'),
    diceDieB: document.getElementById('diceDieB'),
    diceRollValText: document.getElementById('diceRollValText'),
    diceResultSub: document.getElementById('diceResultSub'),
    diceWinZone: document.getElementById('diceWinZone'),
    diceRollMarker: document.getElementById('diceRollMarker'),
    diceTargetSlider: document.getElementById('diceTargetSlider'),
    diceTargetLabel: document.getElementById('diceTargetLabel'),
    diceWinChanceVal: document.getElementById('diceWinChanceVal'),
    diceMultVal: document.getElementById('diceMultVal'),
    diceEstPayoutVal: document.getElementById('diceEstPayoutVal'),
    diceAmount: document.getElementById('diceAmount'),
    diceRuleHint: document.getElementById('diceRuleHint'),
    diceRollBtn: document.getElementById('diceRollBtn'),

    // Limbo X
    limboStatusBadge: document.getElementById('limboStatusBadge'),
    limboResultValue: document.getElementById('limboResultValue'),
    limboResultSub: document.getElementById('limboResultSub'),
    limboGaugeBar: document.getElementById('limboGaugeBar'),
    limboTargetMarker: document.getElementById('limboTargetMarker'),
    limboTargetBadge: document.getElementById('limboTargetBadge'),
    limboChanceVal: document.getElementById('limboChanceVal'),
    limboEstPayoutVal: document.getElementById('limboEstPayoutVal'),
    limboAmount: document.getElementById('limboAmount'),
    limboTargetInput: document.getElementById('limboTargetInput'),
    limboPlayBtn: document.getElementById('limboPlayBtn'),

    // Neon Coin Flip
    coinflipStatusBadge: document.getElementById('coinflipStatusBadge'),
    cyberCoinEl: document.getElementById('cyberCoinEl'),
    cyberCoinFace: document.getElementById('cyberCoinFace'),
    coinflipResultSub: document.getElementById('coinflipResultSub'),
    coinflipAmount: document.getElementById('coinflipAmount'),
    coinflipEstWinHint: document.getElementById('coinflipEstWinHint'),
    coinflipPlayBtn: document.getElementById('coinflipPlayBtn'),

    // Lucky Wheel
    wheelStatusBadge: document.getElementById('wheelStatusBadge'),
    wheelBezelRing: document.getElementById('wheelBezelRing'),
    luckyWheelCanvas: document.getElementById('luckyWheelCanvas'),
    wheelResultSub: document.getElementById('wheelResultSub'),
    wheelAmount: document.getElementById('wheelAmount'),
    wheelSpinBtn: document.getElementById('wheelSpinBtn'),

    // Dragon Hi-Lo
    hiloStatusBadge: document.getElementById('hiloStatusBadge'),
    hiloBaseCardEl: document.getElementById('hiloBaseCardEl'),
    hiloBaseCornerTop: document.getElementById('hiloBaseCornerTop'),
    hiloBaseCenterPip: document.getElementById('hiloBaseCenterPip'),
    hiloBaseCornerBot: document.getElementById('hiloBaseCornerBot'),
    hiloNextCardEl: document.getElementById('hiloNextCardEl'),
    hiloNextCornerTop: document.getElementById('hiloNextCornerTop'),
    hiloNextCenterPip: document.getElementById('hiloNextCenterPip'),
    hiloNextCornerBot: document.getElementById('hiloNextCornerBot'),
    hiloHigherOdds: document.getElementById('hiloHigherOdds'),
    hiloLowerOdds: document.getElementById('hiloLowerOdds'),
    hiloResultSub: document.getElementById('hiloResultSub'),
    hiloAmount: document.getElementById('hiloAmount'),

    // Emerald 777 Slots
    slotsStatusBadge: document.getElementById('slotsStatusBadge'),
    slotReel0: document.getElementById('slotReel0'),
    slotReel1: document.getElementById('slotReel1'),
    slotReel2: document.getElementById('slotReel2'),
    slotsResultSub: document.getElementById('slotsResultSub'),
    slotsAmount: document.getElementById('slotsAmount'),
    slotsSpinBtn: document.getElementById('slotsSpinBtn'),

    // Crystal Keno
    kenoStatusBadge: document.getElementById('kenoStatusBadge'),
    kenoPickCountText: document.getElementById('kenoPickCountText'),
    kenoQuickPickBtn: document.getElementById('kenoQuickPickBtn'),
    kenoClearBtn: document.getElementById('kenoClearBtn'),
    kenoGrid: document.getElementById('kenoGrid'),
    kenoPaytableStrip: document.getElementById('kenoPaytableStrip'),
    kenoResultSub: document.getElementById('kenoResultSub'),
    kenoAmount: document.getElementById('kenoAmount'),
    kenoPlayBtn: document.getElementById('kenoPlayBtn'),

    // Sky Tower
    towerMultBadge: document.getElementById('towerMultBadge'),
    towerRowsContainer: document.getElementById('towerRowsContainer'),
    towerResultSub: document.getElementById('towerResultSub'),
    towerAmount: document.getElementById('towerAmount'),
    towerCashoutVal: document.getElementById('towerCashoutVal'),
    towerNextFloorText: document.getElementById('towerNextFloorText'),
    towerStartBtn: document.getElementById('towerStartBtn'),
    towerCashoutBtn: document.getElementById('towerCashoutBtn'),

    // Dragon Tiger
    dtStatusBadge: document.getElementById('dtStatusBadge'),
    dtDragonCard: document.getElementById('dtDragonCard'),
    dtTigerCard: document.getElementById('dtTigerCard'),
    dtChoiceGroup: document.getElementById('dtChoiceGroup'),
    dtResultSub: document.getElementById('dtResultSub'),
    dtAmount: document.getElementById('dtAmount'),
    dtDealBtn: document.getElementById('dtDealBtn'),

    // Neon Baccarat
    bacStatusBadge: document.getElementById('bacStatusBadge'),
    bacPlayerScore: document.getElementById('bacPlayerScore'),
    bacPlayerCards: document.getElementById('bacPlayerCards'),
    bacBankerScore: document.getElementById('bacBankerScore'),
    bacBankerCards: document.getElementById('bacBankerCards'),
    bacChoiceGroup: document.getElementById('bacChoiceGroup'),
    bacResultSub: document.getElementById('bacResultSub'),
    bacAmount: document.getElementById('bacAmount'),
    bacDealBtn: document.getElementById('bacDealBtn'),

    // Royal Roulette
    roulStatusBadge: document.getElementById('roulStatusBadge'),
    roulWheelDisc: document.getElementById('roulWheelDisc'),
    roulPocketOrb: document.getElementById('roulPocketOrb'),
    roulBetBoard: document.getElementById('roulBetBoard'),
    roulStraightRow: document.getElementById('roulStraightRow'),
    roulStraightInput: document.getElementById('roulStraightInput'),
    roulResultSub: document.getElementById('roulResultSub'),
    roulAmount: document.getElementById('roulAmount'),
    roulSpinBtn: document.getElementById('roulSpinBtn'),

    // Golden Scratch
    scratchStatusBadge: document.getElementById('scratchStatusBadge'),
    scratchGrid: document.getElementById('scratchGrid'),
    scratchResultSub: document.getElementById('scratchResultSub'),
    scratchAmount: document.getElementById('scratchAmount'),
    scratchBuyBtn: document.getElementById('scratchBuyBtn'),
    scratchRevealAllBtn: document.getElementById('scratchRevealAllBtn'),

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
    loginRememberCheck: document.getElementById('loginRememberCheck'),
    openForgotResetBtn: document.getElementById('openForgotResetBtn'),
    registerForm: document.getElementById('registerForm'),
    regPhone: document.getElementById('regPhone'),
    regName: document.getElementById('regName'),
    regRefCode: document.getElementById('regRefCode'),
    regPassword: document.getElementById('regPassword'),
    regAgeAgreement: document.getElementById('regAgeAgreement'),
    openTermsLink: document.getElementById('openTermsLink'),

    // Forgot Password Self-Reset Modal & Security Check
    forgotResetForm: document.getElementById('forgotResetForm'),
    forgotResetIdentifier: document.getElementById('forgotResetIdentifier'),
    forgotResetNewPass: document.getElementById('forgotResetNewPass'),
    forgotSecBox: document.getElementById('forgotSecBox'),
    forgotTurnstileMount: document.getElementById('forgotTurnstileMount'),
    forgotHumanRow: document.getElementById('forgotHumanRow'),
    forgotHumanCheck: document.getElementById('forgotHumanCheck'),
    forgotSecStatus: document.getElementById('forgotSecStatus'),
    forgotResetSubmitBtn: document.getElementById('forgotResetSubmitBtn'),
    forgotResetError: document.getElementById('forgotResetError'),
    forgotResetSuccess: document.getElementById('forgotResetSuccess'),
    backToLoginBtn: document.getElementById('backToLoginBtn'),

    // Profile & Settings Slide-Over Drawer
    profileModal: document.getElementById('profileModal'),
    profileAvatarInitial: document.getElementById('profileAvatarInitial'),
    profileRolloverStatus: document.getElementById('profileRolloverStatus'),
    profileSavedPayoutCount: document.getElementById('profileSavedPayoutCount'),
    profilePhone: document.getElementById('profilePhone'),
    profileName: document.getElementById('profileName'),
    profileFunBalance: document.getElementById('profileFunBalance'),
    profileRealBalance: document.getElementById('profileRealBalance'),
    profileDeposited: document.getElementById('profileDeposited'),
    profileWithdrawn: document.getElementById('profileWithdrawn'),
    profileRefEarnings: document.getElementById('profileRefEarnings'),
    profileVipBadge: document.getElementById('profileVipBadge'),
    profileVipProgress: document.getElementById('profileVipProgress'),
    profileVipCashback: document.getElementById('profileVipCashback'),
    profileVipNextText: document.getElementById('profileVipNextText'),
    profileRefCode: document.getElementById('profileRefCode'),
    profileCopyRefBtn: document.getElementById('profileCopyRefBtn'),
    drawerShareBtn: document.getElementById('drawerShareBtn'),
    profileDepositBtn: document.getElementById('profileDepositBtn'),
    profileWithdrawBtn: document.getElementById('profileWithdrawBtn'),
    profileRewardsBtn: document.getElementById('profileRewardsBtn'),
    profileSupportBtn: document.getElementById('profileSupportBtn'),
    drawerFairBtn: document.getElementById('drawerFairBtn'),
    drawerHowToBtn: document.getElementById('drawerHowToBtn'),
    logoutBtn: document.getElementById('logoutBtn'),

    // Deposit Modal (Privacy-Masked Dynamic QR + Download QR)
    depositModal: document.getElementById('depositModal'),
    depositAccountsList: document.getElementById('depositAccountsList'),
    depGatewayCards: document.getElementById('depGatewayCards'),
    depositErrorBox: document.getElementById('depositErrorBox'),
    depositSuccessBox: document.getElementById('depositSuccessBox'),
    depositForm: document.getElementById('depositForm'),
    depMethod: document.getElementById('depMethod'),
    depAmount: document.getElementById('depAmount'),
    depSenderName: document.getElementById('depSenderName'),
    depSenderNumber: document.getElementById('depSenderNumber'),
    depLimitInfoText: document.getElementById('depLimitInfoText'),
    depLiveQrCard: document.getElementById('depLiveQrCard'),
    depTabDirectBtn: document.getElementById('depTabDirectBtn'),
    depTabQrBtn: document.getElementById('depTabQrBtn'),
    depDirectPanel: document.getElementById('depDirectPanel'),
    depQrPanel: document.getElementById('depQrPanel'),
    depDirectBank: document.getElementById('depDirectBank'),
    depDirectTitle: document.getElementById('depDirectTitle'),
    depDirectNumber: document.getElementById('depDirectNumber'),
    depDirectIbanRow: document.getElementById('depDirectIbanRow'),
    depDirectIban: document.getElementById('depDirectIban'),
    depDirectAmount: document.getElementById('depDirectAmount'),
    depQrGatewayBadge: document.getElementById('depQrGatewayBadge'),
    depQrAmountBadge: document.getElementById('depQrAmountBadge'),
    depQrRefBadge: document.getElementById('depQrRefBadge'),
    depQrImg: document.getElementById('depQrImg'),
    depQrPlaceholder: document.getElementById('depQrPlaceholder'),
    depQrLoadingText: document.getElementById('depQrLoadingText'),
    depQrScanHint: document.getElementById('depQrScanHint'),
    depSaveQrBtn: document.getElementById('depSaveQrBtn'),
    depMicroHint: document.getElementById('depMicroHint'),
    depTid: document.getElementById('depTid'),
    depScreenshot: document.getElementById('depScreenshot'),
    depPreviewWrap: document.getElementById('depPreviewWrap'),
    depPreviewImg: document.getElementById('depPreviewImg'),
    depClearImgBtn: document.getElementById('depClearImgBtn'),
    depSubmitBtn: document.getElementById('depSubmitBtn'),

    // Withdraw Modal
    withdrawModal: document.getElementById('withdrawModal'),
    withdrawHoursAlert: document.getElementById('withdrawHoursAlert'),
    withdrawAvailBalance: document.getElementById('withdrawAvailBalance'),
    withdrawRolloverBox: document.getElementById('withdrawRolloverBox'),
    withdrawRolloverTitle: document.getElementById('withdrawRolloverTitle'),
    withdrawRolloverRatio: document.getElementById('withdrawRolloverRatio'),
    withdrawRolloverBar: document.getElementById('withdrawRolloverBar'),
    withdrawRolloverHint: document.getElementById('withdrawRolloverHint'),
    savedPayoutsList: document.getElementById('savedPayoutsList'),
    wdGatewayCards: document.getElementById('wdGatewayCards'),
    withdrawErrorBox: document.getElementById('withdrawErrorBox'),
    withdrawSuccessBox: document.getElementById('withdrawSuccessBox'),
    withdrawForm: document.getElementById('withdrawForm'),
    wdMethod: document.getElementById('wdMethod'),
    wdAmount: document.getElementById('wdAmount'),
    wdFeeGross: document.getElementById('wdFeeGross'),
    wdFeePctLabel: document.getElementById('wdFeePctLabel'),
    wdFeeAmt: document.getElementById('wdFeeAmt'),
    wdFeeNet: document.getElementById('wdFeeNet'),
    wdBankNameGroup: document.getElementById('wdBankNameGroup'),
    wdBankName: document.getElementById('wdBankName'),
    wdAccountTitle: document.getElementById('wdAccountTitle'),
    wdCnic: document.getElementById('wdCnic'),
    wdAccountNumber: document.getElementById('wdAccountNumber'),
    wdCopyNumBtn: document.getElementById('wdCopyNumBtn'),
    wdSaveAccountChk: document.getElementById('wdSaveAccountChk'),
    wdSubmitBtn: document.getElementById('wdSubmitBtn'),

    // Rewards, Audio & Support Modals
    rewardsVipTierName: document.getElementById('rewardsVipTierName'),
    rewardsNextTierLabel: document.getElementById('rewardsNextTierLabel'),
    rewardsVipProgress: document.getElementById('rewardsVipProgress'),
    rewardsEligibilityHint: document.getElementById('rewardsEligibilityHint'),
    rewardsDailyDesc: document.getElementById('rewardsDailyDesc'),
    rewardsWeeklyDesc: document.getElementById('rewardsWeeklyDesc'),
    claimDailyRewardBtn: document.getElementById('claimDailyRewardBtn'),
    claimWeeklyRewardBtn: document.getElementById('claimWeeklyRewardBtn'),
    rewardsRefCodeText: document.getElementById('rewardsRefCodeText'),
    rewardsRefEarnedText: document.getElementById('rewardsRefEarnedText'),
    copyReferralLinkBtn: document.getElementById('copyReferralLinkBtn'),
    rewardsStreakBadge: document.getElementById('rewardsStreakBadge'),
    rewardsStreakEarned: document.getElementById('rewardsStreakEarned'),
    rewardsStreakProgressBar: document.getElementById('rewardsStreakProgressBar'),
    rewardsStreakProgressText: document.getElementById('rewardsStreakProgressText'),
    rewardsStreakCalendar: document.getElementById('rewardsStreakCalendar'),
    rewardsStreakHint: document.getElementById('rewardsStreakHint'),
    claimStreakRewardBtn: document.getElementById('claimStreakRewardBtn'),

    playerAudioBgm: document.getElementById('playerAudioBgm'),
    playerAudioBgmLabel: document.getElementById('playerAudioBgmLabel'),
    playerAudioPreset: document.getElementById('playerAudioPreset'),
    playerAudioVolume: document.getElementById('playerAudioVolume'),
    playerAudioVolVal: document.getElementById('playerAudioVolVal'),
    playerAudioResetBtn: document.getElementById('playerAudioResetBtn'),

    newTicketToggleBtn: document.getElementById('newTicketToggleBtn'),
    newTicketForm: document.getElementById('newTicketForm'),
    newTicketSubject: document.getElementById('newTicketSubject'),
    newTicketText: document.getElementById('newTicketText'),
    newTicketImage: document.getElementById('newTicketImage'),
    newTicketAttachBtn: document.getElementById('newTicketAttachBtn'),
    newTicketImgPreviewWrap: document.getElementById('newTicketImgPreviewWrap'),
    newTicketImgPreview: document.getElementById('newTicketImgPreview'),
    newTicketClearImgBtn: document.getElementById('newTicketClearImgBtn'),
    userTicketList: document.getElementById('userTicketList'),
    activeTicketSubject: document.getElementById('activeTicketSubject'),
    activeTicketStatus: document.getElementById('activeTicketStatus'),
    userChatThread: document.getElementById('userChatThread'),
    userChatReplyForm: document.getElementById('userChatReplyForm'),
    userChatReplyInput: document.getElementById('userChatReplyInput'),
    userChatImage: document.getElementById('userChatImage'),
    userChatAttachBtn: document.getElementById('userChatAttachBtn'),
    userChatImgPreviewWrap: document.getElementById('userChatImgPreviewWrap'),
    userChatImgPreview: document.getElementById('userChatImgPreview'),
    userChatClearImgBtn: document.getElementById('userChatClearImgBtn'),
    chatLightboxTitle: document.getElementById('chatLightboxTitle'),
    chatLightboxImg: document.getElementById('chatLightboxImg'),

    fairModal: document.getElementById('fairModal'),
    fairRoundHeading: document.getElementById('fairRoundHeading'),
    fairSeedDetails: document.getElementById('fairSeedDetails'),
    fairClientSeedInput: document.getElementById('fairClientSeedInput'),
    saveClientSeedBtn: document.getElementById('saveClientSeedBtn'),
    fairClientSeedStatus: document.getElementById('fairClientSeedStatus'),
    verifyServerSeedInput: document.getElementById('verifyServerSeedInput'),
    verifyClientSeedInput: document.getElementById('verifyClientSeedInput'),
    verifyNonceInput: document.getElementById('verifyNonceInput'),
    verifyHmacBtn: document.getElementById('verifyHmacBtn'),
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
    let cleaned = String(raw || '')
      .replace(/[\s\-()]+/g, '')
      .trim();
    if (/^\+923[0-9]{9}$/.test(cleaned)) {
      cleaned = `0${cleaned.slice(3)}`;
    } else if (/^00923[0-9]{9}$/.test(cleaned)) {
      cleaned = `0${cleaned.slice(4)}`;
    } else if (/^923[0-9]{9}$/.test(cleaned)) {
      cleaned = `0${cleaned.slice(2)}`;
    } else if (/^3[0-9]{9}$/.test(cleaned)) {
      cleaned = `0${cleaned}`;
    }
    return cleaned;
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
    el.soundToggleBtn?.classList.toggle('active', state.soundEnabled);
    el.soundToggleBtn?.setAttribute('aria-pressed', String(state.soundEnabled));
    el.soundOnIcon?.classList.toggle('hidden', !state.soundEnabled);
    el.soundOffIcon?.classList.toggle('hidden', state.soundEnabled);
    if (el.soundStatusLabel) {
      el.soundStatusLabel.textContent = state.soundEnabled ? 'SFX On' : 'Muted';
    }
  }

  el.soundToggleBtn?.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    lsSet('skywing_sound', state.soundEnabled ? 'on' : 'off');
    audio.setMuted(!state.soundEnabled);
    if (state.soundEnabled && state.user && state.activeGameId) {
      audio.setLocked(false);
      audio.ensureContext();
      audio.playClick();
      if (state.publicSettings.audioConfig?.bgmEnabled !== false) {
        audio.startBGM();
      }
      if (state.activeGameId === 'skywing-crash' && state.game.phase === 'FLYING') {
        audio.startTension();
      }
    }
    updateSoundUI();
  });
  updateSoundUI();

  function unlockAudioOnGesture() {
    if (!state.user || !state.activeGameId || !state.soundEnabled) return;
    audio.setLocked(false);
    audio.ensureContext();
    if (state.publicSettings.audioConfig?.bgmEnabled !== false && !audio.bgmRunning) {
      audio.startBGM();
    }
  }
  window.addEventListener('pointerdown', unlockAudioOnGesture);
  window.addEventListener('keydown', unlockAudioOnGesture);

  // ==========================================================================
  // Currency Mode Switcher (Fun Mode FC <-> Real Money Mode PKR)
  // ==========================================================================
  function setCurrencyMode(mode) {
    state.currencyMode = mode === 'real' ? 'real' : 'fun';
    lsSet('skywing_mode', state.currencyMode);
    updateModeAndWalletUI();
    updatePanelButtons();
    updateDiceMetrics();
    updateLimboMetrics();
    updateCoinflipMetrics();
    updateTowerCashoutUI?.();
    renderSidebar();
  }

  function updateModeAndWalletUI() {
    const isReal = state.currencyMode === 'real';
    if (el.modeFunBtn) el.modeFunBtn.className = `mode-btn ${!isReal ? 'active-fun' : ''}`;
    if (el.modeRealBtn) el.modeRealBtn.className = `mode-btn ${isReal ? 'active-real' : ''}`;

    el.realWalletActions?.classList.toggle('hidden', !isReal);

    el.walletBalance?.classList.toggle('real-active', isReal);
    if (el.walletModeLabel) el.walletModeLabel.textContent = isReal ? 'Real PKR' : 'Fun Credits';
    if (el.bettingModeHint) {
      el.bettingModeHint.textContent = isReal
        ? 'Place your Real Money (PKR) bets'
        : 'Place your Fun Credits (FC) bets';
    }

    if (el.walletBalance) {
      if (state.user) {
        const bal = isReal ? state.user.realBalance : state.user.funBalance;
        el.walletBalance.textContent = fmtMoney(bal, state.currencyMode);
      } else {
        el.walletBalance.textContent = isReal ? '0.00 PKR' : '0.00 FC';
      }
    }
  }

  el.modeFunBtn?.addEventListener('click', () => {
    audio.playClick();
    setCurrencyMode('fun');
  });
  el.modeRealBtn?.addEventListener('click', () => {
    audio.playClick();
    setCurrencyMode('real');
  });

  // ==========================================================================
  // Public Settings, Maintenance Lock, Operating Hours, Audio & Multi-Game UI
  // ==========================================================================
  function getEffectiveAudioConfig(serverCfg) {
    const base = serverCfg || state.publicSettings.audioConfig || { bgmEnabled: true, soundPreset: 'aviator-jet', masterVolume: 75 };
    try {
      const savedRaw = lsGet('skywing_player_audio');
      if (savedRaw) {
        const parsed = JSON.parse(savedRaw);
        return {
          bgmEnabled: parsed.bgmEnabled !== undefined ? Boolean(parsed.bgmEnabled) : base.bgmEnabled,
          soundPreset: parsed.soundPreset || base.soundPreset,
          masterVolume: parsed.masterVolume !== undefined ? Number(parsed.masterVolume) : base.masterVolume,
        };
      }
    } catch {
      // ignore parse errors
    }
    return base;
  }

  function syncPlayerAudioDrawerUI() {
    const cfg = getEffectiveAudioConfig(state.publicSettings.audioConfig);
    if (el.playerAudioBgm) el.playerAudioBgm.checked = cfg.bgmEnabled !== false;
    if (el.playerAudioBgmLabel) el.playerAudioBgmLabel.textContent = cfg.bgmEnabled !== false ? 'ON' : 'OFF';
    if (el.playerAudioPreset) el.playerAudioPreset.value = cfg.soundPreset || 'aviator-jet';
    if (el.playerAudioVolume) el.playerAudioVolume.value = Number(cfg.masterVolume ?? 75);
    if (el.playerAudioVolVal) el.playerAudioVolVal.textContent = `${Number(cfg.masterVolume ?? 75)}%`;
  }

  function applyPublicSettingsPayload(data) {
    if (!data) return;
    state.publicSettings = {
      ...state.publicSettings,
      ...data,
    };
    const effectiveAudio = getEffectiveAudioConfig(state.publicSettings.audioConfig);
    audio.setConfig(effectiveAudio, state.soundEnabled);
    syncPlayerAudioDrawerUI();
    renderPaymentAccounts();
    syncPlatformStatusUI();
    syncWithdrawalHoursUI();
    syncGamesLobbyUI();
  }

  function syncPlatformStatusUI() {
    const ps = state.publicSettings.platformStatus || { mode: 'active', message: '' };
    const isLocked = ps.mode && ps.mode !== 'active';
    if (!el.maintenanceOverlay) return;
    el.maintenanceOverlay.classList.toggle('hidden', !isLocked);
    if (isLocked) {
      if (el.maintenanceStatusPill) {
        el.maintenanceStatusPill.textContent = ps.mode === 'disabled' ? 'PLATFORM DISABLED' : 'PLATFORM MAINTENANCE';
      }
      if (el.maintenanceTitle) {
        el.maintenanceTitle.textContent =
          ps.mode === 'disabled' ? 'Platform Temporarily Disabled' : 'SkyWing Servers Under Maintenance';
      }
      if (el.maintenanceMessage) {
        el.maintenanceMessage.textContent = ps.message || 'Platform is undergoing maintenance. Please check back shortly.';
      }
    }
  }

  function syncWithdrawalHoursUI() {
    const wh = state.publicSettings.withdrawalHours || {};
    const closed = Boolean(wh.enabled) && wh.currentlyOpen === false;
    if (el.helpWithdrawHoursText) {
      el.helpWithdrawHoursText.textContent = `${wh.openTime || '09:00'} – ${wh.closeTime || '17:00'}`;
    }
    if (el.withdrawHoursAlert) {
      el.withdrawHoursAlert.classList.toggle('hidden', !closed);
      if (closed) {
        el.withdrawHoursAlert.textContent = wh.noticeText || 'Withdrawals are only open from 9:00 AM to 5:00 PM.';
      }
    }
    if (el.wdSubmitBtn) {
      el.wdSubmitBtn.disabled = closed;
    }
    const limits = state.publicSettings.financialLimits || {};
    if (el.depLimitInfoText) {
      el.depLimitInfoText.textContent = `Min Deposit: ${Number(limits.minDeposit || 50)} PKR · Micro-deposits up to ${Number(limits.microDepositAutoApproveLimit || 1000).toLocaleString()} PKR with valid TID are auto-approved instantly!`;
    }
  }

  const GAME_LABELS = {
    'skywing-crash': 'SkyWing Crash',
    'cyber-plinko': 'Cyber Plinko',
    'golden-mines': 'Golden Mines',
    'cyber-dice': 'Cyber Dice',
    'cyber-limbo': 'Limbo X',
    'neon-flip': 'Neon Coin Flip',
    'lucky-wheel': 'Lucky Wheel',
    'dragon-hilo': 'Dragon Hi-Lo',
    'emerald-slots': 'Emerald 777 Slots',
    'crystal-keno': 'Crystal Keno',
    'tower-climb': 'Sky Tower',
    'dragon-tiger': 'Dragon Tiger',
    'neon-baccarat': 'Neon Baccarat',
    'triple-roulette': 'Royal Roulette',
    'lucky-scratch': 'Golden Scratch',
  };

  function getGameConfig(gameId) {
    const games = state.publicSettings.gamesConfig || [];
    return games.find((g) => g.id === gameId) || null;
  }

  function syncFullscreenButtonUI() {
    const active = Boolean(state.isFullscreen || document.fullscreenElement);
    document.body.classList.toggle('is-game-fullscreen', active);
    if (el.fullscreenToggleBtn) {
      el.fullscreenToggleBtn.setAttribute('aria-pressed', String(active));
    }
    if (el.fullscreenBtnLabel) {
      el.fullscreenBtnLabel.textContent = active ? 'Exit Full' : 'Fullscreen';
    }
    if (el.arenaFullscreenBtn) {
      el.arenaFullscreenBtn.textContent = active ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
    }
    if (state.activeGameId === 'skywing-crash') {
      setTimeout(() => resizeCanvas(), 50);
    }
  }

  async function toggleGameFullscreen() {
    const nextFs = !state.isFullscreen && !document.fullscreenElement;
    state.isFullscreen = nextFs;
    try {
      if (nextFs && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if (!nextFs && document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch {
      // Fallback gracefully to pure CSS full-viewport fullscreen inside embedded iframes
    }
    syncFullscreenButtonUI();
  }

  async function exitGameFullscreen() {
    state.isFullscreen = false;
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch {
      // ignore
    }
    syncFullscreenButtonUI();
  }

  document.addEventListener('fullscreenchange', () => {
    state.isFullscreen = Boolean(document.fullscreenElement);
    syncFullscreenButtonUI();
  });

  el.fullscreenToggleBtn?.addEventListener('click', toggleGameFullscreen);
  el.arenaFullscreenBtn?.addEventListener('click', toggleGameFullscreen);

  function syncFeaturePaneTabs() {
    if (!el.topFeaturePane) return;
    const activeTab = state.activeGameId || 'lobby';
    el.topFeaturePane.querySelectorAll('[data-feature-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.featureTab === activeTab);
    });
  }

  function syncGameWorkspaceView() {
    const isAuthed = Boolean(state.user);
    const hasActiveGame = Boolean(isAuthed && state.activeGameId);

    document.body.classList.toggle('in-game-mode', hasActiveGame);
    el.gameLobbySection?.classList.toggle('hidden', !isAuthed || hasActiveGame);
    el.activeGameWorkspace?.classList.toggle('hidden', !hasActiveGame);

    if (!hasActiveGame) {
      stopCrashRenderLoop();
      audio.setActiveGame(null);
      audio.setLocked(true);
      if (state.isFullscreen || document.fullscreenElement) {
        exitGameFullscreen();
      }
    } else if (el.activeArenaTitle) {
      el.activeArenaTitle.textContent = GAME_LABELS[state.activeGameId] || 'Game Arena';
    }
    syncFeaturePaneTabs();
  }

  function returnToGameLobby() {
    state.activeGameId = null;
    stopCrashRenderLoop();
    audio.setActiveGame(null);
    audio.setLocked(true);
    exitGameFullscreen();
    syncGamesLobbyUI();
    syncGameWorkspaceView();
  }

  function openPlayModeSelector(gameId) {
    if (!state.user) {
      openAuthModal(urlRefCode ? 'register' : 'login');
      return;
    }
    const cfg = getGameConfig(gameId);
    if (cfg && cfg.enabled === false) {
      showToast(`${cfg.name || GAME_LABELS[gameId] || 'Game'} is currently disabled by Admin.`, true);
      return;
    }
    state.pendingLaunchGameId = gameId;
    if (el.playModeGameName) el.playModeGameName.textContent = GAME_LABELS[gameId] || cfg?.name || 'Arcade Arena';
    if (el.playModeFunBal) el.playModeFunBal.textContent = fmtMoney(state.user.funBalance, 'fun');
    if (el.playModeRealBal) el.playModeRealBal.textContent = fmtMoney(state.user.realBalance, 'real');
    openModal('playModeSelectModal');
  }

  function syncGamesLobbyUI() {
    const games = state.publicSettings.gamesConfig || [];
    if (el.gameLobbyBar) {
      el.gameLobbyBar.querySelectorAll('.game-lobby-card').forEach((card) => {
        const gid = card.dataset.game;
        const cfg = games.find((g) => g.id === gid);
        const enabled = cfg ? cfg.enabled !== false : true;
        card.classList.toggle('is-disabled', !enabled);
        card.classList.toggle('active', state.activeGameId === gid);
        const badge = card.querySelector(`[data-game-badge="${gid}"]`);
        if (badge) {
          badge.textContent = enabled ? 'LIVE' : 'OFF';
        }
        const cat = card.dataset.category || 'crash';
        const showCat = state.lobbyCategory === 'all' || state.lobbyCategory === cat;
        card.classList.toggle('hidden', !showCat);
      });
    }

    if (el.topFeaturePane) {
      el.topFeaturePane.querySelectorAll('[data-feature-tab]').forEach((tab) => {
        const tid = tab.dataset.featureTab;
        if (!GAME_LABELS[tid]) return;
        const cfg = games.find((g) => g.id === tid);
        const enabled = cfg ? cfg.enabled !== false : true;
        tab.disabled = !enabled;
        tab.style.opacity = enabled ? '' : '0.45';
      });
    }

    if (state.activeGameId) {
      const activeCfg = games.find((g) => g.id === state.activeGameId);
      if (activeCfg && activeCfg.enabled === false) {
        showToast(`${activeCfg.name} is temporarily offline.`, true);
        returnToGameLobby();
      }
    }
  }

  function switchActiveGame(gameId) {
    if (!state.user) {
      openAuthModal(urlRefCode ? 'register' : 'login');
      return;
    }
    const cfg = getGameConfig(gameId);
    if (cfg && cfg.enabled === false) {
      showToast(`${cfg.name} is currently disabled by Admin.`, true);
      return;
    }

    state.activeGameId = gameId;
    el.crashArenaContainer?.classList.toggle('hidden', gameId !== 'skywing-crash');
    el.plinkoArena?.classList.toggle('hidden', gameId !== 'cyber-plinko');
    el.minesArena?.classList.toggle('hidden', gameId !== 'golden-mines');
    el.diceArena?.classList.toggle('hidden', gameId !== 'cyber-dice');
    el.limboArena?.classList.toggle('hidden', gameId !== 'cyber-limbo');
    el.coinflipArena?.classList.toggle('hidden', gameId !== 'neon-flip');
    el.wheelArena?.classList.toggle('hidden', gameId !== 'lucky-wheel');
    el.hiloArena?.classList.toggle('hidden', gameId !== 'dragon-hilo');
    el.slotsArena?.classList.toggle('hidden', gameId !== 'emerald-slots');
    el.kenoArena?.classList.toggle('hidden', gameId !== 'crystal-keno');
    el.towerArena?.classList.toggle('hidden', gameId !== 'tower-climb');
    el.dragonTigerArena?.classList.toggle('hidden', gameId !== 'dragon-tiger');
    el.baccaratArena?.classList.toggle('hidden', gameId !== 'neon-baccarat');
    el.rouletteArena?.classList.toggle('hidden', gameId !== 'triple-roulette');
    el.scratchArena?.classList.toggle('hidden', gameId !== 'lucky-scratch');

    // Enforce strict per-game SFX isolation
    audio.setActiveGame(gameId);
    audio.setLocked(false);
    audio.setMuted(!state.soundEnabled);
    if (state.soundEnabled) {
      audio.ensureContext();
      audio.playClick();
      if (state.publicSettings.audioConfig?.bgmEnabled !== false && !audio.bgmRunning) {
        audio.startBGM();
      }
      if (gameId === 'skywing-crash' && state.game.phase === 'FLYING') {
        audio.startTension();
      } else {
        audio.stopTension();
      }
    }

    syncGamesLobbyUI();
    syncGameWorkspaceView();
    syncPhaseOverlays();
    renderHistory();
    renderSidebar();
    updatePanelButtons();

    if (gameId === 'skywing-crash') {
      setTimeout(() => {
        resizeCanvas();
        startCrashRenderLoop();
      }, 25);
    } else {
      stopCrashRenderLoop();
      if (gameId === 'cyber-plinko') {
        renderPlinkoBoard();
      } else if (gameId === 'golden-mines') {
        renderMinesGrid();
      } else if (gameId === 'cyber-dice') {
        updateDiceMetrics();
      } else if (gameId === 'cyber-limbo') {
        updateLimboMetrics();
      } else if (gameId === 'neon-flip') {
        updateCoinflipMetrics();
      } else if (gameId === 'lucky-wheel') {
        initWheelBezelLeds();
        renderWheelCanvas(state.wheelRotation);
      } else if (gameId === 'dragon-hilo') {
        updateHiLoOddsUI();
      } else if (gameId === 'crystal-keno') {
        renderKenoBoard();
        renderKenoPaytable();
      } else if (gameId === 'tower-climb') {
        renderTowerRows();
        updateTowerCashoutUI();
      } else if (gameId === 'lucky-scratch') {
        if (!state.scratch.cells.length) renderScratchGrid();
      }
    }
  }

  el.lobbyCategoryFilters?.querySelectorAll('[data-lobby-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.lobbyCategory = btn.dataset.lobbyCat || 'all';
      el.lobbyCategoryFilters?.querySelectorAll('[data-lobby-cat]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      syncGamesLobbyUI();
    });
  });

  el.homeQuickDepositBtn?.addEventListener('click', () => openDepositFlow());
  el.homeQuickRewardsBtn?.addEventListener('click', () => openRewardsFlow());

  el.gameLobbyBar?.querySelectorAll('.game-lobby-card').forEach((card) => {
    card.addEventListener('click', () => {
      openPlayModeSelector(card.dataset.game);
    });
  });

  el.playModeFunBtn?.addEventListener('click', () => {
    const gid = state.pendingLaunchGameId || 'skywing-crash';
    closeModal('playModeSelectModal');
    setCurrencyMode('fun');
    switchActiveGame(gid);
  });

  el.playModeRealBtn?.addEventListener('click', () => {
    const gid = state.pendingLaunchGameId || 'skywing-crash';
    closeModal('playModeSelectModal');
    setCurrencyMode('real');
    switchActiveGame(gid);
  });

  el.playModeDepositBtn?.addEventListener('click', () => {
    closeModal('playModeSelectModal');
    openDepositFlow();
  });

  el.topFeaturePane?.querySelectorAll('[data-feature-tab]').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.featureTab;
      if (!target) return;
      if (target === 'lobby') {
        returnToGameLobby();
      } else if (GAME_LABELS[target]) {
        openPlayModeSelector(target);
      } else if (target === 'deposit') {
        openDepositFlow();
      } else if (target === 'withdraw') {
        openWithdrawFlow();
      } else if (target === 'wallet') {
        if (!state.activeGameId) switchActiveGame('skywing-crash');
        setSidebarTab('wallet');
        el.tabWalletHistory?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (target === 'rewards') {
        openRewardsFlow();
      } else if (target === 'profile') {
        openModal('profileModal');
      } else if (target === 'support') {
        openSupportFlow();
      } else if (target === 'fairness') {
        inspectFairRound(null);
      } else if (target === 'help') {
        openHelpCenterModal();
      }
    });
  });

  el.backToLobbyBtn?.addEventListener('click', () => {
    returnToGameLobby();
  });
  el.headerBackHomeBtn?.addEventListener('click', () => {
    returnToGameLobby();
  });

  async function loadPublicSettings() {
    try {
      const res = await fetch('/api/public-settings');
      if (res.ok) {
        const data = await res.json();
        applyPublicSettingsPayload(data);
      }
    } catch {
      // ignore
    }
  }

  // Customer WhatsApp/Telegram helpline & channel links removed in favor of In-App Live Support Desk.

  function getGatewayBrandMeta(method) {
    if (method === 'EasyPaisa') {
      return {
        value: 'EasyPaisa',
        name: 'EasyPaisa',
        badge: 'MOBILE WALLET',
        sub: 'Dynamic QR',
        cls: 'brand-easypaisa',
        color: '#34d399',
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L4 7v5c0 5.25 3.4 9.74 8 11 4.6-1.26 8-5.75 8-11V7l-8-5z"/><path d="M9 12l2 2 4-4"/></svg>`,
      };
    }
    if (method === 'JazzCash') {
      return {
        value: 'JazzCash',
        name: 'JazzCash',
        badge: 'MOBILE WALLET',
        sub: 'Dynamic QR',
        cls: 'brand-jazzcash',
        color: '#fca5a5',
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
      };
    }
    return {
      value: 'Bank Account',
      name: 'E-Wallet / Bank Transfer',
      badge: 'QR / RAAST',
      sub: 'Verified QR',
      cls: 'brand-bank',
      color: '#7dd3fc',
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M3 10h18"/><path d="M5 6l7-3 7 3"/><path d="M4 10v11"/><path d="M20 10v11"/><path d="M8 14v3"/><path d="M12 14v3"/><path d="M16 14v3"/></svg>`,
    };
  }

  function renderGatewaySelector(containerEl, selectEl) {
    if (!containerEl || !selectEl) return;
    const methods = ['EasyPaisa', 'JazzCash', 'Bank Account'];
    const currentVal = selectEl.value || 'EasyPaisa';

    containerEl.innerHTML = methods
      .map((m) => {
        const meta = getGatewayBrandMeta(m);
        const active = meta.value === currentVal ? 'active' : '';
        return `
          <button type="button" class="gateway-chip ${meta.cls} ${active}" data-gateway="${meta.value}">
            <span class="gateway-icon-box ${meta.cls}" aria-hidden="true">${meta.icon}</span>
            <span class="gateway-chip-name">${meta.name}</span>
            <span class="gateway-chip-sub">${meta.sub}</span>
          </button>
        `;
      })
      .join('');

    containerEl.querySelectorAll('.gateway-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        selectEl.value = chip.dataset.gateway;
        selectEl.dispatchEvent(new Event('change'));
        renderGatewaySelector(containerEl, selectEl);
      });
    });
  }

  el.depMethod?.addEventListener('change', () => {
    // Strictly prevent any browser/user autofill on sender account inputs
    if (el.depSenderName) el.depSenderName.value = '';
    if (el.depSenderNumber) el.depSenderNumber.value = '';
    renderGatewaySelector(el.depGatewayCards, el.depMethod);
    scheduleDynamicQrUpdate(true);
  });

  async function copyValueWithButton(btn, val, label = 'Copied!') {
    try {
      await navigator.clipboard.writeText(val);
      const prev = btn.textContent;
      btn.textContent = label;
      showToast(`Copied: ${val}`);
      setTimeout(() => {
        btn.textContent = prev;
      }, 1500);
    } catch {
      showToast(`Copied!`);
    }
  }

  function renderPaymentAccounts() {
    renderGatewaySelector(el.depGatewayCards, el.depMethod);
    renderGatewaySelector(el.wdGatewayCards, el.wdMethod);

    const acc = state.publicSettings.paymentAccounts;
    if (!acc) {
      el.depositAccountsList.innerHTML =
        '<span class="form-hint">Payment gateways are initializing...</span>';
      return;
    }

    const cards = [];
    if (acc.easypaisa?.enabled) {
      cards.push({
        meta: getGatewayBrandMeta('EasyPaisa'),
        label: 'EasyPaisa',
        subtitle: acc.easypaisa.accountNumber
          ? `${acc.easypaisa.accountNumber} · Instant`
          : acc.easypaisa.supportsAllBanks
            ? 'Direct # & IBAN · All Banks'
            : 'Direct # · Instant',
      });
    }
    if (acc.jazzcash?.enabled) {
      cards.push({
        meta: getGatewayBrandMeta('JazzCash'),
        label: 'JazzCash',
        subtitle: acc.jazzcash.accountNumber
          ? `${acc.jazzcash.accountNumber} · Instant`
          : acc.jazzcash.supportsAllBanks
            ? 'Direct # & IBAN · All Banks'
            : 'Direct # · Instant',
      });
    }
    if (acc.bank?.enabled) {
      cards.push({
        meta: getGatewayBrandMeta('Bank Account'),
        label: acc.bank.bankName || 'E-Wallet / Bank Transfer',
        subtitle: acc.bank.accountNumber
          ? `${acc.bank.accountNumber}`
          : 'All Pakistani Banks · Raast',
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
      <div class="gateway-badge-card">
        <span class="gateway-icon-box ${c.meta.cls}" style="width:30px;height:30px;" aria-hidden="true">${c.meta.icon}</span>
        <div style="min-width:0;">
          <strong style="color: ${c.meta.color}; font-size: 0.82rem; display:block; line-height:1.15;">${escapeHtml(c.label)}</strong>
          <span style="font-size: 0.68rem; color: var(--text-muted);">${escapeHtml(c.subtitle)}</span>
        </div>
      </div>
    `
      )
      .join('');
  }

  const openHelpCenterModal = () => openModal('howToModal');
  el.headerHelpBtn?.addEventListener('click', openHelpCenterModal);
  document.getElementById('footerHelpBtn')?.addEventListener('click', openHelpCenterModal);
  el.drawerHowToBtn?.addEventListener('click', () => {
    closeModal('profileModal');
    openHelpCenterModal();
  });
  document.getElementById('helpOpenSupportBtn')?.addEventListener('click', () => {
    closeModal('howToModal');
    openSupportFlow();
  });
  document.getElementById('helpOpenFairBtn')?.addEventListener('click', () => {
    closeModal('howToModal');
    inspectFairRound(null);
  });
  document.getElementById('helpOpenTermsBtn')?.addEventListener('click', () => {
    closeModal('howToModal');
    openModal('termsModal');
  });

  // ==========================================================================
  // Provably Fair Verification Modal (SHA-256 + HMAC-SHA256 + Client Seed)
  // ==========================================================================
  let activeFairHash = '';

  // Compact pure-JS synchronous SHA-256 (guaranteed to work across HTTP, HTTPS, iframes & WebViews)
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256HexSync(text) {
    const utf8 = unescape(encodeURIComponent(String(text || '')));
    const words = [];
    for (let i = 0; i < utf8.length; i += 1) {
      words[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
    }
    const bitLen = utf8.length * 8;
    words[bitLen >> 5] |= 0x80 << (24 - (bitLen % 32));
    words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;

    const H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const w = new Array(64);
    for (let i = 0; i < words.length; i += 16) {
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t += 1) {
        if (t < 16) {
          w[t] = words[i + t] | 0;
        } else {
          const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
          const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
          w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }

  async function computeSha256HexBrowser(text) {
    if (window.crypto?.subtle) {
      try {
        const enc = new TextEncoder();
        const digest = await window.crypto.subtle.digest('SHA-256', enc.encode(text));
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      } catch {
        // fallback below
      }
    }
    return sha256HexSync(text);
  }

  async function computeHmacCrashPointBrowser(serverSeed, clientSeed, nonce) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(serverSeed),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${clientSeed}:${nonce}`));
    const hmacHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const intVal = parseInt(hmacHex.slice(0, 13), 16);
    if (intVal % 33 === 0) {
      return { hmacHex, crashPoint: 1.0 };
    }
    const e = Math.pow(2, 52);
    const raw = Math.floor((100 * e - intVal) / (e - intVal)) / 100;
    return {
      hmacHex,
      crashPoint: Math.min(100, Math.max(1.01, raw)),
    };
  }

  async function runFairVerification(expectedHash = '') {
    const serverSeed = String(el.verifyServerSeedInput?.value || '').trim();
    const clientSeed = String(el.verifyClientSeedInput?.value || '').trim();
    const nonce = String(el.verifyNonceInput?.value || '').trim();

    if (!serverSeed) {
      el.fairVerifyResult.textContent = 'Server Seed is hidden until the flight ends. Enter a revealed Server Seed to verify.';
      el.fairVerifyResult.className = 'alert-error';
      el.fairVerifyResult.classList.remove('hidden');
      return;
    }

    if (!window.crypto?.subtle) {
      el.fairVerifyResult.textContent = 'Web Crypto API unavailable in this browser context.';
      el.fairVerifyResult.className = 'alert-error';
      el.fairVerifyResult.classList.remove('hidden');
      return;
    }

    try {
      const sha256Hex = await computeSha256HexBrowser(serverSeed);
      const { hmacHex, crashPoint } = await computeHmacCrashPointBrowser(
        serverSeed,
        clientSeed,
        nonce
      );

      const hasExpected = Boolean(expectedHash);
      const hashMatches = hasExpected ? sha256Hex === expectedHash : true;

      el.fairVerifyResult.innerHTML = `
        <div><strong>${hasExpected ? (hashMatches ? 'SHA-256 Commitment Verified' : 'SHA-256 Hash Mismatch') : 'SHA-256 Digest Computed'}:</strong> <span class="tabular-nums" style="word-break:break-all;">${sha256Hex}</span></div>
        <div style="margin-top:4px;"><strong>HMAC-SHA256 Result:</strong> <span class="tabular-nums">${crashPoint.toFixed(2)}x</span> <span style="opacity:0.75;">(${hmacHex.slice(0, 16)}...)</span></div>
      `;
      el.fairVerifyResult.className = hashMatches ? 'alert-success' : 'alert-error';
      el.fairVerifyResult.classList.remove('hidden');
    } catch {
      el.fairVerifyResult.textContent = 'Unable to compute verification digest.';
      el.fairVerifyResult.className = 'alert-error';
      el.fairVerifyResult.classList.remove('hidden');
    }
  }

  async function inspectFairRound(roundObj) {
    const r = roundObj || {
      roundNumber: state.game.roundNumber,
      serverSeedHash: state.game.serverSeedHash,
      serverSeed: state.game.serverSeed,
      clientSeed: state.game.clientSeed,
      nonce: state.game.nonce,
      crashPoint: state.game.phase === 'CRASHED' ? state.game.crashPoint : null,
    };

    activeFairHash = r.serverSeedHash || '';
    el.fairRoundHeading.textContent = `Flight #${r.roundNumber || '---'}`;
    el.fairSeedDetails.innerHTML = `
      <div><strong>Server Seed Hash (SHA-256):</strong><br/>${escapeHtml(r.serverSeedHash || '---')}</div>
      <div style="margin-top:8px;"><strong>Revealed Server Seed:</strong><br/>${escapeHtml(r.serverSeed || 'Hidden until flight finishes')}</div>
      <div style="margin-top:8px;"><strong>Client Seed:</strong> ${escapeHtml(r.clientSeed || '---')}</div>
      <div style="margin-top:4px;"><strong>Nonce:</strong> ${escapeHtml(r.nonce || '---')}</div>
      ${r.crashPoint ? `<div style="margin-top:4px;"><strong>Crash Point:</strong> ${Number(r.crashPoint).toFixed(2)}x</div>` : ''}
    `;

    if (el.fairClientSeedInput && !el.fairClientSeedInput.value) {
      el.fairClientSeedInput.value = state.game.clientSeed || '';
    }
    if (el.fairClientSeedStatus) {
      el.fairClientSeedStatus.classList.add('hidden');
    }
    if (el.verifyServerSeedInput) el.verifyServerSeedInput.value = r.serverSeed || '';
    if (el.verifyClientSeedInput) el.verifyClientSeedInput.value = r.clientSeed || '';
    if (el.verifyNonceInput) el.verifyNonceInput.value = r.nonce || '';

    el.fairVerifyResult.classList.add('hidden');
    if (r.serverSeed && window.crypto?.subtle) {
      await runFairVerification(r.serverSeedHash);
    }

    openModal('fairModal');
  }

  el.verifyHmacBtn?.addEventListener('click', () => {
    const useExpected =
      el.verifyServerSeedInput.value.trim() &&
      activeFairHash &&
      el.fairSeedDetails.textContent.includes(el.verifyServerSeedInput.value.trim())
        ? activeFairHash
        : '';
    runFairVerification(useExpected);
  });

  el.saveClientSeedBtn?.addEventListener('click', () => {
    const val = String(el.fairClientSeedInput?.value || '').trim();
    socket.emit('fair:setClientSeed', { clientSeed: val }, (res) => {
      if (!el.fairClientSeedStatus) return;
      if (!res?.ok) {
        el.fairClientSeedStatus.textContent = res?.error || 'Invalid client seed.';
        el.fairClientSeedStatus.style.color = '#f87171';
        el.fairClientSeedStatus.classList.remove('hidden');
        return;
      }
      el.fairClientSeedInput.value = res.clientSeed;
      el.fairClientSeedStatus.textContent = `Applied "${res.clientSeed}" for upcoming flights.`;
      el.fairClientSeedStatus.style.color = '#34d399';
      el.fairClientSeedStatus.classList.remove('hidden');
      showToast(`Next-round Client Seed set: ${res.clientSeed}`);
    });
  });

  el.drawerFairBtn?.addEventListener('click', () => {
    closeModal('profileModal');
    inspectFairRound(null);
  });
  el.roundSeedHudBtn?.addEventListener('click', () => inspectFairRound(null));

  // ==========================================================================
  // Authentication & User Profile & Settings Drawer
  // ==========================================================================
  let wasAuthenticated = Boolean(state.user);

  function getWhatsAppReferralHref() {
    const code = state.user?.referralCode || '';
    const refUrl = `${window.location.origin}/?ref=${encodeURIComponent(code)}`;
    return refUrl;
  }

  function buildWhatsAppShareUrl() {
    const shareUrl = getWhatsAppReferralHref();
    const msg = `Join me on SkyWing Arena! Play 15 provably fair games & earn welcome rewards with my link: ${shareUrl}`;
    return `https://wa.me/?text=${encodeURIComponent(msg)}`;
  }

  function syncWhatsappShareLinks() {
    const waHref = state.user?.referralCode ? buildWhatsAppShareUrl() : 'https://wa.me/';
    [el.shareHeaderBtn, el.homeWhatsappShareBtn, el.drawerShareBtn].forEach((anchorEl) => {
      if (anchorEl && anchorEl.tagName === 'A') {
        anchorEl.href = waHref;
      }
    });
  }

  function readRememberedCredentials() {
    try {
      const raw = lsGet('skywing_remember_creds');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.phone) return parsed;
    } catch {
      // ignore
    }
    return null;
  }

  function applyRememberedCredentialsToForm() {
    const saved = readRememberedCredentials();
    if (saved) {
      if (el.loginPhone && !el.loginPhone.value) el.loginPhone.value = saved.phone || '';
      if (el.loginPassword && !el.loginPassword.value) el.loginPassword.value = saved.password || '';
      if (el.loginRememberCheck) el.loginRememberCheck.checked = true;
    }
  }

  el.loginRememberCheck?.addEventListener('change', () => {
    if (!el.loginRememberCheck.checked) {
      lsRemove('skywing_remember_creds');
    }
  });

  document.querySelectorAll('[data-toggle-pw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.togglePw;
      const input = document.getElementById(targetId);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('is-visible', show);
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      const labelSpan = btn.querySelector('.pw-toggle-label');
      if (labelSpan) labelSpan.textContent = show ? 'Hide' : 'Show';
    });
  });

  function openAuthModal(defaultTab = 'login') {
    if (el.authErrorBox) el.authErrorBox.classList.add('hidden');
    const savedRef = lsGet('skywing_ref');
    if (savedRef && el.regRefCode && !el.regRefCode.value) {
      el.regRefCode.value = savedRef;
    }
    applyRememberedCredentialsToForm();
    if (defaultTab === 'register') {
      el.authTabRegister?.click();
    } else {
      el.authTabLogin?.click();
    }
    openModal('authModal');
  }

  function updateUserUI() {
    const isAuthed = Boolean(state.user);
    if (state.user) {
      const displayName = String(state.user.displayName || state.user.phoneNumber || 'Player').trim();
      if (el.authTriggerBtn) {
        el.authTriggerBtn.textContent = displayName;
        el.authTriggerBtn.classList.remove('btn-primary');
        el.authTriggerBtn.classList.add('btn-secondary');
      }
      if (el.userAccountLabel) el.userAccountLabel.textContent = displayName;
      if (el.profileAvatarInitial) {
        el.profileAvatarInitial.textContent = String(displayName || 'S').trim().charAt(0).toUpperCase() || 'S';
      }
      if (el.profilePhone) el.profilePhone.textContent = state.user.phoneNumber || '-';
      if (el.profileName) el.profileName.textContent = state.user.displayName || displayName;
      if (el.profileFunBalance) el.profileFunBalance.textContent = fmtMoney(state.user.funBalance, 'fun');
      if (el.profileRealBalance) el.profileRealBalance.textContent = fmtMoney(state.user.realBalance, 'real');
      if (el.profileDeposited) el.profileDeposited.textContent = fmtMoney(state.user.totalDeposited, 'real');
      if (el.profileWithdrawn) el.profileWithdrawn.textContent = fmtMoney(state.user.totalWithdrawn, 'real');
      if (el.profileRefEarnings) el.profileRefEarnings.textContent = fmtMoney(state.user.referralEarnings || 0, 'real');
      if (el.profileRefCode) el.profileRefCode.textContent = state.user.referralCode || '---';

      // Home Hero live wallet & VIP readout
      if (el.homeFunBalStat) el.homeFunBalStat.textContent = fmtMoney(state.user.funBalance, 'fun');
      if (el.homeRealBalStat) el.homeRealBalStat.textContent = fmtMoney(state.user.realBalance, 'real');
      if (el.homeVipStat) el.homeVipStat.textContent = `${state.user.vip?.tier || 'Bronze'} VIP`;

      const totalDep = Math.max(0, Number(state.user.totalDeposited || 0));
      const totalWager = Math.max(0, Number(state.user.totalWageredReal || 0));
      if (el.profileRolloverStatus) {
        if (totalWager >= totalDep) {
          el.profileRolloverStatus.textContent = '1x Rollover Ready';
          el.profileRolloverStatus.style.color = '#34d399';
        } else {
          const rem = Math.max(0, Math.round((totalDep - totalWager) * 100) / 100);
          el.profileRolloverStatus.textContent = `Wager ${rem.toLocaleString()} PKR more`;
          el.profileRolloverStatus.style.color = '#fbbf24';
        }
      }
      if (el.profileSavedPayoutCount) {
        const cnt = (state.user.savedPayoutAccounts || []).length;
        el.profileSavedPayoutCount.textContent = `${cnt} Saved`;
      }
      if (el.profileVipBadge && state.user.vip) {
        el.profileVipBadge.textContent = `${state.user.vip.tier} VIP`;
      }
      if (el.profileVipCashback && state.user.vip) {
        el.profileVipCashback.textContent = `${state.user.vip.cashbackPct}% Weekly Cashback`;
      }
      if (el.profileVipProgress && state.user.vip) {
        el.profileVipProgress.style.width = `${state.user.vip.progressPct || 0}%`;
      }
      if (el.profileVipNextText && state.user.vip) {
        el.profileVipNextText.textContent = state.user.vip.nextTier
          ? `Next: ${state.user.vip.nextTier} (${Number(state.user.vip.nextTarget || 0).toLocaleString()} PKR)`
          : 'Max Platinum VIP';
      }
      if (el.withdrawAvailBalance) el.withdrawAvailBalance.textContent = fmtMoney(state.user.realBalance, 'real');
      try {
        renderSavedPayouts();
      } catch {
        // non-fatal
      }
    } else {
      state.activeGameId = null;
      if (el.authTriggerBtn) {
        el.authTriggerBtn.textContent = 'Log In / Join';
        el.authTriggerBtn.classList.remove('btn-secondary');
        el.authTriggerBtn.classList.add('btn-primary');
      }
      if (el.userAccountLabel) el.userAccountLabel.textContent = 'Guest';
    }

    syncWhatsappShareLinks();

    // Auth-First Gate Enforcement + Visual Game Lobby Isolation
    el.authEntryGate?.classList.toggle('hidden', isAuthed);
    el.mainGameShell?.classList.toggle('hidden', !isAuthed);
    el.siteFooter?.classList.toggle('hidden', !isAuthed);
    el.headerGameControls?.classList.toggle('hidden', !isAuthed);
    el.headerLogoutBtn?.classList.toggle('hidden', !isAuthed);

    syncGameWorkspaceView();
    if (isAuthed && !wasAuthenticated && state.activeGameId) {
      setTimeout(() => {
        if (state.activeGameId === 'skywing-crash') {
          resizeCanvas();
          startCrashRenderLoop();
        } else if (state.activeGameId === 'cyber-plinko') {
          renderPlinkoBoard();
        } else if (state.activeGameId === 'golden-mines') {
          renderMinesGrid();
        }
      }, 40);
    }
    wasAuthenticated = isAuthed;

    updateModeAndWalletUI();
    if (state.activeGameId) {
      renderHistory();
      if (state.sidebarTab !== 'live') renderSidebar();
      updatePanelButtons();
    }
  }

  async function fetchCurrentUser() {
    const activeToken = state.token || readStoredToken();
    if (!activeToken) {
      state.user = null;
      state.transactions = [];
      updateUserUI();
      return;
    }
    state.token = activeToken;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!res.ok) {
        // Only clear session vault when backend explicitly rejects token (401/403)
        if (res.status === 401 || res.status === 403) {
          state.token = '';
          state.user = null;
          clearSessionVault();
          updateUserUI();
          openAuthModal(urlRefCode ? 'register' : 'login');
        }
        return;
      }
      const data = await res.json();
      state.user = data.user;
      if (data.refreshedToken) {
        state.token = data.refreshedToken;
      }
      saveSessionVault(state.token, state.user);
      if (data.publicSettings) {
        applyPublicSettingsPayload(data.publicSettings);
      }
      updateUserUI();
    } catch {
      // Keep cached session & wallet intact during transient network drops or redeploys
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
      openAuthModal(urlRefCode ? 'register' : 'login');
    }
  });

  el.gateLoginBtn?.addEventListener('click', () => openAuthModal('login'));
  el.gateRegisterBtn?.addEventListener('click', () => openAuthModal('register'));

  el.authTabLogin.addEventListener('click', () => {
    el.authTabLogin.classList.add('active');
    el.authTabRegister.classList.remove('active');
    el.loginForm.classList.remove('hidden');
    el.registerForm.classList.add('hidden');
    el.authErrorBox.classList.add('hidden');
  });

  el.authTabRegister?.addEventListener('click', () => {
    el.authTabRegister.classList.add('active');
    el.authTabLogin?.classList.remove('active');
    el.registerForm?.classList.remove('hidden');
    el.loginForm?.classList.add('hidden');
    el.authErrorBox?.classList.add('hidden');
    const savedRef = lsGet('skywing_ref');
    if (savedRef && el.regRefCode && !el.regRefCode.value) {
      el.regRefCode.value = savedRef;
    }
  });

  el.openTermsLink?.addEventListener('click', (e) => {
    e.preventDefault();
    openModal('termsModal');
  });

  function showAuthError(msg) {
    if (!el.authErrorBox) return;
    el.authErrorBox.textContent = msg;
    el.authErrorBox.classList.remove('hidden');
  }

  el.loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.authErrorBox?.classList.add('hidden');
    const rawIdentifier = String(el.loginPhone?.value || '').trim();
    const password = String(el.loginPassword?.value || '');
    if (!rawIdentifier) {
      showAuthError('Enter your mobile number or username.');
      return;
    }
    if (!password) {
      showAuthError('Enter your password.');
      return;
    }
    const submitBtn = document.getElementById('loginSubmitBtn') || el.loginForm.querySelector('button[type="submit"]');
    const origLabel = submitBtn ? submitBtn.textContent : 'Log In & Play';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Logging in...';
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        signal: controller ? controller.signal : undefined,
        headers: {
          'Content-Type': 'application/json',
          'x-device-fingerprint': DEVICE_FINGERPRINT,
        },
        body: JSON.stringify({
          phoneNumber: rawIdentifier,
          identifier: rawIdentifier,
          password,
          deviceFingerprint: DEVICE_FINGERPRINT,
        }),
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        const fallbackErr =
          res.status === 429
            ? 'Too many login attempts. Please wait a minute and try again.'
            : res.status >= 500
              ? 'Server busy during login. Please try again in a moment.'
              : 'Invalid mobile number/username or password.';
        showAuthError(data.error || fallbackErr);
        return;
      }
      if (data.isAdmin) {
        if (data.requires2FA) {
          closeModal('authModal');
          showToast('2FA enabled on Admin — enter Authenticator code on /admin.');
          setTimeout(() => {
            window.location.href = data.redirectUrl || '/admin';
          }, 400);
          return;
        }
        if (data.adminToken) {
          lsSet('skywing_admin_token', data.adminToken);
          closeModal('authModal');
          showToast('Admin authenticated — opening Operations Console...');
          setTimeout(() => {
            window.location.href = data.redirectUrl || '/admin';
          }, 350);
          return;
        }
      }
      if (!data.token || !data.user) {
        showAuthError(data.error || 'Login response incomplete. Please try again.');
        return;
      }
      state.token = data.token;
      state.user = data.user;
      state.activeGameId = null;

      if (el.loginRememberCheck?.checked) {
        lsSet(
          'skywing_remember_creds',
          JSON.stringify({
            phone: rawIdentifier,
            password,
          })
        );
        if (window.PasswordCredential && navigator.credentials?.store) {
          try {
            const cred = new window.PasswordCredential({
              id: rawIdentifier,
              password,
              name: state.user.displayName || rawIdentifier,
            });
            navigator.credentials.store(cred).catch(() => {});
          } catch {
            // ignore unsupported contexts
          }
        }
      } else {
        lsRemove('skywing_remember_creds');
      }

      saveSessionVault(state.token, state.user);
      try {
        socket.emit('auth:identify', { token: state.token });
      } catch {
        // non-fatal
      }
      ['authModal', 'forgotPasswordModal', 'termsModal', 'playModeSelectModal'].forEach(closeModal);
      updateUserUI();
      fetchMyTransactions();
      showToast(`Welcome back, ${state.user.displayName || state.user.phoneNumber}!`);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        showAuthError('Login timed out. Please check your connection and try again.');
      } else {
        showAuthError('Network error. Please check your connection and try again.');
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origLabel;
      }
    }
  });

  el.registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.authErrorBox?.classList.add('hidden');
    if (!el.regAgeAgreement?.checked) {
      const msg = 'You must confirm you are 18+ and accept the User Agreement to register.';
      showAuthError(msg);
      showToast(msg, true);
      return;
    }
    const cleanPhone = normalizePakPhone(el.regPhone?.value);
    if (!PK_PHONE_REGEX.test(cleanPhone)) {
      showAuthError('Enter a valid 11-digit Pakistani mobile number starting with 03 (e.g. 03001234567).');
      return;
    }
    if ((el.regPassword?.value || '').length < 6) {
      showAuthError('Password must be at least 6 characters.');
      return;
    }
    const submitBtn = el.registerForm.querySelector('button[type="submit"]');
    const origLabel = submitBtn ? submitBtn.textContent : 'Create Account & Claim Bonus';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating Account...';
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        signal: controller ? controller.signal : undefined,
        headers: {
          'Content-Type': 'application/json',
          'x-device-fingerprint': DEVICE_FINGERPRINT,
        },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          displayName: el.regName?.value || '',
          referralCode: String(el.regRefCode?.value || '').trim().toUpperCase(),
          password: el.regPassword?.value || '',
          acceptedTerms: true,
          deviceFingerprint: DEVICE_FINGERPRINT,
        }),
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        showAuthError(data.error || 'Registration failed.');
        return;
      }
      if (!data.token || !data.user) {
        showAuthError('Registration response incomplete. Please try again.');
        return;
      }
      state.token = data.token;
      state.user = data.user;
      state.activeGameId = null;
      saveSessionVault(state.token, state.user);
      try {
        socket.emit('auth:identify', { token: state.token });
      } catch {
        // non-fatal
      }
      ['authModal', 'forgotPasswordModal', 'termsModal', 'playModeSelectModal'].forEach(closeModal);
      updateUserUI();
      fetchMyTransactions();
      if (state.user.bonusRestricted) {
        showToast('Account created (Bonus privileges restricted due to multi-device match).');
      } else {
        showToast(`Account created! Welcome to SkyWing, ${state.user.displayName}.`);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        showAuthError('Request timed out. Please try again.');
      } else {
        showAuthError('Network error. Please try again.');
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origLabel;
      }
    }
  });

  // Online Security Verification Check for Password Reset (Turnstile or Instant Sync SHA-256 PoW)
  let forgotChallengeToken = '';
  let forgotChallengeDifficulty = 2;
  let forgotTurnstileSiteKey = '';
  let forgotTurnstileToken = '';
  let forgotPowSolution = '';
  let forgotTurnstileWidgetId = null;
  let forgotChallengePromise = null;

  function setForgotSecStatus(label, isVerified = false) {
    if (!el.forgotSecStatus) return;
    el.forgotSecStatus.textContent = label;
    el.forgotSecStatus.classList.toggle('verified', Boolean(isVerified));
  }

  function solveResetPowChallenge(challengeToken, difficulty = 2) {
    if (!challengeToken) return '';
    const prefix = '0'.repeat(Math.max(1, Math.min(4, Number(difficulty || 2))));
    for (let nonce = 0; nonce < 250000; nonce += 1) {
      const candidate = String(nonce);
      const digest = sha256HexSync(`${challengeToken}:${candidate}`);
      if (digest.startsWith(prefix)) {
        return candidate;
      }
    }
    return '';
  }

  function showForgotPowFallbackBox() {
    forgotTurnstileSiteKey = '';
    forgotTurnstileToken = '';
    el.forgotTurnstileMount?.classList.add('hidden');
    el.forgotHumanRow?.classList.remove('hidden');
  }

  async function initForgotSecurityCheck(preserveCheckbox = false) {
    if (forgotChallengePromise && preserveCheckbox) {
      return forgotChallengePromise;
    }
    if (!preserveCheckbox) {
      forgotChallengeToken = '';
      forgotChallengeDifficulty = 2;
      forgotTurnstileSiteKey = '';
      forgotTurnstileToken = '';
      forgotPowSolution = '';
      if (el.forgotHumanCheck) el.forgotHumanCheck.checked = false;
      setForgotSecStatus('Tap to Verify', false);
    }

    forgotChallengePromise = (async () => {
      try {
        const res = await fetch('/api/auth/reset-challenge');
        const data = await res.json();
        forgotChallengeToken = String(data.challengeToken || '');
        forgotChallengeDifficulty = Number(data.difficulty || 2);
        const siteKey = String(data.turnstileSiteKey || '').trim();

        if (!preserveCheckbox && siteKey && el.forgotTurnstileMount && el.forgotHumanRow) {
          forgotTurnstileSiteKey = siteKey;
          el.forgotTurnstileMount.classList.remove('hidden');
          el.forgotHumanRow.classList.add('hidden');
          let rendered = false;
          const fallbackTimer = setTimeout(() => {
            if (!rendered && !forgotTurnstileToken) {
              showForgotPowFallbackBox();
            }
          }, 2200);

          const mountWidget = () => {
            if (!window.turnstile || !el.forgotTurnstileMount) return;
            try {
              el.forgotTurnstileMount.innerHTML = '';
              forgotTurnstileWidgetId = window.turnstile.render(el.forgotTurnstileMount, {
                sitekey: siteKey,
                theme: 'dark',
                callback: (token) => {
                  rendered = true;
                  clearTimeout(fallbackTimer);
                  forgotTurnstileToken = token;
                  setForgotSecStatus('Verified', true);
                },
                'error-callback': () => {
                  clearTimeout(fallbackTimer);
                  showForgotPowFallbackBox();
                },
                'expired-callback': () => {
                  forgotTurnstileToken = '';
                  setForgotSecStatus('Expired', false);
                },
              });
              rendered = true;
              clearTimeout(fallbackTimer);
            } catch {
              clearTimeout(fallbackTimer);
              showForgotPowFallbackBox();
            }
          };

          if (window.turnstile) {
            mountWidget();
          } else {
            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            script.onload = mountWidget;
            script.onerror = () => {
              clearTimeout(fallbackTimer);
              showForgotPowFallbackBox();
            };
            document.head.appendChild(script);
          }
        } else {
          showForgotPowFallbackBox();
        }
      } catch {
        showForgotPowFallbackBox();
        if (!preserveCheckbox) {
          setForgotSecStatus('Tap to Verify', false);
        }
      } finally {
        forgotChallengePromise = null;
      }
    })();

    return forgotChallengePromise;
  }

  async function verifyHumanCheckboxAction() {
    if (!el.forgotHumanCheck) return;
    if (!el.forgotHumanCheck.checked) {
      forgotPowSolution = '';
      setForgotSecStatus('Tap to Verify', false);
      return;
    }
    setForgotSecStatus('Verifying...', false);
    if (!forgotChallengeToken) {
      await initForgotSecurityCheck(true);
    }
    if (!forgotChallengeToken) {
      forgotPowSolution = '';
      el.forgotHumanCheck.checked = false;
      setForgotSecStatus('Retry Check', false);
      return;
    }
    const sol = solveResetPowChallenge(forgotChallengeToken, forgotChallengeDifficulty);
    if (sol) {
      forgotPowSolution = sol;
      el.forgotHumanCheck.checked = true;
      setForgotSecStatus('Verified', true);
    } else {
      forgotPowSolution = '';
      el.forgotHumanCheck.checked = false;
      setForgotSecStatus('Retry Check', false);
    }
  }

  el.forgotHumanCheck?.addEventListener('change', verifyHumanCheckboxAction);

  el.openForgotResetBtn?.addEventListener('click', () => {
    if (el.forgotResetIdentifier && el.loginPhone?.value) {
      el.forgotResetIdentifier.value = el.loginPhone.value.trim();
    }
    el.forgotResetError?.classList.add('hidden');
    el.forgotResetSuccess?.classList.add('hidden');
    closeModal('authModal');
    openModal('forgotPasswordModal');
    initForgotSecurityCheck(false);
  });

  el.backToLoginBtn?.addEventListener('click', () => {
    closeModal('forgotPasswordModal');
    openModal('authModal');
  });

  el.forgotResetForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.forgotResetError.classList.add('hidden');
    el.forgotResetSuccess.classList.add('hidden');

    const rawInput = String(el.forgotResetIdentifier?.value || '').trim();
    const isCnic = CNIC_REGEX.test(rawInput);
    const normalizedPhone = normalizePakPhone(rawInput);
    const isPhone = PK_PHONE_REGEX.test(normalizedPhone);

    if (!rawInput) {
      el.forgotResetError.textContent =
        'Enter your 03XX mobile number, registered username, or CNIC (XXXXX-XXXXXXX-X).';
      el.forgotResetError.classList.remove('hidden');
      return;
    }

    if (forgotTurnstileSiteKey && !el.forgotTurnstileMount?.classList.contains('hidden')) {
      if (!forgotTurnstileToken) {
        el.forgotResetError.textContent = 'Complete the security verification challenge first.';
        el.forgotResetError.classList.remove('hidden');
        return;
      }
    } else {
      if (!el.forgotHumanCheck?.checked) {
        el.forgotResetError.textContent = 'Tick the Online Security Check box to verify you are human.';
        el.forgotResetError.classList.remove('hidden');
        return;
      }
      if (!forgotChallengeToken) {
        await initForgotSecurityCheck(true);
      }
      if (!forgotPowSolution && forgotChallengeToken) {
        setForgotSecStatus('Verifying...', false);
        forgotPowSolution = solveResetPowChallenge(forgotChallengeToken, forgotChallengeDifficulty);
      }
      if (!forgotPowSolution) {
        el.forgotResetError.textContent = 'Security verification failed. Please tick the verification check again.';
        el.forgotResetError.classList.remove('hidden');
        return;
      }
    }

    const newPassword = el.forgotResetNewPass.value;
    if (el.forgotResetSubmitBtn) el.forgotResetSubmitBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: isCnic ? rawInput : isPhone ? normalizedPhone : rawInput,
          newPassword,
          turnstileToken: forgotTurnstileToken || undefined,
          powChallengeToken: forgotChallengeToken || undefined,
          powSolution: forgotPowSolution || undefined,
        }),
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        el.forgotResetError.textContent = data.error || 'Password reset failed.';
        el.forgotResetError.classList.remove('hidden');
        if (window.turnstile && forgotTurnstileWidgetId !== null) {
          try {
            window.turnstile.reset(forgotTurnstileWidgetId);
          } catch {
            // ignore
          }
        }
        initForgotSecurityCheck(false);
        return;
      }
      el.forgotResetSuccess.textContent = data.message || 'Password reset successfully! You can now log in.';
      el.forgotResetSuccess.classList.remove('hidden');
      el.forgotResetForm.reset();
      forgotPowSolution = '';
      setForgotSecStatus('Verified', true);
      showToast('Password updated! Please log in.');
    } catch {
      el.forgotResetError.textContent = 'Network error. Please try again.';
      el.forgotResetError.classList.remove('hidden');
    } finally {
      if (el.forgotResetSubmitBtn) el.forgotResetSubmitBtn.disabled = false;
    }
  });

  async function performLogout() {
    const activeToken = state.token;
    if (activeToken) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${activeToken}` },
      }).catch(() => {});
    }
    state.token = '';
    state.user = null;
    state.activeGameId = null;
    state.transactions = [];
    stopCrashRenderLoop();
    audio.setActiveGame(null);
    audio.setLocked(true);
    clearSessionVault();
    socket.emit('auth:identify', { token: '' });
    closeModal('profileModal');
    updateUserUI();
    showToast('Logged out successfully.');
  }

  el.logoutBtn?.addEventListener('click', performLogout);
  el.headerLogoutBtn?.addEventListener('click', performLogout);

  // ==========================================================================
  // Automated QR Deposit + Saved Pakistani Payout Accounts + Rollover & Fee
  // ==========================================================================
  function updateWithdrawRolloverUI() {
    if (!state.user || !el.withdrawRolloverBox) return;
    const totalDep = Math.max(0, Number(state.user.totalDeposited || 0));
    const totalWagered = Math.max(0, Number(state.user.totalWageredReal || 0));
    const remaining = Math.max(0, Math.round((totalDep - totalWagered) * 100) / 100);
    const met = totalWagered >= totalDep;
    const pct = totalDep > 0 ? Math.min(100, Math.round((totalWagered / totalDep) * 100)) : 100;

    el.withdrawRolloverBox.classList.toggle('cleared', met);
    el.withdrawRolloverBox.classList.toggle('pending', !met);
    el.withdrawRolloverRatio.textContent = `${totalWagered.toLocaleString()} / ${totalDep.toLocaleString()} PKR`;
    el.withdrawRolloverBar.style.width = `${pct}%`;
    el.withdrawRolloverBar.style.background = met ? '#10b981' : '#f59e0b';

    if (met) {
      el.withdrawRolloverTitle.textContent = '1x Wagering Rollover Completed';
      el.withdrawRolloverTitle.style.color = '#34d399';
      el.withdrawRolloverHint.textContent =
        'Your Real Money balance is unlocked for withdrawal.';
    } else {
      el.withdrawRolloverTitle.textContent = '1x Wagering Requirement Incomplete';
      el.withdrawRolloverTitle.style.color = '#fbbf24';
      el.withdrawRolloverHint.textContent = `Wager ${remaining.toLocaleString()} PKR more in Real Money Mode before submitting a withdrawal.`;
    }
  }

  function updateWithdrawFeePreview() {
    const gross = Math.max(0, Number(el.wdAmount?.value || 0));
    const feePct = Math.min(25, Math.max(0, Number(state.publicSettings.financialLimits?.withdrawalFeePct || 0)));
    const feeAmt = Math.round(gross * (feePct / 100) * 100) / 100;
    const netAmt = Math.max(0, Math.round((gross - feeAmt) * 100) / 100);
    if (el.wdFeeGross) el.wdFeeGross.textContent = `${gross.toLocaleString()} PKR`;
    if (el.wdFeePctLabel) el.wdFeePctLabel.textContent = String(feePct);
    if (el.wdFeeAmt) el.wdFeeAmt.textContent = `${feeAmt.toLocaleString()} PKR`;
    if (el.wdFeeNet) el.wdFeeNet.textContent = `${netAmt.toLocaleString()} PKR`;
  }

  el.wdAmount?.addEventListener('input', updateWithdrawFeePreview);

  function renderSavedPayouts() {
    if (!el.savedPayoutsList) return;
    const accounts = state.user?.savedPayoutAccounts || [];
    if (!accounts.length) {
      el.savedPayoutsList.innerHTML =
        '<span class="form-hint">No saved payout accounts yet. Tick "Save Account" below when withdrawing.</span>';
      return;
    }
    el.savedPayoutsList.innerHTML = accounts
      .map(
        (acc) => `
      <div class="saved-payout-card">
        <div>
          <strong>${escapeHtml(acc.method)}${acc.bankName ? ` (${escapeHtml(acc.bankName)})` : ''} · ${escapeHtml(acc.accountTitle)}</strong>
          <div class="tabular-nums" style="font-size:0.74rem; color:var(--text-muted);">${escapeHtml(acc.accountNumber)} · CNIC: ${escapeHtml(acc.cnic)}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" class="btn btn-emerald btn-xs" data-use-payout="${escapeHtml(acc.id)}">Use</button>
          <button type="button" class="btn btn-danger btn-xs" data-del-payout="${escapeHtml(acc.id)}">×</button>
        </div>
      </div>
    `
      )
      .join('');

    el.savedPayoutsList.querySelectorAll('[data-use-payout]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const acc = accounts.find((a) => String(a.id) === btn.dataset.usePayout);
        if (!acc) return;
        el.wdMethod.value = acc.method;
        el.wdMethod.dispatchEvent(new Event('change'));
        el.wdBankName.value = acc.bankName || '';
        el.wdAccountTitle.value = acc.accountTitle || '';
        el.wdAccountNumber.value = acc.accountNumber || '';
        el.wdCnic.value = acc.cnic || '';
        showToast(`Loaded saved ${acc.method} account!`);
      });
    });

    el.savedPayoutsList.querySelectorAll('[data-del-payout]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await fetch(`/api/payout-accounts/${btn.dataset.delPayout}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${state.token}` },
          });
          const data = await res.json();
          if (res.ok && data.user) {
            state.user = data.user;
            renderSavedPayouts();
            showToast('Saved payout account removed.');
          }
        } catch {
          showToast('Could not remove saved account.', true);
        }
      });
    });
  }

  function setQrLoadingState(message, clearRef = true) {
    if (clearRef) state.qrDepositRef = '';
    state.lastQrDataUrl = '';
    state.qrDownloadUrl = '';
    if (el.depQrImg) {
      el.depQrImg.classList.add('hidden');
      el.depQrImg.removeAttribute('src');
    }
    if (el.depSaveQrBtn) el.depSaveQrBtn.classList.add('hidden');
    if (el.depQrPlaceholder) el.depQrPlaceholder.classList.remove('hidden');
    if (el.depQrLoadingText) el.depQrLoadingText.textContent = message;
    if (clearRef && el.depQrRefBadge) el.depQrRefBadge.textContent = 'REF: ---';
  }

  function dataUrlToPngBlob(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes(',')) return null;
    const parts = dataUrl.split(',');
    const byteString = atob(parts[1]);
    const len = byteString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = byteString.charCodeAt(i);
    }
    return new Blob([bytes], { type: 'image/png' });
  }

  el.depSaveQrBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.lastQrDataUrl && !state.qrDownloadUrl) {
      await requestDynamicDepositQr();
    }
    if (!state.lastQrDataUrl && !state.qrDownloadUrl) {
      showToast('Generate a valid deposit QR code first.', true);
      return;
    }
    const amt = Math.round(Number(el.depAmount?.value || 0) || 0);
    const filename = `SkyWing-Deposit-QR-${amt}PKR.png`;
    try {
      let blob = dataUrlToPngBlob(state.lastQrDataUrl);
      if (!blob && state.qrDownloadUrl) {
        const dlRes = await fetch(state.qrDownloadUrl, { credentials: 'same-origin' });
        if (!dlRes.ok) throw new Error('QR fetch failed');
        const rawBuf = await dlRes.arrayBuffer();
        blob = new Blob([rawBuf], { type: 'image/png' });
      }
      if (!blob) throw new Error('QR image unavailable');

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.setAttribute('download', filename);
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
      }, 15000);
      showToast(`QR downloaded: ${filename}`);
    } catch {
      showToast('Could not download QR automatically. Please refresh the QR code and try again.', true);
    }
  });

  function setDepositTransferTab(tabName) {
    const showQr = tabName === 'qr';
    el.depTabDirectBtn?.classList.toggle('active', !showQr);
    el.depTabQrBtn?.classList.toggle('active', showQr);
    el.depDirectPanel?.classList.toggle('hidden', showQr);
    el.depQrPanel?.classList.toggle('hidden', !showQr);
  }

  el.depTabDirectBtn?.addEventListener('click', () => setDepositTransferTab('direct'));
  el.depTabQrBtn?.addEventListener('click', () => setDepositTransferTab('qr'));

  function syncDirectPanelFromSettings(method, amount, override = null) {
    const pa = state.publicSettings.paymentAccounts || {};
    const acct = method === 'EasyPaisa' ? pa.easypaisa : method === 'JazzCash' ? pa.jazzcash : pa.bank;
    const meta = getGatewayBrandMeta(method);
    const bankLabel = override?.bankName || acct?.bankName || (method === 'EasyPaisa' ? 'EasyPaisa / Telenor Bank' : method === 'JazzCash' ? 'JazzCash / Mobilink Bank' : 'Pakistani Bank / Raast');
    const title = override?.accountTitle || acct?.accountTitle || 'SkyWing Official';
    const acctNumber = override?.accountNumber || acct?.accountNumber || 'Contact Support';
    const iban = override?.iban !== undefined ? override.iban : (acct?.iban || '');

    if (el.depDirectBank) el.depDirectBank.textContent = bankLabel;
    if (el.depDirectTitle) el.depDirectTitle.textContent = title;
    if (el.depDirectNumber) el.depDirectNumber.textContent = acctNumber;
    if (el.depDirectIbanRow && el.depDirectIban) {
      if (iban) {
        el.depDirectIban.textContent = iban;
        el.depDirectIbanRow.classList.remove('hidden');
      } else {
        el.depDirectIban.textContent = '';
        el.depDirectIbanRow.classList.add('hidden');
      }
    }
    if (el.depDirectAmount) {
      el.depDirectAmount.textContent = Number.isFinite(amount) && amount > 0 ? `${amount.toLocaleString()} PKR` : '0 PKR';
    }
    if (el.depQrGatewayBadge && !override) {
      el.depQrGatewayBadge.textContent = `${meta.name} · Direct Transfer`;
    }
  }

  document.querySelectorAll('.dep-copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.copyTarget;
      const targetEl = targetId ? document.getElementById(targetId) : null;
      if (!targetEl) return;
      let text = String(targetEl.textContent || '').trim();
      if (btn.dataset.copyRaw === 'amount') {
        text = String(Math.round(Number(el.depAmount?.value || 0) || 0));
      }
      if (!text || text === 'Loading...' || text === '---') return;
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          copied = document.execCommand('copy');
          ta.remove();
        } catch {
          copied = false;
        }
      }
      if (copied) {
        const orig = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1600);
        showToast(`Copied: ${text}`);
      } else {
        showToast('Long-press the number to copy.', true);
      }
    });
  });

  async function requestDynamicDepositQr() {
    if (!state.token || !state.user) return;
    const method = el.depMethod?.value || 'EasyPaisa';
    const amount = Number(el.depAmount?.value || 0);
    const minDep = Number(state.publicSettings.financialLimits?.minDeposit || 50);
    const meta = getGatewayBrandMeta(method);

    syncDirectPanelFromSettings(method, amount, null);
    if (el.depQrGatewayBadge) el.depQrGatewayBadge.textContent = `${meta.name} · Direct & QR`;
    if (el.depQrAmountBadge) {
      el.depQrAmountBadge.textContent = Number.isFinite(amount) && amount > 0 ? `${amount.toLocaleString()} PKR` : '0 PKR';
    }

    if (!Number.isFinite(amount) || amount < minDep || amount > 1000000) {
      setQrLoadingState(`Enter at least ${minDep} PKR to generate your payment QR.`);
      if (el.depMicroHint) el.depMicroHint.textContent = '';
      return;
    }

    const seq = ++state.qrRequestSeq;
    setQrLoadingState(`Generating ${amount.toLocaleString()} PKR ${meta.name} QR...`, false);

    try {
      const res = await fetch('/api/transactions/deposit/qr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ method, amount }),
      });
      const data = await res.json();
      if (seq !== state.qrRequestSeq) return;

      if (!res.ok) {
        setQrLoadingState(data.error || 'Selected gateway unavailable.');
        return;
      }

      syncDirectPanelFromSettings(method, amount, data);
      state.qrDepositRef = data.qrReference;
      state.lastQrDataUrl = data.qrDataUrl || '';
      state.qrDownloadUrl = data.downloadUrl || '';
      if (el.depQrImg) {
        el.depQrImg.src = data.qrDataUrl;
        el.depQrImg.classList.remove('hidden');
      }
      if (el.depSaveQrBtn && data.qrDataUrl && data.downloadUrl) {
        el.depSaveQrBtn.classList.remove('hidden');
      }
      if (el.depQrPlaceholder) el.depQrPlaceholder.classList.add('hidden');
      if (el.depQrRefBadge) el.depQrRefBadge.textContent = `REF: ${data.qrReference}`;
      if (el.depQrGatewayBadge) {
        el.depQrGatewayBadge.textContent = data.displayMethod || `${meta.name} · Direct & QR`;
      }
      if (el.depQrAmountBadge) el.depQrAmountBadge.textContent = `${Number(data.amount).toLocaleString()} PKR`;
      if (el.depQrScanHint) {
        if (data.hasCustomQr) {
          el.depQrScanHint.innerHTML =
            'Official Account QR ready! Scan with <strong>EasyPaisa, JazzCash, SadaPay, NayaPay or any Bank App</strong>, or use <strong>Direct Number / IBAN</strong> above.';
        } else {
          el.depQrScanHint.innerHTML =
            'Note: Many Pakistani apps only accept official merchant QR or direct transfer. Use <strong>Direct Number / IBAN</strong> above for 100% instant success on every bank app!';
        }
      }
      if (el.depMicroHint) {
        const isMicro = data.microAutoApproveLimit > 0 && amount <= data.microAutoApproveLimit;
        el.depMicroHint.textContent = isMicro
          ? `Micro-Deposit Eligible! Enter your valid TID (6+ chars) for instant auto-approval.`
          : `Standard Review: Admin will approve shortly after verifying your TID / screenshot.`;
      }
    } catch {
      if (seq === state.qrRequestSeq) {
        setQrLoadingState('Network error generating QR. Use Direct Number / IBAN tab above.');
      }
    }
  }

  function scheduleDynamicQrUpdate(immediate = false) {
    if (state.qrDebounceTimer) {
      clearTimeout(state.qrDebounceTimer);
      state.qrDebounceTimer = null;
    }
    if (immediate) {
      requestDynamicDepositQr();
    } else {
      state.qrDebounceTimer = setTimeout(() => {
        requestDynamicDepositQr();
      }, 240);
    }
  }

  el.depAmount?.addEventListener('input', () => scheduleDynamicQrUpdate(false));

  document.querySelectorAll('.dep-amt-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.depAmount) {
        el.depAmount.value = btn.dataset.amt;
        scheduleDynamicQrUpdate(true);
      }
    });
  });

  function openDepositFlow() {
    if (!state.user) {
      openAuthModal(urlRefCode ? 'register' : 'login');
      return;
    }
    el.depositErrorBox.classList.add('hidden');
    el.depositSuccessBox.classList.add('hidden');
    const minDep = Number(state.publicSettings.financialLimits?.minDeposit || 50);
    if (el.depAmount && (!Number(el.depAmount.value) || Number(el.depAmount.value) < minDep)) {
      el.depAmount.value = String(Math.max(500, minDep));
    }
    // Strictly NEVER auto-fill sender account name or number
    if (el.depSenderName) el.depSenderName.value = '';
    if (el.depSenderNumber) el.depSenderNumber.value = '';
    if (el.depTid) el.depTid.value = '';
    renderPaymentAccounts();
    syncWithdrawalHoursUI();
    openModal('depositModal');
    scheduleDynamicQrUpdate(true);
  }

  async function openWithdrawFlow() {
    if (!state.user) {
      openAuthModal(urlRefCode ? 'register' : 'login');
      return;
    }
    await fetchCurrentUser();
    el.withdrawErrorBox.classList.add('hidden');
    el.withdrawSuccessBox.classList.add('hidden');
    el.withdrawAvailBalance.textContent = fmtMoney(state.user.realBalance, 'real');
    if (el.wdCnic && !el.wdCnic.value && state.user.cnic) {
      el.wdCnic.value = state.user.cnic;
    }
    renderGatewaySelector(el.wdGatewayCards, el.wdMethod);
    renderSavedPayouts();
    updateWithdrawRolloverUI();
    updateWithdrawFeePreview();
    syncWithdrawalHoursUI();
    openModal('withdrawModal');
  }

  el.headerDepositBtn?.addEventListener('click', openDepositFlow);
  el.openWithdrawBtn?.addEventListener('click', openWithdrawFlow);
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
    const senderName = String(el.depSenderName?.value || '').trim();
    const senderNumber = String(el.depSenderNumber?.value || '').trim();
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
        body: JSON.stringify({
          amount,
          method,
          senderName,
          senderNumber,
          qrReference: state.qrDepositRef,
          transactionId,
          screenshotData,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.depositErrorBox.textContent = data.error || 'Failed to submit deposit.';
        el.depositErrorBox.classList.remove('hidden');
        return;
      }

      if (data.autoApproved) {
        if (data.user) {
          state.user = data.user;
          updateUserUI();
        } else {
          fetchCurrentUser();
        }
        el.depositSuccessBox.textContent =
          `Instant Micro-Deposit Auto-Approved! ${Number(amount).toLocaleString()} PKR credited to your Real Balance.`;
        showToast(`Micro-deposit auto-approved (+${amount.toLocaleString()} PKR)!`);
      } else {
        el.depositSuccessBox.textContent =
          'Deposit proof submitted! Admin has been notified for verification.';
        showToast('Deposit request sent to Admin!');
      }
      el.depositSuccessBox.classList.remove('hidden');
      el.depositForm.reset();
      const minDep = Number(state.publicSettings.financialLimits?.minDeposit || 50);
      if (el.depAmount) el.depAmount.value = String(Math.max(500, minDep));
      if (el.depSenderName) el.depSenderName.value = '';
      if (el.depSenderNumber) el.depSenderNumber.value = '';
      state.depositScreenshotData = '';
      el.depPreviewWrap.classList.add('hidden');
      scheduleDynamicQrUpdate(true);
      fetchMyTransactions();
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
    renderGatewaySelector(el.wdGatewayCards, el.wdMethod);
  });

  el.wdCopyNumBtn?.addEventListener('click', () => {
    const val = el.wdAccountNumber.value.trim();
    if (!val) {
      showToast('Enter an Account Number or IBAN first.', true);
      return;
    }
    copyValueWithButton(el.wdCopyNumBtn, val);
  });

  el.withdrawForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.withdrawErrorBox.classList.add('hidden');
    el.withdrawSuccessBox.classList.add('hidden');

    const cnicVal = String(el.wdCnic?.value || '').trim();
    if (!CNIC_REGEX.test(cnicVal)) {
      const msg = 'Valid Pakistani CNIC is required (format: XXXXX-XXXXXXX-X).';
      el.withdrawErrorBox.textContent = msg;
      el.withdrawErrorBox.classList.remove('hidden');
      showToast(msg, true);
      return;
    }

    if (state.user) {
      const totalDep = Number(state.user.totalDeposited || 0);
      const totalWagered = Number(state.user.totalWageredReal || 0);
      if (totalWagered < totalDep) {
        const remaining = Math.round((totalDep - totalWagered) * 100) / 100;
        const msg = `1x Wagering Requirement not met! Wagered ${totalWagered.toLocaleString()} / ${totalDep.toLocaleString()} PKR. Play ${remaining.toLocaleString()} PKR more in Real Mode to unlock withdrawals.`;
        el.withdrawErrorBox.textContent = msg;
        el.withdrawErrorBox.classList.remove('hidden');
        showToast(msg, true);
        updateWithdrawRolloverUI();
        return;
      }
    }

    const wdPayload = {
      method: el.wdMethod.value,
      amount: Number(el.wdAmount.value),
      bankName: el.wdBankName.value.trim(),
      accountTitle: el.wdAccountTitle.value.trim(),
      accountNumber: el.wdAccountNumber.value.trim(),
      cnic: cnicVal,
    };

    el.wdSubmitBtn.disabled = true;
    try {
      const res = await fetch('/api/transactions/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify(wdPayload),
      });
      const data = await res.json();
      if (!res.ok) {
        el.withdrawErrorBox.textContent = data.error || 'Withdrawal failed.';
        el.withdrawErrorBox.classList.remove('hidden');
        showToast(data.error || 'Withdrawal failed.', true);
        return;
      }

      if (el.wdSaveAccountChk?.checked && state.user) {
        const alreadySaved = (state.user.savedPayoutAccounts || []).some(
          (a) => a.method === wdPayload.method && a.accountNumber === wdPayload.accountNumber
        );
        if (!alreadySaved) {
          fetch('/api/payout-accounts', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${state.token}`,
            },
            body: JSON.stringify(wdPayload),
          })
            .then((r) => r.json())
            .then((savedRes) => {
              if (savedRes.user) {
                state.user = savedRes.user;
                renderSavedPayouts();
              }
            })
            .catch(() => {});
        }
      }

      if (data.user) {
        state.user = data.user;
        updateUserUI();
        updateWithdrawRolloverUI();
      }
      el.withdrawSuccessBox.textContent =
        'Withdrawal request submitted! Amount is reserved and will be processed by Admin.';
      el.withdrawSuccessBox.classList.remove('hidden');
      el.withdrawForm.reset();
      el.wdBankNameGroup.classList.add('hidden');
      renderGatewaySelector(el.wdGatewayCards, el.wdMethod);
      updateWithdrawFeePreview();
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
        audio.playCasinoChime();
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
  // Isolated Per-Game History & Sidebar Rendering (Live Bets | My Bets | Wallet)
  // ==========================================================================
  function renderHistory() {
    if (!el.historyList) return;
    const gid = state.activeGameId || 'skywing-crash';

    if (gid === 'cyber-plinko') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Plinko Drops';
      const items = (state.arcade.plinkoHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Cyber Plinko drops...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${
          mult >= 5 ? 'mult-high' : mult >= 1.1 ? 'mult-med' : 'mult-low'
        }`;
        chip.textContent = `${mult.toFixed(1)}x`;
        chip.title = `Plinko (${String(item.risk || 'medium').toUpperCase()}) · Slot #${Number(item.slot ?? 0) + 1}`;
        chip.addEventListener('click', () => {
          showToast(
            `Plinko Drop: ${mult}x (${String(item.risk || 'med').toUpperCase()} risk · ${Number(item.amount || 0)} ${item.currencyMode === 'real' ? 'PKR' : 'FC'})`
          );
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'golden-mines') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Mines Games';
      const items = (state.arcade.minesHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Golden Mines results...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const boom = Boolean(item.boom);
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${
          boom ? 'mult-low' : mult >= 3 ? 'mult-high' : 'mult-med'
        }`;
        chip.textContent = boom ? 'Boom' : `${mult.toFixed(2)}x`;
        chip.title = `${item.diamondsCount || 0} Diamonds · ${item.minesCount || 3} Mines`;
        chip.addEventListener('click', () => {
          showToast(
            boom
              ? `Mines Boom (${item.minesCount || 3} mines · ${item.diamondsCount || 0} gems found)`
              : `Mines Cashout ${mult.toFixed(2)}x (${item.diamondsCount || 0}💎 / ${item.minesCount || 3}💣)`
          );
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'cyber-dice') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Dice Rolls';
      const items = (state.arcade.diceHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Cyber Dice rolls...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const won = Boolean(item.won);
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${won ? (mult >= 3 ? 'mult-high' : 'mult-med') : 'mult-low'}`;
        chip.textContent = Number(item.roll || 0).toFixed(2);
        chip.title = `${String(item.direction || 'under').toUpperCase()} ${item.target} · ${won ? `${mult.toFixed(2)}x` : 'Missed'}`;
        chip.addEventListener('click', () => {
          showToast(`Dice Roll ${Number(item.roll || 0).toFixed(2)} (${String(item.direction || 'under').toUpperCase()} ${item.target}) → ${won ? `${mult.toFixed(2)}x Win` : 'Loss'}`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'cyber-limbo') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Limbo Rolls';
      const items = (state.arcade.limboHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Limbo X launches...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const won = Boolean(item.won);
        const rolled = Number(item.rolled || 1);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${won ? (rolled >= 5 ? 'mult-high' : 'mult-med') : 'mult-low'}`;
        chip.textContent = `${rolled.toFixed(2)}x`;
        chip.title = `Target ${Number(item.targetMultiplier || 2).toFixed(2)}x`;
        chip.addEventListener('click', () => {
          showToast(`Limbo Rolled ${rolled.toFixed(2)}x vs Target ${Number(item.targetMultiplier || 2).toFixed(2)}x`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'neon-flip') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Coin Flips';
      const items = (state.arcade.coinflipHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Neon Coin Flips...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const won = Boolean(item.won);
        const side = String(item.outcome || 'heads').toUpperCase();
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${won ? 'mult-med' : 'mult-low'}`;
        chip.textContent = side === 'HEADS' ? 'H' : 'T';
        chip.title = `Picked ${String(item.pick || '').toUpperCase()} · Outcome ${side}`;
        chip.addEventListener('click', () => {
          showToast(`Coin Flip: ${side} (${won ? `Won ${Number(item.multiplier || 1.92).toFixed(2)}x` : 'Missed'})`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'lucky-wheel') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Wheel Spins';
      const items = (state.arcade.wheelHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Lucky Wheel spins...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${mult >= 3 ? 'mult-high' : mult >= 1 ? 'mult-med' : 'mult-low'}`;
        chip.textContent = `${mult}x`;
        chip.addEventListener('click', () => {
          showToast(`Lucky Wheel landed ${mult}x (${Number(item.amount || 0)} ${item.currencyMode === 'real' ? 'PKR' : 'FC'})`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'dragon-hilo') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Hi-Lo Draws';
      const items = (state.arcade.hiloHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Dragon Hi-Lo draws...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const won = Boolean(item.won);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${won ? 'mult-med' : 'mult-low'}`;
        chip.textContent = item.nextCard || '?';
        chip.addEventListener('click', () => {
          showToast(`Hi-Lo: Drew ${item.nextCard} on ${String(item.choice || '').toUpperCase()} (${won ? `${Number(item.multiplier || 0).toFixed(2)}x` : 'Missed'})`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'emerald-slots') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Slot Spins';
      const items = (state.arcade.slotsHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML =
          '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Emerald 777 Slot spins...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${mult >= 6 ? 'mult-high' : mult > 0 ? 'mult-med' : 'mult-low'}`;
        chip.textContent = mult > 0 ? `${mult}x` : '0x';
        chip.title = Array.isArray(item.reels) ? item.reels.join(' ') : '';
        chip.addEventListener('click', () => {
          showToast(`Slots [${Array.isArray(item.reels) ? item.reels.join(' | ') : ''}] → ${mult}x`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'crystal-keno') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Keno Draws';
      const items = (state.arcade.kenoHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Crystal Keno draws...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${mult >= 5 ? 'mult-high' : mult > 0 ? 'mult-med' : 'mult-low'}`;
        chip.textContent = mult > 0 ? `${mult}x` : '0x';
        chip.addEventListener('click', () => {
          showToast(`Keno: ${(item.hits || []).length}/${(item.picks || []).length} Hits → ${mult}x`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'tower-climb') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Tower Climbs';
      const items = (state.arcade.towerHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Sky Tower climbs...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const boom = Boolean(item.boom);
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${boom ? 'mult-low' : mult >= 3 ? 'mult-high' : 'mult-med'}`;
        chip.textContent = boom ? `F${Number(item.floorReached || 0) + 1}✕` : `${mult.toFixed(2)}x`;
        chip.addEventListener('click', () => {
          showToast(boom ? `Sky Tower Trap on Floor ${Number(item.floorReached || 0) + 1}` : `Sky Tower Reached Floor ${item.floorReached} (${mult.toFixed(2)}x)`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'dragon-tiger') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Dragon Tiger';
      const items = (state.arcade.dragonTigerHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Dragon Tiger deals...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const w = String(item.winner || 'dragon').toUpperCase();
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${item.won ? 'mult-med' : w === 'TIE' ? 'mult-high' : 'mult-low'}`;
        chip.textContent = w === 'DRAGON' ? 'D' : w === 'TIGER' ? 'T' : 'TIE';
        chip.addEventListener('click', () => {
          showToast(`Dragon ${item.dragonCard} vs Tiger ${item.tigerCard} → ${w}`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'neon-baccarat') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Baccarat';
      const items = (state.arcade.baccaratHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Neon Baccarat shoes...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const w = String(item.winner || 'player').toUpperCase();
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${item.won ? 'mult-med' : w === 'TIE' ? 'mult-high' : 'mult-low'}`;
        chip.textContent = w === 'PLAYER' ? `P${item.playerScore}` : w === 'BANKER' ? `B${item.bankerScore}` : `T${item.playerScore}`;
        chip.addEventListener('click', () => {
          showToast(`Baccarat: Player ${item.playerScore} vs Banker ${item.bankerScore} (${w})`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'triple-roulette') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Roulette';
      const items = (state.arcade.rouletteHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Royal Roulette spins...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${item.color === 'green' ? 'mult-high' : item.won ? 'mult-med' : 'mult-low'}`;
        chip.textContent = `${item.pocket}`;
        chip.addEventListener('click', () => {
          showToast(`Roulette #${item.pocket} (${String(item.color || '').toUpperCase()})`);
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    if (gid === 'lucky-scratch') {
      if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Scratch Cards';
      const items = (state.arcade.scratchHistory || []).slice(0, 15);
      if (!items.length) {
        el.historyList.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted);">Waiting for Golden Scratch cards...</span>';
        return;
      }
      el.historyList.innerHTML = '';
      items.forEach((item) => {
        const mult = Number(item.multiplier || 0);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `history-chip ${mult >= 6 ? 'mult-high' : mult > 0 ? 'mult-med' : 'mult-low'}`;
        chip.textContent = mult > 0 ? `${mult}x` : '0x';
        chip.addEventListener('click', () => {
          showToast(mult > 0 ? `Scratch Match (${item.matchSymbol}) → ${mult}x` : 'Golden Scratch — No Match');
        });
        el.historyList.appendChild(chip);
      });
      return;
    }

    // SkyWing Crash History
    if (el.historyLabel) el.historyLabel.textContent = 'Last 15 Flights';
    const items = (state.game.history || []).slice(0, 15);
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
    const gid = state.activeGameId || 'skywing-crash';

    if (state.sidebarTab === 'live') {
      el.sidebarTableHead.classList.remove('hidden');

      const arcadeFeedMap = {
        'cyber-plinko': {
          items: state.arcade.plinkoHistory || [],
          empty: 'No Cyber Plinko drops yet. Drop a ball!',
          label: 'Drops',
          multFmt: (x) => `${Number(x.multiplier || 0).toFixed(1)}x`,
        },
        'golden-mines': {
          items: state.arcade.minesHistory || [],
          empty: 'No Golden Mines games yet. Reveal diamonds!',
          label: 'Games',
          multFmt: (x) => (x.boom ? 'Boom' : `${Number(x.multiplier || 0).toFixed(2)}x`),
        },
        'cyber-dice': {
          items: state.arcade.diceHistory || [],
          empty: 'No Cyber Dice rolls yet. Roll the dice!',
          label: 'Rolls',
          multFmt: (x) => (x.won ? `${Number(x.multiplier || 0).toFixed(2)}x` : `Roll ${Number(x.roll || 0).toFixed(1)}`),
        },
        'cyber-limbo': {
          items: state.arcade.limboHistory || [],
          empty: 'No Limbo X launches yet. Launch now!',
          label: 'Launches',
          multFmt: (x) => `${Number(x.rolled || 1).toFixed(2)}x`,
        },
        'neon-flip': {
          items: state.arcade.coinflipHistory || [],
          empty: 'No Neon Coin Flips yet. Flip a coin!',
          label: 'Flips',
          multFmt: (x) => `${String(x.outcome || '').toUpperCase()}`,
        },
        'lucky-wheel': {
          items: state.arcade.wheelHistory || [],
          empty: 'No Lucky Wheel spins yet. Spin the wheel!',
          label: 'Spins',
          multFmt: (x) => `${Number(x.multiplier || 0)}x`,
        },
        'dragon-hilo': {
          items: state.arcade.hiloHistory || [],
          empty: 'No Dragon Hi-Lo deals yet. Deal a card!',
          label: 'Deals',
          multFmt: (x) => `${escapeHtml(x.nextCard || '?')}`,
        },
        'emerald-slots': {
          items: state.arcade.slotsHistory || [],
          empty: 'No Emerald 777 Slots spins yet. Spin now!',
          label: 'Spins',
          multFmt: (x) => (Array.isArray(x.reels) ? x.reels.join('') : `${Number(x.multiplier || 0)}x`),
        },
        'crystal-keno': {
          items: state.arcade.kenoHistory || [],
          empty: 'No Crystal Keno draws yet. Pick numbers!',
          label: 'Draws',
          multFmt: (x) => `${Number(x.multiplier || 0)}x (${(x.hits || []).length}H)`,
        },
        'tower-climb': {
          items: state.arcade.towerHistory || [],
          empty: 'No Sky Tower climbs yet. Start climbing!',
          label: 'Climbs',
          multFmt: (x) => (x.boom ? `Trap F${Number(x.floorReached || 0) + 1}` : `${Number(x.multiplier || 0).toFixed(2)}x`),
        },
        'dragon-tiger': {
          items: state.arcade.dragonTigerHistory || [],
          empty: 'No Dragon Tiger duels yet. Deal now!',
          label: 'Duels',
          multFmt: (x) => `${String(x.winner || 'D').toUpperCase()} (${escapeHtml(x.dragonCard || '')}/${escapeHtml(x.tigerCard || '')})`,
        },
        'neon-baccarat': {
          items: state.arcade.baccaratHistory || [],
          empty: 'No Neon Baccarat hands yet. Deal shoe!',
          label: 'Hands',
          multFmt: (x) => `P${x.playerScore ?? 0}:B${x.bankerScore ?? 0}`,
        },
        'triple-roulette': {
          items: state.arcade.rouletteHistory || [],
          empty: 'No Royal Roulette spins yet. Place bet!',
          label: 'Spins',
          multFmt: (x) => `#${x.pocket ?? 0} ${String(x.color || '').toUpperCase().slice(0, 1)}`,
        },
        'lucky-scratch': {
          items: state.arcade.scratchHistory || [],
          empty: 'No Golden Scratch cards yet. Buy a card!',
          label: 'Cards',
          multFmt: (x) => (Number(x.multiplier || 0) > 0 ? `${x.matchSymbol || ''} ${x.multiplier}x` : '0x'),
        },
      };

      if (arcadeFeedMap[gid]) {
        const meta = arcadeFeedMap[gid];
        const feed = meta.items.slice(0, 25);
        const totalWager = feed.reduce((s, x) => s + Number(x.amount || 0), 0);
        el.activeBetsCount.textContent = `${feed.length} Recent ${meta.label}`;
        el.totalRoundWager.textContent = `${totalWager.toFixed(0)} Vol`;
        if (!feed.length) {
          el.sidebarBetsList.innerHTML = `<div class="empty-state">${meta.empty}</div>`;
          return;
        }
        el.sidebarBetsList.innerHTML = feed
          .map((item) => {
            const u = item.currencyMode === 'real' ? 'PKR' : 'FC';
            const won = Number(item.payout || 0) > 0 && !item.boom;
            const winText = Number(item.payout || 0) > 0 ? `+${Number(item.payout).toFixed(2)}` : '0.00';
            return `
              <div class="bet-row ${won ? 'won' : ''}">
                <span class="bet-player">${escapeHtml(item.player || 'Player')}</span>
                <span class="tabular-nums">${Number(item.amount || 0).toFixed(0)} ${u}</span>
                <span class="bet-mult tabular-nums" style="font-size:0.74rem;">${meta.multFmt(item)}</span>
                <span class="bet-payout tabular-nums">${winText}</span>
              </div>
            `;
          })
          .join('');
        return;
      }

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
      const allHistory = state.user?.recentBets || [];
      const history = allHistory.filter((h) => (h.game || 'skywing-crash') === gid);
      el.activeBetsCount.textContent = `${history.length} Recent`;
      el.totalRoundWager.textContent = state.user
        ? fmtMoney(
            state.currencyMode === 'real' ? state.user.totalWonReal : state.user.totalWonFun,
            state.currencyMode
          )
        : 'Guest';

      if (!state.user) {
        el.sidebarBetsList.innerHTML =
          '<div class="empty-state">Log in to view your personal history.</div>';
        return;
      }
      if (!history.length) {
        const gName = GAME_LABELS[gid] || 'this game';
        el.sidebarBetsList.innerHTML = `<div class="empty-state">You have not played ${gName} yet.</div>`;
        return;
      }

      el.sidebarBetsList.innerHTML = history
        .map((h) => {
          const won = Number(h.payout || 0) > 0;
          const u = h.currencyMode === 'real' ? 'PKR' : 'FC';
          let multText = '';
          if (gid === 'cyber-plinko') {
            multText = `${Number(h.cashoutMultiplier || 0).toFixed(1)}x`;
          } else if (gid === 'golden-mines') {
            multText = won ? `${Number(h.cashoutMultiplier || 0).toFixed(2)}x` : 'Boom';
          } else if (gid === 'skywing-crash') {
            multText = h.cashoutMultiplier
              ? `${Number(h.cashoutMultiplier).toFixed(2)}x`
              : `Crash ${Number(h.crashedAt || 1).toFixed(2)}x`;
          } else {
            multText = won ? `${Number(h.cashoutMultiplier || 0).toFixed(2)}x` : (h.risk || '0x');
          }
          const payoutText = won
            ? `+${Number(h.payout).toFixed(2)}`
            : `-${Number(h.betAmount).toFixed(2)}`;
          return `
            <div class="bet-row ${won ? 'won' : ''}">
              <span class="bet-player">#${h.roundNumber || '-'}</span>
              <span class="tabular-nums">${Number(h.betAmount).toFixed(0)} ${u}</span>
              <span class="bet-mult tabular-nums" style="font-size:0.72rem;">${escapeHtml(multText)}</span>
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
    if (!state.user || state.activeGameId !== 'skywing-crash') return;
    const parent = el.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
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
  let crashRafId = null;

  function startCrashRenderLoop() {
    if (!state.user || state.activeGameId !== 'skywing-crash') return;
    if (!crashRafId) {
      crashRafId = requestAnimationFrame(renderCanvas);
    }
  }

  function stopCrashRenderLoop() {
    if (crashRafId) {
      cancelAnimationFrame(crashRafId);
      crashRafId = null;
    }
    audio.stopTension();
  }

  function renderCanvas(nowMs) {
    if (!state.user || state.activeGameId !== 'skywing-crash') {
      crashRafId = null;
      return;
    }
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
    if (state.game.phase === 'FLYING') {
      const syncDeltaMs = Math.min(50, Math.max(0, performance.now() - state.game.lastSyncPerfMs));
      elapsedSec = Math.max(0, (Number(state.game.elapsedMs || 0) + syncDeltaMs) / 1000);
      el.liveMultiplierText.textContent = `${Number(state.game.currentMultiplier || 1).toFixed(2)}x`;
      audio.updateTension(state.game.currentMultiplier);
      audio.playWingFlap();
    } else if (state.game.phase === 'BETTING') {
      const remMs = Math.max(0, Number(state.game.countdownRemainingMs ?? 0));
      const totalMs = Math.max(1000, Number(state.game.bettingDurationMs || 5000));
      const remSec = (remMs / 1000).toFixed(1);
      el.countdownTimerText.textContent = `${remSec}s`;
      const pct = Math.max(0, Math.min(100, (remMs / totalMs) * 100));
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
    crashRafId = requestAnimationFrame(renderCanvas);
  }

  // ==========================================================================
  // Socket.io Real-Time Client Sync
  // ==========================================================================
  const socket = io({
    transports: ['websocket', 'polling'],
    auth: { token: state.token },
  });

  function syncPhaseOverlays() {
    const phase = state.game.phase;
    const roundId = state.game.currentRoundId || state.game.roundNumber || 0;
    el.hudRoundNumber.textContent = `Round #${roundId}`;
    el.hudSeedShort.textContent = `SHA-256: ${(state.game.serverSeedHash || '').slice(0, 10)}...`;

    if (phase === 'BETTING') {
      const remMs = Math.max(0, Number(state.game.countdownRemainingMs ?? 0));
      const totalMs = Math.max(1000, Number(state.game.bettingDurationMs || 5000));
      el.countdownTimerText.textContent = `${(remMs / 1000).toFixed(1)}s`;
      el.countdownBarFill.style.width = `${Math.max(0, Math.min(100, (remMs / totalMs) * 100))}%`;
      el.bettingOverlay.classList.remove('hidden');
      el.flyingOverlay.classList.add('hidden');
      el.crashBannerText.classList.add('hidden');
      el.liveMultiplierText.classList.remove('crashed');
    } else if (phase === 'FLYING') {
      el.liveMultiplierText.textContent = `${Number(state.game.currentMultiplier || 1).toFixed(2)}x`;
      el.bettingOverlay.classList.add('hidden');
      el.flyingOverlay.classList.remove('hidden');
      el.crashBannerText.classList.add('hidden');
      el.liveMultiplierText.classList.remove('crashed');
    } else {
      el.bettingOverlay.classList.add('hidden');
      el.flyingOverlay.classList.remove('hidden');
      el.crashBannerText.classList.remove('hidden');
      el.liveMultiplierText.classList.add('crashed');
      el.liveMultiplierText.textContent = `${Number(state.game.crashPoint || state.game.currentMultiplier || 1).toFixed(2)}x`;
    }
  }

  function applyServerRoundSnapshot(data, isFullInit = false) {
    if (!data) return false;
    const incomingRoundId = Number(data.currentRoundId ?? data.roundNumber ?? 0);
    const incomingTs = Number(data.serverTickTimestamp ?? data.serverTimestamp ?? 0);

    // Ignore stale/out-of-order packets from previous rounds or earlier ticks
    if (!isFullInit && incomingRoundId > 0 && state.game.currentRoundId > 0) {
      if (incomingRoundId < state.game.currentRoundId) return false;
      if (
        incomingRoundId === state.game.currentRoundId &&
        incomingTs > 0 &&
        state.game.serverTickTimestamp > 0 &&
        incomingTs < state.game.serverTickTimestamp
      ) {
        return false;
      }
    }

    const nextFlightState = String(
      data.flightState || data.phase || state.game.flightState || 'betting'
    ).toLowerCase();
    const nextPhase = String(data.phase || nextFlightState.toUpperCase()).toUpperCase();

    state.game.phase = nextPhase;
    state.game.flightState = nextFlightState;
    if (incomingRoundId > 0) {
      state.game.currentRoundId = incomingRoundId;
      state.game.roundNumber = incomingRoundId;
    }
    if (incomingTs > 0) {
      state.game.serverTimestamp = incomingTs;
      state.game.serverTickTimestamp = incomingTs;
    }
    state.game.lastSyncPerfMs = performance.now();

    if (data.bettingDurationMs !== undefined) state.game.bettingDurationMs = Number(data.bettingDurationMs);
    if (data.countdownRemainingMs !== undefined) state.game.countdownRemainingMs = Number(data.countdownRemainingMs);
    if (data.elapsedMs !== undefined) state.game.elapsedMs = Number(data.elapsedMs);
    if (data.bettingEndsAt !== undefined) state.game.bettingEndsAt = Number(data.bettingEndsAt);
    if (data.flightStartedAt !== undefined) state.game.flightStartedAt = Number(data.flightStartedAt);
    if (data.serverSeedHash) state.game.serverSeedHash = data.serverSeedHash;
    if (data.clientSeed !== undefined) state.game.clientSeed = data.clientSeed;
    if (data.nonce !== undefined) state.game.nonce = data.nonce;

    if (nextPhase === 'BETTING') {
      state.game.serverSeed = '';
      state.game.currentMultiplier = 1.0;
      state.game.crashPoint = 1.0;
    } else if (nextPhase === 'FLYING') {
      const m = Number(data.multiplier ?? data.currentMultiplier ?? 1.0);
      state.game.currentMultiplier = m;
    } else if (nextPhase === 'CRASHED') {
      const cp = Number(data.crashPoint ?? data.multiplier ?? data.currentMultiplier ?? 1.0);
      state.game.crashPoint = cp;
      state.game.currentMultiplier = cp;
      if (data.serverSeed) state.game.serverSeed = data.serverSeed;
    }

    if (Array.isArray(data.bets)) state.game.bets = data.bets;
    if (Array.isArray(data.history)) state.game.history = data.history;
    if (Array.isArray(data.plinkoHistory)) state.arcade.plinkoHistory = data.plinkoHistory;
    if (Array.isArray(data.minesHistory)) state.arcade.minesHistory = data.minesHistory;
    if (Array.isArray(data.diceHistory)) state.arcade.diceHistory = data.diceHistory;
    if (Array.isArray(data.limboHistory)) state.arcade.limboHistory = data.limboHistory;
    if (Array.isArray(data.coinflipHistory)) state.arcade.coinflipHistory = data.coinflipHistory;
    if (Array.isArray(data.wheelHistory)) state.arcade.wheelHistory = data.wheelHistory;
    if (Array.isArray(data.hiloHistory)) state.arcade.hiloHistory = data.hiloHistory;
    if (Array.isArray(data.slotsHistory)) state.arcade.slotsHistory = data.slotsHistory;
    if (Array.isArray(data.kenoHistory)) state.arcade.kenoHistory = data.kenoHistory;
    if (Array.isArray(data.towerHistory)) state.arcade.towerHistory = data.towerHistory;
    if (Array.isArray(data.dragonTigerHistory)) state.arcade.dragonTigerHistory = data.dragonTigerHistory;
    if (Array.isArray(data.baccaratHistory)) state.arcade.baccaratHistory = data.baccaratHistory;
    if (Array.isArray(data.rouletteHistory)) state.arcade.rouletteHistory = data.rouletteHistory;
    if (Array.isArray(data.scratchHistory)) state.arcade.scratchHistory = data.scratchHistory;
    if (data.onlineCount !== undefined && el.onlineCount) {
      el.onlineCount.textContent = `${data.onlineCount} Online`;
    }
    return true;
  }

  let hasConnectedOnce = false;
  socket.on('connect', () => {
    if (state.token) {
      socket.emit('auth:identify', { token: state.token });
    }
    if (hasConnectedOnce) {
      socket.emit('game:sync');
      if (state.token) fetchCurrentUser();
    }
    hasConnectedOnce = true;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket.connected) {
      socket.emit('game:sync');
    }
  });

  socket.on('game:init', (data) => {
    applyServerRoundSnapshot(data, true);

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
    applyPublicSettingsPayload(data);
  });

  socket.on('platform:status', (ps) => {
    state.publicSettings.platformStatus = ps;
    syncPlatformStatusUI();
  });

  socket.on('referral:bonus', ({ amount, fromUser }) => {
    showToast(`Referral Bonus +${Number(amount).toLocaleString()} PKR from ${fromUser}!`);
    fetchCurrentUser();
  });

  socket.on('support:ticket_updated', (ticket) => {
    const idx = state.supportTickets.findIndex((t) => String(t._id || t.id) === String(ticket._id || ticket.id));
    if (idx >= 0) {
      state.supportTickets[idx] = ticket;
    } else {
      state.supportTickets.unshift(ticket);
    }
    if (document.getElementById('supportModal')?.classList.contains('open')) {
      renderUserSupportTickets();
    } else {
      showToast(`Support Ticket Reply: ${ticket.subject}`);
    }
  });

  socket.on('balance:update', ({ funBalance, realBalance, funCredits }) => {
    if (state.user) {
      if (funBalance !== undefined) state.user.funBalance = funBalance;
      else if (funCredits !== undefined) state.user.funBalance = funCredits;
      if (realBalance !== undefined) state.user.realBalance = realBalance;
      saveSessionVault(state.token, state.user);
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
    state.user = null;
    updateUserUI();
  });

  socket.on('round:betting', (data) => {
    audio.stopTension();
    state.game.bets = [];
    applyServerRoundSnapshot({ ...data, phase: 'BETTING', flightState: 'betting' }, true);

    [1, 2].forEach((slot) => {
      state.panels[slot].placedBet = null;
    });

    syncPhaseOverlays();
    if (state.activeGameId === 'skywing-crash') {
      renderHistory();
      renderSidebar();
    }
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
    applyServerRoundSnapshot({ ...data, phase: 'FLYING', flightState: 'flying' }, false);
    if (state.user && state.activeGameId === 'skywing-crash') {
      syncPhaseOverlays();
      audio.startTension();
      updatePanelButtons();
    }
  });

  socket.on('round:tick', (data) => {
    if (!applyServerRoundSnapshot(data, false)) return;
    if (!state.user || state.activeGameId !== 'skywing-crash') return;
    if (state.game.phase === 'FLYING') {
      el.liveMultiplierText.textContent = `${Number(state.game.currentMultiplier || 1).toFixed(2)}x`;
      updatePanelButtons();
    } else if (state.game.phase === 'BETTING') {
      const remMs = Math.max(0, Number(state.game.countdownRemainingMs ?? 0));
      const totalMs = Math.max(1000, Number(state.game.bettingDurationMs || 5000));
      el.countdownTimerText.textContent = `${(remMs / 1000).toFixed(1)}s`;
      el.countdownBarFill.style.width = `${Math.max(0, Math.min(100, (remMs / totalMs) * 100))}%`;
    }
  });

  socket.on('game:state', (data) => {
    const prevPhase = state.game.phase;
    const prevRound = state.game.currentRoundId;
    if (!applyServerRoundSnapshot(data, false)) return;
    if (!state.user || state.activeGameId !== 'skywing-crash') return;

    if (prevPhase !== state.game.phase || prevRound !== state.game.currentRoundId) {
      syncPhaseOverlays();
      updatePanelButtons();
    } else if (state.game.phase === 'FLYING') {
      el.liveMultiplierText.textContent = `${Number(state.game.currentMultiplier || 1).toFixed(2)}x`;
      updatePanelButtons();
    } else if (state.game.phase === 'BETTING') {
      const remMs = Math.max(0, Number(state.game.countdownRemainingMs ?? 0));
      const totalMs = Math.max(1000, Number(state.game.bettingDurationMs || 5000));
      el.countdownTimerText.textContent = `${(remMs / 1000).toFixed(1)}s`;
      el.countdownBarFill.style.width = `${Math.max(0, Math.min(100, (remMs / totalMs) * 100))}%`;
    }
  });

  socket.on('round:crashed', (data) => {
    const alreadyCrashedThisRound =
      state.game.phase === 'CRASHED' &&
      Number(data.currentRoundId ?? data.roundNumber) === Number(state.game.currentRoundId);
    applyServerRoundSnapshot({ ...data, phase: 'CRASHED', flightState: 'crashed' }, false);

    if (state.user && state.activeGameId === 'skywing-crash') {
      if (!alreadyCrashedThisRound) {
        audio.playCrash();
        spawnCrashBurst(lastKnownBirdPos.x, lastKnownBirdPos.y);
      }
      syncPhaseOverlays();
      renderHistory();
      renderSidebar();
      updatePanelButtons();
    }

    if (state.user) fetchCurrentUser();
  });

  socket.on('bet:placed', (bet) => {
    if (!state.game.bets.some((b) => b.id === bet.id)) {
      state.game.bets.push(bet);
      if (state.activeGameId === 'skywing-crash') renderSidebar();
    }
  });

  socket.on('bet:cancelled', ({ betId }) => {
    state.game.bets = state.game.bets.filter((b) => b.id !== betId);
    if (state.activeGameId === 'skywing-crash') renderSidebar();
  });

  socket.on('bet:cashedOut', (data) => {
    const bet = state.game.bets.find((b) => b.id === data.betId);
    if (bet) {
      bet.cashedOut = true;
      bet.cashoutMultiplier = data.cashoutMultiplier;
      bet.payout = data.payout;
      if (state.activeGameId === 'skywing-crash') renderSidebar();
    }
    if (state.user && String(data.userId) === String(state.user.id)) {
      const slot = data.slot === 2 ? 2 : 1;
      if (state.panels[slot].placedBet && !state.panels[slot].placedBet.cashedOut) {
        state.panels[slot].placedBet.cashedOut = true;
        if (state.activeGameId === 'skywing-crash') audio.playCashout();
        showToast(
          `Auto Cashout ${data.cashoutMultiplier.toFixed(2)}x (+${fmtMoney(data.payout, data.currencyMode)})`
        );
      }
      updatePanelButtons();
    }
  });

  socket.on('arcade:plinko_drop', (item) => {
    if (!item) return;
    if (!state.arcade.plinkoHistory.some((x) => x.id === item.id)) {
      state.arcade.plinkoHistory.unshift(item);
      state.arcade.plinkoHistory = state.arcade.plinkoHistory.slice(0, 25);
      if (state.activeGameId === 'cyber-plinko') {
        renderHistory();
        if (state.sidebarTab === 'live') renderSidebar();
      }
    }
  });

  socket.on('arcade:mines_result', (item) => {
    if (!item) return;
    if (!state.arcade.minesHistory.some((x) => x.id === item.id)) {
      state.arcade.minesHistory.unshift(item);
      state.arcade.minesHistory = state.arcade.minesHistory.slice(0, 25);
      if (state.activeGameId === 'golden-mines') {
        renderHistory();
        if (state.sidebarTab === 'live') renderSidebar();
      }
    }
  });

  function pushArcadeSocketFeed(historyKey, gameId, item) {
    if (!item || !state.arcade[historyKey]) return;
    if (!state.arcade[historyKey].some((x) => x.id === item.id)) {
      state.arcade[historyKey].unshift(item);
      state.arcade[historyKey] = state.arcade[historyKey].slice(0, 25);
      if (state.activeGameId === gameId) {
        renderHistory();
        if (state.sidebarTab === 'live') renderSidebar();
      }
    }
  }

  socket.on('arcade:dice_roll', (item) => pushArcadeSocketFeed('diceHistory', 'cyber-dice', item));
  socket.on('arcade:limbo_play', (item) => pushArcadeSocketFeed('limboHistory', 'cyber-limbo', item));
  socket.on('arcade:coinflip_play', (item) => pushArcadeSocketFeed('coinflipHistory', 'neon-flip', item));
  socket.on('arcade:wheel_spin', (item) => pushArcadeSocketFeed('wheelHistory', 'lucky-wheel', item));
  socket.on('arcade:hilo_play', (item) => pushArcadeSocketFeed('hiloHistory', 'dragon-hilo', item));
  socket.on('arcade:slots_spin', (item) => pushArcadeSocketFeed('slotsHistory', 'emerald-slots', item));
  socket.on('arcade:keno_play', (item) => pushArcadeSocketFeed('kenoHistory', 'crystal-keno', item));
  socket.on('arcade:tower_play', (item) => pushArcadeSocketFeed('towerHistory', 'tower-climb', item));
  socket.on('arcade:dragontiger_play', (item) => pushArcadeSocketFeed('dragonTigerHistory', 'dragon-tiger', item));
  socket.on('arcade:baccarat_play', (item) => pushArcadeSocketFeed('baccaratHistory', 'neon-baccarat', item));
  socket.on('arcade:roulette_spin', (item) => pushArcadeSocketFeed('rouletteHistory', 'triple-roulette', item));
  socket.on('arcade:scratch_play', (item) => pushArcadeSocketFeed('scratchHistory', 'lucky-scratch', item));

  // Periodic 60s activity heartbeat to preserve 72h rolling inactivity window while open
  setInterval(() => {
    if (state.token && state.user) {
      updateLastActive();
      if (socket.connected) socket.emit('auth:heartbeat', { token: state.token });
    }
  }, 60000);

  // ==========================================================================
  // Cyber Plinko Arcade Renderer & Controller
  // ==========================================================================
  function renderPlinkoBuckets(highlightSlot = -1) {
    if (!el.plinkoBucketsRow) return;
    const tbl = PLINKO_TABLES[state.plinkoRisk] || PLINKO_TABLES.medium;
    el.plinkoBucketsRow.innerHTML = tbl
      .map(
        (m, idx) =>
          `<div class="plinko-bucket ${idx === highlightSlot ? 'hit' : ''}">${m}x</div>`
      )
      .join('');
  }

  function renderPlinkoBoard(ballPos = null) {
    if (!el.plinkoCanvas) return;
    const pCtx = el.plinkoCanvas.getContext('2d');
    const w = el.plinkoCanvas.width;
    const h = el.plinkoCanvas.height;
    pCtx.clearRect(0, 0, w, h);

    const rows = 8;
    const topY = 26;
    const rowGap = (h - 56) / rows;
    const pegSpacing = 36;

    for (let r = 0; r < rows; r++) {
      const count = r + 3;
      const startX = w / 2 - ((count - 1) * pegSpacing) / 2;
      const y = topY + r * rowGap;
      for (let c = 0; c < count; c++) {
        const x = startX + c * pegSpacing;
        pCtx.fillStyle = '#7dd3fc';
        pCtx.beginPath();
        pCtx.arc(x, y, 4, 0, Math.PI * 2);
        pCtx.fill();
      }
    }

    if (ballPos) {
      pCtx.fillStyle = '#fbbf24';
      pCtx.shadowColor = '#fbbf24';
      pCtx.shadowBlur = 14;
      pCtx.beginPath();
      pCtx.arc(ballPos.x, ballPos.y, 7.5, 0, Math.PI * 2);
      pCtx.fill();
      pCtx.shadowBlur = 0;
    }
    renderPlinkoBuckets(ballPos?.hitSlot ?? -1);
  }

  document.querySelectorAll('.plinko-risk-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.plinkoRisk = btn.dataset.risk || 'medium';
      document.querySelectorAll('.plinko-risk-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderPlinkoBoard();
    });
  });

  document.querySelectorAll('.plinko-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.plinkoAmount) el.plinkoAmount.value = btn.dataset.amt;
    });
  });

  el.plinkoDropBtn?.addEventListener('click', async () => {
    if (!state.user) {
      openModal('authModal');
      return;
    }
    if (state.plinkoBusy) return;
    const amount = Number(el.plinkoAmount?.value || 0);
    state.plinkoBusy = true;
    el.plinkoDropBtn.disabled = true;

    try {
      const res = await fetch('/api/games/plinko/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          currencyMode: state.currencyMode,
          risk: state.plinkoRisk,
          amount,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Plinko drop failed.', true);
        state.plinkoBusy = false;
        el.plinkoDropBtn.disabled = false;
        return;
      }

      audio.ensureContext();
      audio.playClick();

      // Animate ball path smoothly across 8 peg rows
      const rows = 8;
      const w = el.plinkoCanvas.width;
      const h = el.plinkoCanvas.height;
      const topY = 26;
      const rowGap = (h - 56) / rows;
      const pegSpacing = 36;
      let stepIdx = 0;
      let colOffset = 0;

      const animStep = () => {
        if (stepIdx >= data.path.length) {
          const finalX = w / 2 + (data.slot - 4) * pegSpacing * 0.95;
          renderPlinkoBoard({ x: finalX, y: h - 14, hitSlot: data.slot });
          if (Array.isArray(data.plinkoHistory)) {
            state.arcade.plinkoHistory = data.plinkoHistory;
          } else if (data.plinkoFeedItem && !state.arcade.plinkoHistory.some((x) => x.id === data.plinkoFeedItem.id)) {
            state.arcade.plinkoHistory.unshift(data.plinkoFeedItem);
            state.arcade.plinkoHistory = state.arcade.plinkoHistory.slice(0, 25);
          }
          if (data.user) {
            state.user = data.user;
            updateUserUI();
          }
          renderHistory();
          renderSidebar();
          el.plinkoLastResultPill.textContent = `${data.multiplier}x (${data.profit >= 0 ? '+' : ''}${data.profit} ${unitLabel(data.currencyMode)})`;
          audio.playPlinkoBucket(Number(data.multiplier || 0));
          showToast(`Plinko landed ${data.multiplier}x → Payout ${fmtMoney(data.payout, data.currencyMode)}`);
          state.plinkoBusy = false;
          el.plinkoDropBtn.disabled = false;
          return;
        }
        colOffset += data.path[stepIdx] === 1 ? 0.5 : -0.5;
        const bx = w / 2 + colOffset * pegSpacing;
        const by = topY + stepIdx * rowGap + 12;
          renderPlinkoBoard({ x: bx, y: by });
          audio.playPlinkoBounce();
          stepIdx += 1;
          setTimeout(animStep, 85);
        };
        animStep();
      } catch {
        showToast('Network error in Plinko.', true);
        state.plinkoBusy = false;
        el.plinkoDropBtn.disabled = false;
      }
    });

  // ==========================================================================
  // Golden Mines 5x5 Grid Controller
  // ==========================================================================
  document.querySelectorAll('.mines-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.minesAmount && !state.mines.active) {
        el.minesAmount.value = btn.dataset.amt;
      }
    });
  });

  function renderMinesGrid() {
    if (!el.minesGrid) return;
    let html = '';
    for (let i = 0; i < 25; i++) {
      const isGem = state.mines.revealed.includes(i);
      const isMine = state.mines.minesShown.includes(i);
      const cls = isGem ? 'revealed-gem' : isMine ? 'revealed-mine' : '';
      const icon = isGem ? '💎' : isMine ? '💣' : state.mines.active ? '?' : '·';
      const disabled = !state.mines.active || isGem || isMine ? 'disabled' : '';
      html += `<button type="button" class="mine-tile ${cls}" data-tile="${i}" ${disabled}>${icon}</button>`;
    }
    el.minesGrid.innerHTML = html;

    el.minesGrid.querySelectorAll('.mine-tile[data-tile]').forEach((btn) => {
      btn.addEventListener('click', () => revealMineTile(Number(btn.dataset.tile)));
    });

    if (el.minesMultPill) el.minesMultPill.textContent = `${Number(state.mines.multiplier || 1).toFixed(2)}x`;
    if (el.minesNextMult) el.minesNextMult.textContent = `${Number(state.mines.nextMultiplier || 1).toFixed(2)}x`;
    if (el.minesCurrentPayout) {
      el.minesCurrentPayout.textContent = fmtMoney(state.mines.potentialPayout || 0, state.currencyMode);
    }
    if (el.minesStartBtn) el.minesStartBtn.classList.toggle('hidden', state.mines.active);
    if (el.minesCashoutBtn) {
      el.minesCashoutBtn.classList.toggle('hidden', !state.mines.active || state.mines.revealed.length === 0);
      el.minesCashoutBtn.textContent = `CASH OUT (${fmtMoney(state.mines.potentialPayout || 0, state.currencyMode)})`;
    }
  }

  el.minesStartBtn?.addEventListener('click', async () => {
    if (!state.user) {
      openAuthModal(urlRefCode ? 'register' : 'login');
      return;
    }
    const amount = Number(el.minesAmount?.value || 0);
    const minesCount = Number(el.minesCountSelect?.value || 3);
    try {
      const res = await fetch('/api/games/mines/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount, minesCount }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not start Mines.', true);
        return;
      }
      audio.ensureContext();
      audio.playMinesTile();
      state.mines = {
        active: true,
        revealed: [],
        minesCount,
        betAmount: amount,
        multiplier: 1.0,
        nextMultiplier: data.nextMultiplier,
        potentialPayout: amount,
        minesShown: [],
      };
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      el.minesHintText.textContent = 'Click tiles to reveal diamonds. Cash out anytime!';
      renderMinesGrid();
    } catch {
      showToast('Failed to start Golden Mines.', true);
    }
  });

  async function revealMineTile(index) {
    if (!state.mines.active) return;
    try {
      const res = await fetch('/api/games/mines/reveal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ index }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Tile reveal error.', true);
        return;
      }
      if (data.boom) {
        if (audio.ctx && !audio.muted && !audio.locked && audio.activeGame === 'golden-mines') {
          audio.playTone(135, 'sawtooth', audio.ctx.currentTime, 0.28, 0.14, 340);
        }
        state.mines.active = false;
        state.mines.minesShown = data.mines || [];
        state.mines.multiplier = 0;
        state.mines.potentialPayout = 0;
        if (Array.isArray(data.minesHistory)) {
          state.arcade.minesHistory = data.minesHistory;
        } else if (data.minesFeedItem && !state.arcade.minesHistory.some((x) => x.id === data.minesFeedItem.id)) {
          state.arcade.minesHistory.unshift(data.minesFeedItem);
          state.arcade.minesHistory = state.arcade.minesHistory.slice(0, 25);
        }
        if (data.user) {
          state.user = data.user;
          updateUserUI();
        }
        renderHistory();
        renderSidebar();
        el.minesHintText.textContent = 'BOOM! You hit a hidden mine.';
        showToast('Hit a mine! Better luck next round.', true);
      } else if (data.clearedAll) {
        audio.playMinesDiamond();
        audio.playArcadeWin('golden-mines');
        state.mines.active = false;
        state.mines.revealed = data.revealed || [];
        state.mines.minesShown = data.mines || [];
        state.mines.multiplier = data.multiplier;
        state.mines.potentialPayout = data.payout;
        if (Array.isArray(data.minesHistory)) {
          state.arcade.minesHistory = data.minesHistory;
        } else if (data.minesFeedItem && !state.arcade.minesHistory.some((x) => x.id === data.minesFeedItem.id)) {
          state.arcade.minesHistory.unshift(data.minesFeedItem);
          state.arcade.minesHistory = state.arcade.minesHistory.slice(0, 25);
        }
        if (data.user) {
          state.user = data.user;
          updateUserUI();
        }
        renderHistory();
        renderSidebar();
        el.minesHintText.textContent = `Board cleared! Won ${fmtMoney(data.payout, state.currencyMode)}`;
        showToast(`Board Cleared! +${fmtMoney(data.payout, state.currencyMode)}`);
      } else {
        audio.playMinesTile();
        audio.playMinesDiamond();
        state.mines.revealed = data.revealed || [];
        state.mines.multiplier = data.multiplier;
        state.mines.nextMultiplier = data.nextMultiplier;
        state.mines.potentialPayout = data.potentialPayout;
        el.minesHintText.textContent = `${state.mines.revealed.length} diamond(s) found! Cash out or keep going.`;
      }
      renderMinesGrid();
    } catch {
      showToast('Network error revealing tile.', true);
    }
  }

  el.minesCashoutBtn?.addEventListener('click', async () => {
    if (!state.mines.active) return;
    try {
      const res = await fetch('/api/games/mines/cashout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Cashout failed.', true);
        return;
      }
      audio.playArcadeWin('golden-mines');
      state.mines.active = false;
      state.mines.minesShown = data.mines || [];
      state.mines.multiplier = data.multiplier;
      state.mines.potentialPayout = data.payout;
      if (Array.isArray(data.minesHistory)) {
        state.arcade.minesHistory = data.minesHistory;
      } else if (data.minesFeedItem && !state.arcade.minesHistory.some((x) => x.id === data.minesFeedItem.id)) {
        state.arcade.minesHistory.unshift(data.minesFeedItem);
        state.arcade.minesHistory = state.arcade.minesHistory.slice(0, 25);
      }
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      renderHistory();
      renderSidebar();
      el.minesHintText.textContent = `Cashed out at ${data.multiplier}x (+${fmtMoney(data.payout, data.currencyMode)})`;
      showToast(`Mines Cashout ${data.multiplier}x (+${fmtMoney(data.payout, data.currencyMode)})`);
      renderMinesGrid();
    } catch {
      showToast('Cashout error.', true);
    }
  });

  // ==========================================================================
  // 4) Cyber Dice Controller
  // ==========================================================================
  function updateDiceMetrics() {
    const target = Math.min(98, Math.max(2, Math.round(Number(el.diceTargetSlider?.value || state.diceTarget || 50))));
    state.diceTarget = target;
    const dir = state.diceDirection === 'over' ? 'over' : 'under';
    const winChance = dir === 'over' ? 100 - target : target;
    const cfg = getGameConfig('cyber-dice');
    const edgePct = Math.min(25, Math.max(0, Number(cfg?.houseEdgePct ?? 4)));
    const mult = Math.max(1.01, Math.floor(((100 - edgePct) / winChance) * 100) / 100);
    const amt = Math.max(0, Number(el.diceAmount?.value || 0));
    const estPayout = Math.round(amt * mult * 100) / 100;

    if (el.diceTargetLabel) el.diceTargetLabel.textContent = String(target);
    if (el.diceWinChanceVal) el.diceWinChanceVal.textContent = `${winChance.toFixed(2)}%`;
    if (el.diceMultVal) el.diceMultVal.textContent = `${mult.toFixed(2)}x`;
    if (el.diceEstPayoutVal) el.diceEstPayoutVal.textContent = fmtMoney(estPayout, state.currencyMode);
    if (el.diceRuleHint) {
      el.diceRuleHint.textContent = dir === 'over' ? `Roll above ${target}.00 to win.` : `Roll below ${target}.00 to win.`;
    }
    if (el.diceWinZone) {
      el.diceWinZone.style.left = dir === 'over' ? `${target}%` : '0%';
      el.diceWinZone.style.width = `${winChance}%`;
    }
  }

  document.querySelectorAll('.dice-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.diceAmount) {
        el.diceAmount.value = btn.dataset.amt;
        updateDiceMetrics();
      }
    });
  });

  document.querySelectorAll('.dice-dir-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.diceDirection = btn.dataset.dir === 'over' ? 'over' : 'under';
      document.querySelectorAll('.dice-dir-btn').forEach((b) => b.classList.toggle('active', b === btn));
      updateDiceMetrics();
    });
  });

  el.diceTargetSlider?.addEventListener('input', updateDiceMetrics);
  el.diceAmount?.addEventListener('input', updateDiceMetrics);

  el.diceRollBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.diceBusy) return;
    const amount = Number(el.diceAmount?.value || 0);
    state.diceBusy = true;
    el.diceRollBtn.disabled = true;
    if (el.diceStatusPill) el.diceStatusPill.textContent = 'Rolling...';
    audio.ensureContext();
    audio.playDiceRoll();

    try {
      const res = await fetch('/api/games/dice/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          currencyMode: state.currencyMode,
          direction: state.diceDirection,
          target: state.diceTarget,
          amount,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Dice roll failed.', true);
        if (el.diceStatusPill) el.diceStatusPill.textContent = 'Ready';
        return;
      }

      const rollStr = Number(data.roll).toFixed(2).padStart(5, '0');
      const [intPart, decPart] = rollStr.split('.');
      if (el.diceDieA) el.diceDieA.textContent = intPart || '00';
      if (el.diceDieB) el.diceDieB.textContent = decPart || '00';
      if (el.diceRollValText) {
        el.diceRollValText.textContent = Number(data.roll).toFixed(2);
        el.diceRollValText.style.color = data.won ? '#34d399' : '#f87171';
      }
      if (el.diceRollMarker) {
        el.diceRollMarker.style.left = `${Math.min(100, Math.max(0, Number(data.roll)))}%`;
      }
      if (el.diceResultSub) {
        el.diceResultSub.textContent = data.won
          ? `WON ${data.multiplier.toFixed(2)}x (+${fmtMoney(data.payout, data.currencyMode)})`
          : `Rolled ${Number(data.roll).toFixed(2)} — Missed target ${data.target}`;
      }
      if (el.diceStatusPill) {
        el.diceStatusPill.textContent = data.won ? `WIN +${data.multiplier.toFixed(2)}x` : 'Missed';
      }
      if (data.won) audio.playDiceWin();
      if (Array.isArray(data.diceHistory)) state.arcade.diceHistory = data.diceHistory;
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      renderHistory();
      renderSidebar();
    } catch {
      showToast('Network error rolling dice.', true);
    } finally {
      state.diceBusy = false;
      el.diceRollBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 5) Limbo X Controller (Pro Telemetry Gauge & Animated Altitude Counter)
  // ==========================================================================
  function calcLogAltitudePct(multVal) {
    const safe = Math.max(1, Math.min(100, Number(multVal || 1)));
    return Math.min(98, Math.max(5, (Math.log10(safe) / 2) * 95 + 4));
  }

  function updateLimboMetrics() {
    const targetMult = Math.min(100, Math.max(1.05, Number(el.limboTargetInput?.value || 2)));
    const amt = Math.max(0, Number(el.limboAmount?.value || 0));
    const cfg = getGameConfig('cyber-limbo');
    const edgePct = Math.min(25, Math.max(0, Number(cfg?.houseEdgePct ?? 4)));
    const chance = Math.min(98, Math.max(0.5, ((100 - edgePct) / targetMult)));
    const estPayout = Math.round(amt * targetMult * 100) / 100;

    if (el.limboTargetBadge) el.limboTargetBadge.textContent = `${targetMult.toFixed(2)}x`;
    if (el.limboChanceVal) el.limboChanceVal.textContent = `${chance.toFixed(2)}%`;
    if (el.limboEstPayoutVal) el.limboEstPayoutVal.textContent = fmtMoney(estPayout, state.currencyMode);
    if (el.limboTargetMarker) {
      el.limboTargetMarker.style.bottom = `${calcLogAltitudePct(targetMult)}%`;
    }
  }

  document.querySelectorAll('.limbo-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.limboAmount) {
        el.limboAmount.value = btn.dataset.amt;
        updateLimboMetrics();
      }
    });
  });

  document.querySelectorAll('.limbo-target-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.limboTargetInput) {
        el.limboTargetInput.value = btn.dataset.target;
        updateLimboMetrics();
      }
    });
  });

  el.limboAmount?.addEventListener('input', updateLimboMetrics);
  el.limboTargetInput?.addEventListener('input', updateLimboMetrics);

  el.limboPlayBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.limboBusy) return;
    const amount = Number(el.limboAmount?.value || 0);
    const targetMultiplier = Number(el.limboTargetInput?.value || 2);
    state.limboBusy = true;
    el.limboPlayBtn.disabled = true;
    if (el.limboStatusBadge) el.limboStatusBadge.textContent = 'Launching...';
    if (el.limboResultValue) el.limboResultValue.classList.remove('won', 'win', 'lost', 'loss');
    if (el.limboGaugeBar) el.limboGaugeBar.classList.remove('lost');
    audio.ensureContext();
    audio.playLimboLaunch();

    try {
      const res = await fetch('/api/games/limbo/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          currencyMode: state.currencyMode,
          amount,
          targetMultiplier,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Limbo launch failed.', true);
        if (el.limboStatusBadge) el.limboStatusBadge.textContent = 'Ready';
        return;
      }

      const finalVal = Number(data.rolled || 1);
      const tStart = performance.now();
      const tweenDuration = 280;
      const stepNum = (now) => {
        const p = Math.min(1, (now - tStart) / tweenDuration);
        const eased = 1 - Math.pow(1 - p, 3);
        const cur = 1 + (finalVal - 1) * eased;
        if (el.limboResultValue) {
          el.limboResultValue.textContent = `${cur.toFixed(2)}x`;
        }
        if (el.limboGaugeBar) {
          el.limboGaugeBar.style.height = `${calcLogAltitudePct(cur)}%`;
        }
        if (p < 1) {
          requestAnimationFrame(stepNum);
        } else {
          if (el.limboResultValue) {
            el.limboResultValue.textContent = `${finalVal.toFixed(2)}x`;
            el.limboResultValue.classList.toggle('won', Boolean(data.won));
            el.limboResultValue.classList.toggle('lost', !data.won);
          }
          if (el.limboGaugeBar) {
            el.limboGaugeBar.style.height = `${calcLogAltitudePct(finalVal)}%`;
            el.limboGaugeBar.classList.toggle('lost', !data.won);
          }
        }
      };
      requestAnimationFrame(stepNum);

      if (el.limboResultSub) {
        el.limboResultSub.textContent = data.won
          ? `HIT ${Number(data.targetMultiplier).toFixed(2)}x! Won +${fmtMoney(data.payout, data.currencyMode)}`
          : `Stopped at ${finalVal.toFixed(2)}x (Below target ${Number(data.targetMultiplier).toFixed(2)}x)`;
      }
      if (el.limboStatusBadge) {
        el.limboStatusBadge.textContent = data.won ? `WON ${Number(data.multiplier).toFixed(2)}x` : 'Missed';
      }
      if (data.won) audio.playArcadeWin('cyber-limbo');
      if (Array.isArray(data.limboHistory)) state.arcade.limboHistory = data.limboHistory;
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      renderHistory();
      renderSidebar();
    } catch {
      showToast('Network error launching Limbo.', true);
    } finally {
      state.limboBusy = false;
      el.limboPlayBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 6) Neon Coin Flip Controller (3D Metallic Double-Sided Flip)
  // ==========================================================================
  function updateCoinflipMetrics() {
    const amt = Math.max(0, Number(el.coinflipAmount?.value || 0));
    const cfg = getGameConfig('neon-flip');
    const edgePct = Math.min(25, Math.max(0, Number(cfg?.houseEdgePct ?? 4)));
    const mult = Math.max(1.5, Math.floor(2 * (1 - edgePct / 100) * 100) / 100);
    const estWin = Math.round(amt * mult * 100) / 100;
    if (el.coinflipEstWinHint) {
      el.coinflipEstWinHint.textContent = `Potential Win (${mult.toFixed(2)}x): ${fmtMoney(estWin, state.currencyMode)}`;
    }
  }

  document.querySelectorAll('.coinflip-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.coinflipAmount) {
        el.coinflipAmount.value = btn.dataset.amt;
        updateCoinflipMetrics();
      }
    });
  });

  document.querySelectorAll('.coinflip-pick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.coinflipPick = btn.dataset.pick === 'tails' ? 'tails' : 'heads';
      document.querySelectorAll('.coinflip-pick-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  el.coinflipAmount?.addEventListener('input', updateCoinflipMetrics);

  el.coinflipPlayBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.coinflipBusy) return;
    const amount = Number(el.coinflipAmount?.value || 0);
    state.coinflipBusy = true;
    el.coinflipPlayBtn.disabled = true;
    if (el.coinflipStatusBadge) el.coinflipStatusBadge.textContent = 'Flipping...';
    if (el.cyberCoinEl) {
      el.cyberCoinEl.classList.remove('flipping-heads', 'flipping-tails');
    }
    audio.ensureContext();
    audio.playCoinFlip();

    try {
      const res = await fetch('/api/games/coinflip/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          currencyMode: state.currencyMode,
          amount,
          pick: state.coinflipPick,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Coin flip failed.', true);
        if (el.coinflipStatusBadge) el.coinflipStatusBadge.textContent = 'Ready';
        return;
      }

      const isHeads = data.outcome === 'heads';
      if (el.cyberCoinEl) {
        el.cyberCoinEl.classList.remove('heads', 'tails', 'flipping-heads', 'flipping-tails');
        void el.cyberCoinEl.offsetWidth;
        el.cyberCoinEl.classList.add(isHeads ? 'flipping-heads' : 'flipping-tails');
        setTimeout(() => {
          if (el.cyberCoinEl) {
            el.cyberCoinEl.classList.remove('flipping-heads', 'flipping-tails');
            el.cyberCoinEl.classList.toggle('heads', isHeads);
            el.cyberCoinEl.classList.toggle('tails', !isHeads);
          }
        }, 760);
      }

      if (el.coinflipResultSub) {
        el.coinflipResultSub.textContent = data.won
          ? `${String(data.outcome).toUpperCase()}! Won +${fmtMoney(data.payout, data.currencyMode)}`
          : `Landed ${String(data.outcome).toUpperCase()} — Better luck next flip!`;
      }
      if (el.coinflipStatusBadge) {
        el.coinflipStatusBadge.textContent = data.won ? `WIN +${data.multiplier}x` : 'Missed';
      }
      if (data.won) audio.playArcadeWin('neon-flip');
      if (Array.isArray(data.coinflipHistory)) state.arcade.coinflipHistory = data.coinflipHistory;
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      renderHistory();
      renderSidebar();
    } catch {
      el.cyberCoinEl?.classList.remove('flipping-heads', 'flipping-tails');
      showToast('Network error flipping coin.', true);
    } finally {
      state.coinflipBusy = false;
      el.coinflipPlayBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 7) Lucky Wheel Controller (Casino Bezel + Chasing LED Rim)
  // ==========================================================================
  function initWheelBezelLeds() {
    const ring = el.wheelBezelRing;
    if (!ring || ring.dataset.ledsReady === '1') return;
    ring.dataset.ledsReady = '1';
    const bulbCount = 24;
    const radiusPx = 152;
    let html = '';
    for (let i = 0; i < bulbCount; i += 1) {
      const angle = (i / bulbCount) * Math.PI * 2;
      const x = Math.round(Math.cos(angle) * radiusPx);
      const y = Math.round(Math.sin(angle) * radiusPx);
      html += `<span class="wheel-led-dot ${i % 2 === 0 ? 'lit' : ''}" style="transform: translate(${x}px, ${y}px);"></span>`;
    }
    ring.innerHTML = html;
  }

  function updateWheelBezelLeds(stepOffset = 0) {
    const ring = el.wheelBezelRing;
    if (!ring) return;
    const dots = ring.querySelectorAll('.wheel-led-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('lit', (idx + stepOffset) % 2 === 0);
    });
  }

  function renderWheelCanvas(rotRad = 0) {
    const canvas = el.luckyWheelCanvas;
    if (!canvas) return;
    initWheelBezelLeds();
    const wCtx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - 10;
    const segAngle = (Math.PI * 2) / WHEEL_SEGMENTS.length;

    wCtx.clearRect(0, 0, w, h);

    // Outer metallic collar ring
    wCtx.beginPath();
    wCtx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
    wCtx.fillStyle = '#0a1020';
    wCtx.fill();
    wCtx.lineWidth = 3;
    wCtx.strokeStyle = '#fbbf24';
    wCtx.stroke();

    WHEEL_SEGMENTS.forEach((seg, i) => {
      const start = rotRad + i * segAngle;
      const end = start + segAngle;
      wCtx.beginPath();
      wCtx.moveTo(cx, cy);
      wCtx.arc(cx, cy, radius, start, end);
      wCtx.closePath();

      const grad = wCtx.createRadialGradient(cx, cy, 18, cx, cy, radius);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(0.28, seg.color);
      grad.addColorStop(1, seg.color);
      wCtx.fillStyle = grad;
      wCtx.fill();
      wCtx.lineWidth = 2;
      wCtx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      wCtx.stroke();

      // Gold rim peg pin at segment boundary
      const pegX = cx + Math.cos(start) * (radius - 5);
      const pegY = cy + Math.sin(start) * (radius - 5);
      wCtx.beginPath();
      wCtx.arc(pegX, pegY, 3, 0, Math.PI * 2);
      wCtx.fillStyle = '#fde68a';
      wCtx.fill();

      wCtx.save();
      wCtx.translate(cx, cy);
      wCtx.rotate(start + segAngle / 2);
      wCtx.textAlign = 'right';
      wCtx.textBaseline = 'middle';
      wCtx.fillStyle = '#ffffff';
      wCtx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      wCtx.shadowBlur = 4;
      wCtx.font = '800 13px "Outfit", sans-serif';
      wCtx.fillText(seg.label, radius - 16, 0);
      wCtx.restore();
    });

    // Center Luxury Medallion Hub
    wCtx.beginPath();
    wCtx.arc(cx, cy, 29, 0, Math.PI * 2);
    wCtx.fillStyle = '#070b18';
    wCtx.fill();
    wCtx.lineWidth = 3.5;
    wCtx.strokeStyle = '#fde047';
    wCtx.stroke();
    wCtx.fillStyle = '#fde047';
    wCtx.font = '800 12px "Outfit", sans-serif';
    wCtx.textAlign = 'center';
    wCtx.textBaseline = 'middle';
    wCtx.fillText('SPIN', cx, cy);
  }

  document.querySelectorAll('.wheel-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.wheelAmount && !state.wheelBusy) el.wheelAmount.value = btn.dataset.amt;
    });
  });

  el.wheelSpinBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.wheelBusy) return;
    const amount = Number(el.wheelAmount?.value || 0);
    state.wheelBusy = true;
    el.wheelSpinBtn.disabled = true;
    if (el.wheelStatusBadge) el.wheelStatusBadge.textContent = 'Spinning...';
    audio.ensureContext();
    audio.playWheelTick();

    try {
      const res = await fetch('/api/games/wheel/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Wheel spin failed.', true);
        state.wheelBusy = false;
        el.wheelSpinBtn.disabled = false;
        if (el.wheelStatusBadge) el.wheelStatusBadge.textContent = 'Ready';
        return;
      }

      const segIdx = Number(data.segmentIndex ?? 0);
      const segAngle = (Math.PI * 2) / WHEEL_SEGMENTS.length;
      const desiredMod = -Math.PI / 2 - (segIdx + 0.5) * segAngle;
      const twoPi = Math.PI * 2;
      const startRot = state.wheelRotation;
      const baseNormalized = ((startRot % twoPi) + twoPi) % twoPi;
      let delta = (((desiredMod % twoPi) + twoPi) % twoPi) - baseNormalized;
      if (delta <= 0) delta += twoPi;
      const targetRot = startRot + delta + twoPi * 4;

      const durationMs = 2300;
      const t0 = performance.now();
      let lastSegTick = -1;

      const stepWheel = (now) => {
        const p = Math.min(1, (now - t0) / durationMs);
        const eased = 1 - Math.pow(1 - p, 3);
        const curRot = startRot + (targetRot - startRot) * eased;
        state.wheelRotation = curRot;
        renderWheelCanvas(curRot);

        const segTick = Math.floor(curRot / segAngle);
        if (segTick !== lastSegTick) {
          lastSegTick = segTick;
          updateWheelBezelLeds(segTick);
          audio.playWheelTick();
        }

        if (p < 1) {
          requestAnimationFrame(stepWheel);
        } else {
          if (el.wheelResultSub) {
            el.wheelResultSub.textContent =
              data.multiplier > 0
                ? `Landed ${data.multiplier}x! Payout +${fmtMoney(data.payout, data.currencyMode)}`
                : 'Landed 0x — Try another spin!';
          }
          if (el.wheelStatusBadge) el.wheelStatusBadge.textContent = `${data.multiplier}x`;
          if (data.multiplier >= 1) audio.playArcadeWin('lucky-wheel');
          if (Array.isArray(data.wheelHistory)) state.arcade.wheelHistory = data.wheelHistory;
          if (data.user) {
            state.user = data.user;
            updateUserUI();
          }
          renderHistory();
          renderSidebar();
          state.wheelBusy = false;
          el.wheelSpinBtn.disabled = false;
        }
      };
      requestAnimationFrame(stepWheel);
    } catch {
      showToast('Network error spinning wheel.', true);
      state.wheelBusy = false;
      el.wheelSpinBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 8) Dragon Hi-Lo Controller (Pro Casino Card Table + Live Odds)
  // ==========================================================================
  function parseCardStr(cardStr) {
    const raw = String(cardStr || '7♠');
    const suit = raw.slice(-1);
    const rank = raw.slice(0, -1) || '7';
    return { rank, suit };
  }

  function renderPlayingCardTile(tileEl, topEl, pipEl, botEl, cardStr, isRed, isBack = false) {
    if (!tileEl) return;
    tileEl.classList.toggle('back', Boolean(isBack));
    if (isBack) {
      if (topEl) topEl.textContent = '';
      if (pipEl) pipEl.textContent = '★';
      if (botEl) botEl.textContent = '';
      tileEl.classList.remove('red', 'black');
      return;
    }
    const { rank, suit } = parseCardStr(cardStr);
    if (topEl) topEl.textContent = `${rank}${suit}`;
    if (pipEl) pipEl.textContent = suit;
    if (botEl) botEl.textContent = `${rank}${suit}`;
    tileEl.classList.toggle('red', Boolean(isRed));
    tileEl.classList.toggle('black', !isRed);
  }

  function updateHiLoOddsUI() {
    const cfg = getGameConfig('dragon-hilo');
    const edgePct = Math.min(25, Math.max(0, Number(cfg?.houseEdgePct ?? 4)));
    const rtp = Math.max(0.75, 1 - edgePct / 100);
    const baseIdx = Math.min(12, Math.max(0, Number(state.hiloBaseRankIdx ?? 5)));
    const highCount = Math.max(1, 13 - baseIdx);
    const lowCount = Math.max(1, baseIdx + 1);
    const highMult = Math.max(1.04, Math.floor((13 / highCount) * rtp * 100) / 100);
    const lowMult = Math.max(1.04, Math.floor((13 / lowCount) * rtp * 100) / 100);
    if (el.hiloHigherOdds) el.hiloHigherOdds.textContent = `${highMult.toFixed(2)}x`;
    if (el.hiloLowerOdds) el.hiloLowerOdds.textContent = `${lowMult.toFixed(2)}x`;
  }

  document.querySelectorAll('.hilo-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.hiloAmount && !state.hiloBusy) el.hiloAmount.value = btn.dataset.amt;
    });
  });

  document.querySelectorAll('.hilo-choice-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.user) return openAuthModal('login');
      if (state.hiloBusy) return;
      const choice = btn.dataset.choice || 'high';
      const amount = Number(el.hiloAmount?.value || 0);
      state.hiloBusy = true;
      if (el.hiloStatusBadge) el.hiloStatusBadge.textContent = 'Dealing...';
      renderPlayingCardTile(
        el.hiloNextCardEl,
        el.hiloNextCornerTop,
        el.hiloNextCenterPip,
        el.hiloNextCornerBot,
        '',
        false,
        true
      );
      audio.ensureContext();
      audio.playCardDeal();

      try {
        const res = await fetch('/api/games/hilo/play', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${state.token}`,
          },
          body: JSON.stringify({
            currencyMode: state.currencyMode,
            amount,
            baseRankIdx: state.hiloBaseRankIdx,
            choice,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Hi-Lo deal failed.', true);
          if (el.hiloStatusBadge) el.hiloStatusBadge.textContent = 'Ready';
          return;
        }

        const isRed = data.nextSuitIdx === 1 || data.nextSuitIdx === 2;
        renderPlayingCardTile(
          el.hiloNextCardEl,
          el.hiloNextCornerTop,
          el.hiloNextCenterPip,
          el.hiloNextCornerBot,
          data.nextCard || '7♠',
          isRed,
          false
        );

        if (el.hiloResultSub) {
          el.hiloResultSub.textContent = data.won
            ? `Drew ${data.nextCard}! Won ${data.multiplier}x (+${fmtMoney(data.payout, data.currencyMode)})`
            : `Drew ${data.nextCard} — Prediction (${choice.toUpperCase()}) missed`;
        }
        if (el.hiloStatusBadge) {
          el.hiloStatusBadge.textContent = data.won ? `WIN ${data.multiplier}x` : 'Missed';
        }
        if (data.won) audio.playArcadeWin('dragon-hilo');

        if (typeof data.nextRankIdx === 'number') {
          state.hiloBaseRankIdx = data.nextRankIdx;
          renderPlayingCardTile(
            el.hiloBaseCardEl,
            el.hiloBaseCornerTop,
            el.hiloBaseCenterPip,
            el.hiloBaseCornerBot,
            data.nextCard || '7♠',
            isRed,
            false
          );
          updateHiLoOddsUI();
        }
        if (Array.isArray(data.hiloHistory)) state.arcade.hiloHistory = data.hiloHistory;
        if (data.user) {
          state.user = data.user;
          updateUserUI();
        }
        renderHistory();
        renderSidebar();
      } catch {
        showToast('Network error dealing card.', true);
      } finally {
        state.hiloBusy = false;
      }
    });
  });

  // ==========================================================================
  // 9) Emerald 777 Slots Controller (Staggered Vegas Reel Locks + Win Pulse)
  // ==========================================================================
  document.querySelectorAll('.slots-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.slotsAmount && !state.slotsBusy) el.slotsAmount.value = btn.dataset.amt;
    });
  });

  el.slotsSpinBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.slotsBusy) return;
    const amount = Number(el.slotsAmount?.value || 0);
    state.slotsBusy = true;
    el.slotsSpinBtn.disabled = true;
    if (el.slotsStatusBadge) el.slotsStatusBadge.textContent = 'Spinning...';
    const reelEls = [el.slotReel0, el.slotReel1, el.slotReel2];
    reelEls.forEach((r) => r?.classList.remove('reel-won'));
    audio.ensureContext();

    try {
      const res = await fetch('/api/games/slots/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Slots spin failed.', true);
        state.slotsBusy = false;
        el.slotsSpinBtn.disabled = false;
        if (el.slotsStatusBadge) el.slotsStatusBadge.textContent = 'Ready';
        return;
      }

      let step = 0;
      const spinTimer = setInterval(() => {
        audio.playSlotReel(step);
        reelEls.forEach((rEl, idx) => {
          const stopStep = 8 + idx * 4;
          if (rEl && step < stopStep) {
            rEl.textContent = SLOT_SYMBOLS[(step + idx * 2) % SLOT_SYMBOLS.length];
            rEl.classList.add('spinning');
          } else if (rEl && Array.isArray(data.reels)) {
            rEl.textContent = data.reels[idx] || '💎';
            rEl.classList.remove('spinning');
          }
        });
        step += 1;
        if (step > 17) {
          clearInterval(spinTimer);
          const won = Number(data.multiplier || 0) > 0;
          reelEls.forEach((rEl, idx) => {
            if (rEl && Array.isArray(data.reels)) {
              rEl.textContent = data.reels[idx] || '💎';
              rEl.classList.remove('spinning');
              rEl.classList.toggle('reel-won', won);
            }
          });
          if (el.slotsResultSub) {
            el.slotsResultSub.textContent = won
              ? `JACKPOT MATCH ${data.multiplier}x! Won +${fmtMoney(data.payout, data.currencyMode)}`
              : `[${(data.reels || []).join(' | ')}] — Spin again!`;
          }
          if (el.slotsStatusBadge) {
            el.slotsStatusBadge.textContent = won ? `WIN ${data.multiplier}x` : 'No Match';
          }
          if (won) audio.playArcadeWin('emerald-slots');
          if (Array.isArray(data.slotsHistory)) state.arcade.slotsHistory = data.slotsHistory;
          if (data.user) {
            state.user = data.user;
            updateUserUI();
          }
          renderHistory();
          renderSidebar();
          state.slotsBusy = false;
          el.slotsSpinBtn.disabled = false;
        }
      }, 62);
    } catch {
      reelEls.forEach((r) => r?.classList.remove('spinning'));
      showToast('Network error spinning slots.', true);
      state.slotsBusy = false;
      el.slotsSpinBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 10) Crystal Keno Controller (1-40 Grid, 1-5 Picks, 10 Balls Drawn)
  // ==========================================================================
  function renderKenoPaytable() {
    if (!el.kenoPaytableStrip) return;
    const tbl = KENO_PAYTABLES[state.kenoPicks.length] || KENO_PAYTABLES[3];
    const entries = Object.entries(tbl);
    el.kenoPaytableStrip.innerHTML = entries
      .map(([hits, mult]) => `<span class="slots-pay-pill">${hits} Hit${Number(hits) > 1 ? 's' : ''} = ${mult}x</span>`)
      .join('');
    if (el.kenoPickCountText) {
      el.kenoPickCountText.textContent = `Selected: ${state.kenoPicks.length} / 5`;
    }
  }

  function renderKenoBoard(drawn = [], hits = []) {
    if (!el.kenoGrid) return;
    const drawnSet = new Set(drawn);
    const hitSet = new Set(hits);
    el.kenoGrid.innerHTML = '';
    for (let num = 1; num <= 40; num++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isPicked = state.kenoPicks.includes(num);
      const isHit = hitSet.has(num);
      const isDrawn = drawnSet.has(num) && !isHit;
      btn.className = `keno-tile tabular-nums ${isHit ? 'hit' : isPicked ? 'picked' : isDrawn ? 'drawn' : ''}`;
      btn.textContent = String(num);
      btn.disabled = state.kenoBusy;
      btn.addEventListener('click', () => {
        if (state.kenoBusy) return;
        audio.playClick();
        if (state.kenoPicks.includes(num)) {
          state.kenoPicks = state.kenoPicks.filter((x) => x !== num);
        } else if (state.kenoPicks.length < 5) {
          state.kenoPicks.push(num);
        } else {
          showToast('Maximum 5 crystal numbers per draw.', true);
          return;
        }
        renderKenoBoard();
        renderKenoPaytable();
      });
      el.kenoGrid.appendChild(btn);
    }
  }

  el.kenoQuickPickBtn?.addEventListener('click', () => {
    if (state.kenoBusy) return;
    audio.playClick();
    const nums = [];
    while (nums.length < 3) {
      const n = Math.floor(Math.random() * 40) + 1;
      if (!nums.includes(n)) nums.push(n);
    }
    state.kenoPicks = nums;
    renderKenoBoard();
    renderKenoPaytable();
  });

  el.kenoClearBtn?.addEventListener('click', () => {
    if (state.kenoBusy) return;
    state.kenoPicks = [];
    renderKenoBoard();
    renderKenoPaytable();
  });

  document.querySelectorAll('.keno-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.kenoAmount && !state.kenoBusy) el.kenoAmount.value = btn.dataset.amt;
    });
  });

  el.kenoPlayBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.kenoBusy) return;
    if (state.kenoPicks.length < 1) {
      showToast('Pick at least 1 crystal number (1–40).', true);
      return;
    }
    const amount = Number(el.kenoAmount?.value || 0);
    state.kenoBusy = true;
    el.kenoPlayBtn.disabled = true;
    if (el.kenoStatusBadge) el.kenoStatusBadge.textContent = 'Drawing...';
    audio.ensureContext();
    try {
      const res = await fetch('/api/games/keno/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount, picks: state.kenoPicks }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Keno draw failed.', true);
        state.kenoBusy = false;
        el.kenoPlayBtn.disabled = false;
        if (el.kenoStatusBadge) el.kenoStatusBadge.textContent = 'Ready';
        return;
      }

      const drawn = Array.isArray(data.drawn) ? data.drawn : [];
      const hits = Array.isArray(data.hits) ? data.hits : [];
      let revealedIdx = 0;
      const timer = setInterval(() => {
        revealedIdx += 2;
        audio.playKenoDraw(revealedIdx);
        const partial = drawn.slice(0, revealedIdx);
        const partialHits = hits.filter((h) => partial.includes(h));
        renderKenoBoard(partial, partialHits);
        if (revealedIdx >= drawn.length) {
          clearInterval(timer);
          renderKenoBoard(drawn, hits);
          const won = Number(data.multiplier || 0) > 0;
          if (el.kenoResultSub) {
            el.kenoResultSub.textContent = won
              ? `${hits.length} Crystal Hits (${data.multiplier}x)! Won +${fmtMoney(data.payout, data.currencyMode)}`
              : `${hits.length} Hits — Drawn: ${drawn.join(', ')}`;
          }
          if (el.kenoStatusBadge) {
            el.kenoStatusBadge.textContent = won ? `WIN ${data.multiplier}x` : `${hits.length} Hits`;
          }
          if (won) audio.playArcadeWin('crystal-keno');
          if (Array.isArray(data.kenoHistory)) state.arcade.kenoHistory = data.kenoHistory;
          if (data.user) {
            state.user = data.user;
            saveSessionVault(state.token, state.user);
            updateUserUI();
          }
          renderHistory();
          renderSidebar();
          state.kenoBusy = false;
          el.kenoPlayBtn.disabled = false;
        }
      }, 95);
    } catch {
      showToast('Network error drawing Keno balls.', true);
      state.kenoBusy = false;
      el.kenoPlayBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 11) Sky Tower Controller (8-Floor Progressive Vault Climb)
  // ==========================================================================
  function updateTowerCashoutUI() {
    const active = state.tower.active;
    const potWin = active && state.tower.currentFloor > 0
      ? Math.round(state.tower.betAmount * state.tower.multiplier * 100) / 100
      : 0;
    if (el.towerMultBadge) el.towerMultBadge.textContent = `${Number(state.tower.multiplier || 1).toFixed(2)}x`;
    if (el.towerCashoutVal) el.towerCashoutVal.textContent = fmtMoney(potWin, state.currencyMode);
    if (el.towerNextFloorText) {
      el.towerNextFloorText.textContent = active
        ? `Floor ${state.tower.currentFloor + 1} Next: ${Number(state.tower.nextMultiplier || 1.44).toFixed(2)}x`
        : 'Next Floor: 1.44x';
    }
    el.towerStartBtn?.classList.toggle('hidden', active);
    el.towerCashoutBtn?.classList.toggle('hidden', !active || state.tower.currentFloor <= 0);
    if (el.towerCashoutBtn) {
      el.towerCashoutBtn.textContent = `CASH OUT (+${fmtMoney(potWin, state.currencyMode)})`;
    }
  }

  function renderTowerRows() {
    if (!el.towerRowsContainer) return;
    el.towerRowsContainer.innerHTML = '';
    const edgeFactor = Math.max(0.75, 1 - Number(getGameConfig('tower-climb')?.houseEdgePct ?? 4) / 100);

    for (let floor = 7; floor >= 0; floor--) {
      const row = document.createElement('div');
      const isActiveFloor = state.tower.active && state.tower.currentFloor === floor;
      row.className = `tower-row ${isActiveFloor ? 'active-floor' : ''}`;

      const floorMult = Math.max(1.01, Math.round(Math.pow(1.5, floor + 1) * edgeFactor * 100) / 100);
      const label = document.createElement('span');
      label.className = 'tower-floor-label tabular-nums';
      label.textContent = `F${floor + 1} · ${floorMult}x`;
      row.appendChild(label);

      const revItem = state.tower.revealed.find((r) => r.floor === floor);
      const trapIdx = state.tower.traps.length === 8 ? state.tower.traps[floor] : -1;

      for (let tile = 0; tile < 3; tile++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tower-tile';
        const isRevSafe = revItem && revItem.tile === tile;
        const isHitTrap = !state.tower.active && state.tower.hitBoom && state.tower.hitBoom.floor === floor && state.tower.hitBoom.tile === tile;
        const isHintTrap = !state.tower.active && trapIdx === tile && !isHitTrap;

        if (isRevSafe) {
          btn.classList.add('safe');
          btn.textContent = '💎';
        } else if (isHitTrap) {
          btn.classList.add('trap');
          btn.textContent = '💣';
        } else if (isHintTrap) {
          btn.classList.add('trap-hint');
          btn.textContent = '💣';
        } else {
          btn.textContent = isActiveFloor ? '★' : '·';
        }

        btn.disabled = !isActiveFloor || state.tower.busy;
        btn.addEventListener('click', () => handleTowerStep(floor, tile));
        row.appendChild(btn);
      }
      el.towerRowsContainer.appendChild(row);
    }
  }

  document.querySelectorAll('.tower-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.towerAmount && !state.tower.active) el.towerAmount.value = btn.dataset.amt;
    });
  });

  el.towerStartBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.tower.busy || state.tower.active) return;
    const amount = Number(el.towerAmount?.value || 0);
    state.tower.busy = true;
    el.towerStartBtn.disabled = true;
    audio.ensureContext();
    try {
      const res = await fetch('/api/games/tower/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not start Sky Tower.', true);
        return;
      }
      state.tower = {
        active: true,
        currentFloor: 0,
        betAmount: amount,
        multiplier: 1.0,
        nextMultiplier: Number(data.nextMultiplier || 1.44),
        revealed: [],
        traps: [],
        hitBoom: null,
        busy: false,
      };
      if (data.user) {
        state.user = data.user;
        saveSessionVault(state.token, state.user);
        updateUserUI();
      }
      if (el.towerResultSub) el.towerResultSub.textContent = 'Choose 1 of 3 tiles on Floor 1!';
      audio.playClick();
      renderTowerRows();
      updateTowerCashoutUI();
    } catch {
      showToast('Network error starting Sky Tower.', true);
    } finally {
      state.tower.busy = false;
      el.towerStartBtn.disabled = false;
    }
  });

  async function handleTowerStep(floor, tile) {
    if (!state.tower.active || state.tower.busy) return;
    state.tower.busy = true;
    renderTowerRows();
    try {
      const res = await fetch('/api/games/tower/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ floor, tile }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Tower step failed.', true);
        state.tower.busy = false;
        renderTowerRows();
        return;
      }

      if (data.boom) {
        audio.playCrash();
        state.tower.active = false;
        state.tower.traps = data.traps || [];
        state.tower.revealed = data.revealed || state.tower.revealed;
        state.tower.hitBoom = { floor, tile };
        state.tower.multiplier = 0;
        if (el.towerResultSub) el.towerResultSub.textContent = `TRAP HIT on Floor ${floor + 1}! Better luck next climb.`;
        if (Array.isArray(data.towerHistory)) state.arcade.towerHistory = data.towerHistory;
        if (data.user) {
          state.user = data.user;
          saveSessionVault(state.token, state.user);
          updateUserUI();
        }
        renderHistory();
        renderSidebar();
      } else if (data.completedTop) {
        audio.playArcadeWin('tower-climb');
        state.tower.active = false;
        state.tower.traps = data.traps || [];
        state.tower.revealed = data.revealed || [];
        state.tower.currentFloor = 8;
        state.tower.multiplier = Number(data.multiplier || 1);
        if (el.towerResultSub) el.towerResultSub.textContent = `SUMMIT REACHED ${data.multiplier}x! Won +${fmtMoney(data.payout, state.currencyMode)}`;
        if (Array.isArray(data.towerHistory)) state.arcade.towerHistory = data.towerHistory;
        if (data.user) {
          state.user = data.user;
          saveSessionVault(state.token, state.user);
          updateUserUI();
        }
        renderHistory();
        renderSidebar();
      } else {
        audio.playTowerStep(floor);
        state.tower.revealed = data.revealed || [...state.tower.revealed, { floor, tile }];
        state.tower.currentFloor = Number(data.currentFloor || floor + 1);
        state.tower.multiplier = Number(data.multiplier || 1);
        state.tower.nextMultiplier = Number(data.nextMultiplier || state.tower.multiplier);
        if (el.towerResultSub) {
          el.towerResultSub.textContent = `Safe! Climbed Floor ${state.tower.currentFloor} (${state.tower.multiplier.toFixed(2)}x) — Keep climbing or Cash Out!`;
        }
      }
      renderTowerRows();
      updateTowerCashoutUI();
    } catch {
      showToast('Network error during Sky Tower climb.', true);
    } finally {
      state.tower.busy = false;
      renderTowerRows();
    }
  }

  el.towerCashoutBtn?.addEventListener('click', async () => {
    if (!state.tower.active || state.tower.busy || state.tower.currentFloor <= 0) return;
    state.tower.busy = true;
    el.towerCashoutBtn.disabled = true;
    try {
      const res = await fetch('/api/games/tower/cashout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Cashout failed.', true);
        return;
      }
      audio.playCashout();
      state.tower.active = false;
      state.tower.traps = data.traps || [];
      state.tower.revealed = data.revealed || state.tower.revealed;
      if (el.towerResultSub) {
        el.towerResultSub.textContent = `CASHED OUT ${data.multiplier}x! Won +${fmtMoney(data.payout, state.currencyMode)}`;
      }
      if (Array.isArray(data.towerHistory)) state.arcade.towerHistory = data.towerHistory;
      if (data.user) {
        state.user = data.user;
        saveSessionVault(state.token, state.user);
        updateUserUI();
      }
      renderTowerRows();
      updateTowerCashoutUI();
      renderHistory();
      renderSidebar();
    } catch {
      showToast('Network error cashing out Sky Tower.', true);
    } finally {
      state.tower.busy = false;
      el.towerCashoutBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 12) Dragon Tiger Controller
  // ==========================================================================
  el.dtChoiceGroup?.querySelectorAll('[data-dt-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.dtBusy) return;
      state.dtChoice = btn.dataset.dtChoice || 'dragon';
      el.dtChoiceGroup.querySelectorAll('[data-dt-choice]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  document.querySelectorAll('.dt-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.dtAmount && !state.dtBusy) el.dtAmount.value = btn.dataset.amt;
    });
  });

  function renderPlayingCardEl(cardEl, cardStr, suitIdx) {
    if (!cardEl) return;
    const isRed = suitIdx === 1 || suitIdx === 2;
    cardEl.classList.remove('back', 'red', 'black');
    cardEl.classList.add(isRed ? 'red' : 'black');
    const suit = cardStr ? cardStr.slice(-1) : '♠';
    const top = cardEl.querySelector('.card-corner-top');
    const mid = cardEl.querySelector('.card-center-pip');
    const bot = cardEl.querySelector('.card-corner-bot');
    if (top) top.textContent = cardStr;
    if (mid) mid.textContent = suit;
    if (bot) bot.textContent = cardStr;
  }

  el.dtDealBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.dtBusy) return;
    const amount = Number(el.dtAmount?.value || 0);
    state.dtBusy = true;
    el.dtDealBtn.disabled = true;
    if (el.dtStatusBadge) el.dtStatusBadge.textContent = 'Dealing...';
    audio.ensureContext();
    audio.playCardDeal(0);
    try {
      const res = await fetch('/api/games/dragon-tiger/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount, choice: state.dtChoice }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Dragon Tiger deal failed.', true);
        if (el.dtStatusBadge) el.dtStatusBadge.textContent = 'Ready';
        return;
      }
      renderPlayingCardEl(el.dtDragonCard, data.dragonCard, data.dragonSuitIdx);
      setTimeout(() => audio.playCardDeal(1), 110);
      renderPlayingCardEl(el.dtTigerCard, data.tigerCard, data.tigerSuitIdx);

      const winnerLabel = String(data.winner || '').toUpperCase();
      if (el.dtStatusBadge) {
        el.dtStatusBadge.textContent = data.won ? `WIN ${data.multiplier}x` : winnerLabel === 'TIE' ? '50% Push' : `${winnerLabel} Wins`;
      }
      if (el.dtResultSub) {
        el.dtResultSub.textContent = data.won
          ? `${winnerLabel} WINS! Won +${fmtMoney(data.payout, data.currencyMode)} (${data.multiplier}x)`
          : winnerLabel === 'TIE'
            ? `Tie Push — 50% Refunded (+${fmtMoney(data.payout, data.currencyMode)})`
            : `${winnerLabel} took it (${data.dragonCard} vs ${data.tigerCard})`;
      }
      if (data.won) audio.playArcadeWin('dragon-tiger');
      if (Array.isArray(data.dragonTigerHistory)) state.arcade.dragonTigerHistory = data.dragonTigerHistory;
      if (data.user) {
        state.user = data.user;
        saveSessionVault(state.token, state.user);
        updateUserUI();
      }
      renderHistory();
      renderSidebar();
    } catch {
      showToast('Network error dealing Dragon Tiger.', true);
    } finally {
      state.dtBusy = false;
      el.dtDealBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 13) Neon Baccarat Controller (Punto Banco Shoe)
  // ==========================================================================
  el.bacChoiceGroup?.querySelectorAll('[data-bac-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.bacBusy) return;
      state.bacChoice = btn.dataset.bacChoice || 'player';
      el.bacChoiceGroup.querySelectorAll('[data-bac-choice]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  document.querySelectorAll('.bac-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.bacAmount && !state.bacBusy) el.bacAmount.value = btn.dataset.amt;
    });
  });

  function renderBaccaratHand(containerEl, cards) {
    if (!containerEl) return;
    containerEl.innerHTML = (cards || [])
      .map((c) => {
        const redCls = c.suitIdx === 1 || c.suitIdx === 2 ? 'red' : '';
        return `<div class="mini-card ${redCls}">${escapeHtml(c.label)}</div>`;
      })
      .join('');
  }

  el.bacDealBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.bacBusy) return;
    const amount = Number(el.bacAmount?.value || 0);
    state.bacBusy = true;
    el.bacDealBtn.disabled = true;
    if (el.bacStatusBadge) el.bacStatusBadge.textContent = 'Dealing Shoe...';
    audio.ensureContext();
    audio.playCardDeal(0);
    try {
      const res = await fetch('/api/games/baccarat/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount, choice: state.bacChoice }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Baccarat deal failed.', true);
        if (el.bacStatusBadge) el.bacStatusBadge.textContent = 'Ready';
        return;
      }
      renderBaccaratHand(el.bacPlayerCards, data.playerCards);
      renderBaccaratHand(el.bacBankerCards, data.bankerCards);
      if (el.bacPlayerScore) el.bacPlayerScore.textContent = String(data.playerScore ?? 0);
      if (el.bacBankerScore) el.bacBankerScore.textContent = String(data.bankerScore ?? 0);

      const winnerLabel = String(data.winner || '').toUpperCase();
      if (el.bacStatusBadge) {
        el.bacStatusBadge.textContent = data.won ? `WIN ${data.multiplier}x` : `${winnerLabel} (${data.playerScore}-${data.bankerScore})`;
      }
      if (el.bacResultSub) {
        el.bacResultSub.textContent = data.won
          ? `${winnerLabel} WINS ${data.playerScore} vs ${data.bankerScore}! +${fmtMoney(data.payout, data.currencyMode)}`
          : winnerLabel === 'TIE'
            ? `Tie Push (${data.playerScore}-${data.bankerScore}) — Stake Returned!`
            : `${winnerLabel} Won (${data.playerScore} vs ${data.bankerScore})`;
      }
      if (data.won) audio.playArcadeWin('neon-baccarat');
      if (Array.isArray(data.baccaratHistory)) state.arcade.baccaratHistory = data.baccaratHistory;
      if (data.user) {
        state.user = data.user;
        saveSessionVault(state.token, state.user);
        updateUserUI();
      }
      renderHistory();
      renderSidebar();
    } catch {
      showToast('Network error dealing Baccarat.', true);
    } finally {
      state.bacBusy = false;
      el.bacDealBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 14) Royal Roulette Controller (0-36 Single Zero Wheel)
  // ==========================================================================
  el.roulBetBoard?.querySelectorAll('[data-roul-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.roulBusy) return;
      state.roulBetType = btn.dataset.roulType || 'red';
      el.roulBetBoard.querySelectorAll('[data-roul-type]').forEach((b) => b.classList.toggle('active', b === btn));
      el.roulStraightRow?.classList.toggle('hidden', state.roulBetType !== 'number');
    });
  });

  document.querySelectorAll('.roul-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.roulAmount && !state.roulBusy) el.roulAmount.value = btn.dataset.amt;
    });
  });

  el.roulSpinBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.roulBusy) return;
    const amount = Number(el.roulAmount?.value || 0);
    const number = Math.min(36, Math.max(0, Math.floor(Number(el.roulStraightInput?.value ?? 7))));
    state.roulBusy = true;
    el.roulSpinBtn.disabled = true;
    if (el.roulStatusBadge) el.roulStatusBadge.textContent = 'Spinning...';
    audio.ensureContext();
    try {
      const res = await fetch('/api/games/roulette/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount, betType: state.roulBetType, number }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Roulette spin failed.', true);
        state.roulBusy = false;
        el.roulSpinBtn.disabled = false;
        if (el.roulStatusBadge) el.roulStatusBadge.textContent = 'Ready';
        return;
      }

      state.roulRotation += 720 + ((Number(data.pocket || 0) * 9.73) % 360);
      if (el.roulWheelDisc) el.roulWheelDisc.style.transform = `rotate(${state.roulRotation}deg)`;

      let ticks = 0;
      const tickTimer = setInterval(() => {
        audio.playRouletteSpin(ticks);
        ticks += 1;
        if (ticks >= 8) {
          clearInterval(tickTimer);
          if (el.roulPocketOrb) {
            el.roulPocketOrb.textContent = String(data.pocket ?? 0);
            el.roulPocketOrb.className = `roul-pocket-hub tabular-nums pocket-${data.color || 'green'}`;
          }
          if (el.roulStatusBadge) {
            el.roulStatusBadge.textContent = data.won ? `WIN ${data.multiplier}x` : `#${data.pocket} ${String(data.color || '').toUpperCase()}`;
          }
          if (el.roulResultSub) {
            el.roulResultSub.textContent = data.won
              ? `POCKET #${data.pocket} (${String(data.color || '').toUpperCase()})! Won +${fmtMoney(data.payout, data.currencyMode)}`
              : `Landed on #${data.pocket} (${String(data.color || '').toUpperCase()}) — Spin again!`;
          }
          if (data.won) audio.playArcadeWin('triple-roulette');
          if (Array.isArray(data.rouletteHistory)) state.arcade.rouletteHistory = data.rouletteHistory;
          if (data.user) {
            state.user = data.user;
            saveSessionVault(state.token, state.user);
            updateUserUI();
          }
          renderHistory();
          renderSidebar();
          state.roulBusy = false;
          el.roulSpinBtn.disabled = false;
        }
      }, 105);
    } catch {
      showToast('Network error spinning Roulette.', true);
      state.roulBusy = false;
      el.roulSpinBtn.disabled = false;
    }
  });

  // ==========================================================================
  // 15) Golden Scratch Controller (3x3 Brushed Gold Foil)
  // ==========================================================================
  function finalizeScratchCardIfDone() {
    if (!state.scratch.active) return;
    if (state.scratch.scratched.every(Boolean)) {
      state.scratch.active = false;
      el.scratchRevealAllBtn?.classList.add('hidden');
      if (state.scratch.pendingUser) {
        state.user = state.scratch.pendingUser;
        state.scratch.pendingUser = null;
        saveSessionVault(state.token, state.user);
        updateUserUI();
      }
      if (Array.isArray(state.scratch.pendingHistory)) {
        state.arcade.scratchHistory = state.scratch.pendingHistory;
        state.scratch.pendingHistory = null;
      }
      if (state.scratch.won) {
        audio.playArcadeWin('lucky-scratch');
        if (el.scratchResultSub) {
          el.scratchResultSub.textContent = `MATCHED 3× ${state.scratch.matchSymbol} (${state.scratch.mult}x)! Won +${fmtMoney(state.scratch.payout, state.scratch.currencyMode)}`;
        }
        if (el.scratchStatusBadge) el.scratchStatusBadge.textContent = `WIN ${state.scratch.mult}x`;
      } else {
        if (el.scratchResultSub) el.scratchResultSub.textContent = 'No 3-of-a-kind match — Buy a new Golden Scratch card!';
        if (el.scratchStatusBadge) el.scratchStatusBadge.textContent = 'Try Again';
      }
      renderHistory();
      renderSidebar();
      renderScratchGrid();
    }
  }

  function renderScratchGrid() {
    if (!el.scratchGrid) return;
    el.scratchGrid.innerHTML = '';
    const hasCard = state.scratch.cells.length === 9;
    for (let i = 0; i < 9; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isRevealed = hasCard && state.scratch.scratched[i];
      const sym = hasCard ? state.scratch.cells[i] : '✦';
      const isWinningMatch = isRevealed && state.scratch.won && !state.scratch.active && sym === state.scratch.matchSymbol;
      btn.className = `scratch-tile ${isRevealed ? 'scratched' : ''} ${isWinningMatch ? 'match-win' : ''}`;
      btn.textContent = isRevealed ? sym : '✦';
      btn.disabled = !hasCard || isRevealed || state.scratch.busy;
      btn.addEventListener('click', () => {
        if (!state.scratch.active || state.scratch.scratched[i]) return;
        state.scratch.scratched[i] = true;
        audio.playScratchReveal(i);
        renderScratchGrid();
        finalizeScratchCardIfDone();
      });
      el.scratchGrid.appendChild(btn);
    }
  }

  document.querySelectorAll('.scratch-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (el.scratchAmount && !state.scratch.busy) el.scratchAmount.value = btn.dataset.amt;
    });
  });

  el.scratchBuyBtn?.addEventListener('click', async () => {
    if (!state.user) return openAuthModal('login');
    if (state.scratch.busy) return;
    if (state.scratch.active) {
      el.scratchRevealAllBtn?.click();
    }
    const amount = Number(el.scratchAmount?.value || 0);
    state.scratch.busy = true;
    el.scratchBuyBtn.disabled = true;
    if (el.scratchStatusBadge) el.scratchStatusBadge.textContent = 'Minting Card...';
    audio.ensureContext();
    try {
      const res = await fetch('/api/games/scratch/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ currencyMode: state.currencyMode, amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not buy Golden Scratch card.', true);
        if (el.scratchStatusBadge) el.scratchStatusBadge.textContent = 'Ready';
        return;
      }
      state.scratch = {
        active: true,
        cells: Array.isArray(data.cells) ? data.cells : [],
        scratched: new Array(9).fill(false),
        matchSymbol: data.matchSymbol || '',
        won: Boolean(data.won),
        mult: Number(data.multiplier || 0),
        payout: Number(data.payout || 0),
        currencyMode: data.currencyMode || state.currencyMode,
        pendingUser: data.user || null,
        pendingHistory: Array.isArray(data.scratchHistory) ? data.scratchHistory : null,
        busy: false,
      };
      audio.playClick();
      el.scratchRevealAllBtn?.classList.remove('hidden');
      if (el.scratchStatusBadge) el.scratchStatusBadge.textContent = 'Tap Foil to Scratch!';
      if (el.scratchResultSub) el.scratchResultSub.textContent = 'Tap each gold foil tile or click REVEAL ALL!';
      renderScratchGrid();
    } catch {
      showToast('Network error purchasing Golden Scratch card.', true);
    } finally {
      state.scratch.busy = false;
      el.scratchBuyBtn.disabled = false;
    }
  });

  el.scratchRevealAllBtn?.addEventListener('click', () => {
    if (!state.scratch.active) return;
    audio.playScratchReveal(4);
    state.scratch.scratched = new Array(9).fill(true);
    finalizeScratchCardIfDone();
  });

  // ==========================================================================
  // VIP Loyalty Tiers, Rewards & WhatsApp Referral Share & Earn (15%)
  // ==========================================================================
  function getReferralShareUrl() {
    const code = state.user?.referralCode || '';
    return `${window.location.origin}/?ref=${encodeURIComponent(code)}`;
  }

  function handleWhatsappShareClick(e, triggerBtn = null) {
    if (!state.user?.referralCode) {
      e?.preventDefault?.();
      openAuthModal('register');
      return;
    }
    const shareUrl = getReferralShareUrl();
    const waUrl = buildWhatsAppShareUrl();
    if (triggerBtn && triggerBtn.tagName === 'A') {
      triggerBtn.href = waUrl;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(shareUrl).catch(() => {});
    }
    showToast('Opening WhatsApp to share your 15% referral invite link!');
  }

  el.shareHeaderBtn?.addEventListener('click', (e) => handleWhatsappShareClick(e, el.shareHeaderBtn));
  el.homeWhatsappShareBtn?.addEventListener('click', (e) => handleWhatsappShareClick(e, el.homeWhatsappShareBtn));
  el.drawerShareBtn?.addEventListener('click', (e) => handleWhatsappShareClick(e, el.drawerShareBtn));

  el.profileCopyRefBtn?.addEventListener('click', () => {
    if (!state.user?.referralCode) return;
    copyValueWithButton(el.profileCopyRefBtn, getReferralShareUrl(), 'Copied!');
  });

  el.copyReferralLinkBtn?.addEventListener('click', () => {
    if (!state.user?.referralCode) return;
    copyValueWithButton(el.copyReferralLinkBtn, getReferralShareUrl(), 'Copied!');
  });

  function renderLoginStreakUI(streak) {
    if (!streak || typeof streak !== 'object') return;
    const count = Number(streak.streakCount || 0);
    const completed = Number(streak.completedCount || 0);
    const totalEarned = Number(streak.totalEarnedFun || 0);
    const pct = Math.min(100, Math.round((completed / 7) * 100));

    if (el.rewardsStreakBadge) {
      el.rewardsStreakBadge.textContent = `${count}-Day Streak`;
    }
    if (el.rewardsStreakEarned) {
      el.rewardsStreakEarned.textContent = `Earned: ${totalEarned.toLocaleString()} FC`;
    }
    if (el.rewardsStreakProgressBar) {
      el.rewardsStreakProgressBar.style.width = `${pct}%`;
    }
    if (el.rewardsStreakProgressText) {
      el.rewardsStreakProgressText.textContent = `${completed} / 7 Days`;
    }
    if (el.rewardsStreakCalendar && Array.isArray(streak.days)) {
      el.rewardsStreakCalendar.innerHTML = streak.days
        .map((d) => {
          const cls = [
            'streak-day-cell',
            d.completed ? 'completed' : '',
            d.isToday ? 'is-today' : '',
            d.isToday && streak.readyToClaim ? 'is-ready' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const stateText = d.claimed || d.completed ? 'Claimed' : d.isToday && streak.readyToClaim ? 'Ready!' : 'Locked';
          return `
            <div class="${cls}">
              <span class="streak-day-num">Day ${d.day}</span>
              <span class="streak-day-fc">+${d.rewardFun} FC</span>
              <span class="streak-day-state">${stateText}</span>
            </div>
          `;
        })
        .join('');
    }
    if (el.rewardsStreakHint) {
      if (streak.claimedToday) {
        el.rewardsStreakHint.textContent = `Day ${streak.cycleDay} claimed! Log in tomorrow to continue your ${count + 1}-day streak.`;
      } else if (streak.readyToClaim) {
        el.rewardsStreakHint.textContent = `Day ${streak.cycleDay} bonus (+${streak.nextRewardFun} FC) is ready to claim now!`;
      } else {
        el.rewardsStreakHint.textContent = 'Streak claims are currently restricted on this account.';
      }
    }
    if (el.claimStreakRewardBtn) {
      el.claimStreakRewardBtn.disabled = !streak.readyToClaim;
      el.claimStreakRewardBtn.textContent = streak.claimedToday
        ? `Day ${streak.cycleDay} Claimed`
        : `Claim Day ${streak.cycleDay} (+${streak.nextRewardFun} FC)`;
    }
  }

  async function openRewardsFlow() {
    if (!state.user) {
      openAuthModal(urlRefCode ? 'register' : 'login');
      return;
    }
    openModal('rewardsModal');
    try {
      const res = await fetch('/api/rewards/status', {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const vip = data.vip || {};
      el.rewardsVipTierName.textContent = `${vip.tier || 'Bronze'} VIP`;
      el.rewardsNextTierLabel.textContent = vip.nextTier
        ? `Next: ${vip.nextTier} (${Number(vip.nextTarget || 0).toLocaleString()} PKR wagered)`
        : 'Maximum Platinum VIP Achieved!';
      el.rewardsVipProgress.style.width = `${vip.progressPct || 0}%`;
      el.rewardsDailyDesc.textContent = `+${vip.dailyFun || 200} FC & +${vip.dailyReal || 10} PKR daily`;
      el.rewardsWeeklyDesc.textContent = `Estimated Cashback (${vip.cashbackPct || 5}%): ${Number(data.estimatedCashback || 0).toLocaleString()} PKR`;
      el.rewardsRefCodeText.textContent = data.referralCode || '---';
      el.rewardsRefEarnedText.textContent = `${Number(data.referralEarnings || 0).toLocaleString()} PKR`;

      if (data.loginStreak) {
        renderLoginStreakUI(data.loginStreak);
      }

      if (data.bonusRestricted) {
        el.rewardsEligibilityHint.textContent = 'Bonus rewards disabled due to multi-account/device restriction.';
        el.rewardsEligibilityHint.style.color = '#f87171';
      } else if (!data.hasDeposited) {
        el.rewardsEligibilityHint.textContent = 'Make an approved Real PKR deposit to unlock Daily Login & Weekly Cashback rewards.';
        el.rewardsEligibilityHint.style.color = '#fbbf24';
      } else {
        el.rewardsEligibilityHint.textContent = 'Eligible for VIP Daily Login & Weekly Cashback rewards!';
        el.rewardsEligibilityHint.style.color = '#34d399';
      }

      el.claimDailyRewardBtn.disabled = !data.dailyReady;
      el.claimWeeklyRewardBtn.disabled = !data.weeklyReady;
    } catch {
      // ignore
    }
  }

  el.profileRewardsBtn?.addEventListener('click', () => {
    closeModal('profileModal');
    openRewardsFlow();
  });

  el.claimStreakRewardBtn?.addEventListener('click', async () => {
    if (!state.token) return;
    el.claimStreakRewardBtn.disabled = true;
    try {
      const res = await fetch('/api/rewards/streak', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not claim streak bonus.', true);
        openRewardsFlow();
        return;
      }
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      if (data.loginStreak) {
        renderLoginStreakUI(data.loginStreak);
      }
      audio.playCashout();
      showToast(`Day ${data.cycleDay} Login Streak Claimed! +${data.awardedFun} FC`);
    } catch {
      showToast('Failed to claim daily streak reward.', true);
      openRewardsFlow();
    }
  });

  el.claimDailyRewardBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/rewards/daily', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not claim daily bonus.', true);
        return;
      }
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      audio.playCashout();
      showToast(`Daily Reward Claimed! +${data.awardedFun} FC & +${data.awardedReal} PKR`);
      openRewardsFlow();
    } catch {
      showToast('Failed to claim daily reward.', true);
    }
  });

  el.claimWeeklyRewardBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/rewards/weekly', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not claim weekly cashback.', true);
        return;
      }
      if (data.user) {
        state.user = data.user;
        updateUserUI();
      }
      audio.playCashout();
      showToast(`Weekly VIP Cashback Claimed! +${data.cashback} PKR`);
      openRewardsFlow();
    } catch {
      showToast('Failed to claim weekly cashback.', true);
    }
  });

  // ==========================================================================
  // Player Local Audio Settings (Integrated in Profile & Settings Drawer)
  // ==========================================================================
  function saveAndApplyLocalAudio() {
    const cfg = {
      bgmEnabled: Boolean(el.playerAudioBgm?.checked),
      soundPreset: el.playerAudioPreset?.value || 'aviator-jet',
      masterVolume: Number(el.playerAudioVolume?.value ?? 75),
    };
    lsSet('skywing_player_audio', JSON.stringify(cfg));
    if (el.playerAudioBgmLabel) el.playerAudioBgmLabel.textContent = cfg.bgmEnabled ? 'ON' : 'OFF';
    if (el.playerAudioVolVal) el.playerAudioVolVal.textContent = `${cfg.masterVolume}%`;
    audio.setConfig(cfg, state.soundEnabled);
    if (!cfg.bgmEnabled) audio.stopBGM();
  }

  el.playerAudioBgm?.addEventListener('change', saveAndApplyLocalAudio);
  el.playerAudioPreset?.addEventListener('change', saveAndApplyLocalAudio);
  el.playerAudioVolume?.addEventListener('input', saveAndApplyLocalAudio);
  el.playerAudioResetBtn?.addEventListener('click', () => {
    lsRemove('skywing_player_audio');
    const serverCfg = state.publicSettings.audioConfig;
    audio.setConfig(serverCfg, state.soundEnabled);
    syncPlayerAudioDrawerUI();
    showToast('Synced audio back to server defaults.');
  });

  // ==========================================================================
  // In-App Live Support Ticket Chat (Screenshot & Photo Upload Enabled)
  // ==========================================================================
  function compressSupportChatImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        reject(new Error('Please select a valid image file (JPG, PNG, WebP).'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Invalid image file.'));
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
          off.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(off.toDataURL('image/jpeg', 0.78));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function clearNewTicketImage() {
    state.pendingNewTicketImg = '';
    if (el.newTicketImage) el.newTicketImage.value = '';
    if (el.newTicketImgPreview) el.newTicketImgPreview.removeAttribute('src');
    el.newTicketImgPreviewWrap?.classList.add('hidden');
  }

  function clearReplyTicketImage() {
    state.pendingReplyTicketImg = '';
    if (el.userChatImage) el.userChatImage.value = '';
    if (el.userChatImgPreview) el.userChatImgPreview.removeAttribute('src');
    el.userChatImgPreviewWrap?.classList.add('hidden');
  }

  el.newTicketAttachBtn?.addEventListener('click', () => el.newTicketImage?.click());
  el.newTicketClearImgBtn?.addEventListener('click', clearNewTicketImage);
  el.newTicketImage?.addEventListener('change', async () => {
    const file = el.newTicketImage.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressSupportChatImage(file);
      state.pendingNewTicketImg = compressed;
      if (el.newTicketImgPreview) el.newTicketImgPreview.src = compressed;
      el.newTicketImgPreviewWrap?.classList.remove('hidden');
    } catch (err) {
      showToast(err.message || 'Could not process image.', true);
    }
  });

  el.userChatAttachBtn?.addEventListener('click', () => el.userChatImage?.click());
  el.userChatClearImgBtn?.addEventListener('click', clearReplyTicketImage);
  el.userChatImage?.addEventListener('change', async () => {
    const file = el.userChatImage.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressSupportChatImage(file);
      state.pendingReplyTicketImg = compressed;
      if (el.userChatImgPreview) el.userChatImgPreview.src = compressed;
      el.userChatImgPreviewWrap?.classList.remove('hidden');
    } catch (err) {
      showToast(err.message || 'Could not process image.', true);
    }
  });

  function bindSupportPasteAndDrop(zoneEl, inputEl, isReply) {
    const acceptFile = async (file) => {
      if (!file || !file.type.startsWith('image/')) return;
      try {
        const compressed = await compressSupportChatImage(file);
        if (isReply) {
          state.pendingReplyTicketImg = compressed;
          if (el.userChatImgPreview) el.userChatImgPreview.src = compressed;
          el.userChatImgPreviewWrap?.classList.remove('hidden');
        } else {
          state.pendingNewTicketImg = compressed;
          if (el.newTicketImgPreview) el.newTicketImgPreview.src = compressed;
          el.newTicketImgPreviewWrap?.classList.remove('hidden');
        }
        showToast('Screenshot attached to message!');
      } catch (err) {
        showToast(err.message || 'Could not attach pasted screenshot.', true);
      }
    };

    inputEl?.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            acceptFile(f);
            break;
          }
        }
      }
    });

    if (zoneEl) {
      zoneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        zoneEl.classList.add('drag-over');
      });
      zoneEl.addEventListener('dragleave', () => {
        zoneEl.classList.remove('drag-over');
      });
      zoneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        zoneEl.classList.remove('drag-over');
        const f = e.dataTransfer?.files?.[0];
        if (f) acceptFile(f);
      });
    }
  }
  bindSupportPasteAndDrop(el.newTicketForm, el.newTicketText, false);
  bindSupportPasteAndDrop(el.userChatReplyForm, el.userChatReplyInput, true);

  function renderUserSupportTickets() {
    if (!el.userTicketList) return;
    if (!state.supportTickets.length) {
      el.userTicketList.innerHTML = '<span class="form-hint">No support tickets yet. Click "+ New Ticket".</span>';
      el.activeTicketSubject.textContent = 'Select or create a ticket';
      el.activeTicketStatus.textContent = '-';
      el.userChatThread.innerHTML = '<span class="form-hint">Start a conversation with Admin Support anytime.</span>';
      el.userChatReplyForm?.classList.add('hidden');
      return;
    }

    if (!state.activeTicketId || !state.supportTickets.some((t) => String(t._id || t.id) === state.activeTicketId)) {
      state.activeTicketId = String(state.supportTickets[0]._id || state.supportTickets[0].id);
    }

    el.userTicketList.innerHTML = state.supportTickets
      .map((t) => {
        const tid = String(t._id || t.id);
        return `
          <button type="button" class="ticket-item ${tid === state.activeTicketId ? 'active' : ''}" data-ticket-id="${escapeHtml(tid)}">
            <strong style="font-size:0.8rem;">${escapeHtml(t.subject)}</strong>
            <span style="font-size:0.7rem; color:${t.status === 'closed' ? '#94a3b8' : '#34d399'};">${String(t.status || 'open').toUpperCase()} · ${(t.messages || []).length} msgs</span>
          </button>
        `;
      })
      .join('');

    el.userTicketList.querySelectorAll('[data-ticket-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTicketId = btn.dataset.ticketId;
        el.newTicketForm?.classList.add('hidden');
        renderUserSupportTickets();
      });
    });

    const active = state.supportTickets.find((t) => String(t._id || t.id) === state.activeTicketId);
    if (active) {
      el.activeTicketSubject.textContent = active.subject;
      el.activeTicketStatus.textContent = String(active.status || 'open').toUpperCase();
      el.userChatThread.innerHTML = (active.messages || [])
        .map(
          (m) => `
          <div class="chat-msg ${m.sender === 'admin' ? 'admin' : 'user'}">
            ${m.imageData ? `<img src="${escapeHtml(m.imageData)}" class="chat-msg-img" alt="Attached screenshot" />` : ''}
            ${m.text ? `<div>${escapeHtml(m.text)}</div>` : ''}
            <span class="chat-msg-time">${m.sender === 'admin' ? 'Admin' : 'You'} · ${new Date(m.createdAt).toLocaleTimeString()}</span>
          </div>
        `
        )
        .join('');
      el.userChatThread.querySelectorAll('.chat-msg-img').forEach((imgEl) => {
        imgEl.addEventListener('click', () => {
          if (el.chatLightboxTitle) el.chatLightboxTitle.textContent = `Support Attachment · ${active.subject}`;
          if (el.chatLightboxImg) el.chatLightboxImg.src = imgEl.src;
          openModal('chatImageLightboxModal');
        });
      });
      el.userChatThread.scrollTop = el.userChatThread.scrollHeight;
      el.userChatReplyForm?.classList.toggle('hidden', active.status === 'closed');
    }
  }

  async function openSupportFlow() {
    if (!state.user) {
      openModal('authModal');
      return;
    }
    openModal('supportModal');
    try {
      const res = await fetch('/api/support/tickets/my', {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        state.supportTickets = data.tickets || [];
        renderUserSupportTickets();
      }
    } catch {
      // ignore
    }
  }

  el.profileSupportBtn?.addEventListener('click', () => {
    closeModal('profileModal');
    openSupportFlow();
  });

  el.newTicketToggleBtn?.addEventListener('click', () => {
    el.newTicketForm?.classList.toggle('hidden');
  });

  el.newTicketForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = el.newTicketSubject.value.trim();
    const text = el.newTicketText.value.trim();
    const imageData = state.pendingNewTicketImg || '';
    if (!subject || (!text && !imageData)) {
      showToast('Enter a subject and either a message or screenshot.', true);
      return;
    }
    try {
      const res = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ subject, text, imageData }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not create ticket.', true);
        return;
      }
      el.newTicketForm.reset();
      clearNewTicketImage();
      el.newTicketForm.classList.add('hidden');
      state.supportTickets.unshift(data.ticket);
      state.activeTicketId = String(data.ticket._id || data.ticket.id);
      renderUserSupportTickets();
      showToast('Support ticket sent!');
    } catch {
      showToast('Failed to send ticket.', true);
    }
  });

  el.userChatReplyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.userChatReplyInput.value.trim();
    const imageData = state.pendingReplyTicketImg || '';
    if ((!text && !imageData) || !state.activeTicketId) return;
    try {
      const res = await fetch(`/api/support/tickets/${state.activeTicketId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ text, imageData }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to send reply.', true);
        return;
      }
      el.userChatReplyInput.value = '';
      clearReplyTicketImage();
      const idx = state.supportTickets.findIndex((t) => String(t._id || t.id) === state.activeTicketId);
      if (idx >= 0) state.supportTickets[idx] = data.ticket;
      renderUserSupportTickets();
    } catch {
      showToast('Network error sending message.', true);
    }
  });

  // ==========================================================================
  // Initial Load (Start Frozen & Audio-Locked Until Login + Card Click)
  // ==========================================================================
  if (urlRefCode && el.regRefCode) {
    el.regRefCode.value = urlRefCode;
  }
  applyRememberedCredentialsToForm();
  updateLastActive();
  updateUserUI();
  loadPublicSettings();
  fetchCurrentUser();
  if (state.token) {
    fetchMyTransactions();
  }
})();
