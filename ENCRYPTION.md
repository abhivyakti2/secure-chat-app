# Encryption Process — Complete Reference

This document describes **every** cryptographic step in the chat-app: algorithms, keys, lifecycles, forward/backward secrecy, rotation, edge cases, and known limitations. It reflects the implementation as of the current codebase (Signal Protocol via `@privacyresearch/libsignal-protocol-typescript`, Web Crypto API for at-rest wrapping).

**Primary source files**

| Area | Path |
|---|---|
| Password wrap / unwrap | `frontend/src/services/CryptoService.ts` |
| Identity lifecycle | `frontend/src/services/KeyManagementService.ts` |
| IndexedDB key/session stores | `frontend/src/services/KeyStorageService.ts` |
| X3DH + Double Ratchet | `frontend/src/services/SessionRatchetService.ts` |
| Recovery phrase | `frontend/src/services/RecoveryService.ts` |
| Send fan-out | `frontend/src/components/Homepage.tsx` |
| Decrypt UI | `frontend/src/components/messageCard/MessageCard.tsx` |
| Pre-key consume (atomic) | `backend/.../UserServiceImpl.java` |
| Live delivery merge | `backend/.../RealtimeChatController.java` |

---

## 1. Threat model and design goals

### What the system aims to protect

- **Passive network attacker:** cannot read message plaintext (TLS + E2EE ciphertext).
- **Honest-but-curious server:** stores ciphertext, pre-key *public* material, and recovery *blobs*; never holds plaintext or identity private keys in usable form.
- **Account abuse:** OTP, lockout, reCAPTCHA (auth layer — separate from message crypto; see `README.md`).

### What it does **not** fully protect against

- Compromised browser / malware (memory holds plaintext, CryptoKeys, and decrypted session state).
- Active server that swaps pre-key bundles before first trust (**TOFU** / pin window).
- Lost device without wipe (encrypted IndexedDB still present; password/phrase can unlock).
- Multi-device sync of history (not implemented).
- Attachment/file content (no file encryption path).

### Protocol choice (pros)

| Pro | Why it matters |
|---|---|
| Real **Signal X3DH + Double Ratchet** | Industry-standard session setup and per-message keys; not a homemade “shared AES password”. |
| **Forward secrecy** for ratcheted messages | Compromising today’s keys does not decrypt past messages whose message keys were already deleted. |
| **Post-compromise healing** (within Signal model) | After a DH ratchet step with new ephemeral entropy, future chains can recover from prior chain-key compromise. |
| Private keys stay client-side | Server breach does not dump message plaintext. |
| Password + recovery phrase wraps | Keys usable across password change / new-device restore without storing raw privkeys on the server. |
| Atomic OTPK consume | Backend `FOR UPDATE` pop prevents one-time pre-key reuse. |
| Atomic identity regen | Network upload first; local persist only on success; rollback on failure. |
| Pairwise group encryption | Each member gets a distinct ciphertext; server cannot decrypt group bodies. |
| Identity pinning | Silent identity change is rejected after first trust. |
| Own-message local cache | Avoids broken self-sessions; sender can still render their own plaintext. |

### Protocol choice (cons / costs)

| Con | Impact |
|---|---|
| Groups = **O(n)** encrypts per send | No Sender Keys / MLS; large groups are expensive. |
| Single logical device (`deviceId = 1` in Signal address) | No linked multi-device sessions. |
| Safety numbers exist in code but are **not shown in UI** | Users cannot easily verify peers out-of-band. |
| OTPK replenish helper often unused from UI | Pool can drain → sessions fall back to signed-pre-key-only X3DH. |
| Store key derived from base64 **substring** of identity private key | Works, but KDF input hygiene is weaker than hashing full key material. |
| Custom BIP39-style wordlist + `index % length` | Not identical to standard bip39 npm package behavior. |
| No attachment encryption | Files (if added later) would need a separate design. |

---

## 2. Algorithm inventory

