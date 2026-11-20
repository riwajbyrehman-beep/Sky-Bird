import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import QRCode from 'qrcode';

import User from './models/User.js';
import Settings from './models/Settings.js';
import Transaction from './models/Transaction.js';
import SupportTicket from './models/SupportTicket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = (process.env.MONGODB_URI || '')
  .trim()
  .replace(/^["']|["']$/g, '');
const JWT_SECRET = process.env.JWT_SECRET || 'skywing_crash_dev_secret_change_me';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '66442211';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '11224466';
const DEFAULT_MASTER_PASSWORD = process.env.DEFAULT_MASTER_PASSWORD || 'Rehman@1256';
const CNIC_REGEX = /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/;
const INACTIVITY_LIMIT_MS = 3 * 24 * 60 * 60 * 1000;
const TURNSTILE_SITE_KEY = String(process.env.TURNSTILE_SITE_KEY || '').trim();
const TURNSTILE_SECRET_KEY = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
const RESET_CHALLENGE_SECRET = JWT_SECRET;
const resetRateMap = new Map();
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const ENV_LIVE_SYNC_URL = String(process.env.LIVE_SYNC_URL || '').trim().replace(/\/+$/, '');
const LIVE_SYNC_POLL_MS = Math.min(2000, Math.max(150, Number(process.env.LIVE_SYNC_POLL_MS) || 250));

const MULTIPLIER_GROWTH_RATE = 0.068;
const BETTING_DURATION_MS = 5000;
const CRASH_HOLD_MS = 2200;
const TICK_INTERVAL_MS = 50;

// ============================================================================
// Database Abstraction (MongoDB Atlas via Mongoose + Local JSON Fallback)
// ============================================================================
let useMongo = false;
let lastMongoError = '';
let mongoListenersAttached = false;
let mongoRetryTimer = null;
const LOCAL_DB_PATH = path.join(__dirname, 'data', 'local-db.json');

function isMongoReady() {
  return useMongo && mongoose.connection.readyState === 1;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizePakIban(raw = '') {
  return String(raw || '')
    .replace(/[\s\-_]+/g, '')
    .toUpperCase()
    .slice(0, 34);
}

function defaultPaymentAccounts() {
  return {
    easypaisa: {
      enabled: true,
      accountTitle: 'SkyWing Official',
      accountNumber: '03451234567',
      iban: '',
    },
    jazzcash: {
      enabled: true,
      accountTitle: 'SkyWing Official',
      accountNumber: '03001234567',
      iban: '',
    },
    bank: {
      enabled: true,
      bankName: 'Meezan Bank',
      accountTitle: 'SkyWing Enterprises',
      accountNumber: 'PK36MEZN0000000123456789',
    },
  };
}

const ALLOWED_SOUND_PRESETS = [
  'aviator-jet',
  'cyber-flight',
  'casino-chime',
  'turbo-arcade',
  'stealth-minimal',
];

const ALLOWED_PROFIT_MODES = ['balanced', 'house-edge', 'low-crash', 'generous'];

function defaultAudioConfig() {
  return {
    bgmEnabled: true,
    soundPreset: 'aviator-jet',
    masterVolume: 75,
  };
}

function defaultProfitControl() {
  return {
    mode: 'balanced',
    houseEdgePct: 4,
    maxCrashCap: 100,
  };
}

function defaultFinancialLimits() {
  return {
    minDeposit: 50,
    minWithdrawal: 100,
    withdrawalFeePct: 0,
    microDepositAutoApproveLimit: 1000,
  };
}

function defaultWithdrawalHours() {
  return {
    enabled: false,
    openTime: '09:00',
    closeTime: '17:00',
    noticeText: 'Withdrawals are only open from 9:00 AM to 5:00 PM.',
  };
}

function defaultPlatformStatus() {
  return {
    mode: 'active',
    message:
      'SkyWing Crash is currently undergoing scheduled maintenance. Your wallet & bets are safe. Back shortly!',
  };
}

function defaultRtpRiskConfig() {
  return {
    autoAdjustEnabled: true,
    targetRtpPct: 96,
    dynamicEdgeOffset: 0,
    currentRiskIndex: 15,
    lastEvaluatedAt: null,
  };
}

function defaultGamesConfig() {
  return [
    {
      id: 'skywing-crash',
      name: 'SkyWing Crash',
      tagline: 'Live Multiplayer Flying Bird',
      enabled: true,
      houseEdgePct: 4,
      minBet: 1,
      maxBet: 100000,
    },
    {
      id: 'cyber-plinko',
      name: 'Cyber Plinko',
      tagline: '8-Row Neon Peg Multiplier Drop',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'golden-mines',
      name: 'Golden Mines',
      tagline: '5x5 Cyber Grid Treasure Hunt',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'cyber-dice',
      name: 'Cyber Dice',
      tagline: 'Provably Fair Roll Over / Under',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'cyber-limbo',
      name: 'Limbo X',
      tagline: 'Target Any Multiplier Up To 100x',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'neon-flip',
      name: 'Neon Coin Flip',
      tagline: 'Heads or Tails Cyber Vault Duel',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'lucky-wheel',
      name: 'Lucky Wheel',
      tagline: '12-Segment Prize Spin Up To 10x',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'dragon-hilo',
      name: 'Dragon Hi-Lo',
      tagline: 'Card Rank & Suit Duel Multiplier',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
    {
      id: 'emerald-slots',
      name: 'Emerald 777 Slots',
      tagline: '3-Reel Cyber Gem Jackpot Spin',
      enabled: true,
      houseEdgePct: 4,
      minBet: 10,
      maxBet: 50000,
    },
  ];
}

function hydrateGamesConfig(rawList) {
  const defaults = defaultGamesConfig();
  if (!Array.isArray(rawList) || rawList.length === 0) return defaults;
  return defaults.map((def) => {
    const match = rawList.find((g) => g && g.id === def.id);
    return match ? { ...def, ...match } : def;
  });
}

function defaultSecurityConfig() {
  return {
    masterPasswordHash: '',
    totpEnabled: false,
    totpSecret: '',
    securityLogs: [],
  };
}

function defaultTelegramBotConfig() {
  return {
    enabled: false,
    botToken: '',
    adminChatId: '',
    webhookSecret: '',
  };
}

function defaultSyncConfig() {
  return {
    mode: 'auto',
    remoteLiveUrl: ENV_LIVE_SYNC_URL || '',
    updatedAt: null,
  };
}

function defaultLiveRoundSnapshot() {
  return {
    masterId: '',
    leaseExpiresAt: null,
    roundNumber: 1001,
    currentRoundId: 1001,
    phase: 'BETTING',
    bettingEndsAt: 0,
    flightStartedAt: 0,
    crashedAt: 0,
    crashHoldEndsAt: 0,
    currentMultiplier: 1.0,
    scheduledCrashPoint: 2.0,
    serverSeed: '',
    serverSeedHash: '',
    clientSeed: '',
    nonce: 1001,
    bets: [],
    updatedAt: null,
  };
}

function defaultPoolStatsByGame() {
  return {
    crash: { bets: 0, payouts: 0, netDelta: 0 },
    plinko: { bets: 0, payouts: 0, netDelta: 0 },
    mines: { bets: 0, payouts: 0, netDelta: 0 },
    dice: { bets: 0, payouts: 0, netDelta: 0 },
    limbo: { bets: 0, payouts: 0, netDelta: 0 },
    coinflip: { bets: 0, payouts: 0, netDelta: 0 },
    wheel: { bets: 0, payouts: 0, netDelta: 0 },
    hilo: { bets: 0, payouts: 0, netDelta: 0 },
    slots: { bets: 0, payouts: 0, netDelta: 0 },
  };
}

function hydratePoolStatsByGame(raw = {}) {
  const def = defaultPoolStatsByGame();
  return {
    crash: { ...def.crash, ...(raw.crash || {}) },
    plinko: { ...def.plinko, ...(raw.plinko || {}) },
    mines: { ...def.mines, ...(raw.mines || {}) },
    dice: { ...def.dice, ...(raw.dice || {}) },
    limbo: { ...def.limbo, ...(raw.limbo || {}) },
    coinflip: { ...def.coinflip, ...(raw.coinflip || {}) },
    wheel: { ...def.wheel, ...(raw.wheel || {}) },
    hilo: { ...def.hilo, ...(raw.hilo || {}) },
    slots: { ...def.slots, ...(raw.slots || {}) },
  };
}

function defaultSettingsObj() {
  return {
    key: 'global',
    whatsappSupportEnabled: true,
    whatsappSupportNumber: '923001234567',
    whatsappChannelEnabled: true,
    whatsappChannelUrl: 'https://whatsapp.com/channel/0029VaSkyWingOfficial',
    telegramChannelEnabled: true,
    telegramChannelUrl: 'https://t.me/SkyWingOfficial',
    maskMasterAccounts: true,
    settingsUpdatedAt: null,
    paymentAccounts: defaultPaymentAccounts(),
    financialLimits: defaultFinancialLimits(),
    withdrawalHours: defaultWithdrawalHours(),
    platformStatus: defaultPlatformStatus(),
    audioConfig: defaultAudioConfig(),
    profitControl: defaultProfitControl(),
    profitDistributionPool: 10000,
    rtpRiskConfig: defaultRtpRiskConfig(),
    gamesConfig: defaultGamesConfig(),
    security: defaultSecurityConfig(),
    telegramBot: defaultTelegramBotConfig(),
    dailyProfitTarget: 30000,
    varianceTolerancePct: 8,
    welcomeBonusCredits: 1000,
    dailyDateKey: getTodayKey(),
    dailyTotalBets: 0,
    dailyTotalPayouts: 0,
    dailyNetProfit: 0,
    carryForwardPool: 10000,
    poolStatsByGame: defaultPoolStatsByGame(),
    roundCounter: 1000,
    recentRounds: [],
    syncConfig: defaultSyncConfig(),
    liveRound: defaultLiveRoundSnapshot(),
  };
}

function hydrateSettingsObj(raw = {}) {
  const defPay = defaultPaymentAccounts();
  const unifiedPool =
    raw.profitDistributionPool !== undefined
      ? Math.max(0, Number(raw.profitDistributionPool) || 0)
      : raw.carryForwardPool !== undefined
        ? Math.max(0, Number(raw.carryForwardPool) || 0)
        : 10000;
  return {
    ...defaultSettingsObj(),
    ...raw,
    profitDistributionPool: unifiedPool,
    carryForwardPool: unifiedPool,
    poolStatsByGame: hydratePoolStatsByGame(raw.poolStatsByGame),
    paymentAccounts: {
      easypaisa: {
        ...defPay.easypaisa,
        ...(raw.paymentAccounts?.easypaisa || {}),
      },
      jazzcash: {
        ...defPay.jazzcash,
        ...(raw.paymentAccounts?.jazzcash || {}),
      },
      bank: {
        ...defPay.bank,
        ...(raw.paymentAccounts?.bank || {}),
      },
    },
    financialLimits: {
      ...defaultFinancialLimits(),
      ...(raw.financialLimits || {}),
    },
    withdrawalHours: {
      ...defaultWithdrawalHours(),
      ...(raw.withdrawalHours || {}),
    },
    platformStatus: {
      ...defaultPlatformStatus(),
      ...(raw.platformStatus || {}),
    },
    audioConfig: {
      ...defaultAudioConfig(),
      ...(raw.audioConfig || {}),
    },
    profitControl: {
      ...defaultProfitControl(),
      ...(raw.profitControl || {}),
    },
    rtpRiskConfig: {
      ...defaultRtpRiskConfig(),
      ...(raw.rtpRiskConfig || {}),
    },
    gamesConfig: hydrateGamesConfig(raw.gamesConfig),
    security: {
      ...defaultSecurityConfig(),
      ...(raw.security || {}),
    },
    telegramBot: {
      ...defaultTelegramBotConfig(),
      ...(raw.telegramBot || {}),
    },
    syncConfig: {
      ...defaultSyncConfig(),
      ...(raw.syncConfig || {}),
      remoteLiveUrl:
        String(raw.syncConfig?.remoteLiveUrl || ENV_LIVE_SYNC_URL || '')
          .trim()
          .replace(/\/+$/, ''),
    },
    liveRound: {
      ...defaultLiveRoundSnapshot(),
      ...(raw.liveRound || {}),
    },
  };
}

let localStore = {
  users: [],
  transactions: [],
  supportTickets: [],
  settings: defaultSettingsObj(),
};

function loadLocalStore() {
  try {
    fs.mkdirSync(path.dirname(LOCAL_DB_PATH), { recursive: true });
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      localStore = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        supportTickets: Array.isArray(parsed.supportTickets) ? parsed.supportTickets : [],
        settings: hydrateSettingsObj(parsed.settings || {}),
      };
    } else {
      saveLocalStore();
    }
  } catch (err) {
    console.warn('[LocalDB] Load warning:', err.message);
  }
}

function saveLocalStore() {
  try {
    fs.mkdirSync(path.dirname(LOCAL_DB_PATH), { recursive: true });
    const tmpPath = `${LOCAL_DB_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(localStore, null, 2), 'utf8');
    fs.renameSync(tmpPath, LOCAL_DB_PATH);
  } catch (err) {
    console.warn('[LocalDB] Save warning:', err.message);
  }
}

const PERSISTENT_CONFIG_KEYS = [
  'whatsappSupportEnabled',
  'whatsappSupportNumber',
  'whatsappChannelEnabled',
  'whatsappChannelUrl',
  'telegramChannelEnabled',
  'telegramChannelUrl',
  'maskMasterAccounts',
  'paymentAccounts',
  'financialLimits',
  'withdrawalHours',
  'platformStatus',
  'audioConfig',
  'profitControl',
  'profitDistributionPool',
  'carryForwardPool',
  'rtpRiskConfig',
  'gamesConfig',
  'security',
  'telegramBot',
  'syncConfig',
  'dailyProfitTarget',
  'varianceTolerancePct',
  'welcomeBonusCredits',
];

function extractPersistentConfigPatch(settingsObj) {
  const hydrated = hydrateSettingsObj(settingsObj || {});
  const out = {};
  for (const k of PERSISTENT_CONFIG_KEYS) {
    out[k] = hydrated[k];
  }
  out.settingsUpdatedAt = hydrated.settingsUpdatedAt || new Date();
  return out;
}

async function reconcileSettingsWithMongo() {
  if (!isMongoReady()) return;
  try {
    let doc = await Settings.findOne({ key: 'global' });
    const localHydrated = hydrateSettingsObj(localStore.settings || {});
    const localTs = localHydrated.settingsUpdatedAt
      ? new Date(localHydrated.settingsUpdatedAt).getTime()
      : 0;

    if (!doc) {
      const seed = { ...localHydrated, key: 'global' };
      delete seed._id;
      delete seed.__v;
      doc = await Settings.create(seed);
      localStore.settings = hydrateSettingsObj(doc.toObject());
      saveLocalStore();
      return;
    }

    const mongoObj = hydrateSettingsObj(doc.toObject());
    const mongoTs = mongoObj.settingsUpdatedAt
      ? new Date(mongoObj.settingsUpdatedAt).getTime()
      : 0;

    if (localTs > mongoTs) {
      const pushPatch = extractPersistentConfigPatch(localHydrated);
      const updated = await Settings.findOneAndUpdate(
        { key: 'global' },
        { $set: pushPatch },
        { new: true }
      );
      if (updated) {
        localStore.settings = hydrateSettingsObj(updated.toObject());
        saveLocalStore();
      }
    } else {
      localStore.settings = mongoObj;
      saveLocalStore();
    }
  } catch (err) {
    console.warn('[Settings Reconcile Warning]', err.message);
  }
}

function scheduleMongoRetry() {
  if (mongoRetryTimer || !MONGODB_URI) return;
  mongoRetryTimer = setTimeout(async () => {
    mongoRetryTimer = null;
    if (mongoose.connection.readyState === 1) return;
    await attemptMongoConnect(true);
  }, 30000);
}

async function attemptMongoConnect(isRetry = false) {
  try {
    const connectOpts = {
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4,
    };
    await mongoose.connect(MONGODB_URI, connectOpts);
    useMongo = true;
    lastMongoError = '';
    await User.init();
    await Settings.init();
    await Transaction.init();
    await SupportTicket.init();
    await reconcileSettingsWithMongo();
    console.log('[MongoDB] Connected to MongoDB Atlas (settings synced)');
  } catch (err) {
    useMongo = false;
    lastMongoError = err?.message || 'Unable to reach MongoDB Atlas';
    if (!isRetry) {
      console.warn(
        '[MongoDB] Could not connect to Atlas right now (check Network Access IP whitelist 0.0.0.0/0 and MONGODB_URI). Running on persistent local JSON store and retrying in background.'
      );
      loadLocalStore();
    }
    scheduleMongoRetry();
  }
}

async function connectDatabase() {
  // Always hydrate persistent local store first so offline/saved settings are never lost
  loadLocalStore();

  if (!MONGODB_URI) {
    console.warn(
      '[DB] MONGODB_URI is not set. Running with persistent local JSON store (./data/local-db.json). Set MONGODB_URI in environment to use MongoDB Atlas.'
    );
    useMongo = false;
    return;
  }

  if (!mongoListenersAttached) {
    mongoListenersAttached = true;

    mongoose.connection.on('connected', () => {
      useMongo = true;
      lastMongoError = '';
    });

    mongoose.connection.on('error', (err) => {
      lastMongoError = err?.message || 'MongoDB socket error';
      useMongo = false;
    });

    mongoose.connection.on('disconnected', () => {
      if (useMongo) {
        console.warn('[MongoDB] Disconnected. Falling back to local store while reconnecting...');
      }
      useMongo = false;
      loadLocalStore();
      scheduleMongoRetry();
    });

    mongoose.connection.on('reconnected', () => {
      console.log('[MongoDB] Reconnected successfully');
      useMongo = true;
      lastMongoError = '';
      reconcileSettingsWithMongo().catch(() => {});
    });
  }

  await attemptMongoConnect(false);
}

const db = {
  async getSettings() {
    if (isMongoReady()) {
      let doc = await Settings.findOne({ key: 'global' });
      if (!doc) {
        const seed = { ...hydrateSettingsObj(localStore.settings || {}), key: 'global' };
        delete seed._id;
        delete seed.__v;
        doc = await Settings.create(seed);
      }
      const today = getTodayKey();
      if (doc.dailyDateKey !== today) {
        doc.dailyDateKey = today;
        doc.dailyTotalBets = 0;
        doc.dailyTotalPayouts = 0;
        doc.dailyNetProfit = 0;
        doc.carryForwardPool = Math.max(0, Number(doc.profitDistributionPool ?? 10000));
        doc.poolStatsByGame = defaultPoolStatsByGame();
        await doc.save();
      }
      const obj = hydrateSettingsObj(doc.toObject());
      localStore.settings = obj;
      return obj;
    }

    const today = getTodayKey();
    if (localStore.settings.dailyDateKey !== today) {
      localStore.settings.dailyDateKey = today;
      localStore.settings.dailyTotalBets = 0;
      localStore.settings.dailyTotalPayouts = 0;
      localStore.settings.dailyNetProfit = 0;
      localStore.settings.carryForwardPool = Math.max(
        0,
        Number(localStore.settings.profitDistributionPool ?? 10000)
      );
      localStore.settings.poolStatsByGame = defaultPoolStatsByGame();
      saveLocalStore();
    }
    return hydrateSettingsObj(localStore.settings);
  },

  async updateSettings(patch) {
    const safePatch = { ...(patch || {}) };
    const touchesPersistentConfig = Object.keys(safePatch).some((k) =>
      PERSISTENT_CONFIG_KEYS.includes(k)
    );
    if (touchesPersistentConfig) {
      safePatch.settingsUpdatedAt = new Date();
    }

    if (isMongoReady()) {
      const doc = await Settings.findOneAndUpdate(
        { key: 'global' },
        { $set: safePatch },
        { new: true, upsert: true }
      );
      const hydrated = hydrateSettingsObj(doc.toObject());
      localStore.settings = hydrated;
      if (touchesPersistentConfig) {
        saveLocalStore();
      }
      return hydrated;
    }
    localStore.settings = hydrateSettingsObj({ ...localStore.settings, ...safePatch });
    saveLocalStore();
    return { ...localStore.settings };
  },

  async pushRoundHistory(roundSummary, maxRounds = 20) {
    if (isMongoReady()) {
      await Settings.findOneAndUpdate(
        { key: 'global' },
        {
          $push: {
            recentRounds: {
              $each: [roundSummary],
              $position: 0,
              $slice: maxRounds,
            },
          },
        }
      );
      return;
    }
    localStore.settings.recentRounds = [
      roundSummary,
      ...(localStore.settings.recentRounds || []),
    ].slice(0, maxRounds);
    saveLocalStore();
  },

  async tryAcquireOrRenewMasterLease(instanceId, leaseMs = 4000) {
    if (!isMongoReady()) return true;
    const now = new Date();
    const nextExpiry = new Date(Date.now() + leaseMs);
    const doc = await Settings.findOneAndUpdate(
      {
        key: 'global',
        $or: [
          { 'liveRound.masterId': instanceId },
          { 'liveRound.masterId': '' },
          { 'liveRound.masterId': { $exists: false } },
          { 'liveRound.leaseExpiresAt': null },
          { 'liveRound.leaseExpiresAt': { $lt: now } },
        ],
      },
      {
        $set: {
          'liveRound.masterId': instanceId,
          'liveRound.leaseExpiresAt': nextExpiry,
        },
      },
      { new: true }
    );
    return Boolean(doc && doc.liveRound?.masterId === instanceId);
  },

  async writeLiveRoundSnapshot(instanceId, snapshot, leaseMs = 4000) {
    if (!isMongoReady()) return;
    await Settings.findOneAndUpdate(
      {
        key: 'global',
        $or: [
          { 'liveRound.masterId': instanceId },
          { 'liveRound.masterId': '' },
          { 'liveRound.masterId': { $exists: false } },
          { 'liveRound.leaseExpiresAt': null },
          { 'liveRound.leaseExpiresAt': { $lt: new Date() } },
        ],
      },
      {
        $set: {
          liveRound: {
            masterId: instanceId,
            leaseExpiresAt: new Date(Date.now() + leaseMs),
            ...snapshot,
            updatedAt: new Date(),
          },
        },
      }
    ).catch(() => {});
  },

  async findUserByPhone(phoneNumber) {
    if (isMongoReady()) {
      const doc = await User.findOne({ phoneNumber });
      return doc ? doc.toObject() : null;
    }
    const found = localStore.users.find((u) => u.phoneNumber === phoneNumber);
    return found ? { ...found } : null;
  },

  async findUsersByIdentifier(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) return [];
    const normalizedPhone = normalizePakistaniPhone(raw);
    const out = [];
    const seenIds = new Set();
    const pushUnique = (u) => {
      if (!u) return;
      const id = String(u._id || u.phoneNumber);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        out.push(u);
      }
    };

    if (normalizedPhone) {
      pushUnique(await this.findUserByPhone(normalizedPhone));
    }
    if (raw !== normalizedPhone) {
      pushUnique(await this.findUserByPhone(raw));
    }

    if (isMongoReady()) {
      const exactCi = new RegExp(`^${escapeRegex(raw)}$`, 'i');
      const docs = await User.find({ displayName: exactCi }).limit(10);
      for (const d of docs) {
        pushUnique(d.toObject());
      }
    } else {
      const lower = raw.toLowerCase();
      for (const u of localStore.users) {
        if (String(u.displayName || '').trim().toLowerCase() === lower) {
          pushUnique({ ...u });
        }
      }
    }
    return out;
  },

  async findUserByCnic(cnic) {
    const clean = String(cnic || '').trim();
    if (!clean) return null;
    if (isMongoReady()) {
      const doc = await User.findOne({
        $or: [{ cnic: clean }, { 'savedPayoutAccounts.cnic': clean }],
      });
      return doc ? doc.toObject() : null;
    }
    const found = localStore.users.find(
      (u) =>
        String(u.cnic || '').trim() === clean ||
        (Array.isArray(u.savedPayoutAccounts) &&
          u.savedPayoutAccounts.some((acc) => String(acc.cnic || '').trim() === clean))
    );
    return found ? { ...found } : null;
  },

  async findUserById(id) {
    if (isMongoReady()) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const doc = await User.findById(id);
      return doc ? doc.toObject() : null;
    }
    const found = localStore.users.find((u) => String(u._id) === String(id));
    return found ? { ...found } : null;
  },

  async findUserByReferralCode(referralCode) {
    const clean = String(referralCode || '').trim().toUpperCase();
    if (!clean) return null;
    if (isMongoReady()) {
      const doc = await User.findOne({ referralCode: clean });
      return doc ? doc.toObject() : null;
    }
    const found = localStore.users.find((u) => String(u.referralCode || '').toUpperCase() === clean);
    return found ? { ...found } : null;
  },

  async findUsersByIpOrFingerprint({ ip = '', fingerprint = '', excludeUserId = '' } = {}) {
    const cleanIp = String(ip || '').trim();
    const cleanFp = String(fingerprint || '').trim();
    if (!cleanIp && !cleanFp) return [];

    if (isMongoReady()) {
      const or = [];
      if (cleanFp && cleanFp.length >= 8) or.push({ deviceFingerprint: cleanFp });
      if (cleanIp && cleanIp !== '127.0.0.1' && cleanIp !== '::1') {
        or.push({ registrationIp: cleanIp }, { lastLoginIp: cleanIp });
      }
      if (!or.length) return [];
      const docs = await User.find({ $or: or }).select('-passwordHash').limit(20);
      return docs
        .map((d) => d.toObject())
        .filter((u) => !excludeUserId || String(u._id) !== String(excludeUserId));
    }

    return localStore.users
      .filter((u) => {
        if (excludeUserId && String(u._id) === String(excludeUserId)) return false;
        const fpMatch = cleanFp && cleanFp.length >= 8 && u.deviceFingerprint === cleanFp;
        const ipMatch =
          cleanIp &&
          cleanIp !== '127.0.0.1' &&
          cleanIp !== '::1' &&
          (u.registrationIp === cleanIp || u.lastLoginIp === cleanIp);
        return fpMatch || ipMatch;
      })
      .slice(0, 20);
  },

  async createUser({
    phoneNumber,
    displayName,
    passwordHash,
    funBalance,
    cnic = '',
    referralCode = '',
    referredBy = '',
    registrationIp = '',
    deviceFingerprint = '',
    bonusRestricted = false,
    restrictionReason = '',
  }) {
    if (isMongoReady()) {
      const doc = await User.create({
        phoneNumber,
        displayName,
        cnic,
        passwordHash,
        funBalance,
        funCredits: funBalance,
        realBalance: 0,
        referralCode,
        referredBy,
        registrationIp,
        lastLoginIp: registrationIp,
        deviceFingerprint,
        bonusRestricted,
        restrictionReason,
        acceptedTermsAt: new Date(),
        lastLoginAt: new Date(),
        lastActiveAt: new Date(),
      });
      return doc.toObject();
    }
    if (localStore.users.some((u) => u.phoneNumber === phoneNumber)) {
      const err = new Error('Duplicate phoneNumber');
      err.code = 11000;
      throw err;
    }
    const user = {
      _id: crypto.randomBytes(12).toString('hex'),
      phoneNumber,
      displayName,
      cnic,
      passwordHash,
      funBalance,
      funCredits: funBalance,
      realBalance: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      totalWageredFun: 0,
      totalWonFun: 0,
      totalWageredReal: 0,
      totalWonReal: 0,
      totalWagered: 0,
      totalWon: 0,
      referralCode,
      referredBy,
      firstDepositRewarded: false,
      referralEarnings: 0,
      lastDailyClaimAt: null,
      lastWeeklyClaimAt: null,
      loginStreakCount: 0,
      lastLoginStreakDate: '',
      streakTotalFunEarned: 0,
      savedPayoutAccounts: [],
      registrationIp,
      lastLoginIp: registrationIp,
      deviceFingerprint,
      bonusRestricted,
      restrictionReason,
      acceptedTermsAt: new Date().toISOString(),
      isBanned: false,
      recentBets: [],
      lastLoginAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    localStore.users.push(user);
    saveLocalStore();
    return { ...user };
  },

  async updateUserById(id, updateOps) {
    if (isMongoReady()) {
      const doc = await User.findByIdAndUpdate(id, updateOps, { new: true });
      return doc ? doc.toObject() : null;
    }
    const idx = localStore.users.findIndex((u) => String(u._id) === String(id));
    if (idx === -1) return null;
    const u = { ...localStore.users[idx] };

    if (updateOps.$set) {
      Object.assign(u, updateOps.$set);
    }
    if (updateOps.$inc) {
      for (const [k, v] of Object.entries(updateOps.$inc)) {
        u[k] = Math.max(0, Number(((u[k] || 0) + v).toFixed(2)));
      }
    }
    if (updateOps.$push?.recentBets) {
      const each = updateOps.$push.recentBets.$each || [];
      const slice = updateOps.$push.recentBets.$slice || 30;
      u.recentBets = [...each, ...(u.recentBets || [])].slice(0, slice);
    }
    if (updateOps.$push?.savedPayoutAccounts) {
      u.savedPayoutAccounts = [...(u.savedPayoutAccounts || []), updateOps.$push.savedPayoutAccounts];
    }
    if (updateOps.$pull?.savedPayoutAccounts) {
      const pullId = updateOps.$pull.savedPayoutAccounts.id;
      u.savedPayoutAccounts = (u.savedPayoutAccounts || []).filter((acc) => acc.id !== pullId);
    }

    localStore.users[idx] = u;
    saveLocalStore();
    return { ...u };
  },

  async adjustBalanceAtomic(id, currencyMode, delta) {
    const rounded = Math.round(delta * 100) / 100;
    const field = currencyMode === 'real' ? 'realBalance' : 'funBalance';

    if (isMongoReady()) {
      const incObj = { [field]: rounded };
      if (field === 'funBalance') incObj.funCredits = rounded;

      if (rounded < 0) {
        const doc = await User.findOneAndUpdate(
          { _id: id, [field]: { $gte: Math.abs(rounded) } },
          { $inc: incObj },
          { new: true }
        );
        return doc ? doc.toObject() : null;
      }
      const doc = await User.findByIdAndUpdate(id, { $inc: incObj }, { new: true });
      return doc ? doc.toObject() : null;
    }

    const idx = localStore.users.findIndex((u) => String(u._id) === String(id));
    if (idx === -1) return null;
    const u = localStore.users[idx];
    const current = Number(
      field === 'funBalance' ? u.funBalance ?? u.funCredits ?? 0 : u.realBalance ?? 0
    );
    if (rounded < 0 && current + rounded < -0.001) {
      return null;
    }
    const nextVal = Math.max(0, Math.round((current + rounded) * 100) / 100);
    u[field] = nextVal;
    if (field === 'funBalance') u.funCredits = nextVal;
    saveLocalStore();
    return { ...u };
  },

  async searchUsers(query = '') {
    const clean = String(query || '').trim();
    if (isMongoReady()) {
      const filter = clean
        ? {
            $or: [
              {
                phoneNumber: {
                  $regex: clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                  $options: 'i',
                },
              },
              {
                displayName: {
                  $regex: clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                  $options: 'i',
                },
              },
            ],
          }
        : {};
      const docs = await User.find(filter)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .limit(200);
      return docs.map((d) => d.toObject());
    }

    let list = localStore.users;
    if (clean) {
      const lower = clean.toLowerCase();
      list = list.filter(
        (u) =>
          u.phoneNumber.includes(clean) ||
          (u.displayName && u.displayName.toLowerCase().includes(lower))
      );
    }
    return list
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 200)
      .map(({ passwordHash, ...rest }) => rest);
  },

  // Transaction Operations
  async createTransaction(data) {
    if (isMongoReady()) {
      const doc = await Transaction.create(data);
      return doc.toObject();
    }
    const tx = {
      _id: crypto.randomBytes(12).toString('hex'),
      status: 'pending',
      rejectionReason: '',
      reviewedAt: null,
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    localStore.transactions.unshift(tx);
    saveLocalStore();
    return { ...tx };
  },

  async findTransactionByTid(tid) {
    const clean = String(tid || '').trim();
    if (!clean) return null;
    if (isMongoReady()) {
      const doc = await Transaction.findOne({
        transactionId: clean,
        type: 'deposit',
        status: { $in: ['pending', 'approved'] },
      });
      return doc ? doc.toObject() : null;
    }
    const found = localStore.transactions.find(
      (t) =>
        t.type === 'deposit' &&
        (t.status === 'pending' || t.status === 'approved') &&
        String(t.transactionId || '').trim().toLowerCase() === clean.toLowerCase()
    );
    return found ? { ...found } : null;
  },

  async findTransactionById(id) {
    if (isMongoReady()) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const doc = await Transaction.findById(id);
      return doc ? doc.toObject() : null;
    }
    const found = localStore.transactions.find((t) => String(t._id) === String(id));
    return found ? { ...found } : null;
  },

  async resolveTransactionIfPending(id, newStatus, rejectionReason = '') {
    if (isMongoReady()) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const doc = await Transaction.findOneAndUpdate(
        { _id: id, status: 'pending' },
        {
          $set: {
            status: newStatus,
            rejectionReason,
            reviewedAt: new Date(),
          },
        },
        { new: true }
      );
      return doc ? doc.toObject() : null;
    }
    const idx = localStore.transactions.findIndex(
      (t) => String(t._id) === String(id) && t.status === 'pending'
    );
    if (idx === -1) return null;
    localStore.transactions[idx] = {
      ...localStore.transactions[idx],
      status: newStatus,
      rejectionReason,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveLocalStore();
    return { ...localStore.transactions[idx] };
  },

  async listUserTransactions(userId, limit = 40) {
    if (isMongoReady()) {
      const docs = await Transaction.find({ userId: String(userId) })
        .select('-screenshotData')
        .sort({ createdAt: -1 })
        .limit(limit);
      return docs.map((d) => d.toObject());
    }
    return localStore.transactions
      .filter((t) => String(t.userId) === String(userId))
      .slice(0, limit)
      .map(({ screenshotData, ...rest }) => rest);
  },

  async listAdminTransactions({
    status = 'all',
    type = 'all',
    startDate = '',
    endDate = '',
    limit = 100,
  } = {}) {
    const startMs = startDate ? new Date(`${startDate}T00:00:00.000Z`).getTime() : null;
    const endMs = endDate ? new Date(`${endDate}T23:59:59.999Z`).getTime() : null;

    if (isMongoReady()) {
      const filter = {};
      if (status !== 'all') filter.status = status;
      if (type !== 'all') filter.type = type;
      if (startMs || endMs) {
        filter.createdAt = {};
        if (startMs && Number.isFinite(startMs)) filter.createdAt.$gte = new Date(startMs);
        if (endMs && Number.isFinite(endMs)) filter.createdAt.$lte = new Date(endMs);
      }
      const docs = await Transaction.find(filter).sort({ createdAt: -1 }).limit(limit);
      return docs.map((d) => d.toObject());
    }
    return localStore.transactions
      .filter((t) => {
        if (status !== 'all' && t.status !== status) return false;
        if (type !== 'all' && t.type !== type) return false;
        const tMs = new Date(t.createdAt).getTime();
        if (startMs && Number.isFinite(startMs) && tMs < startMs) return false;
        if (endMs && Number.isFinite(endMs) && tMs > endMs) return false;
        return true;
      })
      .slice(0, limit);
  },

  async countPendingTransactions() {
    if (isMongoReady()) {
      const [deposits, withdrawals] = await Promise.all([
        Transaction.countDocuments({ status: 'pending', type: 'deposit' }),
        Transaction.countDocuments({ status: 'pending', type: 'withdrawal' }),
      ]);
      return { deposits, withdrawals, total: deposits + withdrawals };
    }
    const deposits = localStore.transactions.filter(
      (t) => t.status === 'pending' && t.type === 'deposit'
    ).length;
    const withdrawals = localStore.transactions.filter(
      (t) => t.status === 'pending' && t.type === 'withdrawal'
    ).length;
    return { deposits, withdrawals, total: deposits + withdrawals };
  },

  // Support Ticket Operations
  async createSupportTicket({ userId, phoneNumber, displayName, subject, text, imageData = '' }) {
    const msg = { sender: 'user', text: text || '', imageData: imageData || '', createdAt: new Date() };
    if (isMongoReady()) {
      const doc = await SupportTicket.create({
        userId: String(userId),
        phoneNumber,
        displayName,
        subject,
        status: 'open',
        messages: [msg],
        lastMessageAt: new Date(),
      });
      return doc.toObject();
    }
    const ticket = {
      _id: crypto.randomBytes(12).toString('hex'),
      userId: String(userId),
      phoneNumber,
      displayName,
      subject,
      status: 'open',
      messages: [{ sender: 'user', text: text || '', imageData: imageData || '', createdAt: new Date().toISOString() }],
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    localStore.supportTickets.unshift(ticket);
    saveLocalStore();
    return { ...ticket };
  },

  async listUserSupportTickets(userId) {
    if (isMongoReady()) {
      const docs = await SupportTicket.find({ userId: String(userId) })
        .sort({ lastMessageAt: -1 })
        .limit(30);
      return docs.map((d) => d.toObject());
    }
    return localStore.supportTickets
      .filter((t) => String(t.userId) === String(userId))
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
      .slice(0, 30);
  },

  async listAllSupportTickets() {
    if (isMongoReady()) {
      const docs = await SupportTicket.find({}).sort({ status: 1, lastMessageAt: -1 }).limit(80);
      return docs.map((d) => d.toObject());
    }
    return localStore.supportTickets
      .slice()
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
      .slice(0, 80);
  },

  async findSupportTicketById(id) {
    if (isMongoReady()) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const doc = await SupportTicket.findById(id);
      return doc ? doc.toObject() : null;
    }
    const found = localStore.supportTickets.find((t) => String(t._id) === String(id));
    return found ? { ...found } : null;
  },

  async addSupportMessage(id, sender, text, imageData = '') {
    if (isMongoReady()) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const doc = await SupportTicket.findByIdAndUpdate(
        id,
        {
          $push: { messages: { sender, text: text || '', imageData: imageData || '', createdAt: new Date() } },
          $set: { status: 'open', lastMessageAt: new Date() },
        },
        { new: true }
      );
      return doc ? doc.toObject() : null;
    }
    const idx = localStore.supportTickets.findIndex((t) => String(t._id) === String(id));
    if (idx === -1) return null;
    const t = { ...localStore.supportTickets[idx] };
    t.messages = [...(t.messages || []), { sender, text: text || '', imageData: imageData || '', createdAt: new Date().toISOString() }];
    t.status = 'open';
    t.lastMessageAt = new Date().toISOString();
    localStore.supportTickets[idx] = t;
    saveLocalStore();
    return { ...t };
  },

  async closeSupportTicket(id) {
    if (isMongoReady()) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const doc = await SupportTicket.findByIdAndUpdate(
        id,
        { $set: { status: 'closed' } },
        { new: true }
      );
      return doc ? doc.toObject() : null;
    }
    const idx = localStore.supportTickets.findIndex((t) => String(t._id) === String(id));
    if (idx === -1) return null;
    localStore.supportTickets[idx].status = 'closed';
    saveLocalStore();
    return { ...localStore.supportTickets[idx] };
  },
};

// ============================================================================
// Helpers
// ============================================================================
function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePakistaniPhone(input) {
  let cleaned = String(input || '')
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

function isValidPakistaniPhone(phone) {
  return /^03[0-9]{9}$/.test(phone);
}

function sanitizeSupportPhone(input) {
  return String(input || '')
    .replace(/[\s\-+()]/g, '')
    .trim();
}

function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return 'Player';
  return `${s.slice(0, 4)}•••${s.slice(-4)}`;
}

function maskMerchantNumber(num, maskEnabled = true) {
  const s = String(num || '').trim();
  if (!maskEnabled || s.length < 7) return s;
  return `${s.slice(0, 4)}${'•'.repeat(Math.max(4, s.length - 7))}${s.slice(-3)}`;
}

function maskPaymentAccountsForPublic(paymentAccounts) {
  const pa = paymentAccounts || defaultPaymentAccounts();
  const epIban = normalizePakIban(pa.easypaisa?.iban || '');
  const jcIban = normalizePakIban(pa.jazzcash?.iban || '');
  return {
    easypaisa: {
      enabled: pa.easypaisa?.enabled !== false,
      label: 'EasyPaisa',
      accountTitle: pa.easypaisa?.accountTitle || 'SkyWing Official',
      supportsAllBanks: Boolean(epIban && epIban.startsWith('PK')) || /^PK/i.test(pa.easypaisa?.accountNumber || ''),
      qrOnly: true,
    },
    jazzcash: {
      enabled: pa.jazzcash?.enabled !== false,
      label: 'JazzCash',
      accountTitle: pa.jazzcash?.accountTitle || 'SkyWing Official',
      supportsAllBanks: Boolean(jcIban && jcIban.startsWith('PK')) || /^PK/i.test(pa.jazzcash?.accountNumber || ''),
      qrOnly: true,
    },
    bank: {
      enabled: pa.bank?.enabled !== false,
      label: 'E-Wallet / Bank Transfer',
      bankName: pa.bank?.bankName || 'Pakistani Bank / Raast',
      accountTitle: pa.bank?.accountTitle || 'SkyWing Enterprises',
      supportsAllBanks: true,
      qrOnly: true,
    },
  };
}

function getClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = xff || req.ip || req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

function generateReferralCode() {
  return `SW${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function computeVipTier(totalWageredReal = 0) {
  const w = Number(totalWageredReal || 0);
  if (w >= 200000) {
    return { tier: 'Platinum', cashbackPct: 10, dailyFun: 1000, dailyReal: 75, nextTier: null, nextTarget: 200000 };
  }
  if (w >= 50000) {
    return { tier: 'Gold', cashbackPct: 6, dailyFun: 500, dailyReal: 35, nextTier: 'Platinum', nextTarget: 200000 };
  }
  if (w >= 10000) {
    return { tier: 'Silver', cashbackPct: 4, dailyFun: 250, dailyReal: 15, nextTier: 'Gold', nextTarget: 50000 };
  }
  return { tier: 'Bronze', cashbackPct: 2, dailyFun: 100, dailyReal: 5, nextTier: 'Silver', nextTarget: 10000 };
}

function isWithinWithdrawalHours(wh = defaultWithdrawalHours()) {
  if (!wh || !wh.enabled) return { allowed: true };
  const [openH = 9, openM = 0] = String(wh.openTime || '09:00').split(':').map(Number);
  const [closeH = 17, closeM = 0] = String(wh.closeTime || '17:00').split(':').map(Number);
  const now = new Date();
  const curMins = now.getHours() * 60 + now.getMinutes();
  const openMins = openH * 60 + openM;
  const closeMins = closeH * 60 + closeM;

  const allowed =
    openMins <= closeMins
      ? curMins >= openMins && curMins < closeMins
      : curMins >= openMins || curMins < closeMins;

  return {
    allowed,
    noticeText: wh.noticeText || 'Withdrawals are only open from 9:00 AM to 5:00 PM.',
    serverTime: now.toTimeString().slice(0, 5),
  };
}

// RFC 6238 6-Digit TOTP Authenticator Helpers
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret(bytesLen = 20) {
  const buf = crypto.randomBytes(bytesLen);
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32ToBuffer(base32) {
  const clean = String(base32 || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function computeTotpCode(secret, stepOffset = 0) {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, token) {
  const clean = String(token || '').replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(clean) || !secret) return false;
  for (const offset of [-1, 0, 1]) {
    if (computeTotpCode(secret, offset) === clean) return true;
  }
  return false;
}

async function ensureMasterPasswordInitialized() {
  try {
    const settings = await db.getSettings();
    if (!settings.security?.masterPasswordHash) {
      const hash = await bcrypt.hash(DEFAULT_MASTER_PASSWORD, 10);
      await db.updateSettings({
        'security.masterPasswordHash': hash,
        security: { ...settings.security, masterPasswordHash: hash },
      });
    }
  } catch (err) {
    console.warn('[Security Init Warning]', err.message);
  }
}

async function verifyMasterPassword(plainPassword) {
  const settings = await db.getSettings();
  const hash = settings.security?.masterPasswordHash;
  if (!hash) {
    return String(plainPassword || '') === DEFAULT_MASTER_PASSWORD;
  }
  return bcrypt.compare(String(plainPassword || ''), hash);
}

async function logSecurityEvent(event, severity = 'info', details = '', ip = '') {
  try {
    const entry = { event, severity, details, ip, createdAt: new Date() };
    const settings = await db.getSettings();
    const prevLogs = Array.isArray(settings.security?.securityLogs) ? settings.security.securityLogs : [];
    const nextLogs = [entry, ...prevLogs].slice(0, 80);
    await db.updateSettings({
      security: {
        ...settings.security,
        securityLogs: nextLogs,
      },
    });
    io.to('admins').emit('admin:security_alert', entry);
    if (severity === 'critical') {
      sendTelegramAlert(settings, `🚨 <b>SECURITY ALERT: ${event}</b>\n${details}\nIP: ${ip || 'N/A'}`).catch(() => {});
    }
  } catch {
    // ignore log failures
  }
}

async function sendTelegramAlert(settings, htmlText, inlineKeyboard = null) {
  try {
    const tg = settings?.telegramBot;
    if (!tg || !tg.enabled || !tg.botToken || !tg.adminChatId) return false;
    const body = {
      chat_id: tg.adminChatId,
      text: htmlText,
      parse_mode: 'HTML',
    };
    if (inlineKeyboard) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function buildPublicSettingsPayload(settings) {
  const maskEnabled = settings.maskMasterAccounts !== false;
  const whStatus = isWithinWithdrawalHours(settings.withdrawalHours);
  return {
    whatsappSupportEnabled: settings.whatsappSupportEnabled !== false,
    whatsappSupportNumber: settings.whatsappSupportNumber,
    whatsappChannelEnabled: settings.whatsappChannelEnabled !== false,
    whatsappChannelUrl: settings.whatsappChannelUrl,
    telegramChannelEnabled: settings.telegramChannelEnabled !== false,
    telegramChannelUrl: settings.telegramChannelUrl || 'https://t.me/SkyWingOfficial',
    welcomeBonusCredits: settings.welcomeBonusCredits,
    maskMasterAccounts: maskEnabled,
    paymentAccounts: maskPaymentAccountsForPublic(settings.paymentAccounts),
    financialLimits: settings.financialLimits || defaultFinancialLimits(),
    withdrawalHours: {
      ...(settings.withdrawalHours || defaultWithdrawalHours()),
      currentlyOpen: whStatus.allowed,
      serverTime: whStatus.serverTime,
    },
    platformStatus: settings.platformStatus || defaultPlatformStatus(),
    gamesConfig: hydrateGamesConfig(settings.gamesConfig),
    audioConfig: settings.audioConfig || defaultAudioConfig(),
    turnstileSiteKey: TURNSTILE_SITE_KEY,
  };
}

function sanitizeUser(user) {
  if (!user) return null;
  const funBalance = Math.round(Number(user.funBalance ?? user.funCredits ?? 1000) * 100) / 100;
  const realBalance = Math.round(Number(user.realBalance ?? 0) * 100) / 100;
  const totalWageredReal = Math.round(Number(user.totalWageredReal ?? 0) * 100) / 100;
  const totalWonReal = Math.round(Number(user.totalWonReal ?? 0) * 100) / 100;
  const totalDeposited = Math.round(Number(user.totalDeposited ?? 0) * 100) / 100;
  const totalWithdrawn = Math.round(Number(user.totalWithdrawn ?? 0) * 100) / 100;
  const remainingWagering = Math.max(
    0,
    Math.round((totalDeposited - totalWageredReal) * 100) / 100
  );
  const wageringRequirementMet = totalWageredReal >= totalDeposited;
  const vip = computeVipTier(totalWageredReal);

  return {
    id: String(user._id),
    phoneNumber: user.phoneNumber,
    displayName: user.displayName || maskPhone(user.phoneNumber),
    cnic: user.cnic || '',
    funBalance,
    realBalance,
    funCredits: funBalance,
    totalDeposited,
    totalWithdrawn,
    totalWageredFun: Math.round(Number(user.totalWageredFun ?? 0) * 100) / 100,
    totalWonFun: Math.round(Number(user.totalWonFun ?? 0) * 100) / 100,
    totalWageredReal,
    totalWonReal,
    remainingWagering,
    wageringRequirementMet,
    netProfitLoss: Math.round((totalWonReal - totalWageredReal) * 100) / 100,
    totalWagered: Math.round(Number(user.totalWagered ?? 0) * 100) / 100,
    totalWon: Math.round(Number(user.totalWon ?? 0) * 100) / 100,
    referralCode: user.referralCode || '',
    referredBy: user.referredBy || '',
    referralEarnings: Math.round(Number(user.referralEarnings || 0) * 100) / 100,
    firstDepositRewarded: Boolean(user.firstDepositRewarded),
    savedPayoutAccounts: Array.isArray(user.savedPayoutAccounts) ? user.savedPayoutAccounts : [],
    bonusRestricted: Boolean(user.bonusRestricted),
    restrictionReason: user.restrictionReason || '',
    registrationIp: user.registrationIp || '',
    lastLoginIp: user.lastLoginIp || '',
    deviceFingerprint: user.deviceFingerprint || '',
    vip,
    loginStreakCount: Number(user.loginStreakCount || 0),
    lastLoginStreakDate: user.lastLoginStreakDate || '',
    streakTotalFunEarned: Math.round(Number(user.streakTotalFunEarned || 0) * 100) / 100,
    isBanned: Boolean(user.isBanned),
    recentBets: (user.recentBets || []).slice(0, 20),
    createdAt: user.createdAt,
  };
}

function sanitizeTransaction(tx) {
  if (!tx) return null;
  return {
    id: String(tx._id),
    userId: String(tx.userId),
    phoneNumber: tx.phoneNumber,
    displayName: tx.displayName || maskPhone(tx.phoneNumber),
    type: tx.type,
    amount: Math.round(Number(tx.amount || 0) * 100) / 100,
    feeAmount: Math.round(Number(tx.feeAmount || 0) * 100) / 100,
    netAmount: Math.round(Number(tx.netAmount ?? tx.amount ?? 0) * 100) / 100,
    method: tx.method,
    senderName: tx.senderName || '',
    senderNumber: tx.senderNumber || '',
    qrReference: tx.qrReference || '',
    transactionId: tx.transactionId || '',
    screenshotData: tx.screenshotData || '',
    autoApproved: Boolean(tx.autoApproved),
    accountDetails: tx.accountDetails || {},
    status: tx.status,
    rejectionReason: tx.rejectionReason || '',
    reviewedAt: tx.reviewedAt || null,
    createdAt: tx.createdAt,
  };
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      phoneNumber: user.phoneNumber,
      role: 'player',
      tv: Number(user.tokenVersion || 0),
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function signAdminToken() {
  return jwt.sign({ role: 'admin', username: ADMIN_USERNAME }, JWT_SECRET, {
    expiresIn: '12h',
  });
}

function isUserInactiveExpired(user) {
  const ref = user?.lastActiveAt || user?.lastLoginAt;
  if (!ref) return false;
  const ts = new Date(ref).getTime();
  return Number.isFinite(ts) && Date.now() - ts > INACTIVITY_LIMIT_MS;
}

function touchUserActivityThrottled(user) {
  if (!user || !user._id) return;
  const ref = user.lastActiveAt || user.lastLoginAt;
  const ts = ref ? new Date(ref).getTime() : 0;
  if (!Number.isFinite(ts) || Date.now() - ts > 60_000) {
    db.updateUserById(user._id, { $set: { lastActiveAt: new Date() } }).catch(() => {});
  }
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'player' || !payload.sub) {
      return res.status(401).json({ error: 'Invalid user token' });
    }
    const user = await db.findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (Number(payload.tv || 0) !== Number(user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Session invalidated. Please log in again.' });
    }
    if (user.isBanned) {
      return res.status(403).json({ error: 'Account is suspended. Contact Admin support.' });
    }
    if (isUserInactiveExpired(user)) {
      return res.status(401).json({
        error: 'Session expired due to 3 days of inactivity. Please log in again.',
        inactivityExpired: true,
      });
    }
    touchUserActivityThrottled(user);
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Admin authentication required' });

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Admin session expired' });
  }
}

// ============================================================================
// Express App & Socket.io Server
// ============================================================================
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '6mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(html|js|css|json)$/i.test(filePath) || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  })
);

function createRateLimiter(maxHits, windowMs, bucketName) {
  const store = new Map();
  return async (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${bucketName}:${ip}`;
    const now = Date.now();
    const hits = (store.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= maxHits) {
      await logSecurityEvent(
        `Rate Limit Triggered (${bucketName})`,
        'warning',
        `IP ${ip} exceeded ${maxHits} requests in ${Math.round(windowMs / 60000)}m`,
        ip
      ).catch(() => {});
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
      });
    }
    hits.push(now);
    store.set(key, hits);
    if (store.size > 5000) {
      for (const [k, list] of store.entries()) {
        if (!list.some((t) => now - t < windowMs)) store.delete(k);
      }
    }
    next();
  };
}

const registerRateLimit = createRateLimiter(12, 15 * 60 * 1000, 'register');
const loginRateLimit = createRateLimiter(25, 10 * 60 * 1000, 'login');
const adminLoginRateLimit = createRateLimiter(12, 15 * 60 * 1000, 'admin-login');

// Health check for Render.com / Railway & uptime monitors
app.get('/health', (req, res) => {
  const now = Date.now();
  res.status(200).json({
    status: 'ok',
    service: 'SkyWing Crash',
    instanceId: INSTANCE_ID,
    syncRole: runtimeSyncState.role,
    uptime: Math.round(process.uptime()),
    database: isMongoReady() ? 'mongodb-connected' : 'local-fallback',
    mongoNotice: lastMongoError ? 'Atlas IP whitelist (0.0.0.0/0) or URI check required' : null,
    currentRoundId: gameState.currentRoundId,
    round: gameState.roundNumber,
    phase: gameState.phase,
    flightState: String(gameState.phase || 'BETTING').toLowerCase(),
    currentMultiplier: gameState.currentMultiplier,
    serverTimestamp: now,
  });
});

// Cross-instance live synchronization feed (round state, history, public settings)
app.get('/api/sync/state', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.set('Cache-Control', 'no-store');
    res.json({
      instanceId: INSTANCE_ID,
      syncRole: runtimeSyncState.role,
      database: isMongoReady() ? 'mongodb-connected' : 'local-fallback',
      roundCounter: settings.roundCounter,
      roundState: buildAuthoritativeState(true),
      publicSettings: buildPublicSettingsPayload(settings),
      recentRounds: (settings.recentRounds || []).slice(0, 20),
      serverTimestamp: Date.now(),
    });
  } catch {
    res.status(500).json({ error: 'Sync state unavailable' });
  }
});

// Secret Isolated Admin Panel route
app.get(['/admin', '/admin/*'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public Settings (Masked Merchant Accounts, Limits, Operating Hours, Maintenance, Games & Audio)
app.get('/api/public-settings', async (req, res) => {
  try {
    if (runtimeSyncState.role === 'remote-mirror' && mirroredPublicSettings) {
      return res.json(mirroredPublicSettings);
    }
    const settings = await db.getSettings();
    res.json(buildPublicSettingsPayload(settings));
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// User Registration (Strict Pakistani 03XX, 18+ Agreement, Referral & Anti-Fraud)
app.post('/api/auth/register', registerRateLimit, async (req, res) => {
  try {
    const phoneNumber = normalizePakistaniPhone(req.body.phoneNumber);
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim().slice(0, 24);
    const referralInput = String(req.body.referralCode || '').trim().toUpperCase();
    const acceptedTerms = Boolean(req.body.acceptedTerms);
    const deviceFingerprint = String(req.body.deviceFingerprint || req.headers['x-device-fingerprint'] || '')
      .trim()
      .slice(0, 128);
    const clientIp = getClientIp(req);

    if (!acceptedTerms) {
      return res.status(400).json({
        error: 'You must confirm you are 18+ and accept the User Agreement to register.',
      });
    }
    if (!isValidPakistaniPhone(phoneNumber)) {
      return res.status(400).json({
        error: 'Enter a valid 11-digit Pakistani mobile number starting with 03 (e.g. 03001234567).',
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long.',
      });
    }

    const existing = await db.findUserByPhone(phoneNumber);
    if (existing) {
      return res.status(409).json({
        error: 'This mobile number is already registered. Only one account per number is allowed.',
      });
    }

    let validReferredBy = '';
    if (referralInput) {
      const refOwner = await db.findUserByReferralCode(referralInput);
      if (refOwner) {
        validReferredBy = refOwner.referralCode;
      }
    }

    // Real-time Anti-Fraud IP & Device Fingerprint multi-account screening
    const matches = await db.findUsersByIpOrFingerprint({
      ip: clientIp,
      fingerprint: deviceFingerprint,
    });
    const bonusRestricted = matches.length > 0;
    const restrictionReason = bonusRestricted
      ? `Multi-account IP/device match detected (${matches.length} existing account(s))`
      : '';

    const settings = await db.getSettings();
    const passwordHash = await bcrypt.hash(password, 10);
    const startingCredits = bonusRestricted ? 100 : Number(settings.welcomeBonusCredits ?? 1000);
    const referralCode = generateReferralCode();

    const created = await db.createUser({
      phoneNumber,
      displayName: displayName || maskPhone(phoneNumber),
      cnic: '',
      passwordHash,
      funBalance: startingCredits,
      referralCode,
      referredBy: validReferredBy,
      registrationIp: clientIp,
      deviceFingerprint,
      bonusRestricted,
      restrictionReason,
    });

    if (bonusRestricted) {
      await logSecurityEvent(
        'Multi-Account Registration Flagged',
        'warning',
        `${phoneNumber} matched existing IP/Device (${matches.map((m) => m.phoneNumber).join(', ')})`,
        clientIp
      );
    }

    const token = signUserToken(created);
    res.status(201).json({
      token,
      user: sanitizeUser(created),
      whatsappChannelUrl: settings.whatsappChannelUrl,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({
        error: 'This mobile number is already registered. Only one account per number is allowed.',
      });
    }
    console.error('[Auth Register Error]', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// User & Admin Flexible Login (Mobile Number OR Username + IP/Device fraud check)
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    const rawIdentifier = String(req.body.phoneNumber || req.body.identifier || '').trim();
    const phoneNumber = normalizePakistaniPhone(rawIdentifier);
    const password = String(req.body.password || '');
    const deviceFingerprint = String(req.body.deviceFingerprint || req.headers['x-device-fingerprint'] || '')
      .trim()
      .slice(0, 128);
    const clientIp = getClientIp(req);

    if (!rawIdentifier) {
      return res.status(400).json({
        error: 'Mobile number or username is required.',
      });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    if (
      (rawIdentifier === ADMIN_USERNAME || phoneNumber === ADMIN_USERNAME) &&
      password === ADMIN_PASSWORD
    ) {
      const settings = await db.getSettings();
      if (settings.security?.totpEnabled) {
        return res.json({
          isAdmin: true,
          requires2FA: true,
          redirectUrl: '/admin',
        });
      }
      return res.json({
        isAdmin: true,
        adminToken: signAdminToken(),
        redirectUrl: '/admin',
      });
    }

    const candidates = await db.findUsersByIdentifier(rawIdentifier);
    if (!candidates.length) {
      return res.status(401).json({ error: 'Invalid mobile number/username or password.' });
    }

    let user = null;
    for (const cand of candidates) {
      if (cand.passwordHash && (await bcrypt.compare(password, cand.passwordHash))) {
        user = cand;
        break;
      }
    }
    if (!user) {
      return res.status(401).json({ error: 'Invalid mobile number/username or password.' });
    }
    if (user.isBanned) {
      return res.status(403).json({
        error: 'Your account has been suspended. Please contact Admin Support.',
      });
    }

    const dupMatches = await db.findUsersByIpOrFingerprint({
      ip: clientIp,
      fingerprint: deviceFingerprint,
      excludeUserId: user._id,
    });

    const patch = {
      lastLoginAt: new Date(),
      lastActiveAt: new Date(),
      lastLoginIp: clientIp,
    };
    if (deviceFingerprint) patch.deviceFingerprint = deviceFingerprint;
    if (!user.referralCode) patch.referralCode = generateReferralCode();
    if (dupMatches.length > 0 && !user.bonusRestricted) {
      patch.bonusRestricted = true;
      patch.restrictionReason = `Multi-account IP/device match on login (${dupMatches.length} accounts)`;
      await logSecurityEvent(
        'Multi-Account Login Flagged',
        'warning',
        `${user.phoneNumber} shares IP/fingerprint with ${dupMatches.map((m) => m.phoneNumber).join(', ')}`,
        clientIp
      );
    }

    const updated = await db.updateUserById(user._id, { $set: patch });

    const settings = await db.getSettings();
    const token = signUserToken(updated || user);
    res.json({
      token,
      user: sanitizeUser(updated || user),
      whatsappChannelUrl: settings.whatsappChannelUrl,
    });
  } catch (err) {
    console.error('[Auth Login Error]', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Fast Online Security Challenge for Self-Service Password Reset (PoW / Turnstile)
function issueResetChallenge() {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto
    .createHmac('sha256', RESET_CHALLENGE_SECRET)
    .update(`${ts}.${nonce}`)
    .digest('hex');
  return `${ts}.${nonce}.${sig}`;
}

function verifyResetPowChallenge(challengeToken, solution) {
  const parts = String(challengeToken || '').split('.');
  if (parts.length !== 3) return false;
  const [tsStr, nonce, sig] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return false;
  const expectedSig = crypto
    .createHmac('sha256', RESET_CHALLENGE_SECRET)
    .update(`${tsStr}.${nonce}`)
    .digest('hex');
  if (sig !== expectedSig) return false;
  const solStr = String(solution || '').trim();
  if (!solStr || solStr.length > 32) return false;
  const hash = crypto
    .createHash('sha256')
    .update(`${challengeToken}:${solStr}`)
    .digest('hex');
  return hash.startsWith('00');
}

async function verifyTurnstileToken(token, remoteIp) {
  if (!TURNSTILE_SECRET_KEY || !token) return false;
  try {
    const body = new URLSearchParams();
    body.append('secret', TURNSTILE_SECRET_KEY);
    body.append('response', String(token));
    if (remoteIp) body.append('remoteip', remoteIp);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await resp.json().catch(() => ({}));
    return Boolean(data.success);
  } catch {
    return false;
  }
}

app.get('/api/auth/reset-challenge', (req, res) => {
  const challengeToken = issueResetChallenge();
  res.json({
    challengeToken,
    difficulty: 2,
    turnstileSiteKey: TURNSTILE_SITE_KEY || '',
  });
});

// Self-Service Password Reset (Accepts Registered Mobile Number, Username OR CNIC + Security Check)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const rawIdentifier = String(req.body.identifier || '').trim();
    const rawPhone = normalizePakistaniPhone(req.body.phoneNumber);
    const rawCnic = String(req.body.cnic || '').trim();
    const newPassword = String(req.body.newPassword || '');
    const turnstileToken = String(req.body.turnstileToken || '').trim();
    const powChallengeToken = String(req.body.powChallengeToken || '').trim();
    const powSolution = String(req.body.powSolution || '').trim();
    const clientIp = getClientIp(req);

    // Rate limit per IP (max 12 attempts per 10 min)
    const nowMs = Date.now();
    const recentHits = (resetRateMap.get(clientIp) || []).filter((t) => nowMs - t < 10 * 60 * 1000);
    if (recentHits.length >= 12) {
      await logSecurityEvent(
        'Password Reset Rate Limited',
        'warning',
        `IP ${clientIp} exceeded 12 password reset requests in 10 minutes`,
        clientIp
      );
      return res.status(429).json({
        error: 'Too many password reset attempts. Please wait a few minutes and try again.',
      });
    }
    recentHits.push(nowMs);
    resetRateMap.set(clientIp, recentHits);

    // Online Security Verification Check (Cloudflare Turnstile OR Proof-of-Work challenge)
    let humanVerified = false;
    if (TURNSTILE_SECRET_KEY && turnstileToken) {
      humanVerified = await verifyTurnstileToken(turnstileToken, clientIp);
    } else if (powChallengeToken && powSolution) {
      humanVerified = verifyResetPowChallenge(powChallengeToken, powSolution);
    }
    if (!humanVerified) {
      await logSecurityEvent(
        'Password Reset Security Check Failed',
        'warning',
        `Invalid or missing online security check from IP ${clientIp}`,
        clientIp
      );
      return res.status(400).json({
        error: 'Complete the Online Security Verification check before resetting your password.',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    let user = null;
    let verifiedVia = '';

    if (rawIdentifier) {
      if (CNIC_REGEX.test(rawIdentifier)) {
        user = await db.findUserByCnic(rawIdentifier);
        verifiedVia = `CNIC ${rawIdentifier}`;
      } else {
        const normalized = normalizePakistaniPhone(rawIdentifier);
        if (isValidPakistaniPhone(normalized)) {
          user = await db.findUserByPhone(normalized);
          verifiedVia = `Mobile ${normalized}`;
        } else {
          const matches = await db.findUsersByIdentifier(rawIdentifier);
          if (matches.length === 1) {
            user = matches[0];
            verifiedVia = `Username ${user.displayName}`;
          } else if (matches.length > 1) {
            return res.status(400).json({
              error: 'Multiple accounts share that username. Enter your registered 03XX mobile number or CNIC.',
            });
          } else {
            return res.status(404).json({
              error: 'No registered account found matching that Mobile Number, Username, or CNIC.',
            });
          }
        }
      }
      if (!user) {
        await logSecurityEvent(
          'Failed Password Reset Attempt',
          'warning',
          `No account matched recovery input "${rawIdentifier}"`,
          clientIp
        );
        return res.status(404).json({ error: 'No registered account found matching that Number, Username, or CNIC.' });
      }
    } else if (rawPhone && rawCnic) {
      if (!isValidPakistaniPhone(rawPhone)) {
        return res.status(400).json({ error: 'Enter your valid 11-digit 03XX mobile number.' });
      }
      if (!CNIC_REGEX.test(rawCnic)) {
        return res.status(400).json({ error: 'Enter a valid Pakistani CNIC (XXXXX-XXXXXXX-X).' });
      }
      user = await db.findUserByPhone(rawPhone);
      if (!user) {
        return res.status(404).json({ error: 'No account found with that mobile number.' });
      }
      const cnicMatchesProfile = user.cnic && user.cnic === rawCnic;
      const cnicMatchesSavedPayout =
        Array.isArray(user.savedPayoutAccounts) &&
        user.savedPayoutAccounts.some((acc) => acc.cnic === rawCnic);
      if (!cnicMatchesProfile && !cnicMatchesSavedPayout) {
        await logSecurityEvent(
          'Failed Password Reset Attempt',
          'warning',
          `CNIC mismatch for ${rawPhone}`,
          clientIp
        );
        return res.status(403).json({
          error: 'CNIC verification failed. Please double-check your registered CNIC.',
        });
      }
      verifiedVia = `Mobile + CNIC (${rawPhone})`;
    } else if (rawPhone) {
      if (!isValidPakistaniPhone(rawPhone)) {
        return res.status(400).json({ error: 'Enter a valid 11-digit 03XX mobile number.' });
      }
      user = await db.findUserByPhone(rawPhone);
      if (!user) return res.status(404).json({ error: 'No account found with that mobile number.' });
      verifiedVia = `Mobile ${rawPhone}`;
    } else if (rawCnic) {
      if (!CNIC_REGEX.test(rawCnic)) {
        return res.status(400).json({ error: 'Enter a valid Pakistani CNIC (XXXXX-XXXXXXX-X).' });
      }
      user = await db.findUserByCnic(rawCnic);
      if (!user) return res.status(404).json({ error: 'No account found with that CNIC.' });
      verifiedVia = `CNIC ${rawCnic}`;
    } else {
      return res.status(400).json({
        error: 'Enter your registered 03XX mobile number or Pakistani CNIC (XXXXX-XXXXXXX-X).',
      });
    }

    if (user.isBanned) {
      return res.status(403).json({ error: 'This account is suspended.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.updateUserById(user._id, {
      $set: { passwordHash },
      $inc: { tokenVersion: 1 },
    });
    await logSecurityEvent(
      'Self-Service Password Reset',
      'info',
      `${user.phoneNumber} reset password via ${verifiedVia}`,
      clientIp
    );
    res.json({ ok: true, message: 'Password reset successfully! You can now log in.' });
  } catch (err) {
    console.error('[Reset Password Error]', err);
    res.status(500).json({ error: 'Password reset failed.' });
  }
});

// Explicit Log Out (Revokes active token version server-side)
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await db.updateUserById(req.user._id, { $inc: { tokenVersion: 1 } });
  } catch {
    // ignore
  }
  res.json({ ok: true });
});

// Current User Profile & Dual Balances (Refreshes 72h inactivity sliding window)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const patch = { lastActiveAt: new Date() };
  if (!req.user.referralCode) {
    patch.referralCode = generateReferralCode();
  }
  const user = (await db.updateUserById(req.user._id, { $set: patch })) || req.user;
  const settings = await db.getSettings();
  res.json({
    user: sanitizeUser(user),
    refreshedToken: signUserToken(user),
    publicSettings: buildPublicSettingsPayload(settings),
  });
});

// ============================================================================
// Saved Pakistani Payout Accounts + CNIC Verification
// ============================================================================
app.get('/api/payout-accounts', requireAuth, async (req, res) => {
  res.json({ accounts: Array.isArray(req.user.savedPayoutAccounts) ? req.user.savedPayoutAccounts : [] });
});

app.post('/api/payout-accounts', requireAuth, async (req, res) => {
  try {
    const method = String(req.body.method || '').trim();
    const bankName = String(req.body.bankName || '').trim().slice(0, 60);
    const accountTitle = String(req.body.accountTitle || '').trim().slice(0, 60);
    const accountNumber = String(req.body.accountNumber || '').trim().slice(0, 60);
    const cnic = String(req.body.cnic || '').trim();

    if (!['EasyPaisa', 'JazzCash', 'Bank Account'].includes(method)) {
      return res.status(400).json({ error: 'Select EasyPaisa, JazzCash, or Bank Account.' });
    }
    if (!accountTitle || !accountNumber) {
      return res.status(400).json({ error: 'Account Holder Name and Account Number are required.' });
    }
    if (method === 'Bank Account' && !bankName) {
      return res.status(400).json({ error: 'Bank Name is required for bank accounts.' });
    }
    if (!CNIC_REGEX.test(cnic)) {
      return res.status(400).json({
        error: 'Valid Pakistani CNIC is required (format: XXXXX-XXXXXXX-X).',
      });
    }

    const existing = Array.isArray(req.user.savedPayoutAccounts) ? req.user.savedPayoutAccounts : [];
    if (existing.length >= 6) {
      return res.status(400).json({ error: 'Maximum 6 saved payout accounts allowed.' });
    }

    const newAcc = {
      id: crypto.randomBytes(8).toString('hex'),
      method,
      bankName: method === 'Bank Account' ? bankName : '',
      accountTitle,
      accountNumber,
      cnic,
      createdAt: new Date(),
    };

    const ops = { $push: { savedPayoutAccounts: newAcc } };
    if (!req.user.cnic) {
      ops.$set = { cnic };
    }
    const updated = await db.updateUserById(req.user._id, ops);
    res.status(201).json({
      account: newAcc,
      accounts: updated?.savedPayoutAccounts || [newAcc],
      user: sanitizeUser(updated),
    });
  } catch (err) {
    console.error('[Save Payout Account Error]', err);
    res.status(500).json({ error: 'Failed to save payout account.' });
  }
});

app.delete('/api/payout-accounts/:id', requireAuth, async (req, res) => {
  try {
    const accId = String(req.params.id || '');
    const updated = await db.updateUserById(req.user._id, {
      $pull: { savedPayoutAccounts: { id: accId } },
    });
    res.json({
      accounts: updated?.savedPayoutAccounts || [],
      user: sanitizeUser(updated),
    });
  } catch {
    res.status(500).json({ error: 'Failed to delete payout account.' });
  }
});

// ============================================================================
// Universal Pakistani SBP Raast / EMVCo QR Code Gateway & Safe PNG Download
// ============================================================================
function emvTlv(tag, val) {
  const s = String(val || '').replace(/[^\x20-\x7E]/g, '').trim();
  const byteLen = Buffer.byteLength(s, 'utf8');
  const len = String(byteLen).padStart(2, '0');
  return `${tag}${len}${s}`;
}

function crc16CcittFalse(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function normalizePakMobileAlias(raw = '') {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (/^923[0-9]{9}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^00923[0-9]{9}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^3[0-9]{9}$/.test(digits)) return `0${digits}`;
  return digits;
}

function resolveGatewayRoutingInfo(settings, method, qrRoute = 'auto') {
  const pa = settings.paymentAccounts || defaultPaymentAccounts();
  const acct =
    method === 'EasyPaisa' ? pa.easypaisa : method === 'JazzCash' ? pa.jazzcash : pa.bank;
  if (!acct || acct.enabled === false) {
    return { error: `${method} deposits are currently disabled by Admin.` };
  }

  const rawNumber = String(acct.accountNumber || '').trim();
  const cleanIban = normalizePakIban(acct.iban || (rawNumber.toUpperCase().startsWith('PK') ? rawNumber : ''));
  const cleanMobile = normalizePakMobileAlias(rawNumber);
  const hasValidIban = /^PK[0-9]{2}[A-Z]{4}[A-Z0-9]{16}$/.test(cleanIban) || (cleanIban.startsWith('PK') && cleanIban.length >= 18);

  // Use IBAN whenever configured (so ANY Pakistani Bank app -> EasyPaisa/JazzCash/Bank via Raast scans directly)
  let destinationId = '';
  let routeType = 'mobile';

  if (qrRoute === 'mobile' && cleanMobile && !rawNumber.toUpperCase().startsWith('PK')) {
    destinationId = cleanMobile;
    routeType = 'mobile';
  } else if (hasValidIban) {
    destinationId = cleanIban;
    routeType = 'iban';
  } else if (cleanMobile) {
    destinationId = cleanMobile;
    routeType = 'mobile';
  } else {
    destinationId = rawNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 34);
    routeType = destinationId.startsWith('PK') ? 'iban' : 'account';
  }

  if (!destinationId) {
    return { error: `${method} account number is not configured yet.` };
  }

  return {
    acct,
    destinationId,
    routeType,
    hasValidIban,
    bankName: acct.bankName || (method === 'EasyPaisa' ? 'EasyPaisa / Telenor Microfinance Bank' : method === 'JazzCash' ? 'JazzCash / Mobilink Microfinance Bank' : 'Pakistani Bank'),
  };
}

function buildEmvcoRaastQrPayload({ destinationId, accountTitle, amount, qrReference }) {
  const cleanTitle =
    String(accountTitle || 'SkyWing Official')
      .replace(/[^A-Za-z0-9 .-]/g, '')
      .trim()
      .slice(0, 25) || 'SkyWing Official';
  const cleanAcct = String(destinationId || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 34);
  const amountStr = Number(amount).toFixed(2);
  // SBP Raast EMVCo MPM Standard: Tag 26 with GUID 'pk.gov.sbp.raast' + Sub-tag 01 IBAN / Raast Alias
  const mai = emvTlv('00', 'pk.gov.sbp.raast') + emvTlv('01', cleanAcct);
  const cleanRef = String(qrReference || '')
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, 25);
  const addData = emvTlv('01', cleanRef);
  const bodyWithoutCrc =
    emvTlv('00', '01') +
    emvTlv('01', '12') +
    emvTlv('26', mai) +
    emvTlv('52', '5999') +
    emvTlv('53', '586') +
    emvTlv('54', amountStr) +
    emvTlv('58', 'PK') +
    emvTlv('59', cleanTitle) +
    emvTlv('60', 'Lahore') +
    emvTlv('62', addData) +
    '6304';
  return bodyWithoutCrc + crc16CcittFalse(bodyWithoutCrc);
}

function signQrDownloadToken({ method, amount, qrReference, qrRoute = 'auto' }) {
  const payload = {
    t: 'qr_dl',
    method,
    amount,
    qrReference,
    qrRoute,
    exp: Date.now() + 30 * 60 * 1000,
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyQrDownloadToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!parsed || parsed.t !== 'qr_dl' || !parsed.exp || Date.now() > Number(parsed.exp)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

app.post('/api/transactions/deposit/qr', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const limits = settings.financialLimits || defaultFinancialLimits();
    const minDep = Number(limits.minDeposit || 50);

    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const method = String(req.body.method || '').trim();
    const qrRoute = ['auto', 'iban', 'mobile'].includes(req.body.qrRoute) ? req.body.qrRoute : 'auto';

    if (!['EasyPaisa', 'JazzCash', 'Bank Account'].includes(method)) {
      return res.status(400).json({ error: 'Select a valid payment gateway.' });
    }
    if (!Number.isFinite(amount) || amount < minDep || amount > 1000000) {
      return res.status(400).json({
        error: `Deposit amount must be between ${minDep.toLocaleString()} and 1,000,000 PKR.`,
      });
    }

    const routed = resolveGatewayRoutingInfo(settings, method, qrRoute);
    if (routed.error) {
      return res.status(400).json({ error: routed.error });
    }

    const qrReference = `SW-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;

    const qrPayload = buildEmvcoRaastQrPayload({
      destinationId: routed.destinationId,
      accountTitle: routed.acct.accountTitle,
      amount,
      qrReference,
    });

    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M',
      width: 520,
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
    });

    const dlToken = signQrDownloadToken({
      method,
      amount,
      qrReference,
      qrRoute,
    });

    res.json({
      qrReference,
      qrDataUrl,
      downloadUrl: `/api/transactions/deposit/qr/download?token=${encodeURIComponent(dlToken)}`,
      qrFormat: 'EMVCo-SBP-Raast',
      qrRouteType: routed.routeType,
      supportsAllBanks: routed.routeType === 'iban',
      qrPayloadLength: qrPayload.length,
      method,
      displayMethod:
        method === 'Bank Account'
          ? 'All Pakistani Banks / Raast'
          : routed.routeType === 'iban'
            ? `${method} · All Banks Raast QR`
            : `${method} · Raast Wallet QR`,
      amount,
      accountTitle: routed.acct.accountTitle,
      bankName: routed.bankName,
      privacyProtected: true,
      microAutoApproveLimit: Number(limits.microDepositAutoApproveLimit || 0),
    });
  } catch (err) {
    console.error('[Deposit QR Error]', err);
    res.status(500).json({ error: 'Failed to generate payment QR code.' });
  }
});

app.get('/api/transactions/deposit/qr/download', async (req, res) => {
  try {
    const tokenData = verifyQrDownloadToken(req.query.token);
    if (!tokenData) {
      return res.status(400).json({ error: 'QR download link expired. Please refresh QR and try again.' });
    }
    const method = String(tokenData.method || '');
    const amount = Math.round(Number(tokenData.amount) * 100) / 100;
    const qrReference = String(tokenData.qrReference || '');
    const qrRoute = String(tokenData.qrRoute || 'auto');

    if (!['EasyPaisa', 'JazzCash', 'Bank Account'].includes(method) || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid QR parameters.' });
    }

    const settings = await db.getSettings();
    const routed = resolveGatewayRoutingInfo(settings, method, qrRoute);
    if (routed.error) {
      return res.status(400).json({ error: routed.error });
    }

    const qrPayload = buildEmvcoRaastQrPayload({
      destinationId: routed.destinationId,
      accountTitle: routed.acct.accountTitle,
      amount,
      qrReference,
    });

    const pngBuffer = await QRCode.toBuffer(qrPayload, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: 600,
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
    });

    const safeAmtLabel = Math.round(amount);
    const filename = `SkyWing-Deposit-QR-${safeAmtLabel}PKR.png`;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pngBuffer);
  } catch (err) {
    console.error('[Deposit QR Download Error]', err);
    res.status(500).json({ error: 'Failed to download QR PNG.' });
  }
});

async function grantFirstDepositReferralRewardIfEligible(userId, depositAmount) {
  try {
    const depositor = await db.findUserById(userId);
    if (!depositor || depositor.firstDepositRewarded || !depositor.referredBy) return;
    if (depositor.bonusRestricted) return;

    const referrer = await db.findUserByReferralCode(depositor.referredBy);
    if (!referrer || String(referrer._id) === String(depositor._id)) return;
    if (referrer.bonusRestricted) return;

    const bonus = Math.round(Number(depositAmount) * 0.15 * 100) / 100;
    if (bonus <= 0) return;

    await db.updateUserById(depositor._id, { $set: { firstDepositRewarded: true } });
    const updatedRef = await db.adjustBalanceAtomic(referrer._id, 'real', bonus);
    await db.updateUserById(referrer._id, { $inc: { referralEarnings: bonus } });

    if (updatedRef) {
      emitUserBalances(updatedRef);
      emitToUser(referrer._id, 'referral:bonus', {
        amount: bonus,
        fromUser: depositor.displayName || maskPhone(depositor.phoneNumber),
      });
    }
  } catch (err) {
    console.warn('[Referral Bonus Warning]', err.message);
  }
}

app.post('/api/transactions/deposit', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const limits = settings.financialLimits || defaultFinancialLimits();
    const minDep = Number(limits.minDeposit || 50);
    const microLimit = Number(limits.microDepositAutoApproveLimit ?? 1000);

    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const method = String(req.body.method || '').trim();
    const senderName = String(req.body.senderName || '').trim().slice(0, 60);
    const senderNumber = String(req.body.senderNumber || '').trim().slice(0, 32);
    const qrReference = String(req.body.qrReference || '').trim().slice(0, 60);
    const transactionId = String(req.body.transactionId || '').trim().slice(0, 80);
    const screenshotData = String(req.body.screenshotData || '').trim();

    if (!Number.isFinite(amount) || amount < minDep || amount > 1000000) {
      return res.status(400).json({
        error: `Deposit amount must be between ${minDep.toLocaleString()} and 1,000,000 PKR.`,
      });
    }
    if (!['EasyPaisa', 'JazzCash', 'Bank Account'].includes(method)) {
      return res.status(400).json({ error: 'Select a valid payment method.' });
    }
    if (!transactionId && !screenshotData) {
      return res.status(400).json({
        error: 'Please provide either a Payment Screenshot OR a Transaction ID (TID).',
      });
    }
    if (screenshotData) {
      if (!screenshotData.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Invalid screenshot format. Upload a PNG/JPG image.' });
      }
      if (screenshotData.length > 4_500_000) {
        return res.status(400).json({ error: 'Screenshot image is too large. Please upload under 3MB.' });
      }
    }

    if (transactionId) {
      const dupTid = await db.findTransactionByTid(transactionId);
      if (dupTid) {
        await logSecurityEvent(
          'Duplicate TID Replay Blocked',
          'warning',
          `User ${req.user.phoneNumber} tried reusing TID "${transactionId}"`,
          getClientIp(req)
        );
        return res.status(409).json({
          error: 'This Transaction ID (TID) has already been submitted. Duplicate TIDs are not allowed.',
        });
      }
    }

    const canAutoApprove =
      microLimit > 0 &&
      amount <= microLimit &&
      transactionId.length >= 6 &&
      /^[A-Za-z0-9\-_]{6,40}$/.test(transactionId);

    const tx = await db.createTransaction({
      userId: String(req.user._id),
      phoneNumber: req.user.phoneNumber,
      displayName: req.user.displayName || maskPhone(req.user.phoneNumber),
      type: 'deposit',
      amount,
      feeAmount: 0,
      netAmount: amount,
      method,
      senderName,
      senderNumber,
      qrReference,
      transactionId,
      screenshotData,
      autoApproved: canAutoApprove,
      status: canAutoApprove ? 'approved' : 'pending',
      reviewedAt: canAutoApprove ? new Date() : null,
      accountDetails: {},
    });

    const cleanTx = sanitizeTransaction(tx);

    if (canAutoApprove) {
      await db.adjustBalanceAtomic(String(req.user._id), 'real', amount);
      const updatedUser = await db.updateUserById(String(req.user._id), {
        $inc: { totalDeposited: amount },
      });
      await grantFirstDepositReferralRewardIfEligible(req.user._id, amount);
      if (updatedUser) emitUserBalances(updatedUser);
      emitToUser(String(req.user._id), 'transaction:updated', cleanTx);
      io.to('admins').emit('admin:transaction_resolved', cleanTx);
      sendTelegramAlert(
        settings,
        `⚡ <b>Micro-Deposit Auto-Approved</b>\nUser: ${req.user.phoneNumber}\nAmount: <b>${amount.toLocaleString()} PKR</b>\nMethod: ${method}\nTID: <code>${transactionId}</code>`
      ).catch(() => {});
      return res.status(201).json({ transaction: cleanTx, autoApproved: true, user: sanitizeUser(updatedUser) });
    }

    // Trigger real-time Pop-Up Notification in Admin Panel + Telegram Bot Approve/Reject Alert
    io.to('admins').emit('admin:deposit_alert', cleanTx);
    sendTelegramAlert(
      settings,
      `💰 <b>New PKR Deposit Request</b>\nUser: ${req.user.phoneNumber} (${req.user.displayName})\nAmount: <b>${amount.toLocaleString()} PKR</b>\nMethod: ${method}\nSender: ${senderName || '-'} (${senderNumber || '-'})\nTID: <code>${transactionId || 'Screenshot'}</code>`,
      [
        [
          { text: '✅ Approve Deposit', callback_data: `approve:${cleanTx.id}` },
          { text: '❌ Reject', callback_data: `reject:${cleanTx.id}` },
        ],
      ]
    ).catch(() => {});

    res.status(201).json({ transaction: cleanTx, autoApproved: false });
  } catch (err) {
    console.error('[Deposit Error]', err);
    res.status(500).json({ error: 'Failed to submit deposit request.' });
  }
});

app.post('/api/transactions/withdraw', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const whStatus = isWithinWithdrawalHours(settings.withdrawalHours);
    if (!whStatus.allowed) {
      return res.status(403).json({
        error: whStatus.noticeText || 'Withdrawals are only open from 9:00 AM to 5:00 PM.',
        outsideOperatingHours: true,
      });
    }

    const limits = settings.financialLimits || defaultFinancialLimits();
    const minWd = Number(limits.minWithdrawal || 100);
    const feePct = Math.min(25, Math.max(0, Number(limits.withdrawalFeePct || 0)));

    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const method = String(req.body.method || '').trim();
    const accountTitle = String(req.body.accountTitle || '').trim().slice(0, 60);
    const accountNumber = String(req.body.accountNumber || '').trim().slice(0, 60);
    const bankName = String(req.body.bankName || '').trim().slice(0, 60);
    const cnic = String(req.body.cnic || '').trim();

    if (!Number.isFinite(amount) || amount < minWd || amount > 1000000) {
      return res.status(400).json({
        error: `Withdrawal amount must be between ${minWd.toLocaleString()} and 1,000,000 PKR.`,
      });
    }
    if (!['EasyPaisa', 'JazzCash', 'Bank Account'].includes(method)) {
      return res.status(400).json({ error: 'Select a valid withdrawal method.' });
    }
    if (!accountTitle || !accountNumber) {
      return res.status(400).json({ error: 'Enter your Account Title and Account Number / IBAN.' });
    }
    if (method === 'Bank Account' && !bankName) {
      return res.status(400).json({ error: 'Enter your Bank Name.' });
    }
    if (!CNIC_REGEX.test(cnic)) {
      return res.status(400).json({
        error: 'Valid Pakistani CNIC is required for withdrawals (format: XXXXX-XXXXXXX-X).',
      });
    }

    // Strict Mandatory 1x Wagering (Rollover) Check: totalWageredReal >= totalDeposited
    const freshUser = await db.findUserById(String(req.user._id));
    if (!freshUser) {
      return res.status(401).json({ error: 'User account not found.' });
    }
    const totalDep = Math.round(Number(freshUser.totalDeposited || 0) * 100) / 100;
    const totalWagered = Math.round(Number(freshUser.totalWageredReal || 0) * 100) / 100;
    if (totalWagered < totalDep) {
      const remaining = Math.round((totalDep - totalWagered) * 100) / 100;
      return res.status(400).json({
        error: `1x Wagering Requirement not met. Wagered ${totalWagered.toLocaleString()} PKR of ${totalDep.toLocaleString()} PKR deposited. Please wager ${remaining.toLocaleString()} PKR more in Real Mode before withdrawing.`,
        remainingWagering: remaining,
        totalDeposited: totalDep,
        totalWageredReal: totalWagered,
      });
    }

    // Atomically deduct from realBalance upon request (refunded if rejected)
    const updatedUser = await db.adjustBalanceAtomic(String(req.user._id), 'real', -amount);
    if (!updatedUser) {
      return res.status(400).json({ error: 'Insufficient Real Money (PKR) balance.' });
    }

    const feeAmount = Math.round(amount * (feePct / 100) * 100) / 100;
    const netAmount = Math.max(0, Math.round((amount - feeAmount) * 100) / 100);

    const tx = await db.createTransaction({
      userId: String(req.user._id),
      phoneNumber: req.user.phoneNumber,
      displayName: req.user.displayName || maskPhone(req.user.phoneNumber),
      type: 'withdrawal',
      amount,
      feeAmount,
      netAmount,
      method,
      transactionId: '',
      screenshotData: '',
      accountDetails: { accountTitle, accountNumber, bankName, cnic },
    });

    const cleanTx = sanitizeTransaction(tx);
    emitUserBalances(updatedUser);
    io.to('admins').emit('admin:withdrawal_alert', cleanTx);
    sendTelegramAlert(
      settings,
      `💸 <b>New PKR Withdrawal Request</b>\nUser: ${req.user.phoneNumber}\nGross: <b>${amount.toLocaleString()} PKR</b> (Fee: ${feeAmount.toLocaleString()} PKR | Net Payout: <b>${netAmount.toLocaleString()} PKR</b>)\nMethod: ${method}\nAccount: ${accountTitle} · ${accountNumber}\nCNIC: ${cnic}`,
      [
        [
          { text: '✅ Approve Payout', callback_data: `approve:${cleanTx.id}` },
          { text: '❌ Reject & Refund', callback_data: `reject:${cleanTx.id}` },
        ],
      ]
    ).catch(() => {});

    res.status(201).json({
      transaction: cleanTx,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error('[Withdrawal Error]', err);
    res.status(500).json({ error: 'Failed to submit withdrawal request.' });
  }
});

app.get('/api/transactions/my', requireAuth, async (req, res) => {
  try {
    const list = await db.listUserTransactions(String(req.user._id), 40);
    res.json({ transactions: list.map(sanitizeTransaction) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch transaction history.' });
  }
});

// ============================================================================
// VIP Loyalty Tiers, Daily Login & Cashback + Daily Login Streak + Referrals
// ============================================================================
const DAILY_STREAK_REWARDS = [50, 100, 150, 250, 400, 600, 1000];

function getYesterdayKey() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

function computeLoginStreakState(user) {
  const todayKey = getTodayKey();
  const yesterdayKey = getYesterdayKey();
  const rawStreak = Math.max(0, Number(user?.loginStreakCount || 0));
  const lastDate = String(user?.lastLoginStreakDate || '');
  const claimedToday = lastDate === todayKey && rawStreak > 0;
  const continuedFromYesterday = lastDate === yesterdayKey && rawStreak > 0;
  const effectiveStreak = claimedToday || continuedFromYesterday ? rawStreak : 0;

  let cycleDay = 1;
  if (claimedToday) {
    cycleDay = ((rawStreak - 1) % 7) + 1;
  } else if (continuedFromYesterday) {
    cycleDay = (rawStreak % 7) + 1;
  }

  const nextRewardFun = DAILY_STREAK_REWARDS[cycleDay - 1] || 50;
  const readyToClaim = !claimedToday && !user?.bonusRestricted;
  const completedCount = claimedToday ? cycleDay : effectiveStreak > 0 ? (rawStreak % 7) : 0;

  const days = DAILY_STREAK_REWARDS.map((rewardFun, idx) => {
    const day = idx + 1;
    const isCompleted = claimedToday ? day <= cycleDay : day <= completedCount;
    const isToday = day === cycleDay;
    return {
      day,
      rewardFun,
      completed: isCompleted,
      isToday,
      claimed: claimedToday && day === cycleDay,
    };
  });

  return {
    streakCount: effectiveStreak,
    cycleDay,
    completedCount,
    claimedToday,
    readyToClaim,
    nextRewardFun,
    totalEarnedFun: Math.round(Number(user?.streakTotalFunEarned || 0) * 100) / 100,
    todayKey,
    days,
  };
}

app.get('/api/rewards/status', requireAuth, async (req, res) => {
  const user = req.user;
  const vip = computeVipTier(user.totalWageredReal);
  const eligible = Number(user.totalDeposited || 0) > 0 && !user.bonusRestricted;
  const now = Date.now();
  const lastDaily = user.lastDailyClaimAt ? new Date(user.lastDailyClaimAt).getTime() : 0;
  const lastWeekly = user.lastWeeklyClaimAt ? new Date(user.lastWeeklyClaimAt).getTime() : 0;
  const dailyCooldownMs = Math.max(0, lastDaily + 24 * 3600 * 1000 - now);
  const weeklyCooldownMs = Math.max(0, lastWeekly + 7 * 24 * 3600 * 1000 - now);

  const netLoss = Math.max(0, Number(user.totalWageredReal || 0) - Number(user.totalWonReal || 0));
  const estimatedCashback =
    eligible && Number(user.totalWageredReal || 0) >= 100
      ? Math.min(10000, Math.max(10, Math.round(netLoss * (vip.cashbackPct / 100))))
      : 0;

  res.json({
    vip,
    eligible,
    bonusRestricted: Boolean(user.bonusRestricted),
    restrictionReason: user.restrictionReason || '',
    hasDeposited: Number(user.totalDeposited || 0) > 0,
    dailyReady: eligible && dailyCooldownMs === 0,
    dailyCooldownMs,
    weeklyReady: eligible && weeklyCooldownMs === 0 && estimatedCashback > 0,
    weeklyCooldownMs,
    estimatedCashback,
    loginStreak: computeLoginStreakState(user),
    referralCode: user.referralCode || '',
    referralEarnings: Number(user.referralEarnings || 0),
  });
});

app.post('/api/rewards/streak', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.bonusRestricted) {
      return res.status(403).json({
        error: 'Account is restricted from promotional bonuses due to multi-account detection.',
      });
    }

    const todayKey = getTodayKey();
    const yesterdayKey = getYesterdayKey();
    const lastDate = String(user.lastLoginStreakDate || '');

    if (lastDate === todayKey && Number(user.loginStreakCount || 0) > 0) {
      return res.status(429).json({
        error: "Today's Daily Login Streak bonus is already claimed. Come back tomorrow!",
      });
    }

    const nextStreak = (lastDate === yesterdayKey ? Number(user.loginStreakCount || 0) : 0) + 1;
    const cycleDay = ((nextStreak - 1) % 7) + 1;
    const rewardFun = DAILY_STREAK_REWARDS[cycleDay - 1] || 50;

    await db.adjustBalanceAtomic(user._id, 'fun', rewardFun);
    const updated = await db.updateUserById(user._id, {
      $set: {
        loginStreakCount: nextStreak,
        lastLoginStreakDate: todayKey,
      },
      $inc: {
        streakTotalFunEarned: rewardFun,
      },
    });

    if (updated) emitUserBalances(updated);
    res.json({
      ok: true,
      awardedFun: rewardFun,
      streakCount: nextStreak,
      cycleDay,
      loginStreak: computeLoginStreakState(updated),
      user: sanitizeUser(updated),
    });
  } catch (err) {
    console.error('[Daily Streak Error]', err);
    res.status(500).json({ error: 'Failed to claim daily streak reward.' });
  }
});

