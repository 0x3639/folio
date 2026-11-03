// Recently opened files, kept locally in IndexedDB so they can be reopened with one click.

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
  lastPage: number;
  thumb: string;
  data: Blob;
}

const DB_NAME = "folio";
const STORE = "recent";
const LEGACY = "recentByName";
const NOTES = "notes";
const AI = "ai";
const MAX_RECENT = 8;
/** Bigger files aren't kept in Recent: each entry stores the whole PDF, so a few 300 MB downloads would be gigabytes of copies on disk. */
export const MAX_RECENT_FILE_BYTES = 50 * 1024 * 1024;
let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const database = req.result;
      // Older cards can pair one file's preview and position with another file's bytes.
      if (database.objectStoreNames.contains(STORE)) req.transaction!.objectStore(STORE).name = LEGACY;
      database.createObjectStore(STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(NOTES)) database.createObjectStore(NOTES, { keyPath: "id" });
      if (!database.objectStoreNames.contains(AI)) database.createObjectStore(AI, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const database = req.result;
      database.onversionchange = () => { database.close(); connection = null; };
      database.onclose = () => { connection = null; };
      // A migration that runs out of quota can retry next time. Notes and chat still work.
      migrateRecent(database).catch(() => {}).then(() => resolve(database));
    };
    req.onerror = () => { connection = null; reject(req.error); };
  });
  return connection;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const req = fn(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(req.result);
    transaction.onabort = () => reject(transaction.error);
    req.onerror = () => reject(req.error);
  });
}

export async function contentKey(data: Uint8Array) {
  // Up to 2 MiB the old key already hashed every byte. Larger sampled keys cannot prove
  // which file owns old notes or chat, even if a file with the same sample is still in Recent.
  const prefix = data.byteLength <= 2 * 1024 * 1024 ? "sha256:" : "sha256-full:";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  return prefix + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") + ":" + data.byteLength;
}

async function migrateRecent(database: IDBDatabase) {
  if (!database.objectStoreNames.contains(LEGACY)) return;
  const old = await new Promise<RecentFile[]>((resolve, reject) => {
    const request = database.transaction(LEGACY).objectStore(LEGACY).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const file of old.sort((a, b) => b.openedAt - a.openedAt)) {
    let id: string | undefined;
    if (file.data instanceof Blob && file.data.size <= MAX_RECENT_FILE_BYTES) {
      try { id = await contentKey(new Uint8Array(await file.data.arrayBuffer())); } catch { continue; }
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([LEGACY, STORE], "readwrite");
      const legacy = transaction.objectStore(LEGACY);
      const current = transaction.objectStore(STORE);
      // Two tabs can start the same migration. Moving each row atomically avoids resurrecting a removed card.
      const source = legacy.getKey(file.id);
      source.onsuccess = () => {
        if (source.result === undefined) return;
        legacy.delete(file.id);
        if (!id) return;
        const dest = current.getKey(id);
        dest.onsuccess = () => {
          if (dest.result === undefined) current.put({ ...file, id, size: file.data.size, thumb: "", lastPage: 1 });
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

export async function listRecent(): Promise<RecentFile[]> {
  try {
    const all = await tx<RecentFile[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function getRecent(id: string): Promise<RecentFile | undefined> {
  try {
    return await tx<RecentFile | undefined>("readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}

export async function saveRecent(file: RecentFile) {
  try {
    await tx("readwrite", (store) => {
      store.put(file);
      const all: IDBRequest<RecentFile[]> = store.getAll();
      all.onsuccess = () => {
        for (const old of all.result.sort((a, b) => b.openedAt - a.openedAt).slice(MAX_RECENT)) store.delete(old.id);
      };
      return all;
    });
  } catch {
    /* storage may be unavailable (private mode); recent files are best-effort */
  }
}

export async function updateLastPage(id: string, lastPage: number) {
  try {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const file = request.result as RecentFile | undefined;
        if (file && file.lastPage !== lastPage) store.put({ ...file, lastPage });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {}
}

export async function clearRecent() {
  try {
    const db = await open();
    const stores = db.objectStoreNames.contains(LEGACY) ? [STORE, LEGACY] : [STORE];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(stores, "readwrite");
      for (const name of stores) transaction.objectStore(name).clear();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    /* ignore */
  }
}

export async function removeRecent(id: string) {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

// ── Highlights and notes ──────────────────────────────────────────────
// Saved per document (same id as Recent) so markup survives closing Folio.

export interface StoredMark {
  id: string;
  type: "highlight" | "ink" | "freetext";
  shape?: import("./shapes").Shape;
  page: number; // 0-based
  text: string;
  note: string;
  color: string;
  createdAt: number;
  /** pdf.js editor serialization, used to recreate the mark. */
  data: Record<string, unknown>;
}

export interface DocNotes {
  id: string;
  note: string;
  marks: StoredMark[];
  bookmarkedPages?: number[]; // One-based, absent in older records.
  updatedAt: number;
}

export async function getNotes(id: string): Promise<DocNotes | undefined> {
  try {
    return await tx<DocNotes | undefined>("readonly", (s) => s.get(id), NOTES);
  } catch {
    return undefined;
  }
}

export async function saveNotes(notes: DocNotes) {
  try {
    if (!notes.note.trim() && !notes.marks.length && !notes.bookmarkedPages?.length) await tx("readwrite", (s) => s.delete(notes.id), NOTES);
    else await tx("readwrite", (s) => s.put(notes), NOTES);
  } catch {
    /* best-effort, like Recent */
  }
}

// ── Ask AI conversations ──────────────────────────────────────────────
// One conversation per document (same content-based id as notes), so it's there when the document is reopened.

export interface StoredAiMessage {
  role: "user" | "assistant";
  content: string;
  context?: { text: string; page: number };
}

export async function getAiHistory(id: string): Promise<StoredAiMessage[]> {
  try {
    const record = await tx<{ id: string; messages: StoredAiMessage[] } | undefined>("readonly", (s) => s.get(id), AI);
    return Array.isArray(record?.messages) ? record.messages : [];
  } catch {
    return [];
  }
}

export async function saveAiHistory(id: string, messages: StoredAiMessage[]) {
  try {
    if (messages.length === 0) await tx("readwrite", (s) => s.delete(id), AI);
    else await tx("readwrite", (s) => s.put({ id, messages, updatedAt: Date.now() }), AI);
  } catch {
    /* best-effort, like notes */
  }
}
