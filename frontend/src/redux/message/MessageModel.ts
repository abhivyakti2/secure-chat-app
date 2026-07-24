import {UUID} from "node:crypto";
import {UserDTO} from "../auth/AuthModel";
import {ChatDTO} from "../chat/ChatModel";

export interface MessageDTO {
    id: UUID;
    content: string;
    timeStamp: string;
    user: UserDTO;
    readBy: UUID[];
    iv?: string | null;
    encryptedAesKeys?: Record<string, string> | null;
    isEncrypted?: boolean;
}

export interface WebSocketMessageDTO {
    id: UUID;
    content: string;
    timeStamp: string;
    user: UserDTO;
    chat: ChatDTO;
    iv?: string | null;
    encryptedAesKeys?: Record<string, string> | null;
    isEncrypted?: boolean;
}

export interface SendMessageRequestDTO {
    chatId: UUID;
    content: string;
    iv?: string | null;
    encryptedAesKeys?: Record<string, string> | null;
}

export type MessageReducerState = {
    messages: MessageDTO[];
    newMessage: MessageDTO | null;
}
