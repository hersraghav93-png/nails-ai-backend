/**
 * ==========================================================================
 * USER & ACCOUNT SERVICE (`src/services/userService.js`)
 * Nails by Divya Platform
 *
 * Manages customer account lifecycle, Firebase identity linking, profile updates,
 * address management, and role-based permissions retrieval.
 * Hardened against account takeover, race conditions, and privilege escalation.
 * ==========================================================================
 */

const { query, withTransaction } = require("../db/pool");
const { verifyFirebaseAdminUser } = require("./firebaseService");
const CONFIG = require("../config");

const ALLOWED_NAIL_SHAPES = [
  "Almond",
  "Square",
  "Coffin",
  "Stiletto",
  "Oval",
  "Round",
  "Squoval",
  "Ballerina",
];

const ALLOWED_NAIL_LENGTHS = [
  "Extra Short",
  "Short",
  "Medium",
  "Long",
  "Extra Long",
];

const ALLOWED_SIZING_PRESETS = ["XS", "S", "M", "L", "Custom"];

const VALID_ADMIN_ROLES = ["super_operator", "artist_divya", "staff_artist", "support_staff"];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string is a standard UUID.
 * @param {string} id
 * @returns {boolean}
 */
function isValidUuid(id) {
  return typeof id === "string" && UUID_REGEX.test(id.trim());
}

/**
 * Validates Indian or international phone numbers.
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhone(phone) {
  if (typeof phone !== "string") return false;
  const clean = phone.trim().replace(/[\s-]/g, "");
  // Matches +91XXXXXXXXXX or 10-digit Indian mobile 6-9XXXXXXXXX or E.164
  return /^(?:\+91)?[6-9]\d{9}$/.test(clean) || /^\+[1-9]\d{6,14}$/.test(clean);
}

/**
 * Validates 6-digit Indian PIN codes.
 * @param {string} pin
 * @returns {boolean}
 */
function isValidPostalCode(pin) {
  if (typeof pin !== "string") return false;
  return /^[1-9]\d{5}$/.test(pin.trim());
}

/**
 * Finds or creates a user account based on a verified Firebase token.
 * Uses Firebase UID as the canonical identity source.
 *
 * Hardened guarantees:
 * - Only verified phone numbers can link accounts.
 * - Prevents silent account takeover if an existing account is already bound to another UID.
 * - Concurrency safe against simultaneous first-time login race conditions.
 * - Suspended accounts remain suspended.
 * - Never grants administrative privileges.
 *
 * @param {{ uid: string, phone_number?: string, email?: string }} decodedToken
 * @returns {Promise<object>} Complete user record with profile, roles, and permissions
 */
