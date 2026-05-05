import AVFoundation
import UIKit

class CameraManager: NSObject {
    let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let captureDelegate = CaptureDelegate()

    var isAuthorized = false
    // captureId is nil for manual shutter presses, non-nil for API-triggered captures
    var onPhotoCaptured: ((_ data: Data, _ captureId: String?) -> Void)?

    override init() {
        super.init()
        captureDelegate.onCapture = { [weak self] data, captureId in
            self?.onPhotoCaptured?(data, captureId)
        }
    }

    func requestAuthorization() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            isAuthorized = true
            await setupSession()
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            isAuthorized = granted
            if granted { await setupSession() }
        default:
            isAuthorized = false
        }
    }

    private func setupSession() async {
        session.sessionPreset = .photo
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: device)
        else { return }

        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }
    }

    func startSession() {
        guard !session.isRunning else { return }
        Task.detached { [weak self] in self?.session.startRunning() }
    }

    func stopSession() {
        guard session.isRunning else { return }
        Task.detached { [weak self] in self?.session.stopRunning() }
    }

    func capturePhoto(captureId: String? = nil) {
        captureDelegate.pendingCaptureId = captureId
        let settings = AVCapturePhotoSettings()
        settings.flashMode = .auto
        photoOutput.capturePhoto(with: settings, delegate: captureDelegate)
    }
}

private class CaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    var onCapture: ((_ data: Data, _ captureId: String?) -> Void)?
    var pendingCaptureId: String?

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        guard error == nil, let data = photo.fileDataRepresentation() else { return }
        let captureId = pendingCaptureId
        pendingCaptureId = nil
        onCapture?(data, captureId)
    }
}
