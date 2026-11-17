import mongoose from 'mongoose';

const roundSummarySchema = new mongoose.Schema(
  {
    roundNumber: { type: Number, required: true },
    crashPoint: { type: Number, required: true },
    totalBets: { type: Number, default: 0 },
    totalPayouts: { type: Number, default: 0 },
    netDelta: { type: Number, default: 0 },
    serverSeed: { type: String, required: true },
    serverSeedHash: { type: String, required: true },
    clientSeed: { type: String, required: true },
    nonce: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const securityLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    details: { type: String, default: '' },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const gameModuleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    tagline: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    houseEdgePct: { type: Number, default: 4, min: 0, max: 25 },
    minBet: { type: Number, default: 1, min: 1 },
    maxBet: { type: Number, default: 100000, min: 10 },
  },
  { _id: false }
);

const settingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'global',
      unique: true,
    },
    whatsappSupportEnabled: {
      type: Boolean,
      default: true,
    },
    whatsappSupportNumber: {
      type: String,
      default: '923001234567',
      trim: true,
    },
    whatsappChannelEnabled: {
      type: Boolean,
      default: true,
    },
    whatsappChannelUrl: {
      type: String,
      default: 'https://whatsapp.com/channel/0029VaSkyWingOfficial',
      trim: true,
    },
    telegramChannelEnabled: {
      type: Boolean,
      default: true,
    },
    telegramChannelUrl: {
      type: String,
      default: 'https://t.me/SkyWingOfficial',
      trim: true,
    },
    maskMasterAccounts: {
      type: Boolean,
      default: true,
    },
    paymentAccounts: {
      easypaisa: {
        enabled: { type: Boolean, default: true },
        accountTitle: { type: String, default: 'SkyWing Official', trim: true },
        accountNumber: { type: String, default: '03451234567', trim: true },
      },
      jazzcash: {
        enabled: { type: Boolean, default: true },
        accountTitle: { type: String, default: 'SkyWing Official', trim: true },
        accountNumber: { type: String, default: '03001234567', trim: true },
      },
      bank: {
        enabled: { type: Boolean, default: true },
        bankName: { type: String, default: 'Meezan Bank', trim: true },
        accountTitle: { type: String, default: 'SkyWing Enterprises', trim: true },
        accountNumber: {
          type: String,
          default: 'PK36MEZN0000000123456789',
          trim: true,
        },
      },
    },
    financialLimits: {
      minDeposit: { type: Number, default: 50, min: 10 },
      minWithdrawal: { type: Number, default: 100, min: 10 },
      withdrawalFeePct: { type: Number, default: 0, min: 0, max: 25 },
      microDepositAutoApproveLimit: { type: Number, default: 1000, min: 0 },
    },
    withdrawalHours: {
      enabled: { type: Boolean, default: false },
      openTime: { type: String, default: '09:00', trim: true },
      closeTime: { type: String, default: '17:00', trim: true },
      noticeText: {
        type: String,
        default: 'Withdrawals are only open from 9:00 AM to 5:00 PM.',
        trim: true,
      },
    },
    platformStatus: {
      mode: {
        type: String,
        enum: ['active', 'maintenance', 'disabled'],
        default: 'active',
      },
      message: {
        type: String,
        default:
          'SkyWing Crash is currently undergoing scheduled maintenance. Your wallet & bets are safe. Back shortly!',
        trim: true,
      },
    },
    audioConfig: {
      bgmEnabled: { type: Boolean, default: true },
      soundPreset: {
        type: String,
        enum: ['aviator-jet', 'cyber-flight', 'casino-chime', 'turbo-arcade', 'stealth-minimal'],
        default: 'aviator-jet',
      },
      masterVolume: {
        type: Number,
        default: 75,
        min: 0,
        max: 100,
      },
    },
    profitControl: {
      mode: {
        type: String,
        enum: ['balanced', 'house-edge', 'low-crash', 'generous'],
        default: 'balanced',
      },
      houseEdgePct: {
        type: Number,
        default: 4,
        min: 0,
        max: 25,
      },
      maxCrashCap: {
        type: Number,
        default: 100,
        min: 1.05,
        max: 100,
      },
    },
    profitDistributionPool: {
      type: Number,
      default: 10000,
      min: 0,
    },
    rtpRiskConfig: {
      autoAdjustEnabled: { type: Boolean, default: true },
      targetRtpPct: { type: Number, default: 96, min: 75, max: 99 },
      dynamicEdgeOffset: { type: Number, default: 0, min: -3, max: 8 },
      currentRiskIndex: { type: Number, default: 15, min: 0, max: 100 },
      lastEvaluatedAt: { type: Date, default: null },
    },
    gamesConfig: {
      type: [gameModuleSchema],
      default: [
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
      ],
    },
    security: {
      masterPasswordHash: { type: String, default: '' },
      totpEnabled: { type: Boolean, default: false },
      totpSecret: { type: String, default: '' },
      securityLogs: { type: [securityLogSchema], default: [] },
    },
    telegramBot: {
      enabled: { type: Boolean, default: false },
      botToken: { type: String, default: '', trim: true },
      adminChatId: { type: String, default: '', trim: true },
      webhookSecret: { type: String, default: '', trim: true },
    },
    dailyProfitTarget: {
      type: Number,
      default: 30000,
      min: 0,
    },
    varianceTolerancePct: {
      type: Number,
      default: 8,
      min: 5,
      max: 10,
    },
    welcomeBonusCredits: {
      type: Number,
      default: 1000,
      min: 0,
    },
    dailyDateKey: {
      type: String,
      default: () => new Date().toISOString().slice(0, 10),
    },
    dailyTotalBets: {
      type: Number,
      default: 0,
    },
    dailyTotalPayouts: {
      type: Number,
      default: 0,
    },
    dailyNetProfit: {
      type: Number,
      default: 0,
    },
    carryForwardPool: {
      type: Number,
      default: 0,
      min: 0,
    },
    roundCounter: {
      type: Number,
      default: 1000,
    },
    recentRounds: {
      type: [roundSummarySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Settings = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);
export default Settings;