app.post('/api/rewards/daily', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.bonusRestricted) {
      return res.status(403).json({ error: 'Account is restricted from promotional bonuses due to multi-account detection.' });
    }
    if (Number(user.totalDeposited || 0) <= 0) {
      return res.status(403).json({
        error: 'Make your first Real PKR deposit to unlock Daily Login Rewards!',
      });
    }

    const lastDaily = user.lastDailyClaimAt ? new Date(user.lastDailyClaimAt).getTime() : 0;
    const nextAllowed = lastDaily + 24 * 3600 * 1000;
    if (Date.now() < nextAllowed) {
      const hrs = Math.ceil((nextAllowed - Date.now()) / 3600000);
      return res.status(429).json({ error: `Daily reward already claimed. Next claim in ~${hrs}h.` });
    }

    const vip = computeVipTier(user.totalWageredReal);
    await db.adjustBalanceAtomic(user._id, 'fun', vip.dailyFun);
    await db.adjustBalanceAtomic(user._id, 'real', vip.dailyReal);
    const updated = await db.updateUserById(user._id, {
      $set: { lastDailyClaimAt: new Date() },
    });
    if (updated) emitUserBalances(updated);
    res.json({
      ok: true,
      awardedFun: vip.dailyFun,
      awardedReal: vip.dailyReal,
      tier: vip.tier,
      user: sanitizeUser(updated),
    });
  } catch (err) {
    console.error('[Daily Reward Error]', err);
    res.status(500).json({ error: 'Failed to claim daily reward.' });
  }
});