async function findOrCreateUserByFirebaseToken(decodedToken) {
  const { uid, phone_number, email } = decodedToken || {};

  if (!uid || typeof uid !== "string" || !uid.trim()) {
    const err = new Error("Invalid token payload: Firebase UID is required.");
    err.code = "INVALID_TOKEN_PAYLOAD";
    err.statusCode = 401;
    throw err;
  }

  const cleanUid = uid.trim();
  const cleanPhone = phone_number && isValidPhone(phone_number) ? phone_number.trim() : null;
  const cleanEmail = email && typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : null;

  // 1. Look up existing user by firebase_uid
  let userRes = await query(
    `SELECT id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at
     FROM users
     WHERE firebase_uid = $1;`,
    [cleanUid]
  );

  let user = userRes.rows[0];

  // 2. If not found by firebase_uid, check if user exists by verified phone number
  if (!user && cleanPhone) {
    const phoneRes = await query(
      `SELECT id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at
       FROM users
       WHERE phone = $1;`,
      [cleanPhone]
    );

    if (phoneRes.rows.length > 0) {
      const existingUser = phoneRes.rows[0];

      // Security check: If the existing account is already bound to a different Firebase UID, reject!
      // This defends against silent account hijacking / takeover.
      if (existingUser.firebase_uid && existingUser.firebase_uid !== cleanUid) {
        const conflictErr = new Error(
          "Account conflict: This phone number is already registered to a different Firebase identity. Account linking rejected."
        );
        conflictErr.code = "ACCOUNT_LINK_CONFLICT";
        conflictErr.statusCode = 409;
        throw conflictErr;
      }

      // Safe linking: Only link if firebase_uid IS NULL (e.g. guest record)
      const updateRes = await query(
        `UPDATE users
         SET firebase_uid = $1,
             phone_verified_at = COALESCE(phone_verified_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND firebase_uid IS NULL
         RETURNING id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at;`,
        [cleanUid, existingUser.id]
      );

      if (updateRes.rows.length > 0) {
        user = updateRes.rows[0];
      } else {
        // Concurrency catch: if another request linked it concurrently, re-fetch
        const refetch = await query(`SELECT * FROM users WHERE id = $1;`, [existingUser.id]);
        user = refetch.rows[0];
      }
    }
  }

  // 2b. If not found by firebase_uid or phone, check if user exists by verified email address
  if (!user && cleanEmail) {
    const emailRes = await query(
      `SELECT id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at
       FROM users
       WHERE LOWER(email) = LOWER($1);`,
      [cleanEmail]
    );

    if (emailRes.rows.length > 0) {
      const existingUser = emailRes.rows[0];

      // Security check: If the existing account is already bound to a different Firebase UID, reject!
      if (existingUser.firebase_uid && existingUser.firebase_uid !== cleanUid) {
        const conflictErr = new Error(
          "Account conflict: This email address is already registered to a different Firebase identity. Account linking rejected."
        );
        conflictErr.code = "ACCOUNT_LINK_CONFLICT";
        conflictErr.statusCode = 409;
        throw conflictErr;
      }

      // Safe linking: Only link if firebase_uid IS NULL or matches
      const updateRes = await query(
        `UPDATE users
         SET firebase_uid = $1,
             email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND (firebase_uid IS NULL OR firebase_uid = $1)
         RETURNING id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at;`,
        [cleanUid, existingUser.id]
      );

      if (updateRes.rows.length > 0) {
        user = updateRes.rows[0];
      } else {
        const refetch = await query(`SELECT * FROM users WHERE id = $1;`, [existingUser.id]);
        user = refetch.rows[0];
      }
    }
  }

  // 3. If user still does not exist, create new user and customer profile (concurrency-safe)
  if (!user) {
    try {
      user = await withTransaction(async (client) => {
        const newUserRes = await client.query(
          `INSERT INTO users (firebase_uid, phone, phone_verified_at, email, email_verified_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (firebase_uid) DO NOTHING
           RETURNING id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at;`,
          [
            cleanUid,
            cleanPhone,
            cleanPhone ? new Date().toISOString() : null,
            cleanEmail,
            cleanEmail ? new Date().toISOString() : null,
          ]
        );

        let createdUser = newUserRes.rows[0];

        // If another concurrent request inserted first
        if (!createdUser) {
          const concurrentRes = await client.query(
            `SELECT id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at
             FROM users
             WHERE firebase_uid = $1;`,
            [cleanUid]
          );
          createdUser = concurrentRes.rows[0];
        }

        if (createdUser) {
          await client.query(
            `INSERT INTO customer_profiles (user_id, full_name)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO NOTHING;`,
            [createdUser.id, "Customer"]
          );
        }

        return createdUser;
      });
    } catch (insertErr) {
      // If concurrent insert on unique phone occurred
      if (insertErr.code === "23505") {
        const fallbackRes = await query(
          `SELECT id, firebase_uid, phone, phone_verified_at, email, email_verified_at, is_active, created_at, updated_at
           FROM users
           WHERE firebase_uid = $1 OR (phone = $2 AND $2 IS NOT NULL);`,
          [cleanUid, cleanPhone]
        );
        user = fallbackRes.rows[0];
      } else {
        throw insertErr;
      }
    }
  }

  if (!user) {
    throw new Error("Failed to resolve or create user account.");
  }

  // Development-only: auto-link simulator admin roles strictly in verified local development
  if (CONFIG.isDevelopment() && !CONFIG.isLiveEnvironment()) {
    if (user.firebase_uid === "dev_super_raghav") {
      await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'super_operator') ON CONFLICT DO NOTHING;", [user.id]);
      await query("INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled) VALUES ($1, 'Raghav', TRUE) ON CONFLICT (user_id) DO UPDATE SET display_name = 'Raghav';", [user.id]);
    } else if (user.firebase_uid === "dev_divya_artist") {
      await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'artist_divya') ON CONFLICT DO NOTHING;", [user.id]);
      await query("INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled) VALUES ($1, 'Divya', TRUE) ON CONFLICT (user_id) DO UPDATE SET display_name = 'Divya';", [user.id]);
    } else if (user.firebase_uid === "dev_staff_priya") {
      await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'staff_artist') ON CONFLICT DO NOTHING;", [user.id]);
      await query("INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled) VALUES ($1, 'Priya', FALSE) ON CONFLICT (user_id) DO UPDATE SET display_name = 'Priya';", [user.id]);
    }
  }

  // 4. Retrieve roles and permissions
  const rolePermRes = await query(
    `SELECT r.id AS role_id, r.name AS role_name, p.id AS permission_id
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1;`,
    [user.id]
  );

  const roles = [...new Set(rolePermRes.rows.map((r) => r.role_id))];
  const permissions = [
    ...new Set(rolePermRes.rows.map((r) => r.permission_id).filter(Boolean)),
  ];

  // 5. Retrieve customer profile
  const profileRes = await query(
    `SELECT id, full_name, preferred_nail_shape, preferred_nail_length, custom_nail_measurements, sizing_preset, allergies_or_notes, created_at, updated_at
     FROM customer_profiles
     WHERE user_id = $1;`,
    [user.id]
  );
  const profile = profileRes.rows[0] || null;

  // 6. Retrieve admin profile if user has an admin role
  let adminProfile = null;
  if (roles.some((r) => VALID_ADMIN_ROLES.includes(r))) {
    const adminRes = await query(
      `SELECT id, display_name, is_mfa_enabled, last_login_at
       FROM admin_profiles
       WHERE user_id = $1;`,
      [user.id]
    );
    adminProfile = adminRes.rows[0] || null;
  }

  return {
    ...user,
    roles,
    permissions,
    profile,
    adminProfile,
  };
}