| Layer | Algorithm | Parameters | Used for |
|---|---|---|---|
| Identity / DH | **Curve25519 (X25519)** | 32-byte keys | Identity, signed pre-key, one-time pre-keys, ratchet DH |
| Session setup | **X3DH** | IK + SPK (+ optional OTPK) | First message to a peer |
| Message crypto | **Double Ratchet** (WhisperMessage / PreKeyWhisperMessage) | Library-internal AES + MAC + HKDF | Per-message encrypt/decrypt |
| Password wrap | **PBKDF2-SHA256 → AES-256-GCM** | **600,000** iterations; 16-byte salt; 12-byte IV | Identity private key at rest (IndexedDB) |
| Recovery wrap | **PBKDF2-SHA256 → AES-256-GCM** | **600,000** iterations; 16-byte salt; 12-byte IV | Recovery blob on server |
| Session/pre-key at rest | **PBKDF2-SHA256 → AES-256-GCM** | **100,000** iterations; salt `chatapp-ratchet-store-{userId}` | Encrypted session + pre-key records in IndexedDB |
| Own-message cache | **AES-256-GCM** | Key wrapped with store key; salt `chatapp-own-message-cache-{userId}` | Sender plaintext cache |
| Recovery mnemonic | **BIP39-style** 12 words | 128-bit entropy + 4-bit SHA-256 checksum | Human backup of identity |
| Safety number (unused UI) | **SHA-256** of concatenated public keys | Displayed as 6×5 digit groups | Intended OOB verification |
| Transport / API auth | TLS + **JWT** | Cookie (+ localStorage mirror) | Authenticates user to server — **not** peer message authenticity |

**Not used:** RSA, MLS, OMEMO Sender Keys, libsodium/tweetnacl as app dependencies. HKDF is used **inside** the Signal library for ratchet chain derivation; app code does not call HKDF directly.

**Message types (Signal)**

| `type` | Name | When |
|---|---|---||
| `3` | PreKeyWhisperMessage | First message(s) establishing / using X3DH material |
| `1` | WhisperMessage | Subsequent Double Ratchet messages |

---

## 3. Key inventory

Every cryptographic secret or public credential the app handles:

| Key / material | Type | Lifetime | Where private lives | Where public lives |
|---|---|---|---|---|
| **Identity keypair** | Curve25519 | Long-term until regen | Password-wrapped IndexedDB `privateKeys`; unlocked copy in memory | Local record + server pre-key bundle |
| **Signed pre-key (SPK)** | Curve25519 + IK signature | Rotated on ~**7-day** metadata schedule | AES-wrapped IndexedDB `ratchetSignedPreKey` | Server bundle |
| **One-time pre-keys (OTPK)** | Curve25519 | Single use; batch of **100** | AES-wrapped IndexedDB `ratchetPreKeys` | Server list; popped on consume |
| **Registration ID** | Integer | Per user on device | IndexedDB `ratchetRegistrationId` | Embedded in Signal messages |
| **Session / root / chain / message keys** | Double Ratchet state | Per peer; advanced per message | Memory + AES-wrapped `ratchetSessions` | Never on server |
| **Ephemeral ratchet DH keys** | Inside session blob | Per DH ratchet step | Inside session records | In message headers (library) |
| **Store encryption key** | AES-256-GCM CryptoKey | Session of signed-in app | **Memory only** (derived on init) | N/A |
| **Local cache key** | AES-256-GCM | Per user/device | Wrapped in IndexedDB `localCacheKeys` | N/A |
| **Password-derived wrap key** | Transient AES key | During encrypt/decrypt of identity | Never stored | N/A |
| **Mnemonic-derived wrap key** | Transient AES key | During recovery blob ops | Never stored | N/A |
| **Device ID** | 16 random bytes hex | Persistent browser id | `localStorage` `chatapp_device_id` | In ratchet header JSON |
| **Pinned peer identity** | Peer Curve25519 public | Until user accepts change | IndexedDB `identities` (public only) | N/A |

**Not present:** group sender keys, MLS epoch secrets, shared group root keys, RSA keys.

---

## 4. Storage map

