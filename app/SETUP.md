# RemoteCamera — iOS App Setup

## What it does

- Shows a live camera preview with a manual shutter button
- Connects to the server via WebSocket for **remote triggers**
- When triggered (remotely or manually), captures a photo and uploads it to the server

---

## 1. Start the server first

```bash
cd remote-camera/server
npm install
npm start
```

The server prints the network URL — you'll need it:

```
Network:  http://192.168.1.x:3000  ← use this in the iOS app
```

Open `http://192.168.1.x:3000` in any browser to see the web control panel and trigger photos from there.

---

## 2. Create the Xcode project

1. Open Xcode → **File › New › Project**
2. Choose **iOS › App** → Next
3. Fill in:
   - **Product Name:** `RemoteCamera`
   - **Interface:** SwiftUI
   - **Language:** Swift
   - **Minimum Deployments:** iOS 17.0 (required for `@Observable`)
4. Save the project somewhere convenient (not inside this `ios/` folder)

---

## 3. Add the source files

1. Delete the generated `ContentView.swift` from the project
2. Right-click the `RemoteCamera` group → **Add Files to "RemoteCamera"…**
3. Navigate to `remote-camera/ios/RemoteCamera/` and select:
   - All `.swift` files at the root
   - The entire `Views/` folder
4. Ensure **"Copy items if needed"** is checked and the target is ticked → **Add**

Your project navigator should show:

```
RemoteCamera/
├── RemoteCameraApp.swift
├── AppState.swift
├── CameraManager.swift
├── NetworkClient.swift
└── Views/
    ├── ContentView.swift
    ├── CameraPreviewView.swift
    └── SettingsView.swift
```

---

## 4. Update Info.plist

Click the `Info.plist` Xcode generated and add these rows:

| Key | Type | Value |
|-----|------|-------|
| NSCameraUsageDescription | String | Take photos on command — remotely or via the shutter button. |
| NSAppTransportSecurity | Dictionary | — |
| → NSAllowsArbitraryLoads | Boolean | YES |

`NSAllowsArbitraryLoads` lets the app talk to your local server without HTTPS. The app uses `URLSessionDelegate` to handle self-signed certs if you later add TLS.

---

## 5. Build and run

- Select your iPhone (or simulator for testing the UI — camera requires a real device)
- Press **⌘R**
- Tap the gear icon → enter `http://192.168.1.x:3000` (your server's network URL)
- The status bar will turn green: **Connected**

---

## Usage

| Action | How |
|--------|-----|
| Manual shot | Tap the white shutter button |
| Remote shot | Open the web UI (`http://server:3000`) and tap 📸 |
| Remote shot (API) | `curl -X POST http://server:3000/api/trigger` |
| View photos | Web UI gallery, or `server/photos/` directory |

Photos are saved as `photo-<timestamp>.jpg` in `server/photos/`.
