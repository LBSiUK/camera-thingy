#!/usr/bin/env node
// Automated test runner for the Remote Camera API.
// Usage: node test/test.js [server-url]
// Requires Node 18+ (built-in fetch). No extra packages needed.

const BASE = process.argv[2]?.replace(/\/$/, '') ?? 'http://localhost:3000';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';

let passed = 0;
let failed = 0;

function log(msg) { process.stdout.write(msg + '\n'); }
function pass(name, detail = '') {
  passed++;
  log(`  ${GREEN}✓${RESET} ${name}${detail ? DIM + '  ' + detail + RESET : ''}`);
}
function fail(name, detail = '') {
  failed++;
  log(`  ${RED}✗${RESET} ${BOLD}${name}${RESET}${detail ? '\n    ' + RED + detail + RESET : ''}`);
}
function section(name) { log(`\n${BOLD}${CYAN}${name}${RESET}`); }
function info(msg)     { log(`  ${DIM}${msg}${RESET}`); }

async function get(path) {
  const t = Date.now();
  const r = await fetch(BASE + path);
  return { res: r, ms: Date.now() - t, json: () => r.clone().json() };
}

async function post(path, opts = {}) {
  const t = Date.now();
  const r = await fetch(BASE + path, { method: 'POST', ...opts });
  return { res: r, ms: Date.now() - t, json: () => r.clone().json() };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testConnectivity() {
  section('Connectivity');
  try {
    const { res, ms } = await get('/api/photos');
    if (res.ok) pass('Server reachable', `${ms}ms`);
    else        fail('Server reachable', `HTTP ${res.status}`);
  } catch (e) {
    fail('Server reachable', `Cannot connect to ${BASE} — is the server running?`);
    log(`\n${RED}Aborting: server not reachable.${RESET}\n`);
    process.exit(1);
  }
}

async function testPhotosList() {
  section('GET /api/photos');
  const { res, ms, json } = await get('/api/photos');

  if (res.status === 200) pass('Returns 200', `${ms}ms`);
  else                    fail('Returns 200', `Got ${res.status}`);

  const body = await json();
  if (Array.isArray(body))          pass('Body is an array', `${body.length} photo(s)`);
  else                              fail('Body is an array', JSON.stringify(body));

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) pass('Content-Type is JSON');
  else                                 fail('Content-Type is JSON', ct);

  if (body.length > 0) {
    const p = body[0];
    const hasFields = typeof p.filename === 'string' && typeof p.url === 'string';
    if (hasFields) pass('Photos have filename + url fields');
    else           fail('Photos have filename + url fields', JSON.stringify(p));
  } else {
    info('No photos saved yet — skipping schema check');
  }

  return body;
}

async function testNoDevice() {
  section('POST /api/capture  (no device connected)');
  info('Expecting 503 when no iOS device is connected…');

  const { res, ms, json } = await post('/api/capture');

  if (res.status === 503) {
    pass('Returns 503 when no device connected', `${ms}ms`);
    const body = await json();
    if (body.error) pass('Error message present', body.error);
    else            fail('Error message present');
  } else if (res.status === 200) {
    // A device was actually connected — treat as pass
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('image/jpeg') || ct.includes('image')) {
      pass('Returns 200 with JPEG (device was connected!)', `${ms}ms`);
    } else {
      fail('Unexpected 200 with non-image body', ct);
    }
  } else if (res.status === 504) {
    pass('Returns 504 timeout (device connected but did not respond)', `${ms}ms`);
  } else {
    fail('Returns 503 or 200', `Got ${res.status} in ${ms}ms`);
  }
}

