#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════
#   HMorix WhatsApp Bot — Termux Startup Script
#   Schedule: Runs until 11:00 PM then auto-stops
#   Usage: bash start.sh
# ═══════════════════════════════════════════════════════

# Go to bot directory (same folder as this script)
cd "$(dirname "$0")"

# ── Check if it's already past 11 PM ─────────────────
CURRENT_HOUR=$(date +%H)
if [ "$CURRENT_HOUR" -ge 23 ]; then
    echo ""
    echo "⚠️  ════════════════════════════════════════════════"
    echo "   WARNING: It is past 11:00 PM!"
    echo "   Bot will start but please stop it before sleep."
    echo "   Press Ctrl+C anytime to safely stop the bot."
    echo "   ════════════════════════════════════════════════"
    echo ""
    sleep 3
fi

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║    🚀  HMorix Multi-Agent WhatsApp System         ║"
echo "║    ⏰  Schedule: Now → 11:00 PM (auto-stop)       ║"
echo "║    🛡️   Anti-Ban Night Rest: 11 PM → Morning      ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# Calculate and display hours until shutdown
SHUTDOWN_HOUR=23
CURRENT_MIN=$(date +%M)
HOURS_LEFT=$(( SHUTDOWN_HOUR - CURRENT_HOUR - 1 ))
MINS_LEFT=$(( 60 - 10#$CURRENT_MIN ))
if [ "$MINS_LEFT" -eq 60 ]; then
    MINS_LEFT=0
    HOURS_LEFT=$(( HOURS_LEFT + 1 ))
fi
echo "⏳ Uptime today: ~${HOURS_LEFT}h ${MINS_LEFT}m until 11:00 PM auto-shutdown"
echo ""

# ── Step 1: Acquire Wake Lock ─────────────────────────
echo "🔒 Step 1/3 — Acquiring Termux wake lock..."
echo "   (Prevents Android from cutting network overnight)"

if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock
    echo "   ✅ Wake lock acquired! Check notification bar 🔔"
else
    echo "   ⚠️  termux-wake-lock not found. Install with:"
    echo "       pkg install termux-api"
    echo "   ⚠️  Continuing WITHOUT wake lock — network may drop!"
fi

sleep 1

# ── Step 2: Start Dashboard in Background ────────────
echo ""
echo "📊 Step 2/3 — Starting Dashboard server..."

# Kill any old dashboard instance
OLD_DASHBOARD=$(lsof -ti:3000 2>/dev/null)
if [ -n "$OLD_DASHBOARD" ]; then
    echo "   ⚡ Restarting old dashboard (PID: $OLD_DASHBOARD)..."
    kill -9 $OLD_DASHBOARD 2>/dev/null
    sleep 1
fi

# Start dashboard in background, logs go to dashboard.log
node dashboard.js >> dashboard.log 2>&1 &
DASHBOARD_PID=$!

sleep 2

if kill -0 $DASHBOARD_PID 2>/dev/null; then
    echo "   ✅ Dashboard running! (PID: $DASHBOARD_PID)"
    echo "   🌐 Open: http://localhost:3000"
    echo "   📄 Logs: tail -f dashboard.log"
else
    echo "   ⚠️  Dashboard failed. Check: cat dashboard.log"
fi

sleep 1

# ── Step 3: Start WhatsApp Bot ────────────────────────
echo ""
echo "🤖 Step 3/3 — Starting WhatsApp Bot..."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📌  QR CODE INFO:"
echo "  • Session exists  → Auto-connects, NO QR needed ✅"
echo "  • First time      → Scan QR within 30 seconds 📱"
echo "  • After scan once → Never need to scan again ♾️"
echo ""
echo "  🌙  NIGHT MODE:"
echo "  • Bot warns you at 10:55 PM"
echo "  • Bot auto-stops at 11:00 PM exactly"
echo "  • Session stays saved — no re-scan tomorrow"
echo "  • Restart any time morning with: bash start.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Cleanup: runs when Ctrl+C pressed OR bot exits at 11 PM
cleanup() {
    echo ""
    echo "🛑 Shutting down HMorix System..."

    # Stop dashboard
    if kill -0 $DASHBOARD_PID 2>/dev/null; then
        kill $DASHBOARD_PID 2>/dev/null
        echo "   ✅ Dashboard stopped."
    fi

    # Release wake lock
    if command -v termux-wake-unlock &> /dev/null; then
        termux-wake-unlock
        echo "   ✅ Wake lock released."
    fi

    echo ""
    echo "   💾 Session saved — restart with: bash start.sh"
    echo "   🌙 Good night! Bot will be ready again tomorrow."
    echo ""
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start bot in FOREGROUND (QR shows in this terminal)
node index-baileys.js

# Bot exited (11 PM shutdown or crash) — clean up
cleanup