| Location | Contents |
|---|---|
| **IndexedDB `chatapp-keystore` (v6)** | `privateKeys`, `ratchetSessions`, `identities`, `ratchetPreKeys`, `ratchetSignedPreKey`, `ratchetRegistrationId`, `sentMessages`, `localCacheKeys` |
| **localStorage** | `chatapp_device_id`, `chatapp_signed_prekey_meta`, `chatapp_recovery_phrase_shown`, JWT token mirror |
| **Process memory** | Identity private key cache, CryptoKeys, `InMemorySignalStore`, decrypt cache, in-flight session/decrypt maps |
| **Server PostgreSQL** | `pre_key_bundle` (public), `RecoveryBlob` (ciphertext only), `Message` (`content`, `iv`, `ratchetHeader`, `encryptionFormat`, `isEncrypted`) — **no plaintext** |

On **logout**: in-memory keys/sessions are cleared; **encrypted** IndexedDB identity record is kept so the same browser can sign in again without recovery.

---

## 5. End-to-end lifecycle (high level)

```
Signup / OTP verified
  → generate Curve25519 identity
  → PBKDF2+AES-GCM wrap private key → IndexedDB
  → init SessionRatchetService
  → generate SPK + 100 OTPKs → encrypt locally + upload public bundle
  → generate 12-word phrase → encrypt recovery blob → upload to server
  → show phrase once (local flag)

Sign-in
  → load IndexedDB record → decrypt with password
  → init ratchet + load sessions / prekeys / pinned identities
  → if decrypt fails or no record → "new device" path

Send message
  → cache plaintext locally (AES-GCM)
  → for each other member: lazy X3DH if needed → Double Ratchet encrypt
  → store per-recipient header map on server (content often null)
  → WebSocket fan-out with perRecipientContent

Receive / history
  → own: local cache
  → peer: select this user’s header from map → decrypt type 3 or 1
  → identity mismatch → IdentityChangedError → user accepts new identity

Rotate / recover / regen
  → SPK every 7 days (meta); OTPK refresh API exists
  → recovery phrase restores identity on new device
  → identity regen: new keys + new blob/bundle; peers must re-trust
```

---

## 6. Step-by-step: identity creation (signup)

**Entry:** `KeyManagementService.initializeOnSignup(userId, password)`

1. Generate identity with `KeyHelper.generateIdentityKeyPair()` (Curve25519).
2. Encode public and private keys as base64.
3. Build JSON bundle: `{ curve25519PrivateKey: "<base64>" }`.
4. Wrap with password:
   - Random **16-byte salt**, **12-byte IV**.
   - `PBKDF2` (SHA-256, **600,000** iterations) → AES-256-GCM key.
   - Encrypt bundle → `{ encryptedData, iv, salt }` (all base64).
5. Persist `StoredKeyRecord` in IndexedDB (`userId`, `keyVersion`, ciphertext fields, public key fields). Private key is **not** stored in plaintext in the record.
6. Cache private key in memory for immediate ratchet init.
7. Later in signup UI: initialize `SessionRatchetService`, call `generatePreKeyBundle(100)`, upload bundle, generate mnemonic, upload recovery blob.

**Wrong password later:** AES-GCM auth tag fails → treated as **new device** (`decrypt-failed`), not a soft error.

---

## 7. Step-by-step: password wrap / unwrap

**File:** `CryptoService.ts`

### Encrypt private key

1. `salt ← random(16)`, `iv ← random(12)`.
2. Import password as raw key for PBKDF2.
3. Derive AES-GCM-256 key: iterations = `600000`, hash = `SHA-256`.
4. `encrypt(AES-GCM, iv, UTF-8(privateKeyBundleJson))`.
5. Return base64 `encryptedData`, `iv`, `salt`.

### Decrypt private key

1. Decode salt/iv/ciphertext from base64.
2. Re-derive key with same password + salt + iterations.
3. `decrypt(AES-GCM, …)` — **throws** if password wrong or data tampered.
4. Return UTF-8 JSON (or legacy raw private key string).

