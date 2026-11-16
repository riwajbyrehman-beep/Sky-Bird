import mongoose from 'mongoose';

const betRecordSchema = new mongoose.Schema(
  {
    roundNumber: { type: Number, required: true },
    currencyMode: { type: String, enum: ['fun', 'real'], default: 'fun' },
    betAmount: { type: Number, required: true },
    cashoutMultiplier: { type: Number, default: null },
    payout: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    crashedAt: { type: Number, required: true },
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
  },
  {
    timestamps: true,
  }
);

userSchema.index({ phoneNumber: 1 }, { unique: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
export default User;
