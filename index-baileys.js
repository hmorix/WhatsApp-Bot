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
import { ContactSession } from './models/ContactSession.js';
import { Interview } from './models/Interview.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Paths ───────────────────────────────────────────────────────────────────
const CHATS_DIR = path.join(__dirname, 'chats');
const AUTH_DIR = path.join(__dirname, 'baileys_auth');
const ALLOWED_NUMBERS_FILE = path.join(__dirname, 'allowed_numbers.txt');
const PERSONAL_NUMBERS_FILE = path.join(__dirname, 'personal_numbers.txt');
const SESSIONS_FILE = path.join(__dirname, 'contact_sessions.json');
const INTERVIEWS_FILE = path.join(__dirname, 'scheduled_interviews.json');

const PROMPT_MANIK_FILE = path.join(__dirname, 'system_prompt.txt');
const PROMPT_ORIX_FILE = path.join(__dirname, 'system_prompt_orix.txt');
const PROMPT_BLOPSY_FILE = path.join(__dirname, 'system_prompt_blopsy.txt');

// ─── Ensure directories & files exist ────────────────────────────────────────
for (const dir of [CHATS_DIR, AUTH_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(ALLOWED_NUMBERS_FILE)) fs.writeFileSync(ALLOWED_NUMBERS_FILE, '*\n', 'utf8');
if (!fs.existsSync(PERSONAL_NUMBERS_FILE)) fs.writeFileSync(PERSONAL_NUMBERS_FILE, '', 'utf8');
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}', 'utf8');
if (!fs.existsSync(INTERVIEWS_FILE)) fs.writeFileSync(INTERVIEWS_FILE, '[]', 'utf8');

// ─── In-memory Cache & Prompts ────────────────────────────────────────────────
let cachedAllowedNumbers = fs.readFileSync(ALLOWED_NUMBERS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
let cachedPersonalNumbers = fs.readFileSync(PERSONAL_NUMBERS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => Boolean(l) && !l.startsWith('#'));

let cachedPromptManik = fs.existsSync(PROMPT_MANIK_FILE) ? fs.readFileSync(PROMPT_MANIK_FILE, 'utf8') : 'You are Manik, a real person talking over chat in friendly Hinglish.';
let cachedPromptOrix = fs.existsSync(PROMPT_ORIX_FILE) ? fs.readFileSync(PROMPT_ORIX_FILE, 'utf8') : 'You are Orix, senior AI business consultant for HMorix (hmorix.in).';
let cachedPromptBlopsy = fs.existsSync(PROMPT_BLOPSY_FILE) ? fs.readFileSync(PROMPT_BLOPSY_FILE, 'utf8') : 'You are Blopsy, talent acquisition & interview coordinator for HMorix (hmorix.in).';

// Local fallbacks for sessions and interviews
let localSessions = {};
try { localSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) {}

let localInterviews = [];
try { localInterviews = JSON.parse(fs.readFileSync(INTERVIEWS_FILE, 'utf8')); } catch (e) {}

// ─── AI Engine Configuration (Groq & Gemini) ─────────────────────────────────
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const GROQ_MODEL = (process.env.GROQ_MODEL || '').trim().replace(/^["']|["']$/g, '');
let discoveredGroqModels = [];

async function discoverGroqModels() {
    if (!GROQ_API_KEY) return;
    try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }
        });
        if (res.ok) {
            const data = await res.json();
            const list = (data.data || []).map(m => m.id);
            // Only keep text chat/completion models — exclude classifiers, embedders, safety guards
            discoveredGroqModels = list.filter(m =>
                !m.includes('whisper') &&
                !m.includes('vision') &&
                !m.includes('safetensors') &&
                !m.includes('guard') &&
                !m.includes('embed') &&
                !m.includes('moderation') &&
                !m.includes('classifier')
            );
            if (discoveredGroqModels.length > 0) {
                console.log(`⚡ [Groq Engine] Active models on your account: ${discoveredGroqModels.slice(0, 4).join(', ')}`);
            }
        } else {
            const errText = await res.text();
            console.warn(`⚠️  [Groq Auth] Verification returned status ${res.status}: ${errText.slice(0, 80)}...`);
        }
    } catch (e) {
        console.warn('⚠️  [Groq] Could not query models:', e.message);
    }
}

