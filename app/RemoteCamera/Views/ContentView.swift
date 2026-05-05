import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState
    @State private var cameraManager = CameraManager()
    @State private var networkClient = NetworkClient()
    @State private var showSettings = false
    @State private var flashOverlay = false
    @State private var statusMessage = ""
    @State private var isUploading = false

    var body: some View {
        NavigationStack {
            ZStack {
                cameraBackground

                if flashOverlay {
                    Color.white.ignoresSafeArea()
                }

                VStack(spacing: 0) {
                    connectionBar
                    Spacer()
                    statusLabel
                    shutterButton
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gear")
                            .foregroundStyle(.white)
                    }
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
        .task {
            await cameraManager.requestAuthorization()
            cameraManager.startSession()
            setupCallbacks()
            networkClient.connect(to: appState.serverURL)
        }
        .onDisappear {
            cameraManager.stopSession()
            networkClient.disconnect()
        }
        .onChange(of: appState.serverURL) { _, newURL in
            networkClient.connect(to: newURL)
        }
    }

    @ViewBuilder
    private var cameraBackground: some View {
        if cameraManager.isAuthorized {
            CameraPreviewView(session: cameraManager.session)
                .ignoresSafeArea()
        } else {
            Color.black.ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "camera.slash")
                    .font(.system(size: 48))
                Text("Camera access required")
                    .font(.headline)
            }
            .foregroundStyle(.white)
        }
    }

    private var connectionBar: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(networkClient.isConnected ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(networkClient.statusMessage)
                .font(.caption)
                .foregroundStyle(.white)
            Spacer()
            if isUploading {
                ProgressView()
                    .tint(.white)
                    .scaleEffect(0.8)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var statusLabel: some View {
        if !statusMessage.isEmpty {
            Text(statusMessage)
                .font(.caption)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
                .transition(.opacity)
                .padding(.bottom, 12)
                .animation(.easeInOut, value: statusMessage)
        }
    }

    private var shutterButton: some View {
        Button(action: capturePhoto) {
            ZStack {
                Circle()
                    .strokeBorder(.white, lineWidth: 4)
                    .frame(width: 72, height: 72)
                Circle()
                    .fill(.white)
                    .frame(width: 60, height: 60)
            }
        }
        .padding(.bottom, 48)
        .accessibilityLabel("Take photo")
    }

    private func setupCallbacks() {
        // Local refs needed for weak capture (class types required in capture lists)
        let nc = networkClient
        let cm = cameraManager

        // Weak capture of cm breaks the nc→closure→cm→closure→nc retain cycle
        nc.onTrigger = { [weak cm] (captureId: String?) in
            cm?.capturePhoto(captureId: captureId)
        }

        nc.onPhotoUploaded = { (_: Bool, message: String) in
            isUploading = false
            showStatus(message)
        }

        cm.onPhotoCaptured = { [weak nc] (data: Data, captureId: String?) in
            DispatchQueue.main.async {
                triggerFlash()
                isUploading = true
            }
            Task { await nc?.uploadPhoto(data, captureId: captureId) }
        }
    }

    private func capturePhoto() {
        cameraManager.capturePhoto()
    }

    private func triggerFlash() {
        withAnimation(.easeIn(duration: 0.05)) { flashOverlay = true }
        withAnimation(.easeOut(duration: 0.25).delay(0.05)) { flashOverlay = false }
    }

    private func showStatus(_ message: String) {
        statusMessage = message
        Task {
            try? await Task.sleep(for: .seconds(3))
            await MainActor.run { statusMessage = "" }
        }
    }
}
