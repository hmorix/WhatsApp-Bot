import mongoose from 'mongoose';

const interviewSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, index: true },
    scheduledTime: { type: Date, required: true, index: true },
    candidateName: { type: String, default: 'Candidate' },
    role: { type: String, default: 'General' },
    status: { type: String, default: 'scheduled', enum: ['scheduled', 'completed', 'cancelled'] },
    reminded2h: { type: Boolean, default: false },
    reminded1h: { type: Boolean, default: false },
    reminded15m: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

export const Interview = mongoose.models.Interview || mongoose.model('Interview', interviewSchema);
