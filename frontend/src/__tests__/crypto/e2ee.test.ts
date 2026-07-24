/**
 * Jest port of e2eeSmokeTest.ts — run on CI to catch crypto regressions.
 * Uses in-memory key storage mock instead of IndexedDB.
 */
import CryptoService from "../../services/CryptoService";
import KeyStorageService, { StoredKeyRecord } from "../../services/KeyStorageService";
import RecoveryService from "../../services/RecoveryService";

// In-memory storage for testing (replaces IndexedDB)
const testStore = new Map<string, StoredKeyRecord>();

// Mock localStorage for recovery phrase tracking
const localStorageMock = new Map<string, string>();

beforeAll(() => {
    (KeyStorageService as any).saveKeyRecord = async (record: StoredKeyRecord) => {
        testStore.set(record.userId, record);
    };
    (KeyStorageService as any).getKeyRecord = async (userId: string) => {
        return testStore.get(userId) ?? null;
    };
    (KeyStorageService as any).deleteKeyRecord = async (userId: string) => {
        testStore.delete(userId);
    };

    // Mock localStorage
    (global as any).localStorage = {
        getItem: (key: string) => localStorageMock.get(key) ?? null,
        setItem: (key: string, value: string) => localStorageMock.set(key, value),
        removeItem: (key: string) => localStorageMock.delete(key),
        clear: () => localStorageMock.clear(),
    };

    // Mock fetch for recovery blob API calls
    (global as any).fetch = jest.fn();
});

afterAll(() => {
    (global as any).fetch = undefined;
    (global as any).localStorage = undefined;
});

beforeEach(() => {
    testStore.clear();
    localStorageMock.clear();
    jest.clearAllMocks();
});

// Simple in-memory KeyManagementService for testing
function createTestKeyManager() {
    const privateKeyCache: Map<string, CryptoKey> = new Map();
    let currentUserId: string | null = null;

    return {
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

            const imported = await CryptoService.importPrivateKey(privateKey);
            privateKeyCache.set(userId, imported);
            currentUserId = userId;
            return publicKey;
        },

        async loadOnSignIn(userId: string, password: string): Promise<{ status: "ok" | "new-device"; reason?: string }> {
            const record = await KeyStorageService.getKeyRecord(userId);
            if (!record) return { status: "new-device", reason: "no-local-key" };

            try {
                const privateKeyBase64 = await CryptoService.decryptPrivateKey(
                    { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
                    password
                );
                const imported = await CryptoService.importPrivateKey(privateKeyBase64);
                privateKeyCache.set(userId, imported);
                currentUserId = userId;
                return { status: "ok" };
            } catch {
                return { status: "new-device", reason: "decrypt-failed" };
            }
        },

        async regenerateKeys(userId: string, password: string): Promise<string> {
            const existing = testStore.get(userId);
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

            const imported = await CryptoService.importPrivateKey(privateKey);
            privateKeyCache.set(userId, imported);
            currentUserId = userId;
            return publicKey;
        },

        getCachedPrivateKey(userId: string): CryptoKey {
            const key = privateKeyCache.get(userId);
            if (!key) throw new Error("Private key not loaded");
            return key;
        },

        clearOnLogout(): void {
            privateKeyCache.clear();
            currentUserId = null;
        },
    };
}

