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
  const resources = scan => `/Resources << /XObject << /Scan ${scan} 0 R >> /Font << /F 8 0 R >> >>`;
  const imageObject = kind => `<< /Type /XObject /Subtype /Image /Width 1000 /Height 500 ${kind} /BitsPerComponent 1 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${image.length} >>\nstream\n${image}\nendstream`;
  const pdf = testPdf([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 5 /Kids [4 0 R 3 0 R 9 0 R 11 0 R 12 0 R] >>",
    `<< ${pageDict} ${resources(5)} /Contents 6 0 R >>`, `<< ${pageDict} ${resources(5)} /Contents 7 0 R >>`,
    imageObject("/ColorSpace /DeviceGray"),
    ...[draw, native].map(s => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< ${pageDict} ${resources(10)} /Contents 6 0 R >>`, imageObject("/ImageMask true"),
    `<< ${pageDict} ${resources(5)} /Contents 6 0 R >>`, `<< ${pageDict} ${resources(5)} /Contents 6 0 R >>`,
  ]);
  // Hold OCR at the worker boundary so queue priority and loading messages are independent of CPU speed.
  await page.window.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    let jobs = 0;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.action !== "recognize") return post.call(this, message, ...rest);
      window.ocrJob = ++jobs;
      window.resumeOcr = () => post.call(this, message, ...rest);
      if (jobs === 4) {
        Worker.prototype.postMessage = post;
        window.failOcr = () => this.dispatchEvent(new MessageEvent("message", {
          data: { action: "recognize", jobId: message.jobId, status: "reject", data: "Test recognition failure" },
        }));
      }
    };
  });
  await app.evaluate(({ BrowserWindow }, pdf) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Mixed scan.pdf", data: Buffer.from(pdf) }), pdf);
  await page.window.waitForFunction(() => document.title.startsWith("Mixed scan.pdf"));
  const scan = page.locator('.page[data-page-number="2"]');
  const pageNumber = page.getByLabel("Page number");
  const goTo = async n => { await pageNumber.fill(String(n)); await pageNumber.press("Enter"); };
  const status = page.locator(".page-text-status");
  const waitForJob = n => page.waitForFunction(n => window.ocrJob === n, n, { timeout: 45_000 });
  await waitForJob(1);
  assert.equal(await pageNumber.inputValue(), "1");
  const mixed = page.locator('.page[data-page-number="1"] .textLayer');
  await mixed.getByText("Embedded text", { exact: true }).waitFor();
  assert.equal((await mixed.innerText()).trim(), "Embedded text");
  await goTo(2);
  await status.filter({ hasText: "Recognizing text on page 2…" }).waitFor();
  await page.evaluate(() => window.resumeOcr());
  const firstWord = scan.locator(".textLayer span", { hasText: /^Select\s*$/ });
  await firstWord.waitFor({ timeout: 45_000 });
  await waitForJob(2); // Page 3 is already being recognized while the reader is still on page 2.
  assert.equal(await pageNumber.inputValue(), "2");
  assert.equal(await status.innerText(), "");
  await page.getByTitle(/^Zoom in/).click();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitemcheckbox", { name: "PDF dark mode" }).click();
  await scan.locator(".canvasWrapper > .folio-image-overlay").waitFor();
  await firstWord.scrollIntoViewIfNeeded();
  const box = await scan.locator(".canvasWrapper").boundingBox();
  const first = await firstWord.boundingBox();
  const last = await scan.locator(".textLayer span", { hasText: /^words$/ }).boundingBox();
  assert.ok(Math.abs(first.x - box.x - box.width * 0.1) < box.width * 0.01);
  assert.ok(Math.abs(last.x + last.width - box.x - box.width * right / 1000) < box.width * 0.01);
  const y = box.y + box.height * 205 / 500;
  const clip = { x: Math.ceil(first.x + 2), y: Math.floor(y - 2), width: Math.floor(first.width / 2), height: 4 };
  const unselected = await page.screenshot({ clip });
  // Readers often drag from just before the first letter to just past the last.
  await page.mouse.move(first.x - 5, y);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width + 5, y, { steps: 12 });
  await page.waitForFunction(() => getSelection().toString().trim() === "Select these words");
  assert.ok(!unselected.equals(await page.screenshot({ clip })), "the scan hid the live selection in PDF dark mode");
  await page.mouse.up();
  await page.getByRole("dialog", { name: "Selected text" }).waitFor();
  assert.equal((await page.evaluate(() => getSelection().toString())).trim(), "Select these words");
  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await scan.locator(".highlightEditor").waitFor();
  await goTo(5);
  await status.filter({ hasText: "Preparing text on page 5…" }).waitFor();
  await page.evaluate(() => window.resumeOcr());
  await waitForJob(3);
  assert.equal(await status.innerText(), "Recognizing text on page 5…");
  await page.evaluate(() => window.resumeOcr());
  await page.locator('.page[data-page-number="5"] .ocr-word').first().waitFor();
  assert.equal(await status.innerText(), "");
  await goTo(3);
  await page.locator('.page[data-page-number="3"] .textLayer').getByText("Select", { exact: true }).waitFor();
  await waitForJob(4);
  await goTo(4);
  await page.evaluate(() => window.failOcr());
  await status.filter({ hasText: "Text unavailable on page 4." }).waitFor();
  await goTo(3);
  await goTo(4);
  await page.locator('.page[data-page-number="4"] .ocr-word').first().waitFor();
  assert.equal(await status.innerText(), "");
  console.log("ok  background OCR prepares unvisited scans, prioritizes page jumps, and shows selectable text in dark mode");
}

async function captureDownload(app, file) {
  await app.evaluate(({ session }, file) => {
    globalThis.folioReordered = new Promise(resolve => session.defaultSession.once("will-download", (_, item) => {
      item.setSavePath(file);
      item.once("done", (_, state) => resolve(state));
    }));
  }, file);
}

async function checkContentEditing(app, page, folder, shots) {
  // Two identical text runs and two placements of one image, also reused on the second page.
  const words = "BT /F 16 Tf 12 170 Td (Orig) Tj 29.34 0 Td (inal) Tj -29.34 -25 Td (Original) Tj ET";
  const images = "% /Logo Do\n/Artifact << /Details (literal /Logo Do) >> BDC q 10 20 24 40 re W n "
    + "40 0 0 40 10 20 cm /Logo Do Q EMC\nq 40 0 0 40 80 20 cm /Logo Do Q";
  const pageDict = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources 10 0 R /Contents 9 0 R >>";
  const stream = s => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  const original = testPdf([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    pageDict, pageDict,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream",
    stream(words), stream(images), "[7 0 R 8 0 R]", "<< /Font << /F 5 0 R >> /XObject << /Logo 6 0 R >> >>",
  ]);
  await app.evaluate(({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Objects.pdf", data: Buffer.from(file) }), original);
  await page.window.waitForFunction(() => document.title.startsWith("Objects.pdf"));
  const sidebar = page.getByRole("button", { name: /Toggle sidebar/ });
  if (await sidebar.getAttribute("aria-pressed") !== "true") await sidebar.click();
  await page.getByRole("tab", { name: "Pages", exact: true }).click();
  await page.getByRole("button", { name: "Bookmark page 2", exact: true }).click();
  const openEditor = async () => {
    await page.getByRole("button", { name: "Edit mode", exact: true }).click();
    assert.equal(await page.getByRole("dialog").count(), 0);
  };
  const sheet = page.locator('.page[data-page-number="1"]');
  const item = name => sheet.getByRole("button", { name, exact: true });
  const input = sheet.getByRole("textbox", { name: "Edit text on page" });
  const save = page.getByRole("button", { name: "Save copy", exact: true });
  await sheet.locator(".textLayer").getByText("Original", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(shots, "before-pdf-edit.png") });
  await openEditor();
  const rotation = page.getByTitle("Rotate (R)");
  await rotation.click();
  await page.keyboard.press("ControlOrMeta+=");
  const checkRotatedTarget = () => page.waitForFunction(() => {
    const p = document.querySelector('.page[data-page-number="1"]');
    const canvas = p?.querySelector(".canvasWrapper")?.getBoundingClientRect();
    const logo = p?.querySelector('button[aria-label="Image 1"]')?.getBoundingClientRect();
    return canvas && logo && Math.abs((logo.left - canvas.left) / canvas.width - 0.1) < 0.012
      && Math.abs((logo.top - canvas.top) / canvas.height - 0.05) < 0.012;
  }, null, { timeout: 15_000 });
  await checkRotatedTarget();
  const pageWidth = await sheet.locator(".canvasWrapper").evaluate(el => el.getBoundingClientRect().width);
  await item("Original").first().click();
  await input.fill("Cancel me"); await input.press("Escape");
  assert.equal(await input.count(), 0);
  await item("Original").first().click();
  await input.fill("𐍈"); await input.press("Enter");
  await page.getByText(/This font can.t display all of those characters/).waitFor();
  await input.fill("Revised");
  await item("Image 1").click();
  await item("Revised").waitFor();
  await sheet.locator(".textLayer").getByText("Revised", { exact: true }).waitFor();
  await sheet.getByRole("button", { name: /Replace image/ }).waitFor();
  await checkRotatedTarget();
  assert.ok(Math.abs(await sheet.locator(".canvasWrapper").evaluate(el => el.getBoundingClientRect().width) - pageWidth) < 2);
  const png = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 2, height: 2 });
    const g = canvas.getContext("2d");
    g.fillStyle = "#0000ff"; g.fillRect(0, 0, 2, 2);
    return canvas.toDataURL().split(",")[1];
  });
  await sheet.getByLabel("Replacement image").setInputFiles({ name: "blue.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.getByRole("button", { name: "Exit edit mode" }).click();
  await page.getByRole("button", { name: "Edit mode", exact: true }).waitFor();
  assert.equal(await sheet.locator(".folio-content-layer").count(), 0);
  await openEditor();
  const file = path.join(folder, "edited.pdf");
  await captureDownload(app, file);
  await save.click();
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  await page.window.waitForFunction(() => document.title.startsWith("Objects (edited).pdf"));
  await page.getByRole("button", { name: "Bookmark page 2", pressed: true }).waitFor();
  // Read and rasterize the downloaded bytes with the independent reader, including the untouched page.
  const result = await page.evaluate(async bytes => {
    const task = pdfjsLib.getDocument({ data: Uint8Array.from(bytes) });
    const pdf = await task.promise;
    try {
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const p = await pdf.getPage(i), canvas = document.createElement("canvas");
        canvas.width = 200; canvas.height = 200;
        await p.render({ canvas, viewport: p.getViewport({ scale: 1 }) }).promise;
        const g = canvas.getContext("2d");
        pages.push({ text: (await p.getTextContent()).items.map(x => x.str).filter(Boolean),
          images: [30, 45, 100].map(x => [...g.getImageData(x, 160, 1, 1).data]), annotations: (await p.getAnnotations()).length });
      }
      return pages;
    } finally { await task.destroy(); }
  }, Array.from(readFileSync(file)));
  const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], white = [255, 255, 255, 255];
  assert.deepEqual(result, [
    { text: ["Revised", "Original"], images: [blue, white, red], annotations: 0 },
    { text: ["Original", "Original"], images: [red, white, red], annotations: 0 },
  ]);
  console.log("ok  edited copy contains replacement text and image pixels only at the chosen placements");

  await openEditor();
  await item("Original").click();
  await input.fill("");
  await captureDownload(app, path.join(folder, "removed-text.pdf"));
  await page.keyboard.press("ControlOrMeta+s");
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  await page.window.waitForFunction(() => document.title.startsWith("Objects (edited) (edited).pdf"));
  const removed = page.locator('.page[data-page-number="1"] .textLayer');
  await removed.getByText("Revised", { exact: true }).waitFor();
  assert.equal((await removed.innerText()).trim(), "Revised");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const history = page.getByRole("complementary", { name: "Version history" });
  await history.getByRole("heading", { name: "Version 3 This PDF" }).waitFor();
  assert.equal(await history.locator(".version-entry").count(), 3);
  await history.getByText("blue.png").waitFor();
  await page.screenshot({ path: path.join(shots, "after-pdf-edit.png") });
  assert.equal(await history.locator("ins").innerText(), "Revised");
  const recovered = path.join(folder, "original-version.pdf");
  await captureDownload(app, recovered);
  await history.getByRole("button", { name: "Download version 1" }).click();
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  assert.deepEqual(readFileSync(recovered), Buffer.from(original));
  await history.getByRole("button", { name: "Open version 1" }).click();
  await page.window.waitForFunction(() => document.title.startsWith("Objects.pdf"));
  await sheet.locator(".textLayer").getByText("Original", { exact: true }).first().waitFor();
  console.log("ok  version history groups edits by save and recovers the exact original");

  await app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Text runs.pdf", data: Buffer.concat([Buffer.from(data), Buffer.from("\n% Inline editing fixture\n")]) }),
    await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("sample.pdf")).arrayBuffer()))));
  await page.window.waitForFunction(() => document.title.startsWith("Text runs.pdf"));
  const number = page.getByLabel("Page number", { exact: true });
  await number.fill("1"); await number.press("Enter");
  await openEditor();
  await sheet.getByRole("button", { name: /A short tour of Folio/ }).first().click();
  await input.fill("A tour of Folio"); await input.press("Enter");
  await item("A tour of Folio").waitFor();
  await captureDownload(app, path.join(folder, "edited-sample.pdf"));
  await save.click();
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  await page.window.waitForFunction(() => document.title.startsWith("Text runs (edited).pdf"));
  await page.locator('.page[data-page-number="1"] .textLayer').getByText("A tour of Folio", { exact: true }).waitFor();
  console.log("ok  fragmented embedded-font text in Folio's sample edits as a line and reopens in the reader");
}

export async function checkReaderTools(app, page, folder, shots) {
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
  await page.window.waitForFunction(() => document.title.includes("(reordered).pdf"));
  console.log("ok  reordered PDF pages, bookmark destinations and annotations match the sidebar order");

  await app.evaluate(({ BrowserWindow }, form) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Form.pdf", data: Buffer.from(form) }), formPdf());
  const field = page.locator(".textWidgetAnnotation input");
  await field.fill("A filled field");
  const documents = page.getByRole("tablist", { name: "Open documents" });
  await documents.getByRole("button", { name: "Close Form.pdf, unsaved changes" }).waitFor();
  await page.keyboard.press("Control+Shift+Tab");
  await documents.getByRole("tab", { name: "Form.pdf", exact: true }).click();
  assert.equal(await field.inputValue(), "A filled field");
  await page.getByRole("tab", { name: "Pages" }).click();
  await page.getByRole("button", { name: "Reorder pages" }).click();
  await page.getByLabel("Move page 1 to").fill("2");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await captureDownload(app, path.join(folder, "reordered-form.pdf"));
  await page.keyboard.press("ControlOrMeta+s");
  await openCopy.click();
  assert.equal(await app.evaluate(() => globalThis.folioReordered), "completed");
  await page.window.waitForFunction(() => document.title.startsWith("Form (reordered).pdf"));
  await page.getByTitle("Next page").click();
  assert.equal(await page.locator('.page[data-page-number="2"] .textWidgetAnnotation input').inputValue(), "A filled field");
  console.log("ok  the normal Save shortcut and Open reordered copy preserve filled form fields");
  await checkScanSelection(app, page);
  await checkContentEditing(app, page, folder, shots);
}
