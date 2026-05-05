# Remote Camera — Server

A Node.js HTTP and WebSocket server that:

- Pushes capture triggers to connected iOS devices over WebSocket.
- Receives uploaded photos from the iOS app and saves them to disk.
- Exposes a single synchronous API endpoint (`POST /api/capture`) that blocks until the photo arrives and returns the raw JPEG.
- Pushes real-time gallery updates to browser clients via Server-Sent Events (SSE).
- Serves a web control panel at `/`.

---

## Requirements

| | |
|---|---|
| **Node.js** | 18 or later (uses built-in `fetch` and `crypto.randomUUID`) |
| **npm** | Any recent version |

---

## Installation

```bash
cd server
npm install
```

---

## Running

```bash
npm start          # production
npm run dev        # auto-restart on file changes (Node 18+)
```

On startup the server prints:

```
Remote Camera Server
  Local:    http://localhost:3000
  Network:  http://192.168.1.x:3000  ← use this in the iOS app
  Capture:  POST http://192.168.1.x:3000/api/capture  → returns JPEG
  Photos:   /path/to/server/photos
```

---

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `PORT` | `3000` | HTTP/WebSocket listen port |

```bash
PORT=8080 npm start
```

---

## Photo storage

Photos are saved to `server/photos/` with filenames in the format:

```
photo-2026-05-05T23-35-08-000Z.jpg
```

The directory is created automatically on first run. Photos are never deleted automatically.

---

## Source structure

```
server/
├── server.js       All server logic (single file)
├── package.json
├── package-lock.json
└── photos/         Saved photos (created at runtime, not committed to git)
```

---

## API reference

### `POST /api/capture`

Triggers the connected iOS device to take a photo and returns it as a JPEG. The HTTP connection is held open until the photo arrives or the timeout expires.

**Request**

No body required.

```
POST /api/capture HTTP/1.1
Host: 192.168.1.x:3000
```

**Response — success**

```
HTTP/1.1 200 OK
Content-Type: image/jpeg

<binary JPEG data>
```

**Response — no device connected**

```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{ "error": "No devices connected" }
```

**Response — timeout**

```
HTTP/1.1 504 Gateway Timeout
Content-Type: application/json

{ "error": "Timeout — device did not respond in time" }
```

**Timeout:** 30 seconds.

**Examples**

```bash
# Save to file
curl -X POST http://localhost:3000/api/capture --output photo.jpg

# Pipe to ImageMagick
curl -s -X POST http://localhost:3000/api/capture | convert - photo.png
```

```python
import requests

resp = requests.post("http://192.168.1.x:3000/api/capture", timeout=35)
resp.raise_for_status()

with open("photo.jpg", "wb") as f:
    f.write(resp.content)
```

```javascript
// Node.js
const resp = await fetch("http://192.168.1.x:3000/api/capture", { method: "POST" });
const buffer = await resp.arrayBuffer();
fs.writeFileSync("photo.jpg", Buffer.from(buffer));
```

```javascript
// Browser
const resp = await fetch("/api/capture", { method: "POST" });
const blob = await resp.blob();
const url = URL.createObjectURL(blob);
document.querySelector("img").src = url;
```

---

### `GET /api/photos`

Returns a list of all photos saved on the server, newest first.

**Response**

```
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
[
  {
    "filename": "photo-2026-05-05T23-35-08-000Z.jpg",
    "url": "/photos/photo-2026-05-05T23-35-08-000Z.jpg"
  },
  ...
]
```

**Example**

```bash
curl http://localhost:3000/api/photos
```

---

### `GET /photos/:filename`

Serves a saved photo by filename.

**Response**

```
HTTP/1.1 200 OK
Content-Type: image/jpeg

<binary JPEG data>
```

**Example**

```bash
curl http://localhost:3000/photos/photo-2026-05-05T23-35-08-000Z.jpg --output photo.jpg
```

---

### `POST /api/photo`

Receives a captured photo from the iOS app and saves it to disk. If a `captureId` field is present in the form body, the upload resolves the corresponding waiting `/api/capture` request.

> This endpoint is called by the iOS app automatically. You do not need to call it directly.

**Request**

```
POST /api/photo HTTP/1.1
Content-Type: multipart/form-data; boundary=<boundary>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `photo` | File (JPEG) | Yes | The captured image |
| `captureId` | String | No | UUID linking this upload to a waiting `/api/capture` request |

**Response — success**

```json
{ "ok": true, "filename": "photo-2026-05-05T23-35-08-000Z.jpg" }
```

**Response — missing photo**

```
HTTP/1.1 400 Bad Request

{ "error": "No photo in request" }
```

---

### `GET /api/events`

A [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream. The server pushes a `photo` event every time a new photo is saved. Browser clients use this to refresh the gallery in real time without polling.

**Response**

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Events**

| Event | Data | Description |
|-------|------|-------------|
| *(initial)* | `connected` | Sent once on connection |
| `photo` | `{ "filename": "...", "url": "..." }` | Sent each time a photo is saved |

**Browser example**

```javascript
const es = new EventSource("/api/events");

es.addEventListener("photo", (e) => {
  const { filename, url } = JSON.parse(e.data);
  console.log("New photo:", filename);
  // refresh gallery here
});
```

---

### `GET /`

Serves the built-in web control panel — a full-page UI with a shutter button and a live photo gallery.

---

## WebSocket protocol

The iOS app connects to `ws://server:3000/ws` and maintains a persistent connection.

### Server → App messages

| Field | Type | Description |
|-------|------|-------------|
| `action` | `"connected"` | Sent once on WebSocket handshake |
| `action` | `"capture"` | Instructs the app to take a photo |
| `captureId` | string | UUID to echo back with the upload (present when triggered via `/api/capture`) |

**Handshake**

```json
{ "action": "connected" }
```

**Capture trigger**

```json
{ "action": "capture", "captureId": "550e8400-e29b-41d4-a716-446655440000" }
```

### App → Server

The app does not send messages over WebSocket. Photo delivery is via `POST /api/photo`.

---

## Request correlation

Each `/api/capture` call:

1. Generates a UUID (`captureId`).
2. Stores a `{ resolve, reject, timer }` entry in an in-memory `Map` keyed by `captureId`.
3. Broadcasts `{ action: "capture", captureId }` to all connected iOS devices.
4. Awaits the promise (max 30 s).

When `POST /api/photo` arrives carrying a matching `captureId`, the server resolves the promise with the saved file path, clears the timeout, and pipes the file into the waiting HTTP response.

If no photo arrives within 30 seconds, the promise rejects and the server responds with `504`.

---

## CORS

All endpoints send `Access-Control-Allow-Origin: *`, so the test client HTML can be opened directly from the filesystem and still call the API.