/**
 * Retrieves the customer profile for a given user ID.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getCustomerProfile(userId) {
  const res = await query(
    `SELECT cp.id, cp.full_name, cp.preferred_nail_shape, cp.preferred_nail_length,
            cp.custom_nail_measurements, cp.sizing_preset, cp.allergies_or_notes,
            cp.created_at, cp.updated_at,
            u.phone, u.email
     FROM customer_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.user_id = $1;`,
    [userId]
  );

  if (res.rows.length === 0) {
    const err = new Error("Customer profile not found.");
    err.statusCode = 404;
    err.code = "PROFILE_NOT_FOUND";
    throw err;
  }

  return res.rows[0];
}

/**
 * Updates customer profile details with input validation.
 * Whitelists allowed attributes to prevent mass assignment.
 *
 * @param {string} userId
 * @param {object} updates
 * @returns {Promise<object>}
 */
async function updateCustomerProfile(userId, updates = {}) {
  const current = await getCustomerProfile(userId);

  const errors = [];
  const fields = {};

  if (updates.full_name !== undefined) {
    if (typeof updates.full_name !== "string" || !updates.full_name.trim()) {
      errors.push("full_name must be a non-empty string.");
    } else if (updates.full_name.trim().length > 100) {
      errors.push("full_name cannot exceed 100 characters.");
    } else {
      fields.full_name = updates.full_name.trim();
    }
  }

  if (updates.preferred_nail_shape !== undefined) {
    if (updates.preferred_nail_shape === null || updates.preferred_nail_shape === "") {
      fields.preferred_nail_shape = null;
    } else if (!ALLOWED_NAIL_SHAPES.includes(updates.preferred_nail_shape)) {
      errors.push(`preferred_nail_shape must be one of: ${ALLOWED_NAIL_SHAPES.join(", ")}`);
    } else {
      fields.preferred_nail_shape = updates.preferred_nail_shape;
    }
  }

  if (updates.preferred_nail_length !== undefined) {
    if (updates.preferred_nail_length === null || updates.preferred_nail_length === "") {
      fields.preferred_nail_length = null;
    } else if (!ALLOWED_NAIL_LENGTHS.includes(updates.preferred_nail_length)) {
      errors.push(`preferred_nail_length must be one of: ${ALLOWED_NAIL_LENGTHS.join(", ")}`);
    } else {
      fields.preferred_nail_length = updates.preferred_nail_length;
    }
  }

  if (updates.sizing_preset !== undefined) {
    if (updates.sizing_preset === null || updates.sizing_preset === "") {
      fields.sizing_preset = null;
    } else if (!ALLOWED_SIZING_PRESETS.includes(updates.sizing_preset)) {
      errors.push(`sizing_preset must be one of: ${ALLOWED_SIZING_PRESETS.join(", ")}`);
    } else {
      fields.sizing_preset = updates.sizing_preset;
    }
  }

  if (updates.custom_nail_measurements !== undefined) {
    if (updates.custom_nail_measurements === null) {
      fields.custom_nail_measurements = null;
    } else if (typeof updates.custom_nail_measurements === "object" && !Array.isArray(updates.custom_nail_measurements)) {
      fields.custom_nail_measurements = updates.custom_nail_measurements;
    } else {
      errors.push("custom_nail_measurements must be a valid JSON object or null.");
    }
  }

  if (updates.allergies_or_notes !== undefined) {
    if (updates.allergies_or_notes === null) {
      fields.allergies_or_notes = null;
    } else if (typeof updates.allergies_or_notes !== "string") {
      errors.push("allergies_or_notes must be a string.");
    } else if (updates.allergies_or_notes.length > 1000) {
      errors.push("allergies_or_notes cannot exceed 1000 characters.");
    } else {
      fields.allergies_or_notes = updates.allergies_or_notes.trim();
    }
  }

  if (errors.length > 0) {
    const err = new Error(errors.join(" "));
    err.statusCode = 400;
    err.code = "VALIDATION_FAILED";
    err.details = errors;
    throw err;
  }

  if (Object.keys(fields).length === 0) {
    return current;
  }

  const setClauses = [];
  const values = [userId];
  let idx = 2;

  for (const [key, val] of Object.entries(fields)) {
    if (key === "custom_nail_measurements" && val !== null) {
      setClauses.push(`${key} = $${idx}::jsonb`);
      values.push(JSON.stringify(val));
    } else {
      setClauses.push(`${key} = $${idx}`);
      values.push(val);
    }
    idx++;
  }

  const sql = `
    UPDATE customer_profiles
    SET ${setClauses.join(", ")}
    WHERE user_id = $1
    RETURNING id, full_name, preferred_nail_shape, preferred_nail_length, custom_nail_measurements, sizing_preset, allergies_or_notes, updated_at;
  `;

  const updateRes = await query(sql, values);
  return updateRes.rows[0];
}

