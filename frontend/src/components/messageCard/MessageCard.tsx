import {MessageDTO} from "../../redux/message/MessageModel";
import {UserDTO} from "../../redux/auth/AuthModel";
import styles from './MessageCard.module.scss';
import {Chip} from "@mui/material";
import React, {useEffect, useState} from "react";
import {getDateFormat} from "../utils/Utils";
import CryptoService from "../../services/CryptoService";
import KeyManagementService from "../../services/KeyManagementService";
import TelemetryService from "../../services/TelemetryService";

interface MessageCardProps {
    message: MessageDTO;
    reqUser: UserDTO | null;
    isNewDate: boolean;
    isGroup: boolean;
}

const MessageCard = (props: MessageCardProps) => {

    const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
    const [decryptError, setDecryptError] = useState<boolean>(false);

    const isOwnMessage = props.message.user.id === props.reqUser?.id;
    const date: Date = new Date(props.message.timeStamp);
    const hours = date.getHours() > 9 ? date.getHours().toString() : "0" + date.getHours();
    const minutes = date.getMinutes() > 9 ? date.getMinutes().toString() : "0" + date.getMinutes();

    useEffect(() => {
        if (props.message.isEncrypted && props.reqUser) {
            const myUserId = props.reqUser.id.toString();
            const myEncryptedKey = props.message.encryptedAesKeys?.[myUserId];

            if (!myEncryptedKey || !props.message.iv) {
                setDecryptError(true);
                TelemetryService.logDecryptFailure({
                    userId: myUserId,
                    chatId: "",
                    messageId: props.message.id.toString(),
                    failureReason: !props.message.iv ? "missing-iv" : "missing-encrypted-key",
                    timestamp: new Date().toISOString(),
                }, null);
                return;
            }

            const doDecrypt = async () => {
                let privateKey: CryptoKey;
                try {
                    privateKey = KeyManagementService.getCachedPrivateKey();
                } catch {
                    setDecryptError(true);
                    TelemetryService.logDecryptFailure({
                        userId: myUserId,
                        chatId: "",
                        messageId: props.message.id.toString(),
                        failureReason: "private-key-not-loaded",
                        timestamp: new Date().toISOString(),
                    }, null);
                    return;
                }
                try {
                    const plaintext = await CryptoService.hybridDecrypt(
                        props.message.content,
                        props.message.iv!,
                        myEncryptedKey,
                        privateKey
                    );
                    setDecryptedContent(plaintext);
                } catch {
                    setDecryptError(true);
                    TelemetryService.logDecryptFailure({
                        userId: myUserId,
                        chatId: "",
                        messageId: props.message.id.toString(),
                        failureReason: "decrypt-threw",
                        timestamp: new Date().toISOString(),
                    }, null);
                }
            };
            doDecrypt();
        }
    }, [props.message, props.reqUser]);

    const displayContent = props.message.isEncrypted
        ? decryptedContent ?? (decryptError ? "🔒 Cannot decrypt" : "🔒 Decrypting...")
        : props.message.content;

    const label: React.ReactElement = (
        <div className={styles.bubbleContainer}>
            {props.isGroup && !isOwnMessage && <h4 className={styles.contentContainer}>{props.message.user.fullName}:</h4>}
            <p className={styles.contentContainer}>{displayContent}</p>
            <p className={styles.timeContainer}>{hours + ":" + minutes}</p>
        </div>
    );

    const dateLabel: React.ReactElement = (
      <p>{getDateFormat(date)}</p>
    );

    return (
        <div className={styles.messageCardInnerContainer}>
            {props.isNewDate && <div className={styles.date}>{<Chip label={dateLabel}
                                                                    sx={{height: 'auto', width: 'auto', backgroundColor: '#faebd7'}}/>}</div>}
            <div className={isOwnMessage ? styles.ownMessage : styles.othersMessage}>
                <Chip label={label}
                      sx={{height: 'auto', width: 'auto', backgroundColor: isOwnMessage ? '#d3fdd3' : 'white', ml: '0.75rem'}}/>
            </div>
        </div>
    );
};

export default MessageCard;
