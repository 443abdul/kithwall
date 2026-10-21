// Kithwall for iOS (docs/v2/05-native.md): the Capacitor bridge view controller and the four app-local
// plugins the web app calls through apps/web/src/lib/native (contracts in plugins.ts there).
import AuthenticationServices
import Capacitor
import CryptoKit
import LocalAuthentication
import UIKit
import UserNotifications
import WebKit

// MARK: - Bridge view controller

class KithwallBridgeViewController: CAPBridgeViewController {
    /// WKWebView.uiDelegate is weak: keep the prompt gate alive for the controller's lifetime.
    private var promptGate: MainFramePromptGate?

    override func capacitorDidLoad() {
        restrictBridgeToMainFrame()
        bridge?.registerPluginInstance(KithwallShellPlugin())
        bridge?.registerPluginInstance(KithwallPasskeyPlugin())
        bridge?.registerPluginInstance(KithwallSecurePlugin())
        bridge?.registerPluginInstance(KithwallPushPlugin())
    }

    /// Security review N1: Capacitor registers its "bridge" message handler for EVERY frame, so a script in a
    /// third-party iframe (a click-to-play video embed) could post raw plugin calls. Swap in a gatekeeper that
    /// forwards only messages from the main frame of the app's own origin (or the bundled offline page),
    /// like Capacitor's Android bridge already does.
    private func restrictBridgeToMainFrame() {
        // `bridge` is the protocol type; the delegation handler lives on the concrete CapacitorBridge.
        guard let bridge = bridge as? CapacitorBridge else { return }
        let handler = bridge.webViewDelegationHandler
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: "bridge")
        let origins = AppOrigins(serverURL: bridge.config.serverURL, localURL: bridge.config.localURL)
        controller.add(MainFrameBridgeGate(target: handler, origins: origins), name: "bridge")
        // Security re-review I-N1: Capacitor also answers synchronous bridge calls (CapacitorCookies get/set,
        // CapacitorHttp) through window.prompt(), i.e. the WKUIDelegate text-input panel, which the "bridge"
        // message gate above never sees. Gate that path the same way.
        let gate = MainFramePromptGate(target: handler, origins: origins)
        promptGate = gate
        webView?.uiDelegate = gate
    }
}

/// The app's own origins (the live server URL and the bundled offline page).
struct AppOrigins {
    private let allowed: [(scheme: String, host: String, port: Int)]

    init(serverURL: URL, localURL: URL) {
        allowed = [serverURL, localURL].compactMap { u -> (scheme: String, host: String, port: Int)? in
            guard let s = u.scheme?.lowercased(), let h = u.host?.lowercased() else { return nil }
            return (s, h, u.port ?? 0)
        }
    }

    /// True only for the top-level document of one of the app's origins.
    func admits(_ frame: WKFrameInfo) -> Bool {
        guard frame.isMainFrame else { return false }
        let o = frame.securityOrigin
        let scheme = o.protocol.lowercased(), host = o.host.lowercased()
        return allowed.contains(where: { $0.scheme == scheme && $0.host == host && ($0.port == 0 || o.port == 0 || $0.port == o.port) })
    }
}

/// Forwards bridge messages to Capacitor only from the top-level document of the app's origin.
final class MainFrameBridgeGate: NSObject, WKScriptMessageHandler {
    private let target: WKScriptMessageHandler
    private let origins: AppOrigins

    init(target: WKScriptMessageHandler, origins: AppOrigins) {
        self.target = target
        self.origins = origins
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard origins.admits(message.frameInfo) else { return }
        target.userContentController(userContentController, didReceive: message)
    }
}

/// Wraps Capacitor's WKUIDelegate. window.prompt() from anything but the main frame of the app's origin is
/// answered with nil (no panel, and Capacitor's synchronous cookie/HTTP bridge never sees it); every other
/// UI delegate call goes to Capacitor unchanged. Never add `allow-modals` to embed iframes either.
final class MainFramePromptGate: NSObject, WKUIDelegate {
    private weak var target: (NSObject & WKUIDelegate)?
    private let origins: AppOrigins