**Password change** (`KeyManagementService.changePassword`): decrypt with old password → re-encrypt same private material with new password → overwrite IndexedDB. Does **not** change identity keys or server bundle.

---

## 8. Step-by-step: pre-key bundle generation

**Entry:** `SessionRatchetService.generatePreKeyBundle(count = 100)`

1. Require `initialize()` already called (identity in store).
2. Read signed-pre-key meta from `localStorage` (`chatapp_signed_prekey_meta`).
3. If `nextRotationAt` ≤ now → bump `currentId`, set next rotation = now + **7 days**.
4. `KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId)` → keypair + signature by identity.
5. Store SPK private material in memory store; keep signature.
6. For `i = 1..count`: `KeyHelper.generatePreKey(i)` → store privately; collect `{ id, key: pubBase64 }` for upload.
7. Flush encrypted pre-keys / SPK to IndexedDB (`_flushRatchetKeysToStorage`) so type-3 decrypt works after reload.
8. Return DTO:
   - `identityKey`, `signedPreKey`, `signedPreKeySignature`, `signedPreKeyId`
   - `oneTimePreKeys` = JSON string of public OTPKs
9. Upload via `PUT /api/users/pre-key-bundle`.

**Why OTPKs matter:** each consumed OTPK adds entropy and prevents some replay/reuse classes in X3DH. When the pool is empty, X3DH can still proceed with identity + signed pre-key only (weaker than full X3DH with OTPK).

---

## 9. Step-by-step: ratchet service initialization

**Entry:** `SessionRatchetService.initialize(userId, privKeyB64, pubKeyB64, deviceId)`

1. Import Curve25519 identity into `InMemorySignalStore`.
2. Derive **store encryption key**:
   - PBKDF2 input = first **32 characters** of base64 private key (as UTF-8 bytes).
   - Salt = `chatapp-ratchet-store-{userId}`.
   - Iterations = **100,000**, hash SHA-256 → AES-GCM-256.
3. Load and decrypt persisted sessions, pre-keys, signed pre-key, registration id, pinned identities.
4. Ensure / unwrap **local cache key** for own-message plaintext (separate salt namespace `chatapp-own-message-cache-{userId}`).
5. Mark service loaded; subsequent encrypt/decrypt use this store.

Signal addresses are `SignalProtocolAddress(userId, 1)` — device index is fixed at **1** for protocol addressing (browser `deviceId` hex is still written into app-level ratchet header JSON for metadata).

---

## 10. Step-by-step: X3DH session initiation (lazy)

**Triggers:** first `ratchetEncrypt` to a peer with no session (`_lazyInitSession`).

1. `GET /api/users/{id}/pre-key-bundle` → public IK, SPK, signature, OTPK list.
2. `POST /api/users/pre-key-bundle/consume` → backend **atomically** pops one OTPK under row lock (`FOR UPDATE`), persists remaining list, returns consumed key (or empty if none).
3. Build libsignal pre-key bundle object (identity, signed pre-key, optional OTPK).
4. `SessionBuilder.processPreKey(address, bundle)` runs X3DH:
   - DH combinations involving IK / SPK / OTPK / ephemeral.
   - Derives initial root / chain keys (library HKDF).
5. Pin or check remote identity via `isTrustedIdentity`:
   - Unknown → accept (TOFU) and save pin.
   - Known and different → **reject** / `IdentityChangedError` path.
6. Flush new session + keys to IndexedDB.
7. Concurrent inits for the same peer are deduped via `inFlightSessionInits`.

**Self-session:** explicitly forbidden — encrypting to `theirUserId === currentUserId` throws; own plaintext uses the local cache instead.

---

## 11. Step-by-step: encrypt a message (1:1 or group)

**Entry:** `Homepage.onSendMessage` → `SessionRatchetService.ratchetEncrypt` per recipient.

### 11.1 UI / fan-out

