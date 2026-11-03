import type { Mark, MarkupState } from "./markup";
import type { OutlineItem, PDFDocumentProxy } from "./pdf";

export function notesMarkdown(name: string, { note, marks }: MarkupState) {
  const lines = [`# Notes: ${name.replace(/\.pdf$/i, "")}`, ""];
  if (note.trim()) lines.push(note.trim(), "");
  for (const mark of marks) {
    const page = `p. ${mark.page + 1}`;
    if (mark.type === "highlight") {
      lines.push(`> ${mark.text.replace(/\n+/g, " ")} (${page})`);
      if (mark.note) lines.push("", mark.note);
      lines.push("");
    } else if (mark.type === "freetext" && mark.text) {
      lines.push(`- Text box (${page}): ${mark.text}`, "");
    } else if (mark.type === "ink") {
      lines.push(`- ${mark.shape ?? "Drawing"} (${page})`, "");
    }
  }
  return lines.join("\n").trim() + "\n";
}

// pdf.js returns typed arrays for some geometry. JSON needs ordinary arrays of numbers.
function numbers(value: unknown) {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value) && "length" in value) return Array.from(value as unknown as ArrayLike<number>);
}

function annotation(mark: Mark) {
  const paths = mark.data.paths as { points?: unknown[] } | undefined;
  return {
    id: mark.id, type: mark.shape ? "shape" : mark.type, shape: mark.shape?.toLowerCase(),
    page: mark.page + 1, color: mark.color, text: mark.text, note: mark.note,
    createdAt: new Date(mark.createdAt).toISOString(), rect: numbers(mark.data.rect),
    quadPoints: numbers(mark.data.quadPoints), strokes: paths?.points?.map(numbers),
  };
}

interface Bookmark { title: string; page: number | null; url?: string; children?: Bookmark[] }

async function outlineBookmarks(pdf: PDFDocumentProxy, items: OutlineItem[]): Promise<Bookmark[]> {
  return Promise.all(items.map(async item => {
    let page: number | null = null;
    try {
      const dest = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
      const ref = dest?.[0];
      const index = typeof ref === "number" ? ref : ref ? await pdf.getPageIndex(ref) : -1;
      if (Number.isInteger(index) && index >= 0 && index < pdf.numPages) page = index + 1;
    } catch { /* Keep the title even if the PDF contains a broken destination. */ }
    return { title: item.title, page, url: item.url ?? undefined,
      children: item.items.length ? await outlineBookmarks(pdf, item.items) : undefined };
  }));
}

export async function notesJson(doc: { name: string; id: string; pdf: PDFDocumentProxy }, state: MarkupState) {
  const bookmarks = await outlineBookmarks(doc.pdf, await doc.pdf.getOutline() ?? []);
  return JSON.stringify({
    schemaVersion: 1, document: { id: doc.id, name: doc.name, pageCount: doc.pdf.numPages },
    coordinateSpace: "PDF user space on the unrotated page (x increases right, y increases up)",
    documentNote: state.note, annotations: state.marks.map(annotation), bookmarks,
  }, null, 2) + "\n";
}
