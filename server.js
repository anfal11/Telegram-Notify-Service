require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // optional shared-secret check
const MAX_STORED_EVENTS = 1000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Simple JSON file storage (no native deps, easy Docker builds) ----------
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'events.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ events: [], nextId: 1 }, null, 2));

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return { events: [], nextId: 1 };
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function insertEvent({ source_ip, method, path: reqPath, headers, body }) {
  const db = readDb();
  const event = {
    id: db.nextId,
    source_ip,
    method,
    path: reqPath,
    headers,
    body,
    telegram_sent: 0,
    created_at: new Date().toISOString()
  };
  db.events.unshift(event);
  if (db.events.length > MAX_STORED_EVENTS) db.events = db.events.slice(0, MAX_STORED_EVENTS);
  db.nextId += 1;
  writeDb(db);
  return event.id;
}

function markTelegramSent(id) {
  const db = readDb();
  const ev = db.events.find(e => e.id === id);
  if (ev) ev.telegram_sent = 1;
  writeDb(db);
}

function listEvents(limit) {
  const db = readDb();
  return db.events.slice(0, limit);
}

// ---------- Telegram helper ----------
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[telegram] BOT_TOKEN or CHAT_ID missing, skipping notification');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML'
    });
    return true;
  } catch (err) {
    console.error('[telegram] send failed:', err.response?.data || err.message);
    return false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Health check ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------- Webhook endpoint (Zain server hits this) ----------
// Example: POST https://registry.red-cube.co.uk/zain-notify/webhook
app.post('/webhook', async (req, res) => {
  const sourceIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid secret' });
    }
  }

  const bodyStr = JSON.stringify(req.body || {});
  const headersStr = JSON.stringify(req.headers || {});

  const eventId = insertEvent({
    source_ip: sourceIp,
    method: req.method,
    path: req.originalUrl,
    headers: headersStr,
    body: bodyStr
  });

  const msg =
    `<b>🔔 New event from Zain server</b>\n` +
    `<b>IP:</b> ${sourceIp}\n` +
    `<b>Path:</b> ${req.originalUrl}\n` +
    `<b>Time:</b> ${new Date().toISOString()}\n` +
    `<b>Body:</b>\n<code>${escapeHtml(bodyStr).slice(0, 1000)}</code>`;

  const sent = await sendTelegramMessage(msg);
  if (sent) markTelegramSent(eventId);

  res.json({ ok: true, id: eventId, telegram_sent: sent });
});

// Generic catch-all in case Zain calls a slightly different sub-path
app.all('/webhook/*', async (req, res) => {
  const sourceIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const bodyStr = JSON.stringify(req.body || {});
  const headersStr = JSON.stringify(req.headers || {});

  const eventId = insertEvent({
    source_ip: sourceIp,
    method: req.method,
    path: req.originalUrl,
    headers: headersStr,
    body: bodyStr
  });

  const msg =
    `<b>🔔 New event (${req.method})</b>\n` +
    `<b>Path:</b> ${req.originalUrl}\n` +
    `<b>IP:</b> ${sourceIp}\n` +
    `<b>Body:</b>\n<code>${escapeHtml(bodyStr).slice(0, 1000)}</code>`;

  const sent = await sendTelegramMessage(msg);
  if (sent) markTelegramSent(eventId);

  res.json({ ok: true, id: eventId, telegram_sent: sent });
});

// ---------- API for dashboard ----------
app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_STORED_EVENTS);
  res.json(listEvents(limit));
});

app.post('/api/test-telegram', async (req, res) => {
  const sent = await sendTelegramMessage('✅ Test notification from zain-notify-service');
  res.json({ sent });
});

// ---------- Serve frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`zain-notify-service listening on port ${PORT}`);
});
