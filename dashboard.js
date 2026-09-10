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
const PORT = process.env.DASHBOARD_PORT || 3000;

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

    const selectedPhone = query.contact || (leads.length > 0 ? leads[0].phoneNumber : null);
    const chatHistory = selectedPhone ? await getChatHistory(selectedPhone, 50) : [];
    const selectedLead = selectedPhone ? leads.find(l => l.phoneNumber === selectedPhone) || { phoneNumber: selectedPhone, activeAgent: 'orix', leadType: 'client' } : null;

    const upcomingInterviews = interviews.filter(i => !i.isPast && i.status === 'scheduled');
    const pastInterviews = interviews.filter(i => i.isPast || i.status !== 'scheduled');

    const activeTab = query.tab || 'leads';
    const isMongo = isMongoConnected();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HMorix WhatsApp CRM & Meeting Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; min-height: 100vh; }

  .header { background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); padding: 18px 28px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo { font-size: 28px; background: #312e81; padding: 6px 12px; border-radius: 12px; }
  .header h1 { font-size: 20px; font-weight: 700; color: #fff; letter-spacing: -0.3px; }
  .header p { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .live-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
  .storage-pill { font-size: 11px; padding: 4px 10px; border-radius: 20px; font-weight: 600; background: #1e293b; color: #94a3b8; }
  .pulse-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; display: inline-block; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1; transform:scale(1)} 50%{opacity:0.4; transform:scale(1.2)} }

  .stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; padding: 16px 28px; background: #0f172a; border-bottom: 1px solid #1e293b; }
  .stat-card { background: #131d31; border: 1px solid #1e293b; border-radius: 12px; padding: 14px 18px; }
  .stat-card .num { font-size: 26px; font-weight: 800; color: #6366f1; }
  .stat-card .lbl { font-size: 11px; color: #64748b; margin-top: 4px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }

  .main { display: grid; grid-template-columns: 380px 1fr; min-height: calc(100vh - 140px); }

  /* Left Panel */
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

  /* Meetings List */
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

  /* Quick Add Form */
  .schedule-box { padding: 16px 20px; background: #131d31; border-bottom: 1px solid #1e293b; }
  .schedule-box h3 { font-size: 13px; color: #818cf8; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .form-group { margin-bottom: 8px; }
  .form-group input, .form-group select { width: 100%; padding: 8px 12px; background: #0b0f19; border: 1px solid #334155; border-radius: 6px; color: #f8fafc; font-size: 12px; outline: none; }
  .form-group input:focus { border-color: #6366f1; }
  .btn-submit { width: 100%; padding: 8px; background: #4f46e5; color: #fff; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .btn-submit:hover { background: #4338ca; }

  /* Right Panel */
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

  .refresh-btn { background: #312e81; color: #c7d2fe; border: 1px solid #4338ca; padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
  .refresh-btn:hover { background: #3730a3; }

  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }

  @media (max-width: 800px) {
    .main { grid-template-columns: 1fr; }
    .stats-bar { grid-template-columns: repeat(2, 1fr); padding: 12px; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo">⚡</div>
    <div>
      <h1>HMorix WhatsApp CRM <span class="live-pill"><span class="pulse-dot"></span> Live Bot</span></h1>
      <p>Leads · Meetings & Consultations · Candidate Interviews · Automated 2h/1h/15m Reminders</p>
    </div>
  </div>
  <div style="display:flex; gap:10px; align-items:center;">
    <span class="storage-pill">${isMongo ? '🍃 MongoDB Atlas Connected' : '📁 Local Storage (Active)'}</span>
    <a href="/?tab=${activeTab}${selectedPhone ? '&contact=' + selectedPhone : ''}" class="refresh-btn">🔄 Refresh</a>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-card">
    <div class="num">${stats.totalLeads}</div>
    <div class="lbl">Total Contacts</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#22c55e">${stats.clients}</div>
    <div class="lbl">🏢 Client Leads</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#06b6d4">${stats.candidates}</div>
    <div class="lbl">🎓 Candidates (HR)</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#f59e0b">${stats.upcomingInterviews}</div>
    <div class="lbl">📅 Upcoming Meetings</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#a855f7">${stats.totalScheduled}</div>
    <div class="lbl">Total Scheduled</div>
  </div>
</div>

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

<script>
  // Auto-scroll chat to bottom
  const chatScroll = document.querySelector('.chat-scroll');
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;

  // Auto-refresh page every 30 seconds to fetch live leads
  setTimeout(() => {
    // Only auto-reload if user is not actively typing in an input
    if (!document.activeElement || document.activeElement.tagName !== 'INPUT') {
      location.reload();
    }
  }, 30000);
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

    // Attempt MongoDB connection, but gracefully continue if offline
    try {
        await connectDB(process.env.MONGODB_URI);
    } catch (e) {
        console.log('ℹ️  Operating in fallback mode (using local txt & json files).');
    }

    server.listen(PORT, () => {
        console.log(`✅ Dashboard running at http://localhost:${PORT}`);
        console.log(`   • View all WhatsApp leads & full chat histories`);
        console.log(`   • View & schedule meetings (with automated 2h/1h/15m reminders)\n`);
    });
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
