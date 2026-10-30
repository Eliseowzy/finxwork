// Draws the disk image's background (build/dmg/background.png and
// background@2x.png): a light 640 × 400 window with an arrow in the brand
// blue (--accent, renderer/src/styles/tokens.css) from where finxwork sits
// to where Applications sits (build/dmg/settings.py's icon_locations).
//
//   swift scripts/make-dmg-background.swift build/dmg

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/dmg"
let (width, height) = (640, 400)

func srgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

func draw(scale: Int, to file: String) {
  let ctx = CGContext(
    data: nil, width: width * scale, height: height * scale, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
  // CoreGraphics counts y from the bottom; the window's points from the top.
  ctx.translateBy(x: 0, y: CGFloat(height))
  ctx.scaleBy(x: 1, y: -1)

  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [srgb(0xFCFCFD), srgb(0xF1F2F5)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: height), options: [])

  ctx.setStrokeColor(srgb(0x1F6BFF, 0.85))
  ctx.setLineWidth(2.5)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)
  ctx.move(to: CGPoint(x: 276, y: 190))
  ctx.addLine(to: CGPoint(x: 362, y: 190))
  ctx.move(to: CGPoint(x: 352, y: 180))
  ctx.addLine(to: CGPoint(x: 364, y: 190))
  ctx.addLine(to: CGPoint(x: 352, y: 200))
  ctx.strokePath()

  let image = ctx.makeImage()!
  let url = URL(fileURLWithPath: file)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  // The pixels per inch say which is the 2× image.
  let dpi = 72 * scale
  CGImageDestinationAddImage(dest, image, [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(file)") }
}

draw(scale: 1, to: "\(dir)/background.png")
draw(scale: 2, to: "\(dir)/background@2x.png")
