// index.js (FULL - Clean project)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const rimraf = require('rimraf');

const app = express();
const PORT = process.env.PORT || 8080;
const qrcodeTerminal = require('qrcode-terminal');
const allowedOrigins = [
    "https://ts.travel4you.ma",
    "https://backoff.travel4you.ma"

  ];
  
  app.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }));
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// State flags
let isConnected = false;
let isClientReady = false;
let isAuthenticated = false;
let lastQrCode = null;
let connectionTimeout = null;
let syncInterval = null;
let authRecoveryTriggered = false;

// ---- Client with pinned webVersion + remote cache ----
// Change webVersion to a version that works for you if needed.
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/data/.wwebjs_auth' }),
  webVersion: '2.2412.54',
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    strict: false
  },
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium-browser', // nécessaire pour Docker
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});


// Helpers
async function safeDestroy() {
  try {
    client.removeAllListeners();
    await client.destroy();
  } catch (e) {
    console.warn('Destroy error (retrying):', e.message);
    await new Promise(r => setTimeout(r, 2000));
    try {
      client.removeAllListeners();
      await client.destroy();
    } catch (err) {
      console.error('Destroy final failed:', err.message);
    }
  }
}

function resetFlags() {
  isConnected = false;
  isClientReady = false;
  isAuthenticated = false;
  lastQrCode = null;
  authRecoveryTriggered = false;
  if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// Single READY handler (sync + process unread)
async function handleReady() {
  console.log('✅ Client ready.');
  isConnected = true;
  isClientReady = true;
  isAuthenticated = true;
  lastQrCode = null;
  if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
  authRecoveryTriggered = false;

  // Manage sync interval safely
  if (syncInterval) clearInterval(syncInterval);
  await syncAllContacts();
  syncInterval = setInterval(syncAllContacts, 2 * 60 * 1000);

  // Process unread messages once
  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (chat.unreadCount > 0) {
        const messages = await chat.fetchMessages({ limit: chat.unreadCount });
        for (const m of messages) await processMessageAndSendToDjango(m);
        await chat.sendSeen();
      }
    }
  } catch (err) {
    console.error('Error processing unread:', err.message);
  }
}

// Events
client.on('qr', qr => {
  console.log('QR received.');
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toDataURL(qr, (err, url) => {
    lastQrCode = err ? null : url;
    isConnected = false;
    isAuthenticated = false;
  });
});

client.on('authenticated', () => {
  console.log('🔐 Authenticated, waiting for ready...');
  isAuthenticated = true;
  authRecoveryTriggered = false;

  // single recovery attempt after 60s
  if (connectionTimeout) clearTimeout(connectionTimeout);
  connectionTimeout = setTimeout(async () => {
    if (!isClientReady && !authRecoveryTriggered) {
      authRecoveryTriggered = true;
      // check client state
      let state = null;
      try { state = await client.getState(); } catch (e) { state = null; }
      console.warn('Ready missing after 60s; client.getState():', state);

      if (state === 'CONNECTED') {
        // Soft recovery: attempt to run the ready handler logic without destroying session
        console.log('Soft recovery: calling handleReady() to continue without destroying session.');
        try { await handleReady(); }
        catch (e) { console.error('Soft recovery failed:', e.message); }
      } else {
        // Hard recovery: destroy & re-initialize
        console.log('Hard recovery: destroying client and re-initializing.');
        await safeDestroy();
        setTimeout(() => client.initialize(), 2000);
      }
    }
  }, 60000);
});

client.on('ready', handleReady);

client.on('auth_failure', msg => {
  console.error('Auth failure:', msg);
  resetFlags();
});
app.post('/whatsapp-disconnect', async (req, res) => {
    try {
      await safeDestroy();
      resetFlags();
      res.json({ status: 'disconnected' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
});
client.on('disconnected', reason => {
  console.log('Disconnected:', reason);
  resetFlags();
  // re-initialize once
  setTimeout(() => client.initialize(), 5000);
});

// Basic endpoints
app.get('/whatsapp-status', (req, res) => res.json({
    connected: isConnected,
    authenticated: isAuthenticated,
    ready: isClientReady,
    qrCodeUrl: lastQrCode   
  }));

app.get('/whatsapp-diagnose', async (req, res) => {
  try {
    const clientState = await client.getState();
    res.json({ isConnected, isAuthenticated, isClientReady, lastQrCode: !!lastQrCode, clientState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/whatsapp-clear-session', async (req, res) => {
  try {
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) { rimraf.sync(sessionPath); }
    await safeDestroy();
    resetFlags();
    setTimeout(() => client.initialize(), 2000);
    res.json({ status: 'session cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- message forwarding to Django (example) ---
const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';
async function processMessageAndSendToDjango(msg) {
  if (msg.fromMe) return;
  const body = msg.hasMedia ? (msg.type || 'media') : (msg.body || '').trim();
  if (!body) return;
  try {
    await axios.post(DJANGO_API_URL, { sender_number: msg.from, message_body: body });
  } catch (err) {
    console.error('Django send error:', err.message);
  }
}
client.on('message', processMessageAndSendToDjango);

// --- Sync contacts (example) ---
const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';
async function syncAllContacts() {
  console.log('Sync contacts...');
  try {
    const chats = await client.getChats();
    const contacts = chats.filter(c => !c.isGroup).map(c => ({ number: c.id.user, direction: 'sync' }));
    if (contacts.length) await axios.post(DJANGO_SYNC_CONTACTS_URL, contacts);
    console.log('Contacts synced:', contacts.length);
  } catch (err) {
    console.error('Sync error:', err.message);
  }
}

// Start
client.initialize();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

