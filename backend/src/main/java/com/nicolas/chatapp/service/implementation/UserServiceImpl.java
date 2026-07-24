package com.nicolas.chatapp.service.implementation;

import com.nicolas.chatapp.config.JwtConstants;
import com.nicolas.chatapp.config.TokenProvider;
import com.nicolas.chatapp.dto.request.UpdateUserRequestDTO;
import com.nicolas.chatapp.exception.UserException;
import com.nicolas.chatapp.model.User;
import com.nicolas.chatapp.model.UserPublicKey;
import com.nicolas.chatapp.repository.UserPublicKeyRepository;
import com.nicolas.chatapp.repository.UserRepository;
import com.nicolas.chatapp.service.UserService;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.*;

@Service
@RequiredArgsConstructor
public class UserServiceImpl implements UserService {

    private final UserRepository userRepository;
    private final UserPublicKeyRepository userPublicKeyRepository;
    private final TokenProvider tokenProvider;

    @Override
    public User findUserById(UUID id) throws UserException {

        Optional<User> user = userRepository.findById(id);

        if (user.isPresent()) {
            return user.get();
        }

        throw new UserException("User not found with id " + id);
    }

    @Override
    public User findUserByProfile(String jwt) throws UserException {

        String email = String.valueOf(tokenProvider.getClaimsFromToken(jwt).get(JwtConstants.EMAIL));

        if (email == null) {
            throw new BadCredentialsException("Invalid token");
        }

        Optional<User> user = userRepository.findByEmail(email);

        if (user.isPresent()) {
            return user.get();
        }

        throw new UserException("User not found with email " + email);
    }

    @Override
    public User updateUser(UUID id, UpdateUserRequestDTO request) throws UserException {

        User user = findUserById(id);

        if (Objects.nonNull(request.fullName())) {
            user.setFullName(request.fullName());
        }

        return userRepository.save(user);
    }

    @Override
    public List<User> searchUser(String query) {
        return userRepository.findByFullNameOrEmail(query).stream()
                .sorted(Comparator.comparing(User::getFullName))
                .toList();
    }

    @Override
    public List<User> searchUserByName(String name) {
        return userRepository.findByFullName(name).stream()
                .sorted(Comparator.comparing(User::getFullName))
                .toList();
    }

    @Override
    public void updatePublicKey(UUID userId, String publicKey) throws UserException {
        findUserById(userId); // validates user exists, throws if not

        userPublicKeyRepository.findByUserIdAndIsActiveTrue(userId)
                .ifPresent(existing -> {
                    existing.setActive(false);
                    userPublicKeyRepository.save(existing);
                });

        UserPublicKey newKey = UserPublicKey.builder()
                .userId(userId)
                .publicKey(publicKey)
                .createdAt(LocalDateTime.now())
                .isActive(true)
                .build();

        userPublicKeyRepository.save(newKey);
    }

    @Override
    public Optional<String> getUserPublicKey(UUID userId) throws UserException {
        findUserById(userId);
        return userPublicKeyRepository.findByUserIdAndIsActiveTrue(userId)
                .map(UserPublicKey::getPublicKey);
    }

    @Override
    public Map<UUID, String> getUserPublicKeys(Set<UUID> userIds) throws UserException {
        Map<UUID, String> result = new HashMap<>();
        for (UUID id : userIds) {
            getUserPublicKey(id).ifPresent(key -> result.put(id, key));
        }
        return result;
    }

}

