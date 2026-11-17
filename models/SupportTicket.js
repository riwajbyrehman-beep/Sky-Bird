import mongoose from 'mongoose';

const supportMessageSchema = new mongoose.Schema(
  {
    sender: { type: String, enum: ['user', 'admin'], required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    phoneNumber: { type: String, required: true, trim: true },
    displayName: { type: String, default: '', trim: true },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    messages: { type: [supportMessageSchema], default: [] },
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

const SupportTicket =
  mongoose.models.SupportTicket || mongoose.model('SupportTicket', supportTicketSchema);
export default SupportTicket;
