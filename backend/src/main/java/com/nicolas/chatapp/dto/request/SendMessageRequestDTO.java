package com.nicolas.chatapp.dto.request;

import java.util.Map;
import java.util.UUID;

public record SendMessageRequestDTO(UUID chatId, String content, String iv, Map<String, String> encryptedAesKeys) {
}

