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

import User from './models/User.js';
import Settings from './models/Settings.js';
import Transaction from './models/Transaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = (process.env.MONGODB_URI || '')
  .trim()
  .replace(/^["']|["']$/g, '');
const JWT_SECRET = process.env.JWT_SECRET || 'skywing_crash_dev_secret_change_me';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '66442211';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '11224466';

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

function defaultPaymentAccounts() {
  return {
    easypaisa: {
      enabled: true,
      accountTitle: 'SkyWing Official',
      accountNumber: '03451234567',
    },
    jazzcash: {
      enabled: true,
      accountTitle: 'SkyWing Official',
      accountNumber: '03001234567',
    },
    bank: {
      enabled: true,
      bankName: 'Meezan Bank',
      accountTitle: 'SkyWing Enterprises',
      accountNumber: 'PK36MEZN0000000123456789',
    },
  };
}

const ALLOWED_SOUND_PRESETS = ['cyber-flight', 'casino-chime', 'turbo-arcade', 'stealth-minimal'];

function defaultAudioConfig() {
  return {
    bgmEnabled: true,
    soundPreset: 'cyber-flight',
    masterVolume: 75,
  };
}

function defaultSettingsObj() {
  return {
    key: 'global',
    whatsappSupportNumber: '923001234567',
    whatsappChannelUrl: 'https://whatsapp.com/channel/0029VaSkyWingOfficial',
    paymentAccounts: defaultPaymentAccounts(),
    audioConfig: defaultAudioConfig(),
    dailyProfitTarget: 30000,
    varianceTolerancePct: 8,
    welcomeBonusCredits: 1000,
    dailyDateKey: getTodayKey(),
    dailyTotalBets: 0,
    dailyTotalPayouts: 0,
    dailyNetProfit: 0,
    carryForwardPool: 0,
    roundCounter: 1000,
    recentRounds: [],
  };
}

let localStore = {
  users: [],
  transactions: [],
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
        settings: {
          ...defaultSettingsObj(),
          ...(parsed.settings || {}),
          paymentAccounts: {
            ...defaultPaymentAccounts(),
            ...(parsed.settings?.paymentAccounts || {}),
          },
          audioConfig: {
            ...defaultAudioConfig(),
            ...(parsed.settings?.audioConfig || {}),
          },
        },
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
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(localStore, null, 2), 'utf8');
  } catch (err) {
    console.warn('[LocalDB] Save warning:', err.message);
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
    console.log('[MongoDB] Connected to MongoDB Atlas');
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
  if (!MONGODB_URI) {
    console.warn(
      '[DB] MONGODB_URI is not set. Running with persistent local JSON store (./data/local-db.json). Set MONGODB_URI in environment to use MongoDB Atlas.'
    );
    loadLocalStore();
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
    });
  }

  await attemptMongoConnect(false);
}