1. Read plaintext from composer; require chat id, token, auth user.
2. Allocate temp message id `temp-…`.
3. `cacheOwnSentMessage(tempId, plaintext)` — AES-GCM encrypt plaintext into IndexedDB `sentMessages`.
4. Build recipient list = all chat members **except** self.
5. `Promise.all` → for each recipient, `ratchetEncrypt(plaintext, recipientId, token)`.
6. Build:
   - `ratchetHeaders[recipientId] = headerJson`
   - `perRecipientContent[recipientId] = { content, iv, ratchetHeader }`
7. Persist message via Redux `createMessage`:
   - `content: null` (server does not store a single shared body)
   - `ratchetHeader: JSON.stringify(ratchetHeaders)` — **map of userId → header**
   - `encryptionFormat: 'ratchet'`
8. On success, rekey own-message cache from temp id → server UUID.
9. WebSocket `/app/messages` includes `perRecipientContent` so the server can merge **each member’s** ciphertext into their live delivery payload.

### 11.2 Per-recipient `ratchetEncrypt`

1. Reject self.
2. If no session → `_lazyInitSession` (section 10).
3. `SessionCipher.encrypt(UTF-8 plaintext)`:
   - Advances symmetric ratchet (message key used once).
   - May advance DH ratchet when appropriate.
   - Returns `{ type, body, registrationId }` where `body` is a **raw binary string** (may contain `0x00`).
4. Base64-encode binary body (PostgreSQL / JSON cannot safely store NULs).
5. Build header JSON:
   ```json
   {
     "type": 3 | 1,
     "body": "<base64 ciphertext>",
     "registrationId": <number>,
     "deviceId": "<browser device id hex>"
   }
   ```
6. Generate a random 12-byte `iv` field for the API payload (Signal’s AEAD/MAC is inside the library blob; this IV is largely unused for Signal decrypt).
7. Flush session + ratchet keys to IndexedDB.
8. Return `{ ciphertext, iv, ratchetHeader }`.

### 11.3 Group model

- **Not** a shared group key. Each send encrypts **N−1** independent Double Ratchet sessions.
- History decrypt uses the **current user’s** entry in the header map (critical when DB `content` is null).
- Membership add/remove is chat CRUD only — **no** cryptographic rekey of a group epoch:
  - New members do not receive old history by design of pairwise fan-out.
  - Removed members keep any plaintext already decrypted locally.

---

## 12. Step-by-step: decrypt a message

**Entry:** `MessageCard` / `SessionRatchetService.ratchetDecrypt(header, content, senderId, messageId?)`

1. If sender is self → `getCachedOwnMessage(messageId)` only; never self-ratchet.
2. If `messageId` already decrypted → return cache; concurrent decrypts share `inFlightDecryptions`.
3. Parse `ratchetHeader`:
   - May be a **per-recipient map** `{ [userId]: headerJson | headerObject }`.
   - `_selectRatchetHeader` / `_resolveCiphertextForCurrentUser` pick **this user’s** body (history refetch path).
4. Decode base64 body → ArrayBuffer.
5. `SessionCipher`:
   - `type === 3` → `decryptPreKeyWhisperMessage` (may create session / consume OTPK privately).
   - else → `decryptWhisperMessage`.
6. On success: UTF-8 plaintext; flush session; cache by `messageId`.
7. On failure:
   - Identity mismatch / pin conflict → `IdentityChangedError` → UI “Trust new security code” → `acceptNewIdentityAndReset` (drop session, clear pin, re-init on next encrypt).
   - Other session errors may drop the broken session so a fresh X3DH can occur later.

**Integrity:** Signal message MAC/AEAD binds ciphertext to ratchet headers inside the library. App-layer AES-GCM wraps use GCM tags (tamper → decrypt fail). App does not set explicit AAD on Web Crypto wraps.

---

## 13. Forward secrecy

### Definition (as used here)

If an attacker obtains **current** session/chain keys at time *T*, they still **cannot** decrypt messages whose **message keys** were already used and discarded before *T*.

### How this app achieves it

1. Double Ratchet derives a **unique message key** per encrypt/decrypt.
2. Message keys are **not reused**; the library advances the chain and deletes used keys as part of the ratchet.
3. DH ratchet steps introduce new ephemeral Curve25519 keys, updating the root key so past chain keys are not recoverable from the new root alone.

