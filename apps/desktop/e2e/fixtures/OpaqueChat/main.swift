// OpaqueChat: a chat window that draws its own interface and shows nothing through
// accessibility but its window's buttons, like many chat apps, for e2e/desktop-opaque.mjs.
// Contacts on the left, a message field at the bottom right; return sends. Everything it
// does goes into /tmp/finx-opaque-chat:
//   layout.json   the window's title bar height, so a test knows where things are drawn
//   messages.txt  one "<contact>\t<text>" line per message sent
// SIGUSR1 moves the window 60 points right, as a person might between a look and a click.
import AppKit

let dir = URL(fileURLWithPath: "/tmp/finx-opaque-chat")
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

let contacts = ["Alice", "Bob", "Carol"]
/// Content layout, in points from the content's top-left corner.
let listWidth: CGFloat = 200, rowHeight: CGFloat = 60
let field = NSRect(x: 220, y: 330, width: 360, height: 44)

final class ChatView: NSView {
    var selected: Int?
    var fieldFocused = false
    var draft = ""

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }

    override func draw(_ dirty: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        NSColor(white: 0.93, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: listWidth, height: bounds.height).fill()
        let font: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 16)]
        for (i, name) in contacts.enumerated() {
            let row = NSRect(x: 0, y: CGFloat(i) * rowHeight, width: listWidth, height: rowHeight)
            if i == selected {
                NSColor.systemBlue.withAlphaComponent(0.3).setFill()
                row.fill()
            }
            (name as NSString).draw(at: NSPoint(x: 20, y: row.minY + 20), withAttributes: font)
        }
        (fieldFocused ? NSColor.systemBlue : NSColor.gray).setStroke()
        NSBezierPath(roundedRect: field, xRadius: 6, yRadius: 6).stroke()
        (draft as NSString).draw(at: NSPoint(x: field.minX + 10, y: field.minY + 12), withAttributes: font)
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if p.x < listWidth {
            let row = Int(p.y / rowHeight)
            if contacts.indices.contains(row) { selected = row }
            fieldFocused = false
        } else {
            fieldFocused = field.contains(p)
        }
        window?.makeFirstResponder(self)
        needsDisplay = true
    }

    @objc func paste(_ sender: Any?) {
        guard fieldFocused, let text = NSPasteboard.general.string(forType: .string) else { return }
        draft += text
        needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        guard fieldFocused else { return }
        if event.keyCode == 36 {
            if let row = selected, !draft.isEmpty {
                let line = "\(contacts[row])\t\(draft)\n"
                let file = dir.appendingPathComponent("messages.txt")
                if let handle = try? FileHandle(forWritingTo: file) {
                    handle.seekToEndOfFile()
                    handle.write(line.data(using: .utf8)!)
                    try? handle.close()
                } else {
                    try? line.write(to: file, atomically: true, encoding: .utf8)
                }
                draft = ""
            }
        } else if let chars = event.characters, !event.modifierFlags.contains(.command) {
            draft += chars
        }
        needsDisplay = true
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var moves: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ note: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        appItem.submenu!.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem()
        editItem.submenu = NSMenu(title: "Edit")
        editItem.submenu!.addItem(withTitle: "Paste", action: #selector(ChatView.paste(_:)), keyEquivalent: "v")
        menu.addItem(appItem)
        menu.addItem(editItem)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "OpaqueChat"
        window.contentView = ChatView()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let titleBar = window.frame.height - window.contentLayoutRect.height
        try? "{\"title_bar\": \(titleBar)}".write(to: dir.appendingPathComponent("layout.json"), atomically: true, encoding: .utf8)

        signal(SIGUSR1, SIG_IGN)
        moves = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        moves!.setEventHandler { [weak self] in
            guard let w = self?.window else { return }
            w.setFrameOrigin(NSPoint(x: w.frame.minX + 60, y: w.frame.minY))
        }
        moves!.resume()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
