import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcodeTerminal from 'qrcode-terminal';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    Browsers,
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import { GoogleGenAI } from '@google/genai';
import pino from 'pino';
import QRCode from 'qrcode';

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
const STATUS_FILE = path.join(__dirname, 'whatsapp_status.json');
const ALLOWED_NUMBERS_FILE = path.join(__dirname, 'allowed_numbers.txt');
const PERSONAL_NUMBERS_FILE = path.join(__dirname, 'personal_numbers.txt');
const SESSIONS_FILE = path.join(__dirname, 'contact_sessions.json');
const INTERVIEWS_FILE = path.join(__dirname, 'scheduled_interviews.json');

const PROMPT_MANIK_FILE = path.join(__dirname, 'system_prompt.txt');
const PROMPT_ORIX_FILE = path.join(__dirname, 'system_prompt_orix.txt');
const PROMPT_BLOPSY_FILE = path.join(__dirname, 'system_prompt_blopsy.txt');

// ─── Live WhatsApp State Manager (Shared with Dashboard Web UI) ───────────────
let liveStatus = {
    status: 'starting', // starting | waiting_qr | connecting | connected | reconnecting | logged_out | disconnected
    qr: null,
    qrGeneratedAt: null,
    qrExpiresIn: 25,
    connectedAt: null,
    uptimeMs: 0,
    reconnectCount: 0,
    lastDisconnectCode: null,
    lastDisconnectTime: null,
    waWebVersion: 'Loading...',
    activeAgents: ['ORIX (Sales)', 'BLOPSY (HR)', 'MANIK (Personal)'],
    messagesSent: 0,
    messagesReceived: 0,
    logs: [],
    updatedAt: Date.now()
};

function saveLiveStatus() {
    try {
        if (liveStatus.connectedAt && liveStatus.status === 'connected') {
            liveStatus.uptimeMs = Date.now() - liveStatus.connectedAt;
        }
        liveStatus.updatedAt = Date.now();
        fs.writeFileSync(STATUS_FILE, JSON.stringify(liveStatus, null, 2), 'utf8');
    } catch (e) {}
}

function updateLiveStatus(patch = {}) {
    Object.assign(liveStatus, patch);
    saveLiveStatus();
}

function addLiveLog(type, text) {
    const timestamp = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    liveStatus.logs.push({ timestamp, type, text });
    if (liveStatus.logs.length > 80) liveStatus.logs.shift();
    saveLiveStatus();
}

