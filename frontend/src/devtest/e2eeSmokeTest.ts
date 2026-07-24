/**
 * E2EE smoke test — call manually from browser console:
 *
 *   import('./devtest/e2eeSmokeTest').then(m => m.run());
 *
 * NEVER import this from any component. This file is a throwaway
 * dev-only verification of the full encrypted-messaging lifecycle.
 */

export async function run(): Promise<void> {
    const CryptoService = (await import("../services/CryptoService")).default;
    const KeyManagementService = (await import("../services/KeyManagementService")).default;

    const testUserId = "test-user-123";
    const password = "myTestPassword123";

    // Full lifecycle: signup -> logout -> signin -> encrypt -> decrypt
    const publicKey = await KeyManagementService.initializeOnSignup(testUserId, password);
    console.log("✅ Keypair generated, public key len:", publicKey.length);

    KeyManagementService.clearOnLogout();
    console.log("✅ Logged out, cache cleared");

    const loadResult = await KeyManagementService.loadOnSignIn(testUserId, password);
    console.log("✅ Reload with correct password:", loadResult); // expect { status: "ok" }

    const privateKey = KeyManagementService.getCachedPrivateKey();
    const encrypted = await CryptoService.hybridEncrypt("hello world", [
        { userId: testUserId, publicKey },
    ]);
    console.log("✅ Encrypted:", encrypted);

    const decrypted = await CryptoService.hybridDecrypt(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.encryptedAesKeys[testUserId],
        privateKey
    );
    console.log("✅ Decrypted:", decrypted); // MUST equal "hello world"

    // Wrong password should trigger new-device flow, not throw uncaught
    KeyManagementService.clearOnLogout();
    const wrongPwResult = await KeyManagementService.loadOnSignIn(testUserId, "wrongPassword");
    console.log("✅ Wrong password result:", wrongPwResult); // expect { status: "new-device", reason: "decrypt-failed" }
}

