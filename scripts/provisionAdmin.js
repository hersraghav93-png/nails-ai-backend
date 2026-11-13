#!/usr/bin/env node
/**
 * ==========================================================================
 * SECURE ADMINISTRATOR PROVISIONING SCRIPT (`scripts/provisionAdmin.js`)
 * Nails by Divya Platform
 *
 * Provisions or updates administrative accounts with verified Firebase UID,
 * phone number, display name, and role.
 *
 * CLI Usage:
 *   node scripts/provisionAdmin.js --uid <firebase_uid> --phone <e164_phone> --name <display_name> --role <role_id>
 *
 * Examples:
 *   node scripts/provisionAdmin.js --uid fb_super_user_123 --phone +919811000001 --name "Raghav" --role super_operator
 *   node scripts/provisionAdmin.js --uid fb_divya_artist_456 --phone +919811000002 --name "Divya" --role artist_divya
 * ==========================================================================
 */

const { provisionAdminAccount, VALID_ADMIN_ROLES } = require("../src/services/userService");
const { closePool } = require("../src/db/pool");
const CONFIG = require("../src/config");

function printUsage() {
  console.log(`
Nails by Divya — Secure Administrator Provisioning Tool
-------------------------------------------------------
Usage:
  node scripts/provisionAdmin.js --uid <firebase_uid> --phone <e164_phone> --name <display_name> --role <role_id>

Options:
  --uid               Firebase UID of the administrator (required)
  --phone             Verified phone number with country code, e.g. +9198XXXXXXXX (required)
  --name              Display name of the administrator, e.g. "Raghav" or "Divya" (required)
  --role              Administrative role: ${VALID_ADMIN_ROLES.join(", ")} (required)
  --allow-role-change Explicitly permit changing an existing admin's role
  --dev-unverified    [DEV ONLY] Permit provisioning without live Firebase check (strictly blocked in production)
  --help              Show this guidance

Available Roles:
  • super_operator : Full system control and all 15 operational permissions
  • artist_divya   : Lead Nail Artist authority (catalog, orders, bookings, quotes, discounts)
  • staff_artist   : Assistant artist order fulfillment and booking assistance
  • support_staff  : Customer support order status and communication
  `);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--uid" && args[i + 1]) {
      parsed.uid = args[++i];
    } else if (arg === "--phone" && args[i + 1]) {
      parsed.phone = args[++i];
    } else if (arg === "--name" && args[i + 1]) {
      parsed.name = args[++i];
    } else if (arg === "--role" && args[i + 1]) {
      parsed.role = args[++i];
    } else if (arg === "--allow-role-change") {
      parsed.allowRoleChange = true;
    } else if (arg === "--dev-unverified") {
      parsed.devUnverified = true;
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.uid && !args.phone && !args.name && !args.role)) {
    printUsage();
    process.exit(0);
  }

  if (!args.uid || !args.phone || !args.name || !args.role) {
    console.error("❌ Error: Missing required arguments.\n");
    printUsage();
    process.exit(1);
  }

  if (args.devUnverified && (CONFIG.isLiveEnvironment() || !CONFIG.isDevelopment())) {
    console.error("❌ Fatal Security Error: --dev-unverified is strictly forbidden in production and staging environments!\n");
    process.exit(1);
  }

  try {
    console.log(`\n⏳ Provisioning administrator: "${args.name}" (${args.role})...`);
    const admin = await provisionAdminAccount({
      firebaseUid: args.uid,
      phone: args.phone,
      displayName: args.name,
      roleId: args.role,
      allowRoleChange: Boolean(args.allowRoleChange),
      devAllowUnverified: Boolean(args.devUnverified),
    });

    console.log("✅ Administrator successfully provisioned in PostgreSQL!");
    console.log("-------------------------------------------------------");
    console.log(`• User ID      : ${admin.id}`);
    console.log(`• Firebase UID : ${admin.firebase_uid}`);
    console.log(`• Phone        : ${admin.phone}`);
    console.log(`• Display Name : ${admin.display_name}`);
    console.log(`• Assigned Role: ${admin.role_name} (${admin.role_id})`);
    console.log("-------------------------------------------------------\n");
  } catch (err) {
    console.error(`\n❌ Administrator provisioning failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