// Parse comma-separated Gemini keys for automatic round-robin rotation
const geminiKeys = (process.env.GEMINI_API_KEY || '')
    .split(',')
    .map(k => k.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
let currentGeminiKeyIndex = 0;

// Gemini Model Priority Cascade (gemini-3.5-flash-lite and gemini-flash-latest first)
const candidateGeminiModels = [
    'gemini-3.5-flash-lite',
    'gemini-flash-latest',
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash'
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // unique

const logger = pino({ level: 'silent' });

// ─── Message Queues per Sender (prevents dropped / overlapping messages) ─────
const chatQueues = new Map(); // key: jid, value: { timeout, messages: [] }

// ─── Helper: Allowed / Personal checks ───────────────────────────────────────
function isAllowedUser(phoneNumber) {
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

function isPersonalContact(phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/[^0-9]/g, '');
    return cachedPersonalNumbers.some(n => {
        const cleanN = String(n).replace(/[^0-9]/g, '');
        if (!cleanN) return false;
        return cleanPhone.endsWith(cleanN) || cleanN.endsWith(cleanPhone) || cleanPhone === cleanN;
    });
}

// ─── Session Management (Agent Routing: Orix vs Blopsy vs Manik) ────────────
async function getActiveAgent(phoneNumber) {
    // 1. Personal contact list always routes to Manik
    if (isPersonalContact(phoneNumber)) {
        return 'manik';
    }

    // 2. Check MongoDB session
    if (isMongoConnected()) {
        try {
            const doc = await ContactSession.findOne({ phoneNumber });
            if (doc && doc.activeAgent) return doc.activeAgent;
        } catch (e) {}
    }

    // 3. Fallback to local session
    if (localSessions[phoneNumber] && localSessions[phoneNumber].activeAgent) {
        return localSessions[phoneNumber].activeAgent;
    }

    // 4. Default business agent: Orix
    return 'orix';
}

async function setContactSession(phoneNumber, activeAgent, leadType = 'unknown') {
    localSessions[phoneNumber] = { activeAgent, leadType, updatedAt: new Date().toISOString() };
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(localSessions, null, 2), 'utf8'); } catch (e) {}

    if (isMongoConnected()) {
        try {
            await ContactSession.findOneAndUpdate(
                { phoneNumber },
                { activeAgent, leadType, updatedAt: new Date() },
                { upsert: true }
            );
        } catch (e) {}
    }
}

// ─── Interview Management & Automated Reminders (2h, 1h, 15m) ────────────────
async function recordScheduledInterview(phoneNumber, dateStr) {
    try {
        const scheduledTime = new Date(dateStr);
        if (isNaN(scheduledTime.getTime())) return;

        const record = {
            phoneNumber,
            scheduledTime,
            status: 'scheduled',
            reminded2h: false,
            reminded1h: false,
            reminded15m: false,
            createdAt: new Date()
        };

        localInterviews.push(record);
        try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}

        if (isMongoConnected()) {
            await Interview.create(record);
        }
        console.log(`📅 [Interview Scheduled] Confirmed for ${phoneNumber} at: ${scheduledTime.toLocaleString('en-IN')}`);
    } catch (e) {
        console.error('Failed to schedule interview:', e.message);
    }
}

