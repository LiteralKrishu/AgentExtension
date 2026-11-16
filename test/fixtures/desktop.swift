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
func makeSlider() -> NSSlider {
    let slider = NSSlider(value: 2, minValue: 0, maxValue: 4, target: nil, action: nil)
    slider.frame = NSRect(x: 200, y: 20, width: 160, height: 30)
    slider.numberOfTickMarks = 5
    slider.allowsTickMarkValuesOnly = true
    slider.setAccessibilityLabel("Test slider")
    return slider
}
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
let slider = makeSlider()
for view in [label, field, password, button, slider] { window.contentView?.addSubview(view) }
var replacementWindow: NSWindow?
if let target = ProcessInfo.processInfo.environment["AGENTEXTENSION_DESKTOP_SWITCH"] {
    Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
        guard FileManager.default.fileExists(atPath: target) else { return }
        let replacement = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 220),
                                   styleMask: window.styleMask, backing: .buffered, defer: false)
        replacementWindow = replacement
        replacement.isReleasedWhenClosed = false
        replacement.title = window.title
        for view in [label, field, password, button] { replacement.contentView?.addSubview(view) }
        replacement.contentView?.addSubview(makeSlider())
        replacement.makeKeyAndOrderFront(nil)
        window.isReleasedWhenClosed = false
        window.close()
        try? Data().write(to: URL(fileURLWithPath: target + ".ready"))
        timer.invalidate()
    }
}
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
application.run()