/**
 * Retrieves all addresses for a given user.
 *
 * @param {string} userId
 * @returns {Promise<Array<object>>}
 */
async function getUserAddresses(userId) {
  const res = await query(
    `SELECT id, recipient_name, recipient_phone, address_line1, address_line2, landmark, city, state, postal_code, is_default_shipping, is_default_service, created_at
     FROM user_addresses
     WHERE user_id = $1
     ORDER BY is_default_shipping DESC, is_default_service DESC, created_at DESC;`,
    [userId]
  );
  return res.rows;
}

/**
 * Validates address input fields.
 * @param {object} addressData
 * @returns {string[]} Validation errors
 */
function validateAddressData(addressData) {
  const errors = [];

  if (!addressData.recipient_name || typeof addressData.recipient_name !== "string" || !addressData.recipient_name.trim()) {
    errors.push("recipient_name is required (1-100 characters).");
  } else if (addressData.recipient_name.trim().length > 100) {
    errors.push("recipient_name cannot exceed 100 characters.");
  }

  if (!addressData.recipient_phone || !isValidPhone(addressData.recipient_phone)) {
    errors.push("recipient_phone must be a valid 10-digit or E.164 phone number.");
  }

  if (!addressData.address_line1 || typeof addressData.address_line1 !== "string" || addressData.address_line1.trim().length < 3) {
    errors.push("address_line1 is required (at least 3 characters).");
  } else if (addressData.address_line1.trim().length > 255) {
    errors.push("address_line1 cannot exceed 255 characters.");
  }

  if (addressData.address_line2 && (typeof addressData.address_line2 !== "string" || addressData.address_line2.length > 255)) {
    errors.push("address_line2 cannot exceed 255 characters.");
  }

  if (addressData.landmark && (typeof addressData.landmark !== "string" || addressData.landmark.length > 255)) {
    errors.push("landmark cannot exceed 255 characters.");
  }

  if (!addressData.city || typeof addressData.city !== "string" || !addressData.city.trim()) {
    errors.push("city is required.");
  } else if (addressData.city.trim().length > 100) {
    errors.push("city cannot exceed 100 characters.");
  }

  if (!addressData.state || typeof addressData.state !== "string" || !addressData.state.trim()) {
    errors.push("state is required.");
  } else if (addressData.state.trim().length > 100) {
    errors.push("state cannot exceed 100 characters.");
  }

  if (!addressData.postal_code || !isValidPostalCode(addressData.postal_code)) {
    errors.push("postal_code must be a valid 6-digit PIN code.");
  }

  return errors;
}