app.post('/api/rewards/weekly', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.bonusRestricted) {
      return res.status(403).json({ error: 'Account is restricted from promotional bonuses.' });
    }
    if (Number(user.totalDeposited || 0) <= 0 || Number(user.totalWageredReal || 0) < 100) {
      return res.status(403).json({
        error: 'Weekly VIP Cashback requires at least 1 approved deposit and 100 PKR wagered.',
      });
    }

    const lastWeekly = user.lastWeeklyClaimAt ? new Date(user.lastWeeklyClaimAt).getTime() : 0;
    const nextAllowed = lastWeekly + 7 * 24 * 3600 * 1000;
    if (Date.now() < nextAllowed) {
      const days = Math.ceil((nextAllowed - Date.now()) / (24 * 3600 * 1000));
      return res.status(429).json({ error: `Weekly cashback already claimed. Next claim in ${days}d.` });
    }

    const vip = computeVipTier(user.totalWageredReal);
    const netLoss = Math.max(0, Number(user.totalWageredReal || 0) - Number(user.totalWonReal || 0));
    const cashback = Math.min(10000, Math.max(10, Math.round(netLoss * (vip.cashbackPct / 100))));

    await db.adjustBalanceAtomic(user._id, 'real', cashback);
    const updated = await db.updateUserById(user._id, {
      $set: { lastWeeklyClaimAt: new Date() },
    });
    if (updated) emitUserBalances(updated);
    res.json({
      ok: true,
      cashback,
      tier: vip.tier,
      user: sanitizeUser(updated),
    });
  } catch (err) {
    console.error('[Weekly Cashback Error]', err);
    res.status(500).json({ error: 'Failed to claim weekly cashback.' });
  }
});

