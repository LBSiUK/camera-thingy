import Observation
import Foundation

@Observable
class NetworkClient {
    var isConnected = false
    var statusMessage = "Disconnected"

    // captureId is non-nil when the shot was triggered via /api/capture
    @ObservationIgnored var onTrigger: ((_ captureId: String?) -> Void)?
    @ObservationIgnored var onPhotoUploaded: ((Bool, String) -> Void)?

    @ObservationIgnored private var webSocketTask: URLSessionWebSocketTask?
    @ObservationIgnored private var urlSession: URLSession!
    @ObservationIgnored private var currentServerURL = ""

    init() {
        let delegate = SessionDelegate()
        urlSession = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
    }

    func connect(to serverURL: String) {
        currentServerURL = serverURL
        webSocketTask?.cancel(with: .normalClosure, reason: nil)

        guard let url = wsURL(from: serverURL) else { return }
        statusMessage = "Connecting…"
        webSocketTask = urlSession.webSocketTask(with: url)
        webSocketTask?.resume()
        receiveMessage()
    }

    func disconnect() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        isConnected = false
        statusMessage = "Disconnected"
    }

    func uploadPhoto(_ data: Data, captureId: String?) async {
        let base = currentServerURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + "/api/photo") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // Optional captureId field — lets the server match this photo to a waiting /api/capture request
        if let captureId {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"captureId\"\r\n\r\n".data(using: .utf8)!)
            body.append(captureId.data(using: .utf8)!)
            body.append("\r\n".data(using: .utf8)!)
        }

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"photo\"; filename=\"photo.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        do {
            let (_, response) = try await urlSession.upload(for: request, from: body)
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            await MainActor.run {
                self.onPhotoUploaded?(ok, ok ? "Photo uploaded" : "Upload failed")
            }
        } catch {
            await MainActor.run {
                self.onPhotoUploaded?(false, "Upload error: \(error.localizedDescription)")
            }
        }
    }

    private func wsURL(from urlString: String) -> URL? {
        var s = urlString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if s.hasPrefix("https://") { s = "wss://" + s.dropFirst(8) }
        else if s.hasPrefix("http://") { s = "ws://" + s.dropFirst(7) }
        return URL(string: s + "/ws")
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.handle(message)
                self.receiveMessage()
            case .failure:
                DispatchQueue.main.async {
                    self.isConnected = false
                    self.statusMessage = "Disconnected"
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    self.connect(to: self.currentServerURL)
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let s): text = s
        case .data(let d): text = String(data: d, encoding: .utf8) ?? ""
        @unknown default: return
        }

        guard
            let data = text.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let action = json["action"] as? String
        else { return }

        DispatchQueue.main.async {
            switch action {
            case "connected":
                self.isConnected = true
                self.statusMessage = "Connected"
            case "capture":
                let captureId = json["captureId"] as? String
                self.onTrigger?(captureId)
            default:
                break
            }
        }
    }
}

// Accepts self-signed certificates — same pattern as Tracqcer
private class SessionDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