### Limits

| Compromise | Past messages | Future messages |
|---|---|---|
| Single message key | Only that message | Unaffected if chain continues normally |
| Current chain key (no further DH) | Past message keys already deleted stay safe | Near-future messages on that chain at risk until DH ratchet |
| Identity private key | Past ratcheted messages still need old session state | Attacker can impersonate / open new PreKey sessions until identity regen |
| Full device (memory + unlocked IndexedDB) | Anything still on disk/memory | Everything until wipe / regen |
| Server DB only | Ciphertext only — no plaintext | Can still MITM **new** sessions via bundle swap until pin detects change |

**Logged-out device:** identity remains password-wrapped; sessions remain AES-wrapped under store key derived from identity private material — strong against server theft, weak against password guessing + stolen IndexedDB.

---

## 14. Backward secrecy / post-compromise security (PCS)

### Terminology

- **Backward secrecy** (sometimes confused): often means “compromise now does not reveal past” → that is **forward secrecy** above.
- **Post-compromise security / healing:** after a compromise at *T*, the protocol can **recover** so messages after a healing event are safe again.

### How Signal PCS works here

1. When parties exchange messages that trigger a **DH ratchet**, new ephemeral DH secrets mix into the root key.
2. Even if an attacker stole an old chain key, they cannot compute the new root without the new DH private key.
3. Healing requires **ongoing two-way traffic**. A silent compromised device that only receives may heal more slowly than an active conversation.

### What does **not** heal automatically

- Stolen **identity private key** → attacker can keep initiating as you until you regenerate identity and peers accept the new pin.
- Stolen **recovery phrase** → full identity restore forever until phrase rotated (regen + new blob).
- **Password** alone does not decrypt peer messages; it only unwraps local identity. But password + stolen IndexedDB = full local compromise.

---

## 15. Key rotation

| Material | Rotation mechanism | Interval / trigger | Notes |
|---|---|---|---|
| Message / chain keys | Double Ratchet | Every message | Automatic; primary FS mechanism |
| Signed pre-key | `_getOrCreateSignedPreKeyMeta` / `_rotateSignedPreKeyMeta` | **7 days** (localStorage meta) | New SPK generated on next `generatePreKeyBundle` after expiry |
| One-time pre-keys | `generatePreKeyBundle` / `refreshPreKeysIfNeeded` | When pool low / on signup | Refresh helper may not be called from UI — **monitor drain** |
| Store / cache AES keys | Re-derived on init | Sign-in | Not rotated independently of identity |
| Identity key | Explicit regen / new-device | User action or decrypt failure | Breaks old sessions; peers see identity change |
| Recovery blob | Re-upload on regen | With new mnemonic | Old phrase stops working for new blob |
| Password wrap | `changePassword` | User changes password | Same identity, new wrap only |

**Implementation caveat:** signed pre-key persistence has historically forced `id: 1` in some flush paths, which can disagree with rotated meta IDs after reload. Treat SPK rotation as **intended** weekly behavior and verify flush IDs if auditing rotation correctness.

---

## 16. Recovery phrase flow

### Generate (signup)

1. `RecoveryService.generateMnemonic()`:
   - 16 random bytes (128-bit entropy).
   - SHA-256 checksum → first 4 bits.
   - 132 bits → twelve 11-bit indices → words from embedded list (`wordIndex % listLength`).
2. Show UI once; set `chatapp_recovery_phrase_shown`.
3. `encryptPrivateKeyWithMnemonic(priv, pub, mnemonic)`:
   - JSON `{ curve25519PrivateKey, curve25519PublicKey }` (public included so new device can rebuild identity).
   - PBKDF2 600k + AES-GCM → upload `PUT /api/recovery/blob`.

### Recover (`recoverAccess`)

1. Fetch blob from server.
2. Decrypt with mnemonic → parse JSON (or legacy raw privkey → re-derive public via Curve).
3. Re-wrap private key with **new password** via `CryptoService`.
4. Save IndexedDB record **including public key**.
5. `loadOnSignIn` → ratchet initialize.

