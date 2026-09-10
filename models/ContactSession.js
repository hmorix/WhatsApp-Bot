import mongoose from 'mongoose';

const contactSessionSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true, index: true },
    activeAgent: { type: String, enum: ['orix', 'blopsy', 'manik'], default: 'orix' },
    leadType: { type: String, enum: ['client', 'candidate', 'friend', 'unknown'], default: 'unknown' },
    summary: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now }
});

export const ContactSession = mongoose.models.ContactSession || mongoose.model('ContactSession', contactSessionSchema);
