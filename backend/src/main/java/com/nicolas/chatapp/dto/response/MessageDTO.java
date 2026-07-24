package com.nicolas.chatapp.dto.response;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nicolas.chatapp.model.Message;
import lombok.Builder;

import java.time.LocalDateTime;
import java.util.*;

@Builder
public record MessageDTO(UUID id, String content, LocalDateTime timeStamp, UserDTO user, Set<UUID> readBy,
                          String iv, Map<String, String> encryptedAesKeys, boolean isEncrypted) {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static MessageDTO fromMessage(Message message) {
        if (Objects.isNull(message)) return null;

        Map<String, String> keys = Map.of();
        if (message.getEncryptedAesKeys() != null) {
            try {
                keys = MAPPER.readValue(message.getEncryptedAesKeys(), new TypeReference<Map<String, String>>() {});
            } catch (Exception e) {
                keys = Map.of();
            }
        }

        return MessageDTO.builder()
                .id(message.getId())
                .content(message.getContent())
                .timeStamp(message.getTimeStamp())
                .user(UserDTO.fromUser(message.getUser()))
                .readBy(new HashSet<>(message.getReadBy()))
                .iv(message.getIv())
                .encryptedAesKeys(keys)
                .isEncrypted(message.isEncrypted())
                .build();
    }

    public static List<MessageDTO> fromMessages(Collection<Message> messages) {
        if (Objects.isNull(messages)) return List.of();
        return messages.stream()
                .map(MessageDTO::fromMessage)
                .toList();
    }

}

