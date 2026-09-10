import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from './db.js';
import { ContactSession } from './models/ContactSession.js';
import { Interview } from './models/Interview.js';
import { Message } from './models/Message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHATS_DIR = path.join(__dirname, 'chats');
const PORT = process.env.DASHBOARD_PORT || 3000;

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function getAllLeads() {
    const sessions = await ContactSession.find().sort({ updatedAt: -1 }).lean();
    return sessions;
}

async function getAllInterviews() {
    const now = new Date();
    const interviews = await Interview.find().sort({ scheduledTime: 1 }).lean();
    return interviews.map(iv => ({
        ...iv,
        isPast: new Date(iv.scheduledTime) < now,
        isToday: new Date(iv.scheduledTime).toDateString() === now.toDateString(),
    }));
}

async function getChatHistory(phoneNumber, limit = 30) {
    try {
        const docs = await Message.find({ phoneNumber })
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();
        return docs.reverse();
    } catch (e) {
        // Fallback to file
        const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
        if (!fs.existsSync(filePath)) return [];
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(l => {
            const m = l.match(/^\[([\d\- :]+)\] (USER|AI): (.+)$/);
            return m ? { timestamp: m[1], role: m[2] === 'USER' ? 'USER' : 'AI', message: m[3] } : null;
        }).filter(Boolean);
    }
}

async function getStats() {
    const [totalLeads, clients, candidates, interviews, upcomingInterviews] = await Promise.all([
        ContactSession.countDocuments(),
        ContactSession.countDocuments({ leadType: 'client' }),
        ContactSession.countDocuments({ leadType: 'candidate' }),
        Interview.countDocuments(),
        Interview.countDocuments({ scheduledTime: { $gte: new Date() }, status: 'scheduled' }),
    ]);
    return { totalLeads, clients, candidates, interviews, upcomingInterviews };
}

// ─── HTML Templates ───────────────────────────────────────────────────────────
function agentBadge(agent) {
    const map = {
        orix: { color: '#4f46e5', icon: '💼', label: 'ORIX' },
        blopsy: { color: '#0891b2', icon: '👩‍💼', label: 'BLOPSY' },
        manik: { color: '#16a34a', icon: '👦', label: 'MANIK' },
    };
    const a = map[agent] || { color: '#6b7280', icon: '🤖', label: agent };
    return `<span style="background:${a.color};color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${a.icon} ${a.label}</span>`;
}

function leadTypeBadge(type) {
    const map = {
        client: { color: '#16a34a', label: '🏢 Client' },
        candidate: { color: '#0891b2', label: '🎓 Candidate' },
        friend: { color: '#d97706', label: '👋 Friend' },
        unknown: { color: '#9ca3af', label: '❓ Unknown' },
    };
    const t = map[type] || map.unknown;
    return `<span style="background:${t.color};color:#fff;padding:2px 8px;border-radius:12px;font-size:11px">${t.label}</span>`;
}

