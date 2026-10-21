// Shared by the app and the Notification Service Extension (docs/v2/05-native.md §5):
//  - Keychain helpers (this-device-only items; the push key and the hidden-chat list live in a keychain
//    access group both targets can read, KWKeychainGroup in Info.plist),
//  - RFC 8291 Web Push decryption (aes128gcm), a port of decryptPush() in apps/web/src/lib/push/crypto.ts,
//    which is unit-tested against the RFC 8291 example,
//  - the hidden-chat rule of public/sw.js.
import CryptoKit
import Foundation
import Security

enum KWKeychain {
    static let secureService = "com.kithwall.app.secure"
    static let pushService = "com.kithwall.app.push"

    /// "$(AppIdentifierPrefix)com.kithwall.app.shared" from Info.plist (nil in unsigned builds).
    static var sharedGroup: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "KWKeychainGroup") as? String,
              !g.isEmpty, !g.hasPrefix("$(") else { return nil }
        return g
    }

    private static func base(_ service: String, _ account: String?, shared: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account = account { q[kSecAttrAccount as String] = account }
        if shared, let g = sharedGroup { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    @discardableResult
    static func set(_ data: Data, service: String, account: String, shared: Bool = false,
                    accessible: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) -> Bool {
        SecItemDelete(base(service, account, shared: shared) as CFDictionary)
        var q = base(service, account, shared: shared)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = accessible
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func get(service: String, account: String, shared: Bool = false) -> Data? {
        var q = base(service, account, shared: shared)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func remove(service: String, account: String, shared: Bool = false) {
        SecItemDelete(base(service, account, shared: shared) as CFDictionary)
    }

    static func removeAll(service: String, shared: Bool = false) {
        SecItemDelete(base(service, nil, shared: shared) as CFDictionary)
    }
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum KWPushError: Error { case malformed, noKey }

enum KWPush {
    // The device key pair the server encrypts to (P-256) and the 16-byte auth secret. Readable after the
    // first unlock so the extension can decrypt while the phone is locked; never synced or backed up.
    static func ensureKeys() throws -> (p256dh: String, auth: String) {
        if let k = keys() { return (k.priv.publicKey.x963Representation.base64URL, k.auth.base64URL) }
        let priv = P256.KeyAgreement.PrivateKey()
        var auth = Data(count: 16)
        let ok = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) == errSecSuccess }
        guard ok else { throw KWPushError.noKey }
        let a = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard KWKeychain.set(priv.rawRepresentation, service: KWKeychain.pushService, account: "priv", shared: true, accessible: a),
              KWKeychain.set(auth, service: KWKeychain.pushService, account: "auth", shared: true, accessible: a)
        else { throw KWPushError.noKey }
        return (priv.publicKey.x963Representation.base64URL, auth.base64URL)
    }

    static func keys() -> (priv: P256.KeyAgreement.PrivateKey, auth: Data)? {
        guard let raw = KWKeychain.get(service: KWKeychain.pushService, account: "priv", shared: true),
              let auth = KWKeychain.get(service: KWKeychain.pushService, account: "auth", shared: true),
              let priv = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw) else { return nil }
        return (priv, auth)
    }

    static func clear() {
        KWKeychain.removeAll(service: KWKeychain.pushService, shared: true)
    }

    private static func hkdf(_ ikm: SymmetricKey, salt: Data, info: Data, count: Int) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: info, outputByteCount: count).withUnsafeBytes { Data($0) }
    }

    /// RFC 8291 aes128gcm decryption with this device's key.
    static func decrypt(_ message: Data) throws -> Data {
        guard let k = keys() else { throw KWPushError.noKey }
        let m = [UInt8](message)
        guard m.count >= 21 + 65 + 17 else { throw KWPushError.malformed }
        let salt = Data(m[0..<16])
        let rs = (Int(m[16]) << 24) | (Int(m[17]) << 16) | (Int(m[18]) << 8) | Int(m[19])
        let idlen = Int(m[20])
        guard idlen == 65, rs >= 18 else { throw KWPushError.malformed }
        let asPublic = Data(m[21..<(21 + idlen)])
        let ct = Data(m[(21 + idlen)...])
        guard ct.count > 16, ct.count <= rs else { throw KWPushError.malformed }

        let sender = try P256.KeyAgreement.PublicKey(x963Representation: asPublic)
        let shared = try k.priv.sharedSecretFromKeyAgreement(with: sender)
        let uaPublic = k.priv.publicKey.x963Representation
        let keyInfo = Data("WebPush: info".utf8) + Data([0]) + uaPublic + asPublic
        let ikm = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: k.auth, sharedInfo: keyInfo, outputByteCount: 32)
        let cek = hkdf(ikm, salt: salt, info: Data("Content-Encoding: aes128gcm".utf8) + Data([0]), count: 16)
        let nonce = hkdf(ikm, salt: salt, info: Data("Content-Encoding: nonce".utf8) + Data([0]), count: 12)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
        let record = [UInt8](try AES.GCM.open(box, using: SymmetricKey(data: cek)))
        var end = record.count - 1
        while end >= 0 && record[end] == 0 { end -= 1 }
        guard end >= 0, record[end] == 2 else { throw KWPushError.malformed }
        return Data(record[0..<end])
    }

    // Hidden chats: {salt, hashes} mirrored by the web app (lib/safety/swmirror.ts → KithwallPush.setHidden).
    static func setHidden(salt: String, hashes: [String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["salt": salt, "hashes": hashes]) else { return }
        KWKeychain.set(data, service: KWKeychain.pushService, account: "hidden", shared: true,
                       accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    static func clearHidden() {
        KWKeychain.remove(service: KWKeychain.pushService, account: "hidden", shared: true)
    }

    /// Same rule as public/sw.js: base64(SHA-256("<salt>:<conversation id>")) is in the list.
    static func isHidden(conversation: String?) -> Bool {
        guard let id = conversation,
              let raw = KWKeychain.get(service: KWKeychain.pushService, account: "hidden", shared: true),
              let o = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let salt = o["salt"] as? String, let hashes = o["hashes"] as? [String] else { return false }
        let h = Data(SHA256.hash(data: Data("\(salt):\(id.lowercased())".utf8))).base64EncodedString()
        return hashes.contains(h)
    }

    /// Only same-app paths can be opened from a notification.
    static func safePath(_ u: String?) -> String {
        guard let u = u, u.hasPrefix("/"), !u.hasPrefix("//"), !u.contains("\\"), u.count <= 512 else { return "/activity" }
        return u
    }

    static func conversation(path: String, tag: String?) -> String? {
        let pattern = "[0-9a-fA-F-]{36}"
        if path.hasPrefix("/messages/"), let r = path.range(of: pattern, options: .regularExpression) { return String(path[r]) }
        if let t = tag, t.hasPrefix("conv:") || t.hasPrefix("call:"), let r = t.range(of: pattern, options: .regularExpression) { return String(t[r]) }
        return nil
    }
}
