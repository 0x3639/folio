// Uses only macOS system frameworks; opens no application windows.
import Foundation
import AppKit
import PDFKit

func fail(_ message: String) -> Never {
    fputs("FAIL PDFKit: \(message)\n", stderr)
    exit(1)
}

let directory = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "release/smoke"
func load(_ name: String) -> PDFDocument {
    guard let document = PDFDocument(url: URL(fileURLWithPath: directory).appendingPathComponent(name)) else {
        fail("could not open \(name)")
    }
    return document
}

func render(_ document: PDFDocument, _ number: Int) -> [UInt8] {
    guard let page = document.page(at: number),
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 600, pixelsHigh: 600,
              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
              colorSpaceName: .deviceRGB, bytesPerRow: 2400, bitsPerPixel: 32),
          let context = NSGraphicsContext(bitmapImageRep: bitmap)?.cgContext,
          let pixels = bitmap.bitmapData else { fail("could not prepare page \(number + 1)") }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 600, height: 600))
    let bounds = page.bounds(for: .cropBox)
    context.scaleBy(x: 600 / bounds.width, y: 600 / bounds.height)
    page.draw(with: .cropBox, to: context)
    context.flush()
    return Array(UnsafeBufferPointer(start: pixels, count: 600 * 2400))
}

let editable = load("standard-viewer-editable.pdf")
let flattened = load("standard-viewer-flattened.pdf")
guard editable.pageCount == flattened.pageCount, editable.pageCount == 14 else { fail("unexpected fixture pages") }
for index in 0..<editable.pageCount {
    let original = render(editable, index), final = render(flattened, index)
    var ink = 0, changed = 0
    for pixel in stride(from: 0, to: original.count, by: 4) {
        if (0..<3).contains(where: { original[pixel + $0] < 230 }) { ink += 1 }
        if (0..<3).contains(where: { abs(Int(original[pixel + $0]) - Int(final[pixel + $0])) > 12 }) { changed += 1 }
    }
    if ink < 40 { fail("page \(index + 1) has no visible marks") }
    if changed >= 600 { fail("page \(index + 1) differs from its flattened appearance at \(changed) pixels") }
}
let hidden = load("standard-viewer-hidden.pdf")
for index in 0..<hidden.pageCount {
    let pixels = render(hidden, index)
    if stride(from: 0, to: pixels.count, by: 4).contains(where: { pixel in (0..<3).contains(where: { pixels[pixel + $0] < 230 }) }) {
        fail("hidden layer is visible on page \(index + 1)")
    }
}
let unicode = render(load("standard-viewer-unicode.pdf"), 0)
let unicodeFinal = render(load("standard-viewer-unicode-final.pdf"), 0)
let unicodeDifferences = stride(from: 0, to: unicode.count, by: 4).filter { pixel in
    (0..<3).contains { abs(Int(unicode[pixel + $0]) - Int(unicodeFinal[pixel + $0])) > 12 }
}.count
if unicodeDifferences >= 600 { fail("embedded Unicode text differs from its flattened appearance") }
print("PASS macOS PDFKit renders all 14 markup/measurement fixtures consistently with flattened copies, including rotated/cropped pages, Unicode fonts and hidden layers")