// ============================================================================
// Multi-Game Playable Arcade Engines (Cyber Plinko & Golden Mines)
// ============================================================================
const PLINKO_TABLES = {
  low: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
  medium: [13.0, 3.0, 1.3, 0.7, 0.4, 0.7, 1.3, 3.0, 13.0],
  high: [29.0, 4.0, 1.5, 0.3, 0.2, 0.3, 1.5, 4.0, 29.0],
};

const activeMinesGames = new Map(); // userId -> { currencyMode, betAmount, minesCount, mines: Set<number>, revealed: number[], gameOver: boolean }

function computeMinesMultiplier(revealedCount, minesCount, houseEdgePct = 4) {
  if (revealedCount <= 0) return 1.0;
  let prob = 1.0;
  for (let i = 0; i < revealedCount; i++) {
    prob *= (25 - minesCount - i) / (25 - i);
  }
  const edgeFactor = Math.max(0.75, 1 - houseEdgePct / 100);
  return Math.max(1.01, Math.round((edgeFactor / prob) * 100) / 100);
}

async function recordUnifiedPoolDelta(gameKey, betDelta = 0, payoutDelta = 0) {
  const s = await db.getSettings();
  const safeGame = [
    'crash',
    'plinko',
    'mines',
    'dice',
    'limbo',
    'coinflip',
    'wheel',
    'hilo',
    'slots',
  ].includes(gameKey)
    ? gameKey
    : 'crash';
  const cleanBet = Math.round(Number(betDelta || 0) * 100) / 100;
  const cleanPay = Math.round(Number(payoutDelta || 0) * 100) / 100;
  const poolDelta = Math.round((cleanBet - cleanPay) * 100) / 100;

  const dailyTotalBets = Math.round((Number(s.dailyTotalBets || 0) + cleanBet) * 100) / 100;
  const dailyTotalPayouts = Math.round((Number(s.dailyTotalPayouts || 0) + cleanPay) * 100) / 100;
  const dailyNetProfit = Math.round((dailyTotalBets - dailyTotalPayouts) * 100) / 100;
  const currentPool = Math.max(0, Number(s.profitDistributionPool ?? 10000));
  const profitDistributionPool = Math.max(0, Math.round((currentPool + poolDelta) * 100) / 100);

  const stats = hydratePoolStatsByGame(s.poolStatsByGame);
  const gStat = stats[safeGame];
  stats[safeGame] = {
    bets: Math.round((Number(gStat.bets || 0) + cleanBet) * 100) / 100,
    payouts: Math.round((Number(gStat.payouts || 0) + cleanPay) * 100) / 100,
    netDelta: Math.round((Number(gStat.netDelta || 0) + poolDelta) * 100) / 100,
  };

  const updated = await db.updateSettings({
    dailyTotalBets,
    dailyTotalPayouts,
    dailyNetProfit,
    profitDistributionPool,
    carryForwardPool: profitDistributionPool,
    poolStatsByGame: stats,
  });

  io.to('admins').emit('admin:pool_updated', {
    profitDistributionPool,
    carryForwardPool: profitDistributionPool,
    dailyTotalBets,
    dailyTotalPayouts,
    dailyNetProfit,
    poolStatsByGame: stats,
  });

  return hydrateSettingsObj(updated);
}

app.post('/api/games/plinko/play', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (settings.platformStatus?.mode && settings.platformStatus.mode !== 'active') {
      return res.status(503).json({ error: settings.platformStatus.message || 'Platform under maintenance.' });
    }
    const gameCfg = (settings.gamesConfig || defaultGamesConfig()).find((g) => g.id === 'cyber-plinko');
    if (gameCfg && gameCfg.enabled === false) {
      return res.status(403).json({ error: 'Cyber Plinko is currently disabled by Admin.' });
    }

    const currencyMode = req.body.currencyMode === 'real' ? 'real' : 'fun';
    const risk = ['low', 'medium', 'high'].includes(req.body.risk) ? req.body.risk : 'medium';
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const minBet = Number(gameCfg?.minBet || 10);
    const maxBet = Number(gameCfg?.maxBet || 50000);

    if (!Number.isFinite(amount) || amount < minBet || amount > maxBet) {
      return res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet.toLocaleString()}.` });
    }

    const userId = String(req.user._id);
    const afterDeduct = await db.adjustBalanceAtomic(userId, currencyMode, -amount);
    if (!afterDeduct) {
      return res.status(400).json({
        error: currencyMode === 'real' ? 'Insufficient Real PKR balance.' : 'Insufficient Fun Credits.',
      });
    }

    // 8 cryptographic coin flips for Plinko peg path
    const bytes = crypto.randomBytes(8);
    let pathArr = [];
    let slot = 0;
    for (let i = 0; i < 8; i++) {
      const bit = bytes[i] & 1;
      pathArr.push(bit);
      slot += bit;
    }

    const table = PLINKO_TABLES[risk];
    const edgePct = Math.min(25, Math.max(0, Number(gameCfg?.houseEdgePct ?? 4) + Number(settings.rtpRiskConfig?.dynamicEdgeOffset || 0)));
    const computeSlotMult = (targetSlot) => {
      let m = table[targetSlot] ?? 1.0;
      if (m > 1.5 && edgePct > 4) {
        m = Math.round(m * Math.max(0.75, 1 - (edgePct - 4) / 100) * 100) / 100;
      }
      return m;
    };

    let mult = computeSlotMult(slot);
    // Respect unified Profit Distribution Pool for large Real PKR wins so pool cannot go negative
    if (currencyMode === 'real') {
      const unifiedAvailable = Math.max(0, Number(settings.profitDistributionPool ?? 10000)) + amount;
      if (amount * mult > unifiedAvailable) {
        const affordableSlots = table
          .map((_, idx) => idx)
          .filter((idx) => amount * computeSlotMult(idx) <= unifiedAvailable);
        if (affordableSlots.length > 0) {
          const picked = affordableSlots[crypto.randomInt(0, affordableSlots.length)];
          slot = picked;
          mult = computeSlotMult(slot);
          pathArr = Array.from({ length: 8 }, (_, i) => (i < slot ? 1 : 0));
          for (let i = pathArr.length - 1; i > 0; i--) {
            const j = crypto.randomInt(0, i + 1);
            [pathArr[i], pathArr[j]] = [pathArr[j], pathArr[i]];
          }
        }
      }
    }

    const payout = Math.round(amount * mult * 100) / 100;
    const profit = Math.round((payout - amount) * 100) / 100;

    const afterWin = payout > 0 ? await db.adjustBalanceAtomic(userId, currencyMode, payout) : afterDeduct;
    const wagerField = currencyMode === 'real' ? 'totalWageredReal' : 'totalWageredFun';
    const wonField = currencyMode === 'real' ? 'totalWonReal' : 'totalWonFun';

    const plinkoRoundId = Math.floor(Date.now() / 1000) % 100000;
    const updatedUser = await db.updateUserById(userId, {
      $inc: {
        [wagerField]: amount,
        [wonField]: payout,
        totalWagered: amount,
        totalWon: payout,
      },
      $push: {
        recentBets: {
          $each: [
            {
              roundNumber: plinkoRoundId,
              game: 'cyber-plinko',
              currencyMode,
              betAmount: amount,
              cashoutMultiplier: mult,
              payout,
              profit,
              crashedAt: mult,
              risk,
              createdAt: new Date(),
            },
          ],
          $slice: 30,
        },
      },
    });

    const plinkoFeedItem = {
      id: `plinko-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      roundNumber: plinkoRoundId,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount,
      multiplier: mult,
      payout,
      profit,
      risk,
      slot,
      currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.plinkoHistory = [plinkoFeedItem, ...(gameState.plinkoHistory || [])].slice(0, 20);
    io.emit('arcade:plinko_drop', plinkoFeedItem);

    if (currencyMode === 'real') {
      await recordUnifiedPoolDelta('plinko', amount, payout);
      evaluateRtpRiskDaemon().catch(() => {});
    }

    if (updatedUser || afterWin) emitUserBalances(updatedUser || afterWin);

    res.json({
      path: pathArr,
      slot,
      multiplier: mult,
      payout,
      profit,
      risk,
      currencyMode,
      plinkoHistory: gameState.plinkoHistory,
      user: sanitizeUser(updatedUser || afterWin),
    });
  } catch (err) {
    console.error('[Plinko Error]', err);
    res.status(500).json({ error: 'Plinko round failed.' });
  }
});

app.post('/api/games/mines/start', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (settings.platformStatus?.mode && settings.platformStatus.mode !== 'active') {
      return res.status(503).json({ error: settings.platformStatus.message || 'Platform under maintenance.' });
    }
    const gameCfg = (settings.gamesConfig || defaultGamesConfig()).find((g) => g.id === 'golden-mines');
    if (gameCfg && gameCfg.enabled === false) {
      return res.status(403).json({ error: 'Golden Mines is currently disabled by Admin.' });
    }

    const userId = String(req.user._id);
    if (activeMinesGames.has(userId)) {
      return res.status(409).json({ error: 'Finish or cash out your current Golden Mines board first.' });
    }

    const currencyMode = req.body.currencyMode === 'real' ? 'real' : 'fun';
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const minesCount = Math.min(20, Math.max(3, Math.floor(Number(req.body.minesCount || 3))));
    const minBet = Number(gameCfg?.minBet || 10);
    const maxBet = Number(gameCfg?.maxBet || 50000);

    if (!Number.isFinite(amount) || amount < minBet || amount > maxBet) {
      return res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet.toLocaleString()}.` });
    }

    const afterDeduct = await db.adjustBalanceAtomic(userId, currencyMode, -amount);
    if (!afterDeduct) {
      return res.status(400).json({
        error: currencyMode === 'real' ? 'Insufficient Real PKR balance.' : 'Insufficient Fun Credits.',
      });
    }

    const wagerField = currencyMode === 'real' ? 'totalWageredReal' : 'totalWageredFun';
    const updatedUser = await db.updateUserById(userId, {
      $inc: { [wagerField]: amount, totalWagered: amount },
    });

    const mines = new Set();
    while (mines.size < minesCount) {
      mines.add(crypto.randomInt(0, 25));
    }

    const session = {
      currencyMode,
      betAmount: amount,
      minesCount,
      mines,
      revealed: [],
      houseEdgePct: Number(gameCfg?.houseEdgePct ?? 4),
    };
    activeMinesGames.set(userId, session);

    if (currencyMode === 'real') {
      await recordUnifiedPoolDelta('mines', amount, 0);
      evaluateRtpRiskDaemon().catch(() => {});
    }

    emitUserBalances(updatedUser || afterDeduct);
    res.json({
      ok: true,
      minesCount,
      betAmount: amount,
      currencyMode,
      nextMultiplier: computeMinesMultiplier(1, minesCount, session.houseEdgePct),
      user: sanitizeUser(updatedUser || afterDeduct),
    });
  } catch (err) {
    console.error('[Mines Start Error]', err);
    res.status(500).json({ error: 'Could not start Golden Mines.' });
  }
});

app.post('/api/games/mines/reveal', requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const session = activeMinesGames.get(userId);
    if (!session) {
      return res.status(404).json({ error: 'No active Golden Mines session.' });
    }
    const index = Math.floor(Number(req.body.index));
    if (!Number.isFinite(index) || index < 0 || index >= 25) {
      return res.status(400).json({ error: 'Invalid tile index.' });
    }
    if (session.revealed.includes(index)) {
      return res.status(400).json({ error: 'Tile already revealed.' });
    }

    if (session.mines.has(index)) {
      const mineList = Array.from(session.mines);
      const minesRoundId = Math.floor(Date.now() / 1000) % 100000;
      activeMinesGames.delete(userId);
      const updatedUser = await db.updateUserById(userId, {
        $push: {
          recentBets: {
            $each: [
              {
                roundNumber: minesRoundId,
                game: 'golden-mines',
                currencyMode: session.currencyMode,
                betAmount: session.betAmount,
                cashoutMultiplier: null,
                payout: 0,
                profit: -session.betAmount,
                crashedAt: 0,
                diamondsCount: session.revealed.length,
                minesCount: session.minesCount,
                createdAt: new Date(),
              },
            ],
            $slice: 30,
          },
        },
      });
      const minesFeedItem = {
        id: `mines-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
        roundNumber: minesRoundId,
        player: req.user.displayName || maskPhone(req.user.phoneNumber),
        amount: session.betAmount,
        multiplier: 0,
        payout: 0,
        profit: -session.betAmount,
        diamondsCount: session.revealed.length,
        minesCount: session.minesCount,
        boom: true,
        currencyMode: session.currencyMode,
        createdAt: new Date().toISOString(),
      };
      gameState.minesHistory = [minesFeedItem, ...(gameState.minesHistory || [])].slice(0, 20);
      io.emit('arcade:mines_result', minesFeedItem);

      return res.json({
        boom: true,
        index,
        mines: mineList,
        revealed: session.revealed,
        multiplier: 0,
        payout: 0,
        minesHistory: gameState.minesHistory,
        user: sanitizeUser(updatedUser),
      });
    }

    session.revealed.push(index);
    const mult = computeMinesMultiplier(session.revealed.length, session.minesCount, session.houseEdgePct);
    const nextMultiplier =
      session.revealed.length < 25 - session.minesCount
        ? computeMinesMultiplier(session.revealed.length + 1, session.minesCount, session.houseEdgePct)
        : mult;

    // Auto-cashout if all safe gems uncovered
    if (session.revealed.length >= 25 - session.minesCount) {
      const mineList = Array.from(session.mines);
      const payout = Math.round(session.betAmount * mult * 100) / 100;
      const profit = Math.round((payout - session.betAmount) * 100) / 100;
      const minesRoundId = Math.floor(Date.now() / 1000) % 100000;
      activeMinesGames.delete(userId);
      const afterWin = await db.adjustBalanceAtomic(userId, session.currencyMode, payout);
      const wonField = session.currencyMode === 'real' ? 'totalWonReal' : 'totalWonFun';
      const updatedUser = await db.updateUserById(userId, {
        $inc: { [wonField]: payout, totalWon: payout },
        $push: {
          recentBets: {
            $each: [
              {
                roundNumber: minesRoundId,
                game: 'golden-mines',
                currencyMode: session.currencyMode,
                betAmount: session.betAmount,
                cashoutMultiplier: mult,
                payout,
                profit,
                crashedAt: mult,
                diamondsCount: session.revealed.length,
                minesCount: session.minesCount,
                createdAt: new Date(),
              },
            ],
            $slice: 30,
          },
        },
      });
      const minesFeedItem = {
        id: `mines-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
        roundNumber: minesRoundId,
        player: req.user.displayName || maskPhone(req.user.phoneNumber),
        amount: session.betAmount,
        multiplier: mult,
        payout,
        profit,
        diamondsCount: session.revealed.length,
        minesCount: session.minesCount,
        boom: false,
        currencyMode: session.currencyMode,
        createdAt: new Date().toISOString(),
      };
      gameState.minesHistory = [minesFeedItem, ...(gameState.minesHistory || [])].slice(0, 20);
      io.emit('arcade:mines_result', minesFeedItem);

      if (session.currencyMode === 'real') {
        await recordUnifiedPoolDelta('mines', 0, payout);
        evaluateRtpRiskDaemon().catch(() => {});
      }
      emitUserBalances(updatedUser || afterWin);
      return res.json({
        boom: false,
        clearedAll: true,
        index,
        revealed: session.revealed,
        mines: mineList,
        multiplier: mult,
        payout,
        minesHistory: gameState.minesHistory,
        user: sanitizeUser(updatedUser || afterWin),
      });
    }

    res.json({
      boom: false,
      clearedAll: false,
      index,
      revealed: session.revealed,
      multiplier: mult,
      nextMultiplier,
      potentialPayout: Math.round(session.betAmount * mult * 100) / 100,
    });
  } catch (err) {
    console.error('[Mines Reveal Error]', err);
    res.status(500).json({ error: 'Tile reveal failed.' });
  }
});

app.post('/api/games/mines/cashout', requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const session = activeMinesGames.get(userId);
    if (!session) {
      return res.status(404).json({ error: 'No active Golden Mines session.' });
    }
    if (session.revealed.length === 0) {
      return res.status(400).json({ error: 'Reveal at least 1 diamond before cashing out.' });
    }

    const mult = computeMinesMultiplier(session.revealed.length, session.minesCount, session.houseEdgePct);
    const payout = Math.round(session.betAmount * mult * 100) / 100;
    const profit = Math.round((payout - session.betAmount) * 100) / 100;
    const mineList = Array.from(session.mines);
    const minesRoundId = Math.floor(Date.now() / 1000) % 100000;
    activeMinesGames.delete(userId);

    const afterWin = await db.adjustBalanceAtomic(userId, session.currencyMode, payout);
    const wonField = session.currencyMode === 'real' ? 'totalWonReal' : 'totalWonFun';
    const updatedUser = await db.updateUserById(userId, {
      $inc: { [wonField]: payout, totalWon: payout },
      $push: {
        recentBets: {
          $each: [
            {
              roundNumber: minesRoundId,
              game: 'golden-mines',
              currencyMode: session.currencyMode,
              betAmount: session.betAmount,
              cashoutMultiplier: mult,
              payout,
              profit,
              crashedAt: mult,
              diamondsCount: session.revealed.length,
              minesCount: session.minesCount,
              createdAt: new Date(),
            },
          ],
          $slice: 30,
        },
      },
    });

    const minesFeedItem = {
      id: `mines-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      roundNumber: minesRoundId,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount: session.betAmount,
      multiplier: mult,
      payout,
      profit,
      diamondsCount: session.revealed.length,
      minesCount: session.minesCount,
      boom: false,
      currencyMode: session.currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.minesHistory = [minesFeedItem, ...(gameState.minesHistory || [])].slice(0, 20);
    io.emit('arcade:mines_result', minesFeedItem);

    if (session.currencyMode === 'real') {
      await recordUnifiedPoolDelta('mines', 0, payout);
      evaluateRtpRiskDaemon().catch(() => {});
    }

    emitUserBalances(updatedUser || afterWin);
    res.json({
      ok: true,
      multiplier: mult,
      payout,
      profit,
      diamondsCount: session.revealed.length,
      minesCount: session.minesCount,
      mines: mineList,
      currencyMode: session.currencyMode,
      minesHistory: gameState.minesHistory,
      user: sanitizeUser(updatedUser || afterWin),
    });
  } catch (err) {
    console.error('[Mines Cashout Error]', err);
    res.status(500).json({ error: 'Mines cashout failed.' });
  }
});

