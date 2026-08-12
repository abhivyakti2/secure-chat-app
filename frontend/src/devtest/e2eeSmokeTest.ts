/**
 * E2EE smoke test — call manually from browser console:
 *
 *   import('./devtest/e2eeSmokeTest').then(m => m.run());
 *
 * NEVER import this from any component. This file is a throwaway
 * dev-only verification of the full encrypted-messaging lifecycle.
 *
 * NOTE: This now exercises the Curve25519 / Double Ratchet key lifecycle
 * (identity keypair + password-protected at-rest bundle). Per-message
 * encryption is handled by SessionRatchetService (X3DH + Double Ratchet)
 * which requires two users with pre-key bundles, so it's not covered here.
 */

export async function run(): Promise<void> {
    const CryptoService = (await import("../services/CryptoService")).default;
    const KeyManagementService = (await import("../services/KeyManagementService")).default;

    const testUserId = "test-user-123";
    const password = "myTestPassword123";

    // Full lifecycle: signup -> logout -> signin
    const publicKey = await KeyManagementService.initializeOnSignup(testUserId, password);
    console.log("✅ Curve25519 keypair generated, public key len:", publicKey.length);

    KeyManagementService.clearOnLogout();
    console.log("✅ Logged out, cache cleared");

    const loadResult = await KeyManagementService.loadOnSignIn(testUserId, password);
    console.log("✅ Reload with correct password:", loadResult); // expect { status: "ok" }

    // Verify the Curve25519 private key is available for the ratchet
    const curve25519PrivateKey = KeyManagementService.getCurve25519PrivateKey();
    if (!curve25519PrivateKey) {
        throw new Error("❌ Curve25519 private key not loaded after sign-in");
    }
    console.log("✅ Curve25519 private key loaded, len:", curve25519PrivateKey.length);

    // At-rest bundle round-trip
    const bundle = await CryptoService.encryptPrivateKey(
        JSON.stringify({ curve25519PrivateKey }),
        password
    );
    const decryptedBundle = await CryptoService.decryptPrivateKey(bundle, password);
    const parsed = JSON.parse(decryptedBundle);
    if (parsed.curve25519PrivateKey !== curve25519PrivateKey) {
        throw new Error("❌ At-rest bundle round-trip failed");
    }
    console.log("✅ Password-protected at-rest bundle round-trip OK");

    // Wrong password should trigger new-device flow, not throw uncaught
    KeyManagementService.clearOnLogout();
    const wrongPwResult = await KeyManagementService.loadOnSignIn(testUserId, "wrongPassword");
    console.log("✅ Wrong password result:", wrongPwResult); // expect { status: "new-device", reason: "decrypt-failed" }
}