function timeAgo(date) {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function formatDateTime(date) {
    return new Date(date).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}

// ─── Page Renderer ────────────────────────────────────────────────────────────
async function renderDashboard(query = {}) {
    const [leads, interviews, stats] = await Promise.all([
        getAllLeads(),
        getAllInterviews(),
        getStats(),
    ]);

    const selectedPhone = query.contact || null;
    const chatHistory = selectedPhone ? await getChatHistory(selectedPhone, 40) : [];
    const selectedLead = selectedPhone ? leads.find(l => l.phoneNumber === selectedPhone) : null;

    const now = new Date();
    const upcomingInterviews = interviews.filter(i => !i.isPast && i.status === 'scheduled');
    const pastInterviews = interviews.filter(i => i.isPast || i.status !== 'scheduled');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HMorix CRM Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  
  .header { background: linear-gradient(135deg, #1e1b4b 0%, #1e3a5f 100%); padding: 20px 32px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #334155; }
  .header h1 { font-size: 22px; font-weight: 700; color: #fff; }
  .header p { font-size: 13px; color: #94a3b8; margin-top: 2px; }
  .logo { font-size: 32px; }
  .live-dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; display: inline-block; margin-left: 8px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  .stats-bar { display: flex; gap: 16px; padding: 20px 32px; background: #1e293b; border-bottom: 1px solid #334155; flex-wrap: wrap; }
  .stat-card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 16px 24px; flex: 1; min-width: 130px; text-align: center; }
  .stat-card .num { font-size: 28px; font-weight: 800; color: #6366f1; }
  .stat-card .lbl { font-size: 12px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

  .main { display: grid; grid-template-columns: 340px 1fr; min-height: calc(100vh - 130px); }

  /* Left panel */
  .left-panel { background: #1e293b; border-right: 1px solid #334155; display: flex; flex-direction: column; overflow: hidden; }
  .panel-header { padding: 16px 20px; border-bottom: 1px solid #334155; font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  .tabs { display: flex; border-bottom: 1px solid #334155; }
  .tab { flex: 1; padding: 12px; text-align: center; font-size: 13px; cursor: pointer; border: none; background: transparent; color: #64748b; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .tab.active { color: #6366f1; border-bottom: 2px solid #6366f1; background: rgba(99,102,241,0.05); }
  .tab:hover { color: #a5b4fc; }
  
  .list-scroll { overflow-y: auto; flex: 1; }
  .contact-item { padding: 14px 20px; border-bottom: 1px solid #1e293b; cursor: pointer; transition: background 0.15s; display: block; text-decoration: none; color: inherit; }
  .contact-item:hover, .contact-item.active { background: rgba(99,102,241,0.1); border-left: 3px solid #6366f1; }
  .contact-item .phone { font-size: 14px; font-weight: 600; color: #e2e8f0; }
  .contact-item .meta { display: flex; gap: 8px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
  .contact-item .time { font-size: 11px; color: #475569; margin-left: auto; }

  .interview-item { padding: 14px 20px; border-bottom: 1px solid #1e293b; }
  .interview-item.upcoming { border-left: 3px solid #22c55e; }
  .interview-item.past { border-left: 3px solid #475569; opacity: 0.7; }
  .interview-item.today { border-left: 3px solid #f59e0b; background: rgba(245,158,11,0.05); }
  .interview-item .iv-time { font-size: 13px; font-weight: 700; color: #fbbf24; }
  .interview-item .iv-phone { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  .interview-item .iv-badges { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-green { background: #15803d; color: #bbf7d0; }
  .badge-gray { background: #374151; color: #9ca3af; }
  .badge-yellow { background: #92400e; color: #fde68a; }

  /* Right panel */
  .right-panel { background: #0f172a; display: flex; flex-direction: column; overflow: hidden; }
  .right-header { padding: 20px 28px; border-bottom: 1px solid #334155; background: #1e293b; display: flex; align-items: center; justify-content: space-between; }
  .right-header h2 { font-size: 18px; font-weight: 700; }
  .right-header .sub { font-size: 13px; color: #64748b; margin-top: 4px; }

  .chat-scroll { flex: 1; overflow-y: auto; padding: 24px 28px; display: flex; flex-direction: column; gap: 12px; }
  .bubble { max-width: 75%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; word-break: break-word; }
  .bubble.user { background: #1e293b; border: 1px solid #334155; align-self: flex-start; border-bottom-left-radius: 4px; }
  .bubble.ai { background: #4f46e5; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
  .bubble-meta { font-size: 11px; color: #475569; margin-bottom: 3px; }
  .bubble-wrap.user { align-self: flex-start; }
  .bubble-wrap.ai { align-self: flex-end; text-align: right; }

  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; color: #475569; font-size: 15px; }
  .empty-state .icon { font-size: 48px; }

  .refresh-btn { background: #4f46e5; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; text-decoration: none; }
  .refresh-btn:hover { background: #4338ca; }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }

  @media (max-width: 768px) {
    .main { grid-template-columns: 1fr; }
    .stats-bar { padding: 16px; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="logo">🚀</div>
  <div>
    <h1>HMorix CRM Dashboard <span class="live-dot"></span></h1>
    <p>WhatsApp Bot · Leads · Interviews · Chat History · Last updated: ${new Date().toLocaleTimeString('en-IN')}</p>
  </div>
  <div style="margin-left:auto">
    <a href="/" class="refresh-btn">🔄 Refresh</a>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-card">
    <div class="num">${stats.totalLeads}</div>
    <div class="lbl">Total Contacts</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#16a34a">${stats.clients}</div>
    <div class="lbl">🏢 Clients</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#0891b2">${stats.candidates}</div>
    <div class="lbl">🎓 Candidates</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#f59e0b">${stats.upcomingInterviews}</div>
    <div class="lbl">📅 Upcoming Interviews</div>
  </div>
  <div class="stat-card">
    <div class="num" style="color:#a78bfa">${stats.interviews}</div>
    <div class="lbl">Total Scheduled</div>
  </div>
</div>

<div class="main">

  <!-- LEFT PANEL -->
  <div class="left-panel">
    <div class="tabs">
      <a href="/?tab=leads${selectedPhone ? '&contact=' + selectedPhone : ''}" class="tab ${(!query.tab || query.tab === 'leads') ? 'active' : ''}">
        👥 Leads <span style="background:#334155;padding:1px 6px;border-radius:8px;font-size:11px">${leads.length}</span>
      </a>
      <a href="/?tab=interviews${selectedPhone ? '&contact=' + selectedPhone : ''}" class="tab ${query.tab === 'interviews' ? 'active' : ''}">
        📅 Meetings <span style="background:#334155;padding:1px 6px;border-radius:8px;font-size:11px">${upcomingInterviews.length}</span>
      </a>
    </div>
    <div class="list-scroll">
      ${query.tab === 'interviews' ? `
        ${upcomingInterviews.length === 0 && pastInterviews.length === 0 ? `
          <div style="padding:40px;text-align:center;color:#475569">No interviews scheduled yet.</div>
        ` : ''}
        ${upcomingInterviews.length > 0 ? `
          <div class="panel-header" style="color:#22c55e">🟢 Upcoming (${upcomingInterviews.length})</div>
          ${upcomingInterviews.map(iv => `
            <div class="interview-item ${iv.isToday ? 'today' : 'upcoming'}">
              <div class="iv-time">${formatDateTime(iv.scheduledTime)}</div>
              <div class="iv-phone">📱 +${iv.phoneNumber}</div>
              ${iv.candidateName !== 'Candidate' ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px">👤 ${iv.candidateName}</div>` : ''}
              ${iv.role !== 'General' ? `<div style="font-size:12px;color:#94a3b8">💼 ${iv.role}</div>` : ''}
              <div class="iv-badges">
                ${iv.isToday ? '<span class="badge badge-yellow">⚡ TODAY</span>' : ''}
                ${iv.reminded2h ? '<span class="badge badge-green">✓ 2h sent</span>' : '<span class="badge badge-gray">2h pending</span>'}
                ${iv.reminded1h ? '<span class="badge badge-green">✓ 1h sent</span>' : '<span class="badge badge-gray">1h pending</span>'}
                ${iv.reminded15m ? '<span class="badge badge-green">✓ 15m sent</span>' : '<span class="badge badge-gray">15m pending</span>'}
              </div>
            </div>
          `).join('')}
        ` : ''}
        ${pastInterviews.length > 0 ? `
          <div class="panel-header" style="margin-top:8px">⬛ Past (${pastInterviews.length})</div>
          ${pastInterviews.map(iv => `
            <div class="interview-item past">
              <div class="iv-time" style="color:#64748b">${formatDateTime(iv.scheduledTime)}</div>
              <div class="iv-phone">📱 +${iv.phoneNumber}</div>
              <div class="iv-badges">
                <span class="badge" style="background:#1e293b;color:#64748b">${iv.status}</span>
                ${iv.reminded2h ? '<span class="badge badge-green">✓ 2h</span>' : ''}
                ${iv.reminded1h ? '<span class="badge badge-green">✓ 1h</span>' : ''}
                ${iv.reminded15m ? '<span class="badge badge-green">✓ 15m</span>' : ''}
              </div>
            </div>
          `).join('')}
        ` : ''}
      ` : `
        ${leads.length === 0 ? `
          <div style="padding:40px;text-align:center;color:#475569">No contacts yet. Messages will appear here.</div>
        ` : ''}
        ${leads.map(lead => `
          <a href="/?contact=${lead.phoneNumber}&tab=leads" class="contact-item ${selectedPhone === lead.phoneNumber ? 'active' : ''}">
            <div class="phone">+${lead.phoneNumber}</div>
            <div class="meta">
              ${agentBadge(lead.activeAgent)}
              ${leadTypeBadge(lead.leadType)}
              <span class="time">${timeAgo(lead.updatedAt)}</span>
            </div>
            ${lead.summary ? `<div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.4">${lead.summary.slice(0, 80)}${lead.summary.length > 80 ? '...' : ''}</div>` : ''}
          </a>
        `).join('')}
      `}
    </div>
  </div>

  <!-- RIGHT PANEL -->
  <div class="right-panel">
    ${selectedLead ? `
      <div class="right-header">
        <div>
          <h2>+${selectedLead.phoneNumber}</h2>
          <div class="sub" style="display:flex;gap:8px;margin-top:6px">
            ${agentBadge(selectedLead.activeAgent)}
            ${leadTypeBadge(selectedLead.leadType)}
            <span style="font-size:12px;color:#475569">Last active: ${timeAgo(selectedLead.updatedAt)}</span>
          </div>
          ${selectedLead.summary ? `<div style="font-size:13px;color:#94a3b8;margin-top:8px;max-width:600px">${selectedLead.summary}</div>` : ''}
        </div>
      </div>
      <div class="chat-scroll">
        ${chatHistory.length === 0 ? `<div class="empty-state"><div class="icon">💬</div><div>No messages found for this contact.</div></div>` : ''}
        ${chatHistory.map(msg => {
            const isUser = msg.role === 'USER' || msg.role === 'user';
            const ts = msg.timestamp ? formatDateTime(msg.timestamp) : '';
            return `
              <div class="bubble-wrap ${isUser ? 'user' : 'ai'}">
                <div class="bubble-meta">${isUser ? '👤 User' : '🤖 Bot'} ${ts ? '· ' + ts : ''}</div>
                <div class="bubble ${isUser ? 'user' : 'ai'}">${(msg.message || msg.content || '').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>
              </div>
            `;
        }).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <div class="icon">👈</div>
        <div>Select a contact to view chat history</div>
        <div style="font-size:13px">All WhatsApp conversations stored here</div>
      </div>
    `}
  </div>
</div>

<script>
  // Auto-refresh every 30 seconds
  setTimeout(() => location.reload(), 30000);
  // Scroll chat to bottom
  const chat = document.querySelector('.chat-scroll');
  if (chat) chat.scrollTop = chat.scrollHeight;
</script>
</body>
</html>`;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const query = Object.fromEntries(url.searchParams.entries());

        if (url.pathname === '/api/leads') {
            const leads = await getAllLeads();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(leads));
        }

        if (url.pathname === '/api/interviews') {
            const interviews = await getAllInterviews();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(interviews));
        }

        if (url.pathname === '/api/chat' && query.phone) {
            const history = await getChatHistory(query.phone, 50);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(history));
        }

        const html = await renderDashboard(query);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);

    } catch (err) {
        console.error('Dashboard error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Dashboard error: ' + err.message);
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n📊 HMorix CRM Dashboard');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    await connectDB(process.env.MONGODB_URI);
    server.listen(PORT, () => {
        console.log(`✅ Dashboard running at http://localhost:${PORT}`);
        console.log(`   Open in your browser to see all leads, meetings & chats.\n`);
    });
}

main().catch(err => {
    console.error('❌ Fatal:', err);
    process.exit(1);
});
