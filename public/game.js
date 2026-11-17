/* global io */
(() => {
  'use strict';

  const MULTIPLIER_GROWTH_RATE = 0.068;
  const PK_PHONE_REGEX = /^03[0-9]{9}$/;
  const CNIC_REGEX = /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/;

  const PLINKO_TABLES = {
    low: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
    medium: [13.0, 3.0, 1.3, 0.7, 0.4, 0.7, 1.3, 3.0, 13.0],
    high: [29.0, 4.0, 1.5, 0.3, 0.2, 0.3, 1.5, 4.0, 29.0],
  };

  // Persistent LocalStorage & Cookie Session Vault
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

  function readStoredToken() {
    const lsToken = localStorage.getItem('skywing_token') || '';
    const ckToken = getVaultCookie('skywing_token') || '';
    const token = lsToken || ckToken;
    if (token) {
      if (!lsToken) localStorage.setItem('skywing_token', token);
      if (!ckToken) setVaultCookie('skywing_token', token);
    }
    return token;
  }

  function readStoredUserCache() {
    let cached = null;
    try {
      const raw = localStorage.getItem('skywing_user_cache') || getVaultCookie('skywing_user_cache');
      if (raw) cached = JSON.parse(raw);
    } catch {
      cached = null;
    }
    if (cached && typeof cached === 'object') return cached;

    const uid = localStorage.getItem('skywing_user_id') || getVaultCookie('skywing_user_id') || '';
    const uname = localStorage.getItem('skywing_username') || getVaultCookie('skywing_username') || '';
    const phone = localStorage.getItem('skywing_phone') || getVaultCookie('skywing_phone') || '';
    if (uid || uname) {
      return {
        id: uid,
        displayName: uname || phone || 'Player',
        phoneNumber: phone || uname,
        funBalance: Number(localStorage.getItem('skywing_fun_balance') || 0),
        realBalance: Number(localStorage.getItem('skywing_real_balance') || 0),
        totalDeposited: 0,
        totalWithdrawn: 0,
      };
    }
    return null;
  }

  function saveSessionVault(token, user) {
    if (token) {
      localStorage.setItem('skywing_token', token);
      setVaultCookie('skywing_token', token);
      sessionStorage.setItem('skywing_tab_auth', '1');
    }
    if (user && typeof user === 'object') {
      const uid = String(user.id || user._id || '');
      const uname = String(user.displayName || user.phoneNumber || '');
      const phone = String(user.phoneNumber || '');
      if (uid) {
        localStorage.setItem('skywing_user_id', uid);
        setVaultCookie('skywing_user_id', uid);
      }
      if (uname) {
        localStorage.setItem('skywing_username', uname);
        setVaultCookie('skywing_username', uname);
      }
      if (phone) {
        localStorage.setItem('skywing_phone', phone);
        setVaultCookie('skywing_phone', phone);
      }
      localStorage.setItem('skywing_fun_balance', String(Number(user.funBalance ?? 0)));
      localStorage.setItem('skywing_real_balance', String(Number(user.realBalance ?? 0)));
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
        localStorage.setItem('skywing_user_cache', compactCache);
        setVaultCookie('skywing_user_cache', compactCache);
      } catch {
        // ignore serialization quota errors
      }
    }
  }

  function clearSessionVault() {
    localStorage.removeItem('skywing_token');
    localStorage.removeItem('skywing_user_id');
    localStorage.removeItem('skywing_username');
    localStorage.removeItem('skywing_phone');
    localStorage.removeItem('skywing_fun_balance');
    localStorage.removeItem('skywing_real_balance');
    localStorage.removeItem('skywing_user_cache');
    sessionStorage.removeItem('skywing_tab_auth');
    deleteVaultCookie('skywing_token');
    deleteVaultCookie('skywing_user_id');
    deleteVaultCookie('skywing_username');
    deleteVaultCookie('skywing_phone');
    deleteVaultCookie('skywing_user_cache');
  }

  const urlParams = new URLSearchParams(window.location.search);
  const urlRefCode = String(urlParams.get('ref') || '').trim().toUpperCase().slice(0, 16);
  if (urlRefCode) {
    localStorage.setItem('skywing_ref', urlRefCode);
  }

  function getOrCreateDeviceFingerprint() {
    let fp = localStorage.getItem('skywing_device_id');
    if (!fp) {
      const navPart = `${navigator.platform || 'x'}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}`;
      let hash = 2166136261;
      for (let i = 0; i < navPart.length; i++) {
        hash ^= navPart.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const randHex = Math.random().toString(16).slice(2, 10);
      fp = `swfp-${(hash >>> 0).toString(16)}-${randHex}`;
      localStorage.setItem('skywing_device_id', fp);
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
    currencyMode: localStorage.getItem('skywing_mode') === 'real' ? 'real' : 'fun',
    activeGameId: null,
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
        { id: 'skywing-crash', name: 'SkyWing Crash', enabled: true, minBet: 10, maxBet: 100000 },
        { id: 'cyber-plinko', name: 'Cyber Plinko', enabled: true, minBet: 10, maxBet: 50000 },
        { id: 'golden-mines', name: 'Golden Mines', enabled: true, minBet: 10, maxBet: 50000 },
      ],
      audioConfig: {
        bgmEnabled: true,
        soundPreset: 'aviator-jet',
        masterVolume: 75,
      },
    },
    soundEnabled: localStorage.getItem('skywing_sound') !== 'off',
    sidebarTab: 'live', // 'live' | 'mine' | 'wallet'
    transactions: [],
    depositScreenshotData: '',
    qrDepositRef: '',
    deferredInstallPrompt: null,
    supportTickets: [],
    activeTicketId: '',
    pendingNewTicketImg: '',
    pendingReplyTicketImg: '',
    plinkoRisk: 'medium',
    plinkoBusy: false,
    qrRequestSeq: 0,
    qrDebounceTimer: null,
    arcade: {
      plinkoHistory: [],
      minesHistory: [],
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

    // Auth-First Gate, Visual Game Lobby & Active Arena Wrappers
    headerGameControls: document.getElementById('headerGameControls'),
    authEntryGate: document.getElementById('authEntryGate'),
    mainGameShell: document.getElementById('mainGameShell'),
    siteFooter: document.getElementById('siteFooter'),
    gateLoginBtn: document.getElementById('gateLoginBtn'),
    gateRegisterBtn: document.getElementById('gateRegisterBtn'),

    // Maintenance & Operating Hours & Game Lobby
    maintenanceOverlay: document.getElementById('maintenanceOverlay'),
    maintenanceStatusPill: document.getElementById('maintenanceStatusPill'),
    maintenanceTitle: document.getElementById('maintenanceTitle'),
    maintenanceMessage: document.getElementById('maintenanceMessage'),
    helpWithdrawHoursText: document.getElementById('helpWithdrawHoursText'),
    gameLobbySection: document.getElementById('gameLobbySection'),
    gameLobbyBar: document.getElementById('gameLobbyBar'),
    activeGameWorkspace: document.getElementById('activeGameWorkspace'),
    backToLobbyBtn: document.getElementById('backToLobbyBtn'),
    activeArenaTitle: document.getElementById('activeArenaTitle'),
    crashArenaContainer: document.getElementById('crashArenaContainer'),
    plinkoArena: document.getElementById('plinkoArena'),
    minesArena: document.getElementById('minesArena'),

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
    openForgotResetBtn: document.getElementById('openForgotResetBtn'),
    registerForm: document.getElementById('registerForm'),
    regPhone: document.getElementById('regPhone'),
    regName: document.getElementById('regName'),
    regRefCode: document.getElementById('regRefCode'),
    regPassword: document.getElementById('regPassword'),
    regAgeAgreement: document.getElementById('regAgeAgreement'),
    openTermsLink: document.getElementById('openTermsLink'),

    // Forgot Password Self-Reset Modal
    forgotResetForm: document.getElementById('forgotResetForm'),
    forgotResetIdentifier: document.getElementById('forgotResetIdentifier'),
    forgotResetNewPass: document.getElementById('forgotResetNewPass'),
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

    // Deposit Modal (Privacy-Masked Dynamic QR)
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
    depQrGatewayBadge: document.getElementById('depQrGatewayBadge'),
    depQrAmountBadge: document.getElementById('depQrAmountBadge'),
    depQrRefBadge: document.getElementById('depQrRefBadge'),
    depQrImg: document.getElementById('depQrImg'),
    depQrPlaceholder: document.getElementById('depQrPlaceholder'),
    depQrLoadingText: document.getElementById('depQrLoadingText'),
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

  el.soundToggleBtn?.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('skywing_sound', state.soundEnabled ? 'on' : 'off');
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
    localStorage.setItem('skywing_mode', state.currencyMode);
    updateModeAndWalletUI();
    updatePanelButtons();
    renderSidebar();
  }

  function updateModeAndWalletUI() {
    const isReal = state.currencyMode === 'real';
    el.modeFunBtn.className = `mode-btn ${!isReal ? 'active-fun' : ''}`;
    el.modeRealBtn.className = `mode-btn ${isReal ? 'active-real' : ''}`;

    el.realWalletActions?.classList.toggle('hidden', !isReal);

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
  // Public Settings, Maintenance Lock, Operating Hours, Audio & Multi-Game UI
  // ==========================================================================
  function getEffectiveAudioConfig(serverCfg) {
    const base = serverCfg || state.publicSettings.audioConfig || { bgmEnabled: true, soundPreset: 'aviator-jet', masterVolume: 75 };
    try {
      const savedRaw = localStorage.getItem('skywing_player_audio');
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
  };

  function syncGameWorkspaceView() {
    const isAuthed = Boolean(state.user);
    const hasActiveGame = Boolean(isAuthed && state.activeGameId);

    el.gameLobbySection?.classList.toggle('hidden', !isAuthed || hasActiveGame);
    el.activeGameWorkspace?.classList.toggle('hidden', !hasActiveGame);

    if (!hasActiveGame) {
      stopCrashRenderLoop();
      audio.setLocked(true);
    } else if (el.activeArenaTitle) {
      el.activeArenaTitle.textContent = GAME_LABELS[state.activeGameId] || 'Game Arena';
    }
  }

  function returnToGameLobby() {
    state.activeGameId = null;
    stopCrashRenderLoop();
    audio.setLocked(true);
    syncGamesLobbyUI();
    syncGameWorkspaceView();
  }

  function syncGamesLobbyUI() {
    const games = state.publicSettings.gamesConfig || [];
    if (!el.gameLobbyBar) return;
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
    });

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
    const games = state.publicSettings.gamesConfig || [];
    const cfg = games.find((g) => g.id === gameId);
    if (cfg && cfg.enabled === false) {
      showToast(`${cfg.name} is currently disabled by Admin.`, true);
      return;
    }

    state.activeGameId = gameId;
    el.crashArenaContainer?.classList.toggle('hidden', gameId !== 'skywing-crash');
    el.plinkoArena?.classList.toggle('hidden', gameId !== 'cyber-plinko');
    el.minesArena?.classList.toggle('hidden', gameId !== 'golden-mines');

    // Unlock audio engine only once user enters an active game arena
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
      }
    }
  }

  el.gameLobbyBar?.querySelectorAll('.game-lobby-card').forEach((card) => {
    card.addEventListener('click', () => {
      switchActiveGame(card.dataset.game);
    });
  });

  el.backToLobbyBtn?.addEventListener('click', () => {
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
        subtitle: 'Verified · QR Only',
      });
    }
    if (acc.jazzcash?.enabled) {
      cards.push({
        meta: getGatewayBrandMeta('JazzCash'),
        label: 'JazzCash',
        subtitle: 'Verified · QR Only',
      });
    }
    if (acc.bank?.enabled) {
      cards.push({
        meta: getGatewayBrandMeta('Bank Account'),
        label: 'E-Wallet / Bank Transfer',
        subtitle: acc.bank.bankName ? `${acc.bank.bankName} · QR Only` : 'Verified · QR Only',
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

  async function computeSha256HexBrowser(text) {
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
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

  function openAuthModal(defaultTab = 'login') {
    if (el.authErrorBox) el.authErrorBox.classList.add('hidden');
    const savedRef = localStorage.getItem('skywing_ref') || '';
    if (savedRef && el.regRefCode && !el.regRefCode.value) {
      el.regRefCode.value = savedRef;
    }
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
      el.authTriggerBtn.textContent = displayName;
      el.authTriggerBtn.classList.remove('btn-primary');
      el.authTriggerBtn.classList.add('btn-secondary');
      if (el.userAccountLabel) {
        el.userAccountLabel.textContent = displayName;
      }

      if (el.profileAvatarInitial) {
        el.profileAvatarInitial.textContent = String(displayName || 'S').trim().charAt(0).toUpperCase() || 'S';
      }
      el.profilePhone.textContent = state.user.phoneNumber;
      el.profileName.textContent = state.user.displayName;
      el.profileFunBalance.textContent = fmtMoney(state.user.funBalance, 'fun');
      el.profileRealBalance.textContent = fmtMoney(state.user.realBalance, 'real');
      el.profileDeposited.textContent = fmtMoney(state.user.totalDeposited, 'real');
      el.profileWithdrawn.textContent = fmtMoney(state.user.totalWithdrawn, 'real');
      if (el.profileRefEarnings) {
        el.profileRefEarnings.textContent = fmtMoney(state.user.referralEarnings || 0, 'real');
      }
      if (el.profileRefCode) {
        el.profileRefCode.textContent = state.user.referralCode || '---';
      }
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
      el.withdrawAvailBalance.textContent = fmtMoney(state.user.realBalance, 'real');
      renderSavedPayouts();
    } else {
      state.activeGameId = null;
      el.authTriggerBtn.textContent = 'Log In / Join';
      el.authTriggerBtn.classList.remove('btn-secondary');
      el.authTriggerBtn.classList.add('btn-primary');
      if (el.userAccountLabel) {
        el.userAccountLabel.textContent = 'Guest';
      }
    }

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

  el.authTabRegister.addEventListener('click', () => {
    el.authTabRegister.classList.add('active');
    el.authTabLogin.classList.remove('active');
    el.registerForm.classList.remove('hidden');
    el.loginForm.classList.add('hidden');
    el.authErrorBox.classList.add('hidden');
    const savedRef = localStorage.getItem('skywing_ref') || '';
    if (savedRef && el.regRefCode && !el.regRefCode.value) {
      el.regRefCode.value = savedRef;
    }
  });

  el.openTermsLink?.addEventListener('click', (e) => {
    e.preventDefault();
    openModal('termsModal');
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
        headers: {
          'Content-Type': 'application/json',
          'x-device-fingerprint': DEVICE_FINGERPRINT,
        },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          password: el.loginPassword.value,
          deviceFingerprint: DEVICE_FINGERPRINT,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthError(data.error || 'Login failed.');
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
          localStorage.setItem('skywing_admin_token', data.adminToken);
          closeModal('authModal');
          showToast('Admin authenticated — opening Operations Console...');
          setTimeout(() => {
            window.location.href = data.redirectUrl || '/admin';
          }, 350);
          return;
        }
      }
      state.token = data.token;
      state.user = data.user;
      state.activeGameId = null;
      saveSessionVault(state.token, state.user);
      socket.emit('auth:identify', { token: state.token });
      closeModal('authModal');
      closeModal('forgotPasswordModal');
      closeModal('termsModal');
      updateUserUI();
      fetchMyTransactions();
      showToast(`Welcome back, ${state.user.displayName}!`);
    } catch {
      showAuthError('Network error. Please try again.');
    }
  });

  el.registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.authErrorBox.classList.add('hidden');
    if (!el.regAgeAgreement?.checked) {
      const msg = 'You must confirm you are 18+ and accept the User Agreement to register.';
      showAuthError(msg);
      showToast(msg, true);
      return;
    }
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
        headers: {
          'Content-Type': 'application/json',
          'x-device-fingerprint': DEVICE_FINGERPRINT,
        },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          displayName: el.regName.value,
          referralCode: String(el.regRefCode?.value || '').trim().toUpperCase(),
          password: el.regPassword.value,
          acceptedTerms: true,
          deviceFingerprint: DEVICE_FINGERPRINT,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthError(data.error || 'Registration failed.');
        return;
      }
      state.token = data.token;
      state.user = data.user;
      state.activeGameId = null;
      saveSessionVault(state.token, state.user);
      socket.emit('auth:identify', { token: state.token });
      closeModal('authModal');
      closeModal('forgotPasswordModal');
      closeModal('termsModal');
      updateUserUI();
      fetchMyTransactions();
      if (state.user.bonusRestricted) {
        showToast('Account created (Bonus privileges restricted due to multi-device match).');
      } else {
        showToast(`Account created! Welcome to SkyWing, ${state.user.displayName}.`);
      }
    } catch {
      showAuthError('Network error. Please try again.');
    }
  });

  el.openForgotResetBtn?.addEventListener('click', () => {
    if (el.forgotResetIdentifier && el.loginPhone?.value) {
      el.forgotResetIdentifier.value = el.loginPhone.value.trim();
    }
    el.forgotResetError?.classList.add('hidden');
    el.forgotResetSuccess?.classList.add('hidden');
    closeModal('authModal');
    openModal('forgotPasswordModal');
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

    if (!isCnic && !isPhone) {
      el.forgotResetError.textContent =
        'Enter a valid 11-digit 03XX mobile number or Pakistani CNIC (XXXXX-XXXXXXX-X).';
      el.forgotResetError.classList.remove('hidden');
      return;
    }

    const newPassword = el.forgotResetNewPass.value;
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: isCnic ? rawInput : normalizedPhone,
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.forgotResetError.textContent = data.error || 'Password reset failed.';
        el.forgotResetError.classList.remove('hidden');
        return;
      }
      el.forgotResetSuccess.textContent = data.message || 'Password reset successfully! You can now log in.';
      el.forgotResetSuccess.classList.remove('hidden');
      el.forgotResetForm.reset();
      showToast('Password updated! Please log in.');
    } catch {
      el.forgotResetError.textContent = 'Network error. Please try again.';
      el.forgotResetError.classList.remove('hidden');
    }
  });

  function performLogout() {
    state.token = '';
    state.user = null;
    state.activeGameId = null;
    state.transactions = [];
    stopCrashRenderLoop();
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
    if (el.depQrImg) {
      el.depQrImg.classList.add('hidden');
      el.depQrImg.removeAttribute('src');
    }
    if (el.depQrPlaceholder) el.depQrPlaceholder.classList.remove('hidden');
    if (el.depQrLoadingText) el.depQrLoadingText.textContent = message;
    if (clearRef && el.depQrRefBadge) el.depQrRefBadge.textContent = 'REF: ---';
  }

  async function requestDynamicDepositQr() {
    if (!state.token || !state.user) return;
    const method = el.depMethod?.value || 'EasyPaisa';
    const amount = Number(el.depAmount?.value || 0);
    const minDep = Number(state.publicSettings.financialLimits?.minDeposit || 50);
    const meta = getGatewayBrandMeta(method);

    if (el.depQrGatewayBadge) el.depQrGatewayBadge.textContent = `${meta.name} · QR Only`;
    if (el.depQrAmountBadge) {
      el.depQrAmountBadge.textContent = Number.isFinite(amount) && amount > 0 ? `${amount.toLocaleString()} PKR` : '0 PKR';
    }

    if (!Number.isFinite(amount) || amount < minDep || amount > 1000000) {
      setQrLoadingState(`Enter at least ${minDep} PKR to generate your live QR code.`);
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

      state.qrDepositRef = data.qrReference;
      if (el.depQrImg) {
        el.depQrImg.src = data.qrDataUrl;
        el.depQrImg.classList.remove('hidden');
      }
      if (el.depQrPlaceholder) el.depQrPlaceholder.classList.add('hidden');
      if (el.depQrRefBadge) el.depQrRefBadge.textContent = `REF: ${data.qrReference}`;
      if (el.depQrGatewayBadge) el.depQrGatewayBadge.textContent = `${meta.name} · QR Only`;
      if (el.depQrAmountBadge) el.depQrAmountBadge.textContent = `${Number(data.amount).toLocaleString()} PKR`;
      if (el.depMicroHint) {
        const isMicro = data.microAutoApproveLimit > 0 && amount <= data.microAutoApproveLimit;
        el.depMicroHint.textContent = isMicro
          ? `Micro-Deposit Eligible! Enter your valid TID (6+ chars) for instant auto-approval.`
          : `Standard Review: Admin will approve shortly after verifying your TID / screenshot.`;
      }
    } catch {
      if (seq === state.qrRequestSeq) {
        setQrLoadingState('Network error generating QR code. Retrying on edit...');
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
    if (el.depSenderName && !el.depSenderName.value && state.user.displayName) {
      el.depSenderName.value = state.user.displayName;
    }
    if (el.depSenderNumber && !el.depSenderNumber.value && state.user.phoneNumber) {
      el.depSenderNumber.value = state.user.phoneNumber;
    }
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
      if (el.depSenderName && state.user?.displayName) el.depSenderName.value = state.user.displayName;
      if (el.depSenderNumber && state.user?.phoneNumber) el.depSenderNumber.value = state.user.phoneNumber;
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

      if (gid === 'cyber-plinko') {
        const feed = (state.arcade.plinkoHistory || []).slice(0, 25);
        const totalWager = feed.reduce((s, x) => s + Number(x.amount || 0), 0);
        el.activeBetsCount.textContent = `${feed.length} Recent Drops`;
        el.totalRoundWager.textContent = `${totalWager.toFixed(0)} Vol`;
        if (!feed.length) {
          el.sidebarBetsList.innerHTML =
            '<div class="empty-state">No Cyber Plinko drops yet. Drop a ball!</div>';
          return;
        }
        el.sidebarBetsList.innerHTML = feed
          .map((item) => {
            const u = item.currencyMode === 'real' ? 'PKR' : 'FC';
            const won = Number(item.payout || 0) >= Number(item.amount || 0);
            const winText = Number(item.payout || 0) > 0 ? `+${Number(item.payout).toFixed(2)}` : '0.00';
            return `
              <div class="bet-row ${won ? 'won' : ''}">
                <span class="bet-player">${escapeHtml(item.player || 'Player')}</span>
                <span class="tabular-nums">${Number(item.amount || 0).toFixed(0)} ${u}</span>
                <span class="bet-mult tabular-nums">${Number(item.multiplier || 0).toFixed(1)}x</span>
                <span class="bet-payout tabular-nums">${winText}</span>
              </div>
            `;
          })
          .join('');
        return;
      }

      if (gid === 'golden-mines') {
        const feed = (state.arcade.minesHistory || []).slice(0, 25);
        const totalWager = feed.reduce((s, x) => s + Number(x.amount || 0), 0);
        el.activeBetsCount.textContent = `${feed.length} Recent Games`;
        el.totalRoundWager.textContent = `${totalWager.toFixed(0)} Vol`;
        if (!feed.length) {
          el.sidebarBetsList.innerHTML =
            '<div class="empty-state">No Golden Mines games yet. Reveal diamonds!</div>';
          return;
        }
        el.sidebarBetsList.innerHTML = feed
          .map((item) => {
            const u = item.currencyMode === 'real' ? 'PKR' : 'FC';
            const won = !item.boom && Number(item.payout || 0) > 0;
            const multText = item.boom ? 'Boom' : `${Number(item.multiplier || 0).toFixed(2)}x`;
            const winText = won ? `+${Number(item.payout).toFixed(2)}` : '-';
            return `
              <div class="bet-row ${won ? 'won' : ''}">
                <span class="bet-player">${escapeHtml(item.player || 'Player')}</span>
                <span class="tabular-nums">${Number(item.amount || 0).toFixed(0)} ${u}</span>
                <span class="bet-mult tabular-nums">${multText}</span>
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
        const emptyMsg =
          gid === 'cyber-plinko'
            ? 'You have not played Cyber Plinko yet.'
            : gid === 'golden-mines'
              ? 'You have not played Golden Mines yet.'
              : 'You have not placed any SkyWing Crash bets yet.';
        el.sidebarBetsList.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
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
          } else {
            multText = h.cashoutMultiplier
              ? `${Number(h.cashoutMultiplier).toFixed(2)}x`
              : `Crash ${Number(h.crashedAt || 1).toFixed(2)}x`;
          }
          const payoutText = won
            ? `+${Number(h.payout).toFixed(2)}`
            : `-${Number(h.betAmount).toFixed(2)}`;
          return `
            <div class="bet-row ${won ? 'won' : ''}">
              <span class="bet-player">#${h.roundNumber || '-'}</span>
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
          if (data.multiplier >= 1.5) audio.playCashout();
          showToast(`Plinko landed ${data.multiplier}x → Payout ${fmtMoney(data.payout, data.currencyMode)}`);
          state.plinkoBusy = false;
          el.plinkoDropBtn.disabled = false;
          return;
        }
        colOffset += data.path[stepIdx] === 1 ? 0.5 : -0.5;
        const bx = w / 2 + colOffset * pegSpacing;
        const by = topY + stepIdx * rowGap + 12;
        renderPlinkoBoard({ x: bx, y: by });
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
      audio.playCasinoChime();
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
        audio.playCrash();
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
        audio.playCashout();
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
        audio.playCasinoChime();
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
      audio.playCashout();
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
  // VIP Loyalty Tiers, Rewards & Referral Copy / Share & Earn
  // ==========================================================================
  function getReferralShareUrl() {
    const code = state.user?.referralCode || '';
    return `${window.location.origin}/?ref=${encodeURIComponent(code)}`;
  }

  async function shareOrCopyReferralLink(triggerBtn = null) {
    if (!state.user?.referralCode) {
      openAuthModal('register');
      return;
    }
    const shareUrl = getReferralShareUrl();
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'SkyWing Arena — Play & Earn Commission',
          text: 'Join me on SkyWing Crash, Cyber Plinko & Golden Mines! Register with my link for welcome credits:',
          url: shareUrl,
        });
        showToast('Referral link shared! Earn up to 15% commission on deposits.');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (triggerBtn) {
        const span = triggerBtn.querySelector('span');
        if (span) {
          const prev = span.textContent;
          span.textContent = 'Copied!';
          setTimeout(() => {
            span.textContent = prev;
          }, 1600);
        }
      }
      showToast('Referral link copied! Share & earn up to 15% commission.');
    } catch {
      showToast(`Share your link: ${shareUrl}`);
    }
  }

  el.shareHeaderBtn?.addEventListener('click', () => shareOrCopyReferralLink(el.shareHeaderBtn));
  el.drawerShareBtn?.addEventListener('click', () => shareOrCopyReferralLink(el.drawerShareBtn));

  el.profileCopyRefBtn?.addEventListener('click', () => {
    if (!state.user?.referralCode) return;
    copyValueWithButton(el.profileCopyRefBtn, getReferralShareUrl(), 'Copied!');
  });

  el.copyReferralLinkBtn?.addEventListener('click', () => {
    if (!state.user?.referralCode) return;
    copyValueWithButton(el.copyReferralLinkBtn, getReferralShareUrl(), 'Copied!');
  });

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
    localStorage.setItem('skywing_player_audio', JSON.stringify(cfg));
    if (el.playerAudioBgmLabel) el.playerAudioBgmLabel.textContent = cfg.bgmEnabled ? 'ON' : 'OFF';
    if (el.playerAudioVolVal) el.playerAudioVolVal.textContent = `${cfg.masterVolume}%`;
    audio.setConfig(cfg, state.soundEnabled);
    if (!cfg.bgmEnabled) audio.stopBGM();
  }

  el.playerAudioBgm?.addEventListener('change', saveAndApplyLocalAudio);
  el.playerAudioPreset?.addEventListener('change', saveAndApplyLocalAudio);
  el.playerAudioVolume?.addEventListener('input', saveAndApplyLocalAudio);
  el.playerAudioResetBtn?.addEventListener('click', () => {
    localStorage.removeItem('skywing_player_audio');
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
  updateUserUI();
  loadPublicSettings();
  fetchCurrentUser();
  if (state.token) {
    fetchMyTransactions();
  }
})();
