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
const FRONTEND_PIN = process.env.FRONTEND_PIN || null;

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LIVE_IMG), { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());

const clients = new Set();
const sseClients = new Set();
const validTokens = new Set();

let latestAnalysis = null;

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const pending = new Map();

function sseEmit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function getToken(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map(c => c.trim()).find(c => c.startsWith('auth='))?.slice(5);
}

function checkAuth(req, res, next) {
  if (!FRONTEND_PIN) return next();
  const token = getToken(req);
  if (token && validTokens.has(token)) return next();
  res.send(PIN_HTML);
}

// POST /auth — PIN check
app.post('/auth', (req, res) => {
  if (!FRONTEND_PIN || req.body.pin === FRONTEND_PIN) {
    const token = randomUUID();
    validTokens.add(token);
    res.setHeader('Set-Cookie', `auth=${token}; Path=/; HttpOnly; SameSite=Strict`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong PIN' });
  }
});

// GET / — frontend (PIN-gated)
app.get('/', checkAuth, (_req, res) => res.send(UI_HTML));

// GET /api/events — SSE (PIN-gated)
app.get('/api/events', checkAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  if (latestAnalysis) res.write(`event: analysis\ndata: ${JSON.stringify(latestAnalysis)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// GET /api/analysis
app.get('/api/analysis', (_req, res) => res.json(latestAnalysis ?? { text: null }));

// POST /api/analysis — called by main.py
app.post('/api/analysis', (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  latestAnalysis = { text, imageUrl: imageUrl ?? null, timestamp: new Date().toISOString() };
  console.log(`[Analysis] Received ${text.length} chars`);
  sseEmit('analysis', latestAnalysis);
  res.json({ ok: true });
});

// GET /api/latest-photo
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
  if (clients.size === 0) return res.status(503).json({ error: 'No devices connected' });

  const captureId = randomUUID();

  const filePath = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(captureId);
      reject(new Error('Timeout'));
    }, CAPTURE_TIMEOUT_MS);
    pending.set(captureId, { resolve, reject, timer });
    broadcast({ action: 'capture', captureId });
    console.log(`[Capture] ${captureId} — triggered ${clients.size} device(s)`);
  }).catch((err) => {
    console.error(`[Capture] ${captureId} — ${err.message}`);
    return null;
  });

  if (!filePath) return res.status(504).json({ error: 'Timeout — device did not respond in time' });

  console.log(`[Capture] ${captureId} — returning photo`);
  res.sendFile(filePath);
});

// POST /api/photo — iOS app delivers photo
app.post('/api/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo in request' });

  const filename = req.file.filename;
  console.log(`[Photo] Saved ${filename}  (${Math.round(req.file.size / 1024)} KB)`);

  // delete all previous photos, keep only this one
  fs.readdirSync(PHOTOS_DIR)
    .filter(f => f.endsWith('.jpg') && f !== filename)
    .forEach(f => fs.unlink(path.join(PHOTOS_DIR, f), () => {}));

  fs.copyFileSync(req.file.path, LIVE_IMG);

  // push photo to frontend immediately
  sseEmit('photo', { url: `/photos/${filename}`, timestamp: new Date().toISOString() });

  const captureId = req.body?.captureId;
  const p = captureId && pending.get(captureId);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(captureId);
    p.resolve(req.file.path);
  }

  res.json({ ok: true, filename });
});

const PIN_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enter PIN</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a; color: #e8e8e8;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .box {
      background: #111; border: 1px solid #1e1e1e; border-radius: 16px;
      padding: 2.5rem 2rem; width: 100%; max-width: 320px; text-align: center;
    }
    h1 { font-size: 1rem; font-weight: 600; margin-bottom: 1.5rem; color: #fff; }
    input {
      width: 100%; padding: 0.75rem 1rem; background: #0d0d0d;
      border: 1px solid #2a2a2a; border-radius: 8px; color: #fff;
      font-size: 1.1rem; text-align: center; letter-spacing: 0.2em;
      outline: none; margin-bottom: 1rem;
    }
    input:focus { border-color: #444; }
    button {
      width: 100%; padding: 0.75rem; background: #fff; color: #000;
      border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600;
      cursor: pointer;
    }
    button:active { opacity: 0.8; }
    #err { color: #f87171; font-size: 0.8rem; margin-top: 0.75rem; min-height: 1.2em; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Enter PIN</h1>
    <input type="password" id="pin" placeholder="••••" maxlength="20" autofocus>
    <button onclick="submit()">Unlock</button>
    <div id="err"></div>
  </div>
  <script>
    document.getElementById('pin').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    async function submit() {
      const pin = document.getElementById('pin').value;
      const r = await fetch('/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      if (r.ok) { location.reload(); }
      else { document.getElementById('err').textContent = 'Incorrect PIN'; }
    }
  </script>
</body>
</html>`;

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
      background: #0a0a0a; color: #e8e8e8;
      min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    }
    header {
      width: 100%; padding: 1.5rem 2rem; border-bottom: 1px solid #1e1e1e;
      display: flex; align-items: center; justify-content: space-between;
    }
    h1 { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; color: #fff; }
    #status-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #333;
      display: inline-block; margin-right: 6px; transition: background 0.3s;
    }
    #status-dot.live { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
    #status-label { font-size: 0.72rem; color: #555; }
    main { width: 100%; max-width: 900px; padding: 2rem 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
    .card { background: #111; border: 1px solid #1e1e1e; border-radius: 14px; overflow: hidden; }
    .card-label {
      font-size: 0.65rem; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: #444; padding: 0.9rem 1.2rem 0.6rem;
    }
    #photo-wrap {
      position: relative; background: #0d0d0d;
      aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center;
    }
    #photo { width: 100%; height: 100%; object-fit: contain; display: none; }
    #photo-placeholder { color: #2a2a2a; font-size: 0.8rem; }
    #timestamp { font-size: 0.65rem; color: #333; padding: 0.6rem 1.2rem 0.9rem; text-align: right; }
    #analysis-wrap { padding: 1.2rem; min-height: 120px; }
    #analysis-text { font-size: 0.95rem; line-height: 1.7; color: #ccc; white-space: pre-wrap; }
    #analysis-text.empty { color: #333; font-style: italic; }
    .pulse { animation: pulse 0.6s ease-out; }
    @keyframes pulse { 0% { opacity: 0.3; } 100% { opacity: 1; } }
  </style>
</head>
<body>
  <header>
    <h1>Ella Cheating</h1>
    <span><span id="status-dot"></span><span id="status-label">connecting...</span></span>
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

    function showPhoto(url, timestamp) {
      photo.src = url + '?t=' + Date.now();
      photo.style.display = 'block';
      placeholder.style.display = 'none';
      if (timestamp) tsEl.textContent = new Date(timestamp).toLocaleTimeString();
    }

    function showAnalysis(data) {
      if (!data || !data.text) return;
      analysisEl.textContent = data.text;
      analysisEl.classList.remove('empty', 'pulse');
      void analysisEl.offsetWidth;
      analysisEl.classList.add('pulse');
      if (data.imageUrl) showPhoto(data.imageUrl, data.timestamp);
    }

    const es = new EventSource('/api/events');
    es.onopen = () => { dot.classList.add('live'); label.textContent = 'live'; };
    es.onerror = () => { dot.classList.remove('live'); label.textContent = 'reconnecting...'; };
    es.addEventListener('photo', e => {
      const d = JSON.parse(e.data);
      showPhoto(d.url, d.timestamp);
    });
    es.addEventListener('analysis', e => showAnalysis(JSON.parse(e.data)));
  </script>
</body>
</html>`;

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  const localIP = Object.values(ifaces).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
  console.log(`\nRemote Camera Server`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}`);
  console.log(`  PIN:      ${FRONTEND_PIN ? 'enabled' : 'disabled (set FRONTEND_PIN env var)'}\n`);
});
