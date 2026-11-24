/**
 * ==========================================================================
 * CUSTOMER EMAIL PASSWORDLESS AUTH SERVICE (`src/services/emailAuthService.js`)
 * Nails by Divya Platform — Phase 2 Customer Email Authentication
 *
 * Security Guarantees:
 * - Cryptographically random single-use tokens (256-bit via crypto.randomBytes)
 * - Stores ONLY SHA-256 hashed tokens in `email_login_tokens` (never plaintext)
 * - Strict 15-minute expiration TTL
 * - Atomic single-use consumption preventing replay / concurrent race reuse
 * - Uniform responses on request to prevent account enumeration
 * - Strict admin guardrail preventing customer magic links from logging into admin roles
 * - Historical guest orders & bookings linked ONLY after cryptographic email verification
 * - Firebase custom tokens issued ONLY after backend email ownership verification
 * ==========================================================================
 */

"use strict";

const crypto = require("crypto");
const { query, withTransaction } = require("../db/pool");
const CONFIG = require("../config");
const { isOriginAllowed } = require("../middleware/corsConfig");
const { issueEmailVerifiedCustomToken } = require("./firebaseService");
const { findOrCreateUserByFirebaseToken, VALID_ADMIN_ROLES } = require("./userService");

const TOKEN_FORMAT_REGEX = /^[A-Za-z0-9_-]{32,128}$/;
const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const GENERIC_REQUEST_MESSAGE =
  "If that email address is valid, we have sent a sign-in link to your inbox. The link expires in 15 minutes.";

let testEmailSender = null;

/**
 * Registers a controlled email capture hook strictly in NODE_ENV=test.
 * @param {(payload: { to: string, from: string, subject: string, html: string, text: string }) => Promise<{ id: string }>} senderFn
 */
function setTestEmailSender(senderFn) {
  if (!CONFIG.isTest()) {
    throw new Error("setTestEmailSender is strictly forbidden outside test environments (NODE_ENV must be 'test')!");
  }
  testEmailSender = senderFn;
}

/**
 * Clears the test email sender hook.
 */
function clearTestEmailSender() {
  testEmailSender = null;
}

/**
 * Normalizes IP address for PostgreSQL INET storage.
 * @param {string|null} ip
 * @returns {string|null}
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  const clean = ip.trim();
  if (clean === "::1") return "127.0.0.1";
  if (clean.startsWith("::ffff:")) return clean.replace(/^::ffff:/, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean) || clean.includes(":")) return clean;
  return null;
}

/**
 * Validates and normalizes an email address.
 * @param {string} rawEmail
 * @returns {string}
 */
function normalizeAndValidateEmail(rawEmail) {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_FORMAT_REGEX.test(email)) {
    const err = new Error("Please enter a valid email address.");
    err.code = "INVALID_EMAIL";
    err.statusCode = 400;
    throw err;
  }
  return email;
}

/**
 * Hashes a raw single-use token using SHA-256 for server-side persistence/lookup.
 * @param {string} rawToken
 * @returns {string}
 */
function hashLoginToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

/**
 * Resolves a safe frontend base URL from allowlisted origins only.
 * Prevents open-redirect / phishing token leakage via spoofed Origin headers.
 *
 * @param {string|null} originHeader
 * @returns {string}
 */
function resolveSafeFrontendBaseUrl(originHeader) {
  if (originHeader && typeof originHeader === "string") {
    try {
      const parsed = new URL(originHeader.trim());
      const normalizedOrigin = parsed.origin;
      if (normalizedOrigin && normalizedOrigin !== "null") {
        if (CONFIG.isLiveEnvironment()) {
          if (isOriginAllowed(normalizedOrigin)) {
            return normalizedOrigin;
          }
        } else {
          const {
            ALLOWED_PROD_ORIGINS,
            ALLOWED_STAGING_ORIGINS,
          } = require("../middleware/corsConfig");
          const isLocalUrl =
            parsed.protocol === "http:" &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
          const isKnownStage =
            ALLOWED_STAGING_ORIGINS.includes(normalizedOrigin) ||
            (parsed.protocol === "https:" && (parsed.hostname === "pages.dev" || parsed.hostname.endsWith(".pages.dev")));
          const isKnownProd = ALLOWED_PROD_ORIGINS.includes(normalizedOrigin);
          if (isLocalUrl || isKnownStage || isKnownProd) {
            return normalizedOrigin;
          }
        }
      }
    } catch {
      // Ignore malformed origin header and use safe default
    }
  }
  return CONFIG.emailAuth.frontendBaseUrl;
}

