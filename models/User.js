import mongoose from 'mongoose';

const betRecordSchema = new mongoose.Schema(
  {
    roundNumber: { type: Number, required: true },
    game: { type: String, default: 'skywing-crash' },
    currencyMode: { type: String, enum: ['fun', 'real'], default: 'fun' },
    betAmount: { type: Number, required: true },
    cashoutMultiplier: { type: Number, default: null },
    payout: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    crashedAt: { type: Number, required: true },
    risk: { type: String, default: '' },
    diamondsCount: { type: Number, default: 0 },
    minesCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const payoutAccountSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    method: {
      type: String,
      enum: ['EasyPaisa', 'JazzCash', 'Bank Account'],
      required: true,
    },
    bankName: { type: String, default: '', trim: true },
    accountTitle: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    cnic: {
      type: String,
      required: true,
      trim: true,
      match: [/^[0-9]{5}-[0-9]{7}-[0-9]{1}$/, 'CNIC must match XXXXX-XXXXXXX-X'],
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    phoneNumber: {
      type: String,
      required: [true, 'Pakistani mobile number is required'],
      unique: true,
      index: true,
      trim: true,
      match: [
        /^03[0-9]{9}$/,
        'Mobile number must be an 11-digit Pakistani number starting with 03 (e.g. 03001234567)',
      ],
    },
    displayName: {
      type: String,
      trim: true,
      maxlength: 24,
      default: '',
    },
    cnic: {
      type: String,
      trim: true,
      default: '',
    },
    passwordHash: {
      type: String,
      required: true,
    },
    funBalance: {
      type: Number,
      default: 1000,
      min: 0,
    },
    realBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDeposited: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWageredFun: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWonFun: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWageredReal: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWonReal: {
      type: Number,
      default: 0,
      min: 0,
    },
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true,
    },
    referredBy: {
      type: String,
      default: '',
      trim: true,
    },
    firstDepositRewarded: {
      type: Boolean,
      default: false,
    },
    referralEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastDailyClaimAt: {
      type: Date,
      default: null,
    },
    lastWeeklyClaimAt: {
      type: Date,
      default: null,
    },
    savedPayoutAccounts: {
      type: [payoutAccountSchema],
      default: [],
    },
    registrationIp: {
      type: String,
      default: '',
      trim: true,
    },
    lastLoginIp: {
      type: String,
      default: '',
      trim: true,
    },
    deviceFingerprint: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    bonusRestricted: {
      type: Boolean,
      default: false,
    },
    restrictionReason: {
      type: String,
      default: '',
      trim: true,
    },
    acceptedTermsAt: {
      type: Date,
      default: Date.now,
    },
    // Legacy compatibility fields
    funCredits: { type: Number, default: 1000, min: 0 },
    totalWagered: { type: Number, default: 0, min: 0 },
    totalWon: { type: Number, default: 0, min: 0 },
    isBanned: {
      type: Boolean,
      default: false,
    },
    recentBets: {
      type: [betRecordSchema],
      default: [],
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ phoneNumber: 1 }, { unique: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
export default User;
