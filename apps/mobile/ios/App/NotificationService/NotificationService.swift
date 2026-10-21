// Kithwall Notification Service Extension (docs/v2/05-native.md §5). APNs carries only
//   {aps: {alert: "You have new activity on Kithwall.", mutable-content: 1}, kw: <base64url aes128gcm>}
// This extension decrypts `kw` with the device key from the shared keychain (KithwallShared.swift) and
// replaces the generic text with the real "who + what", unless the chat is hidden on this device. If
// anything fails, the generic text stays: Apple never sees more than that.
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        content.title = "Kithwall"
        content.body = "You have new activity on Kithwall."
        content.userInfo = ["kwUrl": "/activity", "kwKind": "notification"]
        fallback = content

        guard let b64 = request.content.userInfo["kw"] as? String, b64.count <= 8192,
              let message = Data(base64URL: b64),
              let plain = try? KWPush.decrypt(message),
              let o = try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
        else { contentHandler(content); return }

        let path = KWPush.safePath(o["url"] as? String)
        let tag = o["tag"] as? String
        let kind = o["kind"] as? String ?? "notification"
        if KWPush.isHidden(conversation: KWPush.conversation(path: path, tag: tag)) {
            contentHandler(content)   // hidden chat: generic text, opens Activity
            return
        }
        content.title = String((o["title"] as? String ?? "Kithwall").prefix(60))
        content.body = String((o["body"] as? String ?? content.body).prefix(200))
        if let tag = tag { content.threadIdentifier = String(tag.prefix(120)) }
        content.userInfo = ["kwUrl": path, "kwKind": kind]
        if let badge = o["badge"] as? Int { content.badge = NSNumber(value: max(0, min(999, badge))) }
        if kind == "call" {
            content.interruptionLevel = .timeSensitive
            content.sound = .default
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let h = handler, let f = fallback { h(f) }
    }
}
