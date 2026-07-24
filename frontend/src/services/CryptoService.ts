/**
 * ════════════════════════════════════════════════════════════════════════════════
 * CRITICAL SECURITY NOTICE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * This file handles raw cryptographic key material, including:
 *   - RSA private keys (base64 PKCS8)
 *   - AES symmetric keys (raw bytes)
 *   - Plaintext message content
 *
 * NEVER add console.log() calls that output ANY of the following:
 *   - privateKey (any format)
 *   - rawAesKey, plaintextBuf, decryptedBuf contents
 *   - plaintext strings (message content)
 *   - password values
 *   - mnemonic phrases / recovery seeds
 *
 * If you need to debug, use the Logger utility (services/Logger.ts) which:
 *   - Only logs in development mode
 *   - Logs lengths/hashes instead of raw values
 *   - Never exposes plaintext or key bytes
 * ════════════════════════════════════════════════════════════════════════════════
 */

const RSA_ALGO = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const AES_ALGO = { name: "AES-GCM", length: 256 };
const PBKDF2_ITERATIONS = 600000;

export interface KeyPairBase64 {
    publicKey: string;  // base64 SPKI — this is what gets uploaded to backend as-is
    privateKey: string; // base64 PKCS8 — NEVER leaves the browser unencrypted
}

export interface EncryptedPrivateKeyBundle {
    encryptedData: string;
    iv: string;
    salt: string;
}

export interface HybridEncryptResult {
    ciphertext: string;
    iv: string;
    encryptedAesKeys: Record<string, string>; // userId -> RSA-wrapped AES key (base64)
}

function bufToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBuf(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

class CryptoService {

    async generateRsaKeyPair(): Promise<KeyPairBase64> {
        const keyPair = (await crypto.subtle.generateKey(RSA_ALGO, true, ["encrypt", "decrypt"])) as CryptoKeyPair;
        const publicKeyRaw = await crypto.subtle.exportKey("spki", keyPair.publicKey);
        const privateKeyRaw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
        return { publicKey: bufToBase64(publicKeyRaw), privateKey: bufToBase64(privateKeyRaw) };
    }

    async importPublicKey(base64Spki: string): Promise<CryptoKey> {
        return crypto.subtle.importKey("spki", base64ToBuf(base64Spki), RSA_ALGO, true, ["encrypt"]);
    }

    async importPrivateKey(base64Pkcs8: string): Promise<CryptoKey> {
        return crypto.subtle.importKey("pkcs8", base64ToBuf(base64Pkcs8), RSA_ALGO, true, ["decrypt"]);
    }

    // aesKey never leaves this function in raw form except wrapped per-recipient — that's the whole point of hybrid encryption
    async hybridEncrypt(plaintext: string, recipients: { userId: string; publicKey: string }[]): Promise<HybridEncryptResult> {
        if (recipients.length === 0) throw new Error("hybridEncrypt: no recipients supplied");

        const aesKey = await crypto.subtle.generateKey(AES_ALGO, true, ["encrypt", "decrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(plaintext);
        const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encoded);
        const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);

        const encryptedAesKeys: Record<string, string> = {};
        for (const recipient of recipients) {
            const pubKey = await this.importPublicKey(recipient.publicKey);
            const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, rawAesKey);
            encryptedAesKeys[recipient.userId] = bufToBase64(wrapped);
        }

        return {
            ciphertext: bufToBase64(ciphertextBuf),
            iv: bufToBase64(iv.buffer),
            encryptedAesKeys,
        };
    }

    async hybridDecrypt(ciphertext: string, iv: string, encryptedAesKeyForUser: string, privateKey: CryptoKey): Promise<string> {
        const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, base64ToBuf(encryptedAesKeyForUser));
        const aesKey = await crypto.subtle.importKey("raw", rawAesKey, AES_ALGO, false, ["decrypt"]);
        const plaintextBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToBuf(iv) },
            aesKey,
            base64ToBuf(ciphertext)
        );
        return new TextDecoder().decode(plaintextBuf);
    }

    private async deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
        const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
            passwordKey,
            AES_ALGO,
            false,
            ["encrypt", "decrypt"]
        );
    }

    async encryptPrivateKey(privateKeyBase64Pkcs8: string, password: string): Promise<EncryptedPrivateKeyBundle> {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const derivedKey = await this.deriveKeyFromPassword(password, salt);
        const encryptedBuf = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            derivedKey,
            base64ToBuf(privateKeyBase64Pkcs8)
        );
        return {
            encryptedData: bufToBase64(encryptedBuf),
            iv: bufToBase64(iv.buffer),
            salt: bufToBase64(salt.buffer),
        };
    }

    // Throws on wrong password (AES-GCM auth tag check fails) — caller MUST catch this, it's the new-device trigger
    async decryptPrivateKey(bundle: EncryptedPrivateKeyBundle, password: string): Promise<string> {
        const salt = new Uint8Array(base64ToBuf(bundle.salt));
        const derivedKey = await this.deriveKeyFromPassword(password, salt);
        const decryptedBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToBuf(bundle.iv) },
            derivedKey,
            base64ToBuf(bundle.encryptedData)
        );
        return bufToBase64(decryptedBuf);
    }
}

const cryptoService = new CryptoService();
export default cryptoService;