/**
 * Renders luxury editorial HTML and plain-text email templates for magic-link login.
 *
 * @param {object} params
 * @param {string} params.loginUrl Single-use URL containing only the token parameter
 * @param {number} params.expiresMinutes
 * @returns {{ subject: string, html: string, text: string }}
 */
function buildMagicLinkEmail({ loginUrl, expiresMinutes = 15 }) {
  const subject = "Your Nails by Divya Sign-In Link";
  const safeUrl = loginUrl.replace(/"/g, "&quot;");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#fcfaf7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2d1f1d;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#fcfaf7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background-color:#ffffff;border:1px solid #eadcdf;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 20px 32px;text-align:center;border-bottom:1px solid #f4ebed;">
              <p style="margin:0 0 6px 0;font-size:11px;letter-spacing:2.2px;text-transform:uppercase;color:#a85b6d;font-weight:700;">Nails by Divya</p>
              <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:600;color:#2d1f1d;line-height:1.2;">Sign In to Your Account</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#4e4446;">
                Use the secure single-use button below to sign in to your Nails by Divya account, view your press-on orders, and manage your custom sizing preferences.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;">
                <tr>
                  <td align="center">
                    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer"
                       style="display:inline-block;padding:14px 28px;background-color:#2d1f1d;color:#fffaf8;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">
                      Sign In to My Account &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 14px 0;font-size:13px;line-height:1.55;color:#6e6264;">
                For your security, this link expires in <strong>${expiresMinutes} minutes</strong> and can only be used once. If you did not request this email, you may safely ignore it.
              </p>
              <div style="margin-top:20px;padding:14px;background-color:#fcf7f8;border:1px solid #f0dfe3;border-radius:8px;">
                <p style="margin:0 0 6px 0;font-size:12px;color:#6e6264;font-weight:600;">Button not working? Copy and paste this link:</p>
                <p style="margin:0;font-size:12px;line-height:1.45;word-break:break-all;color:#8c4a5a;">${safeUrl}</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background-color:#faf6f5;border-top:1px solid #f0e6e8;text-align:center;">
              <p style="margin:0;font-size:12px;color:#837678;">
                Nails by Divya &bull; Handcrafted Press-On Sets &amp; Bespoke Delhi NCR Salon Care
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    "Nails by Divya — Sign In to Your Account",
    "",
    "Click the single-use secure link below to sign in to your Nails by Divya account:",
    loginUrl,
    "",
    `This link expires in ${expiresMinutes} minutes and can only be used once.`,
    "If you did not request this link, you can safely ignore this email.",
  ].join("\n");

  return { subject, html, text };
}

/**
 * Dispatches transactional authentication email via Resend REST API (or test hook in NODE_ENV=test).
 * Fails closed when Resend is unconfigured in live staging/production environments.
 */
async function sendAuthEmail({ to, subject, html, text }) {
  const from = CONFIG.emailAuth.resendFromEmail;

  if (testEmailSender && CONFIG.isTest()) {
    return await testEmailSender({ to, from, subject, html, text });
  }

  if (!CONFIG.emailAuth.isResendConfigured) {
    const err = new Error("Email sign-in is temporarily unavailable because email delivery is not configured.");
    err.code = "EMAIL_SERVICE_UNCONFIGURED";
    err.statusCode = 503;
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.emailAuth.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text,
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`❌ [EmailAuth Resend Error] HTTP ${response.status} delivering auth email.`);
      const err = new Error("Unable to deliver sign-in email at this time. Please try again shortly.");
      err.code = "EMAIL_DELIVERY_FAILED";
      err.statusCode = 502;
      throw err;
    }

    return { id: data.id || "sent" };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error("Email delivery timed out. Please try again.");
      timeoutErr.code = "EMAIL_DELIVERY_TIMEOUT";
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Requests a passwordless single-use customer login link.
 * - Anti-enumeration: always returns generic success for valid email syntax (unless server email delivery itself is unconfigured).
 * - Protects admin & suspended accounts silently without disclosing account existence.
 * - Enforces per-email 15-minute quota to prevent email bombing.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string|null} [params.origin]
 * @param {string|null} [params.ipAddress]
 * @param {string|null} [params.userAgent]
 * @returns {Promise<{ status: string, message: string }>}
 */
