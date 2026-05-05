const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const http = require('http');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const CAPTURE_TIMEOUT_MS = 30_000;
const PHOTOS_DIR = path.join(__dirname, 'photos');
const LIVE_IMG = path.join(__dirname, '..', 'web-server', 'img', 'img.jpeg');

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LIVE_IMG), { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// captureId -> { resolve, reject, timer }
const pending = new Map();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Device connected  (${clients.size} total)`);
  ws.send(JSON.stringify({ action: 'connected' }));
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Device disconnected  (${clients.size} remaining)`);
  });
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === 1) { ws.send(msg); sent++; }
  }
  return sent;
}

const storage = multer.diskStorage({
  destination: PHOTOS_DIR,
  filename: (_req, _file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `photo-${ts}.jpg`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/capture
// Triggers the iOS device, waits up to 30s, returns the JPEG directly.
// curl -X POST http://server:3000/api/capture --output photo.jpg
app.post('/api/capture', async (_req, res) => {
  if (clients.size === 0) {
    return res.status(503).json({ error: 'No devices connected' });
  }

  const captureId = randomUUID();

  const filePath = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(captureId);
      reject(new Error('Timeout — no photo received within 30s'));
    }, CAPTURE_TIMEOUT_MS);

    pending.set(captureId, { resolve, reject, timer });
    broadcast({ action: 'capture', captureId });
    console.log(`[Capture] ${captureId} — triggered ${clients.size} device(s)`);
  }).catch((err) => {
    console.error(`[Capture] ${captureId} — ${err.message}`);
    return null;
  });

  if (!filePath) {
    return res.status(504).json({ error: 'Timeout — device did not respond in time' });
  }

  console.log(`[Capture] ${captureId} — returning photo`);
  res.sendFile(filePath);
});

// POST /api/photo
// Called by the iOS app to deliver a captured photo.
// If the upload carries a captureId it resolves the waiting /api/capture request.
app.post('/api/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo in request' });

  console.log(`[Photo] Saved ${req.file.filename}  (${Math.round(req.file.size / 1024)} KB)`);
  fs.copyFileSync(req.file.path, LIVE_IMG);

  const captureId = req.body?.captureId;
  const p = captureId && pending.get(captureId);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(captureId);
    p.resolve(req.file.path);
  }

  res.json({ ok: true, filename: req.file.filename });
});


server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  const localIP = Object.values(ifaces).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';

  console.log(`\nRemote Camera Server`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}  ← use this in the iOS app`);
  console.log(`  Capture:  POST http://${localIP}:${PORT}/api/capture  → returns JPEG`);
  console.log(`  Photos:   ${PHOTOS_DIR}\n`);
});
