import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      type: String,
      default: '',
      trim: true,
    },
    type: {
      type: String,
      enum: ['deposit', 'withdrawal'],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    feeAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    netAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    method: {
      type: String,
      enum: ['EasyPaisa', 'JazzCash', 'Bank Account'],
      required: true,
    },
    senderName: {
      type: String,
      default: '',
      trim: true,
    },
    senderNumber: {
      type: String,
      default: '',
      trim: true,
    },
    qrReference: {
      type: String,
      default: '',
      trim: true,
    },
    transactionId: {
      type: String,
      default: '',
      trim: true,
    },
    screenshotData: {
      type: String,
      default: '',
    },
    autoApproved: {
      type: Boolean,
      default: false,
    },
    accountDetails: {
      bankName: { type: String, default: '', trim: true },
      accountTitle: { type: String, default: '', trim: true },
      accountNumber: { type: String, default: '', trim: true },
      cnic: { type: String, default: '', trim: true },
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    rejectionReason: {
      type: String,
      default: '',
      trim: true,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ transactionId: 1 });

const Transaction =
  mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
export default Transaction;
