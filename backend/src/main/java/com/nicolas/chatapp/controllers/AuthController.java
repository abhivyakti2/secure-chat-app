package com.nicolas.chatapp.controllers;

import com.nicolas.chatapp.config.JwtConstants;
import com.nicolas.chatapp.config.TokenProvider;
import com.nicolas.chatapp.dto.request.LoginRequestDTO;
import com.nicolas.chatapp.dto.request.PasswordChangeRequestDTO;
import com.nicolas.chatapp.dto.request.UpdateUserRequestDTO;
import com.nicolas.chatapp.dto.request.VerifyOtpRequestDTO;
import com.nicolas.chatapp.dto.response.ApiResponseDTO;
import com.nicolas.chatapp.dto.response.LoginResponseDTO;
import com.nicolas.chatapp.exception.AccountLockedException;
import com.nicolas.chatapp.exception.UserException;
import com.nicolas.chatapp.model.PendingSignup;
import com.nicolas.chatapp.model.User;
import com.nicolas.chatapp.repository.PendingSignupRepository;
import com.nicolas.chatapp.repository.UserRepository;
import com.nicolas.chatapp.service.CaptchaService;
import com.nicolas.chatapp.service.EmailService;
import com.nicolas.chatapp.service.UserService;
import com.nicolas.chatapp.service.implementation.CustomUserDetailsService;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
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
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.Random;

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
    private final PendingSignupRepository pendingSignupRepository;
    private final EmailService emailService;
    private final CaptchaService captchaService;

    @Transactional
    @PostMapping("/signup")
    public ResponseEntity<ApiResponseDTO> signup(@RequestBody UpdateUserRequestDTO signupRequestDTO) throws UserException {

        final String email = signupRequestDTO.email();
        final String password = signupRequestDTO.password();
        final String fullName = signupRequestDTO.fullName();

        if (!captchaService.verifyCaptcha(signupRequestDTO.captchaToken())) {
            throw new UserException("Captcha verification failed. Please try again.");
        }

        Optional<User> existingUser = userRepository.findByEmail(email);

        if (existingUser.isPresent()) {
            throw new UserException("Account with email " + email + " already exists");
        }

        // Generate 6-digit OTP
        String otpCode = String.format("%06d", new Random().nextInt(1000000));

        // Remove any previous pending signup for this email (e.g. retry)
        pendingSignupRepository.deleteByEmail(email);

        PendingSignup pendingSignup = PendingSignup.builder()
                .email(email)
                .password(passwordEncoder.encode(password))
                .fullName(fullName)
                .otpCode(otpCode)
                .expiresAt(LocalDateTime.now().plusMinutes(10))
                .build();

        pendingSignupRepository.save(pendingSignup);
        emailService.sendOtpEmail(email, otpCode);

        log.info("OTP sent to {}", email);

        ApiResponseDTO response = ApiResponseDTO.builder()
                .message("OTP sent to your email")
                .status(true)
                .build();

        return new ResponseEntity<>(response, HttpStatus.OK);
    }

