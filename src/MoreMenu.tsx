import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

export type MoreItem =
  | { kind: "action"; icon: IconName; label: string; shortcut?: string; onSelect: () => void }
  | { kind: "toggle"; icon: IconName; label: string; checked: boolean; onSelect: () => void }
  | { kind: "divider" };

/** The top bar's overflow menu: less-frequent actions. */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return (
    <div className="more" ref={ref}>
      <button
        className={`icon-btn ${open ? "on" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu dropdown" role="menu">
          {items.map((item, i) =>
            item.kind === "divider" ? (
              <hr key={i} />
            ) : (
              <button
                key={item.label}
                role={item.kind === "toggle" ? "menuitemcheckbox" : "menuitem"}
                aria-checked={item.kind === "toggle" ? item.checked : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <Icon name={item.icon} size={15} />
                <span className="menu-label">{item.label}</span>
                {item.kind === "toggle" && item.checked && <Icon name="check" size={14} />}
                {item.kind === "action" && item.shortcut && <kbd className="menu-kbd">{item.shortcut}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
