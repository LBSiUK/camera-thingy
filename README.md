# Remote Camera

A system for remotely triggering an iPhone camera and receiving the captured photo via a single HTTP API call.

## Overview

```
Client (curl / Python / JS)
        │
        ▼
POST /api/capture           ← HTTP request blocks until photo arrives
        │
        ▼ WebSocket trigger (captureId)
        │
   iOS App  ──── takes photo ────►  POST /api/photo (captureId)
                                            │
                                            ▼
Client  ◄──────── JPEG response ────────────┘
```

A caller hits `POST /api/capture`. The server pushes a trigger to the iOS app over a persistent WebSocket, the app captures a photo and uploads it back, and the server returns the raw JPEG to the original caller — all in one round trip.

---

## Repository structure

```
remote-camera/
├── app/          iOS SwiftUI app (AVFoundation camera + WebSocket client)
├── server/       Node.js HTTP + WebSocket server
└── test/         Automated test runner and interactive browser test client
```

| Component | Documentation |
|-----------|--------------|
| iOS App | [app/README.md](app/README.md) |
| Server | [server/README.md](server/README.md) |
| Test client | [test/README.md](test/README.md) |

---

## Quick start

### 1. Start the server

```bash
cd server
npm install
npm start
```

```
Remote Camera Server
  Local:    http://localhost:3000
  Network:  http://192.168.1.x:3000  ← use this in the iOS app
  Capture:  POST http://192.168.1.x:3000/api/capture  → returns JPEG
```

### 2. Install and configure the iOS app

Install `app/build/RemoteCamera.ipa` via [AltStore](https://altstore.io), [Sideloadly](https://sideloadly.io), or [LiveContainer](https://github.com/LiveContainerTeam/LiveContainer).

Open the app → tap **⚙ gear** → enter `http://192.168.1.x:3000`. The status bar turns green when connected.

> To build from source, see [app/README.md](app/README.md).

### 3. Capture a photo

```bash
curl -X POST http://192.168.1.x:3000/api/capture --output photo.jpg
```

The request holds open until the photo is delivered, then saves it as `photo.jpg`.

---

## Branches

| Branch | Owner |
|--------|-------|
| `master` | Shared baseline |
| `leon` | Leon's working branch |
| `sam` | Sam's working branch |

---

## API summary

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/capture` | Trigger device → wait → return JPEG |
| `GET` | `/api/photos` | List all saved photos |
| `GET` | `/photos/:filename` | Serve a saved photo |
| `POST` | `/api/photo` | *(internal)* iOS app uploads photo |
| `GET` | `/api/events` | SSE stream — pushed on each new photo |

Full API reference: [server/README.md](server/README.md).