@Transactional
    @PostMapping("/verify-otp")
    public ResponseEntity<LoginResponseDTO> verifyOtp(@RequestBody VerifyOtpRequestDTO verifyOtpRequestDTO,
                                                      HttpServletResponse response) throws UserException {

final String email = verifyOtpRequestDTO.email();
        final String otpCode = verifyOtpRequestDTO.otpCode();

        log.info("=== OTP verification attempt received for email={} with submitted code='{}' ===", email, otpCode);

        PendingSignup pendingSignup = pendingSignupRepository.findByEmail(email)
                .orElseThrow(() -> {
                    log.warn("OTP FAIL: no pending signup found for email={}", email);
                    return new UserException("No pending signup found for this email");
                });

        log.info("Pending signup found for email={}: expiresAt={}, otpAttempts={}, storedOtpCode='{}'",
                email, pendingSignup.getExpiresAt(), pendingSignup.getOtpAttempts(), pendingSignup.getOtpCode());

        if (pendingSignup.getExpiresAt().isBefore(LocalDateTime.now())) {
            log.warn("OTP FAIL: OTP expired for email={}. expiresAt={}, now={}",
                    email, pendingSignup.getExpiresAt(), LocalDateTime.now());
            pendingSignupRepository.deleteByEmail(email);
            throw new UserException("OTP has expired. Please sign up again.");
        }

        // OTP brute-force protection: limit to 5 attempts
        if (pendingSignup.getOtpAttempts() >= 5) {
            log.warn("OTP FAIL: too many attempts for email={}. otpAttempts={}", email, pendingSignup.getOtpAttempts());
            pendingSignupRepository.deleteByEmail(email);
            throw new UserException("Too many failed OTP attempts. Please sign up again.");
        }

        if (!pendingSignup.getOtpCode().equals(otpCode)) {
            pendingSignup.setOtpAttempts(pendingSignup.getOtpAttempts() + 1);
            pendingSignupRepository.save(pendingSignup);
            int remaining = 5 - pendingSignup.getOtpAttempts();
            log.warn("OTP MISMATCH for email={}: submitted='{}', stored='{}'. attempts now={}, remaining={}",
                    email, otpCode, pendingSignup.getOtpCode(), pendingSignup.getOtpAttempts(), remaining);
            if (remaining <= 0) {
                pendingSignupRepository.deleteByEmail(email);
                throw new UserException("Too many failed OTP attempts. Please sign up again.");
            }
            throw new UserException("Invalid OTP code. " + remaining + " attempt(s) remaining.");
        }

        log.info("OTP MATCH for email={}. Proceeding to create user.", email);

        User newUser = User.builder()
                .email(pendingSignup.getEmail())
                .password(pendingSignup.getPassword())
                .fullName(pendingSignup.getFullName())
                .build();

        userRepository.save(newUser);
        pendingSignupRepository.deleteByEmail(email);

        Authentication authentication = new UsernamePasswordAuthenticationToken(email, null, List.of());
        SecurityContextHolder.getContext().setAuthentication(authentication);
        String jwt = tokenProvider.generateToken(authentication);

// Set JWT as httpOnly, SameSite cookie for XSS protection.
        // The Secure flag is enabled in production (HTTPS) and configurable via env.
        Cookie jwtCookie = new Cookie("token", jwt);
        jwtCookie.setHttpOnly(true);
        jwtCookie.setSecure(isSecureCookie());
        jwtCookie.setPath("/");
        jwtCookie.setMaxAge(24 * 60 * 60); // 24 hours
        jwtCookie.setAttribute("SameSite", "Lax");
        response.addCookie(jwtCookie);

        LoginResponseDTO loginResponseDTO = LoginResponseDTO.builder()
                .token(jwt)  // Also return in body for backward compatibility
                .isAuthenticated(true)
                .build();

        log.info("User {} successfully verified and signed up", email);

        return new ResponseEntity<>(loginResponseDTO, HttpStatus.CREATED);
    }

@PostMapping("/signin")
    public ResponseEntity<LoginResponseDTO> login(@RequestBody LoginRequestDTO loginRequestDTO,
                                                    HttpServletResponse response) {

        final String email = loginRequestDTO.email();
        final String password = loginRequestDTO.password();

        try {
            Authentication authentication = authenticateReq(email, password);
            SecurityContextHolder.getContext().setAuthentication(authentication);
            String jwt = tokenProvider.generateToken(authentication);

// Set JWT as httpOnly, SameSite cookie for XSS protection
            Cookie jwtCookie = new Cookie("token", jwt);
            jwtCookie.setHttpOnly(true);
            jwtCookie.setSecure(isSecureCookie());
            jwtCookie.setPath("/");
            jwtCookie.setMaxAge(24 * 60 * 60); // 24 hours
            jwtCookie.setAttribute("SameSite", "Lax");
            response.addCookie(jwtCookie);

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

    /**
     * Sign out: clear the JWT cookie.
     */
@PostMapping("/signout")
    public ResponseEntity<ApiResponseDTO> signout(HttpServletResponse response) {
        Cookie jwtCookie = new Cookie("token", null);
        jwtCookie.setHttpOnly(true);
        jwtCookie.setSecure(isSecureCookie());
        jwtCookie.setPath("/");
        jwtCookie.setMaxAge(0); // Delete immediately
        jwtCookie.setAttribute("SameSite", "Lax");
        response.addCookie(jwtCookie);

        log.info("User signed out, cookie cleared");

        ApiResponseDTO responseDTO = ApiResponseDTO.builder()
                .message("Signed out successfully")
                .status(true)
                .build();

        return new ResponseEntity<>(responseDTO, HttpStatus.OK);
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

    /**
     * Decide whether to set the {@code Secure} flag on the JWT cookie.
     * <p>
     * In production (HTTPS) the cookie must be marked Secure so it is never sent over
     * plain HTTP. This is read from the {@code JWT_COOKIE_SECURE} env var, defaulting to
     * {@code true} when the active Spring profile is {@code prod}, and {@code false} for
     * local development (plain HTTP on localhost).
     */
    private static boolean isSecureCookie() {
        String explicit = System.getenv("JWT_COOKIE_SECURE");
        if (explicit != null) {
            return Boolean.parseBoolean(explicit);
        }
        String profiles = System.getenv("SPRING_PROFILES_ACTIVE");
        return profiles != null && profiles.contains("prod");
    }

}

