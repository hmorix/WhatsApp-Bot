import mongoose from 'mongoose';

mongoose.set('bufferCommands', false);

let isConnected = false;

export async function connectDB(mongoUri) {
    if (!mongoUri) {
        console.log('ℹ️  No MONGODB_URI provided in .env. Falling back to local file storage.');
        return false;
    }

    try {
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 6000,
        });
        isConnected = true;
        console.log('✅ Connected to MongoDB successfully.');
        return true;
    } catch (err) {
        console.error('⚠️  MongoDB Connection Error:', err.message);
        console.log('ℹ️  Operating in fallback mode (using local txt files).');
        isConnected = false;
        return false;
    }
}

export function isMongoConnected() {
    return isConnected;
}
