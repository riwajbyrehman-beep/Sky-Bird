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