async function testCaptureWithDevice() {
  section('POST /api/capture  (with device — interactive)');
  info('Make sure the iOS app is open and connected, then press Enter…');

  await new Promise((resolve) => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  info(`Sending capture request to ${BASE}/api/capture …`);
  const t = Date.now();

  let res;
  try {
    res = await fetch(BASE + '/api/capture', { method: 'POST', signal: AbortSignal.timeout(35_000) });
  } catch (e) {
    fail('Capture request completed', e.message);
    return;
  }

  const ms = Date.now() - t;

  if (res.status === 503) {
    fail('Returns photo', 'No device connected — open the app and try again');
    return;
  }

  if (res.status === 504) {
    fail('Returns photo', `Timeout after ${ms}ms — app may be in background`);
    return;
  }

  if (res.status !== 200) {
    fail('Returns 200', `Got ${res.status}`);
    return;
  }

  pass('Returns 200', `${ms}ms`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('image/jpeg')) pass('Content-Type is image/jpeg', ct);
  else                             fail('Content-Type is image/jpeg', ct);

  const buf = Buffer.from(await res.arrayBuffer());

  if (buf.length > 0) pass('Body has content', `${(buf.length / 1024).toFixed(1)} KB`);
  else                fail('Body has content', 'Empty response');

  // JPEG magic bytes: FF D8 FF
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (isJpeg) pass('Valid JPEG header (FF D8 FF)');
  else        fail('Valid JPEG header', `Got ${buf.slice(0, 3).toString('hex')}`);

  const outPath = `/tmp/remote-camera-test-${Date.now()}.jpg`;
  require('fs').writeFileSync(outPath, buf);
  pass('Photo saved', outPath);
}

async function testPhotoServing(photos) {
  section('GET /photos/:filename');
  if (!photos.length) { info('No photos to test — skipping'); return; }

  const p = photos[0];
  const { res, ms } = await get(p.url);

  if (res.status === 200)                       pass('Serves saved photo', `${ms}ms`);
  else                                          fail('Serves saved photo', `HTTP ${res.status}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('image/jpeg'))             pass('Content-Type is image/jpeg');
  else                                         fail('Content-Type is image/jpeg', ct);
}

async function testSSE() {
  section('GET /api/events  (SSE)');
  const ctrl = new AbortController();
  const t = Date.now();

  try {
    const res = await fetch(BASE + '/api/events', { signal: ctrl.signal });

    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('text/event-stream')) pass('Content-Type is text/event-stream', `${Date.now() - t}ms`);
    else                                   fail('Content-Type is text/event-stream', ct);

    // Read the first line of the stream — should be the initial "connected" ping
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    if (chunk.includes('connected'))  pass('Receives initial connected ping');
    else                              fail('Receives initial connected ping', JSON.stringify(chunk));

    ctrl.abort();
    reader.cancel().catch(() => {});
  } catch (e) {
    if (e.name !== 'AbortError') fail('SSE stream opens', e.message);
  }
}

async function testCors() {
  section('CORS headers');
  const { res } = await get('/api/photos');
  const acao = res.headers.get('access-control-allow-origin');
  if (acao === '*') pass('Access-Control-Allow-Origin: *');
  else              fail('Access-Control-Allow-Origin', `Got: ${acao}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  log(`\n${BOLD}Remote Camera API Tests${RESET}`);
  log(`${DIM}Server: ${BASE}${RESET}`);

  await testConnectivity();
  const photos = await testPhotosList();
  await testNoDevice();
  await testPhotoServing(photos);
  await testSSE();
  await testCors();

  // Interactive capture test — only run if stdin is a TTY
  if (process.stdin.isTTY) {
    await testCaptureWithDevice();
  } else {
    section('POST /api/capture  (with device)');
    info('Skipped — not a TTY. Run interactively to test live capture.');
  }

  // Summary
  const total = passed + failed;
  log(`\n${'─'.repeat(40)}`);
  if (failed === 0) {
    log(`${GREEN}${BOLD}All ${total} tests passed${RESET}`);
  } else {
    log(`${GREEN}${passed} passed${RESET}  ${RED}${BOLD}${failed} failed${RESET}  of ${total} total`);
  }
  log('');

  process.exit(failed > 0 ? 1 : 0);
})();
