import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import { GoogleGenAI } from '@google/genai';
import pino from 'pino';

import { connectDB, isMongoConnected } from './db.js';
import { Settings } from './models/Settings.js';
import { Message } from './models/Message.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Paths ───────────────────────────────────────────────────────────────────
const CHATS_DIR = path.join(__dirname, 'chats');
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system_prompt.txt');
const ALLOWED_NUMBERS_FILE = path.join(__dirname, 'allowed_numbers.txt');
const AUTH_DIR = path.join(__dirname, 'baileys_auth'); // session stored here (persistent)

// ─── Ensure directories & files exist ────────────────────────────────────────
for (const dir of [CHATS_DIR, AUTH_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(SYSTEM_PROMPT_FILE)) {
    fs.writeFileSync(SYSTEM_PROMPT_FILE, 'You are a helpful and polite virtual assistant for WhatsApp.', 'utf8');
}
if (!fs.existsSync(ALLOWED_NUMBERS_FILE)) {
    fs.writeFileSync(ALLOWED_NUMBERS_FILE, '', 'utf8');
}

// ─── In-memory settings ───────────────────────────────────────────────────────
let cachedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8');
let cachedAllowedNumbers = fs
    .readFileSync(ALLOWED_NUMBERS_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Logging: silent Baileys output ──────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Helper: is user allowed? ─────────────────────────────────────────────────
function isAllowedUser(phoneNumber) {
    if (!cachedAllowedNumbers.length) return true; // empty list = allow all
    return cachedAllowedNumbers.some(n => phoneNumber.endsWith(n));
}

// ─── Helper: get last N messages ─────────────────────────────────────────────
async function getLastMessages(phoneNumber, limit = 15) {
    if (isMongoConnected()) {
        try {
            const docs = await Message.find({ phoneNumber })
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();
            return docs.reverse().map(d => {
                const timeStr = new Date(d.timestamp).toISOString().replace('T', ' ').slice(0, 16);
                return `[${timeStr}] ${d.role}: ${d.message}`;
            });
        } catch (e) {
            console.error('Error fetching from MongoDB:', e.message);
        }
    }
    const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit);
}

// ─── Helper: record message ───────────────────────────────────────────────────
async function recordMessage(phoneNumber, role, messageText) {
    const cleanMessage = messageText.replace(/\n/g, ' ');
    if (isMongoConnected()) {
        try {
            await Message.create({ phoneNumber, role, message: cleanMessage, timestamp: new Date() });
        } catch (e) {
            console.error('Failed to log to MongoDB:', e.message);
        }
    }
    try {
        const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
        fs.appendFileSync(filePath, `[${timestamp}] ${role}: ${cleanMessage}\n`, 'utf8');
    } catch (e) {}
}

// ─── Sync MongoDB settings ────────────────────────────────────────────────────
async function syncDatabase() {
    if (!isMongoConnected()) return;
    try {
        let config = await Settings.findOne({ key: 'global_config' });
        if (!config) {
            await Settings.create({
                key: 'global_config',
                systemPrompt: cachedSystemPrompt,
                allowedNumbers: cachedAllowedNumbers,
            });
            console.log('✅ MongoDB Settings initialized.');
        } else {
            cachedSystemPrompt = config.systemPrompt || cachedSystemPrompt;
            cachedAllowedNumbers = config.allowedNumbers || cachedAllowedNumbers;
            fs.writeFileSync(SYSTEM_PROMPT_FILE, cachedSystemPrompt, 'utf8');
            fs.writeFileSync(ALLOWED_NUMBERS_FILE, cachedAllowedNumbers.join('\n'), 'utf8');
            console.log('✅ Synced settings from MongoDB.');
        }
    } catch (err) {
        console.error('⚠️  MongoDB sync failed:', err.message);
    }
}

// ─── Main WhatsApp connection ─────────────────────────────────────────────────
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`\n📦 Using WA Web v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: true,       // prints QR in terminal for first-time scan
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
    });

    // Save credentials whenever they update (persistent login)
    sock.ev.on('creds.update', saveCreds);

    // ─── Connection state handler ─────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan this QR with WhatsApp → Linked Devices → Link a Device');
            console.log('   (Only needed once! Session is saved permanently after scan)\n');
        }

        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`\n❌ Connection closed. Reason code: ${code}`);

            if (code === DisconnectReason.loggedOut) {
                console.log('🔒 Logged out! Clearing saved session...');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
                console.log('🔄 Restart the bot to scan QR again.');
                process.exit(1);
            } else {
                console.log('🔄 Reconnecting in 5 seconds...');
                setTimeout(() => connectWhatsApp(), 5000);
            }
        }

        if (connection === 'open') {
            console.log('\n✅ WhatsApp connected! Bot is live.\n');
            console.log('   Session saved to ./baileys_auth — no QR needed on next start.');
            console.log('   Press Ctrl+C to stop.\n');
        }
    });

    // ─── Incoming message handler ─────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (!msg.key.remoteJid) continue;
            if (isJidBroadcast(msg.key.remoteJid)) continue;
            if (msg.key.remoteJid.endsWith('@g.us')) continue;  // skip groups
            if (msg.key.fromMe) continue;                        // skip own messages

            const jid = msg.key.remoteJid;
            const phoneNumber = jid.split('@')[0];

            // Extract text from different message types
            const userMessage =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                '';

            if (!userMessage.trim()) continue;

            // Allowed number check
            if (!isAllowedUser(phoneNumber)) {
                console.log(`🔒 Ignored message from ${phoneNumber} (not in allowed list)`);
                continue;
            }

            console.log(`\n📩 Message from ${phoneNumber}: ${userMessage}`);

            try {
                // Mark message as read (show blue ticks)
                await sock.readMessages([msg.key]);

                // Get conversation history
                const history = await getLastMessages(phoneNumber, 15);

                // Record incoming message
                await recordMessage(phoneNumber, 'USER', userMessage);

                // Build Gemini prompt with history
                let fullPrompt = '';
                if (history.length > 0) {
                    fullPrompt += `--- CONTEXT (Last ${history.length} messages) ---\n`;
                    fullPrompt += history.join('\n') + '\n-----------------------------------\n\n';
                }
                fullPrompt += `USER: ${userMessage}\nAI:`;

                // Simulate reading delay
                const wordCount = userMessage.split(/\s+/).length;
                const readingDelayMs = Math.max(1500, wordCount * 300);
                console.log(`🤔 Reading for ${Math.round(readingDelayMs / 1000)}s...`);
                await new Promise(r => setTimeout(r, readingDelayMs));

                // Show "typing..." indicator
                await sock.sendPresenceUpdate('composing', jid);

                // Call Gemini AI
                const response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: fullPrompt,
                    config: {
                        systemInstruction: cachedSystemPrompt,
                        temperature: 0.9,
                        maxOutputTokens: 60,
                    },
                });
                const aiResponse = response.text ? response.text.trim() : '';

                if (!aiResponse) {
                    await sock.sendPresenceUpdate('paused', jid);
                    continue;
                }

                // Simulate typing delay based on response length
                const responseWordCount = aiResponse.split(/\s+/).length;
                const typingDelayMs = Math.max(2000, responseWordCount * 500);
                console.log(`⏳ Typing for ${Math.round(typingDelayMs / 1000)}s...`);
                await new Promise(r => setTimeout(r, typingDelayMs));

                // Stop typing indicator
                await sock.sendPresenceUpdate('paused', jid);

                // Send reply (quoted to original message)
                await sock.sendMessage(jid, { text: aiResponse }, { quoted: msg });
                console.log(`🤖 Replied to ${phoneNumber}: ${aiResponse}`);

                // Record AI response
                await recordMessage(phoneNumber, 'AI', aiResponse);

            } catch (err) {
                console.error(`❌ Error handling message from ${phoneNumber}:`, err.message || err);
                try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
            }
        }
    });

    return sock;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n🚀 WhatsApp AI Bot — Baileys Edition (Termux-friendly)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await connectDB(process.env.MONGODB_URI);
    await syncDatabase();
    await connectWhatsApp();
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Bot stopped. Session saved — restart anytime without re-scanning QR.');
    process.exit(0);
});
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));
