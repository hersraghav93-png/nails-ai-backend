#!/usr/bin/env node
/**
 * ==============================================================================
 * PROVISION OWNER RAGHAV & VERIFY ADMIN PROFILES (`scripts/provisionOwnerRaghav.js`)
 * Nails by Divya Platform — Phase 5.4 Three-Role Account System
 * ==============================================================================
 */

"use strict";

const { query, withTransaction, closePool } = require("../src/db/pool");

async function run() {
  console.log("=== Provisioning Owner Raghav (+917827437985) & Verifying Divya (+918447391310) ===");

  await withTransaction(async (client) => {
    // 1. Provision Raghav (Owner)
    console.log("1. Upserting Owner user record for Raghav (+917827437985)...");
    const userRes = await client.query(
      `INSERT INTO users (id, phone, firebase_uid, phone_verified_at, is_active)
       VALUES ('78274379-8500-4000-8000-000000000001', '+917827437985', NULL, CURRENT_TIMESTAMP, TRUE)
       ON CONFLICT (phone) DO UPDATE
       SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
       RETURNING id, phone, firebase_uid, is_active;`
    );
    const raghavId = userRes.rows[0].id;
    console.log(`   Owner User ID: ${raghavId}`);

    console.log("2. Assigning 'super_operator' role to Raghav...");
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, 'super_operator')
       ON CONFLICT (user_id, role_id) DO NOTHING;`,
      [raghavId]
    );

    console.log("3. Upserting admin profile for Raghav (Display Name: Raghav)...");
    await client.query(
      `INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled)
       VALUES ($1, 'Raghav', TRUE)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = 'Raghav', updated_at = CURRENT_TIMESTAMP;`,
      [raghavId]
    );

    // 2. Ensure Divya's record is clean and has admin profile
    console.log("4. Resetting transient firebase_uid to NULL for Divya (+918447391310)...");
    const divyaRes = await client.query(
      `UPDATE users
       SET firebase_uid = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE phone = '+918447391310'
       RETURNING id, phone, firebase_uid, is_active;`
    );
    if (divyaRes.rows.length > 0) {
      const divyaId = divyaRes.rows[0].id;
      console.log(`   Divya User ID: ${divyaId}`);

      console.log("5. Ensuring Divya has 'artist_divya' role...");
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, 'artist_divya')
         ON CONFLICT (user_id, role_id) DO NOTHING;`,
        [divyaId]
      );

      console.log("6. Upserting admin profile for Divya (Display Name: Divya)...");
      await client.query(
        `INSERT INTO admin_profiles (user_id, display_name, is_mfa_enabled)
         VALUES ($1, 'Divya', TRUE)
         ON CONFLICT (user_id) DO UPDATE
         SET display_name = 'Divya', updated_at = CURRENT_TIMESTAMP;`,
        [divyaId]
      );
    } else {
      console.warn("   ⚠️ Warning: Divya user (+918447391310) not found in database.");
    }
  });

  // Verify resulting records
  console.log("\n--- Verification of Provisioned Administrative Accounts ---");
  const checkRes = await query(
    `SELECT u.id, u.phone, u.firebase_uid, u.is_active, ur.role_id, ap.display_name
     FROM users u
     JOIN user_roles ur ON u.id = ur.user_id
     LEFT JOIN admin_profiles ap ON u.id = ap.user_id
     WHERE u.phone IN ('+917827437985', '+918447391310')
     ORDER BY u.phone ASC;`
  );

  for (const row of checkRes.rows) {
    console.log(`• Phone: ${row.phone} | Role: ${row.role_id} | Name: ${row.display_name} | UID: ${row.firebase_uid || "NULL (Ready for First Phone Login)"} | Active: ${row.is_active}`);
  }

  console.log("\n✅ Provisioning completed successfully!");
}

run()
  .catch((err) => {
    console.error("❌ Error provisioning owner:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