    init(target: NSObject & WKUIDelegate, origins: AppOrigins) {
        self.target = target
        self.origins = origins
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard origins.admits(frame), let target = target else {
            completionHandler(nil)
            return
        }
        // Optional protocol requirement: nil when Capacitor doesn't implement it (then answer nil ourselves).
        if target.webView?(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText,
                           initiatedByFrame: frame, completionHandler: completionHandler) == nil {
            completionHandler(nil)
        }
    }

    // Everything else (alerts, confirms, new windows, media permissions…) is Capacitor's as before.
    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (target?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        (target?.responds(to: aSelector) ?? false) ? target : super.forwardingTarget(for: aSelector)
    }
}

// MARK: - Shell: navigation policy, app-switcher cover, screenshot notice

@objc(KithwallShellPlugin)
public class KithwallShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KithwallShellPlugin"
    public let jsName = "KithwallShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSecureScreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSecureScreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearWebData", returnType: CAPPluginReturnPromise),
    ]
    private static let secureKey = "kw.secureScreen"
    private var cover: UIView?

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(willResign), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(screenshot), name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        nc.addObserver(self, selector: #selector(captureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
    }

    private var origin: String {
        getConfig().getString("origin", nil) ?? bridge?.config.serverURL.absoluteString ?? "https://www.kithwall.com"
    }

    @objc func info(_ call: CAPPluginCall) {
        let v = Bundle.main.infoDictionary
        call.resolve([
            "platform": "ios", "env": getConfig().getString("env", "production") ?? "production", "origin": origin,
            "version": v?["CFBundleShortVersionString"] as? String ?? "", "build": v?["CFBundleVersion"] as? String ?? "",
            "flavor": "ios",
        ])
    }

    @objc func setSecureScreen(_ call: CAPPluginCall) {
        UserDefaults.standard.set(call.getBool("enabled") ?? false, forKey: Self.secureKey)
        call.resolve()
    }

    @objc func getSecureScreen(_ call: CAPPluginCall) {
        call.resolve(["enabled": UserDefaults.standard.bool(forKey: Self.secureKey)])
    }

    private func openOutside(_ url: URL) {
        guard let s = url.scheme?.lowercased(), ["https", "http", "mailto", "tel"].contains(s) else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let u = URL(string: s), u.scheme?.lowercased() == "https" else {
            call.reject("not opened", "failed")
            return
        }
        openOutside(u)
        call.resolve()
    }

    /// Quick exit: apps can't quit themselves on iOS, so the neutral site opens in Safari (Kithwall goes to the background).
    @objc func exit(_ call: CAPPluginCall) {
        if let s = call.getString("url"), let u = URL(string: s), u.scheme?.lowercased() == "https" { openOutside(u) }
        call.resolve()
    }

    /// Panic wipe (security review N6/P1): remove everything WebKit keeps for any site in this app: cookies,
    /// local/session storage, IndexedDB, caches, service workers.
    @objc func clearWebData(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let store = WKWebsiteDataStore.default()
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: Date.distantPast) {
                HTTPCookieStorage.shared.removeCookies(since: Date.distantPast)
                URLCache.shared.removeAllCachedResponses()
                call.resolve()
            }
        }
    }

    /// Only the app's origin (and the bundled offline page) loads in the app; https/mailto/tel go to the system; the rest is blocked.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" { return nil }
        if let o = URL(string: origin), scheme == o.scheme, url.host?.lowercased() == o.host?.lowercased() { return nil }
        if let local = bridge?.config.localURL, url.absoluteString.hasPrefix(local.absoluteString) { return nil }
        // Sub-frames (click-to-play video embeds allowed by the page's CSP) keep the default handling.
        if let frame = navigationAction.targetFrame, !frame.isMainFrame { return nil }
        if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil { openOutside(url) }
        return true
    }

    @objc private func willResign() {
        guard UserDefaults.standard.bool(forKey: Self.secureKey) else { return }
        DispatchQueue.main.async {
            guard self.cover == nil, let view = self.bridge?.viewController?.view else { return }
            let v = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
            v.frame = view.bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(v)
            self.cover = v
        }
    }

    @objc private func didBecomeActive() {
        DispatchQueue.main.async {
            self.cover?.removeFromSuperview()
            self.cover = nil
        }
    }

    // A local notice only: nobody else is told (docs/v2/05-native.md §6).
    @objc private func screenshot() {
        notifyListeners("screenshot", data: ["kind": "screenshot"])
    }

    @objc private func captureChanged() {
        if UIScreen.main.isCaptured { notifyListeners("screenshot", data: ["kind": "recording"]) }
    }
}