describe("E2EE Cryptographic Lifecycle", () => {
    const testUserId = "test-user-123";
    const password = "myTestPassword123";
    const wrongPassword = "wrongPassword";

    let keyManager: ReturnType<typeof createTestKeyManager>;
    let publicKey: string;

    test("1. Full signup → encrypt → decrypt cycle", async () => {
        keyManager = createTestKeyManager();

        publicKey = await keyManager.initializeOnSignup(testUserId, password);
        expect(publicKey).toBeTruthy();
        expect(publicKey.length).toBeGreaterThan(100);

        keyManager.clearOnLogout();

        const loadResult = await keyManager.loadOnSignIn(testUserId, password);
        expect(loadResult.status).toBe("ok");

        const privateKey = keyManager.getCachedPrivateKey(testUserId);
        const encrypted = await CryptoService.hybridEncrypt("hello world", [
            { userId: testUserId, publicKey },
        ]);
        expect(encrypted.ciphertext).toBeTruthy();
        expect(encrypted.iv).toBeTruthy();
        expect(encrypted.encryptedAesKeys[testUserId]).toBeTruthy();

        const decrypted = await CryptoService.hybridDecrypt(
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.encryptedAesKeys[testUserId],
            privateKey
        );
        expect(decrypted).toBe("hello world");
    });

    test("2. Wrong password triggers new-device flow", async () => {
        keyManager = createTestKeyManager();
        publicKey = await keyManager.initializeOnSignup(testUserId, password);
        keyManager.clearOnLogout();

        const wrongPwResult = await keyManager.loadOnSignIn(testUserId, wrongPassword);
        expect(wrongPwResult.status).toBe("new-device");
        expect(wrongPwResult.reason).toBe("decrypt-failed");
    });

    test("3. Missing local key triggers new-device (no-local-key)", async () => {
        keyManager = createTestKeyManager();
        const result = await keyManager.loadOnSignIn("nonexistent-user", password);
        expect(result.status).toBe("new-device");
        expect(result.reason).toBe("no-local-key");
    });

    test("4. Password change re-wraps same key", async () => {
        keyManager = createTestKeyManager();
        publicKey = await keyManager.initializeOnSignup(testUserId, password);

        const privateKey1 = keyManager.getCachedPrivateKey(testUserId);
        const encrypted = await CryptoService.hybridEncrypt("test message", [
            { userId: testUserId, publicKey },
        ]);
        const decrypted1 = await CryptoService.hybridDecrypt(
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.encryptedAesKeys[testUserId],
            privateKey1
        );
        expect(decrypted1).toBe("test message");

        const record = await KeyStorageService.getKeyRecord(testUserId);
        const privateKeyBase64 = await CryptoService.decryptPrivateKey(
            { encryptedData: record!.encryptedData, iv: record!.iv, salt: record!.salt },
            password
        );
        const newEncrypted = await CryptoService.encryptPrivateKey(privateKeyBase64, "newPassword123");
        await KeyStorageService.saveKeyRecord({
            ...record!,
            encryptedData: newEncrypted.encryptedData,
            iv: newEncrypted.iv,
            salt: newEncrypted.salt,
        });

        keyManager.clearOnLogout();

        const oldResult = await keyManager.loadOnSignIn(testUserId, password);
        expect(oldResult.status).toBe("new-device");

        const newResult = await keyManager.loadOnSignIn(testUserId, "newPassword123");
        expect(newResult.status).toBe("ok");

        const privateKey2 = keyManager.getCachedPrivateKey(testUserId);
        const decrypted2 = await CryptoService.hybridDecrypt(
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.encryptedAesKeys[testUserId],
            privateKey2
        );
        expect(decrypted2).toBe("test message");
    });

    test("5. Multi-recipient encryption works", async () => {
        keyManager = createTestKeyManager();

        const userA = { id: "user-a", pw: "pwA" };
        const userB = { id: "user-b", pw: "pwB" };
        const userC = { id: "user-c", pw: "pwC" };

        const pubA = await keyManager.initializeOnSignup(userA.id, userA.pw);
        keyManager.clearOnLogout();
        const pubB = await keyManager.initializeOnSignup(userB.id, userB.pw);
        keyManager.clearOnLogout();
        const pubC = await keyManager.initializeOnSignup(userC.id, userC.pw);
        keyManager.clearOnLogout();

        const encrypted = await CryptoService.hybridEncrypt("group message", [
            { userId: userA.id, publicKey: pubA },
            { userId: userB.id, publicKey: pubB },
            { userId: userC.id, publicKey: pubC },
        ]);

        for (const user of [userA, userB, userC]) {
            const loadResult = await keyManager.loadOnSignIn(user.id, user.pw);
            expect(loadResult.status).toBe("ok");
            const pk = keyManager.getCachedPrivateKey(user.id);
            const decrypted = await CryptoService.hybridDecrypt(
                encrypted.ciphertext,
                encrypted.iv,
                encrypted.encryptedAesKeys[user.id],
                pk
            );
            expect(decrypted).toBe("group message");
            keyManager.clearOnLogout();
        }
    });

    test("6. Recovery phrase generation and encryption produces valid blob", async () => {
        // Generate a mnemonic
        const phrase = RecoveryService.generateMnemonic();
        expect(phrase).toBeTruthy();
        const words = phrase.split(/\s+/);
        expect(words.length).toBe(12);

        // Generate a keypair and encrypt private key with mnemonic
        const { publicKey, privateKey } = await CryptoService.generateRsaKeyPair();
        const blob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKey, phrase);
        expect(blob.encryptedData).toBeTruthy();
        expect(blob.iv).toBeTruthy();
        expect(blob.salt).toBeTruthy();

        // Decrypt private key with mnemonic
        const decryptedPrivateKey = await RecoveryService.decryptPrivateKeyWithMnemonic(blob, phrase);
        expect(decryptedPrivateKey).toBe(privateKey);

        // Verify the decrypted key can still be used for encryption
        const importedKey = await CryptoService.importPrivateKey(decryptedPrivateKey);
        const encrypted = await CryptoService.hybridEncrypt("recovery test", [
            { userId: "recovery-user", publicKey },
        ]);
        const decrypted = await CryptoService.hybridDecrypt(
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.encryptedAesKeys["recovery-user"],
            importedKey
        );
        expect(decrypted).toBe("recovery test");
    });

    test("7. Wrong recovery phrase fails to decrypt blob", async () => {
        const correctPhrase = RecoveryService.generateMnemonic();
        const wrongPhrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";

        const { publicKey, privateKey } = await CryptoService.generateRsaKeyPair();
        const blob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKey, correctPhrase);

        await expect(
            RecoveryService.decryptPrivateKeyWithMnemonic(blob, wrongPhrase)
        ).rejects.toThrow();
    });

    test("8. Full recovery flow simulation", async () => {
        keyManager = createTestKeyManager();
        const recoveryUserId = "recovery-flow-user";
        const recoveryPassword = "recoveryPass123";

        // Signup: generate keys
        const pubKey = await keyManager.initializeOnSignup(recoveryUserId, recoveryPassword);

        // Generate recovery phrase + blob (as done on signup)
        const phrase = RecoveryService.generateMnemonic();
        const record = await KeyStorageService.getKeyRecord(recoveryUserId);
        expect(record).toBeTruthy();

        const privateKeyBase64 = await CryptoService.decryptPrivateKey(
            { encryptedData: record!.encryptedData, iv: record!.iv, salt: record!.salt },
            recoveryPassword
        );

        const blob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKeyBase64, phrase);

        // Simulate losing local key (clear IndexedDB record)
        testStore.delete(recoveryUserId);
        keyManager.clearOnLogout();

        // New device — no local key
        const loadResult = await keyManager.loadOnSignIn(recoveryUserId, recoveryPassword);
        expect(loadResult.status).toBe("new-device");
        expect(loadResult.reason).toBe("no-local-key");

        // Recovery: re-create local key record from blob + phrase
        const decryptedPk = await RecoveryService.decryptPrivateKeyWithMnemonic(blob, phrase);
        const reEncrypted = await CryptoService.encryptPrivateKey(decryptedPk, recoveryPassword);

        await KeyStorageService.saveKeyRecord({
            userId: recoveryUserId,
            keyVersion: 1,
            encryptedData: reEncrypted.encryptedData,
            iv: reEncrypted.iv,
            salt: reEncrypted.salt,
            publicKey: pubKey,
            createdAt: new Date().toISOString(),
        });

        // Now we should be able to sign in and decrypt old messages
        const recoveryResult = await keyManager.loadOnSignIn(recoveryUserId, recoveryPassword);
        expect(recoveryResult.status).toBe("ok");

        // Old messages encrypted with original key should still decrypt
        const encrypted = await CryptoService.hybridEncrypt("old message", [
            { userId: recoveryUserId, publicKey: pubKey },
        ]);
        const restoredPk = keyManager.getCachedPrivateKey(recoveryUserId);
        const decrypted = await CryptoService.hybridDecrypt(
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.encryptedAesKeys[recoveryUserId],
            restoredPk
        );
        expect(decrypted).toBe("old message");
    });

    test("9. Key regeneration produces new keys and invalidates old recovery phrase", async () => {
        keyManager = createTestKeyManager();
        const regenUserId = "regen-test-user";
        const regenPassword = "regenPass123";

        // Signup
        const pubKey1 = await keyManager.initializeOnSignup(regenUserId, regenPassword);

        // Generate and save a recovery blob (simulates what signup does)
        const phrase1 = RecoveryService.generateMnemonic();
        const record1 = await KeyStorageService.getKeyRecord(regenUserId);
        const pk1 = await CryptoService.decryptPrivateKey(
            { encryptedData: record1!.encryptedData, iv: record1!.iv, salt: record1!.salt },
            regenPassword
        );
        const blob1 = await RecoveryService.encryptPrivateKeyWithMnemonic(pk1, phrase1);

        // Encrypt a message with the original key
        const encrypted = await CryptoService.hybridEncrypt("pre-regen message", [
            { userId: regenUserId, publicKey: pubKey1 },
        ]);

        // Regenerate keys (simulates Profile.tsx flow)
        const pubKey2 = await keyManager.regenerateKeys(regenUserId, regenPassword);
        expect(pubKey2).not.toBe(pubKey1); // Must be a different key

        // Generate new recovery phrase + blob for the new keys
        const phrase2 = RecoveryService.generateMnemonic();
        const record2 = await KeyStorageService.getKeyRecord(regenUserId);
        const pk2 = await CryptoService.decryptPrivateKey(
            { encryptedData: record2!.encryptedData, iv: record2!.iv, salt: record2!.salt },
            regenPassword
        );
        const blob2 = await RecoveryService.encryptPrivateKeyWithMnemonic(pk2, phrase2);
        expect(phrase2).not.toBe(phrase1); // Different phrase

        // Old phrase should NOT work with new blob
        await expect(
            RecoveryService.decryptPrivateKeyWithMnemonic(blob2, phrase1)
        ).rejects.toThrow();

        // New phrase should work with new blob
        const decryptedPk2 = await RecoveryService.decryptPrivateKeyWithMnemonic(blob2, phrase2);
        expect(decryptedPk2).toBe(pk2);

        // Old message encrypted with old key should NOT decrypt with new key
        const privateKey2 = keyManager.getCachedPrivateKey(regenUserId);
        await expect(
            CryptoService.hybridDecrypt(
                encrypted.ciphertext,
                encrypted.iv,
                encrypted.encryptedAesKeys[regenUserId],
                privateKey2
            )
        ).rejects.toThrow();

        // But new messages with new key should work
        const newEncrypted = await CryptoService.hybridEncrypt("post-regen message", [
            { userId: regenUserId, publicKey: pubKey2 },
        ]);
        const decryptedNew = await CryptoService.hybridDecrypt(
            newEncrypted.ciphertext,
            newEncrypted.iv,
            newEncrypted.encryptedAesKeys[regenUserId],
            privateKey2
        );
        expect(decryptedNew).toBe("post-regen message");
    });

    test("10. Recovery phrase shown flag tracking", () => {
        expect(RecoveryService.hasShownPhrase()).toBe(false);
        RecoveryService.markPhraseShown();
        expect(RecoveryService.hasShownPhrase()).toBe(true);
    });
});

