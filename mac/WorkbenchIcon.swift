import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Compile this file with swiftc and run it with an output path ending in .iconset.
// Then run iconutil -c icns on the generated iconset.

private let rgb = CGColorSpace(name: CGColorSpace.sRGB)!

private func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    let red = CGFloat((hex >> 16) & 255) / 255
    let green = CGFloat((hex >> 8) & 255) / 255
    let blue = CGFloat(hex & 255) / 255
    return CGColor(srgbRed: red, green: green, blue: blue, alpha: alpha)
}

private func gradient(
    _ context: CGContext,
    in shape: CGPath,
    colors: [CGColor],
    from start: CGPoint,
    to end: CGPoint
) {
    context.saveGState()
    context.addPath(shape)
    context.clip()
    let fill = CGGradient(colorsSpace: rgb, colors: colors as CFArray, locations: nil)!
    context.drawLinearGradient(fill, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    context.restoreGState()
}

private func circle(at point: CGPoint, radius: CGFloat) -> CGPath {
    CGPath(
        ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius),
        transform: nil
    )
}

private func rounded(_ rect: CGRect, radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

private func fill(
    _ context: CGContext,
    _ shape: CGPath,
    _ tint: CGColor
) {
    context.setFillColor(tint)
    context.addPath(shape)
    context.fillPath()
}

private func drawReceiver(_ context: CGContext) {
    context.saveGState()
    context.translateBy(x: 512, y: 512)
    context.rotate(by: -.pi / 16)
    context.translateBy(x: -512, y: -512)

    let shell = rounded(CGRect(x: 232, y: 306, width: 560, height: 411), radius: 138)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -25), blur: 55, color: color(0x070B16, alpha: 0.76))
    fill(context, shell, color(0xE4E1DB))
    context.restoreGState()
    gradient(context, in: shell,
             colors: [color(0xFFFBED), color(0xF3EFE5), color(0xB9BECD)],
             from: CGPoint(x: 327, y: 648), to: CGPoint(x: 691, y: 283))

    let lid = CGMutablePath()
    lid.move(to: CGPoint(x: 185, y: 756))
    lid.addLine(to: CGPoint(x: 836, y: 756))
    lid.addLine(to: CGPoint(x: 836, y: 589))
    lid.addCurve(to: CGPoint(x: 185, y: 573),
                 control1: CGPoint(x: 634, y: 625), control2: CGPoint(x: 390, y: 621))
    lid.closeSubpath()
    context.saveGState()
    context.addPath(shell)
    context.clip()
    gradient(context, in: lid,
             colors: [color(0x586277), color(0x293349), color(0x182135)],
             from: CGPoint(x: 310, y: 745), to: CGPoint(x: 628, y: 576))
    context.restoreGState()

    let faceplate = rounded(CGRect(x: 301, y: 391, width: 422, height: 145), radius: 72)
    gradient(context, in: faceplate,
             colors: [color(0x20283B), color(0x39435A)],
             from: CGPoint(x: 425, y: 546), to: CGPoint(x: 610, y: 389))

    for x: CGFloat in [382, 446, 510] {
        let slot = rounded(CGRect(x: x - 13, y: 435, width: 26, height: 57), radius: 13)
        fill(context, slot, color(0xC5CEDE))
    }
    let signal = circle(at: CGPoint(x: 638, y: 464), radius: 47)
    gradient(context, in: signal,
             colors: [color(0xFFD782), color(0xFF9167), color(0xF16748)],
             from: CGPoint(x: 626, y: 510), to: CGPoint(x: 656, y: 412))
    context.restoreGState()
}

private func renderIcon(pixels: Int) throws -> CGImage {
    let context = try require(CGContext(
        data: nil,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: rgb,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    let scale = CGFloat(pixels) / 1024
    context.scaleBy(x: scale, y: scale)
    context.setAllowsAntialiasing(true)

    let tile = rounded(CGRect(x: 86, y: 86, width: 852, height: 852), radius: 194)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -20), blur: 49, color: color(0x19213A, alpha: 0.44))
    fill(context, tile, color(0x262E43))
    context.restoreGState()

    gradient(
        context,
        in: tile,
        colors: [color(0x56617C), color(0x323C55), color(0x131C2F)],
        from: CGPoint(x: 220, y: 960),
        to: CGPoint(x: 755, y: 71)
    )
    let rim = rounded(CGRect(x: 96, y: 96, width: 832, height: 832), radius: 187)
    context.setStrokeColor(color(0xC6D3F8, alpha: 0.26))
    context.setLineWidth(7)
    context.addPath(rim)
    context.strokePath()

    drawReceiver(context)

    return try require(context.makeImage())
}

private enum IconError: Error {
    case usage
    case generationFailed
}

private func require<Value>(_ value: Value?) throws -> Value {
    guard let value else { throw IconError.generationFailed }
    return value
}

@main
enum WorkbenchIcon {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw IconError.usage }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        guard directory.pathExtension == "iconset" else { throw IconError.usage }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for points in [16, 32, 128, 256, 512] {
            for density in [1, 2] {
                let suffix = density == 1 ? "" : "@2x"
                let url = directory.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
                let destination = try require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
                let image = try renderIcon(pixels: points * density)
                CGImageDestinationAddImage(destination, image, nil)
                guard CGImageDestinationFinalize(destination) else { throw IconError.generationFailed }
            }
        }
    }
}
