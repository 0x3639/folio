import { createRoot } from "react-dom/client";
import { DocumentTabs, type ReaderFrame } from "./documentTabs";
import { takeUpgradeNotes } from "./releaseNotes";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import "./reading-tools.css";

const root = document.getElementById("root")!;
const reader = (window.frameElement as ReaderFrame | null)?.readerContext;
if (reader) {
  const desktop = window.parent.folioDesktop;
  if (desktop) {
    window.folioDesktop = { ...desktop, installUpdate: () => {
      if (reader.tabs.all.some(tab => tab.dirty) && !window.parent.confirm("Restart Folio and discard unsaved changes?")) return;
      desktop.installUpdate();
    } };
    document.documentElement.classList.add("desktop", `platform-${desktop.platform}`);
  }
  // No StrictMode: the pdf.js viewer binds imperatively to its container once.
  void import("./App").then(({ default: App }) => {
    const frame = window.frameElement as ReaderFrame | null;
    if (!frame) return;
    const app = createRoot(root);
    frame.disposeReader = () => app.unmount();
    const upgradeNotes = desktop && reader.tabs.active === reader.key ? takeUpgradeNotes() : [];
    app.render(<App tabs={reader.tabs} tabKey={reader.key} upgradeNotes={upgradeNotes} />);
  });
} else {
  void new DocumentTabs(root).start();
}
