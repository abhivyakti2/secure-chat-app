/**
 * Jest port of e2eeSmokeTest.ts — run on CI to catch crypto regressions.
 * Uses in-memory key storage mock instead of IndexedDB.
 *
 * NOTE: The legacy RSA hybrid-encryption path has been removed. Message
 * encryption now uses the Double Ratchet (X3DH) via SessionRatchetService,
 * which requires pre-key bundles and two users. This test suite therefore
 * covers the Curve25519 identity-key lifecycle and password-protected
 * at-rest bundle handling that the app services expose directly.
 */
import KeyManagementService from "../../services/KeyManagementService";
import CryptoService from "../../services/CryptoService";
import KeyStorageService from "../../services/KeyStorageService";
import type { StoredKeyRecord } from "../../services/KeyStorageService";
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
    (KeyStorageService as any).getOrCreateDeviceId = () => "test-device-1";
    (KeyStorageService as any).clearAllSessions = async () => {};

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

describe("E2EE Cryptographic Lifecycle (Curve25519 / Double Ratchet)", () => {
    const testUserId = "test-user-123";
    const password = "myTestPassword123";
    const wrongPassword = "wrongPassword";

    test("1. Full signup → logout → signin cycle", async () => {
        const publicKey = await KeyManagementService.initializeOnSignup(testUserId, password);
        expect(publicKey).toBeTruthy();
        // Curve25519 public keys are 32 bytes => 44 base64 chars
        expect(publicKey.length).toBe(44);

        KeyManagementService.clearOnLogout();

        const loadResult = await KeyManagementService.loadOnSignIn(testUserId, password);
        expect(loadResult.status).toBe("ok");

        const curve25519PrivateKey = KeyManagementService.getCurve25519PrivateKey();
        expect(curve25519PrivateKey).toBeTruthy();
        expect(KeyManagementService.getCurrentUserId()).toBe(testUserId);
    });

    test("2. Wrong password triggers new-device flow", async () => {
        await KeyManagementService.initializeOnSignup(testUserId, password);
        KeyManagementService.clearOnLogout();

        const wrongPwResult = await KeyManagementService.loadOnSignIn(testUserId, wrongPassword);
        expect(wrongPwResult.status).toBe("new-device");
        expect(wrongPwResult.reason).toBe("decrypt-failed");
    });

    test("3. Missing local key triggers new-device (no-local-key)", async () => {
        const result = await KeyManagementService.loadOnSignIn("nonexistent-user", password);
        expect(result.status).toBe("new-device");
        expect(result.reason).toBe("no-local-key");
    });

    test("4. Password change re-wraps same key", async () => {
        await KeyManagementService.initializeOnSignup(testUserId, password);

        const oldPrivateKey = KeyManagementService.getCurve25519PrivateKey();
        expect(oldPrivateKey).toBeTruthy();

        await KeyManagementService.changePassword(testUserId, password, "newPassword123");

        // Old password should no longer decrypt
        KeyManagementService.clearOnLogout();
        const oldResult = await KeyManagementService.loadOnSignIn(testUserId, password);
        expect(oldResult.status).toBe("new-device");

        // New password works and yields the SAME key (only re-wrapped)
        const newResult = await KeyManagementService.loadOnSignIn(testUserId, "newPassword123");
        expect(newResult.status).toBe("ok");
        expect(KeyManagementService.getCurve25519PrivateKey()).toBe(oldPrivateKey);
    });

    test("5. Password-protected at-rest bundle round-trip", async () => {
        const privateKeyMaterial = "base64curve25519privatekeymaterial";
        const bundle = await CryptoService.encryptPrivateKey(
            JSON.stringify({ curve25519PrivateKey: privateKeyMaterial }),
            password
        );
        expect(bundle.encryptedData).toBeTruthy();
        expect(bundle.iv).toBeTruthy();
        expect(bundle.salt).toBeTruthy();

        const decrypted = await CryptoService.decryptPrivateKey(bundle, password);
        expect(JSON.parse(decrypted).curve25519PrivateKey).toBe(privateKeyMaterial);
    });

    test("6. Recovery phrase generation produces 12 words", async () => {
        const phrase = RecoveryService.generateMnemonic();
        expect(phrase).toBeTruthy();
        const words = phrase.split(/\s+/);
        expect(words.length).toBe(12);
    });

test("7. Recovery phrase encryption round-trip", async () => {
        const phrase = RecoveryService.generateMnemonic();
        const privateKeyData = "base64curve25519privatekeymaterial";
        const publicKeyData = "base64curve25519publickeymaterial";

        const blob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKeyData, publicKeyData, phrase);
        expect(blob.encryptedData).toBeTruthy();
        expect(blob.iv).toBeTruthy();
        expect(blob.salt).toBeTruthy();

        const decryptedBundle = await RecoveryService.decryptPrivateKeyWithMnemonic(blob, phrase);
        const parsed = JSON.parse(decryptedBundle);
        expect(parsed.curve25519PrivateKey).toBe(privateKeyData);
        expect(parsed.curve25519PublicKey).toBe(publicKeyData);
    });

    test("8. Wrong recovery phrase fails to decrypt blob", async () => {
        const correctPhrase = RecoveryService.generateMnemonic();
        const wrongPhrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";

        const blob = await RecoveryService.encryptPrivateKeyWithMnemonic(
            "base64curve25519privatekeymaterial",
            "base64curve25519publickeymaterial",
            correctPhrase
        );

        await expect(
            RecoveryService.decryptPrivateKeyWithMnemonic(blob, wrongPhrase)
        ).rejects.toThrow();
    });

    test("9. Full recovery flow simulation", async () => {
        const recoveryUserId = "recovery-flow-user";
        const recoveryPassword = "recoveryPass123";

        // Signup: generate keys
        const pubKey = await KeyManagementService.initializeOnSignup(recoveryUserId, recoveryPassword);

        // Generate recovery phrase + blob (as done on signup)
        const phrase = RecoveryService.generateMnemonic();
        const record = await KeyStorageService.getKeyRecord(recoveryUserId);
        expect(record).toBeTruthy();

        const privateKeyBase64 = await CryptoService.decryptPrivateKey(
            { encryptedData: record!.encryptedData, iv: record!.iv, salt: record!.salt },
            recoveryPassword
        );

const blob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKeyBase64, pubKey, phrase);

        // Simulate losing local key (clear IndexedDB record)
        testStore.delete(recoveryUserId);
        KeyManagementService.clearOnLogout();

        // New device — no local key
        const loadResult = await KeyManagementService.loadOnSignIn(recoveryUserId, recoveryPassword);
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
            curve25519PublicKey: pubKey,
            createdAt: new Date().toISOString(),
        } as StoredKeyRecord);

        // Now we should be able to sign in and load the recovered key
        const recoveryResult = await KeyManagementService.loadOnSignIn(recoveryUserId, recoveryPassword);
        expect(recoveryResult.status).toBe("ok");
        expect(KeyManagementService.getCurve25519PrivateKey()).toBe(decryptedPk);
    });

    test("10. Key regeneration produces a new key", async () => {
        const regenUserId = "regen-test-user";
        const regenPassword = "regenPass123";

        const pubKey1 = await KeyManagementService.initializeOnSignup(regenUserId, regenPassword);
        const privateKey1 = KeyManagementService.getCurve25519PrivateKey();

        const pubKey2 = await KeyManagementService.regenerateKeys(regenUserId, regenPassword);
        expect(pubKey2).not.toBe(pubKey1); // Must be a different key
        expect(KeyManagementService.getCurve25519PrivateKey()).not.toBe(privateKey1);
    });

    test("11. Recovery phrase shown flag tracking", () => {
        expect(RecoveryService.hasShownPhrase()).toBe(false);
        RecoveryService.markPhraseShown();
        expect(RecoveryService.hasShownPhrase()).toBe(true);
    });
});
