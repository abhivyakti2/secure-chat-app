# Deployment Guide — Chat Application

This guide provides the **minimal setup required to deploy the project fully for free** using free-tier cloud services. All environment variables are documented with exact instructions on where to obtain them.

---

## 📦 Architecture Overview

```
Browser ──→ Frontend (React, port 3000)
                │
                │ HTTP/WebSocket
                ▼
          Backend (Spring Boot, port 8080)
                │
                ├── PostgreSQL Database
                ├── Gmail SMTP (OTP emails)
                └── Google reCAPTCHA (bot prevention)
```

---

## 🔐 Environment Variables Reference

### Backend Variables (application.properties)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_URL` | **Yes** | — | PostgreSQL JDBC connection URL |
| `DB_USERNAME` | **Yes** | `""` (empty) | PostgreSQL database user |
| `DB_PASSWORD` | **Yes** | `""` (empty) | PostgreSQL database password |
| `RECAPTCHA_SECRET` | No | `""` (empty) | Google reCAPTCHA v2 secret key *(see note below)* |
| `MAIL_USERNAME` | No | `""` (empty) | Gmail address for sending OTP emails |
| `MAIL_PASSWORD` | No | `""` (empty) | Gmail app password for SMTP |
| `JWT_SECRET_KEY` | No | Insecure hardcoded default | HMAC-SHA256 key for signing JWT tokens |

