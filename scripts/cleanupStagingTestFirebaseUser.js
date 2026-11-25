/**
 * ==============================================================================
 * NAILS BY DIVYA — ORPHANED STAGING TEST FIREBASE USER CLEANUP
 *
 * Safely verifies exact UID + email match via Firebase Admin SDK before deleting
 * a temporary synthetic E2E test identity. Never prints credentials.
 *
 * Usage (in an environment with Firebase Admin credentials configured):
 *   node scripts/cleanupStagingTestFirebaseUser.js --uid=<UID> --email=<EMAIL> [--confirm-delete]
 * ==============================================================================
 */

"use strict";

require("dotenv").config();
const CONFIG = require("../src/config");
const { getFirebaseAdminAuth, isFirebaseAdminConfigured } = require("../src/services/firebaseService");

function parseArgs(argv) {
  const args = {};
  for (const part of argv.slice(2)) {
    if (part === "--confirm-delete") {
      args.confirmDelete = true;
    } else if (part.startsWith("--uid=")) {
      args.uid = part.slice("--uid=".length).trim();
    } else if (part.startsWith("--email=")) {
      args.email = part.slice("--email=".length).trim().toLowerCase();
    }
  }
  return args;
}

async function run() {
  const { uid, email, confirmDelete } = parseArgs(process.argv);

  if (!uid || !email) {
    console.error("Usage: node scripts/cleanupStagingTestFirebaseUser.js --uid=<UID> --email=<EMAIL> [--confirm-delete]");
    process.exit(1);
  }

  if (!isFirebaseAdminConfigured()) {
    console.error("❌ Firebase Admin SDK credentials are not configured in this environment.");
    console.error(`   Target project configured: "${CONFIG.firebase.projectId || "none"}"`);
    process.exit(2);
  }

  const auth = getFirebaseAdminAuth();
  if (!auth) {
    console.error("❌ Failed to obtain Firebase Admin Auth client.");
    process.exit(2);
  }

  console.log(`🔍 Looking up UID "${uid}" in Firebase project "${CONFIG.firebase.projectId}"...`);
  let userRecord;
  try {
    userRecord = await auth.getUser(uid);
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      console.log(`✅ UID "${uid}" does not exist in Firebase project "${CONFIG.firebase.projectId}" (already clean).`);
      return;
    }
    throw err;
  }

  const actualEmail = (userRecord.email || "").trim().toLowerCase();
  if (actualEmail !== email) {
    console.error(
      `❌ ABORTING: UID "${uid}" belongs to email "${actualEmail || "none"}", NOT expected synthetic email "${email}".`
    );
    process.exit(3);
  }

  console.log(`✅ Confirmed match: uid="${userRecord.uid}", email="${userRecord.email}", emailVerified=${userRecord.emailVerified}`);

  if (!confirmDelete) {
    console.log("ℹ️  Dry-run complete. Re-run with --confirm-delete to permanently delete this synthetic test user.");
    return;
  }

  await auth.deleteUser(uid);
  console.log(`🗑️  Deleted synthetic Firebase Auth user "${uid}" (${email}) from project "${CONFIG.firebase.projectId}".`);
}

run().catch((err) => {
  console.error("❌ Cleanup error:", err.message);
  process.exit(1);
});
