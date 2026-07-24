package com.nicolas.chatapp.model;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.UuidGenerator;

import java.time.LocalDateTime;
import java.util.UUID;

@Getter
@Setter
@Entity
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserPublicKey {

    @Id
    @GeneratedValue
    @UuidGenerator
    private UUID id;

    private UUID userId;

    @Column(columnDefinition = "TEXT")
    private String publicKey;

    private LocalDateTime createdAt;

    @Builder.Default
    @Column(nullable = false)
    private boolean isActive = true;

}