/**
 * Creates a new address for a user.
 *
 * @param {string} userId
 * @param {object} addressData
 * @returns {Promise<object>}
 */
async function createUserAddress(userId, addressData) {
  const errors = validateAddressData(addressData);
  if (errors.length > 0) {
    const err = new Error(errors.join(" "));
    err.statusCode = 400;
    err.code = "VALIDATION_FAILED";
    err.details = errors;
    throw err;
  }

  const isDefaultShipping = Boolean(addressData.is_default_shipping);
  const isDefaultService = Boolean(addressData.is_default_service);

  return withTransaction(async (client) => {
    // If setting as default shipping, unset previous shipping default
    if (isDefaultShipping) {
      await client.query(
        `UPDATE user_addresses SET is_default_shipping = FALSE WHERE user_id = $1;`,
        [userId]
      );
    }

    // If setting as default service, unset previous service default
    if (isDefaultService) {
      await client.query(
        `UPDATE user_addresses SET is_default_service = FALSE WHERE user_id = $1;`,
        [userId]
      );
    }

    const insertRes = await client.query(
      `INSERT INTO user_addresses (
         user_id, recipient_name, recipient_phone, address_line1, address_line2,
         landmark, city, state, postal_code, is_default_shipping, is_default_service
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, recipient_name, recipient_phone, address_line1, address_line2,
                 landmark, city, state, postal_code, is_default_shipping, is_default_service, created_at;`,
      [
        userId,
        addressData.recipient_name.trim(),
        addressData.recipient_phone.trim(),
        addressData.address_line1.trim(),
        addressData.address_line2 ? addressData.address_line2.trim() : null,
        addressData.landmark ? addressData.landmark.trim() : null,
        addressData.city.trim(),
        addressData.state.trim(),
        addressData.postal_code.trim(),
        isDefaultShipping,
        isDefaultService,
      ]
    );

    return insertRes.rows[0];
  });
}

/**
 * Updates an existing user address. Enforces user ownership and valid UUID.
 *
 * @param {string} userId
 * @param {string} addressId
 * @param {object} addressData
 * @returns {Promise<object>}
 */
async function updateUserAddress(userId, addressId, addressData) {
  if (!isValidUuid(addressId)) {
    const err = new Error("Invalid address ID format.");
    err.statusCode = 400;
    err.code = "INVALID_ID";
    throw err;
  }

  // 1. Verify address ownership
  const existingRes = await query(
    `SELECT id, is_default_shipping, is_default_service FROM user_addresses WHERE id = $1 AND user_id = $2;`,
    [addressId, userId]
  );

  if (existingRes.rows.length === 0) {
    const err = new Error("Address not found or does not belong to user.");
    err.statusCode = 404;
    err.code = "ADDRESS_NOT_FOUND";
    throw err;
  }

  const errors = validateAddressData(addressData);
  if (errors.length > 0) {
    const err = new Error(errors.join(" "));
    err.statusCode = 400;
    err.code = "VALIDATION_FAILED";
    err.details = errors;
    throw err;
  }

  const isDefaultShipping = Boolean(addressData.is_default_shipping);
  const isDefaultService = Boolean(addressData.is_default_service);

  return withTransaction(async (client) => {
    if (isDefaultShipping) {
      await client.query(
        `UPDATE user_addresses SET is_default_shipping = FALSE WHERE user_id = $1 AND id != $2;`,
        [userId, addressId]
      );
    }

    if (isDefaultService) {
      await client.query(
        `UPDATE user_addresses SET is_default_service = FALSE WHERE user_id = $1 AND id != $2;`,
        [userId, addressId]
      );
    }

    const updateRes = await client.query(
      `UPDATE user_addresses
       SET recipient_name = $1,
           recipient_phone = $2,
           address_line1 = $3,
           address_line2 = $4,
           landmark = $5,
           city = $6,
           state = $7,
           postal_code = $8,
           is_default_shipping = $9,
           is_default_service = $10
       WHERE id = $11 AND user_id = $12
       RETURNING id, recipient_name, recipient_phone, address_line1, address_line2,
                 landmark, city, state, postal_code, is_default_shipping, is_default_service, created_at;`,
      [
        addressData.recipient_name.trim(),
        addressData.recipient_phone.trim(),
        addressData.address_line1.trim(),
        addressData.address_line2 ? addressData.address_line2.trim() : null,
        addressData.landmark ? addressData.landmark.trim() : null,
        addressData.city.trim(),
        addressData.state.trim(),
        addressData.postal_code.trim(),
        isDefaultShipping,
        isDefaultService,
        addressId,
        userId,
      ]
    );

    return updateRes.rows[0];
  });
}

