// Draws the app icon's mark (build/darwin/AppIcon.icon/Assets/mark.png): the
// "f" of the window's placeholder mark (renderer/src/icons.tsx), white on a
// transparent 1024 px canvas, centred. The icon's colour is icon.json's fill.
//
//   swift scripts/make-mark.swift build/darwin/AppIcon.icon/Assets/mark.png

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
// The mark is drawn on a 16-unit grid; the glyph's middle is at (7.6, 8).
let scale = 56.0
let dx = Double(size) / 2 - 7.6 * scale
let dy = Double(size) / 2 - 8 * scale

let ctx = CGContext(
  data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
// CoreGraphics counts y from the bottom, the SVG from the top.
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineWidth(1.7 * scale)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)

func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * scale + dx, y: y * scale + dy) }

// M6.4 12V6c0-1.2.8-2 2-2h1.8 M5 7.4h4.4
let path = CGMutablePath()
path.move(to: p(6.4, 12))
path.addLine(to: p(6.4, 6))
path.addCurve(to: p(8.4, 4), control1: p(6.4, 4.8), control2: p(7.2, 4))
path.addLine(to: p(10.2, 4))
path.move(to: p(5, 7.4))
path.addLine(to: p(9.4, 7.4))
ctx.addPath(path)
ctx.strokePath()

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
