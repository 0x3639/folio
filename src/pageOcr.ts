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
  for (const word of words) {
    const span = document.createElement("span");
    span.textContent = word.text + (word.endOfLine ? "" : " ");
    span.style.left = `${word.left}%`;
    span.style.top = `${word.top}%`;
    span.style.fontFamily = "sans-serif";
    span.style.setProperty("--font-height", `${word.height}px`);
    span.style.setProperty("--scale-x", String(word.scaleX));
    span.style.setProperty("--rotate", `${-view.pdfPage.rotate}deg`);
    fragment.append(span);
    if (word.endOfLine) fragment.append(document.createElement("br"));
  }
  end.before(fragment);
}

/** One lazy worker per open document. Only visible scans enter the recognition queue. */
export function recognizeScannedPages(bus: EventBus, viewer: PDFViewer) {
  const controller = new AbortController();
  const { signal } = controller;
  const cache = new Map<PDFPageView, Word[]>();
  const candidates = new WeakMap<Element, PDFPageView>();
  const visible = new Set<PDFPageView>();
  let active: PDFPageView | undefined;
  let worker: Promise<OcrWorker> | undefined;

  async function drain() {
    if (active || signal.aborted) return;
    for (const view of visible) {
      visible.delete(view);
      observer.unobserve(view.div);
      if (!view.textLayer?.div.isConnected) continue;
      active = view;
      try {
        let words: Word[] = [];
        if (await hasPageImage(view.pdfPage)) {
          signal.throwIfAborted();
          view.div.dataset.ocrStatus = "Recognizing text…";
          worker ??= startWorker().catch(error => { worker = undefined; throw error; });
          words = await readWords(view.pdfPage, await worker, signal);
        }
        signal.throwIfAborted();
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        cache.set(view, words);
        addWords(view, words);
        delete view.div.dataset.ocrStatus;
      } catch (error) {
        if (!signal.aborted) {
          view.div.dataset.ocrStatus = "Text recognition unavailable";
          console.warn("Page OCR failed", error);
        }
      } finally {
        active = undefined;
      }
      if (signal.aborted) return;
    }
  }

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const view = candidates.get(entry.target);
      if (!view) continue;
      if (entry.isIntersecting) visible.add(view);
      else visible.delete(view);
    }
    void drain();
  }, { root: viewer.container });

  bus.on("textlayerrendered", ({ source: view, error }: { source: PDFPageView; error: unknown }) => {
    const layer = view.textLayer?.div;
    if (error || !layer || !view.pdfPage || layer.textContent.trim() || active === view) return;
    const words = cache.get(view);
    if (words) addWords(view, words);
    else {
      candidates.set(view.div, view);
      observer.observe(view.div);
    }
  }, { signal });
  bus.on("pagesdestroy", () => {
    controller.abort();
    observer.disconnect();
    visible.clear();
    cache.clear();
    void worker?.then(w => w.terminate()).catch(() => {});
  }, { once: true });
}
