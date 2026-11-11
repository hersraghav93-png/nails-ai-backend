/**
 * ==========================================================================
 * FIREBASE AUTHENTICATION SERVICE (`src/services/firebaseService.js`)
 * Verifies Firebase ID tokens using the Firebase Admin SDK (v14+ modular).
 * Supports controlled test verifier hooks strictly in test environments.
 * ==========================================================================
 */

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");

let firebaseApp = null;
let testTokenVerifier = null;
let testAdminUserLookup = null;

/**
 * Checks whether the environment is strictly a test runner execution.
 * @returns {boolean}
 */
function isTestEnvironment() {
  return CONFIG.nodeEnv === "test" || process.env.NODE_ENV === "test";
}

/**
 * Initializes the Firebase Admin SDK using environment configuration.
 * Safe to call multiple times (idempotent).
 */
function initFirebase() {
  if (firebaseApp) return firebaseApp;

  const fbConfig = CONFIG.firebase;

  try {
    const existingApps = getApps();
    if (existingApps.length > 0) {
      firebaseApp = existingApps[0];
      return firebaseApp;
    }

    if (fbConfig.serviceAccountPath) {
      const resolvedPath = path.resolve(process.cwd(), fbConfig.serviceAccountPath);
      if (fs.existsSync(resolvedPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
        firebaseApp = initializeApp({
          credential: cert(serviceAccount),
        });
        console.log(`🔥 [Firebase Admin] Initialized with service account file from: ${resolvedPath}`);
        return firebaseApp;
      }
    }

    if (fbConfig.projectId && fbConfig.clientEmail && fbConfig.privateKey) {
      firebaseApp = initializeApp({
        credential: cert({
          projectId: fbConfig.projectId,
          clientEmail: fbConfig.clientEmail,
          privateKey: fbConfig.privateKey,
        }),
      });
      console.log(`🔥 [Firebase Admin] Initialized with environment credentials for project: "${fbConfig.projectId}"`);
      return firebaseApp;
    }

    if (CONFIG.nodeEnv === "production") {
      console.error("🚨 [CRITICAL Firebase Error]: Firebase Admin credentials not configured in production!");
    } else {
      console.warn("⚠️  [Firebase Warning] Firebase Admin credentials not configured. Live token verification will reject tokens until .env is configured.");
    }
  } catch (err) {
    console.error("❌ [Firebase Initialization Error]:", err.message);
  }

  return null;
}

/**
 * Hook for test environments to verify mock tokens deterministically.
 * Strictly forbidden outside test runner environments.
 *
 * @param {(token: string) => Promise<{ uid: string, phone_number?: string, email?: string, [key: string]: any } | null>} verifierFn
 * @param {(uid: string) => Promise<{ uid: string, phoneNumber: string, disabled: boolean } | null>} [adminLookupFn]
 */
function setTestTokenVerifier(verifierFn, adminLookupFn = null) {
  if (!isTestEnvironment()) {
    throw new Error("setTestTokenVerifier is strictly forbidden outside test environments (NODE_ENV must be 'test')!");
  }
  testTokenVerifier = verifierFn;
  testAdminUserLookup = adminLookupFn;
}

/**
 * Clears the test token verifier hook.
 */
function clearTestTokenVerifier() {
  testTokenVerifier = null;
  testAdminUserLookup = null;
}

/**
 * Verifies a Firebase ID token cryptographically.
 * Includes explicit token revocation checking (checkRevoked = true).
 *
 * @param {string} idToken Raw Bearer token from Authorization header
 * @returns {Promise<{ uid: string, phone_number?: string, email?: string, [key: string]: any }>} Decoded token
 */
async function verifyIdToken(idToken) {
  if (!idToken || typeof idToken !== "string" || !idToken.trim()) {
    const err = new Error("Authentication token is missing or empty.");
    err.code = "AUTH_REQUIRED";
    err.statusCode = 401;
    throw err;
  }

  // 1. In test runner environments, check if a controlled test verifier is active
  if (testTokenVerifier && isTestEnvironment()) {
    const verified = await testTokenVerifier(idToken);
    if (!verified) {
      const err = new Error("Invalid or expired authentication token.");
      err.code = "INVALID_TOKEN";
      err.statusCode = 401;
      throw err;
    }
    return verified;
  }

  // 2. Production / Live Firebase verification
  if (!firebaseApp) {
    initFirebase();
  }

  if (!firebaseApp) {
    const err = new Error("Authentication service is not configured. Please contact support.");
    err.code = "AUTH_SERVICE_UNCONFIGURED";
    err.statusCode = 503;
    throw err;
  }

  try {
    const auth = getAuth(firebaseApp);
    // Passing true enables checkRevoked: validates token against Firebase Revocation List
    const decodedToken = await auth.verifyIdToken(idToken, true);
    return decodedToken;
  } catch (fbErr) {
    let message = "Invalid or expired authentication token.";
    let code = "INVALID_TOKEN";

    if (fbErr.code === "auth/id-token-expired") {
      message = "Authentication token has expired. Please sign in again.";
      code = "TOKEN_EXPIRED";
    } else if (fbErr.code === "auth/id-token-revoked") {
      message = "Authentication token has been revoked. Please sign in again.";
      code = "TOKEN_REVOKED";
    } else if (fbErr.code === "auth/argument-error" || fbErr.code === "auth/invalid-id-token") {
      message = "Malformed or invalid authentication token format.";
      code = "INVALID_TOKEN";
    }

    const err = new Error(message);
    err.code = code;
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Cryptographically verifies an administrator user account against Firebase Admin.
 * Verifies that the user exists in Firebase Auth, has a verified phone number matching
 * the expected phone number, and is not disabled.
 *
 * @param {string} uid Firebase UID
 * @param {string} expectedPhone Expected E.164 phone number
 * @returns {Promise<{ uid: string, phoneNumber: string, disabled: boolean }>}
 */
async function verifyFirebaseAdminUser(uid, expectedPhone) {
  if (!uid || typeof uid !== "string" || !uid.trim()) {
    throw new Error("Firebase UID is required for administrator verification.");
  }
  if (!expectedPhone || typeof expectedPhone !== "string" || !expectedPhone.trim()) {
    throw new Error("Expected phone number is required for administrator verification.");
  }

  // 1. In test environment, verify against mock lookup if configured
  if (testAdminUserLookup && isTestEnvironment()) {
    const mockUser = await testAdminUserLookup(uid);
    if (!mockUser) {
      const err = new Error(`Firebase account with UID "${uid}" does not exist.`);
      err.code = "FIREBASE_USER_NOT_FOUND";
      throw err;
    }
    if (mockUser.disabled) {
      const err = new Error(`Firebase account with UID "${uid}" is disabled.`);
      err.code = "FIREBASE_USER_DISABLED";
      throw err;
    }
    if (!mockUser.phoneNumber) {
      const err = new Error(`Firebase account with UID "${uid}" has no verified phone number.`);
      err.code = "FIREBASE_PHONE_NOT_VERIFIED";
      throw err;
    }
    if (mockUser.phoneNumber !== expectedPhone) {
      const err = new Error(
        `Phone number mismatch: Firebase account phone "${mockUser.phoneNumber}" does not match supplied phone "${expectedPhone}".`
      );
      err.code = "FIREBASE_PHONE_MISMATCH";
      throw err;
    }
    return mockUser;
  }

  // 2. Live verification against Firebase Admin
  if (!firebaseApp) {
    initFirebase();
  }

  if (!firebaseApp) {
    const err = new Error(
      "Firebase Admin credentials are not configured in environment (.env). " +
      "Cannot cryptographically verify administrator UID and phone against Firebase Auth. " +
      "Administrator provisioning aborted for safety."
    );
    err.code = "AUTH_SERVICE_UNCONFIGURED";
    err.statusCode = 503;
    throw err;
  }

  try {
    const auth = getAuth(firebaseApp);
    const userRecord = await auth.getUser(uid);

    if (userRecord.disabled) {
      const err = new Error(`Firebase account with UID "${uid}" is disabled.`);
      err.code = "FIREBASE_USER_DISABLED";
      throw err;
    }

    if (!userRecord.phoneNumber) {
      const err = new Error(`Firebase account with UID "${uid}" has no verified phone number.`);
      err.code = "FIREBASE_PHONE_NOT_VERIFIED";
      throw err;
    }

    if (userRecord.phoneNumber !== expectedPhone) {
      const err = new Error(
        `Phone number mismatch: Firebase account phone "${userRecord.phoneNumber}" does not match supplied phone "${expectedPhone}".`
      );
      err.code = "FIREBASE_PHONE_MISMATCH";
      throw err;
    }

    return {
      uid: userRecord.uid,
      phoneNumber: userRecord.phoneNumber,
      disabled: userRecord.disabled,
    };
  } catch (fbErr) {
    if (fbErr.code === "auth/user-not-found") {
      const err = new Error(`Firebase account with UID "${uid}" does not exist.`);
      err.code = "FIREBASE_USER_NOT_FOUND";
      throw err;
    }
    throw fbErr;
  }
}

// Auto-initialize on module load if configured
initFirebase();

module.exports = {
  initFirebase,
  verifyIdToken,
  verifyFirebaseAdminUser,
  setTestTokenVerifier,
  clearTestTokenVerifier,
  isTestEnvironment,
};
