import { openFolioDatabase } from "./recent";

export type PdfChange =
  | { kind: "text"; page: number; before: string; after: string }
  | { kind: "image"; page: number; fileName: string }
  | { kind: "pages"; order: number[] }
  | { kind: "annotations" };

export interface PdfVersion {
  id: string;
  family: string;
  number: number;
  parent?: number;
  name: string;
  createdAt: number;
  changes: PdfChange[];
}

interface Snapshot { id: string; name: string; data: Blob }
const familyRange = (family: string) => IDBKeyRange.bound([family, 0], [family, Infinity]);
export const HISTORY_CHANNEL = "folio:version-history";

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>) {
  const db = await openFolioDatabase();
  const tx = db.transaction(["versions", "versionPdfs"], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Version history was not saved."));
  });
  const work = run(tx).catch(error => { try { tx.abort(); } catch {} throw error; });
  const [value] = await Promise.all([work, done]);
  return value;
}

function notify() {
  const channel = new BroadcastChannel(HISTORY_CHANNEL);
  channel.postMessage("changed");
  channel.close();
}

export async function saveVersion(source: Snapshot, copy: Snapshot, changes: PdfChange[]) {
  if (source.id === copy.id) return;
  await transaction("readwrite", async tx => {
    const versions = tx.objectStore("versions"), pdfs = tx.objectStore("versionPdfs");
    if (await result(versions.getKey(copy.id)) !== undefined) return;
    let parent: PdfVersion | undefined = await result(versions.get(source.id));
    const now = Date.now();
    if (!parent) {
      parent = { id: source.id, family: source.id, number: 1, name: source.name, createdAt: now, changes: [] };
      versions.add(parent);
      pdfs.add(source.data, source.id);
    }
    // Serialize numbering with the snapshots, even when two tabs save from the same earlier version.
    const latest = await result(versions.index("byFamily").openCursor(familyRange(parent.family), "prev"));
    const version: PdfVersion = { id: copy.id, family: parent.family, number: latest!.value.number + 1,
      parent: parent.number, name: copy.name, createdAt: now, changes };
    versions.add(version);
    pdfs.add(copy.data, copy.id);
  });
  notify();
}

export function listVersions(id: string): Promise<PdfVersion[]> {
  return transaction("readonly", async tx => {
    const store = tx.objectStore("versions");
    const current: PdfVersion | undefined = await result(store.get(id));
    return current ? (await result(store.index("byFamily").getAll(familyRange(current.family)))).reverse() : [];
  });
}

export function readVersion(id: string): Promise<Blob | undefined> {
  return transaction("readonly", tx => result(tx.objectStore("versionPdfs").get(id)));
}

export async function clearVersions(id: string) {
  await transaction("readwrite", async tx => {
    const versions = tx.objectStore("versions");
    const current: PdfVersion | undefined = await result(versions.get(id));
    if (!current) return;
    for (const key of await result(versions.index("byFamily").getAllKeys(familyRange(current.family)))) {
      versions.delete(key);
      tx.objectStore("versionPdfs").delete(key);
    }
  });
  notify();
}