const db = {
  async getSettings() {
    if (isMongoReady()) {
      let doc = await Settings.findOne({ key: 'global' });
      if (!doc) {
        doc = await Settings.create(defaultSettingsObj());
      }
      const today = getTodayKey();
      if (doc.dailyDateKey !== today) {
        doc.dailyDateKey = today;
        doc.dailyTotalBets = 0;
        doc.dailyTotalPayouts = 0;
        doc.dailyNetProfit = 0;
        doc.carryForwardPool = 0;
        await doc.save();
      }
      const obj = doc.toObject();
      obj.paymentAccounts = {
        ...defaultPaymentAccounts(),
        ...(obj.paymentAccounts || {}),
      };
      obj.audioConfig = {
        ...defaultAudioConfig(),
        ...(obj.audioConfig || {}),
      };
      return obj;
    }

    const today = getTodayKey();
    if (localStore.settings.dailyDateKey !== today) {
      localStore.settings.dailyDateKey = today;
      localStore.settings.dailyTotalBets = 0;
      localStore.settings.dailyTotalPayouts = 0;
      localStore.settings.dailyNetProfit = 0;
      localStore.settings.carryForwardPool = 0;
      saveLocalStore();
    }
    return {
      ...localStore.settings,
      paymentAccounts: {
        ...defaultPaymentAccounts(),
        ...(localStore.settings.paymentAccounts || {}),
      },
      audioConfig: {
        ...defaultAudioConfig(),
        ...(localStore.settings.audioConfig || {}),
      },
    };
  },

  async updateSettings(patch) {
    if (isMongoReady()) {
      const doc = await Settings.findOneAndUpdate(
        { key: 'global' },
        { $set: patch },
        { new: true, upsert: true }
      );
      return doc.toObject();
    }
    localStore.settings = { ...localStore.settings, ...patch };
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

  async findUserByPhone(phoneNumber) {
    if (isMongoReady()) {
      const doc = await User.findOne({ phoneNumber });
      return doc ? doc.toObject() : null;
    }
    const found = localStore.users.find((u) => u.phoneNumber === phoneNumber);
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

  async createUser({ phoneNumber, displayName, passwordHash, funBalance }) {
    if (isMongoReady()) {
      const doc = await User.create({
        phoneNumber,
        displayName,
        passwordHash,
        funBalance,
        funCredits: funBalance,
        realBalance: 0,
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
      isBanned: false,
      recentBets: [],
      lastLoginAt: new Date().toISOString(),
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
      ...data,
      status: 'pending',
      rejectionReason: '',
      reviewedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    localStore.transactions.unshift(tx);
    saveLocalStore();
    return { ...tx };
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

  async listAdminTransactions({ status = 'all', type = 'all', limit = 100 } = {}) {
    if (isMongoReady()) {
      const filter = {};
      if (status !== 'all') filter.status = status;
      if (type !== 'all') filter.type = type;
      const docs = await Transaction.find(filter).sort({ createdAt: -1 }).limit(limit);
      return docs.map((d) => d.toObject());
    }
    return localStore.transactions
      .filter((t) => (status === 'all' || t.status === status) && (type === 'all' || t.type === type))
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
};

// ============================================================================
// Helpers
// ============================================================================
function normalizePakistaniPhone(input) {
  return String(input || '')
    .replace(/[\s\-()]/g, '')
    .trim();
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

function sanitizeUser(user) {
  if (!user) return null;
  const funBalance = Math.round(Number(user.funBalance ?? user.funCredits ?? 1000) * 100) / 100;
  const realBalance = Math.round(Number(user.realBalance ?? 0) * 100) / 100;
  const totalWageredReal = Math.round(Number(user.totalWageredReal ?? 0) * 100) / 100;
  const totalWonReal = Math.round(Number(user.totalWonReal ?? 0) * 100) / 100;
  const totalDeposited = Math.round(Number(user.totalDeposited ?? 0) * 100) / 100;
  const totalWithdrawn = Math.round(Number(user.totalWithdrawn ?? 0) * 100) / 100;

  return {
    id: String(user._id),
    phoneNumber: user.phoneNumber,
    displayName: user.displayName || maskPhone(user.phoneNumber),
    funBalance,
    realBalance,
    funCredits: funBalance,
    totalDeposited,
    totalWithdrawn,
    totalWageredFun: Math.round(Number(user.totalWageredFun ?? 0) * 100) / 100,
    totalWonFun: Math.round(Number(user.totalWonFun ?? 0) * 100) / 100,
    totalWageredReal,
    totalWonReal,
    netProfitLoss: Math.round((totalWonReal - totalWageredReal) * 100) / 100,
    totalWagered: Math.round(Number(user.totalWagered ?? 0) * 100) / 100,
    totalWon: Math.round(Number(user.totalWon ?? 0) * 100) / 100,
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
    method: tx.method,
    transactionId: tx.transactionId || '',
    screenshotData: tx.screenshotData || '',
    accountDetails: tx.accountDetails || {},
    status: tx.status,
    rejectionReason: tx.rejectionReason || '',
    reviewedAt: tx.reviewedAt || null,
    createdAt: tx.createdAt,
  };
}

function signUserToken(user) {
  return jwt.sign(
    { sub: String(user._id), phoneNumber: user.phoneNumber, role: 'player' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function signAdminToken() {
  return jwt.sign({ role: 'admin', username: ADMIN_USERNAME }, JWT_SECRET, {
    expiresIn: '12h',
  });
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
    if (user.isBanned) {
      return res.status(403).json({ error: 'Account is suspended. Contact Admin support.' });
    }
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
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check for Render.com / Railway & uptime monitors
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'SkyWing Crash',
    uptime: Math.round(process.uptime()),
    database: isMongoReady() ? 'mongodb-connected' : 'local-fallback',
    mongoNotice: lastMongoError ? 'Atlas IP whitelist (0.0.0.0/0) or URI check required' : null,
    round: gameState.roundNumber,
    phase: gameState.phase,
  });
});

// Secret Isolated Admin Panel route
app.get(['/admin', '/admin/*'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public Settings (WhatsApp Channel + Support Helpline + Payment Accounts + Audio Config)
app.get('/api/public-settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({
      whatsappSupportNumber: settings.whatsappSupportNumber,
      whatsappChannelUrl: settings.whatsappChannelUrl,
      welcomeBonusCredits: settings.welcomeBonusCredits,
      paymentAccounts: settings.paymentAccounts,
      audioConfig: settings.audioConfig || defaultAudioConfig(),
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// User Registration (Strict Pakistani 03XX 11-digit number, min 6 char password)
app.post('/api/auth/register', async (req, res) => {
  try {
    const phoneNumber = normalizePakistaniPhone(req.body.phoneNumber);
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim().slice(0, 24);

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

    const settings = await db.getSettings();
    const passwordHash = await bcrypt.hash(password, 10);
    const startingCredits = Number(settings.welcomeBonusCredits ?? 1000);

    const created = await db.createUser({
      phoneNumber,
      displayName: displayName || maskPhone(phoneNumber),
      passwordHash,
      funBalance: startingCredits,
    });

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

// User & Admin Flexible Login (Strict 03XX enforced only on player registration)
app.post('/api/auth/login', async (req, res) => {
  try {
    const rawIdentifier = String(req.body.phoneNumber || '').trim();
    const phoneNumber = normalizePakistaniPhone(rawIdentifier);
    const password = String(req.body.password || '');

    if (!phoneNumber && !rawIdentifier) {
      return res.status(400).json({
        error: 'Mobile number or username is required.',
      });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    // Allow Admin credentials to authenticate cleanly via the main login modal as well
    if (
      (rawIdentifier === ADMIN_USERNAME || phoneNumber === ADMIN_USERNAME) &&
      password === ADMIN_PASSWORD
    ) {
      return res.json({
        isAdmin: true,
        adminToken: signAdminToken(),
        redirectUrl: '/admin',
      });
    }

    const user =
      (await db.findUserByPhone(phoneNumber)) ||
      (rawIdentifier !== phoneNumber ? await db.findUserByPhone(rawIdentifier) : null);
    if (!user) {
      return res.status(401).json({ error: 'Invalid mobile number or password.' });
    }
    if (user.isBanned) {
      return res.status(403).json({
        error: 'Your account has been suspended. Please contact Admin Support.',
      });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: 'Invalid mobile number or password.' });
    }

    const updated = await db.updateUserById(user._id, {
      $set: { lastLoginAt: new Date() },
    });

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

// Current User Profile & Dual Balances
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const settings = await db.getSettings();
  res.json({
    user: sanitizeUser(req.user),
    publicSettings: {
      whatsappSupportNumber: settings.whatsappSupportNumber,
      whatsappChannelUrl: settings.whatsappChannelUrl,
      paymentAccounts: settings.paymentAccounts,
      audioConfig: settings.audioConfig || defaultAudioConfig(),
    },
  });
});

// ============================================================================
// Real Money PKR Deposit & Withdrawal Routes (User)
// ============================================================================
app.post('/api/transactions/deposit', requireAuth, async (req, res) => {
  try {
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const method = String(req.body.method || '').trim();
    const transactionId = String(req.body.transactionId || '').trim().slice(0, 80);
    const screenshotData = String(req.body.screenshotData || '').trim();

    if (!Number.isFinite(amount) || amount < 50 || amount > 1000000) {
      return res.status(400).json({ error: 'Deposit amount must be between 50 and 1,000,000 PKR.' });
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

    const tx = await db.createTransaction({
      userId: String(req.user._id),
      phoneNumber: req.user.phoneNumber,
      displayName: req.user.displayName || maskPhone(req.user.phoneNumber),
      type: 'deposit',
      amount,
      method,
      transactionId,
      screenshotData,
      accountDetails: {},
    });

    const cleanTx = sanitizeTransaction(tx);

    // Trigger real-time Pop-Up Notification in Admin Panel
    io.to('admins').emit('admin:deposit_alert', cleanTx);

    res.status(201).json({ transaction: cleanTx });
  } catch (err) {
    console.error('[Deposit Error]', err);
    res.status(500).json({ error: 'Failed to submit deposit request.' });
  }
});

app.post('/api/transactions/withdraw', requireAuth, async (req, res) => {
  try {
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const method = String(req.body.method || '').trim();
    const accountTitle = String(req.body.accountTitle || '').trim().slice(0, 60);
    const accountNumber = String(req.body.accountNumber || '').trim().slice(0, 60);
    const bankName = String(req.body.bankName || '').trim().slice(0, 60);

    if (!Number.isFinite(amount) || amount < 100 || amount > 1000000) {
      return res.status(400).json({ error: 'Withdrawal amount must be between 100 and 1,000,000 PKR.' });
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

    // Atomically deduct from realBalance upon request (refunded if rejected)
    const updatedUser = await db.adjustBalanceAtomic(String(req.user._id), 'real', -amount);
    if (!updatedUser) {
      return res.status(400).json({ error: 'Insufficient Real Money (PKR) balance.' });
    }

    const tx = await db.createTransaction({
      userId: String(req.user._id),
      phoneNumber: req.user.phoneNumber,
      displayName: req.user.displayName || maskPhone(req.user.phoneNumber),
      type: 'withdrawal',
      amount,
      method,
      transactionId: '',
      screenshotData: '',
      accountDetails: { accountTitle, accountNumber, bankName },
    });

    const cleanTx = sanitizeTransaction(tx);
    emitUserBalances(updatedUser);
    io.to('admins').emit('admin:withdrawal_alert', cleanTx);

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
// Admin Routes
// ============================================================================
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return res.json({ token: signAdminToken(), username: ADMIN_USERNAME });
  }
  return res.status(401).json({ error: 'Invalid admin credentials.' });
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const [settings, pendingCounts] = await Promise.all([
      db.getSettings(),
      db.countPendingTransactions(),
    ]);
    const tolerance = Math.min(10, Math.max(5, Number(settings.varianceTolerancePct || 8)));
    const target = Number(settings.dailyProfitTarget || 0);
    const protectedFloor = Math.round(target * (1 - tolerance / 100));

    res.json({
      settings: {
        whatsappSupportNumber: settings.whatsappSupportNumber,
        whatsappChannelUrl: settings.whatsappChannelUrl,
        paymentAccounts: settings.paymentAccounts,
        audioConfig: settings.audioConfig || defaultAudioConfig(),
        dailyProfitTarget: target,
        varianceTolerancePct: tolerance,
        welcomeBonusCredits: settings.welcomeBonusCredits,
        dailyDateKey: settings.dailyDateKey,
        dailyTotalBets: Math.round((settings.dailyTotalBets || 0) * 100) / 100,
        dailyTotalPayouts: Math.round((settings.dailyTotalPayouts || 0) * 100) / 100,
        dailyNetProfit: Math.round((settings.dailyNetProfit || 0) * 100) / 100,
        carryForwardPool: Math.round((settings.carryForwardPool || 0) * 100) / 100,
        protectedFloor,
        roundCounter: settings.roundCounter,
        recentRounds: (settings.recentRounds || []).slice(0, 20),
      },
      pendingCounts,
      live: {
        onlineSockets: io.engine.clientsCount,
        roundNumber: gameState.roundNumber,
        phase: gameState.phase,
        multiplier: gameState.currentMultiplier,
        activeBetCount: gameState.bets.length,
        activeRoundWager: gameState.totalRoundBet,
        serverSeedHash: gameState.serverSeedHash,
        clientSeed: gameState.clientSeed,
        nonce: gameState.nonce,
        databaseMode: isMongoReady() ? 'MongoDB Atlas Connected' : 'Local Fallback Store',
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
    const whatsappSupportNumber = sanitizeSupportPhone(
      req.body.whatsappSupportNumber ?? current.whatsappSupportNumber
    );
    const whatsappChannelUrl = String(
      req.body.whatsappChannelUrl ?? current.whatsappChannelUrl
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
        : 'cyber-flight';
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

    const carryForwardPool = Math.max(
      0,
      Math.round((Number(current.dailyNetProfit || 0) - dailyProfitTarget) * 100) / 100
    );

    const updated = await db.updateSettings({
      whatsappSupportNumber: whatsappSupportNumber || current.whatsappSupportNumber,
      whatsappChannelUrl: whatsappChannelUrl || current.whatsappChannelUrl,
      paymentAccounts,
      audioConfig,
      dailyProfitTarget,
      varianceTolerancePct,
      welcomeBonusCredits,
      carryForwardPool,
    });

    io.emit('settings:updated', {
      whatsappSupportNumber: updated.whatsappSupportNumber,
      whatsappChannelUrl: updated.whatsappChannelUrl,
      paymentAccounts: updated.paymentAccounts,
      audioConfig: updated.audioConfig || audioConfig,
    });

    res.json({ settings: updated });
  } catch (err) {
    console.error('[Admin Settings Update Error]', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.post('/api/admin/reset-daily-stats', requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateSettings({
      dailyDateKey: getTodayKey(),
      dailyTotalBets: 0,
      dailyTotalPayouts: 0,
      dailyNetProfit: 0,
      carryForwardPool: 0,
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
    const updated = await db.updateUserById(id, { $set: { passwordHash } });
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

const gameState = {
  phase: 'BETTING',
  roundNumber: 1001,
  nonce: 1001,
  clientSeed: `skywing-${getTodayKey()}`,
  serverSeed: '',
  serverSeedHash: '',
  bettingEndsAt: Date.now() + BETTING_DURATION_MS,
  flightStartedAt: 0,
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
};

let tickTimer = null;
let phaseTimer = null;

function generateProvablyFairSeeds(nonce) {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const clientSeed = `skywing-${getTodayKey()}`;
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
  io.emit('players:online', { count: io.engine.clientsCount });
}

async function startBettingPhase() {
  clearTimeout(phaseTimer);
  clearInterval(tickTimer);

  const settings = await db.getSettings();
  const nextRound = Number(settings.roundCounter || 1000) + 1;
  await db.updateSettings({ roundCounter: nextRound });

  const seeds = generateProvablyFairSeeds(nextRound);

  gameState.phase = 'BETTING';
  gameState.roundNumber = nextRound;
  gameState.nonce = seeds.nonce;
  gameState.clientSeed = seeds.clientSeed;
  gameState.serverSeed = seeds.serverSeed;
  gameState.serverSeedHash = seeds.serverSeedHash;
  gameState.bettingEndsAt = Date.now() + BETTING_DURATION_MS;
  gameState.flightStartedAt = 0;
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

  io.emit('round:betting', {
    roundNumber: gameState.roundNumber,
    bettingEndsAt: gameState.bettingEndsAt,
    countdownMs: BETTING_DURATION_MS,
    serverSeedHash: gameState.serverSeedHash,
    clientSeed: gameState.clientSeed,
    nonce: gameState.nonce,
    bets: [],
    history: publicHistoryList(),
  });

  phaseTimer = setTimeout(() => {
    startFlyingPhase().catch((err) => console.error('[Flight Start Error]', err));
  }, BETTING_DURATION_MS);
}

async function startFlyingPhase() {
  clearTimeout(phaseTimer);
  clearInterval(tickTimer);

  const settings = await db.getSettings();
  const totalRoundBet = gameState.bets.reduce((sum, b) => sum + b.amount, 0);
  const totalRealRoundBet = gameState.bets
    .filter((b) => b.currencyMode === 'real')
    .reduce((sum, b) => sum + b.amount, 0);

  gameState.totalRoundBet = Math.round(totalRoundBet * 100) / 100;
  gameState.totalRealRoundBet = Math.round(totalRealRoundBet * 100) / 100;
  gameState.totalRoundPayouts = 0;
  gameState.totalRealRoundPayouts = 0;

  // Record Real Money PKR bets in Daily House Profit Pool (or fallback to total if only fun bets)
  const poolBetDelta = gameState.totalRealRoundBet;
  const updatedDailyBets =
    Math.round((Number(settings.dailyTotalBets || 0) + poolBetDelta) * 100) / 100;
  const projectedDailyNet =
    Math.round((updatedDailyBets - Number(settings.dailyTotalPayouts || 0)) * 100) / 100;

  if (poolBetDelta > 0) {
    await db.updateSettings({
      dailyTotalBets: updatedDailyBets,
      dailyNetProfit: projectedDailyNet,
    });
  }

  let crashPoint = computeRawCrashPoint(
    gameState.serverSeed,
    gameState.clientSeed,
    gameState.nonce
  );

  const target = Number(settings.dailyProfitTarget || 0);
  const tolerancePct = Math.min(10, Math.max(5, Number(settings.varianceTolerancePct || 8)));
  const protectedFloor = Math.max(0, target * (1 - tolerancePct / 100));
  const surplusPool = Math.max(0, projectedDailyNet - target);

  let maxAllowedRoundPayout = Infinity;
  let protectionActive = false;

  if (gameState.totalRealRoundBet > 0) {
    if (surplusPool > 0 && target > 0) {
      const boostRatio = Math.min(surplusPool / gameState.totalRealRoundBet, 8.0);
      const boostedFloor = Math.min(25.0, Math.max(crashPoint, 1.45 + boostRatio));
      crashPoint = Math.round(boostedFloor * 100) / 100;
      maxAllowedRoundPayout = Math.max(0, projectedDailyNet - protectedFloor);
      protectionActive = true;
    } else if (projectedDailyNet >= protectedFloor && target > 0) {
      maxAllowedRoundPayout = Math.max(
        gameState.totalRealRoundBet * 1.5,
        projectedDailyNet - protectedFloor
      );
      protectionActive = true;
    } else {
      maxAllowedRoundPayout = Math.max(
        gameState.totalRealRoundBet * 3.5,
        target * (tolerancePct / 100)
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

  io.emit('round:flying', {
    roundNumber: gameState.roundNumber,
    flightStartedAt: gameState.flightStartedAt,
    totalRoundBet: gameState.totalRoundBet,
    bets: publicBetsList(),
  });

  if (crashPoint <= 1.0) {
    await triggerCrash(1.0);
    return;
  }

  tickTimer = setInterval(() => {
    runFlightTick().catch((err) => console.error('[Flight Tick Error]', err));
  }, TICK_INTERVAL_MS);
}

async function processCashout(bet, multiplier) {
  if (bet.cashedOut || gameState.phase !== 'FLYING') return null;

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
      (b) => !b.cashedOut && b.currencyMode === 'real'
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

  // 3. Trigger Auto-Cashouts ONLY when bet.autoCashout is explicitly enabled (>= 1.01)
  for (const bet of gameState.bets) {
    if (!bet.cashedOut && bet.autoCashout !== null && bet.autoCashout >= 1.01) {
      if (currentMult >= bet.autoCashout) {
        await processCashout(bet, bet.autoCashout);
      }
    }
  }

  // 4. Broadcast live multiplier tick
  io.emit('round:tick', {
    roundNumber: gameState.roundNumber,
    multiplier: currentMult,
    elapsedMs: Date.now() - gameState.flightStartedAt,
  });
}

async function triggerCrash(finalMultiplier) {
  if (gameState.phase !== 'FLYING') return;
  clearInterval(tickTimer);
  clearTimeout(phaseTimer);

  gameState.phase = 'CRASHED';
  const crashPoint = Math.max(1.0, Math.round(finalMultiplier * 100) / 100);
  gameState.currentMultiplier = crashPoint;

  const losingBets = gameState.bets.filter((b) => !b.cashedOut);
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

  const settings = await db.getSettings();
  const updatedPayouts =
    Math.round((Number(settings.dailyTotalPayouts || 0) + gameState.totalRealRoundPayouts) * 100) /
    100;
  const updatedNet =
    Math.round((Number(settings.dailyTotalBets || 0) - updatedPayouts) * 100) / 100;
  const target = Number(settings.dailyProfitTarget || 0);
  const carryForwardPool = Math.max(0, Math.round((updatedNet - target) * 100) / 100);

  if (gameState.totalRealRoundBet > 0 || gameState.totalRealRoundPayouts > 0) {
    await db.updateSettings({
      dailyTotalPayouts: updatedPayouts,
      dailyNetProfit: updatedNet,
      carryForwardPool,
    });
  }

  const roundRecord = {
    roundNumber: gameState.roundNumber,
    crashPoint,
    totalBets: gameState.totalRealRoundBet,
    totalPayouts: gameState.totalRealRoundPayouts,
    netDelta:
      Math.round((gameState.totalRealRoundBet - gameState.totalRealRoundPayouts) * 100) / 100,
    serverSeed: gameState.serverSeed,
    serverSeedHash: gameState.serverSeedHash,
    clientSeed: gameState.clientSeed,
    nonce: gameState.nonce,
    createdAt: new Date(),
  };

  await db.pushRoundHistory(roundRecord, 20);

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

  io.emit('round:crashed', {
    roundNumber: gameState.roundNumber,
    crashPoint,
    serverSeed: gameState.serverSeed,
    serverSeedHash: gameState.serverSeedHash,
    clientSeed: gameState.clientSeed,
    nonce: gameState.nonce,
    totalBets: gameState.totalRoundBet,
    totalPayouts: gameState.totalRoundPayouts,
    history: publicHistoryList(),
  });

  phaseTimer = setTimeout(() => {
    startBettingPhase().catch((err) => console.error('[Next Round Error]', err));
  }, CRASH_HOLD_MS);
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
        if (user && !user.isBanned) {
          socket.user = user;
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

  socket.emit('game:init', {
    phase: gameState.phase,
    roundNumber: gameState.roundNumber,
    bettingEndsAt: gameState.bettingEndsAt,
    flightStartedAt: gameState.flightStartedAt,
    currentMultiplier: gameState.currentMultiplier,
    serverSeedHash: gameState.serverSeedHash,
    clientSeed: gameState.clientSeed,
    nonce: gameState.nonce,
    bets: publicBetsList(),
    history: publicHistoryList(),
    onlineCount: io.engine.clientsCount,
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
      if (!user || user.isBanned) {
        if (cb) cb({ ok: false, error: 'Account unavailable' });
        return;
      }
      socket.user = user;
      registerUserSocket(String(user._id), socket);
      if (cb) cb({ ok: true, user: sanitizeUser(user) });
    } catch {
      if (cb) cb({ ok: false, error: 'Invalid token' });
    }
  });

  // Place Bet (Dual slots: 1 or 2, Currency: 'fun' | 'real')
  socket.on('bet:place', async ({ slot, amount, autoCashout, currencyMode }, cb) => {
    try {
      if (!socket.user) {
        return cb?.({ ok: false, error: 'Please log in to place a bet.' });
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
      if (!Number.isFinite(betAmount) || betAmount < 1 || betAmount > 100000) {
        return cb?.({
          ok: false,
          error: `Bet must be between 1 and 100,000 ${mode === 'real' ? 'PKR' : 'FC'}.`,
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

      const elapsedSec = (Date.now() - gameState.flightStartedAt) / 1000;
      const liveMult = Math.max(
        1.0,
        Math.floor(Math.exp(MULTIPLIER_GROWTH_RATE * elapsedSec) * 100) / 100
      );

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
  await startBettingPhase();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SkyWing] Unified server listening on http://0.0.0.0:${PORT}`);
    console.log(`[SkyWing] Admin Panel available at http://0.0.0.0:${PORT}/admin`);
  });
}

boot().catch((err) => {
  console.error('[Fatal Boot Error]', err);
  process.exit(1);
});
