// index.js (using wppconnect)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

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

let clientInstance = null;
let lastQrCode = null;
let isConnected = false;

// Django API endpoints
const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';
const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';

const wppconnect = require('@wppconnect-team/wppconnect');

// Start WhatsApp session
wppconnect.create({
  session: 'wp-session',
  headless: true,
  useChrome: true // يجبر wppconnect يستخدم Google Chrome إذا متاح
})
.then(client => {
  clientInstance = client;
  isConnected = true;

  console.log("✅ WhatsApp client ready");

  // Handle QR Code
  client.on('qrCode', async (qrCode) => {
    console.log("📲 QR Code received");
    lastQrCode = await QRCode.toDataURL(qrCode);
  });

  // Handle messages
  client.onMessage(async (message) => {
    if (message.fromMe) return;
    try {
      await axios.post(DJANGO_API_URL, {
        sender_number: message.from,
        message_body: message.body || message.type
      });
      console.log("📩 Message forwarded to Django:", message.body);
    } catch (err) {
      console.error("❌ Error sending to Django:", err.message);
    }
  });

  // Sync contacts periodically
  setInterval(async () => {
    try {
      const contacts = await client.getAllContacts();
      const syncData = contacts.map(c => ({
        number: c.id.user,
        direction: 'sync'
      }));
      if (syncData.length > 0) {
        await axios.post(DJANGO_SYNC_CONTACTS_URL, syncData);
        console.log(`🔄 Synced ${syncData.length} contacts`);
      }
    } catch (err) {
      console.error("❌ Sync error:", err.message);
    }
  }, 2 * 60 * 1000);

})
.catch(err => console.error("❌ Init error:", err));

// API Endpoints
app.get('/whatsapp-status', (req, res) => {
  res.json({
    connected: isConnected,
    qrCodeUrl: lastQrCode
  });
});
// Relance paiement
const sendRelancePayer = async () => {
    try {
        const resp = await axios.get('https://ts.travel4you.ma/paiement-tours/clients-a-relancer/');
        for (const c of resp.data) {
            const num = c.client_phone.replace(/\D/g, '');
            const msg = `Bonjour ${c.client_name}, il vous reste ${c.balance_remaining} MAD à payer pour les services : ${c.tour_title}. Merci de régulariser votre situation.`;
            try {
                await clientInstance.sendText(`${num}@c.us`, msg);
                console.log(`✅ Message envoyé à ${num}`);
            } catch (e) {
                console.error(`❌ Erreur envoi ${num}:`, e.message);
            }
        }
    } catch (err) {
        console.error('❌ Erreur récupération paiement:', err.message);
    }
};

app.get('/send-relance-payer', (req, res) => {
    sendRelancePayer();
    res.json({ status: 'Relances paiement envoyées' });
});

// Relance pub
app.post('/relance-pub', async (req, res) => {
    const { message, contacts } = req.body;
    if (!message?.trim() || !Array.isArray(contacts) || contacts.length === 0)
        return res.status(400).json({ message: 'Message et contacts requis' });

    let sent = [], failed = [];
    for (let n of contacts) {
        let phone = n.replace(/\D/g, '');
        if (!phone.endsWith('@c.us')) phone += '@c.us';
        try {
            await clientInstance.sendText(phone, message);
            sent.push(n);
            console.log(`✅ Message envoyé à ${n}`);
        } catch (e) {
            failed.push(n);
            console.error(`❌ Échec envoi à ${n}:`, e.message);
        }
    }
    res.json({ message: 'Relance terminée', sentCount: sent.length, failedCount: failed.length, sent, failed });
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
