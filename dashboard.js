import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB, isMongoConnected } from './db.js';
import { ContactSession } from './models/ContactSession.js';
import { Interview } from './models/Interview.js';
import { Message } from './models/Message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHATS_DIR = path.join(__dirname, 'chats');
const SESSIONS_FILE = path.join(__dirname, 'contact_sessions.json');
const INTERVIEWS_FILE = path.join(__dirname, 'scheduled_interviews.json');
const STATUS_FILE = path.join(__dirname, 'whatsapp_status.json');
const PORT = process.env.DASHBOARD_PORT || 3000;

// ─── Live WhatsApp Status Helper ──────────────────────────────────────────────
function getWhatsAppStatus() {
    let defaultStatus = {
        status: 'disconnected', // 'starting' | 'waiting_qr' | 'connecting' | 'connected' | 'reconnecting' | 'logged_out' | 'disconnected'
        qr: null,
        qrRaw: null,
        qrGeneratedAt: null,
        qrExpiresIn: 25,
        connectedAt: null,
        uptimeMs: 0,
        reconnectCount: 0,
        lastDisconnectCode: null,
        lastDisconnectTime: null,
        waWebVersion: 'Latest',
        activeAgents: ['ORIX (Sales)', 'BLOPSY (HR)', 'MANIK (Personal)'],
        messagesSent: 0,
        messagesReceived: 0,
        logs: [],
        updatedAt: Date.now()
    };
    if (fs.existsSync(STATUS_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            if (raw.connectedAt && raw.status === 'connected') {
                raw.uptimeMs = Date.now() - raw.connectedAt;
            }
            return { ...defaultStatus, ...raw };
        } catch (e) {}
    }
    return defaultStatus;
}


// Ensure directories exist
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

// ─── Local File Helpers ───────────────────────────────────────────────────────
function getLocalSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveLocalSessions(data) {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
}

function getLocalInterviews() {
    if (!fs.existsSync(INTERVIEWS_FILE)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(INTERVIEWS_FILE, 'utf8'));
        const now = new Date();
        return raw.map(iv => ({
            ...iv,
            isPast: new Date(iv.scheduledTime) < now,
            isToday: new Date(iv.scheduledTime).toDateString() === now.toDateString()
        })).sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
    } catch (e) {
        return [];
    }
}

