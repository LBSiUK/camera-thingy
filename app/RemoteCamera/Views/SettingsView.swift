import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var draftURL = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Server URL") {
                    TextField("http://192.168.1.x:3000", text: $draftURL)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                Section {
                    Text("The base URL of your remote-camera server. The app opens a WebSocket to receive remote triggers and uploads captured photos via HTTP.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Trigger") {
                    Text("• Tap the shutter button on screen at any time")
                    Text("• POST /api/trigger from any device on the network to shoot remotely")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        appState.serverURL = draftURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .onAppear { draftURL = appState.serverURL }
    }
}