// Periodic status sync every 4 seconds
setInterval(() => {
    if (liveStatus.status === 'connected') {
        saveLiveStatus();
    }
}, 4000);


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
            // Only keep text chat/completion models — exclude classifiers, embedders, safety guards, TTS, terms-required
            discoveredGroqModels = list.filter(m =>
                !m.includes('whisper') &&
                !m.includes('vision') &&
                !m.includes('safetensors') &&
                !m.includes('guard') &&
                !m.includes('embed') &&
                !m.includes('moderation') &&
                !m.includes('classifier') &&
                !m.includes('orpheus') &&
                !m.includes('allam') &&
                !m.includes('tts') &&
                !BLOCKED_GROQ_MODELS.has(m)
            );
            if (discoveredGroqModels.length > 0) {
                console.log(`⚡ [Groq Engine] Usable chat models: ${discoveredGroqModels.slice(0, 5).join(', ')}`);
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

// ─── Anti-Ban & Anti-Flood Security Guard ────────────────────────────────────
// Meta algorithms flag and ban accounts with high bursts (> 6 msgs/min per contact)
const contactRateLimits = new Map(); // key: phone, value: timestamp[]
const MAX_MESSAGES_PER_MINUTE = 6;

function isRateLimited(phoneNumber) {
    const now = Date.now();
    let timestamps = contactRateLimits.get(phoneNumber) || [];
    timestamps = timestamps.filter(t => now - t < 60_000);
    if (timestamps.length >= MAX_MESSAGES_PER_MINUTE) {
        return true;
    }
    timestamps.push(now);
    contactRateLimits.set(phoneNumber, timestamps);
    return false;
}

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
    // 1. Check MongoDB session first (allows dynamic switches & manual testing overrides)
    if (isMongoConnected()) {
        try {
            const doc = await ContactSession.findOne({ phoneNumber });
            if (doc && doc.activeAgent) return doc.activeAgent;
        } catch (e) {}
    }

    // 2. Fallback to local session file
    if (localSessions[phoneNumber] && localSessions[phoneNumber].activeAgent) {
        return localSessions[phoneNumber].activeAgent;
    }

    // 3. Personal contact list defaults to Manik if no session set
    if (isPersonalContact(phoneNumber)) {
        return 'manik';
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

// Business hours: 10:00 AM – 7:00 PM (19:00)
const MEETING_HOUR_START = 10;
const MEETING_HOUR_END   = 19; // exclusive (7 PM = last allowed start = 18:59)
const MEETING_SLOT_GAP_MINUTES = 20; // minimum minutes between meetings

/**
 * Check if proposed scheduledTime conflicts with existing meetings (±20 min window).
 * Returns the conflicting meeting record or null.
 */
async function findSlotConflict(proposedTime, excludePhoneNumber = null) {
    const gapMs = MEETING_SLOT_GAP_MINUTES * 60 * 1000;
    let allMeetings = localInterviews;
    if (isMongoConnected()) {
        try { allMeetings = await Interview.find({ status: 'scheduled' }); } catch (e) {}
    }
    const pTime = new Date(proposedTime).getTime();
    for (const m of allMeetings) {
        if (excludePhoneNumber && m.phoneNumber === excludePhoneNumber) continue; // ignore same contact (reschedule)
        const mTime = new Date(m.scheduledTime).getTime();
        if (Math.abs(pTime - mTime) < gapMs) return m;
    }
    return null;
}

/**
 * Main scheduling function.
 * mode = 'schedule' | 'reschedule'
 * Returns: { ok: true, scheduledTime } | { ok: false, reason: 'outside_hours'|'conflict', conflictTime? }
 */
async function recordScheduledInterview(phoneNumber, dateStr, role = 'Client Consultation', candidateName = 'Client', mode = 'schedule') {
    try {
        const scheduledTime = new Date(dateStr);
        if (isNaN(scheduledTime.getTime())) {
            console.warn(`📅 [Meeting] Invalid date string: "${dateStr}"`);
            return { ok: false, reason: 'invalid_date' };
        }

        // ── Business Hours Guard ──────────────────────────────────────────────
        const hour = scheduledTime.getHours();
        if (hour < MEETING_HOUR_START || hour >= MEETING_HOUR_END) {
            console.warn(`📅 [Meeting] Rejected — outside business hours: ${scheduledTime.toLocaleString('en-IN')}`);
            return { ok: false, reason: 'outside_hours', scheduledTime };
        }

        // ── Slot Conflict Check ───────────────────────────────────────────────
        // For reschedule, exclude the same phone's own existing slot from conflict check
        const excludePhone = mode === 'reschedule' ? phoneNumber : null;
        const conflict = await findSlotConflict(scheduledTime, excludePhone);
        if (conflict) {
            console.warn(`📅 [Meeting] Slot conflict detected at ${scheduledTime.toLocaleTimeString('en-IN')} — another meeting at ${new Date(conflict.scheduledTime).toLocaleString('en-IN')}`);
            return { ok: false, reason: 'conflict', conflictTime: new Date(conflict.scheduledTime) };
        }

        // ── Reschedule: cancel any existing meeting for this phone ────────────
        if (mode === 'reschedule') {
            // Cancel existing local meeting records for this phone
            const oldCount = localInterviews.length;
            localInterviews = localInterviews.filter(m => m.phoneNumber !== phoneNumber || m.status !== 'scheduled');
            if (localInterviews.length < oldCount) {
                try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}
                console.log(`📅 [Reschedule] Cancelled previous meeting for ${phoneNumber}`);
            }
            if (isMongoConnected()) {
                try {
                    await Interview.updateMany(
                        { phoneNumber, status: 'scheduled' },
                        { $set: { status: 'cancelled' } }
                    );
                } catch (e) {}
            }
        }

        // ── Create new meeting record ─────────────────────────────────────────
        const record = {
            phoneNumber,
            scheduledTime,
            role,
            candidateName,
            status: 'scheduled',
            reminded2h: false,
            reminded1h: false,
            reminded15m: false,
            createdAt: new Date()
        };

        localInterviews.push(record);
        try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}

        if (isMongoConnected()) {
            try { await Interview.create(record); } catch (e) {}
        }

        const modeLabel = mode === 'reschedule' ? 'Rescheduled' : 'Scheduled';
        console.log(`📅 [Meeting ${modeLabel}] Confirmed for ${phoneNumber} (${role}) at: ${scheduledTime.toLocaleString('en-IN')}`);
        return { ok: true, scheduledTime };
    } catch (e) {
        console.error('Failed to schedule interview:', e.message);
        return { ok: false, reason: 'error' };
    }
}