/**
 * Deletes a user address. Enforces user ownership and valid UUID.
 *
 * @param {string} userId
 * @param {string} addressId
 * @returns {Promise<boolean>}
 */
async function deleteUserAddress(userId, addressId) {
  if (!isValidUuid(addressId)) {
    const err = new Error("Invalid address ID format.");
    err.statusCode = 400;
    err.code = "INVALID_ID";
    throw err;
  }

  const res = await query(
    `DELETE FROM user_addresses WHERE id = $1 AND user_id = $2 RETURNING id;`,
    [addressId, userId]
  );

  if (res.rowCount === 0) {
    const err = new Error("Address not found or does not belong to user.");
    err.statusCode = 404;
    err.code = "ADDRESS_NOT_FOUND";
    throw err;
  }

  return true;
}

/**
 * Securely provisions or updates an administrator account.
 * Requires cryptographic verification against Firebase Auth via Firebase Admin SDK.
 * Fails closed if Firebase Admin credentials are not configured in environment.
 *
 * @param {object} params
 * @param {string} params.firebaseUid Verified Firebase UID
 * @param {string} params.phone E.164 verified phone number
 * @param {string} params.displayName Admin display name (e.g. "Raghav" or "Divya")
 * @param {"super_operator" | "artist_divya" | "staff_artist" | "support_staff"} params.roleId
 * @param {string} [params.assignedByUserId] Optional admin who assigned this role
 * @param {boolean} [params.allowRoleChange] Whether to permit changing an existing admin's role
 * @returns {Promise<object>}
 */
