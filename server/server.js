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

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

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

// Browser SSE connections
const sseClients = new Set();

function sseEmit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// GET /api/events — SSE stream for browser UIs
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

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
  sseEmit('photo', { filename: req.file.filename, url: `/photos/${req.file.filename}` });

  const captureId = req.body?.captureId;
  const p = captureId && pending.get(captureId);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(captureId);
    p.resolve(req.file.path);
  }

  res.json({ ok: true, filename: req.file.filename });
});

// GET /api/photos — list saved photos, newest first
app.get('/api/photos', (_req, res) => {
  const files = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .reverse()
    .map((f) => ({ filename: f, url: `/photos/${f}` }));
  res.json(files);
});

app.use('/photos', express.static(PHOTOS_DIR));
app.get('/', (_req, res) => res.send(UI_HTML));

const UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Remote Camera</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e8e8e8; min-height: 100vh; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 1.25rem 1.5rem; border-bottom: 1px solid #2a2a2a; }
    h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
    #status { font-size: 0.75rem; color: #888; }
    .shutter-wrap { display: flex; justify-content: center; padding: 2.5rem 0 1rem; }
    .shutter { width: 100px; height: 100px; border-radius: 50%; background: #fff; border: 5px solid #444; cursor: pointer; font-size: 2.75rem; display: flex; align-items: center; justify-content: center; transition: transform 0.1s, background 0.1s; user-select: none; }
    .shutter:active { transform: scale(0.92); background: #ddd; }
    .shutter:disabled { opacity: 0.4; cursor: default; transform: none; }
    #feedback { text-align: center; min-height: 1.5rem; font-size: 0.8rem; color: #4ade80; padding: 0.5rem; }
    #preview { display: none; margin: 0 auto 1.5rem; max-width: 420px; padding: 0 1.5rem; }
    #preview img { width: 100%; border-radius: 10px; }
    h2 { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #666; padding: 1.25rem 1.5rem 0.75rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; padding: 0 1.5rem 2rem; }
    .card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 8px; cursor: pointer; background: #1c1c1c; }
    .card p { font-size: 0.6rem; color: #555; margin-top: 4px; text-align: center; }
    .empty { padding: 2rem 1.5rem; color: #555; font-size: 0.85rem; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>📷 Remote Camera</h1>
    <span id="status">0 photos</span>
  </header>
  <div class="shutter-wrap">
    <button class="shutter" id="btn" onclick="capture()" title="Take photo">📸</button>
  </div>
  <div id="feedback"></div>
  <div id="preview"><img id="preview-img" src=""></div>
  <h2>Saved Photos</h2>
  <div class="grid" id="grid"></div>
  <script>
    const btn = document.getElementById('btn');

    async function capture() {
      btn.disabled = true;
      feedback('Waiting for photo…');
      document.getElementById('preview').style.display = 'none';

      const r = await fetch('/api/capture', { method: 'POST' });

      if (r.ok) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        document.getElementById('preview-img').src = url;
        document.getElementById('preview').style.display = 'block';
        feedback('Got it!');
        loadPhotos();
      } else {
        const j = await r.json().catch(() => ({}));
        feedback(j.error ?? 'Error ' + r.status);
      }

      btn.disabled = false;
    }

    function feedback(msg) {
      const el = document.getElementById('feedback');
      el.textContent = msg;
    }

    async function loadPhotos() {
      const photos = await fetch('/api/photos').then(r => r.json());
      document.getElementById('status').textContent = photos.length + ' photo' + (photos.length !== 1 ? 's' : '');
      const grid = document.getElementById('grid');
      if (!photos.length) {
        grid.innerHTML = '<p class="empty">No photos yet — press the button above or<br><code>curl -X POST http://localhost:3000/api/capture --output photo.jpg</code></p>';
        return;
      }
      grid.innerHTML = photos.slice(0, 48).map(p => {
        const label = p.filename.replace('photo-', '').replace('.jpg', '').replace(/-/g, ' ');
        return '<div class="card"><img src="' + p.url + '" loading="lazy" onclick="window.open(this.src)"><p>' + label + '</p></div>';
      }).join('');
    }

    loadPhotos();

    // Live updates — reload gallery the moment a photo arrives
    const es = new EventSource('/api/events');
    es.addEventListener('photo', () => loadPhotos());
  </script>
</body>
</html>`;

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  const localIP = Object.values(ifaces).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';

  console.log(`\nRemote Camera Server`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}  ← use this in the iOS app`);
  console.log(`  Capture:  POST http://${localIP}:${PORT}/api/capture  → returns JPEG`);
  console.log(`  Photos:   ${PHOTOS_DIR}\n`);
});
