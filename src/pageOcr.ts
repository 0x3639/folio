import { AnnotationMode, OPS, type PDFPageProxy } from "pdfjs-dist";
import type { Worker as OcrWorker } from "tesseract.js";
import type { EventBus, PDFPageView, PDFViewer } from "./viewer";

interface Word {
  text: string;
  left: number;
  top: number;
  height: number;
  scaleX: number;
  endOfLine: boolean;
}

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat,
]);

async function hasPageImage(page: PDFPageProxy) {
  if (page.imageCoordinates?.length) return true;
  // pdf.js records locations for ordinary images but not for stencil masks used by some monochrome scans.
  const { fnArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  return fnArray.some(op => IMAGE_OPS.has(op));
}

async function startWorker() {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  const base = `${import.meta.env.BASE_URL}ocr`;
  // Language initialization errors in Tesseract are delivered to errorHandler.
  const worker = await new Promise<OcrWorker>((resolve, reject) => {
    createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: `${base}/worker.min.js`, workerBlobURL: false, corePath: base, langPath: base,
      cacheMethod: "none", errorHandler: reject,
    }).then(resolve, reject);
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  return worker;
}

async function readWords(page: PDFPageProxy, worker: OcrWorker, signal: AbortSignal): Promise<Word[]> {
  signal.throwIfAborted();
  // Read at a consistent resolution even in fit-page mode. Bound both dimensions on oversized scans.
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, 2400 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const render = page.render({ canvas, viewport });
  const cancel = () => render.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await render.promise;
    signal.throwIfAborted();
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    signal.throwIfAborted();
    const ctx = canvas.getContext("2d")!;
    ctx.font = "100px sans-serif";
    const [xMin, yMin, xMax, yMax] = page.view;
    const words: Word[] = [];
    const lines = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(p => p.lines));
    for (const line of lines) {
      const height = line.bbox.y1 - line.bbox.y0;
      for (const [i, word] of line.words.entries()) {
        const width = ctx.measureText(word.text).width;
        if (!width || !height) continue;
        // pdf.js sizes its text layer in unrotated PDF units and rotates the whole layer for display.
        const [x, y] = viewport.convertToPdfPoint(word.bbox.x0, line.bbox.y0);
        words.push({
          text: word.text, endOfLine: i === line.words.length - 1,
          left: 100 * (x - xMin) / (xMax - xMin), top: 100 * (yMax - y) / (yMax - yMin),
          height: height / (scale * page.userUnit), scaleX: 100 * (word.bbox.x1 - word.bbox.x0) / (width * height),
        });
      }
    }
    return words;
  } finally {
    signal.removeEventListener("abort", cancel);
    canvas.width = canvas.height = 0;
  }
}

function addWords(view: PDFPageView, words: Word[]) {
  const layer = view.textLayer?.div;
  const end = layer?.querySelector(":scope > .endOfContent");
  if (!end || layer?.textContent.trim()) return;
  const fragment = document.createDocumentFragment();
  let lineStart = true;
  for (const word of words) {
    const span = document.createElement("span");
    span.className = lineStart ? "ocr-word ocr-line-start" : "ocr-word";
    span.textContent = word.text + (word.endOfLine ? "" : " ");
    span.style.left = `${word.left}%`;
    span.style.top = `${word.top}%`;
    span.style.fontFamily = "sans-serif";
    span.style.setProperty("--font-height", `${word.height}px`);
    span.style.setProperty("--scale-x", String(word.scaleX));
    span.style.setProperty("--rotate", `${-view.pdfPage.rotate}deg`);
    fragment.append(span);
    if (word.endOfLine) fragment.append(document.createElement("br"));
    lineStart = word.endOfLine;
  }
  end.before(fragment);
}

/** Consume the stream one chunk at a time without retaining a whole page's text and fonts. */
async function hasEmbeddedText(page: PDFPageProxy, signal: AbortSignal) {
  const reader = page.streamTextContent().getReader();
  let found = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return found;
      found ||= value.items.some((item: { str?: string }) => item.str?.trim());
    }
    throw signal.reason;
  } finally {
    reader.releaseLock();
  }
}