**Pros:** offline-capable human backup; server never sees phrase.  
**Cons:** phrase = full account crypto takeover; custom wordlist modulo is not stock BIP39; user must store phrase safely.

---

## 17. New device and identity regeneration

### Paths that trigger “new device”

| Reason | Meaning |
|---|---|
| `no-local-key` | No IndexedDB record for this user on this browser |
| `decrypt-failed` | Wrong password **or** corrupted/tampered wrap (GCM fail) |

### Regen without losing atomicity

`regenerateKeysWithoutPersist`:

1. Generate new Curve25519 identity; bump `keyVersion`.
2. Wrap with password; return record **without** saving yet.
3. Caller uploads **new** recovery blob + **new** pre-key bundle first.
4. Only then persist local record; on network failure keep old local keys.

Effects for peers:

- Their pinned identity no longer matches → decrypt fails with `IdentityChangedError`.
- They must explicitly accept the new identity; old ratchet sessions are cleared on the regenerating device.

**Backward secrecy of history:** regenerating does **not** magically re-encrypt old server ciphertext for the new identity. Old messages remain decryptable only where old session state / caches still exist. Cross-device without phrase = no old history.

---

## 18. Identity trust model (TOFU → pin)

1. First time a peer identity is seen → **trust on first use**, store pin in IndexedDB `identities`.
2. Later sessions must present the **same** public identity key (`isTrustedIdentity`).
3. Change without user consent → reject.
4. UI path: accept new identity → clear pin + session → next message re-runs X3DH with new IK.
5. `getSafetyNumber(myPub, theirPub)` computes a comparable fingerprint (**implemented**, **not wired into main UI**).

**Server MITM window:** between account creation and first successful pin, a malicious server can serve a fake bundle. After pin, silent swap is detectable. Without safety-number UI, users still lack strong OOB confirmation.

---

## 19. Edge cases (exhaustive)

| Scenario | Behavior |
|---|---|
| Out-of-order messages | Signal skipped-message key buffer; `MAX_SKIP = 100` is declared — confirm it is passed into the library if auditing skip limits |
| Offline recipient | Ciphertext + header map stored; OTPK consumed at **sender** session init time; recipient decrypts when online |
| Empty OTPK pool | X3DH with IK+SPK only; still works if SPK valid |
| Concurrent session init | Deduped with `inFlightSessionInits` |
| Concurrent decrypt | Shared promise + plaintext cache by `messageId` |
| History refetch | `content` often null; body taken from per-recipient header map entry for current user |
| NUL bytes in Signal body | Client base64-encodes; server may strip `\u0000` defensively |
| Group member added | Encrypts for them on future sends only; no old history |
| Group member removed | Stops receiving new ciphertexts; keeps old local plaintext |
| Sender viewing own bubble | Local AES-GCM cache only |
| Cache miss for own message | Error / empty — cannot decrypt own ratchet output |
| Clear browser storage | Local identity/sessions/cache gone → new-device or recovery required |
| Logout | Memory wiped; encrypted IndexedDB retained |
| Password change | Re-wrap only; sessions continue |
| Identity regen mid-chat | Peers must accept new identity; old sessions invalid |
| Multi-tab | Same IndexedDB; race on session flush possible (not a formal multi-device protocol) |
| Multi-device account | **Not supported** — separate browsers = separate identities unless recovery restores **same** identity from phrase |
| Attachments | **None** encrypted |
| JWT XSS | Token mirror in localStorage increases session theft risk (auth, not E2EE break by itself) |

---

## 20. Authentication vs encryption (do not confuse)

| Mechanism | Proves |
|---|---|
| JWT / cookie | Browser is logged in as user *U* to **this server** |
| Signal MAC / ratchet | Ciphertext was produced by someone with the **current session keys** for that peer relationship |
| Signed pre-key signature | SPK was signed by the claimed identity key at publish time |
| Identity pin | Peer IK matches what this device previously trusted |
| Password / mnemonic | Holder can unwrap **this account’s** identity on a client |

