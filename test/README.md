# Remote Camera — Test Client

Two tools for testing the Remote Camera API:

| Tool | File | Use |
|------|------|-----|
| CLI test runner | `test.js` | Automated pass/fail suite, CI-friendly |
| Browser test client | `client.html` | Interactive UI, shows live photos |

---

## CLI test runner (`test.js`)

### Requirements

Node.js 18+ (uses built-in `fetch` — no extra packages needed).

### Usage

```bash
# Test localhost:3000 (default)
node test/test.js

# Test a specific server
node test/test.js http://192.168.1.x:3000
```

### What it tests

| # | Test | Description |
|---|------|-------------|
| 1 | Server reachable | Can connect to the server at all |
| 2 | `GET /api/photos` returns 200 | Endpoint is up |
| 3 | Body is an array | Response is valid JSON array |
| 4 | Content-Type is JSON | Correct MIME type |
| 5 | Photos have filename + url | Schema check (if any photos exist) |
| 6 | `POST /api/capture` returns 503 (no device) | Correct error when no iOS app is connected |
| 7 | Error message present | Response body has a human-readable message |
| 8 | `GET /photos/:filename` returns 200 | Static photo serving works |
| 9 | Served photo is image/jpeg | Correct MIME type |
| 10 | `GET /api/events` Content-Type | SSE stream opens correctly |
| 11 | SSE receives connected ping | Server sends initial message |
| 12 | CORS header present | `Access-Control-Allow-Origin: *` |
| 13 | Live capture (interactive) | Full end-to-end: trigger → photo → JPEG response |

Test 13 is only run when stdin is a TTY (i.e. you ran it in a terminal, not in CI). It prompts you to press Enter, then fires a real `/api/capture` and verifies the returned bytes are a valid JPEG.

### Output

Passing run (no device needed for tests 1–12):

```
Remote Camera API Tests
Server: http://localhost:3000

Connectivity
  ✓ Server reachable  43ms

GET /api/photos
  ✓ Returns 200  2ms
  ✓ Body is an array  3 photo(s)
  ✓ Content-Type is JSON
  ✓ Photos have filename + url fields

POST /api/capture  (no device connected)
  ✓ Returns 503 when no device connected  1ms
  ✓ Error message present  No devices connected

GET /photos/:filename
  ✓ Serves saved photo  3ms
  ✓ Content-Type is image/jpeg

GET /api/events  (SSE)
  ✓ Content-Type is text/event-stream  1ms
  ✓ Receives initial connected ping

CORS headers
  ✓ Access-Control-Allow-Origin: *

POST /api/capture  (with device — interactive)
  Skipped — not a TTY

────────────────────────────────────────
All 12 tests passed
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All tests passed |
| `1` | One or more tests failed |

This makes the runner usable in CI pipelines:

```yaml
# GitHub Actions example
- run: node test/test.js http://localhost:3000
```

---

## Browser test client (`client.html`)

### Opening

The file can be opened directly in any browser — no web server needed:

```
File → Open  →  test/client.html
```

Or with a `?server=` parameter pre-filled:

```
file:///path/to/test/client.html?server=http://192.168.1.x:3000
```

Because the server sends `Access-Control-Allow-Origin: *`, cross-origin requests from a `file://` page work without any proxy.

### Interface

**Header**

- **URL input** — enter the server address and click **Connect**.
- **Status pill** — green = server reachable, red = unreachable.

**Left panel — Capture**

| Control | Action |
|---------|--------|
| `POST /api/capture` button | Fires the API, holds until photo arrives |
| `Run all tests` button | Runs the automated suite in-browser |
| Status card | HTTP status of the last capture |
| Response time card | Round-trip time in ms |
| Content-Type card | MIME type returned |
| Size card | Photo size in KB |
| Photo preview | Inline display of the returned JPEG |
| Download button | Save the photo to disk |
| Request log | Collapsible history of every request made |

**Right panel — Saved photos**

- Thumbnail grid of all photos on the server.
- Refreshes automatically the instant a new photo is uploaded (via SSE — no polling).
- Click any thumbnail to open the full-size image.

**In-browser test suite**

Clicking **Run all tests** runs five checks and shows pass/fail inline:

1. Server reachable
2. `GET /api/photos` returns an array
3. CORS header present
4. `POST /api/capture` returns 503 or 200 (handles both connected and disconnected device)
5. `GET /photos/:file` serves a JPEG

### Live updates

The test client connects to `/api/events` (SSE) immediately after you press **Connect**. Every `photo` event triggers an automatic gallery refresh, so photos appear within milliseconds of being uploaded — even if someone else triggers a capture from a different device or terminal.