function startReminderWorker(sock) {
    // Checks every 60 seconds for interviews needing reminders
    setInterval(async () => {
        const now = Date.now();

        let interviews = localInterviews;
        if (isMongoConnected()) {
            try {
                interviews = await Interview.find({ status: 'scheduled' });
            } catch (e) {
                interviews = localInterviews;
            }
        }

        for (const item of interviews) {
            const interviewTime = new Date(item.scheduledTime).getTime();
            const timeDiffMs = interviewTime - now;
            const minutesLeft = Math.round(timeDiffMs / (60 * 1000));
            const jid = item.phoneNumber.includes('@') ? item.phoneNumber : `${item.phoneNumber}@s.whatsapp.net`;

            // 2 Hours Reminder (between 115 and 125 minutes)
            if (minutesLeft > 60 && minutesLeft <= 125 && !item.reminded2h) {
                const text = `👋 Hello! Gentle reminder from Blopsy at HMorix:\nYour scheduled interview is in approximately 2 hours (${new Date(item.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).\nPlease make sure you are in a quiet room with stable internet connection. All the best! ✨`;
                try {
                    await sock.sendMessage(jid, { text });
                    item.reminded2h = true;
                    if (item.save) await item.save();
                    try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}
                    console.log(`⏰ [Reminder Sent] 2-Hour reminder delivered to ${item.phoneNumber}`);
                } catch (e) {}
            }

            // 1 Hour Reminder (between 50 and 65 minutes)
            if (minutesLeft > 20 && minutesLeft <= 65 && !item.reminded1h) {
                const text = `⏰ Reminder from HMorix (Blopsy):\nYour interview is coming up in 1 hour! Feel free to review our services at https://hmorix.in before we chat. See you soon!`;
                try {
                    await sock.sendMessage(jid, { text });
                    item.reminded1h = true;
                    if (item.save) await item.save();
                    try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}
                    console.log(`⏰ [Reminder Sent] 1-Hour reminder delivered to ${item.phoneNumber}`);
                } catch (e) {}
            }

            // 15 Minutes Reminder (between 5 and 18 minutes)
            if (minutesLeft >= 0 && minutesLeft <= 18 && !item.reminded15m) {
                const text = `🚀 Final reminder: Your interview with HMorix begins in 15 minutes! Please be ready. We are excited to meet you!`;
                try {
                    await sock.sendMessage(jid, { text });
                    item.reminded15m = true;
                    if (item.save) await item.save();
                    try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}
                    console.log(`⏰ [Reminder Sent] 15-Minute reminder delivered to ${item.phoneNumber}`);
                } catch (e) {}
            }
        }
    }, 60 * 1000);
}

// ─── Chat History ─────────────────────────────────────────────────────────────
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
        } catch (e) {}
    }
    const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit);
}

async function recordMessage(phoneNumber, role, messageText) {
    const cleanMessage = messageText.replace(/\n/g, ' ');
    if (isMongoConnected()) {
        try {
            await Message.create({ phoneNumber, role, message: cleanMessage, timestamp: new Date() });
        } catch (e) {}
    }
    try {
        const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
        fs.appendFileSync(filePath, `[${timestamp}] ${role}: ${cleanMessage}\n`, 'utf8');
    } catch (e) {}
}

// ─── Live File Watchers ───────────────────────────────────────────────────────
function setupFileWatchers() {
    const watchWithDebounce = (filePath, onUpdate) => {
        let debounceTimer = null;
        try {
            fs.watch(filePath, () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    try {
                        if (fs.existsSync(filePath)) onUpdate();
                    } catch (e) {}
                }, 300);
            });
            console.log(`👀 Watching ${path.basename(filePath)} (live auto-reload enabled)`);
        } catch (e) {}
    };

    watchWithDebounce(ALLOWED_NUMBERS_FILE, () => {
        cachedAllowedNumbers = fs.readFileSync(ALLOWED_NUMBERS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        const allowAll = !cachedAllowedNumbers.length || cachedAllowedNumbers.includes('*') || cachedAllowedNumbers.includes('all');
        console.log(`\n🔄 [Auto-Reload] allowed_numbers.txt updated! ${allowAll ? '🌟 Mode: ALL numbers allowed' : `🔒 Whitelist: [${cachedAllowedNumbers.join(', ')}]`}`);
    });

    watchWithDebounce(PERSONAL_NUMBERS_FILE, () => {
        cachedPersonalNumbers = fs.readFileSync(PERSONAL_NUMBERS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => Boolean(l) && !l.startsWith('#'));
        console.log(`\n🔄 [Auto-Reload] personal_numbers.txt updated! (Manik persona assigned to: ${cachedPersonalNumbers.join(', ') || 'none'})`);
    });

    watchWithDebounce(PROMPT_ORIX_FILE, () => {
        cachedPromptOrix = fs.readFileSync(PROMPT_ORIX_FILE, 'utf8');
        console.log('\n🔄 [Auto-Reload] system_prompt_orix.txt updated!');
    });

    watchWithDebounce(PROMPT_BLOPSY_FILE, () => {
        cachedPromptBlopsy = fs.readFileSync(PROMPT_BLOPSY_FILE, 'utf8');
        console.log('\n🔄 [Auto-Reload] system_prompt_blopsy.txt updated!');
    });

    watchWithDebounce(PROMPT_MANIK_FILE, () => {
        cachedPromptManik = fs.readFileSync(PROMPT_MANIK_FILE, 'utf8');
        console.log('\n🔄 [Auto-Reload] system_prompt.txt (Manik) updated!');
    });
}

