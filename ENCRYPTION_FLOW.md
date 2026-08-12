# End-to-End Encryption Flow — Chronological Walkthrough

This document describes the complete encryption lifecycle of the chat app, following a strict chronological order from account creation through messaging, password changes, and recovery. All steps reference the actual source code in `CryptoService.ts`, `KeyManagementService.ts`, `KeyStorageService.ts`, `RecoveryService.ts`, and `SessionRatchetService.ts`.

> **Architecture note (current code):** All message encryption uses the Signal Protocol Double Ratchet with Curve25519 (X25519) keys. There is **no legacy RSA path** — the RSA keypair, RSA-wrapped AES keys (`encryptedAesKeys`), the server-side `UserPublicKey` table, and `/api/users/public-key` endpoints have been **removed**. The backend (`MessageServiceImpl`) **rejects** any message where `encryptionFormat != "ratchet"` or where `ratchetHeader` is missing. The only supported encryption format is `ratchet`.

> **Security assessment:** A full security evaluation is provided at the end of this document in [Security Assessment & Deployment Readiness](#security-assessment--deployment-readiness). **The current implementation is NOT yet ready for production deployment** — see the listed blockers.

---

## Phase 1: Account Creation (Sign Up → OTP → Key Generation)

### Step 1.1 — User Signs Up

A new user (Alice) opens the app, clicks "Sign Up", and fills in:

```
Full Name: Alice Wonderland
Email: alice@example.com
Password: MyS3cur3P@ss!
```

**Client-side (`SignUp.tsx`):**
1. Reads reCAPTCHA v2 token from `window.grecaptcha.getResponse(widgetIdRef.current)` — if blank, blocks submission
2. Dispatches `register({ fullName, email, password, captchaToken })` → `POST /auth/signup`
3. Stores password temporarily as `window.__signupPassword = "MyS3cur3P@ss!"` for later use on the OTP page
4. Navigates to `/verify-otp` with email in `location.state`

**Server-side (`AuthController.java — @PostMapping("/signup")`):**
```java
// 1. Verifies reCAPTCHA: captchaService.verifyCaptcha(captchaToken)
// 2. Checks if email already exists in UserRepository
// 3. Generates 6-digit OTP: String.format("%06d", new Random().nextInt(1000000))
// 4. Creates PendingSignup with encoded password, OTP, 10-min expiry
// 5. Saves to pending_signup table
// 6. Sends OTP via emailService.sendOtpEmail(email, otpCode)
// 7. Returns { message: "OTP sent to your email", status: true }
```

**Keys used so far:** none (only reCAPTCHA site key for bot prevention)

---

### Step 1.2 — User Verifies OTP

Alice enters the 6-digit code received via email → dispatch `verifyOtp({ email, otpCode })` → `POST /auth/verify-otp`

**Server-side (`AuthController.java — @PostMapping("/verify-otp")`):**
```java
// 1. Finds PendingSignup by email → throws if not found
// 2. Checks OTP expiry (expiresAt < now) → deletes pending signup, throws error
// 3. Validates OTP code → throws "Invalid OTP code" on mismatch
// 4. Creates User entity from PendingSignup data
// 5. Saves User to user table, deletes PendingSignup
// 6. Generates JWT via TokenProvider.generateToken()
// 7. Returns { token: "eyJhbGciOiJIUzI1NiJ9...", isAuthenticated: true }
```

**Client-side (`VerifyOtp.tsx`):**
```javascript
// 1. Stores JWT token: localStorage.setItem(TOKEN, "eyJhbGci...")
// 2. Dispatches currentUser(token) → GET /api/users/profile
// 3. When authState.reqUser is populated → triggers initE2EEAndGeneratePhrase()
```

**Keys created so far:**
- **JWT token** — HMAC-signed, identifies Alice to the backend

---

### Step 1.3 — E2EE Key Generation (Curve25519 Identity Keypair)

Once Alice's profile loads (still on the VerifyOtp page), the app generates a **Curve25519 identity keypair** for X3DH + Double Ratchet:

```javascript
// VerifyOtp.tsx — initE2EEAndGeneratePhrase()
const userId = authState.reqUser.id.toString();    // "42"
const password = window.__signupPassword || "";     // "MyS3cur3P@ss!"

const publicKey = await KeyManagementService.initializeOnSignup(userId, password);
await KeyManagementService.uploadPreKeyBundle(token);
```

#### 3a. Generate Curve25519 Keypair (for X3DH + Double Ratchet forward secrecy)

```javascript
// KeyManagementService.generateProperCurve25519KeyPair()
const identityKeyPair = await KeyHelper.generateIdentityKeyPair();  // Signal Protocol library
// Exports: pubKey (raw Curve25519, base64), privKey (base64)
```

#### 3b. Encrypt Curve25519 Private Key Bundle with Password

The Curve25519 private key is encrypted as a single password-protected bundle:

```javascript
const combinedPrivateKey = JSON.stringify({
    curve25519PrivateKey: curve25519.privateKey,  // Curve25519 private key (base64)
});
const encryptedCombined = await CryptoService.encryptPrivateKey(combinedPrivateKey, password);
```

The encryption process uses:

```
Alice's Password ("MyS3cur3P@ss!")
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│ PBKDF2 (Password-Based Key Derivation Function 2)               │
│                                                                  │
│ Inputs:                                                          │
│   • Password: "MyS3cur3P@ss!"  (TextEncoder bytes)              │
│   • Salt:     16 random bytes from crypto.getRandomValues()      │
│   • Iterations: 600,000        (makes brute-force slow)         │
│   • Hash: SHA-256                                                │
│   • Derived key algorithm: AES-256-GCM                           │
│                                                                  │
│ Output:                                                          │
│   • AES-256 Key (never stored — used immediately then discarded) │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│ AES-256-GCM Encryption (Authenticated Encryption)               │
│                                                                  │
│ Inputs:                                                          │
│   • Derived AES Key         (from PBKDF2 above)                  │
│   • Plaintext: JSON string  {curve25519PrivateKey}               │
│   • IV: 12 random bytes     (from crypto.getRandomValues())      │
│                                                                  │
│ Output: EncryptedPrivateKeyBundle:                               │
│   {                                                              │
│     encryptedData: "a8f3c9d2b1e4...",  // ciphertext + GCM tag  │
│     iv: "7F3A8C...",                    // initialization vector │
│     salt: "A2b9F3c8..."                 // PBKDF2 salt           │
│   }                                                              │
└──────────────────────────────────────────────────────────────────┘
```

> **Note:** The bundle contains ONLY the Curve25519 private key. There is no RSA private key.

#### 3c. Save to IndexedDB

The encrypted bundle plus the plaintext Curve25519 public key are stored:

```javascript
const record: ExtendedStoredKeyRecord = {
    userId: "42",
    keyVersion: 1,
    encryptedData: encryptedCombined.encryptedData,  // encrypted JSON bundle
    iv: encryptedCombined.iv,
    salt: encryptedCombined.salt,
    publicKey: curve25519.publicKey,               // plaintext Curve25519 public key
    curve25519PublicKey: curve25519.publicKey,     // plaintext Curve25519 public key (ratchet)
    createdAt: "2024-01-15T10:30:00Z"
};
await KeyStorageService.saveKeyRecord(record);
```

#### 3d. Cache Keys in Memory

```javascript
this.curve25519PrivateKeyCache = curve25519.privateKey;   // Curve25519 private key
this.currentUserId = "42";
return curve25519.publicKey;  // Curve25519 public key (base64) — used for recovery
```

#### 3e. Generate & Upload the X3DH Pre-Key Bundle

The pre-key bundle is uploaded **immediately after signup** (not lazily):

```javascript
// KeyManagementService.uploadPreKeyBundle(token)
await SessionRatchetService.initialize(userId, curve25519PrivateKey, curve25519PublicKey, deviceId);
const bundle = await SessionRatchetService.generatePreKeyBundle(100);  // 100 one-time pre-keys
await SessionRatchetService.uploadPreKeyBundle(bundle, token);
// → PUT /api/users/pre-key-bundle
```

Inside `generatePreKeyBundle(100)`:
- Generates a **signed pre-key** via `KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId)`
- Generates **100 one-time pre-keys** via `KeyHelper.generatePreKey(id)` for `id = 1..100`
- Returns `PreKeyBundleDTO { identityKey, signedPreKey, signedPreKeySignature, signedPreKeyId, oneTimePreKeys }`

---

### Step 1.4 — Generate Recovery Phrase

After key generation, the app generates a 12-word BIP39 recovery phrase:

```javascript
const phrase = RecoveryService.generateMnemonic();
setRecoveryPhrase(phrase);
setShowPhraseDialog(true);
```

The user sees:

```
┌──────────────────────────────────────────────────┐
│         🔐 Your Recovery Phrase                  │
│                                                   │
│  ⚠️ This is the ONLY way to recover your         │
│     encrypted messages if you lose your password  │
│                                                   │
│  ┌──────────┬──────────┬──────────┐              │
│  │ 1. abandon│ 5. breeze │ 9. casino │             │
│  │ 2. bamboo │ 6. clock  │10. depart │             │
│  │ 3. brick  │ 7. eagle  │11. fossil │             │
│  │ 4. cabin  │ 8. guitar │12. hybrid │             │
│  └──────────┴──────────┴──────────┘              │
│                                                   │
│  ☐ I have saved my recovery phrase...            │
│                                                   │
│  [       I've Saved It — Continue       ]        │
└──────────────────────────────────────────────────┘
```

When Alice checks "I saved this" and clicks Continue:

```javascript
// onRecoveryPhraseConfirmed()
// 1. Reads the encrypted key bundle from IndexedDB
const record = await KeyStorageService.getKeyRecord(userId);

// 2. Decrypts the bundle using password
const privateKeyBase64 = await CryptoService.decryptPrivateKey(
    { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
    password  // "MyS3cur3P@ss!"
);
// → Returns '{"curve25519PrivateKey":"ABC123..."}'

// 3. Re-encrypts the SAME bundle with the recovery phrase
const recoveryBlob = await RecoveryService.encryptPrivateKeyWithMnemonic(
    privateKeyBase64,  // The full JSON bundle string
    recoveryPhrase      // The 12-word phrase
);

// 4. Uploads recovery blob to server
await RecoveryService.uploadRecoveryBlob(recoveryBlob, token);
// → PUT /api/recovery/blob

// 5. Marks phrase as shown
RecoveryService.markPhraseShown();  // localStorage flag
```

**Server-side (`RecoveryController.java — PUT /api/recovery/blob`):**
```java
// Saves RecoveryBlob { userId, encryptedData, iv, salt } to recovery_blob table
recoveryService.saveRecoveryBlob(user.getId(), request);
```

---

### Step 1.5 — Cleanup & Redirect

```javascript
setShowPhraseDialog(false);
navigate("/");                              // Go to homepage
```

> **Note:** `window.__signupPassword` is NOT explicitly deleted in the current `VerifyOtp.tsx`. It is referenced again in `onRecoveryPhraseConfirmed`. See [Security Assessment](#security-assessment--deployment-readiness) for the risk this poses.

---

## Phase 2: Sign In Flow

### Step 2.1 — Sign In & Key Loading

Alice returns later and signs in:

```javascript
// SignIn.tsx — onSubmit()
dispatch(loginUser({ email, password }));
// → POST /auth/signin → returns { token, isAuthenticated: true }
```

When sign-in succeeds, `loadOnSignIn()` tries to load existing keys from IndexedDB:

```javascript
// SignIn.tsx — handleLoginSuccess()
const loadResult = await KeyManagementService.loadOnSignIn(userId, password);
```

Inside `KeyManagementService.loadOnSignIn()`:

```javascript
const record = await KeyStorageService.getKeyRecord(userId);
if (!record) return { status: "new-device", reason: "no-local-key" };

try {
    const decryptedBundle = await CryptoService.decryptPrivateKey(
        { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
        password
    );

    // Parse the Curve25519 private key from the bundle
    let curve25519PrivateKey;
    try {
        const parsed = JSON.parse(decryptedBundle);
        curve25519PrivateKey = parsed.curve25519PrivateKey;
    } catch {
        curve25519PrivateKey = decryptedBundle;  // raw key fallback
    }

    this.curve25519PrivateKeyCache = curve25519PrivateKey || null;
    const curve25519PublicKeyCache = (record as ExtendedStoredKeyRecord).curve25519PublicKey || null;
    this.currentUserId = userId;

    // Initialize SessionRatchetService ONLY if BOTH private + public keys are present
    if (this.curve25519PrivateKeyCache && curve25519PublicKeyCache) {
        const deviceId = KeyStorageService.getOrCreateDeviceId();
        await SessionRatchetService.initialize(
            userId,
            this.curve25519PrivateKeyCache,
            curve25519PublicKeyCache,
            deviceId
        );
    }

    return { status: "ok" };
} catch {
    return { status: "new-device", reason: "decrypt-failed" };
}
```

> **Important:** Session ratchet initialization requires **both** the private key (from the encrypted bundle) **and** the public key (from the stored `curve25519PublicKey` field). If the public key is missing, the ratchet is never initialized and message decryption will fail.

### Step 2.2 — Outcome: Normal vs "New Device"

**Normal flow (keys found):** Navigate to homepage. Curve25519 key is loaded into `SessionRatchetService`.

**New device flow (no keys or wrong password):** A dialog appears with two options:

```
┌─────────────────────────────────────────────────────────┐
│  🔐 New Device Detected                                │
│                                                         │
│  This device has no encryption keys. Messages sent      │
│  before this login cannot be decrypted here.            │
│                                                         │
│  [I have my recovery phrase]  [Start fresh (keys lost)] │
└─────────────────────────────────────────────────────────┘
```

**Option A — Recovery with phrase:**
```javascript
// handleRecoverySubmit()
await RecoveryService.recoverAccess(trimmedPhrase, password, userId, token);
```
Inside `RecoveryService.recoverAccess()`:
1. Fetches recovery blob from server: `GET /api/recovery/blob`
2. Decrypts with mnemonic: `decryptPrivateKeyWithMnemonic(blob, mnemonic)`
3. Re-wraps with new password: `CryptoService.encryptPrivateKey(privateKeyBase64, newPassword)`
4. Saves re-wrapped key record to IndexedDB — **note: this record does NOT include `curve25519PublicKey`**
5. Loads into cache via `KeyManagementService.loadOnSignIn()`
6. Navigates to homepage — old messages SHOULD be decryptable, but see [Security Assessment] (#recovery-bug)

**Option B — Start fresh (atomic regeneration with rollback):**
```javascript
// handleNewDeviceConfirm()
// Step 1: Generate new keypair (in-memory only — not persisted)
const { record: newRecord } = await KeyManagementService.regenerateKeysWithoutPersist(userId, password);

// Step 2: Generate new recovery phrase
const phrase = RecoveryService.generateMnemonic();
const recoveryBlob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKeyBase64, phrase);

// Step 3: Upload recovery blob FIRST
await RecoveryService.uploadRecoveryBlob(recoveryBlob, token);

// Step 4: Upload the new pre-key bundle SECOND
await KeyManagementService.uploadPreKeyBundle(token);

// Step 5: BOTH succeeded → NOW persist to IndexedDB
await KeyManagementService.persistKeyRecord(newRecord);

// Step 6: Mark phrase shown and navigate
RecoveryService.markPhraseShown();
navigate("/");

// If any step fails → ROLLBACK by restoring old record
if (oldRecord) {
    await KeyManagementService.restoreFromKeyRecord(oldRecord, password);
}
```

---

## Phase 3: First Double Ratchet Message (Pairwise Fan-Out)

When Alice sends a message to Bob, the app performs a **per-recipient** Double Ratchet encryption. If a session doesn't exist with a recipient, it performs **lazy X3DH initialization**.

### Step 3.1 — Encrypt for Every Recipient (Including Self)

```javascript
// Homepage.tsx — onSendMessage()
const memberIds = currentChat.users.map(u => u.id.toString()).filter(id => id !== myUserId);
const targetIds = [...memberIds, myUserId];   // recipients + self

const ratchetResults = await Promise.all(
    targetIds.map(async (recipientId) => {
        const result = await SessionRatchetService.ratchetEncrypt(
            newMessage.trim(), recipientId, token
        );
        return { recipientId, result };
    })
);

// Build per-recipient ratchet headers
const ratchetHeaders: Record<string, string> = {};
for (const { recipientId, result } of ratchetResults) {
    ratchetHeaders[recipientId] = result.ratchetHeader;
}

dispatch(createMessage({
    chatId: currentChat.id,
    content: ratchetResults[0].result.ciphertext,   // first recipient's ciphertext
    iv: ratchetResults[0].result.iv,
    ratchetHeader: JSON.stringify(ratchetHeaders),  // map of userId → header
    encryptionFormat: 'ratchet',
}, token));
```

### Step 3.2 — Lazy X3DH Session Init

```javascript
// SessionRatchetService.ratchetEncrypt() → _lazyInitSession(theirUserId, authToken)

// Only runs if no session exists with the recipient:
const existingSession = await this.store.loadSession(theirAddress.toString());
if (!existingSession) {
    await this._lazyInitSession(theirUserId, authToken);
}

// 1. Fetch recipient's pre-key bundle from server
GET /api/users/99/pre-key-bundle
→ { identityKey, signedPreKey, signedPreKeySignature, signedPreKeyId, oneTimePreKeys }

// 2. Atomically consume one of the recipient's one-time pre-keys
POST /api/users/pre-key-bundle/consume
{ "senderUserId": "42" }
→ { "id": 1, "key": "base64_otpk" }  // consumed with FOR UPDATE lock
```

**X3DH Key Agreement (Signal Protocol):**
```
Alice's Identity Key (IK_A)     Bob's Identity Key (IK_B)
Alice's Ephemeral Key (EK_A)    Bob's Signed Pre-Key (SPK_B)
                                Bob's One-Time Pre-Key (OTPK_B)

Shared Secret = DH(IK_A, SPK_B) + DH(EK_A, IK_B) + DH(EK_A, SPK_B) + DH(EK_A, OTPK_B)
                                                    ↓
                                            Root Key (RK)
```

### Step 3.3 — Encrypt with Double Ratchet

```javascript
// SessionRatchetService.ratchetEncrypt()
const cipher = new SessionCipher(store, theirAddress);
const encrypted = await cipher.encrypt(new TextEncoder().encode("Hey Bob! Want coffee?").buffer);

// The Signal library:
// 1. Derives a message key from the sending chain (HKDF)
// 2. AES-256-GCM encrypts the plaintext
// 3. Ratchets the DH key forward (new ephemeral key pair)
// 4. Deletes the old message key → FORWARD SECRECY

const ratchetHeader = JSON.stringify({
    type: encrypted.type,            // 3 = PreKeyWhisperMessage, 1 = WhisperMessage
    body: encrypted.body,            // base64 ciphertext body
    registrationId: encrypted.registrationId,
    deviceId: this.currentDeviceId,
});

return {
    ciphertext: encrypted.body,      // base64 ciphertext
    iv: arrayBufferToBase64(iv.buffer),
    ratchetHeader,
};
```

**What gets stored on the server:**
```json
{
  "content": "a8f3c9d2b1e4...",
  "iv": "base64_iv",
  "ratchetHeader": "{\"42\":\"{\\\"type\\\":3,\\\"body\\\":\\\"...\\\",\\\"registrationId\\\":1,\\\"deviceId\\\":\\\"dev123\\\"}\"}",
  "encryptionFormat": "ratchet"
}
```

> **Note on `content`:** The `content` field stores the ciphertext produced for the **first recipient** in the `targetIds` array. Decryption on each recipient's side uses the **per-recipient `ratchetHeader.body`** (via `_selectRatchetHeader`), NOT the `content` field directly. The `content` field is effectively a redundant copy and is not used for decryption.

### Step 3.4 — Decrypt (Recipient Side)

```javascript
// MessageCard.tsx — ratchet decrypt path
if (props.message.isEncrypted && props.reqUser) {
    const senderUserId = props.message.user.id.toString();
    if (!props.message.ratchetHeader) {
        setDecryptError(true);
        TelemetryService.logDecryptFailure({ failureReason: "missing-ratchet-header", ... });
        return;
    }
    const plaintext = await SessionRatchetService.ratchetDecrypt(
        props.message.ratchetHeader!,   // JSON header map
        props.message.content,          // ciphertext (base64)
        senderUserId                    // sender's user ID
    );
}
```

Inside `SessionRatchetService.ratchetDecrypt()`:
1. Parse the ratchet header (a map), then select the entry for the current user via `_selectRatchetHeader`
2. Create `SessionCipher` for the sender's address
3. If `type === 3` → `cipher.decryptPreKeyWhisperMessage()` (establishes session on recipient's side)
4. If `type === 1` → `cipher.decryptWhisperMessage()` (subsequent messages)
5. Library automatically derives correct chain key, deletes used message key, and flushes session state to IndexedDB

### Step 3.5 — Forward Secrecy in Action

```
TIME →  Week 1           Week 2           Week 3           Week 4
         │                │                │                │
Alice    ✎ "Hey Bob!"    ✎ "Lunch?"       ✎ "Project X"   💥 LAPTOP STOLEN
sends:   │                │                │                │
         │  Ratchet Key   │  Ratchet Key   │  Ratchet Key   │  Keys exposed!
         │  ┌─┐           │  ┌─┐           │  ┌─┐           │
         │  │K1│←deleted  │  │K2│←deleted  │  │K3│←deleted  │
         │  └─┘           │  └─┘           │  └─┘           │
         ▼                ▼                ▼                ▼
EVIL EVE:  Can't decrypt  Can't decrypt   CAN decrypt K3
           (K1 deleted)   (K2 deleted)    (K3 in memory)
```

**Forward secrecy:** Past message keys are deleted immediately after use. Even if the device is compromised, only future messages are at risk.

---

## Phase 4: Subsequent Double Ratchet Messages

Once a session is established with a recipient, subsequent messages use the existing ratchet:

1. `SessionRatchetService` finds an existing session for the recipient
2. Skip X3DH init, directly call `cipher.encrypt(plaintext)`
3. `encrypted.type === 1` (WhisperMessage, not PreKeyWhisperMessage)
4. Ratchet rotates keys again — message keys from previous messages remain deleted

---

## Phase 5: Group Chat Encryption (Pairwise Fan-Out)

For group chats with 3+ members, the app encrypts the message **N separate times** — once per recipient (including the sender for their own copy):

```javascript
// Homepage.tsx — ratchet path for groups
const targetIds = [...memberIds, myUserId];
const ratchetResults = await Promise.all(
    targetIds.map(async (recipientId) => {
        const result = await SessionRatchetService.ratchetEncrypt(
            newMessage.trim(), recipientId, token
        );
        return { recipientId, result };
    })
);

// Build per-recipient ratchet headers
const ratchetHeaders: Record<string, string> = {};
for (const { recipientId, result } of ratchetResults) {
    ratchetHeaders[recipientId] = result.ratchetHeader;
}
```

The `ratchetHeader` map includes one entry per recipient:
```json
{
  "99": "{\"type\":3,\"body\":\"...\"}",
  "111": "{\"type\":3,\"body\":\"...\"}"
}
```

Each recipient independently decrypts using their session with the sender. **Tradeoff:** O(N) encrypted copies per message for N members. Acceptable for small groups (<20 users).

---

## Phase 6: Pre-Key Bundle Lifecycle

### Bundle Generation & Upload

```javascript
// SessionRatchetService.generatePreKeyBundle(100)
const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
// Generate 100 one-time pre-keys
for (let i = 0; i < 100; i++) {
    const otpk = await KeyHelper.generatePreKey(i + 1);
    oneTimePreKeys.push({ id: otpk.keyId, key: base64(otpk.pubKey) });
}
return {
    identityKey: base64(curve25519PubKey),
    signedPreKey: base64(signedPreKeyPubKey),
    signedPreKeySignature: base64(signature),
    signedPreKeyId: 1,
    oneTimePreKeys: JSON.stringify(oneTimePreKeys)
};
```

### Bundle Upload

```javascript
PUT /api/users/pre-key-bundle
Body: { identityKey, signedPreKey, signedPreKeySignature, signedPreKeyId, oneTimePreKeys }
```

### Atomic Consumption (Server-side)

```java
// PreKeyBundleRepository.java — consumeOneTimePreKeyAtomic()
// Uses PostgreSQL CTE with FOR UPDATE lock:
WITH popped AS (
  SELECT user_id, one_time_pre_keys -> -1 AS consumed_key
  FROM pre_key_bundle
  WHERE user_id = :userId AND jsonb_array_length(one_time_pre_keys::jsonb) > 0
  FOR UPDATE
)
UPDATE pre_key_bundle p
SET one_time_pre_keys = one_time_pre_keys::jsonb - -1
FROM popped
WHERE p.user_id = popped.user_id
RETURNING popped.consumed_key::text
```

### Automatic Replenishment

```javascript
// SessionRatchetService.refreshPreKeysIfNeeded(minCount, authToken)
if (this.getOneTimePreKeyCount() < minCount) {
    const newBundle = await this.generatePreKeyBundle(100);
    await this.uploadPreKeyBundle(newBundle, authToken);
}
```

> **⚠️ Current limitation:** `generatePreKeyBundle(100)` always regenerates pre-keys with IDs `1..100`. On a page reload, previously-consumed OTPK IDs get re-uploaded, which weakens one-time-key uniqueness. See [Security Assessment](#security-assessment--deployment-readiness).

### Signed Pre-Key Rotation (7-Day Window)

```javascript
// _getOrCreateSignedPreKeyMeta() — localStorage 'chatapp_signed_prekey_meta'
{
  currentId: 1,
  nextRotationAt: <now + 7 days>
}
```

When the current signed pre-key expires, `_rotateSignedPreKeyMeta()` increments the ID and generates a fresh signed pre-key.

> **⚠️ Current limitation:** The signed pre-key **signature** is stored only in memory (`InMemorySignalStore.setSignedPreKeyWithSignature`) and is lost on reload. See [Security Assessment](#security-assessment--deployment-readiness).

---

## Phase 7: Session Persistence (IndexedDB)

Sessions are encrypted at rest in the `ratchetSessions` object store:

```javascript
// SessionRatchetService._flushSessionsToStorage()
const encrypted = await this._encryptSessionData(sessionData);
await KeyStorageService.saveSession({
    userId: address,                     // e.g., "99.1" (recipient's SignalProtocolAddress)
    deviceId: this.currentDeviceId,
    sessionData: encrypted,             // AES-GCM encrypted with store key
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
});
```

The store encryption key is derived from the Curve25519 private key:

```javascript
const storeKeyMaterial = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(curve25519PrivateKey.substring(0, 32)),
    'PBKDF2', false, ['deriveKey']);
this.storeEncryptionKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('chatapp-ratchet-store-' + userId),
      iterations: 100000, hash: 'SHA-256' },
    storeKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
);
```

---

## Phase 8: Password Change

When Alice changes her password, her Curve25519 key bundle is re-wrapped:

```javascript
// Profile.tsx — onChangePasswordSubmit()
await KeyManagementService.changePassword(userId, oldPassword, newPassword);

// Inside changePassword():
const record = await KeyStorageService.getKeyRecord(userId);
const decryptedBundle = await CryptoService.decryptPrivateKey(bundle, oldPassword);
// → '{"curve25519PrivateKey":"ABC123..."}'

const parsed = JSON.parse(decryptedBundle);
const newBundle = JSON.stringify({ curve25519PrivateKey: parsed.curve25519PrivateKey });
const reEncrypted = await CryptoService.encryptPrivateKey(newBundle, newPassword);

await KeyStorageService.saveKeyRecord({ ...record, encryptedData, iv, salt });

// Also update server-side password hash
dispatch(changePassword(data, token));  // PUT /auth/password
```

---

## Phase 9: Key Regeneration (Atomic with Rollback)

Alice can voluntarily regenerate keys from the Profile page. This uses an **atomic pattern**:

```javascript
// Profile.tsx — onRegenKeysConfirm()

// 0. Save old record BEFORE any mutations (rollback snapshot)
const oldRecord = await KeyStorageService.getKeyRecord(userId);

try {
    // Step 1: Generate new keypair (in-memory ONLY — not persisted)
    const { record: newRecord } = await KeyManagementService.regenerateKeysWithoutPersist(userId, regenPassword);

    // Step 2: Generate new recovery phrase + encrypted blob
    const phrase = RecoveryService.generateMnemonic();
    const recoveryBlob = await RecoveryService.encryptPrivateKeyWithMnemonic(privateKeyBase64, phrase);

    // Step 3: Upload recovery blob FIRST
    await RecoveryService.uploadRecoveryBlob(recoveryBlob, token);

    // Step 4: Upload the new pre-key bundle SECOND
    await KeyManagementService.uploadPreKeyBundle(token);

    // Step 5: BOTH succeeded → NOW persist to IndexedDB
    await KeyManagementService.persistKeyRecord(newRecord);

    // Step 6: Show new recovery phrase to user
    setRecoveryPhrase(phrase);
    setShowRecoveryPhraseDialog(true);

} catch (err) {
    // ROLLBACK: restore the OLD key record and reload into cache
    if (oldRecord) {
        await KeyManagementService.restoreFromKeyRecord(oldRecord, regenPassword);
    }
    alert("Key regeneration failed. Original keys remain active.");
}
```

**Why this order matters:**
- If step 3 fails → old recovery blob still matches a valid record → no data loss
- If step 4 fails → old pre-key bundle on the server still has a valid recovery path
- If step 5 never executes → IndexedDB still holds old keys → user can still decrypt old messages
- If step 5 executes → new keys are committed, old keys are irreversibly replaced (but new recovery blob is already on server)

---

## Phase 10: Account Recovery

### Recovery Page (`/recover`)
A separate page for full account recovery:

```javascript
// RecoverAccess.tsx — onSubmit()
await RecoveryService.recoverAccess(trimmedPhrase, newPassword, userId, token);
// Navigates to "/" on success
```

### Recovery Flow Details

```javascript
// RecoveryService.recoverAccess()
1. const blob = await this.fetchRecoveryBlob(token);         // GET /api/recovery/blob
2. const privateKeyBase64 = await this.decryptPrivateKeyWithMnemonic(blob, mnemonic);
3. const encrypted = await CryptoService.encryptPrivateKey(privateKeyBase64, newPassword);
4. await KeyStorageService.saveKeyRecord({
       userId, keyVersion: 1, encryptedData, iv, salt,   // ← NO curve25519PublicKey
       createdAt
   });
5. await KeyManagementService.loadOnSignIn(userId, newPassword);
```

> **⚠️ Recovery bug (HIGH):** Step 4 saves a key record **without** `curve25519PublicKey`. In `loadOnSignIn()`, the ratchet is initialized only when **both** the private and public keys are present. After recovery, the private key is restored but the public key is missing → `SessionRatchetService` is never initialized → **old Double Ratchet messages cannot be decrypted** on the recovered device. This defeats the primary purpose of recovery. See [Security Assessment](#recovery-bug).

---

## Complete Key Hierarchy

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        END-TO-END ENCRYPTION KEY MAP                        │
│                                                                              │
│  IDENTITY KEY (generated at signup, stored in IndexedDB encrypted bundle):   │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Curve25519 (X25519) Identity Keypair (DOUBLE RATCHET)                │    │
│  │  • Generated: KeyHelper.generateIdentityKeyPair() (Signal library)   │    │
│  │  • Public Key  → Uploaded as part of X3DH PreKeyBundle               │    │
│  │  • Private Key → In IndexedDB, encrypted with password-derived key   │    │
│  │  • Used for: X3DH session initiation + DH ratchet                    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  SESSION KEYS (per-peer, managed by Signal Protocol library):                │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Root Key       → Derived from X3DH (4 DH computations)               │    │
│  │ Chain Keys     → Rotated per message (HKDF-derived from root)        │    │
│  │ Message Keys   → Deleted immediately after use → FORWARD SECRECY     │    │
│  │ DH Ratchet Keys → New ephemeral key pair each ratchet step           │    │
│  │ MAX_SKIP        → 100 (buffers out-of-order messages)                │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  KEY DERIVATION:                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Password → PBKDF2(600K, SHA-256) → AES-256-GCM → encrypts key bundle │    │
│  │ Mnemonic → PBKDF2(600K, SHA-256) → AES-256-GCM → encrypts key bundle │    │
│  │ Curve25519 → PBKDF2(100K, SHA-256) → AES-256-GCM → encrypts sessions │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  SERVER STORAGE:                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ PreKeyBundle table:   userId → Curve25519 info + one-time pre-keys   │    │
│  │ RecoveryBlob table:   userId → encrypted key bundle (mnemonic-derived)│    │
│  │ Message table:        messageId → ciphertext + IV + ratchetHeader    │    │
│  │                       + encryptionFormat ("ratchet")                  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  CLIENT STORAGE (IndexedDB):                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ privateKeys store:     userId → encrypted key bundle (password-derived)│   │
│  │ ratchetSessions store:  userId → encrypted session data (store key)   │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Summary: All Cryptographic Keys

| Key Type | Algorithm | Length | Generated | Stored | Purpose |
|----------|-----------|--------|-----------|--------|---------|
| Curve25519 Identity Keypair | Curve25519 (X25519) | 256 bits | `KeyHelper.generateIdentityKeyPair()` | Public: server `PreKeyBundle` + IndexedDB; Private: IndexedDB (encrypted bundle) | X3DH session init + DH ratchet |
| Signed Pre-Key | Curve25519 (X25519) | 256 bits | `KeyHelper.generateSignedPreKey()` | Server `PreKeyBundle` | Medium-term DH key for X3DH |
| One-Time Pre-Keys | Curve25519 (X25519) | 256 bits | `KeyHelper.generatePreKey()` (batch of 100) | Server `PreKeyBundle` JSON array; consumed atomically | Single-use session initiation |
| Root Key (RK) | X3DH (4 DH computations) | 256 bits | `SessionBuilder.processPreKey()` | In-memory session state; persisted encrypted to IndexedDB | Seed for Double Ratchet chain derivation |
| Chain Keys (CK) | HKDF from RK | 256 bits | Signal Protocol ratchet | In-memory; flushed encrypted to IndexedDB | Per-message key derivation |
| Message Keys (MK) | HKDF from CK | 256 bits | Signal Protocol ratchet | **Deleted immediately after use** | AES-GCM encrypt/decrypt individual messages |
| DH Ratchet Ephemeral Keys | X25519 | 256 bits | Signal Protocol per-message ratchet step | In-memory; old keys deleted after ratchet step | Forward secrecy |
| Password-derived AES Key | PBKDF2 → AES-GCM | 256 bits | `CryptoService.deriveKeyFromPassword()` | Never stored (derived on demand) | Encrypt/decrypt key bundle in IndexedDB |
| Mnemonic-derived AES Key | PBKDF2 → AES-GCM | 256 bits | `RecoveryService.deriveKeyFromMnemonic()` | Never stored (derived on demand) | Encrypt/decrypt key bundle in recovery blob |
| Store Encryption Key | PBKDF2 → AES-GCM | 256 bits | `SessionRatchetService.initialize()` | Never stored (derived from Curve25519) | Encrypt/decrypt session data at rest |
| PBKDF2 Salt | Random | 128 bits | `crypto.getRandomValues()` | IndexedDB + server recovery blob | Ensure unique derived keys |
| AES-GCM IV | Random | 96 bits | `crypto.getRandomValues()` | IndexedDB + server + message payload | Ensure unique ciphertexts |
| JWT | HMAC | Configurable | `TokenProvider.generateToken()` | `localStorage` | API authentication |
| BIP39 Mnemonic | 12-word phrase | ~108 bits (subset) | `RecoveryService.generateMnemonic()` | User's memory/paper (NOT stored digitally) | Backup key recovery |
| Key Version | Integer | — | `KeyManagementService` | IndexedDB `keyVersion` | Track key regeneration count |
| One-Time Pre-Keys | Curve25519 (X3DH) | 256 bits | `SessionRatchetService.generatePreKeyBundle()` | Server `PreKeyBundle` JSON array | Single-use session initiation |
| Device ID | Random hex | 128 bits | `KeyStorageService.getOrCreateDeviceId()` | `localStorage` | Identify device for session management |

---

## Security Assessment & Deployment Readiness

### Verdict: ⚠️ NOT READY for Production Deployment

The cryptographic construction (X3DH + Double Ratchet via the Signal Protocol library) is sound, and the at-rest encryption is well-configured (PBKDF2 600k iterations, AES-256-GCM, unique salts/IVs). However, there are **functional and security blockers** that must be fixed before production.

### Blocker 1 — Recovery breaks the Double Ratchet (HIGH) <a name="recovery-bug"></a>

- `RecoveryService.recoverAccess()` saves a key record without `curve25519PublicKey`.
- `loadOnSignIn()` initializes `SessionRatchetService` only when **both** private and public keys are present.
- **Result:** After a successful recovery, the user's private key is restored, but the ratchet is never initialized → **old messages cannot be decrypted**. This silently defeats the recovery promise.
- **Fix:** Persist `curve25519PublicKey` in the recovered record (re-derive the public key from the private key, or store the public key in the recovery blob alongside the private key).

### Blocker 2 — Trust-On-First-Use (TOFU) with no MITM protection (HIGH)

- `InMemorySignalStore.isTrustedIdentity()` returns `true` unconditionally.
- There is no safety-number / fingerprint display or verification.
- **Result:** A malicious server or a network attacker performing an active MITM can substitute their own identity keys silently. Neither party would detect the substitution.
- **Fix:** Implement identity-key fingerprint (safety number) verification shown in the UI, and/or pin identity keys server-side with key transparency.

### Blocker 3 — Non-standard recovery phrase (MEDIUM-HIGH)

- Only the **first 512 BIP39 words** are used (≈108 bits of entropy, not the standard 128).
- There is **no BIP39 checksum** — a typo in any word yields a silent wrong-key failure with no validation feedback.
- The code accepts *any* 12 words; there is no wordlist validation.
- **Fix:** Use the full 2048-word BIP39 list, compute the proper checksum word, and validate entered words on recovery.

### Blocker 4 — Signed pre-key signature not persisted (MEDIUM)

- The signed pre-key signature is stored only in memory (`setSignedPreKeyWithSignature`) and lost on reload.
- Signature verification is essential for X3DH authenticity.
- **Fix:** Persist the signed pre-key signature alongside the signed pre-key in the store / IndexedDB.

### Blocker 5 — One-time pre-key reuse after reload (MEDIUM)

- `generatePreKeyBundle(100)` always uses IDs `1..100`.
- After a page reload, consumed OTPK IDs are re-uploaded, so previously-consumed one-time pre-keys become valid again — weakening one-time-key guarantees.
- **Fix:** Track the highest used pre-key ID and only generate fresh IDs on replenishment.

### Blocker 6 — JWT stored in `localStorage` (MEDIUM)

- The JWT is stored in `localStorage`, which is readable by any XSS script.
- **Fix:** Store the token in an `httpOnly`, `Secure`, `SameSite` cookie (already flagged in the deployment guide's Production Readiness notes).

### Blocker 7 — Temporary signup password in global scope (MINOR)

- `window.__signupPassword` holds the password in memory across the OTP page and is not cleared after use.
- **Fix:** Scope it to component state and clear it after the recovery blob is created.

### Recommendations (not blockers)

- Replace the embedded 512-word BIP39 subset with the full list from the `bip39` npm package.
- Add end-to-end integration tests for the recovery flow that assert old messages decrypt after recovery.
- Add a telemetry metric for ratchet-decrypt success/failure across the whole app.
- Consider limiting the O(N) group fan-out for large groups (e.g., sender keys).

### What is done well

- Correct use of the Signal Protocol Double Ratchet (X3DH + DH ratchet + symmetric ratchet).
- Forward secrecy: message keys deleted immediately after use.
- Authenticated encryption (AES-256-GCM) for data at rest.
- High PBKDF2 iteration count (600,000) for password / mnemonic-derived keys.
- Atomic one-time pre-key consumption via PostgreSQL `FOR UPDATE` CTE (prevents OTPK reuse race conditions during concurrent sends).
- Atomic key-regeneration pattern with rollback.
- Sessions encrypted at rest in IndexedDB.