/** Prepare the document sequentially, giving the reader's current page and its successor the next turns. */
export function recognizeScannedPages(bus: EventBus, viewer: PDFViewer, onStatus: (text: string | null) => void) {
  const pdf = viewer.pdfDocument!;
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set(Array.from({ length: pdf.numPages }, (_, i) => i + 1));
  // Keep small documents ready for the entire session. On huge scans, evicted pages can be read again on demand.
  const cache = new Map<number, Word[]>();
  const evicted = new Set<number>();
  const notices = new Map<number, "noWords" | "ocrError" | "layerError">();
  let nextPage = viewer.currentPageNumber;
  let cachedWords = 0;
  let active = 0;
  let recognizing = false;
  let timer: number | undefined;
  let worker: Promise<OcrWorker> | undefined;
  let workerStartFailed = false;

  function updateStatus() {
    const n = viewer.currentPageNumber;
    const view: PDFPageView = viewer.getPageView(n - 1);
    const layer = view.textLayer?.div;
    if (layer?.isConnected && !layer.hidden && layer.textContent.trim()) onStatus(null);
    else if (notices.get(n) === "noWords") onStatus(`No readable text found on page ${n}.`);
    else if (notices.has(n)) onStatus(`Text unavailable on page ${n}.`);
    else if (active === n && recognizing) onStatus(`Recognizing text on page ${n}…`);
    else if (pending.has(n) || active === n || !layer?.isConnected || layer.hidden || !layer.querySelector(".endOfContent")) {
      onStatus(`Preparing text on page ${n}…`);
    } else onStatus(null);
  }

  function remember(n: number, words: Word[]) {
    cache.set(n, words);
    cachedWords += words.length;
    for (const [old, entry] of cache) {
      if (cachedWords <= 100_000) break;
      if (old === n || Math.abs(old - viewer.currentPageNumber) <= 1) continue;
      cache.delete(old);
      cachedWords -= entry.length;
      evicted.add(old);
    }
  }

  function schedule() {
    if (!signal.aborted && !active && timer === undefined && pending.size) {
      timer = window.setTimeout(prepareNext, 0);
    }
  }

  async function prepareNext() {
    timer = undefined;
    if (!pending.size || signal.aborted) return;
    // Start at the last jump, continue ahead of the reader, then wrap back to the beginning.
    while (!pending.has(nextPage)) nextPage = nextPage % pdf.numPages + 1;
    const n = nextPage;
    nextPage = n % pdf.numPages + 1;
    pending.delete(n);
    active = n;
    const view: PDFPageView = viewer.getPageView(n - 1);
    let page: PDFPageProxy | undefined;
    try {
      page = await pdf.getPage(n);
      signal.throwIfAborted();
      if (await hasEmbeddedText(page, signal)) return;
      signal.throwIfAborted();
      if (!(await hasPageImage(page))) return;
      signal.throwIfAborted();
      if (n !== viewer.currentPageNumber && pending.has(viewer.currentPageNumber)) {
        pending.add(n);
        return;
      }
      recognizing = true;
      if (n === viewer.currentPageNumber) updateStatus();
      worker ??= startWorker().catch(error => { workerStartFailed = true; throw error; });
      const words = await readWords(page, await worker, signal);
      signal.throwIfAborted();
      if (words.length) {
        remember(n, words);
        addWords(view, words);
      } else {
        notices.set(n, "noWords");
      }
    } catch (error) {
      if (!signal.aborted) {
        notices.set(n, "ocrError");
        console.warn("Page OCR failed", error);
      }
    } finally {
      active = 0;
      recognizing = false;
      if (!signal.aborted) {
        // Background renders aren't in the viewer's page buffer, so it won't release their images for us.
        if (!viewer.getCachedPageViews().has(view)) page?.cleanup();
        if (n === viewer.currentPageNumber) updateStatus();
        schedule();
      }
    }
  }

  bus.on("textlayerrendered", ({ source: view, pageNumber: n, error }: { source: PDFPageView; pageNumber: number; error: unknown }) => {
    if (error) {
      notices.set(n, "layerError");
      if (n === viewer.currentPageNumber) updateStatus();
      return;
    }
    if (notices.get(n) === "layerError") notices.delete(n);
    const words = cache.get(n);
    if (words) addWords(view, words);
    else if (evicted.delete(n)) pending.add(n);
    else if (view.textLayer?.div.textContent.trim() && !view.textLayer.div.querySelector(".ocr-word")) pending.delete(n);
    if (n === viewer.currentPageNumber) updateStatus();
    schedule();
  }, { signal });
  bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
    nextPage = pageNumber;
    if (notices.get(pageNumber) === "ocrError") {
      notices.delete(pageNumber);
      if (workerStartFailed) { worker = undefined; workerStartFailed = false; }
      if (pageNumber !== active) pending.add(pageNumber);
    }
    if (evicted.delete(pageNumber)) pending.add(pageNumber);
    if (evicted.delete(pageNumber + 1)) pending.add(pageNumber + 1);
    updateStatus();
    schedule();
  }, { signal });
  bus.on("pagesdestroy", () => {
    controller.abort();
    window.clearTimeout(timer);
    cache.clear();
    pending.clear();
    onStatus(null);
    void worker?.then(w => w.terminate()).catch(() => {});
  }, { once: true });
  updateStatus();
  schedule();
}