// ─── Groq API Caller (Free Tier: 14,400 requests/day, fluent Hindi/Hinglish/English) ──
const defaultGroqModels = [
    process.env.GROQ_MODEL,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'qwen/qwen3.6-27b',
    'groq/compound',
    'groq/compound-mini',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant'
].filter(Boolean);

// messages = array of {role: 'user'|'assistant', content: string}
async function callGroqAPI(messages, systemInstruction, activeAgent) {
    if (!GROQ_API_KEY) return null;
    const url = 'https://api.groq.com/openai/v1/chat/completions';

    // Prioritize dynamically discovered models, then defaults
    const candidateGroqModels = [...discoveredGroqModels, ...defaultGroqModels]
        .filter((v, i, a) => a.indexOf(v) === i);

    for (const model of candidateGroqModels) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: systemInstruction },
                        ...messages   // proper multi-turn history + current user message
                    ],
                    temperature: activeAgent === 'orix' ? 0.7 : activeAgent === 'blopsy' ? 0.7 : 0.9,
                    max_tokens: 450
                })
            });

            if (res.ok) {
                const json = await res.json();
                const text = json.choices?.[0]?.message?.content?.trim() || '';
                if (text) return text;
            } else {
                const errText = await res.text();
                console.warn(`⚠️  [Groq ${model}] failed (${res.status}): ${errText.slice(0, 100)}...`);
            }
        } catch (err) {
            console.warn(`⚠️  [Groq ${model}] error:`, err.message);
        }
    }
    throw new Error('All Groq candidate models failed or returned empty.');
}

// ─── Robust Multi-Provider AI Caller with Retries & Auto-Fallback ─────────────
// messages = array of {role: 'user'|'assistant', content: string}
async function generateAIResponse(messages, systemInstruction, activeAgent) {
    // 1. Priority: Groq Cloud API (Free tier: 14,400 requests/day)
    if (GROQ_API_KEY) {
        try {
            const text = await callGroqAPI(messages, systemInstruction, activeAgent);
            if (text) return text;
        } catch (err) {
            console.error('⚠️  Groq request failed, falling back to Gemini:', err.message);
        }
    }

    // 2. Secondary: Google Gemini (With model cascade & key rotation)
    if (geminiKeys.length > 0) {
        // Build Gemini-compatible contents array from messages
        const geminiContents = messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        for (const model of candidateGeminiModels) {
            for (let i = 0; i < geminiKeys.length; i++) {
                const apiKey = geminiKeys[(currentGeminiKeyIndex + i) % geminiKeys.length];
                try {
                    const client = new GoogleGenAI({ apiKey });
                    const response = await client.models.generateContent({
                        model,
                        contents: geminiContents,
                        config: {
                            systemInstruction,
                            temperature: activeAgent === 'orix' ? 0.7 : activeAgent === 'blopsy' ? 0.7 : 0.9,
                            maxOutputTokens: 400,
                        },
                    });
                    const text = response.text ? response.text.trim() : '';
                    if (text) {
                        currentGeminiKeyIndex = (currentGeminiKeyIndex + i) % geminiKeys.length;
                        return text;
                    }
                } catch (err) {
                    console.warn(`⚠️  [Gemini ${model}] Key ${i + 1} attempt failed: ${err.message?.slice(0, 100)}...`);
                }
            }
        }
    }

    // 3. Graceful human fallback response so conversation never stops
    if (activeAgent === 'orix') {
        return "Haan ji, main sun raha hun! HMorix ke products (BillingFlow, AI Agents, Web & App Development) ke baare mein aapko kya jaanna hai? Batayein!";
    } else if (activeAgent === 'blopsy') {
        return "Hi! Main sun rahi hun. Aap kis role ke liye apply karna chahte hain? Please share karein!";
    } else {
        return "Haan yrr bol, sun raha hun!";
    }
}