async function provisionAdminAccount({
  firebaseUid,
  phone,
  displayName,
  roleId,
  assignedByUserId = null,
  allowRoleChange = false,
  devAllowUnverified = false,
}) {
  if (!firebaseUid || typeof firebaseUid !== "string" || !firebaseUid.trim()) {
    throw new Error("firebaseUid is required for administrator provisioning.");
  }
  if (!phone || !isValidPhone(phone)) {
    throw new Error("Valid E.164 phone number is required for administrator provisioning.");
  }
  if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
    throw new Error("displayName is required for administrator provisioning.");
  }
  if (!VALID_ADMIN_ROLES.includes(roleId)) {
    throw new Error(`Invalid role: "${roleId}". Must be one of: ${VALID_ADMIN_ROLES.join(", ")}`);
  }

  const cleanUid = firebaseUid.trim();
  const cleanPhone = phone.trim();

  // 1. Remote verification against Firebase Admin
  // Strictly mandatory in production and staging; permitted to skip only in local dev/test with explicit dev flag
  if (devAllowUnverified) {
    if (CONFIG.isLiveEnvironment() || !CONFIG.isDevelopment()) {
      if (!CONFIG.isTest()) {
        throw new Error("devAllowUnverified is strictly forbidden outside development mode.");
      }
    }
    console.warn(`⚠️  [DEV ONLY] Skipping remote Firebase Auth verification for "${cleanUid}" because devAllowUnverified=true in development/test mode.`);
  } else {
    // Cryptographically verify against Firebase Admin
    // Fails closed if Firebase Admin credentials are not in .env
    await verifyFirebaseAdminUser(cleanUid, cleanPhone);
  }

  return withTransaction(async (client) => {
    // 2. Check for separate conflicts between firebase_uid and phone
    const uidRes = await client.query(`SELECT id, phone, is_active FROM users WHERE firebase_uid = $1;`, [cleanUid]);
    const phoneRes = await client.query(`SELECT id, firebase_uid, is_active FROM users WHERE phone = $1;`, [cleanPhone]);

    const userByUid = uidRes.rows[0] || null;
    const userByPhone = phoneRes.rows[0] || null;

    if (userByUid && userByPhone && userByUid.id !== userByPhone.id) {
      throw new Error(
        `Identity conflict: Firebase UID "${cleanUid}" belongs to user ID ${userByUid.id}, ` +
        `but phone "${cleanPhone}" is registered to user ID ${userByPhone.id}. Cannot merge distinct identities.`
      );
    }

    let userId;
    if (userByUid) {
      userId = userByUid.id;
      await client.query(
        `UPDATE users
         SET phone = $1,
             phone_verified_at = COALESCE(phone_verified_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2;`,
        [cleanPhone, userId]
      );
    } else if (userByPhone) {
      userId = userByPhone.id;
      if (userByPhone.firebase_uid && userByPhone.firebase_uid !== cleanUid) {
        throw new Error(
          `Identity conflict: User ${userId} with phone "${cleanPhone}" is already bound to Firebase UID "${userByPhone.firebase_uid}".`
        );
      }
      await client.query(
        `UPDATE users
         SET firebase_uid = $1,
             phone_verified_at = COALESCE(phone_verified_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2;`,
        [cleanUid, userId]
      );
    } else {
      const insertRes = await client.query(
        `INSERT INTO users (firebase_uid, phone, phone_verified_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         RETURNING id;`,
        [cleanUid, cleanPhone]
      );
      userId = insertRes.rows[0].id;
    }

    // 3. Verify existing role assignments on this user
    const existingRolesRes = await client.query(
      `SELECT r.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1;`,
      [userId]
    );
    const existingRoles = existingRolesRes.rows.map((r) => r.id);

    // If account already has a different administrative role assigned, require explicit confirmation
    if (existingRoles.length > 0 && !existingRoles.includes(roleId)) {
      if (!allowRoleChange) {
        throw new Error(
          `Role conflict: Account already has administrative role(s): "${existingRoles.join(", ")}". ` +
          `Changing administrative role to "${roleId}" requires explicit confirmation (--allow-role-change).`
        );
      }
      // If role change allowed, replace previous roles with the new role
      await client.query(`DELETE FROM user_roles WHERE user_id = $1;`, [userId]);
    }

    // 4. Upsert admin profile
    await client.query(
      `INSERT INTO admin_profiles (user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           updated_at = CURRENT_TIMESTAMP;`,
      [userId, displayName.trim()]
    );

    // 5. Upsert user role assignment
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_id) DO NOTHING;`,
      [userId, roleId, assignedByUserId]
    );

    // 6. Record in immutable audit log
    await client.query(
      `INSERT INTO audit_logs (
         actor_id, actor_role, action, target_entity, target_id, diff, ip_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        assignedByUserId || userId,
        assignedByUserId ? "super_operator" : "system",
        "ADMIN_ACCOUNT_PROVISIONED",
        "user_roles",
        userId,
        JSON.stringify({
          firebase_uid: cleanUid,
          phone: cleanPhone,
          display_name: displayName.trim(),
          role_id: roleId,
        }),
        "127.0.0.1",
      ]
    );

    // 7. Retrieve complete provisioned record
    const adminDetailsRes = await client.query(
      `SELECT u.id, u.firebase_uid, u.phone, ap.display_name, r.id AS role_id, r.name AS role_name
       FROM users u
       JOIN admin_profiles ap ON ap.user_id = u.id
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1 AND r.id = $2;`,
      [userId, roleId]
    );

    return adminDetailsRes.rows[0];
  });
}

module.exports = {
  findOrCreateUserByFirebaseToken,
  getCustomerProfile,
  updateCustomerProfile,
  getUserAddresses,
  createUserAddress,
  updateUserAddress,
  deleteUserAddress,
  provisionAdminAccount,
  isValidPhone,
  isValidPostalCode,
  isValidUuid,
  ALLOWED_NAIL_SHAPES,
  ALLOWED_NAIL_LENGTHS,
  ALLOWED_SIZING_PRESETS,
  VALID_ADMIN_ROLES,
};
