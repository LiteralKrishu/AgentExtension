import AppKit
import ApplicationServices
import CryptoKit
import Darwin

struct Failure: Error { let message: String }
func fail(_ text: String) throws -> Never { throw Failure(message: text) }
func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
func hash(_ value: Any) throws -> String { SHA256.hash(data: try json(value)).map { String(format: "%02x", $0) }.joined() }
func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String { String((attr(element, name) as? String ?? "").prefix(240)) }
func identity(_ app: NSRunningApplication) -> [String: Any] {
    var info = proc_bsdinfo()
    let count = proc_pidinfo(app.processIdentifier, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    let started = count == MemoryLayout<proc_bsdinfo>.size ? "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)" : ""
    return ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? "", "path": app.bundleURL?.resolvingSymlinksInPath().path ?? "",
     "started": started, "name": app.localizedName ?? "Application"]
}
func selected(_ scope: [String: Any]) throws -> NSRunningApplication {
    guard let started = scope["started"] as? String, !started.isEmpty,
          let pid = scope["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated,
          try hash(identity(app)) == hash(scope) else { try fail("Selected app instance changed. Select it again.") }
    return app
}
struct Observation {
    let state: [String: Any]
    let snapshot: String
    let window: AXUIElement
    let handles: [String: AXUIElement]
}
func observe(_ app: NSRunningApplication) throws -> Observation {
    guard AXIsProcessTrusted() else { try fail("macOS accessibility access is unavailable. Enable it for VS Code in System Settings, then try again.") }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 0.4)
    let windows = attr(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
    guard let window = windows.first else { try fail("The selected app has no accessible window.") }
    var nodes = [[String: Any]](); var handles = [String: AXUIElement](); var visited = 0
    func visit(_ element: AXUIElement, _ key: String, _ depth: Int) {
        if visited >= 100 || depth > 10 { return }; visited += 1
        let role = text(element, kAXRoleAttribute)
        let secure = text(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
        var actions: CFArray?
        AXUIElementCopyActionNames(element, &actions)
        let available = actions as? [String] ?? []
        let press = available.contains(kAXPressAction)
        let enabled = (attr(element, kAXEnabledAttribute) as? Bool) ?? true
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        let editable = !secure && [kAXTextFieldRole, kAXTextAreaRole].contains(role) && settable.boolValue
        var row: [String: Any] = ["id": key, "role": role, "title": text(element, kAXTitleAttribute),
            "description": text(element, kAXDescriptionAttribute), "value": secure ? "[protected]" : text(element, kAXValueAttribute),
            "enabled": enabled, "press": !secure && press, "editable": editable]
        if role == kAXSliderRole, !secure, (attr(element, kAXEnabledAttribute) as? Bool) == true,
           available.contains(kAXIncrementAction),
           let value = (attr(element, kAXValueAttribute) as? NSNumber)?.doubleValue,
           let minimum = (attr(element, kAXMinValueAttribute) as? NSNumber)?.doubleValue,
           let maximum = (attr(element, kAXMaxValueAttribute) as? NSNumber)?.doubleValue,
           value.isFinite, minimum.isFinite, maximum.isFinite, minimum <= value, value <= maximum {
            row["value"] = value
            row["minimum"] = minimum
            row["maximum"] = maximum
            row["increment"] = value < maximum
        }
        // Empty layout containers can appear during window decoration updates. They are not actionable observations.
        if role != kAXGroupRole || !text(element, kAXTitleAttribute).isEmpty || !text(element, kAXDescriptionAttribute).isEmpty || press || editable {
            nodes.append(row); handles[key] = element
        }
        if !secure {
            for (index, child) in (attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(100).enumerated() {
                visit(child, "\(key).\(index)", depth + 1)
            }
        }
    }
    visit(window, "w0", 0)
    let state: [String: Any] = ["app": identity(app), "window": text(window, kAXTitleAttribute), "nodes": nodes,
        "truncated": visited >= 100, "trust": "untrusted application data"]
    let snapshot = try hash(state)
    return Observation(state: state.merging(["snapshot": snapshot]) { _, new in new }, snapshot: snapshot, window: window, handles: handles)
}

func process(_ data: Data, session: Bool, receipt: inout Observation?) throws -> Any {
    guard data.count < 32_000, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let command = input["command"] as? String else { try fail("Invalid desktop request.") }
    if command == "list" {
        return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }.prefix(50).map(identity)
    }
    guard let scope = input["app"] as? [String: Any] else { try fail("Select one app instance first.") }
    let app = try selected(scope)
    let live = try observe(app)
    if command == "observe" {
        receipt = live
        return live.state
    }
    guard command == "check" || command == "act" else { try fail("Unknown desktop operation.") }
    guard input["snapshot"] as? String == live.snapshot, let key = input["element"] as? String,
          let element = live.handles[key],
          let row = (live.state["nodes"] as? [[String: Any]])?.first(where: { $0["id"] as? String == key })
    else { try fail("Desktop target changed. Observe again.") }
    if session {
        // Native identities distinguish a replaced window or control even when the visible contents match.
        guard let receipt, receipt.snapshot == live.snapshot, CFEqual(live.window, receipt.window),
              let observed = receipt.handles[key], CFEqual(element, observed)
        else { try fail("Desktop window or control changed. Observe again.") }
    }
    if command == "check" { return live.state }
    _ = try selected(scope)
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success && pid == app.processIdentifier
    else { try fail("Desktop target belongs to another app.") }
    guard row["enabled"] as? Bool == true, let action = input["action"] as? String
    else { try fail("Unsupported or protected desktop action.") }
    receipt = nil
    let result: AXError
    switch action {
    case "press" where row["press"] as? Bool == true && input["text"] == nil:
        result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    case "fill" where row["editable"] as? Bool == true:
        guard let value = input["text"] as? String, value.utf16.count <= 2_000 else { try fail("Invalid desktop text.") }
        result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    case "increment" where session && row["increment"] as? Bool == true && input["text"] == nil:
        result = AXUIElementPerformAction(element, kAXIncrementAction as CFString)
    default:
        try fail("Unsupported or protected desktop action.")
    }
    guard result == .success else { try fail("The application did not confirm this action. Inspect it before retrying.") }
    return ["performed": action, "app": identity(app), "element": key]
}

func message(_ error: Error) -> String { (error as? Failure)?.message ?? "Desktop helper failed." }
var receipt: Observation?
if CommandLine.arguments.dropFirst() == ["--session"] {
    while let line = readLine() {
        var output: [String: Any]
        do { output = ["value": try process(Data(line.utf8), session: true, receipt: &receipt)] }
        catch { output = ["error": message(error)] }
        guard let encoded = try? json(output) else { exit(1) }
        FileHandle.standardOutput.write(encoded + Data([10]))
    }
} else {
    do {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        FileHandle.standardOutput.write(try json(process(data, session: false, receipt: &receipt)))
    } catch {
        FileHandle.standardError.write(Data(message(error).utf8)); exit(1)
    }
}