function startReminderWorker() {
    // Checks every 60 seconds for meetings needing reminders
    setInterval(async () => {
        if (!currentSocket) return; // Only process reminders when socket is connected
        const sock = currentSocket;
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
            const isClient = (item.role || '').toLowerCase().includes('consult') || (item.role || '').toLowerCase().includes('client');
            const timeStr = new Date(item.scheduledTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

            // 1 Hour Reminder (between 45 and 70 minutes before)
            if (minutesLeft > 20 && minutesLeft <= 70 && !item.reminded1h) {
                const text = isClient
                    ? `👋 Namaste! HMorix team se gentle reminder:\nAapka consultation call 1 ghante mein (${timeStr}) scheduled hai. We look forward to speaking with you! 🙏\n\n(Agar aap call reschedule karna chahte hain toh bas yahan batayein).`
                    : `⏰ Gentle Reminder from Blopsy at HMorix:\nYour interview is coming up in approximately 1 hour (${timeStr})! Please ensure you have stable internet connection. All the best! ✨\n\n(Need to reschedule? Feel free to reply here).`;

                try {
                    // Simulate natural human presence before delivering reminder
                    await sock.sendPresenceUpdate('composing', jid);
                    await new Promise(r => setTimeout(r, 1500 + Math.random() * 800));
                    await sock.sendPresenceUpdate('paused', jid);

                    await sock.sendMessage(jid, { text });
                    item.reminded1h = true;
                    if (item.save) await item.save();
                    try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}
                    console.log(`⏰ [Safe Reminder Sent] 1-Hour reminder delivered to ${item.phoneNumber}`);
                } catch (e) {
                    console.warn(`Failed to deliver 1h reminder to ${item.phoneNumber}:`, e.message);
                }
            }

            // 15 Minutes Final Ready Ping (between 3 and 18 minutes before)
            if (minutesLeft >= 0 && minutesLeft <= 18 && !item.reminded15m) {
                const text = isClient
                    ? `🚀 Quick update: Our call begins in 15 minutes! Please be ready. See you soon! ✨`
                    : `🚀 Final check: Your interview with HMorix starts in 15 minutes. We are excited to meet you! ✨`;

                try {
                    await sock.sendPresenceUpdate('composing', jid);
                    await new Promise(r => setTimeout(r, 1200 + Math.random() * 600));
                    await sock.sendPresenceUpdate('paused', jid);

                    await sock.sendMessage(jid, { text });
                    item.reminded15m = true;
                    if (item.save) await item.save();
                    try { fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(localInterviews, null, 2), 'utf8'); } catch (e) {}
                    console.log(`⏰ [Safe Reminder Sent] 15-Minute reminder delivered to ${item.phoneNumber}`);
                } catch (e) {
                    console.warn(`Failed to deliver 15m reminder to ${item.phoneNumber}:`, e.message);
                }
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

// Models known to support reasoning_effort (suppress <think> blocks)
const REASONING_EFFORT_MODELS = new Set([
    'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'qwen/qwen3-32b',
    'qwen/qwen3-14b', 'qwen/qwen3-7b', 'qwen/qwen3-4b',
    'deepseek-r1-distill-llama-70b', 'deepseek-r1-distill-qwen-32b'
]);

// Models known to cause errors (require terms, unsupported params, TTS-only)
const BLOCKED_GROQ_MODELS = new Set([
    'canopylabs/orpheus-v1-english', 'canopylabs/orpheus-arabic-saudi',
    'allam-2-7b', 'groq/compound', 'groq/compound-mini',
    'openai/gpt-oss-120b', 'openai/gpt-oss-20b'
]);

// Hardcoded reliable defaults — known to work well for chat with no issues
const defaultGroqModels = [
    process.env.GROQ_MODEL,
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'qwen/qwen3.8-27b',
    'qwen/qwen3.6-27b',
    'llama-3.2-11b-text-preview',
    'gemma2-9b-it'
].filter(m => m && !BLOCKED_GROQ_MODELS.has(m));

// messages = array of {role: 'user'|'assistant', content: string}
async function callGroqAPI(messages, systemInstruction, activeAgent) {
    if (!GROQ_API_KEY) return null;
    const url = 'https://api.groq.com/openai/v1/chat/completions';

    // Combine discovered models + defaults; filter blocked ones
    const candidateGroqModels = [...discoveredGroqModels, ...defaultGroqModels]
        .filter(m => m && !BLOCKED_GROQ_MODELS.has(m))
        .filter((v, i, a) => a.indexOf(v) === i);

    for (const model of candidateGroqModels) {
        try {
            // Only send reasoning_effort for models that actually support it
            const supportsReasoningEffort = REASONING_EFFORT_MODELS.has(model);

            const body = {
                model,
                messages: [
                    { role: 'system', content: systemInstruction },
                    ...messages
                ],
                temperature: activeAgent === 'orix' ? 0.7 : activeAgent === 'blopsy' ? 0.7 : 0.9,
                max_tokens: 450,
            };
            if (supportsReasoningEffort) body.reasoning_effort = 'none';

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                const json = await res.json();
                const text = json.choices?.[0]?.message?.content?.trim() || '';
                if (text) {
                    if (candidateGroqModels.indexOf(model) > 0) {
                        console.log(`✅ [Groq] Response from: ${model}`);
                    }
                    return text;
                }
            } else {
                const errText = await res.text();
                const errObj = (() => { try { return JSON.parse(errText); } catch { return null; } })();
                const errMsg = errObj?.error?.message || errText;
                // If model requires terms acceptance, add to blocked list silently
                if (errMsg.includes('terms acceptance') || errMsg.includes('requires terms')) {
                    BLOCKED_GROQ_MODELS.add(model);
                    console.warn(`🚫 [Groq] Blocked ${model} — requires terms acceptance.`);
                } else {
                    console.warn(`⚠️  [Groq ${model}] failed (${res.status}): ${errMsg.slice(0, 120)}`);
                }
            }
        } catch (err) {
            console.warn(`⚠️  [Groq ${model}] network error:`, err.message);
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

    // Anti-Ban: Flood protection — prevent responding more than 6 times/minute to the same contact
    if (isRateLimited(phoneNumber)) {
        console.warn(`🛡️  [Anti-Ban] High message burst detected from ${phoneNumber}. Throttling reply to protect WhatsApp account.`);
        return;
    }

    // ─── Manual Override Commands (/hmorix_model:orix, /hmorix_model:blopsy, /hmorix_model:manik, /reset) ───
    const trimmedMsg = combinedMessage.trim();
    const modelCmdMatch = trimmedMsg.match(/^\/(?:hmorix_model|agent|model|switch)(?:[:\s=]+(\w+))?$/i);
    const isResetCmd = /^\/(?:reset|hmorix_reset)$/i.test(trimmedMsg);

    if (modelCmdMatch || isResetCmd) {
        let targetAgent = modelCmdMatch && modelCmdMatch[1] ? modelCmdMatch[1].toLowerCase() : null;
        if (isResetCmd) targetAgent = 'reset';

        if (!targetAgent || !['orix', 'blopsy', 'manik', 'reset'].includes(targetAgent)) {
            const currentAgent = await getActiveAgent(phoneNumber);
            const currentAgentLabel = currentAgent === 'orix'
                ? '💼 ORIX (Business, Tech & Sales)'
                : currentAgent === 'blopsy'
                ? '👩‍💼 BLOPSY (HR & Recruitment)'
                : '👦 MANIK (Personal)';

            const helpText = `🤖 *HMorix Multi-Agent Switcher*\n\n` +
                `Current active agent: *${currentAgentLabel}*\n\n` +
                `Switch active agent instantly with:\n` +
                `• \`/hmorix_model:orix\` ➔ 💼 *ORIX* (Solutions Consultant & Sales)\n` +
                `• \`/hmorix_model:blopsy\` ➔ 👩‍💼 *BLOPSY* (Talent Acquisition & HR)\n` +
                `• \`/hmorix_model:manik\` ➔ 👦 *MANIK* (Personal Hinglish Friend)\n` +
                `• \`/reset\` ➔ 🔄 Reset to default agent`;

            try {
                await sock.readMessages([originalMsg.key]);
                await sock.sendMessage(jid, { text: helpText }, { quoted: originalMsg });
            } catch (e) {}
            return;
        }

        if (targetAgent === 'reset') {
            const defaultAgent = isPersonalContact(phoneNumber) ? 'manik' : 'orix';
            const leadType = defaultAgent === 'manik' ? 'friend' : 'client';
            await setContactSession(phoneNumber, defaultAgent, leadType);
            console.log(`🔄 [Manual Reset] Contact ${phoneNumber} session reset to default: ${defaultAgent.toUpperCase()}`);
            addLiveLog('cmd', `🔄 [${phoneNumber}] Session reset to ${defaultAgent.toUpperCase()}`);

            const label = defaultAgent === 'orix'
                ? '💼 *ORIX* (Senior AI Solutions Consultant & Business Lead)'
                : '👦 *MANIK* (Personal Hinglish Friend)';

            const resetReply = `🔄 *Session Reset Successfully!*\n\nDefault agent active: ${label}.\n\nHow can I help you today?`;
            try {
                await sock.readMessages([originalMsg.key]);
                await sock.sendMessage(jid, { text: resetReply }, { quoted: originalMsg });
                await recordMessage(phoneNumber, 'USER', combinedMessage);
                await recordMessage(phoneNumber, 'AI', resetReply);
            } catch (e) {}
            return;
        }

        const leadType = targetAgent === 'blopsy' ? 'candidate' : targetAgent === 'manik' ? 'friend' : 'client';
        await setContactSession(phoneNumber, targetAgent, leadType);
        console.log(`🔀 [Manual Switch] Contact ${phoneNumber} switched to: ${targetAgent.toUpperCase()}`);
        addLiveLog('cmd', `🔀 [${phoneNumber}] Switched agent ➔ ${targetAgent.toUpperCase()}`);

        const agentDescriptions = {
            orix: '💼 *ORIX* (Senior AI Solutions Consultant & Business Lead)\n_Handling: Web Development, Apps, SaaS Products, Pricing & Enterprise Solutions_',
            blopsy: '👩‍💼 *BLOPSY* (Senior Talent Acquisition & HR Coordinator)\n_Handling: Candidate Screening, Job Vacancies, Tech Stack & Interviews_',
            manik: '👦 *MANIK* (Personal Hinglish Friend)\n_Handling: Casual Hinglish conversations_'
        };

        const switchReply = `✅ *Agent Switched Successfully!*\n\nYou are now speaking with:\n${agentDescriptions[targetAgent]}\n\nHow can I assist you?`;
        try {
            await sock.readMessages([originalMsg.key]);
            await sock.sendMessage(jid, { text: switchReply }, { quoted: originalMsg });
            await recordMessage(phoneNumber, 'USER', combinedMessage);
            await recordMessage(phoneNumber, 'AI', switchReply);
        } catch (e) {}
        return;
    }

    let activeAgent = await getActiveAgent(phoneNumber);

    // Intent-based Auto-Routing BEFORE LLM generation:
    // If contact is currently routed to Blopsy (HR), but sends client / product / website inquiry:
    if (activeAgent === 'blopsy') {
        const clientPattern = /(?:website|web development|app development|mobile app|software|billingflow|pricing|cost|price|prize|quotation|quote|build an? (?:app|website)|make an? (?:app|website)|restaurant|hire your company|your services|your products|(?:talk|connect|switch|change|shift)\s+(?:to|with)?\s*orix|orix se baat)/i;
        const candidatePattern = /(?:resume|cv|applying|internship|job vacancy|job opening|fresher|interview|my tech stack|hiring for|hiring process|apply for|my role)/i;

        if (clientPattern.test(combinedMessage) && !candidatePattern.test(combinedMessage)) {
            console.log(`🔀 [Smart Router] Contact ${phoneNumber} sent client inquiry while on Blopsy. Auto-routing to ORIX!`);
            addLiveLog('switch', `🔀 [${phoneNumber}] Auto-routed client inquiry to ORIX`);
            activeAgent = 'orix';
            await setContactSession(phoneNumber, 'orix', 'client');
        }
    } else if (activeAgent === 'orix') {
        // If contact explicitly asks to talk to HR / Blopsy
        const explicitBlopsy = /(?:(?:talk|connect|switch|change|shift)\s+(?:to|with)?\s*(?:blopsy|hr)|blopsy se baat|hr se baat)/i;
        if (explicitBlopsy.test(combinedMessage)) {
            console.log(`🔀 [Smart Router] Contact ${phoneNumber} explicitly requested HR. Auto-routing to BLOPSY!`);
            addLiveLog('switch', `🔀 [${phoneNumber}] Explicit request to BLOPSY (HR)`);
            activeAgent = 'blopsy';
            await setContactSession(phoneNumber, 'blopsy', 'candidate');
        }
    }

    const agentLabel = activeAgent === 'orix' ? '💼 ORIX (Smart Tech AI)' : activeAgent === 'blopsy' ? '👩‍💼 BLOPSY (HR)' : '👦 MANIK (Personal)';
    console.log(`\n📩 Message from ${phoneNumber} [Assigned: ${agentLabel}]:\n   "${combinedMessage}"`);
    
    liveStatus.messagesReceived++;
    addLiveLog('in', `📩 [${phoneNumber}] "${combinedMessage.slice(0, 65)}"`);

    try {
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

        // Anti-Ban: Human-like reading delay BEFORE opening/reading the chat
        const wordCount = combinedMessage.split(/\s+/).length;
        const readingDelayMs = Math.round(Math.min(3500, Math.max(1500, wordCount * 220)) * (0.9 + Math.random() * 0.25));
        console.log(`🤔 Reading for ${Math.round(readingDelayMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, readingDelayMs));

        // Mark as read (blue ticks) ONLY AFTER opening the chat naturally
        await sock.readMessages([originalMsg.key]);

        // Start typing indicator
        await sock.sendPresenceUpdate('composing', jid);

        let systemInstruction = cachedPromptOrix;
        if (activeAgent === 'blopsy') systemInstruction = cachedPromptBlopsy;
        else if (activeAgent === 'manik') systemInstruction = cachedPromptManik;

        let aiReply = await generateAIResponse(messages, systemInstruction, activeAgent);

        // Strip <think>...</think> reasoning blocks (qwen3, deepseek-r1 thinking mode)
        aiReply = aiReply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        // 1. Detect Agent Switch in AI output: [AGENT_SWITCH:blopsy] or [AGENT_SWITCH:orix] or [AGENT_SWITCH:manik]
        const switchMatch = aiReply.match(/\[AGENT_SWITCH\s*:\s*(orix|blopsy|manik)\]/i);
        if (switchMatch) {
            const nextAgent = switchMatch[1].toLowerCase();
            aiReply = aiReply.replace(/\[AGENT_SWITCH\s*:\s*(?:orix|blopsy|manik)\]/gi, '').trim();
            const nextLeadType = nextAgent === 'blopsy' ? 'candidate' : nextAgent === 'manik' ? 'friend' : 'client';
            await setContactSession(phoneNumber, nextAgent, nextLeadType);
            console.log(`🔀 [Auto-Handshake] Handed off contact ${phoneNumber} to ${nextAgent.toUpperCase()}!`);
            addLiveLog('switch', `🔀 [${phoneNumber}] Handed off ➜ ${nextAgent.toUpperCase()}`);
        } else {
            // Guarantee contact is tracked in sessions & dashboard
            const leadType = activeAgent === 'blopsy' ? 'candidate' : activeAgent === 'manik' ? 'friend' : 'client';
            await setContactSession(phoneNumber, activeAgent, leadType);
        }

        // 2. Detect Scheduled / Rescheduled Meeting or Interview
        // AI uses [MEETING_SCHEDULED:YYYY-MM-DD HH:MM] or [MEETING_RESCHEDULED:YYYY-MM-DD HH:MM]
        const scheduleMatch = aiReply.match(/\[((?:INTERVIEW|MEETING)_(?:SCHEDULED|RESCHEDULED))\s*:\s*([\d\-]+ [\d:]+)\]/i);
        if (scheduleMatch) {
            const fullTag = scheduleMatch[0];
            const tagType = scheduleMatch[1].toUpperCase();
            const dateTimeStr = scheduleMatch[2];
            const isReschedule = tagType.includes('RESCHEDULE');
            const meetingRole = activeAgent === 'blopsy' ? 'Candidate Interview' : 'Client Consultation';

            // Remove marker from outbound message first
            aiReply = aiReply.replace(new RegExp(fullTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();

            const result = await recordScheduledInterview(phoneNumber, dateTimeStr, meetingRole, 'Client', isReschedule ? 'reschedule' : 'schedule');

            if (!result.ok) {
                if (result.reason === 'outside_hours') {
                    const timeStr = result.scheduledTime
                        ? result.scheduledTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                        : dateTimeStr;
                    // Append a polite correction to the AI's reply
                    aiReply = aiReply + `\n\n⚠️ *Scheduling Note:* I'm unable to book at ${timeStr} as our team is available only between *10:00 AM – 7:00 PM*. Please choose a slot within that window.`;
                    console.log(`📅 [Meeting] Rejected outside-hours slot for ${phoneNumber}`);
                } else if (result.reason === 'conflict') {
                    const conflictStr = result.conflictTime
                        ? result.conflictTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                        : 'that time';
                    aiReply = aiReply + `\n\n⚠️ *Scheduling Note:* That slot is already taken (meeting at ${conflictStr}). Please suggest a time at least 20 minutes before or after.`;
                    console.log(`📅 [Meeting] Slot conflict for ${phoneNumber}`);
                }
                // Record that the scheduling failed so AI context is accurate
                await recordMessage(phoneNumber, 'AI', `[SYSTEM: Meeting not booked — ${result.reason}]`);
            }
        }

        // Anti-Ban: Typing delay simulation with human jitter (85% to 115% variance)
        const responseWordCount = aiReply.split(/\s+/).length;
        const humanJitter = 0.85 + Math.random() * 0.3;
        const typingDelayMs = Math.round(Math.min(5000, Math.max(1600, responseWordCount * 220)) * humanJitter);
        console.log(`⏳ Typing for ${Math.round(typingDelayMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, typingDelayMs));

        // Natural pause (300-600ms) before pressing enter to send
        await sock.sendPresenceUpdate('paused', jid);
        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));

        await sock.sendMessage(jid, { text: aiReply }, { quoted: originalMsg });
        console.log(`🤖 Replied to ${phoneNumber} [${agentLabel}]:\n   "${aiReply}"`);

        liveStatus.messagesSent++;
        addLiveLog('out', `🤖 [${agentLabel}] ➜ ${phoneNumber}: "${aiReply.slice(0, 65)}"`);

        await recordMessage(phoneNumber, 'AI', aiReply);

    } catch (err) {
        console.error(`❌ Error responding to ${phoneNumber}:`, err.message || err);
        try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
    }
}

// ─── Night Auto-Shutdown (Anti-Ban: Rest period 11 PM onwards) ───────────────
// Real WhatsApp users don't chat 24/7. A rest period drastically reduces
// bot-detection risk. Bot auto-shuts down at 23:00 if it was running before then.
// If started AFTER 11 PM — just warn the user, don't force-stop.
function scheduleNightShutdown() {
    const CHECK_INTERVAL_MS = 60_000; // check every minute

    const now = new Date();
    const hour = now.getHours();

    // If already past 11 PM at startup — just warn, don't block
    if (hour >= 23) {
        console.log('\n⚠️  [Night Mode] Started after 11:00 PM.');
        console.log('   Bot is running. Please stop it before you sleep (Ctrl+C).');
        console.log('   No auto-shutdown since bot was manually started late.\n');
        return; // don't arm the timer — user started it manually after hours
    }

    // Calculate shutdown time and display countdown
    const shutdownToday = new Date();
    shutdownToday.setHours(23, 0, 0, 0);
    const msUntilShutdown = shutdownToday - now;
    const hrs = Math.floor(msUntilShutdown / 3_600_000);
    const mins = Math.floor((msUntilShutdown % 3_600_000) / 60_000);
    console.log(`🌙 [Night Mode] Auto-shutdown scheduled at 11:00 PM (in ${hrs}h ${mins}m)`);

    const checker = setInterval(() => {
        const current = new Date();
        const currentHour = current.getHours();
        const currentMin = current.getMinutes();

        // 5-minute warning at 10:55 PM
        if (currentHour === 22 && currentMin === 55) {
            console.log('\n🌙 [Night Mode] ⚠️  Bot stops in 5 minutes (11:00 PM).');
            console.log('   ➜ Session will be saved — restart with: bash start.sh');
        }

        // Hard shutdown at 11:00 PM
        if (currentHour >= 23) {
            console.log('\n🌙 ══════════════════════════════════════════════════');
            console.log('   Auto-Shutdown: 11:00 PM Night Rest Mode activated.');
            console.log('   ✅ Session saved — no re-scan needed tomorrow.');
            console.log('   ➜  Restart tomorrow with: bash start.sh');
            console.log('   ══════════════════════════════════════════════════\n');
            clearInterval(checker);
            process.exit(0);
        }
    }, CHECK_INTERVAL_MS);
}

// ─── Main WhatsApp Connection State ───────────────────────────────────────────
let currentSocket = null;
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let reminderWorkerStarted = false;
let cachedWaVersion = null;

function scheduleReconnect(delayMs, reason = '') {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    const safeDelay = Math.max(2000, delayMs);
    console.log(`⏳ [Reconnect Queue] Reconnecting in ${Math.round(safeDelay / 1000)}s${reason ? ' (' + reason + ')' : ''}...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWhatsApp();
    }, safeDelay);
}

async function connectWhatsApp() {
    if (isConnecting) {
        console.log('ℹ️  Connection attempt already in progress. Skipping duplicate call.');
        return;
    }
    isConnecting = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Clean up previous socket to prevent dual socket conflict (which causes 428/440 loop)
    if (currentSocket) {
        try {
            currentSocket.ev.removeAllListeners('connection.update');
            currentSocket.ev.removeAllListeners('creds.update');
            currentSocket.ev.removeAllListeners('messages.upsert');
            currentSocket.end(undefined);
        } catch (e) {}
        currentSocket = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    // Resilient version detection: Cached so we never hammer web.whatsapp.com on every reconnect
    let version = cachedWaVersion || [2, 3000, 1047236770];
    let isLatest = false;
    if (!cachedWaVersion) {
        try {
            const wa = await fetchLatestWaWebVersion();
            if (wa?.version && Array.isArray(wa.version)) {
                version = wa.version;
                cachedWaVersion = version;
                isLatest = wa.isLatest;
            }
        } catch (e) {
            try {
                const b = await fetchLatestBaileysVersion();
                if (b?.version && Array.isArray(b.version)) {
                    version = b.version;
                    cachedWaVersion = version;
                    isLatest = b.isLatest;
                }
            } catch (_) {}
        }
    }

    liveStatus.waWebVersion = version.join('.');
    updateLiveStatus({ waWebVersion: version.join('.') });
    console.log(`📦 Using WA Web v${version.join('.')} ${isLatest ? '✅ (live updated)' : 'ℹ️ (cached)'}`);

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,          // Required: Signals to WhatsApp server that client is active (prevents passive 428 disconnects)
        keepAliveIntervalMs: 25_000,        // 25s keep-alive ping satisfies WhatsApp server's 30-45s inactivity timeout!
        defaultQueryTimeoutMs: 60_000,      // Allow 60s for queries to complete on mobile networks
        connectTimeoutMs: 60_000,           // Allow up to 60s for initial connect
        retryRequestDelayMs: 2_500,         // Wait 2.5s before retrying
        maxMsgRetryCount: 5,
        browser: Browsers.ubuntu('Chrome'), // Standard Ubuntu Chrome profile matching Linux/Termux environment
    });

    currentSocket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            let qrDataUrl = null;
            try {
                qrDataUrl = await QRCode.toDataURL(qr, {
                    width: 360,
                    margin: 2,
                    color: { dark: '#0f172a', light: '#ffffff' },
                    errorCorrectionLevel: 'M'
                });
            } catch (e) {}

            updateLiveStatus({
                status: 'waiting_qr',
                qr: qrDataUrl,
                qrRaw: qr,
                qrGeneratedAt: Date.now(),
                qrExpiresIn: 25
            });
            addLiveLog('qr', '📱 New QR Code ready. View at http://localhost:3000');

            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📱 Scan this QR in WhatsApp → Linked Devices → Link a Device');
            console.log('   🌐 Web Dashboard: View clean single QR at http://localhost:3000');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }

        if (connection === 'close') {
            isConnecting = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`\n❌ Connection closed. Reason code: ${code}`);

            addLiveLog('warn', `❌ Connection closed (Code: ${code}). Reconnecting...`);
            updateLiveStatus({
                status: code === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
                reconnectCount: reconnectAttempts + 1,
                lastDisconnectCode: code,
                lastDisconnectTime: Date.now()
            });

            if (code === DisconnectReason.loggedOut) {
                console.log('🔒 Logged out! Clearing saved session...');
                addLiveLog('error', '🔒 Logged out! Session cleared. Scan new QR.');
                updateLiveStatus({ status: 'logged_out', qr: null });
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
                process.exit(1);
            } else if (code === 428) {
                // 428 = connectionClosed — Add progressive backoff with jitter to prevent reconnect storms
                reconnectAttempts++;
                const delayMs = Math.min(10_000 + (reconnectAttempts * 3_000) + Math.random() * 2000, 45_000);
                console.log(`🔄 [Code 428] Server closed socket. Safe reconnect in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})...`);
                scheduleReconnect(delayMs, 'Code 428 Safe Recovery');
            } else if (code === 503) {
                // 503 = WhatsApp servers temporarily overloaded. Wait longer to avoid hammering.
                console.log('⏳ [Code 503] WhatsApp servers busy. Waiting 45s before reconnect...');
                scheduleReconnect(45_000, 'Code 503 Server Busy');
            } else if (code === DisconnectReason.connectionReplaced || code === 440) {
                // 440 = Connection Replaced — another WhatsApp Web session opened
                console.log('⚠️  [Code 440] Session replaced! Another WhatsApp Web session is active.');
                console.log('   ➜ Retrying in 15s — bot will reclaim the session automatically...');
                reconnectAttempts = 0;
                scheduleReconnect(15_000, 'Code 440 Session Reclaim');
            } else if (code === DisconnectReason.restartRequired || code === 515) {
                // 515 = Normal restart required by WhatsApp
                console.log('🔄 WhatsApp requested session restart (code 515). Reconnecting in 3s...');
                scheduleReconnect(3_000, 'Code 515 Handshake Complete');
            } else if (code === DisconnectReason.connectionLost || code === DisconnectReason.timedOut || code === 408) {
                // 408 = Mobile network switch / TCP ping timeout — restore instantly
                console.log('📡 Mobile network route changed/timeout (code 408). Auto-restoring in 4s...');
                scheduleReconnect(4_000, 'Code 408 Route Reset');
            } else {
                // Exponential backoff: 5s, 10s, 20s, 40s, then cap at 60s
                reconnectAttempts++;
                const delayMs = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60_000);
                console.log(`🔄 Reconnecting in ${Math.round(delayMs / 1000)}s... (attempt ${reconnectAttempts})`);
                scheduleReconnect(delayMs, 'General Backoff');
            }
        }

        if (connection === 'open') {
            isConnecting = false;
            reconnectAttempts = 0; // reset backoff on successful connect
            updateLiveStatus({
                status: 'connected',
                qr: null,
                qrRaw: null,
                connectedAt: liveStatus.connectedAt || Date.now(),
                reconnectCount: reconnectAttempts
            });
            addLiveLog('success', '✅ WhatsApp Connected! HMorix Multi-Agent Bot is LIVE.');

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
        startReminderWorker();
        reminderWorkerStarted = true;
    }

    return sock;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n🚀 HMorix Intelligent Multi-Agent WhatsApp System');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    addLiveLog('info', '🚀 HMorix WhatsApp Bot initializing...');
    updateLiveStatus({ status: 'starting' });

    await connectDB(process.env.MONGODB_URI);
    await discoverGroqModels();
    setupFileWatchers();
    scheduleNightShutdown(); // Auto-stop at 11 PM to protect against WhatsApp suspension

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
    addLiveLog('error', `❌ Fatal error: ${err.message || err}`);
    updateLiveStatus({ status: 'disconnected' });
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n\n🛑 Bot stopped. Session saved — restart anytime without re-scanning QR.');
    updateLiveStatus({ status: 'disconnected', qr: null });
    addLiveLog('info', '🛑 Bot stopped by user (SIGINT).');
    process.exit(0);
});
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));

