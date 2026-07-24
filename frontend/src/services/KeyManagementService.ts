import CryptoService from "./CryptoService";
import KeyStorageService, { StoredKeyRecord } from "./KeyStorageService";

export type NewDeviceReason = "no-local-key" | "decrypt-failed";

export interface LoadResult {
    status: "ok" | "new-device";
    reason?: NewDeviceReason;
}

class KeyManagementService {
    private privateKeyCache: CryptoKey | null = null;
    private currentUserId: string | null = null;

    // Call right after successful signup. Returns publicKey (base64) — caller uploads it via UserService.
    async initializeOnSignup(userId: string, password: string): Promise<string> {
        const { publicKey, privateKey } = await CryptoService.generateRsaKeyPair();
        const encrypted = await CryptoService.encryptPrivateKey(privateKey, password);

        const record: StoredKeyRecord = {
            userId,
            keyVersion: 1,
            encryptedData: encrypted.encryptedData,
            iv: encrypted.iv,
            salt: encrypted.salt,
            publicKey,
            createdAt: new Date().toISOString(),
        };
        await KeyStorageService.saveKeyRecord(record);

        this.privateKeyCache = await CryptoService.importPrivateKey(privateKey);
        this.currentUserId = userId;
        return publicKey;
    }

    // Call right after successful signin. On "new-device", caller shows disclaimer dialog
    // then calls initializeOnSignup again (which overwrites the local record with a fresh keypair).
    async loadOnSignIn(userId: string, password: string): Promise<LoadResult> {
        const record = await KeyStorageService.getKeyRecord(userId);
        if (!record) return { status: "new-device", reason: "no-local-key" };

        try {
            const privateKeyBase64 = await CryptoService.decryptPrivateKey(
                { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
                password
            );
            this.privateKeyCache = await CryptoService.importPrivateKey(privateKeyBase64);
            this.currentUserId = userId;
            return { status: "ok" };
        } catch {
            return { status: "new-device", reason: "decrypt-failed" };
        }
    }

    // Caller MUST verify oldPassword against the backend BEFORE calling this.
    // This only re-wraps the local private key — it does not touch the server.
    async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
        const record = await KeyStorageService.getKeyRecord(userId);
        if (!record) throw new Error("No local private key — cannot re-encrypt for password change");

        const privateKeyBase64 = await CryptoService.decryptPrivateKey(
            { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
            oldPassword
        );
        const reEncrypted = await CryptoService.encryptPrivateKey(privateKeyBase64, newPassword);

        await KeyStorageService.saveKeyRecord({
            ...record,
            encryptedData: reEncrypted.encryptedData,
            iv: reEncrypted.iv,
            salt: reEncrypted.salt,
        });
    }

    // Same as regenerateKeys but DOES NOT persist to IndexedDB — returns the record for
    // the caller to persist ONLY after all network calls succeed. This is critical for
    // atomicity: if blob upload or public key upload fails, the old key record in IndexedDB
    // must remain intact so the user can still decrypt messages.
    // Returns { publicKey (base64), record (StoredKeyRecord) }.
    async regenerateKeysWithoutPersist(userId: string, password: string): Promise<{ publicKey: string; record: StoredKeyRecord }> {
        const existing = await KeyStorageService.getKeyRecord(userId);
        const nextVersion = existing ? existing.keyVersion + 1 : 1;

        const { publicKey, privateKey } = await CryptoService.generateRsaKeyPair();
        const encrypted = await CryptoService.encryptPrivateKey(privateKey, password);

        const record: StoredKeyRecord = {
            userId,
            keyVersion: nextVersion,
            encryptedData: encrypted.encryptedData,
            iv: encrypted.iv,
            salt: encrypted.salt,
            publicKey,
            createdAt: new Date().toISOString(),
        };

        // Cache the new private key in memory (OK to do early — not persisted yet).
        // If the caller needs to roll back, they must call restoreFromKeyRecord().
        this.privateKeyCache = await CryptoService.importPrivateKey(privateKey);
        this.currentUserId = userId;

        return { publicKey, record };
    }

    // Persist a key record to IndexedDB (called only after network calls confirm success).
    async persistKeyRecord(record: StoredKeyRecord): Promise<void> {
        await KeyStorageService.saveKeyRecord(record);
    }

    // Rollback: restore a previously-saved key record + re-load it into the cache.
    // Call this if a network call fails after regenerateKeysWithoutPersist().
    async restoreFromKeyRecord(record: StoredKeyRecord, password: string): Promise<void> {
        await KeyStorageService.saveKeyRecord(record);
        const privateKeyBase64 = await CryptoService.decryptPrivateKey(
            { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
            password
        );
        this.privateKeyCache = await CryptoService.importPrivateKey(privateKeyBase64);
        this.currentUserId = record.userId;
    }

    // Generates a brand-new keypair AND persists immediately.
    // Used by initializeOnSignup where there is no old key to roll back to.
    async regenerateKeys(userId: string, password: string): Promise<string> {
        const existing = await KeyStorageService.getKeyRecord(userId);
        const nextVersion = existing ? existing.keyVersion + 1 : 1;

        const { publicKey, privateKey } = await CryptoService.generateRsaKeyPair();
        const encrypted = await CryptoService.encryptPrivateKey(privateKey, password);

        const record: StoredKeyRecord = {
            userId,
            keyVersion: nextVersion,
            encryptedData: encrypted.encryptedData,
            iv: encrypted.iv,
            salt: encrypted.salt,
            publicKey,
            createdAt: new Date().toISOString(),
        };
        await KeyStorageService.saveKeyRecord(record);

        this.privateKeyCache = await CryptoService.importPrivateKey(privateKey);
        this.currentUserId = userId;
        return publicKey;
    }

    getCachedPrivateKey(): CryptoKey {
        if (!this.privateKeyCache) throw new Error("Private key not loaded — call loadOnSignIn first");
        return this.privateKeyCache;
    }

    getCurrentUserId(): string | null {
        return this.currentUserId;
    }

    // Deliberately does NOT delete the IndexedDB record — it's ciphertext at rest and needed
    // so the same device can decrypt on next login without a false "new-device" trigger.
    clearOnLogout(): void {
        this.privateKeyCache = null;
        this.currentUserId = null;
    }
}

const keyManagementService = new KeyManagementService();
export default keyManagementService;

