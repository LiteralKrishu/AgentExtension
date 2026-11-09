import AppKit
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "AgentExtension test window"
let label = NSTextField(labelWithString: "No action yet")
label.frame = NSRect(x: 20, y: 160, width: 350, height: 30)
let field = NSTextField(frame: NSRect(x: 20, y: 110, width: 350, height: 30))
field.placeholderString = "Test text"; field.setAccessibilityLabel("Test text")
let password = NSSecureTextField(frame: NSRect(x: 20, y: 70, width: 350, height: 25))
password.stringValue = "fixture-protected-value"; password.setAccessibilityLabel("Protected field")
class Handler: NSObject {
    @objc func press() {
        label.stringValue = "Action confirmed"
        if let target = ProcessInfo.processInfo.environment["AGENTEXTENSION_DESKTOP_RESULT"] {
            try? Data(field.stringValue.utf8).write(to: URL(fileURLWithPath: target))
        }
    }
}
let handler = Handler()
let button = NSButton(title: "Confirm test", target: handler, action: #selector(Handler.press))
button.frame = NSRect(x: 20, y: 20, width: 160, height: 30)
for view in [label, field, password, button] { window.contentView?.addSubview(view) }
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
application.run()