async function requestMagicLink({ email, origin = null, ipAddress = null, userAgent = null }) {
  const cleanEmail = normalizeAndValidateEmail(email);

  // Check service availability early (environment-level only, never per-account)
  if (!CONFIG.emailAuth.isResendConfigured && !(testEmailSender && CONFIG.isTest())) {
    const err = new Error("Email sign-in is temporarily unavailable because email delivery is not configured.");
    err.code = "EMAIL_SERVICE_UNCONFIGURED";
    err.statusCode = 503;
    throw err;
  }

  // 1. Check if email belongs to a suspended user or studio administrator (fail silently to prevent enumeration)
  const accountRes = await query(
    `SELECT u.id, u.is_active, array_remove(array_agg(ur.role_id), NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     WHERE LOWER(u.email) = LOWER($1)
     GROUP BY u.id, u.is_active;`,
    [cleanEmail]
  );

  if (accountRes.rows.length > 0) {
    const existing = accountRes.rows[0];
    const roles = Array.isArray(existing.roles) ? existing.roles : [];
    const hasAdminRole = roles.some((r) => VALID_ADMIN_ROLES.includes(r));
    if (existing.is_active === false || hasAdminRole) {
      return {
        status: "success",
        message: GENERIC_REQUEST_MESSAGE,
      };
    }
  }

  // 2. Per-email 15-minute issue throttle (anti-spam without disclosing existence)
  const countRes = await query(
    `SELECT COUNT(*)::int AS recent_count
     FROM email_login_tokens
     WHERE LOWER(email) = LOWER($1)
       AND created_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes';`,
    [cleanEmail]
  );

  if ((countRes.rows[0]?.recent_count || 0) >= CONFIG.emailAuth.maxRequestsPerEmailWindow) {
    return {
      status: "success",
      message: GENERIC_REQUEST_MESSAGE,
    };
  }

  // 3. Generate cryptographically secure 256-bit single-use token and persist ONLY its SHA-256 hash
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashLoginToken(rawToken);
  const ttlMinutes = CONFIG.emailAuth.tokenTtlMinutes || 15;

  const insertRes = await query(
    `INSERT INTO email_login_tokens (
       email,
       token_hash,
       expires_at,
       request_ip,
       user_agent
     ) VALUES (
       $1,
       $2,
       CURRENT_TIMESTAMP + ($3 || ' minutes')::interval,
       $4,
       $5
     )
     RETURNING id;`,
    [
      cleanEmail,
      tokenHash,
      String(ttlMinutes),
      normalizeIp(ipAddress),
      userAgent ? String(userAgent).slice(0, 500) : null,
    ]
  );

  const tokenRecordId = insertRes.rows[0].id;
  const baseUrl = resolveSafeFrontendBaseUrl(origin);
  const loginUrl = `${baseUrl}/account.html?email_token=${encodeURIComponent(rawToken)}`;
  const emailTemplate = buildMagicLinkEmail({ loginUrl, expiresMinutes: ttlMinutes });

  try {
    await sendAuthEmail({
      to: cleanEmail,
      subject: emailTemplate.subject,
      html: emailTemplate.html,
      text: emailTemplate.text,
    });
  } catch (sendErr) {
    // Roll back unused token if delivery failed so the user is not penalized against quota
    await query(`DELETE FROM email_login_tokens WHERE id = $1;`, [tokenRecordId]).catch(() => {});
    throw sendErr;
  }

  return {
    status: "success",
    message: GENERIC_REQUEST_MESSAGE,
  };
}

/**
 * Verifies a single-use customer magic link token atomically, binds/creates the customer account,
 * associates unowned historical guest orders & bookings matching the verified email,
 * and issues a Firebase custom token ONLY after verification succeeds.
 *
 * @param {object} params
 * @param {string} params.token Raw single-use token from URL query parameter
 * @param {string|null} [params.ipAddress]
 * @returns {Promise<{ status: string, customToken: string, linkedOrdersCount: number, linkedBookingsCount: number, user: object }>}
 */