function saveLocalInterviews(data) {
    try {
        fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
}

// ─── Data Access Layer (Mongo with Automatic Local Fallback) ───────────────────
async function getAllLeads() {
    // 1. Try Mongo if connected
    if (isMongoConnected()) {
        try {
            const docs = await ContactSession.find().sort({ updatedAt: -1 }).lean();
            if (docs && docs.length > 0) return docs;
        } catch (e) {}
    }

    // 2. Fallback: Parse contact_sessions.json + scan chats/ folder
    const sessions = getLocalSessions();
    const leadsMap = new Map();

    for (const [phone, data] of Object.entries(sessions)) {
        leadsMap.set(phone, {
            phoneNumber: phone,
            activeAgent: data.activeAgent || 'orix',
            leadType: data.leadType || 'unknown',
            summary: data.summary || '',
            updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date()
        });
    }

    // Scan chats directory for any contact that chatted with the bot
    if (fs.existsSync(CHATS_DIR)) {
        try {
            const files = fs.readdirSync(CHATS_DIR);
            for (const file of files) {
                if (file.endsWith('.txt')) {
                    const phone = file.replace('.txt', '');
                    const filePath = path.join(CHATS_DIR, file);
                    try {
                        const stat = fs.statSync(filePath);
                        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
                        let lastMsg = '';
                        if (lines.length > 0) {
                            const lastLine = lines[lines.length - 1];
                            const m = lastLine.match(/^\[[\d\- :]+\]\s*(USER|AI):\s*(.+)$/i);
                            lastMsg = m ? `${m[1]}: ${m[2]}` : lastLine;
                        }

                        if (!leadsMap.has(phone)) {
                            leadsMap.set(phone, {
                                phoneNumber: phone,
                                activeAgent: 'orix',
                                leadType: 'client',
                                summary: lastMsg,
                                updatedAt: stat.mtime
                            });
                        } else if (!leadsMap.get(phone).summary && lastMsg) {
                            leadsMap.get(phone).summary = lastMsg;
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }

    return Array.from(leadsMap.values()).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function getAllInterviews() {
    const now = new Date();
    if (isMongoConnected()) {
        try {
            const list = await Interview.find().sort({ scheduledTime: 1 }).lean();
            if (list && list.length > 0) {
                return list.map(iv => ({
                    ...iv,
                    isPast: new Date(iv.scheduledTime) < now,
                    isToday: new Date(iv.scheduledTime).toDateString() === now.toDateString(),
                }));
            }
        } catch (e) {}
    }

    return getLocalInterviews();
}

async function getChatHistory(phoneNumber, limit = 50) {
    if (isMongoConnected()) {
        try {
            const docs = await Message.find({ phoneNumber })
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();
            if (docs && docs.length > 0) return docs.reverse();
        } catch (e) {}
    }

    // Local file fallback
    const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
    if (!fs.existsSync(filePath)) return [];
    try {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(l => {
            const m = l.match(/^\[([\d\- :]+)\]\s*(USER|AI):\s*(.+)$/i);
            return m ? { timestamp: m[1], role: m[2], message: m[3] } : { timestamp: '', role: 'USER', message: l };
        });
    } catch (e) {
        return [];
    }
}

function computeStats(leads, interviews) {
    const totalLeads = leads.length;
    const clients = leads.filter(l => l.leadType === 'client').length;
    const candidates = leads.filter(l => l.leadType === 'candidate').length;
    const upcomingInterviews = interviews.filter(i => !i.isPast && i.status === 'scheduled').length;
    const totalScheduled = interviews.length;

    return { totalLeads, clients, candidates, upcomingInterviews, totalScheduled };
}

// ─── Formatters & Badges ──────────────────────────────────────────────────────
function agentBadge(agent) {
    const map = {
        orix: { color: '#4f46e5', icon: '💼', label: 'ORIX' },
        blopsy: { color: '#0891b2', icon: '👩‍💼', label: 'BLOPSY' },
        manik: { color: '#16a34a', icon: '👦', label: 'MANIK' },
    };
    const a = map[agent] || { color: '#6b7280', icon: '🤖', label: agent || 'ORIX' };
    return `<span style="background:${a.color};color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700">${a.icon} ${a.label}</span>`;
}

function leadTypeBadge(type) {
    const map = {
        client: { color: '#16a34a', label: '🏢 Client Lead' },
        candidate: { color: '#0891b2', label: '🎓 Candidate' },
        friend: { color: '#d97706', label: '👋 Personal' },
        unknown: { color: '#475569', label: '💬 Active Chat' },
    };
    const t = map[type] || map.unknown;
    return `<span style="background:${t.color};color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600">${t.label}</span>`;
}

function timeAgo(date) {
    if (!date) return 'recently';
    const diff = Date.now() - new Date(date).getTime();
    if (isNaN(diff) || diff < 0) return 'recently';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function formatDateTime(date) {
    if (!date) return '';
    try {
        return new Date(date).toLocaleString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });
    } catch (e) {
        return String(date);
    }
}

function getRelativeMeetingTime(date) {
    const target = new Date(date).getTime();
    const now = Date.now();
    const diffMs = target - now;
    if (diffMs < 0) {
        return `${Math.round(-diffMs / (60 * 60 * 1000))}h ago (Past)`;
    }
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    const mins = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
    if (hours === 0) return `In ${mins} minutes`;
    if (hours < 24) return `In ${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    return `In ${days} day${days > 1 ? 's' : ''}`;
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
async function renderDashboard(query = {}) {
    const leads = await getAllLeads();
    const interviews = await getAllInterviews();
    const stats = computeStats(leads, interviews);
    const waStatus = getWhatsAppStatus();

    const selectedPhone = query.contact || (leads.length > 0 ? leads[0].phoneNumber : null);
    const chatHistory = selectedPhone ? await getChatHistory(selectedPhone, 50) : [];
    const selectedLead = selectedPhone ? leads.find(l => l.phoneNumber === selectedPhone) || { phoneNumber: selectedPhone, activeAgent: 'orix', leadType: 'client' } : null;

    const upcomingInterviews = interviews.filter(i => !i.isPast && i.status === 'scheduled');
    const pastInterviews = interviews.filter(i => i.isPast || i.status !== 'scheduled');

    // Default to 'live' tab so user can see QR code and connection status immediately
    const activeTab = query.tab || (waStatus.status === 'waiting_qr' ? 'live' : 'live');
    const isMongo = isMongoConnected();

    // Format uptime
    function formatUptime(ms) {
        if (!ms || ms <= 0) return '00m 00s';
        const totalSec = Math.floor(ms / 1000);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
        return `${mins}m ${secs}s`;
    }

    const isConnected = waStatus.status === 'connected';
    const isWaitingQr = waStatus.status === 'waiting_qr' || (!isConnected && waStatus.qr);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HMorix WhatsApp Bot & CRM Live Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f1f5f9; min-height: 100vh; }

  /* Header */
  .header { background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; flex-wrap: wrap; gap: 12px; }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo { font-size: 26px; background: #312e81; padding: 6px 12px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; }
  .header h1 { font-size: 19px; font-weight: 700; color: #fff; letter-spacing: -0.3px; }
  .header p { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  
  .live-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; text-decoration: none; transition: all 0.2s; }
  .live-pill.connected { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
  .live-pill.waiting { background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }
  .live-pill.reconnecting { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
  .live-pill.offline { background: rgba(148,163,184,0.15); color: #94a3b8; border: 1px solid rgba(148,163,184,0.3); }

  .pulse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .pulse-dot.green { background: #22c55e; animation: pulse 2s infinite; }
  .pulse-dot.blue { background: #3b82f6; animation: pulse 1.5s infinite; }
  .pulse-dot.amber { background: #f59e0b; animation: pulse 1s infinite; }
  .pulse-dot.gray { background: #64748b; }
  @keyframes pulse { 0%,100%{opacity:1; transform:scale(1)} 50%{opacity:0.35; transform:scale(1.25)} }

  .storage-pill { font-size: 11px; padding: 4px 10px; border-radius: 20px; font-weight: 600; background: #1e293b; color: #94a3b8; }
  .refresh-btn { background: #312e81; color: #c7d2fe; border: 1px solid #4338ca; padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s; }
  .refresh-btn:hover { background: #3730a3; }

  /* Navigation Bar */
  .nav-bar { display: flex; background: #070b14; border-bottom: 1px solid #1e293b; padding: 0 20px; overflow-x: auto; }
  .nav-tab { padding: 14px 18px; text-decoration: none; color: #94a3b8; font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; border-bottom: 2px solid transparent; transition: all 0.15s; white-space: nowrap; }
  .nav-tab:hover { color: #f1f5f9; background: rgba(255,255,255,0.02); }
  .nav-tab.active { color: #818cf8; border-bottom-color: #6366f1; background: rgba(99,102,241,0.08); }
  .nav-badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 700; }

  /* Stats Bar */
  .stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; padding: 16px 24px; background: #0f172a; border-bottom: 1px solid #1e293b; }
  .stat-card { background: #131d31; border: 1px solid #1e293b; border-radius: 12px; padding: 14px 18px; }
  .stat-card .num { font-size: 22px; font-weight: 800; color: #6366f1; letter-spacing: -0.5px; display: flex; align-items: center; gap: 8px; }
  .stat-card .lbl { font-size: 11px; color: #64748b; margin-top: 4px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }

  /* Tab 1: WhatsApp Live Monitor View */
  .live-grid { display: grid; grid-template-columns: 430px 1fr; gap: 20px; padding: 24px; min-height: calc(100vh - 190px); }
  
  .card-box { background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 24px; display: flex; flex-direction: column; }
  .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #1e293b; }
  .card-header h3 { font-size: 16px; font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 8px; }
  .status-tag { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  
  /* QR Code Presentation */
  .qr-center-box { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .qr-image-frame { background: #ffffff; padding: 14px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: inline-block; margin: 12px 0 16px; max-width: 100%; border: 4px solid #3b82f6; }
  .qr-image-frame img { display: block; width: 280px; height: 280px; max-width: 100%; object-fit: contain; }
  .qr-placeholder { width: 280px; height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #0f172a; gap: 12px; font-weight: 600; font-size: 13px; }

  /* Refresh Countdown Bar */
  .timer-card { width: 100%; background: #131d31; border: 1px solid #1e293b; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; }
  .timer-track { width: 100%; height: 6px; background: #1e293b; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .timer-fill { height: 100%; width: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1); border-radius: 4px; transition: width 1s linear; }
  .timer-label { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #94a3b8; }
  .timer-label strong { color: #60a5fa; font-size: 14px; }

  /* Step Instructions */
  .instructions-box { background: #131d31; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; width: 100%; text-align: left; }
  .instructions-box h4 { font-size: 13px; font-weight: 700; color: #c7d2fe; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .step-row { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; color: #cbd5e1; margin-bottom: 8px; line-height: 1.4; }
  .step-num { width: 20px; height: 20px; border-radius: 50%; background: #312e81; color: #a5b4fc; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }

  /* Connected Card State */
  .connected-hero { text-align: center; padding: 20px 10px; }
  .connected-hero .icon-big { font-size: 56px; margin-bottom: 10px; display: inline-block; filter: drop-shadow(0 0 16px rgba(34,197,94,0.4)); }
  .connected-hero h2 { font-size: 20px; font-weight: 800; color: #4ade80; margin-bottom: 6px; }
  .connected-hero p { font-size: 13px; color: #94a3b8; max-width: 320px; margin: 0 auto 20px; line-height: 1.4; }
  
  .details-list { background: #131d31; border: 1px solid #1e293b; border-radius: 12px; padding: 14px 18px; margin-top: 14px; }
  .detail-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #1e293b; font-size: 12.5px; }
  .detail-row:last-child { border-bottom: none; }
  .detail-lbl { color: #64748b; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .detail-val { color: #f8fafc; font-weight: 700; }

  /* Terminal Window */
  .terminal-box { background: #030712; border: 1px solid #1e293b; border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); height: 100%; min-height: 520px; }
  .terminal-top { background: #0f172a; padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; flex-wrap: wrap; gap: 10px; }
  .terminal-dots { display: flex; gap: 6px; align-items: center; }
  .tdot { width: 11px; height: 11px; border-radius: 50%; }
  .tdot.red { background: #ef4444; }
  .tdot.yellow { background: #f59e0b; }
  .tdot.green { background: #22c55e; }
  .terminal-title { font-size: 13px; font-weight: 700; color: #e2e8f0; display: flex; align-items: center; gap: 8px; margin-left: 8px; }
  
  .terminal-actions { display: flex; gap: 8px; align-items: center; }
  .filter-pill { background: #1e293b; color: #94a3b8; border: 1px solid #334155; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .filter-pill.active { background: #4f46e5; color: #fff; border-color: #6366f1; }
  .copy-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .copy-btn:hover { background: #334155; color: #fff; }

  .terminal-logs { flex: 1; padding: 16px; overflow-y: auto; font-family: 'JetBrains Mono', Consolas, Monaco, monospace; font-size: 12px; line-height: 1.6; max-height: 580px; }
  .log-line { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; word-break: break-word; }
  .log-time { color: #64748b; font-size: 10.5px; white-space: nowrap; flex-shrink: 0; }
  .log-tag { font-size: 9.5px; font-weight: 800; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; white-space: nowrap; flex-shrink: 0; }
  .log-tag.in { background: #1e3a8a; color: #93c5fd; }
  .log-tag.out { background: #3730a3; color: #c7d2fe; }
  .log-tag.qr { background: #14532d; color: #86efac; }
  .log-tag.success { background: #064e3b; color: #6ee7b7; }
  .log-tag.warn { background: #78350f; color: #fde68a; }
  .log-tag.error { background: #7f1d1d; color: #fca5a5; }
  .log-tag.info { background: #1e293b; color: #94a3b8; }
  .log-msg { color: #e2e8f0; }

  /* CRM 2-Column Main Layout (Leads & Meetings) */
  .main { display: grid; grid-template-columns: 380px 1fr; min-height: calc(100vh - 140px); }
  .left-panel { background: #0f172a; border-right: 1px solid #1e293b; display: flex; flex-direction: column; overflow: hidden; }
  .tabs { display: flex; border-bottom: 1px solid #1e293b; background: #0b0f19; }
  .tab { flex: 1; padding: 14px 10px; text-align: center; font-size: 13px; font-weight: 600; color: #64748b; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.15s; }
  .tab:hover { color: #cbd5e1; background: rgba(255,255,255,0.02); }
  .tab.active { color: #818cf8; border-bottom: 2px solid #6366f1; background: rgba(99,102,241,0.08); }
  .counter-badge { background: #1e293b; color: #cbd5e1; font-size: 11px; padding: 1px 7px; border-radius: 10px; }

  .list-scroll { overflow-y: auto; flex: 1; }
  .contact-item { padding: 14px 20px; border-bottom: 1px solid #131d31; cursor: pointer; transition: background 0.15s; display: block; text-decoration: none; color: inherit; }
  .contact-item:hover { background: rgba(99,102,241,0.06); }
  .contact-item.active { background: rgba(99,102,241,0.14); border-left: 3px solid #6366f1; }
  .contact-item .top-row { display: flex; align-items: center; justify-content: space-between; }
  .contact-item .phone { font-size: 14px; font-weight: 700; color: #f8fafc; }
  .contact-item .meta-row { display: flex; gap: 6px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
  .contact-item .preview { font-size: 12px; color: #94a3b8; margin-top: 6px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .meeting-item { padding: 16px 20px; border-bottom: 1px solid #1e293b; transition: background 0.15s; }
  .meeting-item.today { background: rgba(245, 158, 11, 0.08); border-left: 3px solid #f59e0b; }
  .meeting-item.upcoming { border-left: 3px solid #22c55e; }
  .meeting-item.past { border-left: 3px solid #475569; opacity: 0.65; }
  .meeting-item .time-title { display: flex; align-items: center; justify-content: space-between; }
  .meeting-item .time { font-size: 15px; font-weight: 700; color: #f59e0b; }
  .meeting-item .rel-time { font-size: 11px; background: rgba(245,158,11,0.15); color: #fbbf24; padding: 2px 8px; border-radius: 8px; font-weight: 700; }
  .meeting-item .phone { font-size: 13px; font-weight: 600; color: #cbd5e1; margin-top: 4px; }
  .meeting-item .role { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .reminder-pills { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .pill { font-size: 10px; padding: 3px 8px; border-radius: 8px; font-weight: 700; text-transform: uppercase; }
  .pill-sent { background: #14532d; color: #86efac; }
  .pill-pending { background: #1e293b; color: #64748b; }
  .pill-today { background: #78350f; color: #fde68a; }

  .schedule-box { padding: 16px 20px; background: #131d31; border-bottom: 1px solid #1e293b; }
  .schedule-box h3 { font-size: 13px; color: #818cf8; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .form-group { margin-bottom: 8px; }
  .form-group input, .form-group select { width: 100%; padding: 8px 12px; background: #0b0f19; border: 1px solid #334155; border-radius: 6px; color: #f8fafc; font-size: 12px; outline: none; }
  .form-group input:focus { border-color: #6366f1; }
  .btn-submit { width: 100%; padding: 8px; background: #4f46e5; color: #fff; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .btn-submit:hover { background: #4338ca; }

  .right-panel { background: #0b0f19; display: flex; flex-direction: column; overflow: hidden; }
  .right-header { padding: 16px 28px; border-bottom: 1px solid #1e293b; background: #0f172a; display: flex; align-items: center; justify-content: space-between; }
  .right-header h2 { font-size: 17px; font-weight: 700; color: #f8fafc; }
  .right-header .sub { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 12px; color: #64748b; }

  .chat-scroll { flex: 1; overflow-y: auto; padding: 20px 28px; display: flex; flex-direction: column; gap: 14px; }
  .bubble-wrap { display: flex; flex-direction: column; max-width: 75%; }
  .bubble-wrap.user { align-self: flex-start; }
  .bubble-wrap.ai { align-self: flex-end; align-items: flex-end; }
  .bubble-meta { font-size: 11px; color: #475569; margin-bottom: 4px; font-weight: 600; }
  .bubble { padding: 11px 16px; border-radius: 16px; font-size: 13.5px; line-height: 1.5; word-break: break-word; }
  .bubble.user { background: #1e293b; color: #f1f5f9; border-bottom-left-radius: 4px; border: 1px solid #334155; }
  .bubble.ai { background: #4f46e5; color: #ffffff; border-bottom-right-radius: 4px; }

  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; color: #475569; text-align: center; padding: 40px; }
  .empty-state .icon { font-size: 44px; }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }

  /* Mobile Responsive Media Queries */
  @media (max-width: 900px) {
    .live-grid { grid-template-columns: 1fr; padding: 14px; gap: 16px; }
    .main { grid-template-columns: 1fr; }
    .stats-bar { grid-template-columns: repeat(2, 1fr); padding: 12px; }
    .qr-image-frame img { width: 240px; height: 240px; }
    .qr-placeholder { width: 240px; height: 240px; }
    .header { padding: 12px 16px; }
  }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-left">
    <div class="logo">⚡</div>
    <div>
      <h1>HMorix Multi-Agent WhatsApp System</h1>
      <p>ORIX (Sales) · BLOPSY (HR & Reminders) · MANIK (Personal Hinglish AI)</p>
    </div>
  </div>
  <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
    <a href="/?tab=live" class="live-pill ${isConnected ? 'connected' : isWaitingQr ? 'waiting' : waStatus.status === 'reconnecting' ? 'reconnecting' : 'offline'}" id="header-live-pill">
      <span class="pulse-dot ${isConnected ? 'green' : isWaitingQr ? 'blue' : waStatus.status === 'reconnecting' ? 'amber' : 'gray'}" id="header-pulse-dot"></span>
      <span id="header-status-text">${isConnected ? 'WhatsApp LIVE' : isWaitingQr ? 'Scan QR Needed' : waStatus.status === 'reconnecting' ? 'Reconnecting' : 'Offline'}</span>
    </a>
    <span class="storage-pill">${isMongo ? '🍃 MongoDB Atlas' : '📁 Local Storage'}</span>
    <a href="/?tab=${activeTab}${selectedPhone ? '&contact=' + selectedPhone : ''}" class="refresh-btn">🔄 Refresh</a>
  </div>
</div>

<!-- TOP NAV TABS -->
<div class="nav-bar">
  <a href="/?tab=live" class="nav-tab ${activeTab === 'live' ? 'active' : ''}">
    📱 WhatsApp Live & QR 
    <span class="nav-badge" id="nav-tab-badge" style="background:${isConnected ? '#15803d' : isWaitingQr ? '#2563eb' : '#b45309'}; color:#fff">
      ${isConnected ? 'ONLINE' : isWaitingQr ? 'SCAN QR' : 'STATUS'}
    </span>
  </a>
  <a href="/?tab=leads${selectedPhone ? '&contact=' + selectedPhone : ''}" class="nav-tab ${activeTab === 'leads' ? 'active' : ''}">
    👥 Leads & CRM <span class="counter-badge">${leads.length}</span>
  </a>
  <a href="/?tab=interviews${selectedPhone ? '&contact=' + selectedPhone : ''}" class="nav-tab ${activeTab === 'interviews' ? 'active' : ''}">
    📅 Meetings & Reminders <span class="counter-badge" style="background:#4338ca">${upcomingInterviews.length}</span>
  </a>
</div>

<!-- STATS BAR -->
<div class="stats-bar">
  <div class="stat-card">
    <div class="num" id="stat-connection-num" style="color:${isConnected ? '#4ade80' : isWaitingQr ? '#60a5fa' : '#f59e0b'}">
      ${isConnected ? '🟢 ACTIVE' : isWaitingQr ? '📱 SCAN QR' : '🟡 ' + waStatus.status.toUpperCase()}
    </div>
    <div class="lbl">WhatsApp Connection</div>
  </div>
  <div class="stat-card">
    <div class="num" id="stat-uptime-num" style="color:#818cf8">${formatUptime(waStatus.uptimeMs)}</div>
    <div class="lbl">Session Live Uptime</div>
  </div>
  <div class="stat-card">
    <div class="num" id="stat-reconnect-num" style="color:#f59e0b">${waStatus.reconnectCount}</div>
    <div class="lbl">Reconnection Count</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#22c55e">
      <span id="stat-sent-num">${waStatus.messagesSent || 0}</span>
      <span style="font-size:13px;color:#64748b;margin-left:4px">/ <span id="stat-recv-num">${waStatus.messagesReceived || 0}</span> in</span>
    </div>
    <div class="lbl">Messages Handled</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#a855f7">🌙 23:00</div>
    <div class="lbl">Anti-Ban Night Rest</div>
  </div>
</div>

${activeTab === 'live' ? `
<!-- TAB 1: WHATSAPP LIVE MONITOR VIEW -->
<div class="live-grid">

  <!-- LEFT COLUMN: QR CODE OR CONNECTED STATUS -->
  <div class="card-box" id="left-live-card">
    
    <!-- IF WAITING FOR QR OR DISCONNECTED -->
    <div id="qr-view-container" style="${isConnected ? 'display:none;' : 'display:block;'}">
      <div class="card-header">
        <h3>📱 Link WhatsApp with QR</h3>
        <span class="status-tag" style="background:#1e3a8a; color:#93c5fd">Single Device</span>
      </div>

      <div class="qr-center-box">
        <div class="qr-image-frame" id="qr-frame-box">
          <img id="live-qr-img" src="${waStatus.qr || ''}" alt="WhatsApp Web QR Code" style="${waStatus.qr ? 'display:block;' : 'display:none;'}">
          <div id="qr-placeholder" class="qr-placeholder" style="${waStatus.qr ? 'display:none;' : 'display:flex;'}">
            <span style="font-size:32px">⏳</span>
            <div>Waiting for QR Code...</div>
            <div style="font-size:11px;color:#64748b">Generated by Baileys on WhatsApp Web</div>
          </div>
        </div>

        <!-- REFRESH TIMER COUNTDOWN BAR -->
        <div class="timer-card">
          <div class="timer-label">
            <span>🔄 Auto-refreshing security key:</span>
            <strong id="timer-countdown-text">25s</strong>
          </div>
          <div class="timer-track">
            <div class="timer-fill" id="timer-progress-fill" style="width:100%"></div>
          </div>
        </div>

        <!-- STEP BY STEP GUIDE -->
        <div class="instructions-box">
          <h4>📋 Quick Mobile Pairing Instructions</h4>
          <div class="step-row">
            <div class="step-num">1</div>
            <div>Open <strong>WhatsApp</strong> on your phone</div>
          </div>
          <div class="step-row">
            <div class="step-num">2</div>
            <div>Tap <strong>Settings</strong> (iPhone) or <strong>⋮ (Three dots)</strong> (Android) → <strong>Linked Devices</strong></div>
          </div>
          <div class="step-row">
            <div class="step-num">3</div>
            <div>Tap <strong>Link a Device</strong> and point camera here</div>
          </div>
          <div class="step-row">
            <div class="step-num">4</div>
            <div>Scan once — session is saved permanently in Termux!</div>
          </div>
        </div>
      </div>
    </div>

    <!-- IF CONNECTED AND ONLINE -->
    <div id="connected-view-container" style="${isConnected ? 'display:block;' : 'display:none;'}">
      <div class="card-header">
        <h3>🤖 WhatsApp Status</h3>
        <span class="status-tag" style="background:#14532d; color:#86efac">ONLINE</span>
      </div>

      <div class="connected-hero">
        <div class="icon-big">✅</div>
        <h2>WhatsApp Connected!</h2>
        <p>HMorix multi-agent AI system is active, responding to contacts, and scheduling interviews.</p>
      </div>

      <div class="details-list">
        <div class="detail-row">
          <span class="detail-lbl">💼 Sales AI Agent</span>
          <span class="detail-val" style="color:#818cf8">ORIX (Smart Tech)</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">👩‍💼 HR Coordinator</span>
          <span class="detail-val" style="color:#06b6d4">BLOPSY (Interviews)</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">👦 Personal AI</span>
          <span class="detail-val" style="color:#22c55e">MANIK (Hinglish)</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">🛡️ Anti-Ban Protections</span>
          <span class="detail-val" style="color:#4ade80">Active (Typing jitter + 6/min)</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">🌙 Night Rest Mode</span>
          <span class="detail-val" style="color:#f59e0b">23:00 Shutdown Arm</span>
        </div>
        <div class="detail-row">
          <span class="detail-lbl">📦 WA Web Protocol</span>
          <span class="detail-val" id="detail-wa-version">${waStatus.waWebVersion || 'v2.3000.x'}</span>
        </div>
      </div>
    </div>

  </div>

  <!-- RIGHT COLUMN: REAL-TIME ACTIVITY TERMINAL LOGS -->
  <div class="terminal-box">
    <div class="terminal-top">
      <div style="display:flex; align-items:center;">
        <div class="terminal-dots">
          <div class="tdot red"></div>
          <div class="tdot yellow"></div>
          <div class="tdot green"></div>
        </div>
        <div class="terminal-title">⚡ Real-Time WhatsApp Activity Logs</div>
      </div>

      <div class="terminal-actions">
        <button class="filter-pill active" onclick="setLogFilter('all', this)">All</button>
        <button class="filter-pill" onclick="setLogFilter('in', this)">Inbound 📩</button>
        <button class="filter-pill" onclick="setLogFilter('out', this)">AI 🤖</button>
        <button class="filter-pill" onclick="setLogFilter('system', this)">System ⚙️</button>
        <button class="copy-btn" onclick="copyAllLogs()">📋 Copy</button>
      </div>
    </div>

    <div class="terminal-logs" id="terminal-logs-container">
      ${(waStatus.logs || []).length === 0 ? `
        <div style="color:#64748b; text-align:center; padding:40px 10px;">
          <div>📡 Waiting for WhatsApp events...</div>
          <div style="font-size:11px; margin-top:4px;">Incoming messages, AI replies, and reconnects stream here live.</div>
        </div>
      ` : (waStatus.logs || []).map(log => `
        <div class="log-line log-type-${log.type || 'info'}">
          <span class="log-time">[${log.timestamp || ''}]</span>
          <span class="log-tag ${log.type || 'info'}">${log.type || 'INFO'}</span>
          <span class="log-msg">${(log.text || '').replace(/</g, '&lt;')}</span>
        </div>
      `).join('')}
    </div>
  </div>

</div>
` : `
<!-- TAB 2 & 3: CRM LEADS & MEETINGS VIEW -->
<div class="main">

  <!-- LEFT PANEL -->
  <div class="left-panel">
    <div class="tabs">
      <a href="/?tab=leads${selectedPhone ? '&contact=' + selectedPhone : ''}" class="tab ${activeTab === 'leads' ? 'active' : ''}">
        👥 Leads & Chats <span class="counter-badge">${leads.length}</span>
      </a>
      <a href="/?tab=interviews${selectedPhone ? '&contact=' + selectedPhone : ''}" class="tab ${activeTab === 'interviews' ? 'active' : ''}">
        📅 Meetings <span class="counter-badge" style="background:#4338ca">${upcomingInterviews.length}</span>
      </a>
    </div>

    <!-- MEETINGS TAB -->
    ${activeTab === 'interviews' ? `
      <!-- Quick Add Meeting Form -->
      <div class="schedule-box">
        <h3>➕ Schedule / Confirm Meeting</h3>
        <form method="POST" action="/api/schedule-meeting">
          <div class="form-group">
            <input type="text" name="phoneNumber" placeholder="Phone Number (e.g. 919876543210)" required value="${selectedPhone || ''}">
          </div>
          <div class="form-group">
            <input type="datetime-local" name="scheduledTime" required>
          </div>
          <div class="form-group">
            <input type="text" name="role" placeholder="Meeting Purpose (e.g. Client Call: Restaurant Website)">
          </div>
          <div class="form-group">
            <input type="text" name="candidateName" placeholder="Name (Client / Candidate)">
          </div>
          <button type="submit" class="btn-submit">📅 Save Meeting & Arm Reminders</button>
        </form>
      </div>

      <div class="list-scroll">
        ${upcomingInterviews.length === 0 && pastInterviews.length === 0 ? `
          <div class="empty-state">
            <div class="icon">📅</div>
            <div>No meetings scheduled yet.</div>
            <div style="font-size:12px;color:#64748b">Use the form above to add a meeting or let Orix / Blopsy schedule it in chat!</div>
          </div>
        ` : ''}

        ${upcomingInterviews.length > 0 ? `
          <div style="padding:12px 20px 6px; font-size:11px; font-weight:700; color:#22c55e; letter-spacing:0.5px">
            🟢 UPCOMING (${upcomingInterviews.length})
          </div>
          ${upcomingInterviews.map(iv => `
            <div class="meeting-item ${iv.isToday ? 'today' : 'upcoming'}">
              <div class="time-title">
                <span class="time">${formatDateTime(iv.scheduledTime)}</span>
                <span class="rel-time">${getRelativeMeetingTime(iv.scheduledTime)}</span>
              </div>
              <div class="phone">📱 +${iv.phoneNumber}</div>
              <div class="role">📌 ${iv.role || 'Client Consultation / Interview'} ${iv.candidateName && iv.candidateName !== 'Candidate' ? '• ' + iv.candidateName : ''}</div>
              <div class="reminder-pills">
                ${iv.isToday ? '<span class="pill pill-today">⚡ TODAY</span>' : ''}
                <span class="pill ${iv.reminded2h ? 'pill-sent' : 'pill-pending'}">${iv.reminded2h ? '✓ 2h Sent' : '2h Pending'}</span>
                <span class="pill ${iv.reminded1h ? 'pill-sent' : 'pill-pending'}">${iv.reminded1h ? '✓ 1h Sent' : '1h Pending'}</span>
                <span class="pill ${iv.reminded15m ? 'pill-sent' : 'pill-pending'}">${iv.reminded15m ? '✓ 15m Sent' : '15m Pending'}</span>
              </div>
            </div>
          `).join('')}
        ` : ''}

        ${pastInterviews.length > 0 ? `
          <div style="padding:14px 20px 6px; font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.5px">
            ⬛ PAST / COMPLETED (${pastInterviews.length})
          </div>
          ${pastInterviews.map(iv => `
            <div class="meeting-item past">
              <div class="time-title">
                <span class="time" style="color:#64748b">${formatDateTime(iv.scheduledTime)}</span>
                <span style="font-size:11px; color:#475569">${iv.status}</span>
              </div>
              <div class="phone" style="color:#64748b">📱 +${iv.phoneNumber}</div>
              <div class="role" style="color:#475569">📌 ${iv.role || 'Meeting'}</div>
            </div>
          `).join('')}
        ` : ''}
      </div>
    ` : `
      <!-- LEADS TAB -->
      <div class="list-scroll">
        ${leads.length === 0 ? `
          <div class="empty-state">
            <div class="icon">💬</div>
            <div>No active contacts found.</div>
            <div style="font-size:12px">When someone messages your WhatsApp number, they will automatically appear here!</div>
          </div>
        ` : ''}

        ${leads.map(lead => `
          <a href="/?contact=${lead.phoneNumber}&tab=leads" class="contact-item ${selectedPhone === lead.phoneNumber ? 'active' : ''}">
            <div class="top-row">
              <span class="phone">+${lead.phoneNumber}</span>
              <span style="font-size:11px;color:#475569">${timeAgo(lead.updatedAt)}</span>
            </div>
            <div class="meta-row">
              ${agentBadge(lead.activeAgent)}
              ${leadTypeBadge(lead.leadType)}
            </div>
            ${lead.summary ? `<div class="preview">${lead.summary}</div>` : ''}
          </a>
        `).join('')}
      </div>
    `}
  </div>

  <!-- RIGHT PANEL (CHAT VIEWER) -->
  <div class="right-panel">
    ${selectedLead ? `
      <div class="right-header">
        <div>
          <h2>📱 +${selectedLead.phoneNumber}</h2>
          <div class="sub">
            ${agentBadge(selectedLead.activeAgent)}
            ${leadTypeBadge(selectedLead.leadType)}
            <span>· Last Active: ${timeAgo(selectedLead.updatedAt)}</span>
          </div>
        </div>
        <div>
          <a href="/?tab=interviews&contact=${selectedLead.phoneNumber}" class="refresh-btn" style="background:#1e1b4b; border-color:#3730a3">
            📅 Schedule Call For This Contact
          </a>
        </div>
      </div>

      <div class="chat-scroll">
        ${chatHistory.length === 0 ? `
          <div class="empty-state">
            <div class="icon">💬</div>
            <div>No messages logged yet for +${selectedLead.phoneNumber}.</div>
          </div>
        ` : ''}

        ${chatHistory.map(msg => {
            const isUser = msg.role === 'USER' || msg.role === 'user';
            const cleanText = (msg.message || msg.content || '').replace(/</g, '&lt;').replace(/\n/g, '<br>');
            return `
              <div class="bubble-wrap ${isUser ? 'user' : 'ai'}">
                <div class="bubble-meta">${isUser ? '👤 User' : (selectedLead.activeAgent === 'blopsy' ? '👩‍💼 Blopsy' : '💼 Orix')} ${msg.timestamp ? '· ' + msg.timestamp : ''}</div>
                <div class="bubble ${isUser ? 'user' : 'ai'}">${cleanText}</div>
              </div>
            `;
        }).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <div class="icon">👈</div>
        <div>Select a contact from the list on the left to view the full WhatsApp conversation.</div>
      </div>
    `}
  </div>

</div>
`}

<!-- REAL-TIME CLIENT SCRIPT -->
<script>
  let currentLogFilter = 'all';
  let lastQrRaw = '';
  let qrGeneratedTime = ${waStatus.qrGeneratedAt || 'Date.now()'};
  let qrLifespanSec = ${waStatus.qrExpiresIn || 25};
  let currentUptimeMs = ${waStatus.uptimeMs || 0};
  let isCurrentlyConnected = ${isConnected ? 'true' : 'false'};

  // Format ms to hh:mm:ss
  function formatMs(ms) {
    if (!ms || ms <= 0) return '00m 00s';
    const totalSec = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) return (hrs < 10 ? '0' : '') + hrs + 'h ' + (mins < 10 ? '0' : '') + mins + 'm ' + (secs < 10 ? '0' : '') + secs + 's';
    return (mins < 10 ? '0' : '') + mins + 'm ' + (secs < 10 ? '0' : '') + secs + 's';
  }

  // Uptime ticker every second
  setInterval(() => {
    if (isCurrentlyConnected) {
      currentUptimeMs += 1000;
      const el = document.getElementById('stat-uptime-num');
      if (el) el.innerText = formatMs(currentUptimeMs);
    }
  }, 1000);

  // QR Countdown ticker every second
  setInterval(() => {
    if (!isCurrentlyConnected) {
      const elapsed = Math.floor((Date.now() - qrGeneratedTime) / 1000);
      let remain = Math.max(0, qrLifespanSec - (elapsed % qrLifespanSec));
      const countdownEl = document.getElementById('timer-countdown-text');
      const fillEl = document.getElementById('timer-progress-fill');
      if (countdownEl) countdownEl.innerText = remain + 's';
      if (fillEl) fillEl.style.width = ((remain / qrLifespanSec) * 100) + '%';
    }
  }, 1000);

  // Poll /api/status every 1500ms
  async function pollStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();

      isCurrentlyConnected = data.status === 'connected';
      currentUptimeMs = data.uptimeMs || 0;

      // Update Header Pill
      const pill = document.getElementById('header-live-pill');
      const dot = document.getElementById('header-pulse-dot');
      const txt = document.getElementById('header-status-text');
      if (pill && dot && txt) {
        if (isCurrentlyConnected) {
          pill.className = 'live-pill connected';
          dot.className = 'pulse-dot green';
          txt.innerText = 'WhatsApp LIVE';
        } else if (data.status === 'waiting_qr' || data.qr) {
          pill.className = 'live-pill waiting';
          dot.className = 'pulse-dot blue';
          txt.innerText = 'Scan QR Needed';
        } else if (data.status === 'reconnecting') {
          pill.className = 'live-pill reconnecting';
          dot.className = 'pulse-dot amber';
          txt.innerText = 'Reconnecting';
        } else {
          pill.className = 'live-pill offline';
          dot.className = 'pulse-dot gray';
          txt.innerText = 'Offline';
        }
      }

      // Update Stats Bar
      const statConn = document.getElementById('stat-connection-num');
      if (statConn) {
        if (isCurrentlyConnected) {
          statConn.style.color = '#4ade80';
          statConn.innerText = '🟢 ACTIVE';
        } else if (data.status === 'waiting_qr' || data.qr) {
          statConn.style.color = '#60a5fa';
          statConn.innerText = '📱 SCAN QR';
        } else {
          statConn.style.color = '#f59e0b';
          statConn.innerText = '🟡 ' + (data.status || 'OFFLINE').toUpperCase();
        }
      }

      const recEl = document.getElementById('stat-reconnect-num');
      if (recEl && data.reconnectCount !== undefined) recEl.innerText = data.reconnectCount;

      const sentEl = document.getElementById('stat-sent-num');
      if (sentEl && data.messagesSent !== undefined) sentEl.innerText = data.messagesSent;

      const recvEl = document.getElementById('stat-recv-num');
      if (recvEl && data.messagesReceived !== undefined) recvEl.innerText = data.messagesReceived;

      // Switch between QR View and Connected View
      const qrView = document.getElementById('qr-view-container');
      const connView = document.getElementById('connected-view-container');
      if (qrView && connView) {
        if (isCurrentlyConnected) {
          qrView.style.display = 'none';
          connView.style.display = 'block';
        } else {
          qrView.style.display = 'block';
          connView.style.display = 'none';
        }
      }

      // Update QR Code Image
      const qrImg = document.getElementById('live-qr-img');
      const qrHolder = document.getElementById('qr-placeholder');
      if (qrImg && qrHolder) {
        if (data.qr) {
          if (qrImg.src !== data.qr) {
            qrImg.src = data.qr;
            qrGeneratedTime = data.qrGeneratedAt || Date.now();
          }
          qrImg.style.display = 'block';
          qrHolder.style.display = 'none';
        } else if (!isCurrentlyConnected) {
          qrImg.style.display = 'none';
          qrHolder.style.display = 'flex';
        }
      }

      // Update WA Web Version in connected card
      const verEl = document.getElementById('detail-wa-version');
      if (verEl && data.waWebVersion) verEl.innerText = data.waWebVersion;

      // Update Real-Time Logs in Terminal
      if (data.logs && Array.isArray(data.logs)) {
        renderTerminalLogs(data.logs);
      }

    } catch (e) {}
  }

  setInterval(pollStatus, 1500);

  // Render logs into terminal
  function renderTerminalLogs(logs) {
    const container = document.getElementById('terminal-logs-container');
    if (!container) return;

    const filtered = logs.filter(log => {
      if (currentLogFilter === 'all') return true;
      if (currentLogFilter === 'in') return log.type === 'in';
      if (currentLogFilter === 'out') return log.type === 'out';
      if (currentLogFilter === 'system') return ['info', 'qr', 'warn', 'error', 'success'].includes(log.type);
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div style="color:#64748b; text-align:center; padding:40px 10px;">No events matching current filter.</div>';
      return;
    }

    const html = filtered.map(log => \`
      <div class="log-line log-type-\${log.type || 'info'}">
        <span class="log-time">[\${log.timestamp || ''}]</span>
        <span class="log-tag \${log.type || 'info'}">\${(log.type || 'INFO').toUpperCase()}</span>
        <span class="log-msg">\${(log.text || '').replace(/</g, '&lt;')}</span>
      </div>
    \`).join('');

    const shouldScroll = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
    container.innerHTML = html;
    if (shouldScroll) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function setLogFilter(type, btn) {
    currentLogFilter = type;
    document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    pollStatus();
  }

  function copyAllLogs() {
    const container = document.getElementById('terminal-logs-container');
    if (!container) return;
    const text = container.innerText;
    navigator.clipboard.writeText(text).then(() => {
      alert('📋 Live logs copied to clipboard!');
    }).catch(() => {
      prompt('Copy logs below:', text);
    });
  }

  // Auto-scroll chat to bottom if on CRM leads tab
  const chatScroll = document.querySelector('.chat-scroll');
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
</script>
</body>
</html>`;
}

// ─── HTTP Server & API Routes ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const query = Object.fromEntries(url.searchParams.entries());

        // POST /api/schedule-meeting (form submit from dashboard)
        if (req.method === 'POST' && url.pathname === '/api/schedule-meeting') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const params = new URLSearchParams(body);
                    const phoneNumber = (params.get('phoneNumber') || '').replace(/[^0-9]/g, '');
                    const scheduledTimeStr = params.get('scheduledTime');
                    const role = params.get('role') || 'Client Consultation';
                    const candidateName = params.get('candidateName') || 'Client';

                    if (phoneNumber && scheduledTimeStr) {
                        const scheduledTime = new Date(scheduledTimeStr);
                        if (!isNaN(scheduledTime.getTime())) {
                            const newRecord = {
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

                            // Save to local file
                            const list = getLocalInterviews();
                            list.push(newRecord);
                            saveLocalInterviews(list);

                            // Save to Mongo if connected
                            if (isMongoConnected()) {
                                try { await Interview.create(newRecord); } catch (e) {}
                            }

                            console.log(`📅 [Dashboard Scheduled] Added meeting for ${phoneNumber} at: ${scheduledTime.toLocaleString('en-IN')}`);
                        }
                    }
                    res.writeHead(302, { Location: '/?tab=interviews&contact=' + phoneNumber });
                    res.end();
                } catch (e) {
                    res.writeHead(302, { Location: '/?tab=interviews' });
                    res.end();
                }
            });
            return;
        }

        // GET /api/status (Real-time WhatsApp state & QR)
        if (url.pathname === '/api/status') {
            const status = getWhatsAppStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(status));
        }

        // GET /api/logs
        if (url.pathname === '/api/logs') {
            const status = getWhatsAppStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(status.logs || []));
        }

        // GET /api/leads
        if (url.pathname === '/api/leads') {
            const leads = await getAllLeads();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(leads));
        }

        // GET /api/interviews
        if (url.pathname === '/api/interviews') {
            const interviews = await getAllInterviews();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(interviews));
        }

        // GET /api/chat?phone=...
        if (url.pathname === '/api/chat' && query.phone) {
            const history = await getChatHistory(query.phone, 50);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(history));
        }

        // Main Dashboard View
        const html = await renderDashboard(query);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);

    } catch (err) {
        console.error('Dashboard Error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Dashboard error: ' + err.message);
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n📊 HMorix WhatsApp CRM Dashboard');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    server.listen(PORT, () => {
        console.log(`✅ Dashboard running at http://localhost:${PORT}`);
        console.log(`   • View live WhatsApp QR code & real-time activity logs`);
        console.log(`   • View all WhatsApp leads & full chat histories`);
        console.log(`   • View & schedule meetings (with automated 2h/1h/15m reminders)\n`);
    });

    // Connect to Mongo in background without delaying server startup
    connectDB(process.env.MONGODB_URI).catch(() => {
        console.log('ℹ️  Operating in fallback mode (using local txt & json files).');
    });
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