**Note on reCAPTCHA:** If `RECAPTCHA_SECRET` is empty, captcha verification will fail and signup will be blocked. For a quick free deployment, you can set `RECAPTCHA_SECRET` to a placeholder like `"6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe"` (Google's **test key** that always passes verification). **Do not use the test key in production** — get your own from the reCAPTCHA admin console.

### Frontend Variables (Config.ts)

| Variable | Required | Current Value | Description |
|----------|----------|---------------|-------------|
| `BASE_API_URL` | **Yes** | `http://localhost:8080` | Backend API base URL (change for production) |

The frontend currently has `BASE_API_URL` hardcoded in `frontend/src/config/Config.ts`. For deployment, you should either:
- **Build with env vars**: Replace with an environment-aware build process (e.g., `REACT_APP_API_URL`)
- **Edit directly**: Change the value before building

---

## 🚀 Option 1: Free Deployment (Recommended)

Use **Render** (free tier) for the backend and **Vercel** (free tier) for the frontend.

### Prerequisites

1. A [GitHub](https://github.com) account
2. A [Render](https://render.com) account (free tier includes PostgreSQL)
3. A [Vercel](https://vercel.com) account (free tier)
4. A [Google](https://cloud.google.com) account for reCAPTCHA + Gmail
5. Push the project to a **public GitHub repository**

---

### Step 1: Set Up Google reCAPTCHA v2

1. Go to [https://www.google.com/recaptcha/admin](https://www.google.com/recaptcha/admin)
2. Register a new site:
   - **Label**: `Chat App`
   - **reCAPTCHA type**: "I'm not a robot" Checkbox (v2)
   - **Domains**: Add your Render backend domain (e.g., `your-app.onrender.com`) **and** your Vercel frontend domain (e.g., `your-app.vercel.app`)
   - **Accept Terms** → **Submit**
3. You will receive two keys:
   - **Site Key** (public) — used in the frontend signup form (already included in the code)
   - **Secret Key** (private) — set as `RECAPTCHA_SECRET` environment variable

> The project already uses Google's test site key in the frontend (`6Lc1bJwqAAAAAIJ...`). For production, **replace it** with your actual reCAPTCHA site key in `frontend/src/components/register/SignUp.tsx` (search for the reCAPTCHA `sitekey` prop).

---

### Step 2: Set Up Gmail SMTP for OTP Emails

1. Go to your [Google Account Security](https://myaccount.google.com/security)
2. Enable **2-Step Verification** (required for app passwords)
3. Go to [App Passwords](https://myaccount.google.com/apppasswords)
4. Select **Mail** and **Windows Computer** (or choose your device)
5. Click **Generate** — you will receive a **16-character app password**
6. Set this as `MAIL_PASSWORD`

> Use your Gmail address as `MAIL_USERNAME` (e.g., `yourname@gmail.com`).

---

### Step 3: Deploy Backend + PostgreSQL on Render

#### 3a: Create PostgreSQL Database

1. Log in to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **PostgreSQL**
3. Configure:
   - **Name**: `chatapp-db`
   - **Database**: `chatapp`
   - **User**: `chatapp_user`
   - **Region**: Choose the closest to you
   - **Plan**: **Free** ($0/month — expires after 90 days, data persists)
4. Click **Create Database**
5. After creation, note the **Internal Database URL** and **External Database URL** (you'll need these)

#### 3b: Deploy Backend as Web Service

1. In Render Dashboard, click **New +** → **Web Service**
2. Connect your GitHub repository
3. Configure:
   - **Name**: `chatapp-backend`
   - **Region**: Same as your database
   - **Branch**: `main`
   - **Runtime**: `Java`
   - **Build Command**: `cd backend && ./mvnw clean package -DskipTests`
   - **Start Command**: `cd backend && java -jar target/chatapp-0.0.1-SNAPSHOT.jar`
   - **Plan**: **Free** ($0/month)
4. Click **Advanced** and add the following **Environment Variables**:

| Key | Value |
|-----|-------|
| `DB_URL` | `jdbc:postgresql://<INTERNAL_DB_HOST>:5432/chatapp` (from Step 3a) |
| `DB_USERNAME` | `chatapp_user` (from Step 3a) |
| `DB_PASSWORD` | Your PostgreSQL password (from Step 3a) |
| `RECAPTCHA_SECRET` | Your reCAPTCHA secret key (from Step 1) |
| `MAIL_USERNAME` | `yourname@gmail.com` |
| `MAIL_PASSWORD` | Your 16-character Gmail app password (from Step 2) |
| `JWT_SECRET_KEY` | A **random 256-bit key** (see below) |

5. Click **Create Web Service**

> **Generating a JWT_SECRET_KEY:**
> Run this command in your terminal to generate a secure random key:
> ```
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> Or use any online secure random generator to create a 64-character hex string.

6. After deployment completes, note your backend URL: `https://chatapp-backend.onrender.com`

---

### Step 4: Update CORS and Deploy Frontend on Vercel

#### 4a: Update CORS Configuration

You need to allow your frontend domain in the backend's CORS settings.

**HTTP CORS** — Edit `backend/src/main/java/com/nicolas/chatapp/config/SecurityConfig.java`:

```java
// Change this line:
cfg.setAllowedOrigins(List.of("http://localhost:3000"));
// To include your Vercel domain:
cfg.setAllowedOrigins(List.of("http://localhost:3000", "https://your-app.vercel.app"));
```

Alternatively, for a quick deployment, use a wildcard (not recommended for production):

```java
cfg.setAllowedOriginPatterns(List.of("*"));
```

**WebSocket CORS** — Edit `backend/src/main/java/com/nicolas/chatapp/config/WebSocketConfig.java`:

```java
// Change this line:
registry.addEndpoint("/ws")
        .setAllowedOrigins("http://localhost:3000")
        .withSockJS();
// To include your Vercel domain:
registry.addEndpoint("/ws")
        .setAllowedOrigins("http://localhost:3000", "https://your-app.vercel.app")
        .withSockJS();
```

> **Important:** If you change CORS settings, you must re-deploy the backend on Render (it auto-deploys when you push to GitHub).

#### 4b: Update Frontend API URL

Edit `frontend/src/config/Config.ts`:

```typescript
// Change this:
export const BASE_API_URL = "http://localhost:8080";
// To your Render backend URL:
export const BASE_API_URL = "https://chatapp-backend.onrender.com";
```

#### 4c: Deploy Frontend on Vercel

1. Log in to [Vercel Dashboard](https://vercel.com)
2. Click **Add New...** → **Project**
3. Connect your GitHub repository
4. Configure:
   - **Root Directory**: `frontend`
   - **Framework Preset**: `Create React App`
   - **Build Command**: `npm run build`
   - **Output Directory**: `build`
   - No environment variables needed
5. Click **Deploy**
6. After deployment, note your frontend URL: `https://your-app.vercel.app`

---

### Step 5: Update reCAPTCHA Domain (if needed)

1. Go back to [reCAPTCHA Admin](https://www.google.com/recaptcha/admin)
2. Edit your reCAPTCHA site
3. Add both domains:
   - `https://chatapp-backend.onrender.com`
   - `https://your-app.vercel.app`
4. If you're using the test key, this step is optional (test key works on any domain)

---

### Step 6: Verify Deployment

1. Open your Vercel URL: `https://your-app.vercel.app`
2. You should see the welcome page
3. Click **Sign Up** and complete the registration flow:
   - Fill in details → Solve reCAPTCHA → Submit
   - Check Gmail for OTP code
   - Verify OTP → Save recovery phrase
4. You should land on the homepage

---

## 🛠 Option 2: Local Development (Quick Start)

For running locally with minimal setup:

### Prerequisites

- Java 17+ ([Download](https://adoptium.net/))
- Node.js 18+ ([Download](https://nodejs.org/))
- PostgreSQL 14+ ([Download](https://www.postgresql.org/download/))

### Setup

#### 1. Create the `.env` file

Create `backend/.env` with the following content:

```properties
DB_URL=jdbc:postgresql://localhost:5432/chatapp
DB_USERNAME=postgres
DB_PASSWORD=postgres
RECAPTCHA_SECRET=6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe
MAIL_USERNAME=
MAIL_PASSWORD=
JWT_SECRET_KEY=local-dev-change-in-production-this-must-be-256-bit-long-hex
```

> The reCAPTCHA secret above is Google's official **test key** — it always passes verification.

#### 2. Create PostgreSQL Database

```bash
# Connect to PostgreSQL
psql -U postgres

# Create the database
CREATE DATABASE chatapp;

# Exit
\q
```

#### 3. Start the Backend

```bash
cd backend
./mvnw spring-boot:run
```

The backend starts on `http://localhost:8080`.

#### 4. Start the Frontend

```bash
cd frontend
npm install
npm start
```

The frontend starts on `http://localhost:3000`.

#### 5. Access the Application

Open `http://localhost:3000` in your browser.

---

## 📋 Complete Environment Variables Summary Table

### Backend (set on Render or in `backend/.env`)

| Variable | Where to Get It | Free? |
|----------|----------------|-------|
| `DB_URL` | Render PostgreSQL dashboard → Internal Database URL | ✅ Yes (Render free tier) |
| `DB_USERNAME` | Render PostgreSQL dashboard | ✅ Yes |
| `DB_PASSWORD` | Render PostgreSQL dashboard (shown once at creation) | ✅ Yes |
| `RECAPTCHA_SECRET` | [Google reCAPTCHA Admin](https://www.google.com/recaptcha/admin) → Secret Key | ✅ Yes (free) |
| `MAIL_USERNAME` | Your Gmail address | ✅ Yes (free Gmail) |
| `MAIL_PASSWORD` | [Google App Passwords](https://myaccount.google.com/apppasswords) | ✅ Yes (free) |
| `JWT_SECRET_KEY` | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | ✅ Free |

### Frontend (edit in `frontend/src/config/Config.ts` or Vercel env vars)

| Variable | Where to Get It | Free? |
|----------|----------------|-------|
| `BASE_API_URL` | Your Render backend URL, e.g. `https://chatapp-backend.onrender.com` | ✅ Yes |

### reCAPTCHA Site Key (in SignUp.tsx component)

| Value | Where to Get It | Free? |
|-------|----------------|-------|
| `6Lc1bJwqAAAAAIJ...` (replace with yours) | [Google reCAPTCHA Admin](https://www.google.com/recaptcha/admin) → Site Key | ✅ Yes (free) |

---

## 📝 Post-Deployment Checklist

- [ ] Backend health check: Visit `https://chatapp-backend.onrender.com/` — should work (no auth needed)
- [ ] Signup flow: Can create a new account and receive OTP email
- [ ] Recovery phrase: Dialog appears with 12 words after signup
- [ ] Sign-in: Can log in with the new account
- [ ] Messaging: Can send and receive messages
- [ ] End-to-end encryption: Messages show as encrypted in network tab
- [ ] WebSocket connects: No 404 or connection errors in console

---

## 🛡 Steps to Make Everything Deployment Ready

> **Important:** The chat app uses **end-to-end encryption (X3DH + Double Ratchet)**. Before you go live, you MUST address the security blockers described below. The current implementation is **NOT ready for production** until these are fixed. These steps are ordered by priority.

### Step A — Fix the Recovery Flow (HIGH — blocks deployment)

**Problem:** `RecoveryService.recoverAccess()` saves a key record **without `curve25519PublicKey`**. In `KeyManagementService.loadOnSignIn()`, the ratchet is initialized only when **both** the private and public keys are present. After recovery, the private key is restored but the public key is missing → `SessionRatchetService` is never initialized → **old messages cannot be decrypted**.

**Fix (in `frontend/src/services/RecoveryService.ts`):**
1. Re-derive the Curve25519 public key from the restored private key, OR
2. Store the public key in the recovery blob alongside the private key, and persist it to the IndexedDB record in `recoverAccess()`.

Example fix — re-derive the public key from the private key using the Signal library:
```typescript
// In recoverAccess(), after decrypting the private key:
const KeyHelper = (await import('@privacyresearch/libsignal-protocol-typescript')).KeyHelper;
const idKeyPair = await KeyHelper.importIdentityKeyPair(base64ToArrayBuffer(privateKeyBase64));
// ... export pubKey and save it as curve25519PublicKey in the record
```

**Test:** After a full recovery on a new device, old Double Ratchet messages must decrypt successfully.

### Step B — Replace Trust-On-First-Use (TOFU) with Verified Identity (HIGH)

**Problem:** `InMemorySignalStore.isTrustedIdentity()` returns `true` for every identity. A malicious server or an active network MITM can substitute identity keys silently.

**Fix (in `frontend/src/services/SessionRatchetService.ts`):**
1. Compute a **safety number** (e.g., 60-bit fingerprint from the two users' identity public keys) and display it in the UI.
2. Require users to verify the safety number out-of-band (e.g., scanning a QR code / comparing words).
3. In `isTrustedIdentity()`, compare against the stored safety number and require explicit approval for new identities.

This is a larger feature; at a minimum, **pin the identity key** to the user's account and reject silently changed keys.

### Step C — Use the Full BIP39 Wordlist with a Checksum (MEDIUM-HIGH)

**Problem:** `RecoveryService` uses only the **first 512 BIP39 words** (~108 bits of entropy instead of 128) and has **no checksum**. A typo yields a silent wrong-key failure, and there is no validation of entered words.

**Fix (in `frontend/src/services/RecoveryService.ts`):**
1. Replace the embedded 512-word subset with the full 2048-word BIP39 list (from the `bip39` npm package).
2. Compute the proper checksum word (reflect the SHA-256 checksum bits in the final word).
3. Validate entered words on recovery — reject phrases containing words not in the list.

```bash
# Add the full-wordlist dependency
cd frontend && npm install --save bip39
```

### Step D — Persist the Signed Pre-Key Signature (MEDIUM)

**Problem:** The signed pre-key signature is stored only in memory (`InMemorySignalStore.setSignedPreKeyWithSignature`) and is lost on reload. Signature verification is essential for X3DH authenticity.

**Fix (in `frontend/src/services/SessionRatchetService.ts`):** Persist the signed pre-key private key + signature alongside the session data in IndexedDB (encrypted at rest with the store key), and restore it in `initialize()`.

### Step E — Fix One-Time Pre-Key Reuse After Reload (MEDIUM)

**Problem:** `generatePreKeyBundle(100)` always uses IDs `1..100`. After a page reload, consumed OTPK IDs are re-uploaded, weakening one-time-key guarantees.

**Fix (in `frontend/src/services/SessionRatchetService.ts`):** Track the highest used pre-key ID in the store (or localStorage) and generate only fresh IDs on replenishment.

### Step F — Move the JWT Out of `localStorage` (MEDIUM)

**Problem:** The JWT is stored in `localStorage`, which is readable by any XSS script.

**Fix (in `frontend/src/redux/auth/AuthAction.ts` + backend):**
1. Set the JWT in an `httpOnly`, `Secure`, `SameSite` cookie (server-side).
2. Remove the `localStorage`/`sessionStorage` token storage.
3. Update the WebSocket/STOMP handshake to use the cookie (or a CSRF-safe header).

**Backend note:** In `AuthController.java`, ensure the JWT cookie is set with `HttpOnly=true`, `Secure=true`, and `SameSite=Strict` (or `Lax`).

### Step G — Remove the Temporary Signup Password From Global Scope (MINOR)

**Problem:** `window.__signupPassword` holds the password in memory across the OTP page and is not cleared after use.

**Fix (in `frontend/src/components/register/SignUp.tsx` / `VerifyOtp.tsx`):** Keep the password in component/context state instead of a global, and clear it as soon as the recovery blob is created.

### Step H — Production Configuration Checklist

1. **`JWT_SECRET_KEY`**: Set a strong random 256-bit value (see below). Never use the hardcoded dev default.
2. **reCAPTCHA**: Replace Google's test site key with your real site key in `SignUp.tsx`, and set the real `RECAPTCHA_SECRET`.
3. **HTTPS**: Render and Vercel provide HTTPS automatically. Ensure **no** HTTP traffic is allowed.
4. **CORS**: Restrict `allowedOrigins` to exactly your frontend domain (both HTTP CORS in `SecurityConfig.java` and WebSocket origins in `WebSocketConfig.java`).
5. **Database backups**: Render free-tier DBs are deleted after 90 days of inactivity. Schedule `pg_dump` or enable backups.
6. **Email**: Gmail has a 500/day sending limit. For production scale, use SendGrid (free tier: 100/day) or another provider.
7. **Session persistence**: Because E2EE keys live in the user's browser IndexedDB, back up the recovery blob server-side. Never store plaintext keys server-side.

---

## ⚠️ Production Readiness Notes

1. **JWT_SECRET_KEY**: Must be changed from the default. The default is a hardcoded fallback in `JwtConstants.java` used only for local development.
2. **reCAPTCHA**: Replace the test key with your own site+secret keys.
3. **HTTPS**: Render and Vercel provide HTTPS automatically. For local dev with HTTPS, use `mkcert` or a reverse proxy.
4. **CORS**: Restrict `allowedOrigins` to only your actual frontend domain.
5. **Database Backups**: Render free tier databases are deleted after 90 days of inactivity. Use [Render's backup docs](https://render.com/docs/databases#database-backups) or schedule `pg_dump`.
6. **Email**: Gmail has sending limits (500/day). For production, use a dedicated email service like SendGrid (free tier: 100 emails/day).
7. **JWT Cookie**: The `secure` flag is set to `false`. In production, set it to `true` (line in `AuthController.java`).

---

## 🔍 Troubleshooting

| Problem | Likely Cause | Solution |
|---------|-------------|----------|
| Signup fails with "Captcha verification failed" | `RECAPTCHA_SECRET` is empty or wrong | Set the correct secret key or use Google's test key |
| Can't send messages — "One or more chat members are missing a ratchet pre-key bundle" | Other users haven't completed signup (no pre-key bundle uploaded) | Ensure both users completed E2EE key generation & pre-key bundle upload |
| OTP emails not arriving | SMTP credentials wrong or Gmail blocking | Check `MAIL_USERNAME` and `MAIL_PASSWORD` |
| Frontend shows blank page | CORS or API URL misconfigured | Check browser console for errors |
| WebSocket disconnects | Backend URL mismatch | Ensure `BASE_API_URL` matches the deployed backend |
| 401 Unauthorized on API calls | JWT_SECRET_KEY mismatch or expired token | Re-login or check `JWT_SECRET_KEY` consistency |

