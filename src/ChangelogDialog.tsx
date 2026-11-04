import { Fragment, useState, type ReactNode } from "react";
import { Modal } from "./Dialogs";
import { releases, type Release } from "./releaseNotes";

// **bold** and `code` are the only inline styles the changelog uses.
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code>
    : <Fragment key={i}>{part}</Fragment>);
}

const PAGE_SIZE = 5;

function ChangeList({ release }: { release: Release }) {
  return <ul>{release.items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>;
}

export function ChangelogDialog({ upgradeNotes, onClose }: { upgradeNotes?: Release[]; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(releases.length / PAGE_SIZE);
  return (
    <Modal title="What's new" onClose={onClose}>
      <div className="changelog">
        {upgradeNotes ? upgradeNotes.map((r) => (
          <section key={r.version}>
            <h3>Folio {r.version}</h3>
            <ChangeList release={r} />
          </section>
        )) : releases.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((r, i) => (
          <details key={r.version} open={i === 0}>
            <summary>Folio {r.version}</summary>
            <ChangeList release={r} />
          </details>
        ))}
      </div>
      {upgradeNotes ? <div className="upgrade-footer">
        <span>Read past changes in Settings → About.</span>
        <button className="btn primary" autoFocus onClick={onClose}>Done</button>
      </div> : <footer className="history-footer">
        <nav aria-label="Changelog pages">
          <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer releases</button>
          <span aria-live="polite">Page {page + 1} of {pages}</span>
          <button className="btn ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older releases</button>
        </nav>
        <a href="https://github.com/Forward-Future/folio-releases/releases" target="_blank" rel="noreferrer">View releases on GitHub</a>
      </footer>}
    </Modal>
  );
}
