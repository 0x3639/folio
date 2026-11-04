import changelog from "../CHANGELOG.md?raw";
import { version as installed } from "../package.json";

export interface Release {
  version: string;
  items: string[];
}

// The bundled changelog uses "## version" headings and "- " bullets with indented continuations.
function parse(text: string): Release[] {
  const releases: Release[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) releases.push({ version: heading[1].trim(), items: [] });
    const current = releases[releases.length - 1];
    if (!current || heading) continue;
    if (line.startsWith("- ")) current.items.push(line.slice(2).trim());
    else if (line.trim() && current.items.length) current.items[current.items.length - 1] += " " + line.trim();
  }
  return releases;
}

export const releases = parse(changelog);
const byVersion = new Intl.Collator("en", { numeric: true });

export function takeUpgradeNotes(): Release[] {
  const key = "folio:last-opened-version";
  try {
    const previous = localStorage.getItem(key);
    if (previous && byVersion.compare(installed, previous) <= 0) return [];
    localStorage.setItem(key, installed);
    // Older releases saved the sidebar preference on first launch, before version tracking existed.
    if (!previous) return localStorage.getItem("folio:sidebar") === null ? [] : releases.filter(r => r.version === installed);
    return releases.filter(r => byVersion.compare(r.version, previous) > 0 && byVersion.compare(r.version, installed) <= 0);
  } catch {
    return []; // If the version can't be saved, don't repeat the popup on every launch.
  }
}
