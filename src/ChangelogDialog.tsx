import { Fragment, type ReactNode } from "react";
import { Modal } from "./Dialogs";
import { releases, type Release } from "./releaseNotes";

// **bold** and `code` are the only inline styles the changelog uses.
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code>
    : <Fragment key={i}>{part}</Fragment>);
}

export function ChangelogDialog({ upgradeNotes, onClose }: { upgradeNotes?: Release[]; onClose: () => void }) {
  return (
    <Modal title="What's new" onClose={onClose}>
      <div className="changelog">
        {(upgradeNotes ?? releases).map((r) => (
          <section key={r.version}>
            <h3>Folio {r.version}</h3>
            <ul>
              {r.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
            </ul>
          </section>
        ))}
      </div>
      {upgradeNotes && <div className="upgrade-footer">
        <span>Read past changes in Settings → About.</span>
        <button className="btn primary" autoFocus onClick={onClose}>Done</button>
      </div>}
    </Modal>
  );
}
