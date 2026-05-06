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

app.use(express.json());

const clients = new Set();
const sseClients = new Set();

let latestAnalysis = null;

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// captureId -> { resolve, reject, timer }
const pending = new Map();

function sseEmit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// GET / — frontend
app.get('/', (_req, res) => res.send(UI_HTML));

// GET /api/events — SSE stream for live updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  if (latestAnalysis) res.write(`event: analysis\ndata: ${JSON.stringify(latestAnalysis)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// GET /api/analysis — latest Gemini result
app.get('/api/analysis', (_req, res) => {
  res.json(latestAnalysis ?? { text: null });
});

// POST /api/analysis — called by main.py after Gemini responds
app.post('/api/analysis', (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  latestAnalysis = { text, imageUrl: imageUrl ?? null, timestamp: new Date().toISOString() };
  console.log(`[Analysis] Received ${text.length} chars`);
  sseEmit('analysis', latestAnalysis);
  res.json({ ok: true });
});

// GET /api/latest-photo — serves most recent saved photo
app.get('/api/latest-photo', (_req, res) => {
  const files = fs.readdirSync(PHOTOS_DIR).filter(f => f.endsWith('.jpg')).sort();
  if (!files.length) return res.status(404).json({ error: 'No photos yet' });
  res.sendFile(path.join(PHOTOS_DIR, files[files.length - 1]));
});

app.use('/photos', express.static(PHOTOS_DIR));

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

// POST /api/photo — iOS app delivers captured photo
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

const UI_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ella Cheating</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #e8e8e8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    header {
      width: 100%;
      padding: 1.5rem 2rem;
      border-bottom: 1px solid #1e1e1e;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    h1 { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; color: #fff; }

    #status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #333;
      display: inline-block;
      margin-right: 6px;
      transition: background 0.3s;
    }
    #status-dot.live { background: #4ade80; box-shadow: 0 0 6px #4ade80; }

    #status-label { font-size: 0.72rem; color: #555; }

    main {
      width: 100%;
      max-width: 900px;
      padding: 2rem 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .card {
      background: #111;
      border: 1px solid #1e1e1e;
      border-radius: 14px;
      overflow: hidden;
    }

    .card-label {
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #444;
      padding: 0.9rem 1.2rem 0.6rem;
    }

    #photo-wrap {
      position: relative;
      background: #0d0d0d;
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #photo {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: none;
    }

    #photo-placeholder {
      color: #2a2a2a;
      font-size: 0.8rem;
      text-align: center;
    }

    #timestamp {
      font-size: 0.65rem;
      color: #333;
      padding: 0.6rem 1.2rem 0.9rem;
      text-align: right;
    }

    #analysis-wrap { padding: 1.2rem; min-height: 120px; }

    #analysis-text {
      font-size: 0.95rem;
      line-height: 1.7;
      color: #ccc;
      white-space: pre-wrap;
    }

    #analysis-text.empty { color: #333; font-style: italic; }

    .pulse {
      animation: pulse 1s ease-out;
    }

    @keyframes pulse {
      0%   { opacity: 0.4; }
      100% { opacity: 1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Ella Cheating</h1>
    <span><span id="status-dot"></span><span id="status-label">waiting...</span></span>
  </header>
  <main>
    <div class="card">
      <div class="card-label">Latest capture</div>
      <div id="photo-wrap">
        <img id="photo" alt="Latest capture">
        <div id="photo-placeholder">No image yet</div>
      </div>
      <div id="timestamp"></div>
    </div>
    <div class="card">
      <div class="card-label">AI analysis</div>
      <div id="analysis-wrap">
        <div id="analysis-text" class="empty">Waiting for analysis...</div>
      </div>
    </div>
  </main>

  <script>
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    const photo = document.getElementById('photo');
    const placeholder = document.getElementById('photo-placeholder');
    const analysisEl = document.getElementById('analysis-text');
    const tsEl = document.getElementById('timestamp');

    function applyAnalysis(data) {
      if (!data || !data.text) return;

      analysisEl.textContent = data.text;
      analysisEl.classList.remove('empty');
      analysisEl.classList.remove('pulse');
      void analysisEl.offsetWidth;
      analysisEl.classList.add('pulse');

      if (data.imageUrl) {
        photo.src = data.imageUrl + '?t=' + Date.now();
      } else {
        photo.src = '/api/latest-photo?t=' + Date.now();
      }
      photo.style.display = 'block';
      placeholder.style.display = 'none';

      if (data.timestamp) {
        const d = new Date(data.timestamp);
        tsEl.textContent = d.toLocaleTimeString();
      }

      dot.classList.add('live');
      label.textContent = 'live';
    }

    const es = new EventSource('/api/events');
    es.addEventListener('analysis', e => applyAnalysis(JSON.parse(e.data)));
    es.onopen = () => { dot.classList.add('live'); label.textContent = 'connected'; };
    es.onerror = () => { dot.classList.remove('live'); label.textContent = 'reconnecting...'; };
  </script>
</body>
</html>`;

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  const localIP = Object.values(ifaces).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';

  console.log(`\nRemote Camera Server`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}`);
  console.log(`  Capture:  POST http://${localIP}:${PORT}/api/capture`);
  console.log(`  Photos:   ${PHOTOS_DIR}\n`);
});