// ─── Process Aggregated Incoming Messages ─────────────────────────────────────
async function processUserMessages(sock, jid, phoneNumber, combinedMessage, originalMsg) {
    if (!isAllowedUser(phoneNumber)) {
        console.log(`🔒 Ignored message from ${phoneNumber} (not in allowed list)`);
        return;
    }

    const activeAgent = await getActiveAgent(phoneNumber);
    const agentLabel = activeAgent === 'orix' ? '💼 ORIX (Smart Tech AI)' : activeAgent === 'blopsy' ? '👩‍💼 BLOPSY (HR)' : '👦 MANIK (Personal)';
    console.log(`\n📩 Message from ${phoneNumber} [Assigned: ${agentLabel}]:\n   "${combinedMessage}"`);

    try {
        await sock.readMessages([originalMsg.key]);
        const history = await getLastMessages(phoneNumber, 12);
        await recordMessage(phoneNumber, 'USER', combinedMessage);

        // Parse history lines into proper multi-turn messages array
        // Each line is: "[YYYY-MM-DD HH:MM] USER: text" or "[...] AI: text"
        const messages = [];
        for (const line of history) {
            const match = line.match(/^\[[\d\- :]+\]\s+(USER|AI):\s+(.+)$/);
            if (match) {
                messages.push({
                    role: match[1] === 'USER' ? 'user' : 'assistant',
                    content: match[2].trim()
                });
            }
        }
        // Add current user message as the latest turn
        messages.push({ role: 'user', content: combinedMessage });

        // Human-like reading delay
        const wordCount = combinedMessage.split(/\s+/).length;
        const readingDelayMs = Math.min(3000, Math.max(1500, wordCount * 250));
        console.log(`🤔 Reading for ${Math.round(readingDelayMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, readingDelayMs));

        await sock.sendPresenceUpdate('composing', jid);

        let systemInstruction = cachedPromptOrix;
        if (activeAgent === 'blopsy') systemInstruction = cachedPromptBlopsy;
        else if (activeAgent === 'manik') systemInstruction = cachedPromptManik;

        let aiReply = await generateAIResponse(messages, systemInstruction, activeAgent);

        // 1. Detect Agent Switch (Orix -> Blopsy)
        if (aiReply.includes('[AGENT_SWITCH:blopsy]')) {
            aiReply = aiReply.replace(/\[AGENT_SWITCH:blopsy\]/gi, '').trim();
            await setContactSession(phoneNumber, 'blopsy', 'candidate');
            console.log(`🔀 [Auto-Handshake] Handed off contact ${phoneNumber} from Orix to BLOPSY (HR)!`);
        }

        // 2. Detect Scheduled Interview [INTERVIEW_SCHEDULED:YYYY-MM-DD HH:MM]
        const scheduleMatch = aiReply.match(/\[INTERVIEW_SCHEDULED:([\d\-]+ [\d:]+)\]/i);
        if (scheduleMatch) {
            const dateTimeStr = scheduleMatch[1];
            aiReply = aiReply.replace(/\[INTERVIEW_SCHEDULED:[\d\-]+ [\d:]+\]/gi, '').trim();
            await recordScheduledInterview(phoneNumber, dateTimeStr);
        }

        // Typing delay simulation
        const responseWordCount = aiReply.split(/\s+/).length;
        const typingDelayMs = Math.min(4500, Math.max(1800, responseWordCount * 300));
        console.log(`⏳ Typing for ${Math.round(typingDelayMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, typingDelayMs));

        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text: aiReply }, { quoted: originalMsg });
        console.log(`🤖 Replied to ${phoneNumber} [${agentLabel}]:\n   "${aiReply}"`);

        await recordMessage(phoneNumber, 'AI', aiReply);

    } catch (err) {
        console.error(`❌ Error responding to ${phoneNumber}:`, err.message || err);
        try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
    }
}

