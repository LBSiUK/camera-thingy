import Observation
import Foundation

@Observable
class AppState {
    var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:3000"
    }
}