// MARK: - Passkeys (AuthenticationServices, PRF on iOS 18+)

@objc(KithwallPasskeyPlugin)
public class KithwallPasskeyPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "KithwallPasskeyPlugin"
    public let jsName = "KithwallPasskey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]
    private var pending: CAPPluginCall?
    private var controller: ASAuthorizationController?

    @objc func isAvailable(_ call: CAPPluginCall) {
        var prf = false
        if #available(iOS 18.0, *) { prf = true }
        call.resolve(["available": true, "prf": prf])
    }

    private func parse(_ call: CAPPluginCall) -> [String: Any]? {
        guard let s = call.getString("requestJson"), s.count <= 16384, let d = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return o
    }

    private static func prfSalt(_ o: [String: Any]) -> Data? {
        guard let ext = o["extensions"] as? [String: Any], let prf = ext["prf"] as? [String: Any],
              let ev = prf["eval"] as? [String: Any], let first = ev["first"] as? String else { return nil }
        return Data(base64URL: first)
    }

    private func start(_ request: ASAuthorizationRequest, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let p = self.pending { p.reject("superseded", "cancelled") }
            self.pending = call
            let c = ASAuthorizationController(authorizationRequests: [request])
            c.delegate = self
            c.presentationContextProvider = self
            self.controller = c
            c.performRequests()
        }
    }

    @objc func create(_ call: CAPPluginCall) {
        guard let o = parse(call), let rp = o["rp"] as? [String: Any], let rpId = rp["id"] as? String,
              let user = o["user"] as? [String: Any], let uid = (user["id"] as? String).flatMap({ Data(base64URL: $0) }),
              let name = user["name"] as? String, let challenge = (o["challenge"] as? String).flatMap({ Data(base64URL: $0) })
        else { call.reject("bad request", "failed"); return }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let req = provider.createCredentialRegistrationRequest(challenge: challenge, name: name, userID: uid)
        if let display = user["displayName"] as? String, !display.isEmpty { req.displayName = display }
        req.userVerificationPreference = .required
        if #available(iOS 17.4, *), let ex = o["excludeCredentials"] as? [[String: Any]] {
            req.excludedCredentials = ex.compactMap { ($0["id"] as? String).flatMap { Data(base64URL: $0) } }
                .map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        if #available(iOS 18.0, *), let salt = Self.prfSalt(o) {
            req.prf = .inputValues(.init(saltInput1: salt))
        }
        start(req, call)
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let o = parse(call), let rpId = o["rpId"] as? String,
              let challenge = (o["challenge"] as? String).flatMap({ Data(base64URL: $0) })
        else { call.reject("bad request", "failed"); return }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let req = provider.createCredentialAssertionRequest(challenge: challenge)
        req.userVerificationPreference = .required
        if let allow = o["allowCredentials"] as? [[String: Any]], !allow.isEmpty {
            req.allowedCredentials = allow.compactMap { ($0["id"] as? String).flatMap { Data(base64URL: $0) } }
                .map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        if #available(iOS 18.0, *), let salt = Self.prfSalt(o) {
            req.prf = .inputValues(.init(saltInput1: salt), perCredentialInputValues: nil)
        }
        start(req, call)
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func finish(_ json: [String: Any]) {
        guard let call = pending else { return }
        pending = nil
        controller = nil
        guard let d = try? JSONSerialization.data(withJSONObject: json), let s = String(data: d, encoding: .utf8) else {
            call.reject("encode failed", "failed")
            return
        }
        call.resolve(["responseJson": s])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        if let r = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            var ext: [String: Any] = [:]
            if #available(iOS 18.0, *), let prf = r.prf {
                var p: [String: Any] = ["enabled": prf.isSupported]
                if let first = prf.first { p["results"] = ["first": first.withUnsafeBytes { Data($0) }.base64URL] }
                ext["prf"] = p
            }
            let id = r.credentialID.base64URL
            finish([
                "id": id, "rawId": id, "type": "public-key", "authenticatorAttachment": "platform",
                "response": [
                    "clientDataJSON": r.rawClientDataJSON.base64URL,
                    "attestationObject": (r.rawAttestationObject ?? Data()).base64URL,
                    "transports": ["internal", "hybrid"],
                ],
                "clientExtensionResults": ext,
            ])
            return
        }
        if let a = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            var ext: [String: Any] = [:]
            if #available(iOS 18.0, *), let prf = a.prf {
                ext["prf"] = ["results": ["first": prf.first.withUnsafeBytes { Data($0) }.base64URL]]
            }
            let id = a.credentialID.base64URL
            finish([
                "id": id, "rawId": id, "type": "public-key", "authenticatorAttachment": "platform",
                "response": [
                    "clientDataJSON": a.rawClientDataJSON.base64URL,
                    "authenticatorData": a.rawAuthenticatorData.base64URL,
                    "signature": a.signature.base64URL,
                    "userHandle": a.userID.base64URL,
                ],
                "clientExtensionResults": ext,
            ])
            return
        }
        pending?.reject("unexpected credential", "failed")
        pending = nil
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = pending else { return }
        pending = nil
        self.controller = nil
        // 1001 canceled (also "no passkey for this site"), 1006 matchedExcludedCredential (iOS 18).
        let raw = (error as NSError).code
        let code = raw == ASAuthorizationError.Code.canceled.rawValue ? "cancelled" : raw == 1006 ? "exists" : "failed"
        call.reject(code, code)
    }
}

