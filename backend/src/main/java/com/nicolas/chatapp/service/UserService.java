package com.nicolas.chatapp.service;

import com.nicolas.chatapp.dto.request.UpdateUserRequestDTO;
import com.nicolas.chatapp.exception.UserException;
import com.nicolas.chatapp.model.User;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

public interface UserService {

    User findUserById(UUID id) throws UserException;

    User findUserByProfile(String jwt) throws UserException;

    User updateUser(UUID id, UpdateUserRequestDTO request) throws UserException;

    List<User> searchUser(String query);

    List<User> searchUserByName(String name);

    void updatePublicKey(UUID userId, String publicKey) throws UserException;

    Optional<String> getUserPublicKey(UUID userId) throws UserException;

    Map<UUID, String> getUserPublicKeys(Set<UUID> userIds) throws UserException;

}