app.post('/api/games/dice/play', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (settings.platformStatus?.mode && settings.platformStatus.mode !== 'active') {
      return res.status(503).json({ error: settings.platformStatus.message || 'Platform under maintenance.' });
    }
    const gamesList = hydrateGamesConfig(settings.gamesConfig);
    const gameCfg = gamesList.find((g) => g.id === 'cyber-dice');
    if (gameCfg && gameCfg.enabled === false) {
      return res.status(403).json({ error: 'Cyber Dice is currently disabled by Admin.' });
    }

    const currencyMode = req.body.currencyMode === 'real' ? 'real' : 'fun';
    const direction = req.body.direction === 'over' ? 'over' : 'under';
    const target = Math.min(98, Math.max(2, Math.round(Number(req.body.target ?? 50))));
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const minBet = Number(gameCfg?.minBet || 10);
    const maxBet = Number(gameCfg?.maxBet || 50000);

    if (!Number.isFinite(amount) || amount < minBet || amount > maxBet) {
      return res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet.toLocaleString()}.` });
    }

    const userId = String(req.user._id);
    const afterDeduct = await db.adjustBalanceAtomic(userId, currencyMode, -amount);
    if (!afterDeduct) {
      return res.status(400).json({
        error: currencyMode === 'real' ? 'Insufficient Real PKR balance.' : 'Insufficient Fun Credits.',
      });
    }

    const winChance = direction === 'over' ? 100 - target : target;
    const edgePct = Math.min(
      25,
      Math.max(0, Number(gameCfg?.houseEdgePct ?? 4) + Number(settings.rtpRiskConfig?.dynamicEdgeOffset || 0))
    );
    const multiplier = Math.max(1.01, Math.floor(((100 - edgePct) / winChance) * 100) / 100);

    let roll = crypto.randomInt(0, 10000) / 100;
    let won = direction === 'over' ? roll > target : roll < target;

    // Respect unified Profit Distribution Pool in Real PKR mode so pool never goes negative
    if (currencyMode === 'real' && won) {
      const potentialWin = Math.round(amount * multiplier * 100) / 100;
      const unifiedAvailable = Math.max(0, Number(settings.profitDistributionPool ?? 10000)) + amount;
      if (potentialWin > unifiedAvailable) {
        won = false;
        if (direction === 'over') {
          const maxLossInt = Math.max(1, Math.min(9999, Math.floor(target * 100)));
          roll = crypto.randomInt(0, maxLossInt + 1) / 100;
        } else {
          const minLossInt = Math.max(0, Math.min(9999, Math.ceil(target * 100)));
          roll = crypto.randomInt(minLossInt, 10000) / 100;
        }
      }
    }

    const payout = won ? Math.round(amount * multiplier * 100) / 100 : 0;
    const profit = Math.round((payout - amount) * 100) / 100;

    const afterWin = payout > 0 ? await db.adjustBalanceAtomic(userId, currencyMode, payout) : afterDeduct;
    const wagerField = currencyMode === 'real' ? 'totalWageredReal' : 'totalWageredFun';
    const wonField = currencyMode === 'real' ? 'totalWonReal' : 'totalWonFun';
    const diceRoundId = Math.floor(Date.now() / 1000) % 100000;

    const updatedUser = await db.updateUserById(userId, {
      $inc: {
        [wagerField]: amount,
        [wonField]: payout,
        totalWagered: amount,
        totalWon: payout,
      },
      $push: {
        recentBets: {
          $each: [
            {
              roundNumber: diceRoundId,
              game: 'cyber-dice',
              currencyMode,
              betAmount: amount,
              cashoutMultiplier: won ? multiplier : null,
              payout,
              profit,
              crashedAt: roll,
              risk: `${direction.toUpperCase()} ${target}`,
              createdAt: new Date(),
            },
          ],
          $slice: 30,
        },
      },
    });

    const diceFeedItem = {
      id: `dice-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      roundNumber: diceRoundId,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount,
      direction,
      target,
      roll,
      won,
      multiplier: won ? multiplier : 0,
      payout,
      profit,
      currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.diceHistory = [diceFeedItem, ...(gameState.diceHistory || [])].slice(0, 20);
    io.emit('arcade:dice_roll', diceFeedItem);

    if (currencyMode === 'real') {
      await recordUnifiedPoolDelta('dice', amount, payout);
      evaluateRtpRiskDaemon().catch(() => {});
    }

    if (updatedUser || afterWin) emitUserBalances(updatedUser || afterWin);

    res.json({
      roll,
      won,
      direction,
      target,
      winChance,
      multiplier,
      payout,
      profit,
      currencyMode,
      diceHistory: gameState.diceHistory,
      user: sanitizeUser(updatedUser || afterWin),
    });
  } catch (err) {
    console.error('[Dice Play Error]', err);
    res.status(500).json({ error: 'Cyber Dice round failed.' });
  }
});

// ============================================================================
// 5 Additional Instant Unified-Pool Arcade Games (Limbo X, Neon Coin Flip,
// Lucky Wheel, Dragon Hi-Lo, Emerald 777 Slots)
// ============================================================================
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

async function validateAndDeductArcadeBet(req, res, gameId) {
  const settings = await db.getSettings();
  if (settings.platformStatus?.mode && settings.platformStatus.mode !== 'active') {
    res.status(503).json({ error: settings.platformStatus.message || 'Platform under maintenance.' });
    return null;
  }
  const gameCfg = hydrateGamesConfig(settings.gamesConfig).find((g) => g.id === gameId);
  if (gameCfg && gameCfg.enabled === false) {
    res.status(403).json({ error: `${gameCfg.name} is currently disabled by Admin.` });
    return null;
  }
  const currencyMode = req.body.currencyMode === 'real' ? 'real' : 'fun';
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  const minBet = Number(gameCfg?.minBet || 10);
  const maxBet = Number(gameCfg?.maxBet || 50000);
  if (!Number.isFinite(amount) || amount < minBet || amount > maxBet) {
    res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet.toLocaleString()}.` });
    return null;
  }
  const userId = String(req.user._id);
  const afterDeduct = await db.adjustBalanceAtomic(userId, currencyMode, -amount);
  if (!afterDeduct) {
    res.status(400).json({
      error: currencyMode === 'real' ? 'Insufficient Real PKR balance.' : 'Insufficient Fun Credits.',
    });
    return null;
  }
  const effectiveEdgePct = Math.min(
    25,
    Math.max(0, Number(gameCfg?.houseEdgePct ?? 4) + Number(settings.rtpRiskConfig?.dynamicEdgeOffset || 0))
  );
  const unifiedAvailable = Math.max(0, Number(settings.profitDistributionPool ?? 10000)) + amount;
  return { settings, gameCfg, currencyMode, amount, userId, afterDeduct, effectiveEdgePct, unifiedAvailable };
}

async function settleArcadeRound({ userId, afterDeduct, currencyMode, amount, payout, roundNumber, gameId, gamePoolKey, mult, crashedAt, risk }) {
  const profit = Math.round((payout - amount) * 100) / 100;
  const afterWin = payout > 0 ? await db.adjustBalanceAtomic(userId, currencyMode, payout) : afterDeduct;
  const wagerField = currencyMode === 'real' ? 'totalWageredReal' : 'totalWageredFun';
  const wonField = currencyMode === 'real' ? 'totalWonReal' : 'totalWonFun';

  const updatedUser = await db.updateUserById(userId, {
    $inc: {
      [wagerField]: amount,
      [wonField]: payout,
      totalWagered: amount,
      totalWon: payout,
    },
    $push: {
      recentBets: {
        $each: [
          {
            roundNumber,
            game: gameId,
            currencyMode,
            betAmount: amount,
            cashoutMultiplier: mult > 0 ? mult : null,
            payout,
            profit,
            crashedAt,
            risk: String(risk || ''),
            createdAt: new Date(),
          },
        ],
        $slice: 30,
      },
    },
  });

  if (currencyMode === 'real') {
    await recordUnifiedPoolDelta(gamePoolKey, amount, payout);
    evaluateRtpRiskDaemon().catch(() => {});
  }
  if (updatedUser || afterWin) emitUserBalances(updatedUser || afterWin);
  return { profit, updatedUser: updatedUser || afterWin };
}

// 1) Limbo X
app.post('/api/games/limbo/play', requireAuth, async (req, res) => {
  try {
    const ctx = await validateAndDeductArcadeBet(req, res, 'cyber-limbo');
    if (!ctx) return;

    const targetMult = Math.min(100, Math.max(1.05, Math.round(Number(req.body.targetMultiplier ?? 2) * 100) / 100));
    const u = Math.max(0.0001, (crypto.randomInt(1, 1000000) / 1000000));
    const rtpFactor = Math.max(0.75, 1 - ctx.effectiveEdgePct / 100);
    let rolled = Math.max(1.0, Math.min(1000, Math.floor((rtpFactor / u) * 100) / 100));
    let won = rolled >= targetMult;

    if (ctx.currencyMode === 'real' && won) {
      const potentialWin = Math.round(ctx.amount * targetMult * 100) / 100;
      if (potentialWin > ctx.unifiedAvailable) {
        won = false;
        rolled = Math.max(1.0, Math.floor((1 + (crypto.randomInt(0, Math.max(1, Math.floor((targetMult - 1) * 100)))) / 100) * 100) / 100);
      }
    }

    const payout = won ? Math.round(ctx.amount * targetMult * 100) / 100 : 0;
    const roundNumber = Math.floor(Date.now() / 1000) % 100000;
    const { profit, updatedUser } = await settleArcadeRound({
      userId: ctx.userId,
      afterDeduct: ctx.afterDeduct,
      currencyMode: ctx.currencyMode,
      amount: ctx.amount,
      payout,
      roundNumber,
      gameId: 'cyber-limbo',
      gamePoolKey: 'limbo',
      mult: won ? targetMult : 0,
      crashedAt: rolled,
      risk: `${targetMult.toFixed(2)}x`,
    });

    const feedItem = {
      id: `limbo-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount: ctx.amount,
      targetMultiplier: targetMult,
      rolled,
      won,
      multiplier: won ? targetMult : 0,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.limboHistory = [feedItem, ...(gameState.limboHistory || [])].slice(0, 20);
    io.emit('arcade:limbo_play', feedItem);

    res.json({
      rolled,
      targetMultiplier: targetMult,
      won,
      multiplier: won ? targetMult : 0,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      limboHistory: gameState.limboHistory,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error('[Limbo Error]', err);
    res.status(500).json({ error: 'Limbo X failed.' });
  }
});

// 2) Neon Coin Flip
app.post('/api/games/coinflip/play', requireAuth, async (req, res) => {
  try {
    const ctx = await validateAndDeductArcadeBet(req, res, 'neon-flip');
    if (!ctx) return;

    const pick = req.body.pick === 'tails' ? 'tails' : 'heads';
    const rtpFactor = Math.max(0.75, 1 - ctx.effectiveEdgePct / 100);
    const mult = Math.max(1.5, Math.floor(2 * rtpFactor * 100) / 100);
    let outcome = crypto.randomInt(0, 2) === 0 ? 'heads' : 'tails';
    let won = outcome === pick;

    if (ctx.currencyMode === 'real' && won) {
      const potentialWin = Math.round(ctx.amount * mult * 100) / 100;
      if (potentialWin > ctx.unifiedAvailable) {
        won = false;
        outcome = pick === 'heads' ? 'tails' : 'heads';
      }
    }

    const payout = won ? Math.round(ctx.amount * mult * 100) / 100 : 0;
    const roundNumber = Math.floor(Date.now() / 1000) % 100000;
    const { profit, updatedUser } = await settleArcadeRound({
      userId: ctx.userId,
      afterDeduct: ctx.afterDeduct,
      currencyMode: ctx.currencyMode,
      amount: ctx.amount,
      payout,
      roundNumber,
      gameId: 'neon-flip',
      gamePoolKey: 'coinflip',
      mult: won ? mult : 0,
      crashedAt: won ? mult : 0,
      risk: pick.toUpperCase(),
    });

    const feedItem = {
      id: `flip-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount: ctx.amount,
      pick,
      outcome,
      won,
      multiplier: won ? mult : 0,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.coinflipHistory = [feedItem, ...(gameState.coinflipHistory || [])].slice(0, 20);
    io.emit('arcade:coinflip_play', feedItem);

    res.json({
      pick,
      outcome,
      won,
      multiplier: won ? mult : 0,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      coinflipHistory: gameState.coinflipHistory,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error('[CoinFlip Error]', err);
    res.status(500).json({ error: 'Neon Coin Flip failed.' });
  }
});

// 3) Lucky Wheel
app.post('/api/games/wheel/play', requireAuth, async (req, res) => {
  try {
    const ctx = await validateAndDeductArcadeBet(req, res, 'lucky-wheel');
    if (!ctx) return;

    let segIndex = crypto.randomInt(0, WHEEL_SEGMENTS.length);
    let seg = WHEEL_SEGMENTS[segIndex];

    if (ctx.currencyMode === 'real' && seg.mult > 0) {
      const potentialWin = Math.round(ctx.amount * seg.mult * 100) / 100;
      if (potentialWin > ctx.unifiedAvailable) {
        const safeIndices = WHEEL_SEGMENTS.map((s, i) => (s.mult <= 0.5 ? i : -1)).filter((i) => i >= 0);
        segIndex = safeIndices[crypto.randomInt(0, safeIndices.length)] ?? 0;
        seg = WHEEL_SEGMENTS[segIndex];
      }
    }

    const payout = Math.round(ctx.amount * seg.mult * 100) / 100;
    const roundNumber = Math.floor(Date.now() / 1000) % 100000;
    const { profit, updatedUser } = await settleArcadeRound({
      userId: ctx.userId,
      afterDeduct: ctx.afterDeduct,
      currencyMode: ctx.currencyMode,
      amount: ctx.amount,
      payout,
      roundNumber,
      gameId: 'lucky-wheel',
      gamePoolKey: 'wheel',
      mult: seg.mult,
      crashedAt: seg.mult,
      risk: seg.label,
    });

    const feedItem = {
      id: `wheel-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount: ctx.amount,
      segmentIndex: segIndex,
      multiplier: seg.mult,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.wheelHistory = [feedItem, ...(gameState.wheelHistory || [])].slice(0, 20);
    io.emit('arcade:wheel_spin', feedItem);

    res.json({
      segmentIndex: segIndex,
      multiplier: seg.mult,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      wheelHistory: gameState.wheelHistory,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error('[Wheel Error]', err);
    res.status(500).json({ error: 'Lucky Wheel spin failed.' });
  }
});

// 4) Dragon Hi-Lo
const HILO_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const HILO_SUITS = ['♠', '♥', '♦', '♣'];

app.post('/api/games/hilo/play', requireAuth, async (req, res) => {
  try {
    const ctx = await validateAndDeductArcadeBet(req, res, 'dragon-hilo');
    if (!ctx) return;

    const baseRankIdx = Math.min(12, Math.max(0, Math.round(Number(req.body.baseRankIdx ?? 6))));
    const choice = ['high', 'low', 'red', 'black'].includes(req.body.choice) ? req.body.choice : 'high';
    const rtpFactor = Math.max(0.75, 1 - ctx.effectiveEdgePct / 100);

    let winCount = 13;
    if (choice === 'high') winCount = Math.max(1, 13 - baseRankIdx);
    else if (choice === 'low') winCount = Math.max(1, baseRankIdx + 1);
    else winCount = 6.5;

    const mult = Math.max(1.04, Math.floor((13 / winCount) * rtpFactor * 100) / 100);
    let nextRankIdx = crypto.randomInt(0, 13);
    let nextSuitIdx = crypto.randomInt(0, 4);

    const checkWin = (rIdx, sIdx) => {
      if (choice === 'high') return rIdx >= baseRankIdx;
      if (choice === 'low') return rIdx <= baseRankIdx;
      if (choice === 'red') return sIdx === 1 || sIdx === 2;
      return sIdx === 0 || sIdx === 3;
    };

    let won = checkWin(nextRankIdx, nextSuitIdx);
    if (ctx.currencyMode === 'real' && won) {
      const potentialWin = Math.round(ctx.amount * mult * 100) / 100;
      if (potentialWin > ctx.unifiedAvailable) {
        won = false;
        if (choice === 'red') nextSuitIdx = 0;
        else if (choice === 'black') nextSuitIdx = 1;
        else if (choice === 'high' && baseRankIdx > 0) nextRankIdx = crypto.randomInt(0, baseRankIdx);
        else if (choice === 'low' && baseRankIdx < 12) nextRankIdx = crypto.randomInt(baseRankIdx + 1, 13);
      }
    }

    const payout = won ? Math.round(ctx.amount * mult * 100) / 100 : 0;
    const nextCard = `${HILO_RANKS[nextRankIdx]}${HILO_SUITS[nextSuitIdx]}`;
    const roundNumber = Math.floor(Date.now() / 1000) % 100000;
    const { profit, updatedUser } = await settleArcadeRound({
      userId: ctx.userId,
      afterDeduct: ctx.afterDeduct,
      currencyMode: ctx.currencyMode,
      amount: ctx.amount,
      payout,
      roundNumber,
      gameId: 'dragon-hilo',
      gamePoolKey: 'hilo',
      mult: won ? mult : 0,
      crashedAt: nextRankIdx + 2,
      risk: `${choice.toUpperCase()} vs ${HILO_RANKS[baseRankIdx]}`,
    });

    const feedItem = {
      id: `hilo-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount: ctx.amount,
      choice,
      nextCard,
      nextRankIdx,
      nextSuitIdx,
      won,
      multiplier: won ? mult : 0,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.hiloHistory = [feedItem, ...(gameState.hiloHistory || [])].slice(0, 20);
    io.emit('arcade:hilo_play', feedItem);

    res.json({
      choice,
      nextCard,
      nextRankIdx,
      nextSuitIdx,
      won,
      multiplier: won ? mult : 0,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      hiloHistory: gameState.hiloHistory,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error('[HiLo Error]', err);
    res.status(500).json({ error: 'Dragon Hi-Lo deal failed.' });
  }
});

// 5) Emerald 777 Slots
const SLOT_TRIPLE_PAY = { '777': 25, '💎': 12, '👑': 6, '⚡': 3.5, '🍒': 2.5, '🍋': 1.8 };

app.post('/api/games/slots/play', requireAuth, async (req, res) => {
  try {
    const ctx = await validateAndDeductArcadeBet(req, res, 'emerald-slots');
    if (!ctx) return;

    let r1 = SLOT_SYMBOLS[crypto.randomInt(0, SLOT_SYMBOLS.length)];
    let r2 = SLOT_SYMBOLS[crypto.randomInt(0, SLOT_SYMBOLS.length)];
    let r3 = SLOT_SYMBOLS[crypto.randomInt(0, SLOT_SYMBOLS.length)];

    const calcSlotMult = (a, b, c) => {
      if (a === b && b === c) return SLOT_TRIPLE_PAY[a] || 2;
      if (a === b || b === c || a === c) return 1.2;
      return 0;
    };

    let mult = calcSlotMult(r1, r2, r3);
    if (ctx.currencyMode === 'real' && mult > 0) {
      const potentialWin = Math.round(ctx.amount * mult * 100) / 100;
      if (potentialWin > ctx.unifiedAvailable) {
        r1 = '🍒';
        r2 = '🍋';
        r3 = '⚡';
        mult = 0;
      }
    }

    const payout = Math.round(ctx.amount * mult * 100) / 100;
    const roundNumber = Math.floor(Date.now() / 1000) % 100000;
    const { profit, updatedUser } = await settleArcadeRound({
      userId: ctx.userId,
      afterDeduct: ctx.afterDeduct,
      currencyMode: ctx.currencyMode,
      amount: ctx.amount,
      payout,
      roundNumber,
      gameId: 'emerald-slots',
      gamePoolKey: 'slots',
      mult,
      crashedAt: mult,
      risk: `${r1}${r2}${r3}`,
    });

    const feedItem = {
      id: `slots-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      player: req.user.displayName || maskPhone(req.user.phoneNumber),
      amount: ctx.amount,
      reels: [r1, r2, r3],
      multiplier: mult,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      createdAt: new Date().toISOString(),
    };
    gameState.slotsHistory = [feedItem, ...(gameState.slotsHistory || [])].slice(0, 20);
    io.emit('arcade:slots_spin', feedItem);

    res.json({
      reels: [r1, r2, r3],
      multiplier: mult,
      payout,
      profit,
      currencyMode: ctx.currencyMode,
      slotsHistory: gameState.slotsHistory,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error('[Slots Error]', err);
    res.status(500).json({ error: 'Emerald 777 Slots spin failed.' });
  }
});

// ============================================================================
// In-App Live Support Ticket Chat (Player Routes)
// ============================================================================
app.get('/api/support/tickets/my', requireAuth, async (req, res) => {
  try {
    const tickets = await db.listUserSupportTickets(req.user._id);
    res.json({ tickets });
  } catch {
    res.status(500).json({ error: 'Failed to load support tickets.' });
  }
});

function sanitizeSupportImageData(raw) {
  const val = String(raw || '').trim();
  if (!val) return '';
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(val)) {
    return '';
  }
  if (val.length > 2_800_000) {
    return '';
  }
  return val;
}

app.post('/api/support/tickets', requireAuth, async (req, res) => {
  try {
    const subject = String(req.body.subject || '').trim().slice(0, 120);
    const text = String(req.body.text || '').trim().slice(0, 1000);
    const imageData = sanitizeSupportImageData(req.body.imageData);
    if (!subject || (!text && !imageData)) {
      return res.status(400).json({ error: 'Subject and a message or screenshot are required.' });
    }
    const ticket = await db.createSupportTicket({
      userId: req.user._id,
      phoneNumber: req.user.phoneNumber,
      displayName: req.user.displayName || maskPhone(req.user.phoneNumber),
      subject,
      text,
      imageData,
    });
    io.to('admins').emit('support:ticket_updated', ticket);
    res.status(201).json({ ticket });
  } catch (err) {
    console.error('[Support Create Error]', err);
    res.status(500).json({ error: 'Failed to create support ticket.' });
  }
});

app.post(['/api/support/tickets/:id/message', '/api/support/tickets/:id/messages'], requireAuth, async (req, res) => {
  try {
    const existing = await db.findSupportTicketById(req.params.id);
    if (!existing || String(existing.userId) !== String(req.user._id)) {
      return res.status(404).json({ error: 'Support ticket not found.' });
    }
    const text = String(req.body.text || '').trim().slice(0, 1000);
    const imageData = sanitizeSupportImageData(req.body.imageData);
    if (!text && !imageData) {
      return res.status(400).json({ error: 'Message text or image attachment is required.' });
    }
    const updated = await db.addSupportMessage(req.params.id, 'user', text, imageData);
    io.to('admins').emit('support:ticket_updated', updated);
    emitToUser(req.user._id, 'support:ticket_updated', updated);
    res.json({ ticket: updated });
  } catch {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// Telegram Webhook Handler (Inline [Approve] / [Reject] buttons)
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const settings = await db.getSettings();
    const tg = settings.telegramBot || {};
    const cbq = req.body?.callback_query;
    if (!cbq || !cbq.data) {
      return res.json({ ok: true });
    }
    const chatId = String(cbq.message?.chat?.id || cbq.from?.id || '');
    if (tg.adminChatId && chatId !== String(tg.adminChatId)) {
      return res.json({ ok: false });
    }
    const [action, txId] = String(cbq.data).split(':');
    if (action === 'approve' && txId) {
      const existingTx = await db.findTransactionById(txId);
      if (existingTx && existingTx.status === 'pending') {
        const resolved = await db.resolveTransactionIfPending(txId, 'approved', '');
        if (resolved) {
          if (resolved.type === 'deposit') {
            await db.adjustBalanceAtomic(resolved.userId, 'real', resolved.amount);
            const u = await db.updateUserById(resolved.userId, { $inc: { totalDeposited: resolved.amount } });
            await grantFirstDepositReferralRewardIfEligible(resolved.userId, resolved.amount);
            if (u) emitUserBalances(u);
          } else {
            const u = await db.updateUserById(resolved.userId, { $inc: { totalWithdrawn: resolved.amount } });
            if (u) emitUserBalances(u);
          }
          const clean = sanitizeTransaction(resolved);
          emitToUser(resolved.userId, 'transaction:updated', clean);
          io.to('admins').emit('admin:transaction_resolved', clean);
          await sendTelegramAlert(settings, `✅ Transaction <code>${txId}</code> (${resolved.amount} PKR) approved via Telegram.`);
        }
      }
    } else if (action === 'reject' && txId) {
      const resolved = await db.resolveTransactionIfPending(txId, 'rejected', 'Rejected via Telegram Admin');
      if (resolved) {
        if (resolved.type === 'withdrawal') {
          const u = await db.adjustBalanceAtomic(resolved.userId, 'real', resolved.amount);
          if (u) emitUserBalances(u);
        }
        const clean = sanitizeTransaction(resolved);
        emitToUser(resolved.userId, 'transaction:updated', clean);
        io.to('admins').emit('admin:transaction_resolved', clean);
        await sendTelegramAlert(settings, `❌ Transaction <code>${txId}</code> rejected via Telegram.`);
      }
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// ============================================================================
// Admin Routes
// ============================================================================
app.post('/api/admin/login', adminLoginRateLimit, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const totpCode = String(req.body.totpCode || '').trim();
    const clientIp = getClientIp(req);

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      await logSecurityEvent('Admin Login Failed', 'critical', `Bad credentials attempt for "${username}"`, clientIp);
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const settings = await db.getSettings();
    if (settings.security?.totpEnabled) {
      if (!totpCode) {
        return res.status(200).json({ requires2FA: true });
      }
      if (!verifyTotp(settings.security.totpSecret, totpCode)) {
        await logSecurityEvent('Admin 2FA Failed', 'critical', 'Invalid Google Authenticator 2FA code', clientIp);
        return res.status(401).json({ error: 'Invalid 2FA Authenticator code.', requires2FA: true });
      }
    }

    await logSecurityEvent('Admin Logged In', 'info', `Admin console unlocked`, clientIp);
    return res.json({ token: signAdminToken(), username: ADMIN_USERNAME });
  } catch {
    return res.status(500).json({ error: 'Admin login error.' });
  }
});

function computeLiveRtpTelemetry(settings) {
  const totalBets = Number(settings.dailyTotalBets || 0);
  const totalPayouts = Number(settings.dailyTotalPayouts || 0);
  const actualRtp = totalBets > 0 ? Math.round((totalPayouts / totalBets) * 10000) / 100 : 96;
  const rtpCfg = settings.rtpRiskConfig || defaultRtpRiskConfig();
  return {
    actualRtp,
    targetRtpPct: Number(rtpCfg.targetRtpPct ?? 96),
    dynamicEdgeOffset: Number(rtpCfg.dynamicEdgeOffset ?? 0),
    currentRiskIndex: Number(rtpCfg.currentRiskIndex ?? 15),
    autoAdjustEnabled: rtpCfg.autoAdjustEnabled !== false,
    lastEvaluatedAt: rtpCfg.lastEvaluatedAt || null,
  };
}

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const [settings, pendingCounts] = await Promise.all([
      db.getSettings(),
      db.countPendingTransactions(),
    ]);
    const tolerance = Math.min(10, Math.max(5, Number(settings.varianceTolerancePct || 8)));
    const target = Number(settings.dailyProfitTarget || 0);
    const protectedFloor = Math.round(target * (1 - tolerance / 100));

    const realActiveBets = gameState.bets.filter((b) => !b.isBot);

    res.json({
      settings: {
        whatsappSupportEnabled: settings.whatsappSupportEnabled !== false,
        whatsappSupportNumber: settings.whatsappSupportNumber,
        whatsappChannelEnabled: settings.whatsappChannelEnabled !== false,
        whatsappChannelUrl: settings.whatsappChannelUrl,
        telegramChannelEnabled: settings.telegramChannelEnabled !== false,
        telegramChannelUrl: settings.telegramChannelUrl || 'https://t.me/SkyWingOfficial',
        maskMasterAccounts: settings.maskMasterAccounts !== false,
        paymentAccounts: settings.paymentAccounts,
        financialLimits: settings.financialLimits || defaultFinancialLimits(),
        withdrawalHours: settings.withdrawalHours || defaultWithdrawalHours(),
        platformStatus: settings.platformStatus || defaultPlatformStatus(),
        audioConfig: settings.audioConfig || defaultAudioConfig(),
        profitControl: settings.profitControl || defaultProfitControl(),
        profitDistributionPool: Math.round(Number(settings.profitDistributionPool ?? 10000) * 100) / 100,
        poolStatsByGame: hydratePoolStatsByGame(settings.poolStatsByGame),
        rtpRiskConfig: settings.rtpRiskConfig || defaultRtpRiskConfig(),
        gamesConfig: settings.gamesConfig || defaultGamesConfig(),
        telegramBot: {
          enabled: Boolean(settings.telegramBot?.enabled),
          botToken: settings.telegramBot?.botToken || '',
          adminChatId: settings.telegramBot?.adminChatId || '',
          webhookSecret: settings.telegramBot?.webhookSecret || '',
        },
        securitySummary: {
          totpEnabled: Boolean(settings.security?.totpEnabled),
          masterPasswordSet: Boolean(settings.security?.masterPasswordHash),
        },
        dailyProfitTarget: target,
        varianceTolerancePct: tolerance,
        welcomeBonusCredits: settings.welcomeBonusCredits,
        dailyDateKey: settings.dailyDateKey,
        dailyTotalBets: Math.round((settings.dailyTotalBets || 0) * 100) / 100,
        dailyTotalPayouts: Math.round((settings.dailyTotalPayouts || 0) * 100) / 100,
        dailyNetProfit: Math.round((settings.dailyNetProfit || 0) * 100) / 100,
        carryForwardPool: Math.round(Number(settings.profitDistributionPool ?? settings.carryForwardPool ?? 10000) * 100) / 100,
        protectedFloor,
        roundCounter: settings.roundCounter,
        recentRounds: (settings.recentRounds || []).slice(0, 20),
        syncConfig: settings.syncConfig || defaultSyncConfig(),
      },
      pendingCounts,
      telemetry: computeLiveRtpTelemetry(settings),
      live: {
        onlineSockets: io.engine.clientsCount,
        displayedOnline: getDisplayedOnlineCount(),
        roundNumber: gameState.roundNumber,
        phase: gameState.phase,
        multiplier: gameState.currentMultiplier,
        activeBetCount: realActiveBets.length,
        activeRoundWager: gameState.totalRoundBet,
        nextRoundForcedCrash: gameState.nextRoundForcedCrash,
        serverSeedHash: gameState.serverSeedHash,
        clientSeed: gameState.clientSeed,
        nonce: gameState.nonce,
        databaseMode: isMongoReady() ? 'MongoDB Atlas Connected' : 'Local Fallback Store',
        mongoConnected: isMongoReady(),
        syncStatus: getPublicSyncStatus(settings),
        mongoNotice: lastMongoError
          ? 'MongoDB Atlas unreachable (ensure 0.0.0.0/0 is allowed in Atlas Network Access). Using local fallback store.'
          : '',
      },
    });
  } catch (err) {
    console.error('[Admin Dashboard Error]', err);
    res.status(500).json({ error: 'Failed to load admin dashboard' });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const whatsappSupportEnabled =
      req.body.whatsappSupportEnabled !== undefined
        ? Boolean(req.body.whatsappSupportEnabled)
        : current.whatsappSupportEnabled !== false;
    const whatsappSupportNumber = sanitizeSupportPhone(
      req.body.whatsappSupportNumber ?? current.whatsappSupportNumber
    );
    const whatsappChannelEnabled =
      req.body.whatsappChannelEnabled !== undefined
        ? Boolean(req.body.whatsappChannelEnabled)
        : current.whatsappChannelEnabled !== false;
    const whatsappChannelUrl = String(
      req.body.whatsappChannelUrl ?? current.whatsappChannelUrl
    ).trim();
    const telegramChannelEnabled =
      req.body.telegramChannelEnabled !== undefined
        ? Boolean(req.body.telegramChannelEnabled)
        : current.telegramChannelEnabled !== false;
    const telegramChannelUrl = String(
      req.body.telegramChannelUrl ?? current.telegramChannelUrl ?? 'https://t.me/SkyWingOfficial'
    ).trim();
    const dailyProfitTarget = Math.max(
      0,
      Number(req.body.dailyProfitTarget ?? current.dailyProfitTarget) || 0
    );
    const varianceTolerancePct = Math.min(
      10,
      Math.max(5, Number(req.body.varianceTolerancePct ?? current.varianceTolerancePct) || 8)
    );
    const welcomeBonusCredits = Math.max(
      0,
      Number(req.body.welcomeBonusCredits ?? current.welcomeBonusCredits) || 0
    );

    const incomingPay = req.body.paymentAccounts || {};
    const curPay = current.paymentAccounts || defaultPaymentAccounts();
    const paymentAccounts = {
      easypaisa: {
        enabled:
          incomingPay.easypaisa?.enabled !== undefined
            ? Boolean(incomingPay.easypaisa.enabled)
            : Boolean(curPay.easypaisa?.enabled),
        accountTitle: String(
          incomingPay.easypaisa?.accountTitle ?? curPay.easypaisa?.accountTitle ?? ''
        ).trim(),
        accountNumber: String(
          incomingPay.easypaisa?.accountNumber ?? curPay.easypaisa?.accountNumber ?? ''
        ).trim(),
        iban: normalizePakIban(
          incomingPay.easypaisa?.iban !== undefined
            ? incomingPay.easypaisa.iban
            : curPay.easypaisa?.iban ?? ''
        ),
      },
      jazzcash: {
        enabled:
          incomingPay.jazzcash?.enabled !== undefined
            ? Boolean(incomingPay.jazzcash.enabled)
            : Boolean(curPay.jazzcash?.enabled),
        accountTitle: String(
          incomingPay.jazzcash?.accountTitle ?? curPay.jazzcash?.accountTitle ?? ''
        ).trim(),
        accountNumber: String(
          incomingPay.jazzcash?.accountNumber ?? curPay.jazzcash?.accountNumber ?? ''
        ).trim(),
        iban: normalizePakIban(
          incomingPay.jazzcash?.iban !== undefined
            ? incomingPay.jazzcash.iban
            : curPay.jazzcash?.iban ?? ''
        ),
      },
      bank: {
        enabled:
          incomingPay.bank?.enabled !== undefined
            ? Boolean(incomingPay.bank.enabled)
            : Boolean(curPay.bank?.enabled),
        bankName: String(incomingPay.bank?.bankName ?? curPay.bank?.bankName ?? '').trim(),
        accountTitle: String(
          incomingPay.bank?.accountTitle ?? curPay.bank?.accountTitle ?? ''
        ).trim(),
        accountNumber: String(
          incomingPay.bank?.accountNumber ?? curPay.bank?.accountNumber ?? ''
        ).trim(),
      },
    };

    const incomingAudio = req.body.audioConfig || {};
    const curAudio = current.audioConfig || defaultAudioConfig();
    const nextPreset = ALLOWED_SOUND_PRESETS.includes(incomingAudio.soundPreset)
      ? incomingAudio.soundPreset
      : ALLOWED_SOUND_PRESETS.includes(curAudio.soundPreset)
        ? curAudio.soundPreset
        : 'aviator-jet';
    const rawVol =
      incomingAudio.masterVolume !== undefined
        ? Number(incomingAudio.masterVolume)
        : Number(curAudio.masterVolume ?? 75);
    const audioConfig = {
      bgmEnabled:
        incomingAudio.bgmEnabled !== undefined
          ? Boolean(incomingAudio.bgmEnabled)
          : Boolean(curAudio.bgmEnabled),
      soundPreset: nextPreset,
      masterVolume: Number.isFinite(rawVol) ? Math.min(100, Math.max(0, Math.round(rawVol))) : 75,
    };

    const incomingProfit = req.body.profitControl || {};
    const curProfit = current.profitControl || defaultProfitControl();
    const nextProfitMode = ALLOWED_PROFIT_MODES.includes(incomingProfit.mode)
      ? incomingProfit.mode
      : ALLOWED_PROFIT_MODES.includes(curProfit.mode)
        ? curProfit.mode
        : 'balanced';
    const rawEdge =
      incomingProfit.houseEdgePct !== undefined
        ? Number(incomingProfit.houseEdgePct)
        : Number(curProfit.houseEdgePct ?? 4);
    const rawCap =
      incomingProfit.maxCrashCap !== undefined
        ? Number(incomingProfit.maxCrashCap)
        : Number(curProfit.maxCrashCap ?? 100);
    const profitControl = {
      mode: nextProfitMode,
      houseEdgePct: Number.isFinite(rawEdge)
        ? Math.min(25, Math.max(0, Math.round(rawEdge * 10) / 10))
        : 4,
      maxCrashCap: Number.isFinite(rawCap)
        ? Math.min(100, Math.max(1.05, Math.round(rawCap * 100) / 100))
        : 100,
    };

    const unifiedPool = Math.max(0, Number(current.profitDistributionPool ?? current.carryForwardPool ?? 10000));

    const updated = await db.updateSettings({
      whatsappSupportEnabled,
      whatsappSupportNumber: whatsappSupportNumber || current.whatsappSupportNumber,
      whatsappChannelEnabled,
      whatsappChannelUrl: whatsappChannelUrl || current.whatsappChannelUrl,
      telegramChannelEnabled,
      telegramChannelUrl: telegramChannelUrl || current.telegramChannelUrl || 'https://t.me/SkyWingOfficial',
      paymentAccounts,
      audioConfig,
      profitControl,
      dailyProfitTarget,
      varianceTolerancePct,
      welcomeBonusCredits,
      profitDistributionPool: unifiedPool,
      carryForwardPool: unifiedPool,
    });

    io.emit('settings:updated', buildPublicSettingsPayload(updated));

    res.json({ settings: updated });
  } catch (err) {
    console.error('[Admin Settings Update Error]', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Admin Financial Limits, Operating Hours, Maintenance, Games Hub, RTP Risk, Security & Reports
app.put('/api/admin/financial-limits', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const curLim = current.financialLimits || defaultFinancialLimits();
    const financialLimits = {
      minDeposit: Math.max(10, Number(req.body.minDeposit ?? curLim.minDeposit) || 50),
      minWithdrawal: Math.max(10, Number(req.body.minWithdrawal ?? curLim.minWithdrawal) || 100),
      withdrawalFeePct: Math.min(25, Math.max(0, Number(req.body.withdrawalFeePct ?? curLim.withdrawalFeePct) || 0)),
      microDepositAutoApproveLimit: Math.max(
        0,
        Number(req.body.microDepositAutoApproveLimit ?? curLim.microDepositAutoApproveLimit) || 0
      ),
    };
    const maskMasterAccounts =
      req.body.maskMasterAccounts !== undefined
        ? Boolean(req.body.maskMasterAccounts)
        : current.maskMasterAccounts !== false;
    const profitDistributionPool =
      req.body.profitDistributionPool !== undefined
        ? Math.max(0, Math.round((Number(req.body.profitDistributionPool) || 0) * 100) / 100)
        : Math.max(0, Number(current.profitDistributionPool ?? 10000));

    const updated = await db.updateSettings({
      financialLimits,
      maskMasterAccounts,
      profitDistributionPool,
      carryForwardPool: profitDistributionPool,
    });
    io.emit('settings:updated', buildPublicSettingsPayload(updated));
    io.to('admins').emit('admin:pool_updated', {
      profitDistributionPool,
      carryForwardPool: profitDistributionPool,
      dailyTotalBets: Number(updated.dailyTotalBets || 0),
      dailyTotalPayouts: Number(updated.dailyTotalPayouts || 0),
      dailyNetProfit: Number(updated.dailyNetProfit || 0),
      poolStatsByGame: hydratePoolStatsByGame(updated.poolStatsByGame),
    });
    res.json({
      financialLimits: updated.financialLimits,
      maskMasterAccounts: updated.maskMasterAccounts,
      profitDistributionPool: updated.profitDistributionPool,
      carryForwardPool: updated.profitDistributionPool,
    });
  } catch {
    res.status(500).json({ error: 'Failed to save financial limits.' });
  }
});

app.put('/api/admin/withdrawal-hours', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const curWh = current.withdrawalHours || defaultWithdrawalHours();
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const openTime = timeRegex.test(String(req.body.openTime || '')) ? req.body.openTime : curWh.openTime;
    const closeTime = timeRegex.test(String(req.body.closeTime || '')) ? req.body.closeTime : curWh.closeTime;
    const withdrawalHours = {
      enabled: req.body.enabled !== undefined ? Boolean(req.body.enabled) : Boolean(curWh.enabled),
      openTime,
      closeTime,
      noticeText: String(req.body.noticeText ?? curWh.noticeText).trim().slice(0, 200) || 'Withdrawals are only open from 9:00 AM to 5:00 PM.',
    };
    const updated = await db.updateSettings({ withdrawalHours });
    io.emit('settings:updated', buildPublicSettingsPayload(updated));
    res.json({ withdrawalHours: updated.withdrawalHours });
  } catch {
    res.status(500).json({ error: 'Failed to update withdrawal operating hours.' });
  }
});

app.put('/api/admin/platform-status', requireAdmin, async (req, res) => {
  try {
    const mode = ['active', 'maintenance', 'disabled'].includes(req.body.mode) ? req.body.mode : 'active';
    const message = String(req.body.message || '').trim().slice(0, 300) || defaultPlatformStatus().message;
    const masterPassword = String(req.body.masterPassword || '');

    if (mode !== 'active') {
      const okMaster = await verifyMasterPassword(masterPassword);
      if (!okMaster) {
        await logSecurityEvent('Unauthorized Maintenance Switch Attempt', 'critical', `Attempted to switch platform to ${mode} with invalid Master Password`, getClientIp(req));
        return res.status(403).json({ error: 'Invalid Master Password. Maintenance / Disable switch denied.' });
      }
    }

    const platformStatus = { mode, message };
    const updated = await db.updateSettings({ platformStatus });
    await logSecurityEvent('Platform Status Changed', mode === 'active' ? 'info' : 'critical', `Platform mode set to "${mode}"`, getClientIp(req));
    io.emit('platform:status', platformStatus);
    io.emit('settings:updated', buildPublicSettingsPayload(updated));
    res.json({ platformStatus: updated.platformStatus });
  } catch {
    res.status(500).json({ error: 'Failed to update platform status.' });
  }
});

app.put('/api/admin/games-config', requireAdmin, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.gamesConfig)
      ? req.body.gamesConfig
      : req.body.game && req.body.game.id
        ? [req.body.game]
        : [];
    const current = await db.getSettings();
    const curGames = hydrateGamesConfig(current.gamesConfig);
    const nextGames = curGames.map((g) => {
      const match = incoming.find((item) => item && item.id === g.id);
      if (!match) return g;
      return {
        id: g.id,
        name: String(match.name || g.name).trim().slice(0, 40),
        tagline: String(match.tagline || g.tagline).trim().slice(0, 80),
        enabled: match.enabled !== undefined ? Boolean(match.enabled) : g.enabled,
        houseEdgePct: Math.min(25, Math.max(0, Number(match.houseEdgePct ?? g.houseEdgePct) || 4)),
        minBet: Math.max(1, Number(match.minBet ?? g.minBet) || 1),
        maxBet: Math.max(10, Number(match.maxBet ?? g.maxBet) || 50000),
      };
    });
    const updated = await db.updateSettings({ gamesConfig: nextGames });
    io.emit('settings:updated', buildPublicSettingsPayload(updated));
    res.json({ gamesConfig: updated.gamesConfig });
  } catch {
    res.status(500).json({ error: 'Failed to update games configuration.' });
  }
});