// MARK: - Secure storage and biometric unlock (Keychain, this device only)

@objc(KithwallSecurePlugin)
public class KithwallSecurePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KithwallSecurePlugin"
    public let jsName = "KithwallSecure"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bioSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bioGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bioRemove", returnType: CAPPluginReturnPromise),
    ]
    private static let bioService = "com.kithwall.app.bio"

    private func key(_ call: CAPPluginCall) -> String? {
        guard let k = call.getString("key"), k.range(of: "^[a-z0-9.-]{1,64}$", options: .regularExpression) != nil else {
            call.reject("bad key", "failed")
            return nil
        }
        return k
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let k = key(call) else { return }
        let v = KWKeychain.get(service: KWKeychain.secureService, account: k).flatMap { String(data: $0, encoding: .utf8) }
        call.resolve(["value": v ?? NSNull()])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let k = key(call) else { return }
        guard let v = call.getString("value"), v.count <= 65536, KWKeychain.set(Data(v.utf8), service: KWKeychain.secureService, account: k) else {
            call.reject("could not save", "failed")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let k = key(call) else { return }
        KWKeychain.remove(service: KWKeychain.secureService, account: k)
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        KWKeychain.removeAll(service: KWKeychain.secureService)
        KWKeychain.removeAll(service: Self.bioService)
        call.resolve()
    }

    @objc func biometricStatus(_ call: CAPPluginCall) {
        let ctx = LAContext()
        var err: NSError?
        let can = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        let notEnrolled = (err?.code == LAError.biometryNotEnrolled.rawValue)
        let kind: String
        switch ctx.biometryType {
        case .faceID: kind = "face"
        case .touchID: kind = "fingerprint"
        case .none: kind = "none"
        default: kind = "biometric"
        }
        call.resolve(["available": can || notEnrolled, "enrolled": can, "kind": kind])
    }

    /// Stored behind .biometryCurrentSet: Face ID / Touch ID for every read, gone if biometrics are re-enrolled.
    @objc func bioSet(_ call: CAPPluginCall) {
        guard let k = key(call) else { return }
        guard let v = call.getString("value"), v.count <= 8192,
              let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil)
        else { call.reject("unavailable", "unavailable"); return }
        KWKeychain.removeAll(service: Self.bioService)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.bioService,
            kSecAttrAccount as String: k, kSecValueData as String: Data(v.utf8), kSecAttrAccessControl as String: access,
        ]
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecSuccess { call.resolve() } else { call.reject("unavailable", "unavailable") }
    }

    @objc func bioGet(_ call: CAPPluginCall) {
        guard let k = key(call) else { return }
        let ctx = LAContext()
        ctx.localizedCancelTitle = call.getString("cancel")
        let reason = call.getString("title") ?? "Kithwall"
        DispatchQueue.global(qos: .userInitiated).async {
            let q: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.bioService,
                kSecAttrAccount as String: k, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: ctx, kSecUseOperationPrompt as String: reason,
            ]
            var out: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            switch status {
            case errSecSuccess:
                let v = (out as? Data).flatMap { String(data: $0, encoding: .utf8) }
                call.resolve(["value": v ?? NSNull()])
            case errSecItemNotFound:
                call.resolve(["value": NSNull()])
            case errSecUserCanceled:
                call.reject("cancelled", "cancelled")
            case errSecAuthFailed:
                call.reject("failed", "lockout")
            default:
                call.reject("unavailable", "unavailable")
            }
        }
    }

    @objc func bioRemove(_ call: CAPPluginCall) {
        KWKeychain.removeAll(service: Self.bioService)
        call.resolve()
    }
}

