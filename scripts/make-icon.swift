// Renders the 1ops dock icon (🔑 on a dark rounded tile) to a 1024px PNG.
// Usage: swift make-icon.swift /path/to/out.png
import AppKit
import Foundation

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Dark rounded background (matches the dashboard's --bg/--panel).
let rect = NSRect(x: 0, y: 0, width: size, height: size)
let tile = NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185)
NSColor(calibratedRed: 0.09, green: 0.11, blue: 0.14, alpha: 1).setFill()
tile.fill()

// Centered key emoji.
let emoji = "🔑" as NSString
let para = NSMutableParagraphStyle()
para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 600),
    .paragraphStyle: para,
]
let s = emoji.size(withAttributes: attrs)
emoji.draw(at: NSPoint(x: (size - s.width) / 2, y: (size - s.height) / 2 - 24), withAttributes: attrs)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("failed to render icon\n".data(using: .utf8)!)
    exit(1)
}
do { try png.write(to: URL(fileURLWithPath: out)) } catch { exit(1) }
