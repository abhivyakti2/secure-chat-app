import React, {Dispatch, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useDispatch, useSelector} from "react-redux";
import {RootState} from "../../redux/Store";
import {AuthReducerState} from "../../redux/auth/AuthModel";
import {TOKEN} from "../../config/Config";
import {currentUser} from "../../redux/auth/AuthAction";
import RecoveryService from "../../services/RecoveryService";
import KeyManagementService from "../../services/KeyManagementService";
import {Button, TextField, Alert, CircularProgress} from "@mui/material";
import styles from "./Register.module.scss";

const RecoverAccess = () => {
    const [mnemonic, setMnemonic] = useState<string>("");
    const [newPassword, setNewPassword] = useState<string>("");
    const [confirmPassword, setConfirmPassword] = useState<string>("");
    const [error, setError] = useState<string>("");
    const [success, setSuccess] = useState<string>("");
    const [loading, setLoading] = useState<boolean>(false);

    const navigate = useNavigate();
    const dispatch: Dispatch<any> = useDispatch();
    const token: string | null = localStorage.getItem(TOKEN);
    const auth: AuthReducerState = useSelector((state: RootState) => state.auth);

    const onSubmit = async (e: React.ChangeEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError("");
        setSuccess("");

        const trimmedPhrase = mnemonic.trim().toLowerCase();
        if (trimmedPhrase.split(/\s+/).length < 12) {
            setError("Please enter your full 12-word recovery phrase.");
            return;
        }
        if (newPassword.length < 6) {
            setError("New password must be at least 6 characters.");
            return;
        }
        if (newPassword !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }
        if (!token || !auth.reqUser) {
            setError("You must be logged in to recover access.");
            return;
        }

        setLoading(true);
        try {
            const userId = auth.reqUser.id.toString();
            await RecoveryService.recoverAccess(trimmedPhrase, newPassword, userId, token);

            // Upload new public key if needed (re-wrap doesn't change keys, but ensure it's uploaded)
            const publicKey = KeyManagementService.getCachedPrivateKey();
            // Just signal success — keys are restored locally and password is changed
            setSuccess("Access recovered successfully! Your encryption keys have been restored with your new password.");

            // Navigate home after delay
            setTimeout(() => navigate("/"), 2000);
        } catch (err: any) {
            setError(err.message || "Recovery failed. Check your phrase and try again.");
        } finally {
            setLoading(false);
        }
    };

    const onBackToSignIn = () => {
        navigate("/signin");
    };

    return (
        <div>
            <div className={styles.outerContainer}>
                <div className={styles.innerContainer}>
                    <h2 style={{textAlign: "center", marginBottom: "1rem"}}>Recover Access</h2>
                    <p style={{textAlign: "center", fontSize: "0.85rem", color: "#888", marginBottom: "1rem"}}>
                        Enter your 12-word recovery phrase and set a new password to regain access to your encrypted messages.
                    </p>

                    <form onSubmit={onSubmit}>
                        <div>
                            <p className={styles.text}>Recovery Phrase</p>
                            <TextField
                                className={styles.textInput}
                                id="mnemonic"
                                type="text"
                                label="Enter your 12-word recovery phrase"
                                variant="outlined"
                                multiline
                                rows={3}
                                fullWidth
                                value={mnemonic}
                                onChange={(e) => setMnemonic(e.target.value)}
                                placeholder="word1 word2 word3 ..."
                            />
                        </div>
                        <div style={{marginTop: "1rem"}}>
                            <p className={styles.text}>New Password</p>
                            <TextField
                                className={styles.textInput}
                                id="newPassword"
                                type="password"
                                label="Enter new password"
                                variant="outlined"
                                fullWidth
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                            />
                        </div>
                        <div style={{marginTop: "1rem"}}>
                            <p className={styles.text}>Confirm New Password</p>
                            <TextField
                                className={styles.textInput}
                                id="confirmPassword"
                                type="password"
                                label="Confirm new password"
                                variant="outlined"
                                fullWidth
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                            />
                        </div>

                        {error && (
                            <Alert severity="error" sx={{mt: 2}}>{error}</Alert>
                        )}
                        {success && (
                            <Alert severity="success" sx={{mt: 2}}>{success}</Alert>
                        )}

                        <div className={styles.button} style={{marginTop: "1rem"}}>
                            <Button
                                fullWidth
                                variant="contained"
                                size="large"
                                type="submit"
                                disabled={loading}
                            >
                                {loading ? <CircularProgress size={24}/> : "Recover Access"}
                            </Button>
                        </div>
                    </form>

                    <div className={styles.bottomContainer}>
                        <p>Remember your password?</p>
                        <Button variant='text' size='large' onClick={onBackToSignIn}>Back to Sign In</Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default RecoverAccess;

