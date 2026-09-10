import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcodeTerminal from 'qrcode-terminal';

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
    // If explicitly configured to allow all or wildcard '*' or 'all' or empty list:
    if (process.env.ALLOW_ALL_NUMBERS === 'true') return true;
    if (!cachedAllowedNumbers.length || cachedAllowedNumbers.includes('*') || cachedAllowedNumbers.includes('all')) {
        return true;
    }

    const cleanPhone = String(phoneNumber).replace(/[^0-9]/g, '');
    return cachedAllowedNumbers.some(n => {
        const cleanN = String(n).replace(/[^0-9]/g, '');
        if (!cleanN) return false;
        return cleanPhone.endsWith(cleanN) || cleanN.endsWith(cleanPhone) || cleanPhone === cleanN;
    });
}

// ─── Live File Watchers (Auto-Reload on Edit) ────────────────────────────────
function setupFileWatchers() {
    let allowedDebounce = null;
    try {
        fs.watch(ALLOWED_NUMBERS_FILE, () => {
            clearTimeout(allowedDebounce);
            allowedDebounce = setTimeout(async () => {
                try {
                    if (fs.existsSync(ALLOWED_NUMBERS_FILE)) {
                        const content = fs.readFileSync(ALLOWED_NUMBERS_FILE, 'utf8');
                        cachedAllowedNumbers = content
                            .split('\n')
                            .map(l => l.trim())
                            .filter(Boolean);

                        const allowAll = !cachedAllowedNumbers.length || cachedAllowedNumbers.includes('*') || cachedAllowedNumbers.includes('all');
                        console.log(`\n🔄 [Auto-Reload] allowed_numbers.txt updated live!`);
                        if (allowAll) {
                            console.log(`🌟 Mode: ALL numbers allowed! (Every contact receives AI responses)`);
                        } else {
                            console.log(`🔒 Mode: Whitelist active. Allowed: [${cachedAllowedNumbers.join(', ')}]`);
                        }

                        if (isMongoConnected()) {
                            await Settings.findOneAndUpdate(
                                { key: 'global_config' },
                                { allowedNumbers: cachedAllowedNumbers, updatedAt: new Date() }
                            );
                            console.log('☁️ Synced updated allowed numbers to MongoDB.');
                        }
                    }
                } catch (err) {
                    console.error('⚠️  Failed to reload allowed_numbers.txt:', err.message);
                }
            }, 300);
        });
        console.log('👀 Watching allowed_numbers.txt for live changes (auto-reload active)');
    } catch (e) {
        console.warn('⚠️  Could not watch allowed_numbers.txt:', e.message);
    }

    let promptDebounce = null;
    try {
        fs.watch(SYSTEM_PROMPT_FILE, () => {
            clearTimeout(promptDebounce);
            promptDebounce = setTimeout(async () => {
                try {
                    if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
                        cachedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8');
                        console.log('\n🔄 [Auto-Reload] system_prompt.txt updated live!');
                        if (isMongoConnected()) {
                            await Settings.findOneAndUpdate(
                                { key: 'global_config' },
                                { systemPrompt: cachedSystemPrompt, updatedAt: new Date() }
                            );
                            console.log('☁️ Synced updated system prompt to MongoDB.');
                        }
                    }
                } catch (err) {
                    console.error('⚠️  Failed to reload system_prompt.txt:', err.message);
                }
            }, 300);
        });
        console.log('👀 Watching system_prompt.txt for live changes (auto-reload active)');
    } catch (e) {
        console.warn('⚠️  Could not watch system_prompt.txt:', e.message);
    }
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
            // If local allowed numbers has '*' or 'all' (allow everyone), persist to MongoDB
            if (cachedAllowedNumbers.includes('*') || cachedAllowedNumbers.includes('all')) {
                await Settings.findOneAndUpdate(
                    { key: 'global_config' },
                    { allowedNumbers: cachedAllowedNumbers, updatedAt: new Date() }
                );
                console.log('✅ Synchronized settings: ALLOW ALL numbers (*) active.');
            } else if (config.allowedNumbers && config.allowedNumbers.length > 0 && !cachedAllowedNumbers.length) {
                cachedAllowedNumbers = config.allowedNumbers;
                fs.writeFileSync(ALLOWED_NUMBERS_FILE, cachedAllowedNumbers.join('\n'), 'utf8');
                console.log('✅ Synced settings from MongoDB.');
            }
            cachedSystemPrompt = config.systemPrompt || cachedSystemPrompt;
            fs.writeFileSync(SYSTEM_PROMPT_FILE, cachedSystemPrompt, 'utf8');
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
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📱 Scan this QR in WhatsApp → Linked Devices → Link a Device');
            console.log('   (Only needed once — session saved permanently after scan)\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
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

            // Resolve real phone number — newer WhatsApp uses LID (@lid) instead of phone numbers
            // Try to get the real number from verifiedBizName, notify, or pushName fallbacks
            let phoneNumber = jid.split('@')[0];

            // If this is a LID (not a real phone number), try to get the actual number
            if (jid.endsWith('@lid') || !/^\d{7,15}$/.test(phoneNumber)) {
                // Try from message's pushName/notify or sender number fields
                const senderJid =
                    msg.key.participant ||
                    msg.participant ||
                    '';
                if (senderJid && senderJid.includes('@')) {
                    const candidate = senderJid.split('@')[0];
                    if (/^\d{7,15}$/.test(candidate)) {
                        phoneNumber = candidate;
                    }
                }
                // Still a LID? Try verifiedBizName or notify in message
                if (!/^\d{7,15}$/.test(phoneNumber)) {
                    const notify = msg.pushName || '';
                    console.log(`⚠️  LID contact detected (${jid.split('@')[0]}). Add their number manually to allowed_numbers.txt if needed.`);
                }
            }

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
    setupFileWatchers();

    const allowAll = !cachedAllowedNumbers.length || cachedAllowedNumbers.includes('*') || cachedAllowedNumbers.includes('all') || process.env.ALLOW_ALL_NUMBERS === 'true';
    if (allowAll) {
        console.log('🌟 Mode: ALL numbers allowed! (Every contact receives AI responses)\n');
    } else {
        console.log(`🔒 Mode: Whitelist active. Allowed: [${cachedAllowedNumbers.join(', ')}]\n`);
    }

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
