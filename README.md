# Chat Application

Welcome to my Chat Application! This project is a full-fledged realtime messaging application with a user interface 
inspired by WhatsApp. It enables users to exchange messages individually or within groups.

![image Screenshot](./images/homepage.png)

## ⚠️ Security Disclosures

Before using or evaluating this project, please understand these important security characteristics:

### Authentication and Account Protection

The app now has four security features in place:

1. **OTP verification for signup and password reset**
  - Signup creates a pending account record, generates a 6-digit OTP, stores the password only after hashing it, and sends the OTP by email.
  - The OTP expires after 10 minutes.
  - A pending signup is deleted after 5 failed OTP attempts or when it expires.
  - Verifying the signup OTP creates the actual user account and returns a JWT.
  - Password reset follows the same OTP pattern and also clears the account lockout state after a successful reset.

2. **Temporary account blocking after incorrect passwords**
  - The backend counts failed sign-in attempts per account.
  - After 2 wrong passwords, the account is locked for 15 minutes.
  - While locked, sign-in returns HTTP 423 with the remaining minutes.
  - Once the lockout expires, the next sign-in attempt resets the counters before checking the password again.
  - A successful sign-in also resets the failure counter and clears any stale lockout.

3. **reCAPTCHA on account recovery flows**
  - Signup and forgot-password both require a Google reCAPTCHA token from the browser.
  - The backend validates the token server-side using the reCAPTCHA secret.
  - Password-reset requests are also rate-limited per email and per client IP for 1 minute.
  - The UI discards stale captcha tokens if the challenge was solved too long before submit.

4. **Encrypted messages with device-local key material**
  - Each account generates a Curve25519 identity keypair on the client.
  - The private key is stored only in the browser's IndexedDB, encrypted with AES-GCM.
  - The AES key is derived from the login password using PBKDF2-SHA256 with 600,000 iterations and a random salt.
  - Message encryption uses the Signal Protocol Double Ratchet, not RSA.
  - The server stores pre-key bundles and message records, but not the plaintext message body.

### Current Security Status

This project is reasonably protected against passive network attackers and basic account abuse, but it is not a fully hardened secure messenger.

- **Good:** TLS plus JWT cookies, password-based key wrapping, forward secrecy for ratcheted messages, OTP expiry, OTP attempt limits, lockout after repeated failures, and no plaintext logging in the crypto path.
- **Partial:** The app uses Trust-On-First-Use for peer identity. There is no safety-number or out-of-band verification flow, so a malicious or compromised server can still swap keys without the user noticing.
- **Partial:** JWTs are set as httpOnly cookies, but the frontend also mirrors tokens in localStorage for its current flow. That makes the session more exposed to browser-side attacks than a cookie-only design.
- **Partial:** The private key is protected at rest, but once the browser is compromised, the encrypted key bundle, session state, and decrypted plaintext in memory are all at risk.
- **Partial:** The own-message cache is device-local. If the browser storage is cleared, or the same account is opened on a new device, the app cannot decrypt old local history until the recovery or key-rotation flow is used.
- **Not covered:** There is no multi-factor authentication, no device management screen, no independent key verification, and no server-side content moderation of encrypted message bodies.

### Encryption and Key Logic

- On first signup, the client generates a Curve25519 keypair with the Signal library.
- The public key is uploaded as part of the pre-key bundle so other users can start sessions.
- The private key is wrapped with the user's password and saved locally.
- A 12-word recovery phrase is generated from 128 bits of entropy plus a checksum.
- The recovery phrase encrypts a recovery blob that can restore the private key and rebuild the ratchet state on a new device.
- If password-based decryption fails on sign-in, the app treats the device as a new device and can regenerate keys.
- When keys are regenerated, the app uploads the new recovery blob and pre-key bundle first, then only persists the local key record if both network calls succeed.

### Architecture Notes

- **Forward secrecy:** Message keys are consumed through the Double Ratchet and are not reused.
- **Atomic key regeneration:** If a new-device recovery or key refresh fails halfway through, the app rolls back to the previous local key record.
- **Atomic one-time pre-key consumption:** The backend consumes pre-keys in a transaction so they are not reused.
- **No plaintext logging:** The crypto path avoids logging secrets; debug output is limited to hashes, lengths, and state transitions.
- **Own-message cache:** The sender's own plaintext is cached locally by device because the sender cannot decrypt their own ratchet chain in the normal recipient flow.

### Future Scope

- Add out-of-band identity verification so users can confirm keys before trusting them.
- Replace the localStorage token mirror with a cookie-only session flow.
- Add multi-device support with explicit device linking and per-device session sync.
- Add stronger password policy and optional MFA.
- Add a recovery phrase management screen with clearer key-rotation history.
- Add server-side observability for abuse patterns without exposing message contents.

## Features

- **Realtime Messaging:** Experience seamless, real-time messaging with instant message delivery.
- **Individual Messaging:** Send private messages to other users.
- **Group Messaging:** Create and edit groups to communicate with more than one user.
- **Login And Signup:** Signup OTP, password-reset OTP, captcha checks, and temporary lockouts are built into the auth flow.
- **End-to-End Encryption:** Messages are encrypted with the Signal Protocol Double Ratchet using Curve25519 keys and password-wrapped client-side key storage.

## Technologies

- **Frontend:** Typescript with React
- **Backend:** Java with Spring Boot, Spring Security, Spring Websocket and Spring Data JPA
- **Database:** PostgreSQL
- **Authentication:** JSON Web Token (JWT) — stored in httpOnly, SameSite cookie
- **State Management:** Redux, Thunk
- **Component Library:** Material UI
- **Encryption:** Web Crypto API, Signal Protocol (`@privacyresearch/libsignal-protocol-typescript`)

## Getting Started

### Prerequisites

Ensure you have **npm** and **mvn** installed on your machine.

### Installation

1. **Clone the repository:**  
    ```bash  
    git clone https://github.com/nicolasjusten95/chat-app.git
    ```
   
2. **Navigate to the Frontend and install the required dependencies:**  
    ```bash
    cd frontend
    npm install
    ```
   
3. **Navigate to the Backend and install the required dependencies:**  
    ```bash
    cd backend
    mvn clean install
    ```
   
4. **Configure Environment Variables:**  
   Configure the Spring Boot application.properties for database and other configurations.

5. **Run the Application:**
    - Start the frontend:
      ```bash
      npm start
      ```
    - Start the backend:
      ```bash
      mvn spring-boot:run
      ```
6. **Access the Application:**
   - Open your browser and visit [http://localhost:3000](http://localhost:3000) to use the Realtime Chat Application.
   - You can log in with a sample user to access the app with predefined data:
     - email: luke.skywalker@test.com
     - password: luke
   - Or you can create your own Accounts and start chatting!

## Images

View your chats with other users:
![image Screenshot](./images/homepage.png)

Send messages to other users:
![image Screenshot](./images/send_messages.png)

Log into your account:
![image Screenshot](./images/signin.png)

Create a new account:
![image Screenshot](./images/signup.png)

Start a new chat:
![image Screenshot](./images/start_new_group_chat.png)

Edit your chats:
![image Screenshot](./images/edit_group_chat.png)

## Contribution Guidelines

I welcome contributions! If you have ideas for improvements or new features, feel free to open an issue or submit a pull request.

## License

This project is licensed under the [MIT License](LICENSE).

Thank you for using and contributing to the Realtime Chat Application!

 
