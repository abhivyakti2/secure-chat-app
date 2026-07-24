import styles from './Register.module.scss'
import {useNavigate} from "react-router-dom";
import React, {Dispatch, useCallback, useEffect, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {TOKEN} from "../../config/Config";
import {RootState} from "../../redux/Store";
import {AuthReducerState, SignUpRequestDTO} from "../../redux/auth/AuthModel";
import {currentUser, register, uploadPublicKey} from "../../redux/auth/AuthAction";
import {Button, CircularProgress, TextField} from "@mui/material";
import KeyManagementService from "../../services/KeyManagementService";
import RecoveryService from "../../services/RecoveryService";
import RecoveryPhraseDialog from "./RecoveryPhraseDialog";


// TODO: Verify email
// TODO: Check if account already exists
// TODO: Show error if something went wrong
const SignUp = () => {

    const [createAccountData, setCreateAccountData] = useState<SignUpRequestDTO>({
        fullName: "",
        email: "",
        password: ""
    });
    const [showPhraseDialog, setShowPhraseDialog] = useState<boolean>(false);
    const [recoveryPhrase, setRecoveryPhrase] = useState<string>("");
    const [isGeneratingKeys, setIsGeneratingKeys] = useState<boolean>(false);
    const navigate = useNavigate();
    const dispatch: Dispatch<any> = useDispatch();
    const token: string | null = localStorage.getItem(TOKEN);
    const state: AuthReducerState = useSelector((state: RootState) => state.auth);

    useEffect(() => {
        if (token && !state.reqUser) {
            dispatch(currentUser(token));
        }
    }, [token, state.reqUser, dispatch]);

    const initE2EEAndGeneratePhrase = useCallback(async () => {
        if (!state.reqUser || !token) return;
        setIsGeneratingKeys(true);

        try {
            const userId = state.reqUser.id.toString();

            // 1. Initialize E2EE keys (generate RSA keypair, encrypt private key with password)
            const publicKey = await KeyManagementService.initializeOnSignup(userId, createAccountData.password);

            // 2. Upload public key to backend
            dispatch(uploadPublicKey(publicKey, token));

            // 3. Generate recovery phrase
            const phrase = RecoveryService.generateMnemonic();

            // 4. Encrypt private key with mnemonic and upload recovery blob to backend
            // Need to get the private key from KeyManagementService — it's cached
            // The private key is already encrypted locally; we need the raw private key
            // Since initializeOnSignup already called encryptPrivateKey, we need to extract it
            // We'll generate the recovery blob after the dialog is confirmed

            setRecoveryPhrase(phrase);
            setShowPhraseDialog(true);

            console.log("E2EE keys initialized and public key uploaded");
        } catch (err) {
            console.error("Failed to initialize E2EE keys after signup:", err);
        } finally {
            setIsGeneratingKeys(false);
        }
    }, [state.reqUser, token, createAccountData.password, dispatch]);

    const onRecoveryPhraseConfirmed = useCallback(async () => {
        if (!state.reqUser || !token || !recoveryPhrase) return;

        try {
            const userId = state.reqUser.id.toString();

            // The private key is in IndexedDB encrypted with password. We need to:
            // 1. Decrypt it using the password
            // 2. Re-encrypt it with the mnemonic
            // 3. Upload the recovery blob

            // Load the private key from IndexedDB
            const storedRecord = (await import("../../services/KeyStorageService")).default;
            const record = await storedRecord.getKeyRecord(userId);
            if (!record) throw new Error("No key record found after signup");

            const CryptoService = (await import("../../services/CryptoService")).default;
            const privateKeyBase64 = await CryptoService.decryptPrivateKey(
                { encryptedData: record.encryptedData, iv: record.iv, salt: record.salt },
                createAccountData.password
            );

            // Encrypt with mnemonic
            const recoveryBlob = await RecoveryService.encryptPrivateKeyWithMnemonic(
                privateKeyBase64,
                recoveryPhrase
            );

            // Upload blob to backend
            await RecoveryService.uploadRecoveryBlob(recoveryBlob, token);

            // Mark phrase as shown
            RecoveryService.markPhraseShown();

            console.log("Recovery phrase generated and blob uploaded");
        } catch (err) {
            console.error("Failed to upload recovery blob:", err);
            // Non-blocking — user can still use the app, recovery is just not available
            console.warn("Recovery blob upload failed, but account setup continued");
        }

        setShowPhraseDialog(false);
        navigate("/");
    }, [state.reqUser, token, recoveryPhrase, createAccountData.password, navigate]);

    useEffect(() => {
        if (state.reqUser && !showPhraseDialog && !isGeneratingKeys && !recoveryPhrase) {
            // Only run if we haven't started the process yet
            initE2EEAndGeneratePhrase();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state, navigate]);

    const onSubmit = (e: React.ChangeEvent<HTMLFormElement>) => {
        e.preventDefault();
        console.log("Sign up form submitted");
        dispatch(register(createAccountData));
    };

    const onChangeFullName = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        setCreateAccountData({...createAccountData, fullName: e.target.value});
    };

    const onChangeEmail = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        setCreateAccountData({...createAccountData, email: e.target.value});
    }

    const onChangePassword = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        setCreateAccountData({...createAccountData, password: e.target.value});
    };

    const onNavigateToSignIn = () => {
        navigate("/signin");
    }

    return (
        <div>
            <div className={styles.outerContainer}>
                <div className={styles.innerContainer}>
                    <form onSubmit={onSubmit}>
                        <div>
                            <p className={styles.text}>Full Name</p>
                            <TextField
                                className={styles.textInput}
                                id="fullName"
                                type="text"
                                label="Enter your full name"
                                variant="outlined"
                                onChange={onChangeFullName}
                                value={createAccountData.fullName}/>
                        </div>
                        <div>
                            <p className={styles.text}>Email</p>
                            <TextField
                                className={styles.textInput}
                                id="email"
                                type="email"
                                label="Enter your email"
                                variant="outlined"
                                onChange={onChangeEmail}
                                value={createAccountData.email}/>
                        </div>
                        <div>
                            <p className={styles.text}>Password</p>
                            <TextField
                                className={styles.textInput}
                                id="password"
                                type="password"
                                label="Enter your password"
                                variant="outlined"
                                onChange={onChangePassword}
                                value={createAccountData.password}/>
                        </div>
                        <div className={styles.button}>
                            <Button
                                fullWidth
                                variant="contained"
                                size="large"
                                type="submit"
                                disabled={isGeneratingKeys}>
                                {isGeneratingKeys ? <CircularProgress size={24}/> : "Sign up"}
                            </Button>
                        </div>
                    </form>
                    <div className={styles.bottomContainer}>
                        <p>Already signed up?</p>
                        <Button variant='text' size='large' onClick={onNavigateToSignIn}>Login</Button>
                    </div>
                </div>
            </div>

            {/* Recovery Phrase Dialog — shown once after signup */}
            <RecoveryPhraseDialog
                phrase={recoveryPhrase}
                open={showPhraseDialog}
                onConfirmed={onRecoveryPhraseConfirmed}
            />
        </div>
    );
};

export default SignUp;
