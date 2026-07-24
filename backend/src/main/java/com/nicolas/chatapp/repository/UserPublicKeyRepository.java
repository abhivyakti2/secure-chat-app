package com.nicolas.chatapp.repository;

import com.nicolas.chatapp.model.UserPublicKey;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface UserPublicKeyRepository extends JpaRepository<UserPublicKey, UUID> {

    Optional<UserPublicKey> findByUserIdAndIsActiveTrue(UUID userId);

    List<UserPublicKey> findByUserIdOrderByCreatedAtDesc(UUID userId);

}