// ─── Main WhatsApp Connection ─────────────────────────────────────────────────
let reconnectAttempts = 0;
let reminderWorkerStarted = false;

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📦 Using WA Web v${version.join('.')}`);

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
        keepAliveIntervalMs: 25_000,       // ping WA every 25s to prevent 408 timeouts
        connectTimeoutMs: 60_000,          // allow up to 60s for initial connect
        retryRequestDelayMs: 2_000,        // wait 2s before retrying a failed request
        browser: ['HMorix Bot', 'Chrome', '125.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

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
                process.exit(1);
            } else if (code === 428) {
                // 428 = Precondition Required — WA is rejecting the session key state.
                // Clearing auth forces a clean re-registration on next start.
                console.log('⚠️  Session rejected by WhatsApp (code 428). Clearing stale auth & exiting.');
                console.log('   ➜ Restart the bot and re-scan the QR code.');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
                process.exit(1);
            } else {
                // Exponential backoff: 5s, 10s, 20s, 40s, then cap at 60s
                reconnectAttempts++;
                const delayMs = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60_000);
                console.log(`🔄 Reconnecting in ${Math.round(delayMs / 1000)}s... (attempt ${reconnectAttempts})`);
                setTimeout(() => connectWhatsApp(), delayMs);
            }
        }

        if (connection === 'open') {
            reconnectAttempts = 0; // reset backoff on successful connect
            console.log('\n✅ WhatsApp Connected! HMorix Multi-Agent Bot is LIVE.\n');
            console.log('   Agents active:');
            console.log('   • 💼 ORIX Smart Tech AI (Sales, Pricing, HMorix Services, Client Qualification)');
            console.log('   • 👩‍💼 BLOPSY (HR, Candidate Screening, Interview Scheduler & 2h/1h/15m Reminders)');
            console.log('   • 👦 MANIK (Personal Hinglish Friend - strictly for personal_numbers.txt)');
            console.log('\n   Press Ctrl+C to stop.\n');
        }
    });

    // ─── Incoming Message Debounce / Aggregator ────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || !msg.key.remoteJid) continue;
            if (isJidBroadcast(msg.key.remoteJid)) continue;
            if (msg.key.remoteJid.endsWith('@g.us')) continue; // skip group chats
            if (msg.key.fromMe) continue; // skip self messages

            const jid = msg.key.remoteJid;
            let phoneNumber = jid.split('@')[0];

            // LID or PushName candidate resolution
            if (jid.endsWith('@lid') || !/^\d{7,15}$/.test(phoneNumber)) {
                const senderJid = msg.key.participant || msg.participant || '';
                if (senderJid && senderJid.includes('@')) {
                    const candidate = senderJid.split('@')[0];
                    if (/^\d{7,15}$/.test(candidate)) phoneNumber = candidate;
                }
            }

            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                '';

            if (!text.trim()) continue;

            // Debounce aggregation: If user sends 2-3 quick messages, combine them!
            if (!chatQueues.has(jid)) {
                chatQueues.set(jid, { texts: [text], originalMsg: msg });
            } else {
                const queue = chatQueues.get(jid);
                queue.texts.push(text);
                queue.originalMsg = msg; // use latest message for quoting
                if (queue.timeout) clearTimeout(queue.timeout);
            }

            const queue = chatQueues.get(jid);
            queue.timeout = setTimeout(async () => {
                const combined = queue.texts.join('\n');
                const lastMsg = queue.originalMsg;
                chatQueues.delete(jid);
                await processUserMessages(sock, jid, phoneNumber, combined, lastMsg);
            }, 2500); // wait 2.5 seconds for user to stop typing
        }
    });

    // Start background interview reminder worker (only once, not on every reconnect)
    if (!reminderWorkerStarted) {
        startReminderWorker(sock);
        reminderWorkerStarted = true;
    }

    return sock;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n🚀 HMorix Intelligent Multi-Agent WhatsApp System');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await connectDB(process.env.MONGODB_URI);
    await discoverGroqModels();
    setupFileWatchers();

    const allowAll = !cachedAllowedNumbers.length || cachedAllowedNumbers.includes('*') || cachedAllowedNumbers.includes('all') || process.env.ALLOW_ALL_NUMBERS === 'true';
    if (allowAll) {
        console.log('🌟 Mode: ALL numbers allowed! (Every contact receives AI responses)');
    } else {
        console.log(`🔒 Mode: Whitelist active. Allowed: [${cachedAllowedNumbers.join(', ')}]`);
    }

    if (cachedPersonalNumbers.length > 0) {
        console.log(`👦 Personal Contacts (Manik persona): ${cachedPersonalNumbers.join(', ')}`);
    } else {
        console.log('ℹ️  No personal numbers configured in personal_numbers.txt (Everyone routes to Orix by default).');
    }

    console.log('\n');
    await connectWhatsApp();
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n\n🛑 Bot stopped. Session saved — restart anytime without re-scanning QR.');
    process.exit(0);
});
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));