The server can always drop, reorder, or withhold ciphertext. It cannot **honestly** decrypt ratcheted bodies without client keys. It **can** attempt active attacks on **unpinned** or **newly regenerated** identities.

---

## 21. Wire format cheat sheet

### Stored message (conceptual)

```json
{
  "content": null,
  "iv": "<base64 12-byte iv>",
  "ratchetHeader": "{ \"<recipientUserId>\": \"{...header...}\", ... }",
  "encryptionFormat": "ratchet",
  "isEncrypted": true
}
```

### Per-recipient header object

```json
{
  "type": 1,
  "body": "<base64 Signal ciphertext>",
  "registrationId": 12345,
  "deviceId": "a1b2c3..."
}
```

### Live WebSocket enrichment

Server merges `perRecipientContent[viewerId]` into the payload for that connected user so live delivery matches what history decrypt expects.

---

## 22. Security properties summary

| Property | Status | Mechanism |
|---|---|---|
| Confidentiality (E2EE) | **Yes** | Signal Double Ratchet; server stores ciphertext |
| Integrity of ciphertext | **Yes** | Library MAC/AEAD; GCM on wraps |
| Forward secrecy | **Yes** (ratcheted msgs) | Per-message keys discarded |
| Post-compromise healing | **Partial / yes in Signal model** | DH ratchet after compromise |
| Deniability | **Inherited from Signal design** | Not a product guarantee called out in UI |
| Peer authentication | **Partial** | TOFU + pin; no mandatory safety numbers |
| Group confidentiality | **Yes** vs server | Pairwise fan-out |
| Group forward secrecy on membership change | **Weak / N/A** | No epoch rekey; rely on stopping encrypts to removed members |
| Multi-device continuity | **No** | Single-device sessions + local own-cache |
| At-rest identity protection | **Yes** (password) | PBKDF2 600k + AES-GCM |
| Recovery portability | **Yes** (phrase) | Server blob ciphertext |

---

## 23. Operational checklist for developers

When changing crypto code:

1. Never log plaintext, passwords, mnemonics, raw private keys, or chain keys — use `Logger` hashes/lengths.
2. Keep **base64** on any Signal body that touches PostgreSQL/JSON.
3. Prefer **network-then-persist** for identity regen and recovery uploads.
4. Preserve **per-recipient header maps** for groups and history.
5. Do not invent a self-session; keep own-message cache.
6. On identity change, clear session + pin deliberately; never silently overwrite pins.
7. If adding attachments: separate content keys, ratchet or pairwise wrap, and never upload plaintext blobs.
8. If adding multi-device: real device IDs in `SignalProtocolAddress`, Sender Keys or per-device fan-out, and sync of own-message cache.

---

## 24. Known gaps / TODOs (crypto-related)

1. `MAX_SKIP` documented/declared but may not be wired into `SessionCipher` configuration.
2. `getSafetyNumber` not exposed in primary UI.
3. `refreshPreKeysIfNeeded` may never run from production UI paths.
4. Signed pre-key ID persistence vs 7-day rotation meta can disagree after reload.
5. No multi-device linking / session sync.
6. No attachment encryption.
7. No Sender Keys / MLS for scalable groups.
8. Store-key KDF uses base64 substring of private key (improve to hash full key material).
9. BIP39 subset + modulo indexing — migrate to full standard wordlist package for interoperability.
10. JWT mirrored in localStorage — prefer cookie-only session for XSS resilience.

---

## 25. Quick “mental model”

Think of three layers:

1. **Identity layer** — Curve25519 long-term key, password-wrapped locally, recovery-blob-backed, TOFU-pinned between peers.
2. **Session layer** — X3DH once, then Double Ratchet forever (until identity regen or session drop).
3. **Transport layer** — TLS + JWT moves ciphertext and public pre-keys; never entrusted with plaintext.

Forward secrecy lives in layer 2 (message keys die). Healing lives in layer 2 (DH ratchet). Catastrophic identity compromise is layer 1 (regen + peer re-trust). Everything else is operational edge-case handling around storage, groups, and caches.