// MARK: - Push (APNs; payloads decrypted by the Notification Service Extension)

@objc(KithwallPushPlugin)
public class KithwallPushPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "KithwallPushPlugin"
    public let jsName = "KithwallPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "permission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "current", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHidden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearHidden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNotifications", returnType: CAPPluginReturnPromise),
    ]
    private var pending: CAPPluginCall?

    override public func load() {
        bridge?.notificationRouter.pushNotificationHandler = self
        NotificationCenter.default.addObserver(self, selector: #selector(didRegister(_:)), name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didFail(_:)), name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
    }

    private func state(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            switch s.authorizationStatus {
            case .authorized, .provisional, .ephemeral: done("granted")
            case .denied: done("denied")
            default: done("prompt")
            }
        }
    }

    @objc func permission(_ call: CAPPluginCall) {
        state { call.resolve(["state": $0]) }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            self.state { call.resolve(["state": $0]) }
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        pending?.reject("superseded", "failed")
        pending = call
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }

    @objc private func didRegister(_ n: Notification) {
        guard let call = pending else { return }
        pending = nil
        guard let token = n.object as? Data else { call.reject("unavailable", "unavailable"); return }
        do {
            let keys = try KWPush.ensureKeys()
            let hex = token.map { String(format: "%02x", $0) }.joined()
            #if DEBUG
            let env = "sandbox"
            #else
            let env = "production"
            #endif
            let reg: [String: Any] = ["provider": "apns", "token": hex, "p256dh": keys.p256dh, "auth": keys.auth, "apnsEnv": env]
            if let d = try? JSONSerialization.data(withJSONObject: reg) {
                KWKeychain.set(d, service: KWKeychain.pushService, account: "registration", shared: true,
                               accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
            }
            call.resolve(reg)
        } catch {
            call.reject("failed", "failed")
        }
    }

    @objc private func didFail(_ n: Notification) {
        pending?.reject("unavailable", "unavailable")
        pending = nil
    }

    @objc func current(_ call: CAPPluginCall) {
        guard let d = KWKeychain.get(service: KWKeychain.pushService, account: "registration", shared: true),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { call.resolve([:]); return }
        call.resolve(o)
    }

    @objc func unregister(_ call: CAPPluginCall) {
        DispatchQueue.main.async { UIApplication.shared.unregisterForRemoteNotifications() }
        KWPush.clear()
        call.resolve()
    }

    @objc func setHidden(_ call: CAPPluginCall) {
        guard let salt = call.getString("salt"), let hashes = call.getArray("hashes") as? [String], hashes.count <= 10000 else {
            call.reject("bad list", "failed")
            return
        }
        KWPush.setHidden(salt: salt, hashes: hashes)
        call.resolve()
    }

    @objc func clearHidden(_ call: CAPPluginCall) {
        KWPush.clearHidden()
        call.resolve()
    }

    @objc func clearNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        call.resolve()
    }

    // NotificationHandlerProtocol. The extension stored kwUrl / kwKind in userInfo after decrypting.
    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        let kind = notification.request.content.userInfo["kwKind"] as? String
        // On screen: the app shows new messages and rings for calls itself.
        if kind == "message" || kind == "call" { return [] }
        return [.banner, .list, .sound]
    }

    public func didReceive(response: UNNotificationResponse) {
        let path = KWPush.safePath(response.notification.request.content.userInfo["kwUrl"] as? String)
        notifyListeners("open", data: ["url": path], retainUntilConsumed: true)
    }
}
