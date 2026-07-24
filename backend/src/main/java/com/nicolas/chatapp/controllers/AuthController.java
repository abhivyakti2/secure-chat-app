package com.nicolas.chatapp.controllers;

import com.nicolas.chatapp.config.JwtConstants;
import com.nicolas.chatapp.config.TokenProvider;
import com.nicolas.chatapp.dto.request.LoginRequestDTO;
import com.nicolas.chatapp.dto.request.PasswordChangeRequestDTO;
import com.nicolas.chatapp.dto.request.UpdateUserRequestDTO;
import com.nicolas.chatapp.dto.response.ApiResponseDTO;
import com.nicolas.chatapp.dto.response.LoginResponseDTO;
import com.nicolas.chatapp.exception.AccountLockedException;
import com.nicolas.chatapp.exception.UserException;
import com.nicolas.chatapp.model.User;
import com.nicolas.chatapp.repository.UserRepository;
import com.nicolas.chatapp.service.UserService;
import com.nicolas.chatapp.service.implementation.CustomUserDetailsService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.Optional;

@Slf4j
@CrossOrigin
@RestController
@RequiredArgsConstructor
@RequestMapping("/auth")
public class AuthController {

    private final TokenProvider tokenProvider;
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final CustomUserDetailsService customUserDetailsService;
    private final UserService userService;

    @PostMapping("/signup")
    public ResponseEntity<LoginResponseDTO> signup(@RequestBody UpdateUserRequestDTO signupRequestDTO) throws UserException {

        final String email = signupRequestDTO.email();
        final String password = signupRequestDTO.password();
        final String fullName = signupRequestDTO.fullName();

        Optional<User> existingUser = userRepository.findByEmail(email);

        if (existingUser.isPresent()) {
            throw new UserException("Account with email " + email + " already exists");
        }

        User newUser = User.builder()
                .email(email)
                .password(passwordEncoder.encode(password))
                .fullName(fullName)
                .build();

        userRepository.save(newUser);

        Authentication authentication = new UsernamePasswordAuthenticationToken(email, password);
        SecurityContextHolder.getContext().setAuthentication(authentication);
        String jwt = tokenProvider.generateToken(authentication);

        LoginResponseDTO loginResponseDTO = LoginResponseDTO.builder()
                .token(jwt)
                .isAuthenticated(true)
                .build();

        log.info("User {} successfully signed up", email);

        return new ResponseEntity<>(loginResponseDTO, HttpStatus.ACCEPTED);
    }

    @PostMapping("/signin")
    public ResponseEntity<LoginResponseDTO> login(@RequestBody LoginRequestDTO loginRequestDTO) {

        final String email = loginRequestDTO.email();
        final String password = loginRequestDTO.password();

        try {
            Authentication authentication = authenticateReq(email, password);
            SecurityContextHolder.getContext().setAuthentication(authentication);
            String jwt = tokenProvider.generateToken(authentication);

            LoginResponseDTO loginResponseDTO = LoginResponseDTO.builder()
                    .token(jwt)
                    .isAuthenticated(true)
                    .build();

            log.info("User {} successfully signed in", email);
            return new ResponseEntity<>(loginResponseDTO, HttpStatus.ACCEPTED);

        } catch (AccountLockedException ex) {
            log.warn("Login blocked for {} - locked for {} more minute(s)", email, ex.getRemainingMinutes());
            LoginResponseDTO locked = LoginResponseDTO.builder()
                    .isAuthenticated(false)
                    .lockoutTimeRemainingMinutes((int) ex.getRemainingMinutes())
                    .build();
            return new ResponseEntity<>(locked, HttpStatus.LOCKED);

        } catch (BadCredentialsException ex) {
            log.warn("Login failed for {}", email);
            LoginResponseDTO failed = LoginResponseDTO.builder()
                    .isAuthenticated(false)
                    .build();
            return new ResponseEntity<>(failed, HttpStatus.UNAUTHORIZED);
        }
    }

    @PutMapping("/password")
    public ResponseEntity<ApiResponseDTO> changePassword(@RequestBody PasswordChangeRequestDTO request,
                                                          @RequestHeader(JwtConstants.TOKEN_HEADER) String token)
            throws UserException {

        User user = userService.findUserByProfile(token);

        if (!passwordEncoder.matches(request.oldPassword(), user.getPassword())) {
            throw new BadCredentialsException("Old password is incorrect");
        }

        user.setPassword(passwordEncoder.encode(request.newPassword()));
        userRepository.save(user);

        log.info("Password changed for user: {}", user.getEmail());

        ApiResponseDTO response = ApiResponseDTO.builder()
                .message("Password updated")
                .status(true)
                .build();

        return new ResponseEntity<>(response, HttpStatus.OK);
    }

    private static final int MAX_FAILED_ATTEMPTS = 2;
    private static final int LOCKOUT_MINUTES = 15;

    public Authentication authenticateReq(String username, String password) {

        User user = userRepository.findByEmail(username)
                .orElseThrow(() -> new BadCredentialsException("Invalid username"));

        if (user.getLockoutTime() != null) {
            if (user.getLockoutTime().isAfter(LocalDateTime.now())) {
                long remaining = Duration.between(LocalDateTime.now(), user.getLockoutTime()).toMinutes() + 1;
                throw new AccountLockedException(remaining);
            }
            // lockout expired — reset before re-checking password
            user.setFailedLoginAttempts(0);
            user.setLockoutTime(null);
        }

        if (!passwordEncoder.matches(password, user.getPassword())) {
            user.setFailedLoginAttempts(user.getFailedLoginAttempts() + 1);
            if (user.getFailedLoginAttempts() >= MAX_FAILED_ATTEMPTS) {
                user.setLockoutTime(LocalDateTime.now().plusMinutes(LOCKOUT_MINUTES));
            }
            userRepository.save(user);
            throw new BadCredentialsException("Invalid Password");
        }

        if (user.getFailedLoginAttempts() != 0 || user.getLockoutTime() != null) {
            user.setFailedLoginAttempts(0);
            user.setLockoutTime(null);
        }
        userRepository.save(user);

        UserDetails userDetails = customUserDetailsService.loadUserByUsername(username);
        return new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());
    }

}

