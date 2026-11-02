import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

// A two-page form with a text field on its first page.
function formPdf() {
  return testPdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 6 0 R >> >> >> >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Annots [5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [30 180 260 210] /P 3 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function testPdf(objects) {
  let pdf = "%PDF-1.4\n";
  const entries = objects.map((obj, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return String(offset).padStart(10, "0") + " 00000 n \n";
  });
  const size = objects.length + 1;
  return pdf + `xref\n0 ${size}\n0000000000 65535 f \n${entries.join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF`;
}

async function checkScanSelection(app, page) {
  const { pixels, right } = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1000, height: 500 });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1000, 500);
    ctx.fillStyle = "black";
    ctx.font = "56px sans-serif";
    ctx.fillText("Select these words", 100, 225);
    ctx.fillText("from a scanned page.", 100, 300);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const bits = new Uint8Array(canvas.width * canvas.height / 8);
    for (let i = 0; i < canvas.width * canvas.height; i++) {
      if (rgba[4 * i] >= 128) bits[i >> 3] |= 0x80 >> (i % 8);
    }
    return { pixels: Array.from(bits), right: 100 + ctx.measureText("Select these words").width };
  });
  const image = deflateSync(Buffer.from(pixels)).toString("hex") + ">";
  // The scan is upright when displayed, on a rotated, offset page with a non-default unit.
  const draw = "q 0 400 -200 0 220 30 cm /Scan Do Q";
  const native = draw + "\nBT /F 12 Tf 30 50 Td (Embedded text) Tj ET";
  const pageDict = "/Type /Page /Parent 2 0 R /MediaBox [20 30 220 430] /Rotate 90 /UserUnit 1.25";
  const resources = "/Resources << /XObject << /Scan 5 0 R >> /Font << /F 8 0 R >> >>";
  const pdf = testPdf([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    `<< ${pageDict} ${resources} /Contents 6 0 R >>`, `<< ${pageDict} ${resources} /Contents 7 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width 1000 /Height 500 /ImageMask true /BitsPerComponent 1 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${image.length} >>\nstream\n${image}\nendstream`,
    ...[draw, native].map(s => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
  await app.evaluate(({ BrowserWindow }, pdf) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Mixed scan.pdf", data: Buffer.from(pdf) }), pdf);
  await page.waitForFunction(() => document.title.startsWith("Mixed scan.pdf"));
  const scan = page.locator('.page[data-page-number="1"]');
  const firstWord = scan.locator(".textLayer span", { hasText: /^Select\s*$/ });
  await firstWord.waitFor({ timeout: 45_000 });
  await page.getByTitle(/^Zoom in/).click();
  await firstWord.scrollIntoViewIfNeeded();
  const box = await scan.locator(".canvasWrapper").boundingBox();
  const first = await firstWord.boundingBox();
  const last = await scan.locator(".textLayer span", { hasText: /^words$/ }).boundingBox();
  assert.ok(Math.abs(first.x - box.x - box.width * 0.1) < box.width * 0.01);
  assert.ok(Math.abs(last.x + last.width - box.x - box.width * right / 1000) < box.width * 0.01);
  const y = box.y + box.height * 205 / 500;
  await page.mouse.move(first.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 2, y, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("dialog", { name: "Selected text" }).waitFor();
  assert.equal((await page.evaluate(() => getSelection().toString())).trim(), "Select these words");
  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await scan.locator(".highlightEditor").waitFor();
  await page.getByTitle("Next page").click();
  const mixed = page.locator('.page[data-page-number="2"] .textLayer');
  await mixed.getByText("Embedded text", { exact: true }).waitFor();
  assert.equal((await mixed.innerText()).trim(), "Embedded text");
  console.log("ok  an image-only page gains selectable, highlightable text at the scanned coordinates");
}

async function captureDownload(app, file) {
  await app.evaluate(({ session }, file) => {
    globalThis.folioReordered = new Promise(resolve => session.defaultSession.once("will-download", (_, item) => {
      item.setSavePath(file);
      item.once("done", (_, state) => resolve(state));
    }));
  }, file);
}

export async function checkReaderTools(app, page, folder) {
  const settings = () => page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  const wheelSwitch = page.getByRole("switch", { name: "Scroll one page at a time" });
  const wheel = options => page.locator(".viewer-container").evaluate((el, options) =>
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...options })), options);
  const atPage = n => page.waitForFunction(n => document.querySelector('[aria-label="Page number"]').value === String(n), n);
  await settings();
  assert.equal(await wheelSwitch.getAttribute("aria-checked"), "false");
  await wheelSwitch.click();
  await page.keyboard.press("Escape");
  await page.locator(".viewer-container").hover();
  await page.mouse.wheel(0, 100);
  await atPage(2);
  await wheel({ deltaY: 3, deltaMode: 1 });
  await atPage(3);
  await wheel({ deltaY: -1, deltaMode: 2 });
  await atPage(2);
  assert.equal(await wheel({ deltaX: 100 }), true);
  await page.locator(".viewer-container").evaluate(el => {
    for (const deltaY of [5, 10, 12, 100, 8, 3, 1]) el.dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }));
  });
  await atPage(3);
  await page.reload();
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor();
  await settings();
  assert.equal(await wheelSwitch.getAttribute("aria-checked"), "true");
  await wheelSwitch.click();
  await page.keyboard.press("Escape");
  assert.equal(await wheel({ deltaY: 3, deltaMode: 1 }), true);
  console.log("ok  wheel notches and trackpad swipes turn pages, and the setting survives reopening");

  // A deterministic response exercises the real stream and buttons without signing in or sending document data.
  const answer = "**Two points** (p. 1)\n\n- First\n- Second";
  await app.evaluate(({ ipcMain }, answer) => {
    for (const name of ["folio:ai-status", "folio:ai-chatgpt-models", "folio:ai-ask"]) ipcMain.removeHandler(name);
    ipcMain.handle("folio:ai-status", () => ({ chatgpt: { connected: true, welcomeSeen: true }, claude: { installed: false } }));
    ipcMain.handle("folio:ai-chatgpt-models", () => ({ ok: true, models: [{ id: "local", name: "Local test" }] }));
    ipcMain.handle("folio:ai-ask", (event, { id }) => {
      event.sender.send("folio:ai-event", { id, type: "delta", text: answer });
      event.sender.send("folio:ai-event", { id, type: "done" });
      return true;
    });
  }, answer);
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await page.getByRole("button", { name: "Summarize this document" }).click();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async text => { window.folioCopiedResponse = text; };
  });
  const copyResponse = page.getByTitle("Copy response as Markdown");
  await copyResponse.click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.folioCopiedResponse), answer);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Denied"); }; });
  await copyResponse.click();
  await page.getByRole("button", { name: "Copy failed" }).waitFor();
  await page.evaluate(() => { delete navigator.clipboard.writeText; });
  await page.getByRole("button", { name: "Close Ask AI" }).click();
  console.log("ok  Copy response copies the original Markdown and reports a refused write");

  const sidebar = page.getByRole("button", { name: /Toggle sidebar/ });
  if (await sidebar.getAttribute("aria-pressed") !== "true") await sidebar.click();
  await page.getByRole("tab", { name: "Outline" }).click();
  await page.getByRole("button", { name: "Reorder pages" }).click();
  const thumb = n => page.locator(`.thumb[data-page="${n}"]`);
  await thumb(1).dragTo(thumb(2));
  assert.equal(await thumb(1).getAttribute("aria-label"), "Page 1, position 2");
  await page.getByLabel("Move page 1 to").fill("3");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  assert.equal(await thumb(1).getAttribute("aria-label"), "Page 1, position 3");
  const file = path.join(folder, "reordered.pdf");
  await captureDownload(app, file);
  await page.getByRole("button", { name: "Save reordered copy" }).click();
  const openCopy = page.getByRole("button", { name: "Open reordered copy" });
  await openCopy.waitFor();
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  const result = await page.evaluate(async bytes => {
    const read = async data => {
      const task = pdfjsLib.getDocument({ data });
      const pdf = await task.promise;
      try {
        const pages = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const p = await pdf.getPage(n);
          pages.push({ text: (await p.getTextContent()).items.map(i => i.str).join(" "),
            marks: (await p.getAnnotations()).map(a => a.subtype) });
        }
        const [bookmark] = await pdf.getOutline();
        const dest = typeof bookmark.dest === "string" ? await pdf.getDestination(bookmark.dest) : bookmark.dest;
        return { pages, bookmark: await pdf.getPageIndex(dest[0]) };
      } finally { await task.destroy(); }
    };
    return { original: await read(await (await fetch("sample.pdf")).arrayBuffer()), reordered: await read(Uint8Array.from(bytes)) };
  }, Array.from(readFileSync(file)));
  const { original, reordered } = result;
  const order = original.pages.map((_, i) => i);
  order.splice(2, 0, order.shift());
  assert.deepEqual(reordered.pages.map(p => p.text), order.map(i => original.pages[i].text));
  assert.equal(reordered.bookmark, order.indexOf(original.bookmark));
  assert.ok(reordered.pages[2].marks.includes("FreeText") && reordered.pages[2].marks.includes("Highlight"));
  assert.ok(reordered.pages.at(-1).marks.includes("Highlight"));
  await openCopy.click();
  await page.waitForFunction(() => document.title.includes("(reordered).pdf"));
  console.log("ok  reordered PDF pages, bookmark destinations and annotations match the sidebar order");

  await app.evaluate(({ BrowserWindow }, form) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Form.pdf", data: Buffer.from(form) }), formPdf());
  const field = page.locator(".textWidgetAnnotation input");
  await field.fill("A filled field");
  await page.getByRole("tab", { name: "Pages" }).click();
  await page.getByRole("button", { name: "Reorder pages" }).click();
  await page.getByLabel("Move page 1 to").fill("2");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await captureDownload(app, path.join(folder, "reordered-form.pdf"));
  await page.keyboard.press("ControlOrMeta+s");
  await openCopy.click();
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  await page.waitForFunction(() => document.title.startsWith("Form (reordered).pdf"));
  await page.getByTitle("Next page").click();
  assert.equal(await page.locator('.page[data-page-number="2"] .textWidgetAnnotation input').inputValue(), "A filled field");
  console.log("ok  the normal Save shortcut and Open reordered copy preserve filled form fields");
  await checkScanSelection(app, page);
}