async function verifyMagicLink({ token, ipAddress = null }) {
  const cleanToken = typeof token === "string" ? token.trim() : "";
  if (!cleanToken || !TOKEN_FORMAT_REGEX.test(cleanToken)) {
    const err = new Error("This sign-in link is invalid or malformed. Please request a new sign-in link.");
    err.code = "TOKEN_INVALID";
    err.statusCode = 400;
    throw err;
  }

  const tokenHash = hashLoginToken(cleanToken);
  const cleanIp = normalizeIp(ipAddress);

  const txResult = await withTransaction(async (client) => {
    // 1. Atomic single-use token consumption
    const consumeRes = await client.query(
      `UPDATE email_login_tokens
       SET used_at = CURRENT_TIMESTAMP,
           consumed_ip = $2
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP
       RETURNING id, email, expires_at;`,
      [tokenHash, cleanIp]
    );

    if (consumeRes.rows.length === 0) {
      const lookupRes = await client.query(
        `SELECT used_at, expires_at
         FROM email_login_tokens
         WHERE token_hash = $1;`,
        [tokenHash]
      );

      if (lookupRes.rows.length === 0) {
        const err = new Error("This sign-in link is invalid. Please request a new sign-in link.");
        err.code = "TOKEN_INVALID";
        err.statusCode = 401;
        throw err;
      }

      const existingToken = lookupRes.rows[0];
      if (existingToken.used_at) {
        const err = new Error("This sign-in link has already been used. Please request a new sign-in link.");
        err.code = "TOKEN_USED";
        err.statusCode = 401;
        throw err;
      }

      const err = new Error("This sign-in link has expired after 15 minutes. Please request a new sign-in link.");
      err.code = "TOKEN_EXPIRED";
      err.statusCode = 401;
      throw err;
    }

    const consumedToken = consumeRes.rows[0];
    const verifiedEmail = consumedToken.email.trim().toLowerCase();

    // 2. Invalidate any remaining unused older tokens for the same email
    await client.query(
      `UPDATE email_login_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE LOWER(email) = LOWER($1)
         AND used_at IS NULL
         AND id <> $2;`,
      [verifiedEmail, consumedToken.id]
    );

    // 3. Look up existing PostgreSQL user by verified email
    const existingRes = await client.query(
      `SELECT id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active
       FROM users
       WHERE LOWER(email) = LOWER($1)
       FOR UPDATE;`,
      [verifiedEmail]
    );

    const existingUser = existingRes.rows[0] || null;

    if (existingUser) {
      if (existingUser.is_active === false) {
        const err = new Error("Account has been deactivated or suspended. Please contact customer support.");
        err.code = "ACCOUNT_SUSPENDED";
        err.statusCode = 403;
        throw err;
      }

      const roleRes = await client.query(
        `SELECT role_id FROM user_roles WHERE user_id = $1;`,
        [existingUser.id]
      );
      const userRoles = roleRes.rows.map((r) => r.role_id);
      if (userRoles.some((r) => VALID_ADMIN_ROLES.includes(r))) {
        const err = new Error("Studio administrator accounts must sign in through the Studio Admin Portal.");
        err.code = "ADMIN_PORTAL_REQUIRED";
        err.statusCode = 403;
        throw err;
      }
    }

    // 4. Email ownership is cryptographically verified -> issue Firebase custom token
    const { uid: canonicalUid, customToken } = await issueEmailVerifiedCustomToken(
      verifiedEmail,
      existingUser ? existingUser.firebase_uid : null
    );

    // 5. Bind or create PostgreSQL user & customer profile
    let pgUser;
    if (existingUser) {
      if (existingUser.firebase_uid && existingUser.firebase_uid !== canonicalUid) {
        const err = new Error("Account conflict: This email address is already bound to another identity.");
        err.code = "ACCOUNT_LINK_CONFLICT";
        err.statusCode = 409;
        throw err;
      }

      const updateRes = await client.query(
        `UPDATE users
         SET firebase_uid = COALESCE(firebase_uid, $1),
             email = $2,
             email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, firebase_uid, phone, email, email_verified_at, is_active, created_at, updated_at;`,
        [canonicalUid, verifiedEmail, existingUser.id]
      );
      pgUser = updateRes.rows[0];
    } else {
      // Check whether canonicalUid already exists (e.g. customer previously used Phone OTP with this Firebase UID)
      const uidRes = await client.query(
        `SELECT id, firebase_uid, phone, email, is_active FROM users WHERE firebase_uid = $1 FOR UPDATE;`,
        [canonicalUid]
      );

      if (uidRes.rows.length > 0) {
        const byUid = uidRes.rows[0];
        if (byUid.email && byUid.email.toLowerCase() !== verifiedEmail) {
          const err = new Error("Account conflict: Existing Firebase identity is already linked to a different email.");
          err.code = "ACCOUNT_LINK_CONFLICT";
          err.statusCode = 409;
          throw err;
        }
        const updateByUid = await client.query(
          `UPDATE users
           SET email = $1,
               email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2
           RETURNING id, firebase_uid, phone, email, email_verified_at, is_active, created_at, updated_at;`,
          [verifiedEmail, byUid.id]
        );
        pgUser = updateByUid.rows[0];
      } else {
        const insertUser = await client.query(
          `INSERT INTO users (firebase_uid, email, email_verified_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           RETURNING id, firebase_uid, phone, email, email_verified_at, is_active, created_at, updated_at;`,
          [canonicalUid, verifiedEmail]
        );
        pgUser = insertUser.rows[0];
      }
    }

    await client.query(
      `INSERT INTO customer_profiles (user_id, full_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING;`,
      [pgUser.id, "Customer"]
    );

    // 6. Safely link unowned historical guest orders & bookings ONLY after verified email ownership
    const linkedOrdersRes = await client.query(
      `UPDATE orders
       SET user_id = $1,
           claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
           claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id IS NULL
         AND LOWER(customer_email) = LOWER($2)
       RETURNING id;`,
      [pgUser.id, verifiedEmail]
    );

    const linkedBookingsRes = await client.query(
      `UPDATE bookings
       SET user_id = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id IS NULL
         AND LOWER(customer_email) = LOWER($2)
       RETURNING id;`,
      [pgUser.id, verifiedEmail]
    );

    const linkedOrdersCount = linkedOrdersRes.rowCount || 0;
    const linkedBookingsCount = linkedBookingsRes.rowCount || 0;

    // 7. Record security audit log (strictly without raw tokens or secrets)
    await client.query(
      `INSERT INTO audit_logs (
         actor_id,
         actor_role,
         action,
         target_entity,
         target_id,
         diff,
         ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        pgUser.id,
        "customer",
        "CUSTOMER_EMAIL_LOGIN_VERIFIED",
        "users",
        pgUser.id,
        JSON.stringify({
          linkedOrdersCount,
          linkedBookingsCount,
          tokenId: consumedToken.id,
        }),
        cleanIp,
      ]
    );

    return {
      canonicalUid,
      verifiedEmail,
      customToken,
      linkedOrdersCount,
      linkedBookingsCount,
    };
  });

  // Hydrate full customer profile, roles, and permissions
  const hydratedUser = await findOrCreateUserByFirebaseToken({
    uid: txResult.canonicalUid,
    email: txResult.verifiedEmail,
    email_verified: true,
  });

  return {
    status: "success",
    customToken: txResult.customToken,
    linkedOrdersCount: txResult.linkedOrdersCount,
    linkedBookingsCount: txResult.linkedBookingsCount,
    user: {
      id: hydratedUser.id,
      firebase_uid: hydratedUser.firebase_uid,
      phone: hydratedUser.phone,
      phone_verified_at: hydratedUser.phone_verified_at,
      email: hydratedUser.email,
      email_verified_at: hydratedUser.email_verified_at,
      is_active: hydratedUser.is_active,
      roles: hydratedUser.roles,
      permissions: hydratedUser.permissions,
      profile: hydratedUser.profile,
      created_at: hydratedUser.created_at,
      updated_at: hydratedUser.updated_at,
    },
  };
}

module.exports = {
  requestMagicLink,
  verifyMagicLink,
  hashLoginToken,
  resolveSafeFrontendBaseUrl,
  buildMagicLinkEmail,
  setTestEmailSender,
  clearTestEmailSender,
  GENERIC_REQUEST_MESSAGE,
};
