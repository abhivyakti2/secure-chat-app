const DB_NAME = "chatapp-keystore";
const DB_VERSION = 1;
const STORE_NAME = "privateKeys";

export interface StoredKeyRecord {
    userId: string; // primary key — one active key record per user per device
    keyVersion: number;
    encryptedData: string;
    iv: string;
    salt: string;
    publicKey: string;
    createdAt: string;
}

class KeyStorageService {
    private dbPromise: Promise<IDBDatabase> | null = null;

    private openDb(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "userId" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return this.dbPromise;
    }

    async saveKeyRecord(record: StoredKeyRecord): Promise<void> {
        const db = await this.openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getKeyRecord(userId: string): Promise<StoredKeyRecord | null> {
        const db = await this.openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).get(userId);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    async deleteKeyRecord(userId: string): Promise<void> {
        const db = await this.openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).delete(userId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

const keyStorageService = new KeyStorageService();
export default keyStorageService;