app.put('/api/admin/rtp-risk', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const cur = current.rtpRiskConfig || defaultRtpRiskConfig();
    const rtpRiskConfig = {
      ...cur,
      autoAdjustEnabled: req.body.autoAdjustEnabled !== undefined ? Boolean(req.body.autoAdjustEnabled) : cur.autoAdjustEnabled,
      targetRtpPct: Math.min(99, Math.max(75, Number(req.body.targetRtpPct ?? cur.targetRtpPct) || 96)),
      dynamicEdgeOffset: Math.min(8, Math.max(-3, Number(req.body.dynamicEdgeOffset ?? cur.dynamicEdgeOffset) || 0)),
    };
    const updated = await db.updateSettings({ rtpRiskConfig });
    res.json({ rtpRiskConfig: updated.rtpRiskConfig, telemetry: computeLiveRtpTelemetry(updated) });
  } catch {
    res.status(500).json({ error: 'Failed to update RTP risk settings.' });
  }
});

// Admin Cross-Instance Live Sync Config & Test
app.put('/api/admin/sync-config', requireAdmin, async (req, res) => {
  try {
    const mode = ['auto', 'standalone', 'mirror'].includes(req.body.mode) ? req.body.mode : 'auto';
    let remoteLiveUrl = String(req.body.remoteLiveUrl || '').trim().replace(/\/+$/, '');
    if (remoteLiveUrl) {
      let parsed;
      try {
        parsed = new URL(remoteLiveUrl);
      } catch {
        return res.status(400).json({ error: 'Enter a valid http:// or https:// Live Site URL.' });
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Live Site URL must start with http:// or https://' });
      }
      remoteLiveUrl = parsed.origin;
    }

    const updated = await db.updateSettings({
      syncConfig: {
        mode,
        remoteLiveUrl,
        updatedAt: new Date(),
      },
    });
    await applySyncCoordinator(true);
    await logSecurityEvent('Live Sync Config Updated', 'info', `Mode: ${mode} | URL: ${remoteLiveUrl || 'None'}`, getClientIp(req));
    res.json({
      syncConfig: updated.syncConfig,
      syncStatus: getPublicSyncStatus(updated),
    });
  } catch (err) {
    console.error('[Sync Config Error]', err);
    res.status(500).json({ error: 'Failed to update sync configuration.' });
  }
});

app.post('/api/admin/sync-test', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const rawUrl = String(req.body.remoteLiveUrl ?? settings.syncConfig?.remoteLiveUrl ?? ENV_LIVE_SYNC_URL ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (!rawUrl) {
      return res.status(400).json({ error: 'Enter a Remote Live Site URL first.' });
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format.' });
    }
    const targetUrl = `${parsed.origin}/api/sync/state`;
    const started = Date.now();
    const resp = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return res.status(502).json({ error: `Remote server responded with HTTP ${resp.status}.` });
    }
    const data = await resp.json();
    const latencyMs = Date.now() - started;
    if (data.instanceId === INSTANCE_ID) {
      return res.status(400).json({
        error: 'This URL points to the current server instance itself. Enter the remote deployment URL.',
      });
    }
    res.json({
      ok: true,
      latencyMs,
      remoteInstanceId: data.instanceId || '',
      remoteDatabase: data.database || 'unknown',
      roundNumber: data.roundState?.roundNumber || data.roundCounter || 0,
      phase: data.roundState?.phase || 'BETTING',
      multiplier: data.roundState?.currentMultiplier || 1,
    });
  } catch (err) {
    res.status(502).json({ error: `Unable to reach remote live site: ${err.message}` });
  }
});

// Admin Security: Master Password + 2FA Setup + Fraud Logs
app.get('/api/admin/security/overview', requireAdmin, async (req, res) => {
  try {
    const [settings, users] = await Promise.all([db.getSettings(), db.searchUsers('')]);
    const flaggedUsers = users.filter((u) => u.bonusRestricted).map(sanitizeUser);
    res.json({
      totpEnabled: Boolean(settings.security?.totpEnabled),
      securityLogs: (settings.security?.securityLogs || []).slice(0, 50),
      flaggedUsers,
    });
  } catch {
    res.status(500).json({ error: 'Failed to load security overview.' });
  }
});

app.post('/api/admin/security/master-password', requireAdmin, async (req, res) => {
  try {
    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New Master Password must be at least 6 characters.' });
    }
    const okOld = await verifyMasterPassword(oldPassword);
    if (!okOld) {
      await logSecurityEvent('Master Password Change Denied', 'critical', 'Old master password mismatch', getClientIp(req));
      return res.status(403).json({ error: 'Current Master Password is incorrect.' });
    }
    const settings = await db.getSettings();
    const masterPasswordHash = await bcrypt.hash(newPassword, 10);
    await db.updateSettings({
      security: { ...settings.security, masterPasswordHash },
    });
    await logSecurityEvent('Master Password Updated', 'info', 'Admin updated Master Password', getClientIp(req));
    res.json({ ok: true, message: 'Master Password updated successfully.' });
  } catch {
    res.status(500).json({ error: 'Failed to update Master Password.' });
  }
});

app.post('/api/admin/security/2fa/setup', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const secret = generateBase32Secret(20);
    const otpauthUrl = `otpauth://totp/SkyWingAdmin:${ADMIN_USERNAME}?secret=${secret}&issuer=SkyWingCrash`;
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 220, margin: 2 });
    await db.updateSettings({
      security: { ...settings.security, totpSecret: secret, totpEnabled: false },
    });
    res.json({ secret, otpauthUrl, qrDataUrl });
  } catch {
    res.status(500).json({ error: 'Failed to generate 2FA secret.' });
  }
});

app.post('/api/admin/security/2fa/verify', requireAdmin, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    const settings = await db.getSettings();
    const secret = settings.security?.totpSecret;
    if (!secret) {
      return res.status(400).json({ error: 'Generate a 2FA QR secret first.' });
    }
    if (!verifyTotp(secret, code)) {
      return res.status(400).json({ error: 'Invalid 6-digit Authenticator code.' });
    }
    await db.updateSettings({
      security: { ...settings.security, totpEnabled: true },
    });
    await logSecurityEvent('Admin 2FA Enabled', 'info', 'Google Authenticator TOTP 2FA enabled', getClientIp(req));
    res.json({ ok: true, totpEnabled: true });
  } catch {
    res.status(500).json({ error: 'Failed to verify 2FA.' });
  }
});

app.post('/api/admin/security/2fa/disable', requireAdmin, async (req, res) => {
  try {
    const masterPassword = String(req.body.masterPassword || '');
    const okMaster = await verifyMasterPassword(masterPassword);
    if (!okMaster) {
      return res.status(403).json({ error: 'Valid Master Password required to disable 2FA.' });
    }
    const settings = await db.getSettings();
    await db.updateSettings({
      security: { ...settings.security, totpEnabled: false, totpSecret: '' },
    });
    await logSecurityEvent('Admin 2FA Disabled', 'warning', '2FA disabled using Master Password', getClientIp(req));
    res.json({ ok: true, totpEnabled: false });
  } catch {
    res.status(500).json({ error: 'Failed to disable 2FA.' });
  }
});

// Admin Telegram Bot Config & Test
app.put('/api/admin/telegram', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const cur = current.telegramBot || defaultTelegramBotConfig();
    const telegramBot = {
      enabled: req.body.enabled !== undefined ? Boolean(req.body.enabled) : Boolean(cur.enabled),
      botToken: String(req.body.botToken ?? cur.botToken).trim(),
      adminChatId: String(req.body.adminChatId ?? cur.adminChatId).trim(),
      webhookSecret: String(req.body.webhookSecret ?? cur.webhookSecret).trim(),
    };
    const updated = await db.updateSettings({ telegramBot });
    res.json({ telegramBot: updated.telegramBot });
  } catch {
    res.status(500).json({ error: 'Failed to save Telegram bot settings.' });
  }
});

app.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const ok = await sendTelegramAlert(
      settings,
      `🛸 <b>SkyWing Operations Test Alert</b>\nTelegram Bot integration is active and ready for deposit, withdrawal, and security alerts!`
    );
    if (!ok) {
      return res.status(400).json({ error: 'Failed to send test alert. Verify Bot Token, Chat ID, and Enabled switch.' });
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Telegram test failed.' });
  }
});

// Admin Support Ticket Queue
app.get('/api/admin/support/tickets', requireAdmin, async (req, res) => {
  try {
    const tickets = await db.listAllSupportTickets();
    res.json({ tickets });
  } catch {
    res.status(500).json({ error: 'Failed to load support tickets.' });
  }
});

app.post('/api/admin/support/tickets/:id/reply', requireAdmin, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim().slice(0, 1000);
    const imageData = sanitizeSupportImageData(req.body.imageData);
    if (!text && !imageData) {
      return res.status(400).json({ error: 'Reply text or image attachment is required.' });
    }
    const updated = await db.addSupportMessage(req.params.id, 'admin', text, imageData);
    if (!updated) return res.status(404).json({ error: 'Ticket not found.' });
    emitToUser(updated.userId, 'support:ticket_updated', updated);
    io.to('admins').emit('support:ticket_updated', updated);
    res.json({ ticket: updated });
  } catch {
    res.status(500).json({ error: 'Failed to send admin reply.' });
  }
});

app.post('/api/admin/support/tickets/:id/close', requireAdmin, async (req, res) => {
  try {
    const updated = await db.closeSupportTicket(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Ticket not found.' });
    emitToUser(updated.userId, 'support:ticket_updated', updated);
    io.to('admins').emit('support:ticket_updated', updated);
    res.json({ ticket: updated });
  } catch {
    res.status(500).json({ error: 'Failed to close ticket.' });
  }
});

// Admin Financial Reports & UTF-8 BOM CSV/Excel Export
app.get('/api/admin/reports/transactions', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const type = String(req.query.type || 'all');
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');
    const list = await db.listAdminTransactions({ status, type, startDate, endDate, limit: 500 });
    res.json({ transactions: list.map(sanitizeTransaction) });
  } catch {
    res.status(500).json({ error: 'Failed to load financial report.' });
  }
});

