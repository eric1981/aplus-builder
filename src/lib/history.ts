// IndexedDB-based generation history — stores last 5 results with full HTML + images
// localStorage can't fit 18MB HTML, so we use IndexedDB for heavy payloads.

export interface HistoryEntry {
  id: string;
  timestamp: number;
  description: string;
  imageCount: number;
  html: string;
  images: HistoryImage[];
  thumbnail: string;
  htmlSize: number;
}

export interface HistoryImage {
  name: string;
  base64: string;
  mime: string;
}

const DB_NAME = "aplus-builder";
const STORE_NAME = "history";
const MAX_ENTRIES = 5;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resize first image to a small thumbnail for the history list */
function createThumbnail(base64: string, mime: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const maxW = 200;
      const maxH = 200;
      let w = img.width;
      let h = img.height;
      if (w > h) {
        h = (h * maxW) / w;
        w = maxW;
      } else {
        w = (w * maxH) / h;
        h = maxH;
      }
      canvas.width = Math.round(w);
      canvas.height = Math.round(h);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = () => resolve("");
    img.src = `data:${mime};base64,${base64}`;
  });
}

export async function saveToHistory(entry: {
  description: string;
  html: string;
  images: HistoryImage[];
}): Promise<void> {
  const db = await openDB();

  let thumbnail = "";
  if (entry.images.length > 0) {
    thumbnail = await createThumbnail(entry.images[0].base64, entry.images[0].mime);
  }

  const record: HistoryEntry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    thumbnail,
    imageCount: entry.images.length,
    htmlSize: entry.html.length,
    ...entry,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.add(record);

    // prune to MAX_ENTRIES
    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      const keys = keysReq.result as string[];
      if (keys.length > MAX_ENTRIES) {
        keys.sort();
        for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
          store.delete(keys[i]);
        }
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      resolve(
        (req.result as HistoryEntry[]).sort(
          (a, b) => b.timestamp - a.timestamp,
        ),
      );
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFromHistory(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
