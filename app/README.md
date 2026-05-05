# Remote Camera — iOS App

A SwiftUI app that keeps a persistent WebSocket connection to the server and captures a photo on demand — either via a remote trigger or by pressing the on-screen shutter button. Captured photos are uploaded back to the server immediately.

---

## Requirements

| | |
|---|---|
| **iOS** | 17.0 or later |
| **Xcode** | 15 or later |
| **Device** | Physical iPhone (camera capture does not work in the simulator) |
| **Signing** | Free Apple Developer account is sufficient for development signing |

---

## Installation (pre-built IPA)

The pre-built IPA is at `app/build/RemoteCamera.ipa`. It is signed with a development certificate and can be sideloaded with any of the following tools:

| Tool | Notes |
|------|-------|
| [LiveContainer](https://github.com/LiveContainerTeam/LiveContainer) | On-device, no PC required |
| [AltStore](https://altstore.io) | Requires AltServer running on a Mac or PC |
| [Sideloadly](https://sideloadly.io) | Windows and Mac |
| Xcode → Devices | Drag-and-drop install, Mac only |

> **Note:** The pre-built IPA is signed with the original developer's certificate. If it expires (after 7 days on a free account) or is rejected by your device, build your own — see [Building from source](#building-from-source).

---

## Configuration

1. Open the app on your iPhone.
2. Tap the **⚙ gear** icon (top right).
3. Enter the server's network URL, e.g. `http://192.168.1.x:3000`.
4. Tap **Save**.

The status bar at the top of the camera view shows a green dot and **Connected** when the WebSocket is established. It reconnects automatically if the connection drops.

---

## Usage

| Action | How |
|--------|-----|
| Manual shot | Tap the white shutter button |
| Remote shot | `POST /api/capture` on the server |
| Remote shot (web) | Open `http://server:3000` and tap 📸 |

Photos are uploaded to the server immediately after capture. A brief flash overlay and a status message confirm the upload.

---

## Building from source

### Prerequisites

- Xcode 15+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (to regenerate the `.xcodeproj`)

```bash
brew install xcodegen
```

### Steps

1. **Generate the Xcode project**

   ```bash
   cd app
   xcodegen generate
   ```

   This reads `project.yml` and writes `RemoteCamera.xcodeproj`.

2. **Open in Xcode**

   ```bash
   open RemoteCamera.xcodeproj
   ```

3. **Set your team**

   Select the `RemoteCamera` target → **Signing & Capabilities** → set **Team** to your Apple Developer account.

4. **Run on device**

   Select your iPhone from the device picker and press **⌘R**.

### Building an IPA from the command line

Replace `YOUR_TEAM_ID` with your 10-character Apple Developer team ID (visible in Xcode under Signing & Capabilities).

```bash
cd app

# 1. Archive
xcodebuild archive \
  -project RemoteCamera.xcodeproj \
  -scheme RemoteCamera \
  -destination "generic/platform=iOS" \
  -archivePath /tmp/RemoteCamera.xcarchive \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID

# 2. Export IPA
xcodebuild -exportArchive \
  -archivePath /tmp/RemoteCamera.xcarchive \
  -exportPath app/build \
  -exportOptionsPlist app/ExportOptions.plist \
  -allowProvisioningUpdates
```

The IPA will be written to `app/build/RemoteCamera.ipa`.

---

## Source code structure

```
app/
├── project.yml                   XcodeGen project spec
├── ExportOptions.plist           IPA export configuration
├── RemoteCamera.xcodeproj        Generated Xcode project (do not edit manually)
├── build/
│   └── RemoteCamera.ipa          Pre-built IPA
└── RemoteCamera/
    ├── RemoteCameraApp.swift     App entry point; injects AppState into the environment
    ├── AppState.swift            Persists server URL in UserDefaults
    ├── CameraManager.swift       AVFoundation session; programmatic photo capture
    ├── NetworkClient.swift       WebSocket trigger receiver + multipart HTTP upload
    ├── Info.plist                Camera permission + ATS config
    └── Views/
        ├── ContentView.swift     Root view: live preview, shutter button, status bar
        ├── CameraPreviewView.swift  UIViewRepresentable wrapping AVCaptureVideoPreviewLayer
        └── SettingsView.swift    Server URL configuration sheet
```

### Key files

#### `CameraManager.swift`

Wraps an `AVCaptureSession` configured for photo capture. `capturePhoto(captureId:)` takes a shot programmatically; the optional `captureId` is threaded through to the upload so the server can match the photo to a waiting `/api/capture` request.

```swift
cameraManager.capturePhoto(captureId: "some-uuid")
```

The result comes back via the `onPhotoCaptured` closure:

```swift
cameraManager.onPhotoCaptured = { data, captureId in
    // data: raw JPEG bytes
    // captureId: echoed back from the trigger, or nil for manual shots
}
```

#### `NetworkClient.swift`

Manages two connections:

1. **WebSocket** (`/ws`) — receives `{ "action": "capture", "captureId": "uuid" }` messages from the server and fires `onTrigger`.
2. **HTTP upload** — `uploadPhoto(_:captureId:)` POSTs the JPEG as `multipart/form-data` to `/api/photo`, including the `captureId` field if one was provided.

Reconnects automatically after a 3-second delay if the WebSocket drops.

Self-signed certificates are accepted via a custom `URLSessionDelegate` — the same pattern used by Tracqcer.

#### `ContentView.swift`

Wires everything together:

- Shows `CameraPreviewView` full-screen.
- Connects `NetworkClient` to `CameraManager` via closure callbacks.
- Displays a connection status bar, a spinner while an upload is in progress, and a transient status message after each upload.
- Triggers a white flash overlay when a photo is captured.

---

## Architecture notes

- **`@Observable`** (iOS 17) is used throughout for state management, matching the pattern from the Tracqcer source.
- A **retain cycle** between `NetworkClient` and `CameraManager` (each holding a closure referencing the other) is broken via weak capture in `setupCallbacks()`.
- **Self-signed certificate support** is implemented with a custom `URLSessionDelegate` that accepts any server trust — intentionally permissive for local-network use.
- The `captureId` correlation pattern means a single `/api/capture` call produces exactly one photo even if multiple devices are connected, because the first upload that carries the matching `captureId` wins.