app.get('/api/admin/reports/export.csv', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const type = String(req.query.type || 'all');
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');
    const list = await db.listAdminTransactions({ status, type, startDate, endDate, limit: 2000 });

    const csvEscape = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const headers = [
      'Transaction ID',
      'Date',
      'Type',
      'Status',
      'User Phone',
      'Display Name',
      'Method',
      'Gross Amount (PKR)',
      'Fee (PKR)',
      'Net Amount (PKR)',
      'TID / Reference',
      'Auto Approved',
      'Payout Title',
      'Payout Account',
      'CNIC',
      'Rejection Reason',
    ];
    const rows = list.map((t) => [
      String(t._id),
      new Date(t.createdAt).toISOString(),
      t.type,
      t.status,
      t.phoneNumber,
      t.displayName,
      t.method,
      t.amount,
      t.feeAmount || 0,
      t.netAmount ?? t.amount,
      t.transactionId || t.qrReference || '',
      t.autoApproved ? 'YES' : 'NO',
      t.accountDetails?.accountTitle || '',
      t.accountDetails?.accountNumber || '',
      t.accountDetails?.cnic || '',
      t.rejectionReason || '',
    ]);
    const csvBody =
      '\uFEFF' + [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="skywing-audit-${getTodayKey()}.csv"`);
    res.send(csvBody);
  } catch {
    res.status(500).json({ error: 'Failed to export CSV audit.' });
  }
});

// Admin Profit Control & Multiplier Override Endpoints
app.put('/api/admin/profit-control', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const curProfit = current.profitControl || defaultProfitControl();
    const mode = ALLOWED_PROFIT_MODES.includes(req.body.mode) ? req.body.mode : curProfit.mode;
    const rawEdge =
      req.body.houseEdgePct !== undefined ? Number(req.body.houseEdgePct) : Number(curProfit.houseEdgePct ?? 4);
    const rawCap =
      req.body.maxCrashCap !== undefined ? Number(req.body.maxCrashCap) : Number(curProfit.maxCrashCap ?? 100);

    const profitControl = {
      mode,
      houseEdgePct: Number.isFinite(rawEdge)
        ? Math.min(25, Math.max(0, Math.round(rawEdge * 10) / 10))
        : 4,
      maxCrashCap: Number.isFinite(rawCap)
        ? Math.min(100, Math.max(1.05, Math.round(rawCap * 100) / 100))
        : 100,
    };

    const updated = await db.updateSettings({ profitControl });
    res.json({ profitControl: updated.profitControl || profitControl });
  } catch (err) {
    console.error('[Admin Profit Control Error]', err);
    res.status(500).json({ error: 'Failed to update profit control settings' });
  }
});

app.post('/api/admin/profit-control/override', requireAdmin, (req, res) => {
  const raw = req.body.forcedCrash;
  if (raw === null || raw === undefined || raw === '') {
    gameState.nextRoundForcedCrash = null;
    io.to('admins').emit('admin:profit_override', { nextRoundForcedCrash: null });
    return res.json({ nextRoundForcedCrash: null });
  }
  const val = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(val) || val < 1.0 || val > 100.0) {
    return res.status(400).json({ error: 'Multiplier override must be between 1.00x and 100.00x.' });
  }
  gameState.nextRoundForcedCrash = val;
  io.to('admins').emit('admin:profit_override', { nextRoundForcedCrash: val });
  return res.json({ nextRoundForcedCrash: val });
});

app.post('/api/admin/profit-control/crash-now', requireAdmin, async (req, res) => {
  if (gameState.phase !== 'FLYING') {
    return res.status(400).json({ error: 'No active flight in progress right now.' });
  }
  const crashAt = Math.max(1.0, gameState.currentMultiplier);
  await triggerCrash(crashAt);
  return res.json({ ok: true, crashedAt: crashAt });
});

app.post('/api/admin/reset-daily-stats', requireAdmin, async (req, res) => {
  try {
    const current = await db.getSettings();
    const unifiedPool = Math.max(0, Number(current.profitDistributionPool ?? 10000));
    const updated = await db.updateSettings({
      dailyDateKey: getTodayKey(),
      dailyTotalBets: 0,
      dailyTotalPayouts: 0,
      dailyNetProfit: 0,
      carryForwardPool: unifiedPool,
      poolStatsByGame: defaultPoolStatsByGame(),
    });
    res.json({ settings: updated });
  } catch {
    res.status(500).json({ error: 'Failed to reset daily stats' });
  }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const type = String(req.query.type || 'all');
    const [list, pendingCounts] = await Promise.all([
      db.listAdminTransactions({ status, type, limit: 120 }),
      db.countPendingTransactions(),
    ]);
    res.json({ transactions: list.map(sanitizeTransaction), pendingCounts });
  } catch {
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

app.post('/api/admin/transactions/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existingTx = await db.findTransactionById(id);
    if (!existingTx || existingTx.status !== 'pending') {
      return res.status(409).json({ error: 'Transaction not found or already reviewed.' });
    }

    if (existingTx.type === 'withdrawal') {
      const targetUser = await db.findUserById(existingTx.userId);
      if (!targetUser) {
        return res.status(404).json({ error: 'User account not found.' });
      }
      const totalDep = Math.round(Number(targetUser.totalDeposited || 0) * 100) / 100;
      const totalWagered = Math.round(Number(targetUser.totalWageredReal || 0) * 100) / 100;
      if (totalWagered < totalDep) {
        const remaining = Math.round((totalDep - totalWagered) * 100) / 100;
        return res.status(400).json({
          error: `Cannot approve withdrawal: user has not met 1x wagering rule (Wagered ${totalWagered.toLocaleString()} / ${totalDep.toLocaleString()} PKR; ${remaining.toLocaleString()} PKR remaining). Reject or wait until wagered.`,
        });
      }
    }

    const resolved = await db.resolveTransactionIfPending(id, 'approved', '');
    if (!resolved) {
      return res.status(409).json({ error: 'Transaction not found or already reviewed.' });
    }

    let updatedUser = null;
    if (resolved.type === 'deposit') {
      await db.adjustBalanceAtomic(resolved.userId, 'real', resolved.amount);
      updatedUser = await db.updateUserById(resolved.userId, {
        $inc: { totalDeposited: resolved.amount },
      });
      await grantFirstDepositReferralRewardIfEligible(resolved.userId, resolved.amount);
    } else {
      updatedUser = await db.updateUserById(resolved.userId, {
        $inc: { totalWithdrawn: resolved.amount },
      });
    }

    if (updatedUser) {
      emitUserBalances(updatedUser);
    }

    const cleanTx = sanitizeTransaction(resolved);
    emitToUser(resolved.userId, 'transaction:updated', cleanTx);
    io.to('admins').emit('admin:transaction_resolved', cleanTx);

    res.json({ transaction: cleanTx, user: sanitizeUser(updatedUser) });
  } catch (err) {
    console.error('[Approve Tx Error]', err);
    res.status(500).json({ error: 'Failed to approve transaction.' });
  }
});

app.post('/api/admin/transactions/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const rejectionReason = String(req.body.rejectionReason || '').trim().slice(0, 200);
    if (!rejectionReason) {
      return res.status(400).json({ error: 'A rejection reason is mandatory.' });
    }

    const resolved = await db.resolveTransactionIfPending(id, 'rejected', rejectionReason);
    if (!resolved) {
      return res.status(409).json({ error: 'Transaction not found or already reviewed.' });
    }

    let updatedUser = null;
    if (resolved.type === 'withdrawal') {
      // Refund deducted withdrawal amount back to realBalance
      updatedUser = await db.adjustBalanceAtomic(resolved.userId, 'real', resolved.amount);
    } else {
      updatedUser = await db.findUserById(resolved.userId);
    }

    if (updatedUser) {
      emitUserBalances(updatedUser);
    }

    const cleanTx = sanitizeTransaction(resolved);
    emitToUser(resolved.userId, 'transaction:updated', cleanTx);
    io.to('admins').emit('admin:transaction_resolved', cleanTx);

    res.json({ transaction: cleanTx, user: sanitizeUser(updatedUser) });
  } catch (err) {
    console.error('[Reject Tx Error]', err);
    res.status(500).json({ error: 'Failed to reject transaction.' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const users = await db.searchUsers(q);
    res.json({ users: users.map(sanitizeUser) });
  } catch {
    res.status(500).json({ error: 'Failed to search users' });
  }
});

app.post('/api/admin/users/:id/credits', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const action = String(req.body.action || 'add');
    const currencyMode = req.body.currencyMode === 'real' ? 'real' : 'fun';
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Enter a valid non-negative amount.' });
    }

    const targetUser = await db.findUserById(id);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const field = currencyMode === 'real' ? 'realBalance' : 'funBalance';
    const currentVal = Number(
      field === 'funBalance'
        ? targetUser.funBalance ?? targetUser.funCredits ?? 0
        : targetUser.realBalance ?? 0
    );

    let updated;
    if (action === 'add') {
      updated = await db.adjustBalanceAtomic(id, currencyMode, amount);
    } else if (action === 'deduct') {
      const deductAmt = Math.min(amount, currentVal);
      updated = await db.adjustBalanceAtomic(id, currencyMode, -deductAmt);
    } else if (action === 'set') {
      const setVal = Math.round(amount * 100) / 100;
      const patch = { [field]: setVal };
      if (field === 'funBalance') patch.funCredits = setVal;
      updated = await db.updateUserById(id, { $set: patch });
    } else {
      return res.status(400).json({ error: 'Invalid balance action.' });
    }

    if (updated) {
      emitUserBalances(updated);
    }

    res.json({ user: sanitizeUser(updated) });
  } catch (err) {
    console.error('[Admin Credits Error]', err);
    res.status(500).json({ error: 'Failed to update user balance.' });
  }
});

app.post('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await db.updateUserById(id, {
      $set: { passwordHash },
      $inc: { tokenVersion: 1 },
    });
    if (!updated) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true, user: sanitizeUser(updated) });
  } catch {
    res.status(500).json({ error: 'Failed to reset user password.' });
  }
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const isBanned = Boolean(req.body.isBanned);
    const updated = await db.updateUserById(id, { $set: { isBanned } });
    if (!updated) return res.status(404).json({ error: 'User not found.' });

    if (isBanned) {
      emitToUser(String(updated._id), 'account:banned', {
        reason: 'Your account has been suspended by Admin.',
      });
    }
    res.json({ user: sanitizeUser(updated) });
  } catch {
    res.status(500).json({ error: 'Failed to update account status.' });
  }
});

// ============================================================================
// Real-Time Crash Game Engine + Profit-Pool Distribution
// ============================================================================
const userSocketsMap = new Map(); // userId -> Set<socket>

function registerUserSocket(userId, socket) {
  if (!userSocketsMap.has(userId)) {
    userSocketsMap.set(userId, new Set());
  }
  userSocketsMap.get(userId).add(socket);
}

function unregisterUserSocket(userId, socket) {
  const set = userSocketsMap.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) userSocketsMap.delete(userId);
}

function emitToUser(userId, event, payload) {
  const set = userSocketsMap.get(String(userId));
  if (!set) return;
  for (const sock of set) {
    sock.emit(event, payload);
  }
}

function emitUserBalances(user) {
  if (!user) return;
  const funBalance = Math.round(Number(user.funBalance ?? user.funCredits ?? 0) * 100) / 100;
  const realBalance = Math.round(Number(user.realBalance ?? 0) * 100) / 100;
  emitToUser(String(user._id), 'balance:update', {
    funBalance,
    realBalance,
    funCredits: funBalance,
  });
}

const BOT_PLAYER_NAMES = [
  'Ali_Khan',
  'Bilal786',
  'Zara_Pk',
  'KingOfSky',
  'Hamza_Lhr',
  'UsmanPro',
  'Sana_KHI',
  'Faisal_77',
  'AyeshaSky',
  'Noman_ISB',
  'TariqFly',
  'Hira_RWP',
  'Saad_99',
  'ZainabPK',
  'HassanJet',
  'Mahnoor_X',
  'Kashif_512',
  'Omer_FSD',
  'Raza_King',
  'Imran_Fly',
  'FarhanPK',
  'Sadia_786',
  'Kamran_Ace',
  'Danish_Jet',
  'Ahsan_92',
  'NadiaFly',
  'Waqar_PK',
  'TaimoorSky',
];

let simulatedOnlineCrowd = 48;
let botBetTimers = [];

function getDisplayedOnlineCount() {
  return io.engine.clientsCount + simulatedOnlineCrowd;
}

function clearBotBetTimers() {
  for (const t of botBetTimers) clearTimeout(t);
  botBetTimers = [];
}

function scheduleSimulatedRoundBets(roundNum) {
  clearBotBetTimers();
  const count = 11 + Math.floor(Math.random() * 8); // 11..18 simulated bets per flight
  const shuffled = BOT_PLAYER_NAMES.slice().sort(() => Math.random() - 0.5).slice(0, count);
  const realStakes = [50, 100, 150, 200, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];
  const funStakes = [25, 50, 100, 250, 500, 1000, 2500];

  shuffled.forEach((name, idx) => {
    const delayMs = 220 + Math.floor((idx / count) * 3900) + Math.floor(Math.random() * 320);
    const timer = setTimeout(() => {
      if (gameState.phase !== 'BETTING' || gameState.roundNumber !== roundNum) return;

      const currencyMode = Math.random() < 0.6 ? 'real' : 'fun';
      const pool = currencyMode === 'real' ? realStakes : funStakes;
      const amount = pool[Math.floor(Math.random() * pool.length)];

      // Realistic cashout curve (some low scalps, some mid, occasional high riders)
      const r = Math.random();
      let botTargetMult;
      if (r < 0.52) botTargetMult = 1.15 + Math.random() * 0.8;
      else if (r < 0.84) botTargetMult = 1.95 + Math.random() * 2.1;
      else botTargetMult = 4.1 + Math.random() * 7.5;
      botTargetMult = Math.round(botTargetMult * 100) / 100;

      const botBet = {
        id: `${roundNum}-sim-${idx + 1}`,
        userId: `sim-${idx + 1}-${name}`,
        displayName: name,
        slot: 1,
        currencyMode,
        amount,
        autoCashout: null,
        botTargetMult,
        isBot: true,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
      };

      gameState.bets.push(botBet);
      io.emit('bet:placed', {
        id: botBet.id,
        userId: botBet.userId,
        player: botBet.displayName,
        slot: botBet.slot,
        currencyMode: botBet.currencyMode,
        amount: botBet.amount,
        autoCashout: null,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
      });
    }, delayMs);

    botBetTimers.push(timer);
  });
}

const gameState = {
  phase: 'BETTING',
  currentRoundId: 1001,
  roundNumber: 1001,
  nonce: 1001,
  clientSeed: `skywing-${getTodayKey()}`,
  nextClientSeedOverride: '',
  nextRoundForcedCrash: null,
  serverSeed: '',
  serverSeedHash: '',
  bettingEndsAt: Date.now() + BETTING_DURATION_MS,
  flightStartedAt: 0,
  crashedAt: 0,
  crashHoldEndsAt: 0,
  currentMultiplier: 1.0,
  scheduledCrashPoint: 2.0,
  maxAllowedRoundPayout: Infinity,
  protectionActive: false,
  totalRoundBet: 0,
  totalRealRoundBet: 0,
  totalRoundPayouts: 0,
  totalRealRoundPayouts: 0,
  bets: [],
  history: [],
  plinkoHistory: [],
  minesHistory: [],
  diceHistory: [],
  limboHistory: [],
  coinflipHistory: [],
  wheelHistory: [],
  hiloHistory: [],
  slotsHistory: [],
};

let tickTimer = null;
let phaseTimer = null;
let bettingTransitionInFlight = false;
let flightTickInFlight = false;

let syncPollTimer = null;
let leaseRenewTimer = null;
let mirrorTickTimer = null;
let mirroredPublicSettings = null;
let lastMirrorSettingsJson = '';
let lastMirrorRound = 0;
let lastMirrorPhase = '';
let lastMongoSnapshotWriteAt = 0;

const runtimeSyncState = {
  instanceId: INSTANCE_ID,
  role: 'standalone-master',
  mode: 'auto',
  remoteUrl: '',
  isFollower: false,
  lastSyncAt: null,
  lastError: '',
  remoteDatabase: '',
  remoteInstanceId: '',
};

function getPublicSyncStatus(settings) {
  return {
    ...runtimeSyncState,
    configuredMode: settings?.syncConfig?.mode || 'auto',
    configuredRemoteUrl: settings?.syncConfig?.remoteLiveUrl || ENV_LIVE_SYNC_URL || '',
    mongoConnected: isMongoReady(),
    currentRoundNumber: gameState.roundNumber,
    currentPhase: gameState.phase,
  };
}

function stopAllRoundAndSyncTimers() {
  clearTimeout(phaseTimer);
  clearInterval(tickTimer);
  clearTimeout(syncPollTimer);
  clearInterval(leaseRenewTimer);
  clearInterval(mirrorTickTimer);
  clearBotBetTimers();
  phaseTimer = null;
  tickTimer = null;
  syncPollTimer = null;
  leaseRenewTimer = null;
  mirrorTickTimer = null;
  bettingTransitionInFlight = false;
  flightTickInFlight = false;
}

async function publishLiveRoundIfMaster(force = false) {
  if (!isMongoReady() || runtimeSyncState.isFollower) return;
  const now = Date.now();
  if (!force && now - lastMongoSnapshotWriteAt < 350) return;
  lastMongoSnapshotWriteAt = now;
  await db.writeLiveRoundSnapshot(
    INSTANCE_ID,
    {
      roundNumber: gameState.roundNumber,
      currentRoundId: gameState.currentRoundId,
      phase: gameState.phase,
      bettingEndsAt: gameState.bettingEndsAt,
      flightStartedAt: gameState.flightStartedAt,
      crashedAt: gameState.crashedAt,
      crashHoldEndsAt: gameState.crashHoldEndsAt,
      currentMultiplier: gameState.currentMultiplier,
      scheduledCrashPoint: gameState.scheduledCrashPoint,
      serverSeed: gameState.serverSeed,
      serverSeedHash: gameState.serverSeedHash,
      clientSeed: gameState.clientSeed,
      nonce: gameState.nonce,
      bets: gameState.bets.slice(0, 60),
    },
    4500
  );
}

function buildAuthoritativeState(includeDetails = false) {
  const now = Date.now();
  const phase = gameState.phase;
  const flightState = String(phase || 'BETTING').toLowerCase();
  const countdownRemainingMs =
    phase === 'BETTING' ? Math.max(0, gameState.bettingEndsAt - now) : 0;
  const elapsedMs =
    phase === 'FLYING' && gameState.flightStartedAt > 0
      ? Math.max(0, now - gameState.flightStartedAt)
      : 0;
  const crashHoldRemainingMs =
    phase === 'CRASHED' && gameState.crashHoldEndsAt > 0
      ? Math.max(0, gameState.crashHoldEndsAt - now)
      : 0;

  const payload = {
    currentRoundId: gameState.currentRoundId,
    roundNumber: gameState.roundNumber,
    phase,
    flightState,
    multiplier: gameState.currentMultiplier,
    currentMultiplier: gameState.currentMultiplier,
    crashPoint: phase === 'CRASHED' ? gameState.currentMultiplier : null,
    serverTimestamp: now,
    serverTickTimestamp: now,
    bettingDurationMs: BETTING_DURATION_MS,
    countdownRemainingMs,
    elapsedMs,
    crashHoldRemainingMs,
    bettingEndsAt: gameState.bettingEndsAt,
    flightStartedAt: gameState.flightStartedAt,
    crashedAt: gameState.crashedAt,
    serverSeedHash: gameState.serverSeedHash,
    clientSeed: gameState.clientSeed,
    nonce: gameState.nonce,
  };

  if (phase === 'CRASHED' && gameState.serverSeed) {
    payload.serverSeed = gameState.serverSeed;
  }

  if (includeDetails) {
    payload.bets = publicBetsList();
    payload.history = publicHistoryList();
    payload.plinkoHistory = (gameState.plinkoHistory || []).slice(0, 15);
    payload.minesHistory = (gameState.minesHistory || []).slice(0, 15);
    payload.diceHistory = (gameState.diceHistory || []).slice(0, 15);
    payload.limboHistory = (gameState.limboHistory || []).slice(0, 15);
    payload.coinflipHistory = (gameState.coinflipHistory || []).slice(0, 15);
    payload.wheelHistory = (gameState.wheelHistory || []).slice(0, 15);
    payload.hiloHistory = (gameState.hiloHistory || []).slice(0, 15);
    payload.slotsHistory = (gameState.slotsHistory || []).slice(0, 15);
    payload.totalRoundBet = gameState.totalRoundBet;
  }

  return payload;
}

function generateProvablyFairSeeds(nonce) {
  const entropySalt = crypto.randomBytes(8).toString('hex');
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const clientSeed = gameState.nextClientSeedOverride || `skywing-${getTodayKey()}-${entropySalt}`;
  return { serverSeed, serverSeedHash, clientSeed, nonce };
}

function computeRawCrashPoint(serverSeed, clientSeed, nonce) {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const intVal = parseInt(hmac.slice(0, 13), 16);
  if (intVal % 33 === 0) return 1.0;
  const e = Math.pow(2, 52);
  const raw = Math.floor((100 * e - intVal) / (e - intVal)) / 100;
  return Math.min(100.0, Math.max(1.01, raw));
}

function publicBetsList() {
  return gameState.bets.map((b) => ({
    id: b.id,
    userId: b.userId,
    player: b.displayName,
    slot: b.slot,
    currencyMode: b.currencyMode,
    amount: b.amount,
    autoCashout: b.autoCashout,
    cashedOut: b.cashedOut,
    cashoutMultiplier: b.cashoutMultiplier,
    payout: b.payout,
  }));
}

function publicHistoryList() {
  return gameState.history.slice(0, 15);
}

function broadcastOnlineCount() {
  io.emit('players:online', { count: getDisplayedOnlineCount() });
}

async function runBettingTick() {
  if (gameState.phase !== 'BETTING') return;
  const tickPayload = buildAuthoritativeState(false);

  if (tickPayload.countdownRemainingMs <= 0) {
    if (bettingTransitionInFlight) return;
    bettingTransitionInFlight = true;
    clearInterval(tickTimer);
    tickTimer = null;
    try {
      await startFlyingPhase();
    } catch (err) {
      console.error('[Flight Start Error]', err);
    } finally {
      bettingTransitionInFlight = false;
    }
    return;
  }

  io.emit('round:tick', tickPayload);
  io.emit('game:state', tickPayload);
}

async function startBettingPhase() {
  if (runtimeSyncState.isFollower) return;
  clearTimeout(phaseTimer);
  clearInterval(tickTimer);
  clearBotBetTimers();
  bettingTransitionInFlight = false;
  flightTickInFlight = false;

  const settings = await db.getSettings();
  const nextRound = Number(settings.roundCounter || 1000) + 1;
  await db.updateSettings({ roundCounter: nextRound });

  const seeds = generateProvablyFairSeeds(nextRound);
  simulatedOnlineCrowd = Math.min(96, Math.max(36, simulatedOnlineCrowd + Math.floor(Math.random() * 9) - 4));

  gameState.phase = 'BETTING';
  gameState.currentRoundId = nextRound;
  gameState.roundNumber = nextRound;
  gameState.nonce = seeds.nonce;
  gameState.clientSeed = seeds.clientSeed;
  gameState.serverSeed = seeds.serverSeed;
  gameState.serverSeedHash = seeds.serverSeedHash;
  gameState.bettingEndsAt = Date.now() + BETTING_DURATION_MS;
  gameState.flightStartedAt = 0;
  gameState.crashedAt = 0;
  gameState.crashHoldEndsAt = 0;
  gameState.currentMultiplier = 1.0;
  gameState.totalRoundBet = 0;
  gameState.totalRealRoundBet = 0;
  gameState.totalRoundPayouts = 0;
  gameState.totalRealRoundPayouts = 0;
  gameState.bets = [];
  gameState.protectionActive = false;
  gameState.maxAllowedRoundPayout = Infinity;

  if (gameState.history.length === 0 && Array.isArray(settings.recentRounds)) {
    gameState.history = settings.recentRounds.slice(0, 15).map((r) => ({
      roundNumber: r.roundNumber,
      crashPoint: r.crashPoint,
      serverSeed: r.serverSeed,
      serverSeedHash: r.serverSeedHash,
      clientSeed: r.clientSeed,
      nonce: r.nonce,
    }));
  }

  publishLiveRoundIfMaster(true).catch(() => {});

  const startPayload = {
    ...buildAuthoritativeState(true),
    countdownMs: BETTING_DURATION_MS,
  };
  io.emit('round:betting', startPayload);
  io.emit('game:state', startPayload);
  broadcastOnlineCount();

  // Launch realistic simulated players placing staggered bets
  scheduleSimulatedRoundBets(nextRound);

  // Centralized 20Hz server loop drives betting countdown directly to all clients
  tickTimer = setInterval(() => {
    runBettingTick().catch((err) => console.error('[Betting Tick Error]', err));
  }, TICK_INTERVAL_MS);
}

async function startFlyingPhase() {
  clearTimeout(phaseTimer);
  clearInterval(tickTimer);
  clearBotBetTimers();
  flightTickInFlight = false;

  const settings = await db.getSettings();
  // STRICT REAL DATA: Only genuine non-bot player bets count toward pool/accounting
  const realUserBets = gameState.bets.filter((b) => !b.isBot);
  const totalRoundBet = realUserBets.reduce((sum, b) => sum + b.amount, 0);
  const totalRealRoundBet = realUserBets
    .filter((b) => b.currencyMode === 'real')
    .reduce((sum, b) => sum + b.amount, 0);

  gameState.totalRoundBet = Math.round(totalRoundBet * 100) / 100;
  gameState.totalRealRoundBet = Math.round(totalRealRoundBet * 100) / 100;
  gameState.totalRoundPayouts = 0;
  gameState.totalRealRoundPayouts = 0;

  // Credit Real Money PKR bets directly into the centralized Unified Profit Pool
  const poolBetDelta = gameState.totalRealRoundBet;
  let effectiveSettings = settings;
  if (poolBetDelta > 0) {
    effectiveSettings = await recordUnifiedPoolDelta('crash', poolBetDelta, 0);
  }
  const updatedDailyBets = Number(effectiveSettings.dailyTotalBets || 0);
  const projectedDailyNet = Number(effectiveSettings.dailyNetProfit || 0);

  let crashPoint = computeRawCrashPoint(
    gameState.serverSeed,
    gameState.clientSeed,
    gameState.nonce
  );

  const profitCtrl = effectiveSettings.profitControl || defaultProfitControl();
  const rtpRisk = effectiveSettings.rtpRiskConfig || defaultRtpRiskConfig();
  const maxCrashCap = Math.min(100, Math.max(1.05, Number(profitCtrl.maxCrashCap ?? 100)));
  const effectiveEdgePct = Math.min(
    25,
    Math.max(0, Number(profitCtrl.houseEdgePct ?? 4) + Number(rtpRisk.dynamicEdgeOffset ?? 0))
  );

  // Reset per-round crash state cleanly before evaluating RNG + Pool
  gameState.scheduledCrashPoint = 1.0;
  gameState.maxAllowedRoundPayout = Infinity;
  gameState.protectionActive = false;

  if (gameState.nextRoundForcedCrash !== null) {
    crashPoint = Math.min(100, Math.max(1.0, gameState.nextRoundForcedCrash));
    gameState.nextRoundForcedCrash = null;
    io.to('admins').emit('admin:profit_override', { nextRoundForcedCrash: null });
  } else {
    const entropyRoll = crypto.randomBytes(4).readUInt32BE(0) / 0xffffffff;
    if (entropyRoll * 100 < effectiveEdgePct) {
      crashPoint = Math.min(crashPoint, Math.round((1.0 + (crypto.randomBytes(2).readUInt16BE(0) / 65535) * 0.35) * 100) / 100);
    }
    if (profitCtrl.mode === 'low-crash') {
      const jitter = (crypto.randomBytes(2).readUInt16BE(0) / 65535) * 0.85;
      crashPoint = Math.min(crashPoint, Math.round((1.05 + jitter) * 100) / 100);
    } else if (profitCtrl.mode === 'house-edge') {
      crashPoint = Math.max(1.0, Math.round((1 + (crashPoint - 1) * 0.72) * 100) / 100);
    } else if (profitCtrl.mode === 'generous') {
      crashPoint = Math.round(Math.min(maxCrashCap, 1 + (crashPoint - 1) * 1.35) * 100) / 100;
    }
    crashPoint = Math.min(maxCrashCap, crashPoint);
  }

  // Dynamic Pool-Aware Variance Engine backed by the single Unified Profit Pool (Crash + Plinko + Mines)
  const target = Number(effectiveSettings.dailyProfitTarget || 0);
  const tolerancePct = Math.min(10, Math.max(5, Number(effectiveSettings.varianceTolerancePct || 8)));
  const protectedFloor = Math.max(0, target * (1 - tolerancePct / 100));
  const availablePool = Math.max(0, Number(effectiveSettings.profitDistributionPool ?? 10000));
  const surplusPool = Math.max(0, projectedDailyNet - target);

  let maxAllowedRoundPayout = Infinity;
  let protectionActive = false;

  if (gameState.totalRealRoundBet > 0 && gameState.nextRoundForcedCrash === null) {
    if (availablePool >= gameState.totalRealRoundBet * 2) {
      const poolCoverageLimit = Math.max(
        gameState.totalRealRoundBet * 15,
        availablePool + gameState.totalRealRoundBet
      );
      maxAllowedRoundPayout = poolCoverageLimit;
      protectionActive = true;
    } else if (surplusPool > 0 && target > 0) {
      maxAllowedRoundPayout = Math.max(
        gameState.totalRealRoundBet * (3 + (crypto.randomBytes(2).readUInt16BE(0) / 65535) * 6),
        projectedDailyNet - protectedFloor
      );
      protectionActive = true;
    } else {
      const randomMultFloor = 1.18 + (crypto.randomBytes(2).readUInt16BE(0) / 65535) * 3.1;
      maxAllowedRoundPayout = Math.max(
        availablePool + gameState.totalRealRoundBet * 0.9,
        gameState.totalRealRoundBet * randomMultFloor
      );
      protectionActive = true;
    }
  }

  gameState.scheduledCrashPoint = crashPoint;
  gameState.maxAllowedRoundPayout = maxAllowedRoundPayout;
  gameState.protectionActive = protectionActive;
  gameState.phase = 'FLYING';
  gameState.flightStartedAt = Date.now();
  gameState.currentMultiplier = 1.0;

  publishLiveRoundIfMaster(true).catch(() => {});

  const flyPayload = buildAuthoritativeState(true);
  io.emit('round:flying', flyPayload);
  io.emit('game:state', flyPayload);

  if (crashPoint <= 1.0) {
    await triggerCrash(1.0);
    return;
  }

  tickTimer = setInterval(() => {
    if (flightTickInFlight) return;
    flightTickInFlight = true;
    runFlightTick()
      .catch((err) => console.error('[Flight Tick Error]', err))
      .finally(() => {
        flightTickInFlight = false;
      });
  }, TICK_INTERVAL_MS);
}

async function processCashout(bet, multiplier) {
  if (bet.cashedOut || bet.isBot || gameState.phase !== 'FLYING') return null;

  bet.cashedOut = true;
  const cleanMult = Math.floor(multiplier * 100) / 100;
  const payout = Math.round(bet.amount * cleanMult * 100) / 100;
  const profit = Math.round((payout - bet.amount) * 100) / 100;

  bet.cashoutMultiplier = cleanMult;
  bet.payout = payout;
  gameState.totalRoundPayouts = Math.round((gameState.totalRoundPayouts + payout) * 100) / 100;
  if (bet.currencyMode === 'real') {
    gameState.totalRealRoundPayouts =
      Math.round((gameState.totalRealRoundPayouts + payout) * 100) / 100;
  }

  const afterBalance = await db.adjustBalanceAtomic(bet.userId, bet.currencyMode, payout);
  const wonField = bet.currencyMode === 'real' ? 'totalWonReal' : 'totalWonFun';

  const updatedUser = await db.updateUserById(bet.userId, {
    $inc: { [wonField]: payout, totalWon: payout },
    $push: {
      recentBets: {
        $each: [
          {
            roundNumber: gameState.roundNumber,
            currencyMode: bet.currencyMode,
            betAmount: bet.amount,
            cashoutMultiplier: cleanMult,
            payout,
            profit,
            crashedAt: cleanMult,
            createdAt: new Date(),
          },
        ],
        $slice: 30,
      },
    },
  });

  emitUserBalances(updatedUser || afterBalance);

  io.emit('bet:cashedOut', {
    betId: bet.id,
    userId: bet.userId,
    slot: bet.slot,
    currencyMode: bet.currencyMode,
    player: bet.displayName,
    amount: bet.amount,
    cashoutMultiplier: cleanMult,
    payout,
    profit,
  });

  return { payout, cashoutMultiplier: cleanMult, currencyMode: bet.currencyMode };
}

async function runFlightTick() {
  if (gameState.phase !== 'FLYING') return;

  const elapsedSec = (Date.now() - gameState.flightStartedAt) / 1000;
  const rawMult = Math.exp(MULTIPLIER_GROWTH_RATE * elapsedSec);
  const currentMult = Math.max(1.0, Math.floor(rawMult * 100) / 100);
  gameState.currentMultiplier = currentMult;

  // 1. Check real-time pool protection ceiling for Real Money PKR bets
  if (gameState.protectionActive && gameState.totalRealRoundBet > 0) {
    const uncashedRealBets = gameState.bets.filter(
      (b) => !b.isBot && !b.cashedOut && b.currencyMode === 'real'
    );
    const activeLiability = uncashedRealBets.reduce((sum, b) => sum + b.amount * currentMult, 0);
    const totalPotential = gameState.totalRealRoundPayouts + activeLiability;

    if (
      uncashedRealBets.length > 0 &&
      totalPotential > gameState.maxAllowedRoundPayout &&
      currentMult >= 1.02
    ) {
      await triggerCrash(Math.max(1.01, Math.floor((currentMult - 0.01) * 100) / 100));
      return;
    }
  }

  // 2. Check scheduled crash threshold
  if (currentMult >= gameState.scheduledCrashPoint) {
    await triggerCrash(gameState.scheduledCrashPoint);
    return;
  }

  // 3. Trigger Simulated Crowd Cashouts & Genuine Auto-Cashouts
  for (const bet of gameState.bets) {
    if (bet.isBot) {
      if (!bet.cashedOut && bet.botTargetMult && currentMult >= bet.botTargetMult) {
        bet.cashedOut = true;
        bet.cashoutMultiplier = bet.botTargetMult;
        bet.payout = Math.round(bet.amount * bet.botTargetMult * 100) / 100;
        io.emit('bet:cashedOut', {
          betId: bet.id,
          userId: bet.userId,
          slot: bet.slot,
          currencyMode: bet.currencyMode,
          player: bet.displayName,
          amount: bet.amount,
          cashoutMultiplier: bet.cashoutMultiplier,
          payout: bet.payout,
          profit: Math.round((bet.payout - bet.amount) * 100) / 100,
        });
      }
      continue;
    }
    if (!bet.cashedOut && bet.autoCashout !== null && bet.autoCashout >= 1.01) {
      if (currentMult >= bet.autoCashout) {
        await processCashout(bet, bet.autoCashout);
      }
    }
  }

  // 4. Broadcast unified live multiplier & authoritative round tick
  publishLiveRoundIfMaster(false).catch(() => {});
  const tickPayload = buildAuthoritativeState(false);
  io.emit('round:tick', tickPayload);
  io.emit('game:state', tickPayload);
}

async function triggerCrash(finalMultiplier) {
  if (gameState.phase !== 'FLYING') return;
  clearInterval(tickTimer);
  clearTimeout(phaseTimer);
  clearBotBetTimers();

  gameState.phase = 'CRASHED';
  const crashPoint = Math.max(1.0, Math.round(finalMultiplier * 100) / 100);
  gameState.currentMultiplier = crashPoint;
  gameState.crashedAt = Date.now();
  gameState.crashHoldEndsAt = gameState.crashedAt + CRASH_HOLD_MS;

  // Strictly only record losses for genuine registered users (never bots)
  const losingBets = gameState.bets.filter((b) => !b.isBot && !b.cashedOut);
  for (const bet of losingBets) {
    await db.updateUserById(bet.userId, {
      $push: {
        recentBets: {
          $each: [
            {
              roundNumber: gameState.roundNumber,
              currencyMode: bet.currencyMode,
              betAmount: bet.amount,
              cashoutMultiplier: null,
              payout: 0,
              profit: -bet.amount,
              crashedAt: crashPoint,
              createdAt: new Date(),
            },
          ],
          $slice: 30,
        },
      },
    });
  }

  const roundNetDelta =
    Math.round((gameState.totalRealRoundBet - gameState.totalRealRoundPayouts) * 100) / 100;

  // Bets were already credited to the Unified Pool at takeoff; debit Crash payouts here
  if (gameState.totalRealRoundPayouts > 0) {
    await recordUnifiedPoolDelta('crash', 0, gameState.totalRealRoundPayouts);
  }

  const roundRecord = {
    roundNumber: gameState.roundNumber,
    crashPoint,
    totalBets: gameState.totalRealRoundBet,
    totalPayouts: gameState.totalRealRoundPayouts,
    netDelta: roundNetDelta,
    serverSeed: gameState.serverSeed,
    serverSeedHash: gameState.serverSeedHash,
    clientSeed: gameState.clientSeed,
    nonce: gameState.nonce,
    createdAt: new Date(),
  };

  await db.pushRoundHistory(roundRecord, 20);
  evaluateRtpRiskDaemon().catch(() => {});

  gameState.history = [
    {
      roundNumber: roundRecord.roundNumber,
      crashPoint: roundRecord.crashPoint,
      serverSeed: roundRecord.serverSeed,
      serverSeedHash: roundRecord.serverSeedHash,
      clientSeed: roundRecord.clientSeed,
      nonce: roundRecord.nonce,
    },
    ...gameState.history,
  ].slice(0, 15);

  const crashPayload = {
    ...buildAuthoritativeState(true),
    crashPoint,
    serverSeed: gameState.serverSeed,
    totalBets: gameState.totalRoundBet,
    totalPayouts: gameState.totalRoundPayouts,
  };
  publishLiveRoundIfMaster(true).catch(() => {});
  io.emit('round:crashed', crashPayload);
  io.emit('game:state', crashPayload);

  // Stream authoritative crash hold ticks until the next betting round starts
  tickTimer = setInterval(() => {
    if (gameState.phase !== 'CRASHED') return;
    const holdPayload = buildAuthoritativeState(false);
    if (holdPayload.crashHoldRemainingMs <= 0) {
      clearInterval(tickTimer);
      tickTimer = null;
      startBettingPhase().catch((err) => console.error('[Next Round Error]', err));
      return;
    }
    io.emit('round:tick', holdPayload);
    io.emit('game:state', holdPayload);
  }, TICK_INTERVAL_MS);
}

// ============================================================================
// Cross-Instance Sync Coordinator (Mongo Distributed Lease & Remote Mirror)
// ============================================================================
function hydrateGameStateFromSnapshot(rs, serverTimestamp = Date.now(), extras = {}) {
  if (!rs) return;
  const now = Date.now();
  const offsetMs = now - Number(serverTimestamp || now);
  const nextRoundNum = Number(rs.roundNumber || gameState.roundNumber || 1001);
  const nextPhase = String(rs.phase || 'BETTING').toUpperCase();

  gameState.currentRoundId = Number(rs.currentRoundId || nextRoundNum);
  gameState.roundNumber = nextRoundNum;
  gameState.phase = nextPhase;
  gameState.bettingEndsAt = rs.bettingEndsAt ? Number(rs.bettingEndsAt) + offsetMs : 0;
  gameState.flightStartedAt = rs.flightStartedAt ? Number(rs.flightStartedAt) + offsetMs : 0;
  gameState.crashedAt = rs.crashedAt ? Number(rs.crashedAt) + offsetMs : 0;
  gameState.crashHoldEndsAt = rs.crashHoldEndsAt
    ? Number(rs.crashHoldEndsAt) + offsetMs
    : nextPhase === 'CRASHED' && rs.crashHoldRemainingMs
      ? now + Number(rs.crashHoldRemainingMs)
      : 0;
  gameState.currentMultiplier = Math.max(1.0, Number(rs.currentMultiplier || rs.multiplier || 1.0));
  gameState.serverSeedHash = rs.serverSeedHash || gameState.serverSeedHash;
  gameState.clientSeed = rs.clientSeed || gameState.clientSeed;
  gameState.nonce = Number(rs.nonce || nextRoundNum);
  if (nextPhase === 'CRASHED' && rs.serverSeed) {
    gameState.serverSeed = rs.serverSeed;
  } else if (nextPhase === 'BETTING') {
    gameState.serverSeed = '';
  }

  if (Array.isArray(rs.bets)) {
    gameState.bets = rs.bets.map((b) => ({
      ...b,
      displayName: b.displayName || b.player || 'Player',
    }));
  }
  if (Array.isArray(rs.history)) gameState.history = rs.history;
  if (Array.isArray(rs.plinkoHistory)) gameState.plinkoHistory = rs.plinkoHistory;
  if (Array.isArray(rs.minesHistory)) gameState.minesHistory = rs.minesHistory;
  if (Array.isArray(rs.diceHistory)) gameState.diceHistory = rs.diceHistory;
  if (Array.isArray(rs.limboHistory)) gameState.limboHistory = rs.limboHistory;
  if (Array.isArray(rs.coinflipHistory)) gameState.coinflipHistory = rs.coinflipHistory;
  if (Array.isArray(rs.wheelHistory)) gameState.wheelHistory = rs.wheelHistory;
  if (Array.isArray(rs.hiloHistory)) gameState.hiloHistory = rs.hiloHistory;
  if (Array.isArray(rs.slotsHistory)) gameState.slotsHistory = rs.slotsHistory;
  if (Array.isArray(extras.recentRounds) && extras.recentRounds.length > 0 && (!Array.isArray(rs.history) || rs.history.length === 0)) {
    gameState.history = extras.recentRounds.slice(0, 15);
  }

  const transitioned = nextRoundNum !== lastMirrorRound || nextPhase !== lastMirrorPhase;
  lastMirrorRound = nextRoundNum;
  lastMirrorPhase = nextPhase;

  if (transitioned) {
    const payload = buildAuthoritativeState(true);
    if (nextPhase === 'BETTING') {
      io.emit('round:betting', { ...payload, countdownMs: BETTING_DURATION_MS });
    } else if (nextPhase === 'FLYING') {
      io.emit('round:flying', payload);
    } else if (nextPhase === 'CRASHED') {
      io.emit('round:crashed', {
        ...payload,
        crashPoint: gameState.currentMultiplier,
        serverSeed: gameState.serverSeed,
      });
    }
    io.emit('game:state', payload);
  }
}

function startMirrorLocalTicker() {
  clearInterval(mirrorTickTimer);
  mirrorTickTimer = setInterval(() => {
    if (!runtimeSyncState.isFollower) return;
    if (gameState.phase === 'FLYING' && gameState.flightStartedAt > 0) {
      const elapsedSec = Math.max(0, (Date.now() - gameState.flightStartedAt) / 1000);
      const interpolated = Math.max(
        gameState.currentMultiplier || 1.0,
        Math.floor(Math.exp(MULTIPLIER_GROWTH_RATE * elapsedSec) * 100) / 100
      );
      gameState.currentMultiplier = interpolated;
    }
    const payload = buildAuthoritativeState(false);
    io.emit('round:tick', payload);
    io.emit('game:state', payload);
  }, TICK_INTERVAL_MS);
}

function startRemoteMirrorLoop(remoteUrl) {
  stopAllRoundAndSyncTimers();
  runtimeSyncState.role = 'remote-mirror';
  runtimeSyncState.isFollower = true;
  runtimeSyncState.remoteUrl = remoteUrl;
  runtimeSyncState.lastError = '';
  lastMirrorRound = 0;
  lastMirrorPhase = '';
  startMirrorLocalTicker();

  const pollOnce = async () => {
    if (runtimeSyncState.role !== 'remote-mirror') return;
    try {
      const resp = await fetch(`${remoteUrl}/api/sync/state`, {
        signal: AbortSignal.timeout(4500),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.instanceId === INSTANCE_ID) {
        runtimeSyncState.lastError = 'Remote URL resolves to self; reverting to Master';
        await applySyncCoordinator(true, true);
        return;
      }
      runtimeSyncState.lastSyncAt = new Date().toISOString();
      runtimeSyncState.lastError = '';
      runtimeSyncState.remoteDatabase = data.database || '';
      runtimeSyncState.remoteInstanceId = data.instanceId || '';

      if (data.publicSettings) {
        const nextJson = JSON.stringify(data.publicSettings);
        if (nextJson !== lastMirrorSettingsJson) {
          lastMirrorSettingsJson = nextJson;
          mirroredPublicSettings = data.publicSettings;
          io.emit('settings:updated', mirroredPublicSettings);
        }
      }
      hydrateGameStateFromSnapshot(data.roundState, data.serverTimestamp, {
        recentRounds: data.recentRounds,
      });
    } catch (err) {
      runtimeSyncState.lastError = err.message || 'Mirror poll failed';
    } finally {
      if (runtimeSyncState.role === 'remote-mirror') {
        syncPollTimer = setTimeout(pollOnce, LIVE_SYNC_POLL_MS);
      }
    }
  };
  pollOnce();
}

function startMongoFollowerLoop() {
  stopAllRoundAndSyncTimers();
  runtimeSyncState.role = 'mongo-follower';
  runtimeSyncState.isFollower = true;
  runtimeSyncState.remoteUrl = '';
  runtimeSyncState.lastError = '';
  lastMirrorRound = 0;
  lastMirrorPhase = '';
  startMirrorLocalTicker();

  const pollMongo = async () => {
    if (runtimeSyncState.role !== 'mongo-follower') return;
    try {
      if (!isMongoReady()) {
        await applySyncCoordinator(true);
        return;
      }
      const settings = await db.getSettings();
      const lr = settings.liveRound || {};
      const leaseExpired =
        !lr.leaseExpiresAt || new Date(lr.leaseExpiresAt).getTime() < Date.now();
      if (!lr.masterId || lr.masterId === INSTANCE_ID || leaseExpired) {
        const won = await db.tryAcquireOrRenewMasterLease(INSTANCE_ID, 4500);
        if (won) {
          await applySyncCoordinator(true);
          return;
        }
      }
      runtimeSyncState.lastSyncAt = new Date().toISOString();
      runtimeSyncState.remoteInstanceId = lr.masterId || '';
      runtimeSyncState.remoteDatabase = 'mongodb-shared';
      hydrateGameStateFromSnapshot(lr, Date.now(), { recentRounds: settings.recentRounds });
    } catch (err) {
      runtimeSyncState.lastError = err.message || 'Mongo follower sync error';
    } finally {
      if (runtimeSyncState.role === 'mongo-follower') {
        syncPollTimer = setTimeout(pollMongo, LIVE_SYNC_POLL_MS);
      }
    }
  };
  pollMongo();
}

async function applySyncCoordinator(forceRestart = false, skipRemote = false) {
  const settings = await db.getSettings();
  const cfg = settings.syncConfig || defaultSyncConfig();
  const mode = cfg.mode || 'auto';
  const remoteUrl = (cfg.remoteLiveUrl || ENV_LIVE_SYNC_URL || '').trim().replace(/\/+$/, '');
  runtimeSyncState.mode = mode;

  if (!skipRemote && (mode === 'mirror' || (mode === 'auto' && remoteUrl))) {
    if (remoteUrl) {
      if (forceRestart || runtimeSyncState.role !== 'remote-mirror' || runtimeSyncState.remoteUrl !== remoteUrl) {
        console.log(`[Sync] Mirroring live rounds & state from ${remoteUrl}`);
        startRemoteMirrorLoop(remoteUrl);
      }
      return;
    }
  }

  mirroredPublicSettings = null;
  lastMirrorSettingsJson = '';

  if (isMongoReady() && mode !== 'standalone') {
    const acquired = await db.tryAcquireOrRenewMasterLease(INSTANCE_ID, 4500);
    if (!acquired) {
      if (forceRestart || runtimeSyncState.role !== 'mongo-follower') {
        console.log('[Sync] Another instance owns MongoDB round lease -> entering MongoDB Follower mode');
        startMongoFollowerLoop();
      }
      return;
    }
    const alreadyActiveMaster =
      runtimeSyncState.role === 'mongo-master' && !runtimeSyncState.isFollower && Boolean(tickTimer || phaseTimer);
    runtimeSyncState.role = 'mongo-master';
    runtimeSyncState.isFollower = false;
    runtimeSyncState.remoteUrl = '';
    runtimeSyncState.lastError = '';
    if (!leaseRenewTimer) {
      leaseRenewTimer = setInterval(async () => {
        if (runtimeSyncState.role !== 'mongo-master') return;
        if (!isMongoReady()) {
          await applySyncCoordinator(true);
          return;
        }
        const renewed = await db.tryAcquireOrRenewMasterLease(INSTANCE_ID, 4500);
        if (!renewed) {
          console.warn('[Sync] Lost MongoDB master lease -> switching to Follower');
          startMongoFollowerLoop();
        }
      }, 1500);
    }
    if (alreadyActiveMaster) {
      return;
    }
    stopAllRoundAndSyncTimers();
    leaseRenewTimer = setInterval(async () => {
      if (runtimeSyncState.role !== 'mongo-master') return;
      if (!isMongoReady()) {
        await applySyncCoordinator(true);
        return;
      }
      const renewed = await db.tryAcquireOrRenewMasterLease(INSTANCE_ID, 4500);
      if (!renewed) {
        console.warn('[Sync] Lost MongoDB master lease -> switching to Follower');
        startMongoFollowerLoop();
      }
    }, 1500);
    console.log(`[Sync] Acquired MongoDB Master lease (instance ${INSTANCE_ID})`);
    await startBettingPhase();
    return;
  }

  const alreadyStandaloneMaster =
    runtimeSyncState.role === 'standalone-master' &&
    !runtimeSyncState.isFollower &&
    Boolean(tickTimer || phaseTimer);
  runtimeSyncState.role = 'standalone-master';
  runtimeSyncState.isFollower = false;
  runtimeSyncState.remoteUrl = '';
  runtimeSyncState.lastError = '';
  if (alreadyStandaloneMaster) {
    return;
  }
  stopAllRoundAndSyncTimers();
  console.log(`[Sync] Running as Standalone Master (instance ${INSTANCE_ID})`);
  await startBettingPhase();
}

// ============================================================================
// Automated RTP & House Risk Management Daemon
// ============================================================================
async function evaluateRtpRiskDaemon() {
  try {
    const settings = await db.getSettings();
    const totalBets = Number(settings.dailyTotalBets || 0);
    const totalPayouts = Number(settings.dailyTotalPayouts || 0);
    const cfg = settings.rtpRiskConfig || defaultRtpRiskConfig();
    const targetRtp = Number(cfg.targetRtpPct ?? 96);

    let actualRtp = targetRtp;
    if (totalBets >= 100) {
      actualRtp = Math.round((totalPayouts / totalBets) * 10000) / 100;
    }

    const rtpExcess = actualRtp - targetRtp;
    const riskIndex = Math.min(100, Math.max(5, Math.round(20 + rtpExcess * 3.5)));

    let dynamicEdgeOffset = Number(cfg.dynamicEdgeOffset ?? 0);
    if (cfg.autoAdjustEnabled !== false && totalBets >= 200) {
      if (rtpExcess > 3) {
        dynamicEdgeOffset = Math.min(6, Math.round((dynamicEdgeOffset + 0.5) * 10) / 10);
      } else if (rtpExcess < -4) {
        dynamicEdgeOffset = Math.max(-1.5, Math.round((dynamicEdgeOffset - 0.5) * 10) / 10);
      }
    }

    const nextCfg = {
      ...cfg,
      dynamicEdgeOffset,
      currentRiskIndex: riskIndex,
      lastEvaluatedAt: new Date(),
    };

    const updated = await db.updateSettings({ rtpRiskConfig: nextCfg });
    io.to('admins').emit('admin:telemetry', computeLiveRtpTelemetry(updated));
  } catch {
    // ignore daemon transient errors
  }
}

// ============================================================================
// Socket.io Real-Time Handlers
// ============================================================================
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || '';
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role === 'player' && payload.sub) {
        const user = await db.findUserById(payload.sub);
        if (
          user &&
          !user.isBanned &&
          !isUserInactiveExpired(user) &&
          Number(payload.tv || 0) === Number(user.tokenVersion || 0)
        ) {
          socket.user = user;
          touchUserActivityThrottled(user);
        }
      }
    }
  } catch {
    // Allow guest spectators
  }
  next();
});

io.on('connection', async (socket) => {
  if (socket.user) {
    registerUserSocket(String(socket.user._id), socket);
  }
  broadcastOnlineCount();

  const initPayload = {
    ...buildAuthoritativeState(true),
    onlineCount: getDisplayedOnlineCount(),
  };
  socket.emit('game:init', initPayload);
  socket.emit('game:state', initPayload);

  socket.on('game:sync', (cb) => {
    const snapshot = {
      ...buildAuthoritativeState(true),
      onlineCount: getDisplayedOnlineCount(),
    };
    socket.emit('game:init', snapshot);
    socket.emit('game:state', snapshot);
    cb?.({ ok: true, state: snapshot });
  });

  // Update next-round Provably Fair client seed
  socket.on('fair:setClientSeed', ({ clientSeed }, cb) => {
    const clean = String(clientSeed || '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32);
    if (clean.length < 4) {
      return cb?.({ ok: false, error: 'Client seed must be 4-32 alphanumeric characters.' });
    }
    gameState.nextClientSeedOverride = clean;
    cb?.({ ok: true, clientSeed: clean });
  });

  // Admin socket subscription for real-time deposit & withdrawal pop-up alerts
  socket.on('admin:subscribe', async ({ token }, cb) => {
    try {
      const payload = jwt.verify(String(token || ''), JWT_SECRET);
      if (payload.role !== 'admin') {
        return cb?.({ ok: false, error: 'Unauthorized' });
      }
      socket.join('admins');
      const pending = await db.countPendingTransactions();
      cb?.({ ok: true, pending });
    } catch {
      cb?.({ ok: false, error: 'Invalid admin token' });
    }
  });

  socket.on('auth:identify', async ({ token }, cb) => {
    try {
      if (socket.user) {
        unregisterUserSocket(String(socket.user._id), socket);
        socket.user = null;
      }
      if (!token) {
        if (cb) cb({ ok: true });
        return;
      }
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await db.findUserById(payload.sub);
      if (!user || user.isBanned || Number(payload.tv || 0) !== Number(user.tokenVersion || 0)) {
        if (cb) cb({ ok: false, error: 'Account unavailable or session revoked' });
        return;
      }
      if (isUserInactiveExpired(user)) {
        if (cb) cb({ ok: false, error: 'Session expired due to 3 days of inactivity', inactivityExpired: true });
        return;
      }
      touchUserActivityThrottled(user);
      socket.user = user;
      registerUserSocket(String(user._id), socket);
      if (cb) cb({ ok: true, user: sanitizeUser(user) });
    } catch {
      if (cb) cb({ ok: false, error: 'Invalid token' });
    }
  });

  socket.on('auth:heartbeat', () => {
    if (socket.user) {
      touchUserActivityThrottled(socket.user);
    }
  });

  // Place Bet (Dual slots: 1 or 2, Currency: 'fun' | 'real')
  socket.on('bet:place', async ({ slot, amount, autoCashout, currencyMode }, cb) => {
    try {
      if (!socket.user) {
        return cb?.({ ok: false, error: 'Please log in to place a bet.' });
      }
      if (runtimeSyncState.isFollower) {
        return cb?.({
          ok: false,
          error:
            runtimeSyncState.role === 'remote-mirror'
              ? 'Mirrored round active: place bets on the primary Live Site or configure shared MONGODB_URI.'
              : 'Synced follower node active: wait for round sync or place bets on primary node.',
        });
      }
      const settings = await db.getSettings();
      if (settings.platformStatus?.mode && settings.platformStatus.mode !== 'active') {
        return cb?.({ ok: false, error: settings.platformStatus.message || 'Platform under maintenance.' });
      }
      const crashCfg = (settings.gamesConfig || defaultGamesConfig()).find((g) => g.id === 'skywing-crash');
      if (crashCfg && crashCfg.enabled === false) {
        return cb?.({ ok: false, error: 'SkyWing Crash is currently disabled by Admin.' });
      }
      const freshUser = await db.findUserById(socket.user._id);
      if (!freshUser || freshUser.isBanned) {
        return cb?.({ ok: false, error: 'Account suspended or not found.' });
      }
      if (gameState.phase !== 'BETTING') {
        return cb?.({ ok: false, error: 'Betting is closed for this flight.' });
      }

      const mode = currencyMode === 'real' ? 'real' : 'fun';
      const slotNum = slot === 2 ? 2 : 1;
      const betAmount = Math.round(Number(amount) * 100) / 100;
      const minBet = Number(crashCfg?.minBet || 1);
      const maxBet = Number(crashCfg?.maxBet || 100000);
      if (!Number.isFinite(betAmount) || betAmount < minBet || betAmount > maxBet) {
        return cb?.({
          ok: false,
          error: `Bet must be between ${minBet} and ${maxBet.toLocaleString()} ${mode === 'real' ? 'PKR' : 'FC'}.`,
        });
      }

      const userId = String(freshUser._id);
      if (gameState.bets.some((b) => b.userId === userId && b.slot === slotNum)) {
        return cb?.({ ok: false, error: `Bet already placed on Panel ${slotNum}.` });
      }

      // Strictly respect Auto Cashout ON/OFF: null means OFF (manual cashout required)
      let parsedAuto = null;
      if (autoCashout !== null && autoCashout !== undefined && autoCashout !== '') {
        const val = Math.round(Number(autoCashout) * 100) / 100;
        if (Number.isFinite(val) && val >= 1.01) {
          parsedAuto = Math.min(100, val);
        }
      }

      const updatedUser = await db.adjustBalanceAtomic(userId, mode, -betAmount);
      if (!updatedUser) {
        return cb?.({
          ok: false,
          error:
            mode === 'real'
              ? 'Insufficient Real Money (PKR) balance. Please deposit first.'
              : 'Insufficient Fun Credits balance.',
        });
      }

      const wagerField = mode === 'real' ? 'totalWageredReal' : 'totalWageredFun';
      await db.updateUserById(userId, {
        $inc: { [wagerField]: betAmount, totalWagered: betAmount },
      });

      const betObj = {
        id: `${gameState.roundNumber}-${userId}-${slotNum}`,
        userId,
        displayName: freshUser.displayName || maskPhone(freshUser.phoneNumber),
        slot: slotNum,
        currencyMode: mode,
        amount: betAmount,
        autoCashout: parsedAuto,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
      };

      gameState.bets.push(betObj);
      emitUserBalances(updatedUser);

      io.emit('bet:placed', {
        id: betObj.id,
        userId: betObj.userId,
        player: betObj.displayName,
        slot: betObj.slot,
        currencyMode: betObj.currencyMode,
        amount: betObj.amount,
        autoCashout: betObj.autoCashout,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
      });

      const cleanUser = sanitizeUser(updatedUser);
      cb?.({
        ok: true,
        bet: betObj,
        funBalance: cleanUser.funBalance,
        realBalance: cleanUser.realBalance,
      });
    } catch (err) {
      console.error('[bet:place Error]', err);
      cb?.({ ok: false, error: 'Failed to place bet.' });
    }
  });

  // Cancel Bet (Only during BETTING phase)
  socket.on('bet:cancel', async ({ slot }, cb) => {
    try {
      if (!socket.user) return cb?.({ ok: false, error: 'Not authenticated.' });
      if (gameState.phase !== 'BETTING') {
        return cb?.({ ok: false, error: 'Cannot cancel once flight has started.' });
      }

      const slotNum = slot === 2 ? 2 : 1;
      const userId = String(socket.user._id);
      const idx = gameState.bets.findIndex((b) => b.userId === userId && b.slot === slotNum);
      if (idx === -1) {
        return cb?.({ ok: false, error: 'No active bet on this panel.' });
      }

      const [removed] = gameState.bets.splice(idx, 1);
      const updatedUser = await db.adjustBalanceAtomic(
        userId,
        removed.currencyMode,
        removed.amount
      );
      const wagerField = removed.currencyMode === 'real' ? 'totalWageredReal' : 'totalWageredFun';
      await db.updateUserById(userId, {
        $inc: { [wagerField]: -removed.amount, totalWagered: -removed.amount },
      });

      if (updatedUser) {
        emitUserBalances(updatedUser);
      }

      io.emit('bet:cancelled', { betId: removed.id, userId, slot: slotNum });
      const cleanUser = updatedUser ? sanitizeUser(updatedUser) : null;
      cb?.({
        ok: true,
        funBalance: cleanUser?.funBalance,
        realBalance: cleanUser?.realBalance,
      });
    } catch (err) {
      console.error('[bet:cancel Error]', err);
      cb?.({ ok: false, error: 'Failed to cancel bet.' });
    }
  });

  // Manual Cash Out (Only during FLYING phase)
  socket.on('bet:cashout', async ({ slot }, cb) => {
    try {
      if (!socket.user) return cb?.({ ok: false, error: 'Not authenticated.' });
      if (gameState.phase !== 'FLYING') {
        return cb?.({ ok: false, error: 'Flight is not active.' });
      }

      const slotNum = slot === 2 ? 2 : 1;
      const userId = String(socket.user._id);
      const bet = gameState.bets.find(
        (b) => b.userId === userId && b.slot === slotNum && !b.cashedOut
      );
      if (!bet) {
        return cb?.({ ok: false, error: 'No active un-cashed bet on this panel.' });
      }

      // Lock cashout to the exact server-authoritative multiplier
      const liveMult = Math.max(1.0, Number(gameState.currentMultiplier || 1.0));

      if (liveMult >= gameState.scheduledCrashPoint) {
        return cb?.({ ok: false, error: 'Too late! The bird already flew away.' });
      }

      if (gameState.protectionActive && bet.currencyMode === 'real' && gameState.totalRealRoundBet > 0) {
        const potentialTotal = gameState.totalRealRoundPayouts + bet.amount * liveMult;
        if (potentialTotal > gameState.maxAllowedRoundPayout && liveMult >= 1.02) {
          await triggerCrash(Math.max(1.01, Math.floor((liveMult - 0.01) * 100) / 100));
          return cb?.({ ok: false, error: 'Too late! The bird already flew away.' });
        }
      }

      const result = await processCashout(bet, liveMult);
      if (!result) {
        return cb?.({ ok: false, error: 'Already cashed out.' });
      }

      cb?.({ ok: true, ...result });
    } catch (err) {
      console.error('[bet:cashout Error]', err);
      cb?.({ ok: false, error: 'Cashout failed.' });
    }
  });

  socket.on('disconnect', () => {
    if (socket.user) {
      unregisterUserSocket(String(socket.user._id), socket);
    }
    broadcastOnlineCount();
  });
});

// Fallback SPA route for main game
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// Boot Sequence
// ============================================================================
async function boot() {
  await connectDatabase();
  await ensureMasterPasswordInitialized();
  await applySyncCoordinator(true);
  setInterval(() => {
    evaluateRtpRiskDaemon().catch(() => {});
  }, 15000);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SkyWing] Unified server listening on http://0.0.0.0:${PORT}`);
    console.log(`[SkyWing] Admin Panel available at http://0.0.0.0:${PORT}/admin`);
  });
}

boot().catch((err) => {
  console.error('[Fatal Boot Error]', err);
  process.exit(1);
});
