/**
 * ==============================================================================
 * NAILS BY DIVYA — ADMIN DASHBOARD & CMS INTEGRATION TEST SUITE (`testAdminDashboardCMS.js`)
 * Phase 5.1B: Product CMS, Portfolio CMS, Genuine Reviews & Moderation, Media Uploads
 * ==============================================================================
 */

"use strict";

process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const app = require("../index");
const { query } = require("../src/db/pool");
const { setTestTokenVerifier, clearTestTokenVerifier } = require("../src/services/firebaseService");

const TEST_PORT = 64991;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeRequest(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BASE_URL);
    const reqOptions = {
      method: options.method || "GET",
      headers: options.headers || {},
    };

    let bodyData = null;
    if (options.body) {
      if (typeof options.body === "string") {
        bodyData = options.body;
      } else {
        bodyData = JSON.stringify(options.body);
        reqOptions.headers["Content-Type"] = "application/json";
      }
      reqOptions.headers["Content-Length"] = Buffer.byteLength(bodyData);
    }

    const req = http.request(url, reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(data);
        } catch {
          body = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(err);
    throw err;
  }
}

async function cleanupTestArtifacts() {
  try {
    await query("DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');");
    await query("DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');");
    await query("DELETE FROM products WHERE sku LIKE 'TEST-%' OR name LIKE 'Imperial Emerald Velvet%';");
    await query("DELETE FROM customer_reviews WHERE customer_name LIKE '%CMS Test%';");
    await query("DELETE FROM portfolio_designs WHERE name LIKE '%Molten Platinum%';");
  } catch (err) {
    // Non-fatal cleanup
  }
}

async function runAdminDashboardCMSSuite() {
  console.log("\n==================================================================");
  console.log("   NAILS BY DIVYA — PHASE 5.1B ADMIN DASHBOARD & CMS TEST SUITE");
  console.log("==================================================================\n");

  await cleanupTestArtifacts();

  let server;

  try {
    server = app.listen(TEST_PORT);
    await new Promise((r) => server.once("listening", r));

    // Configure test token verifier
    setTestTokenVerifier(async (token) => {
      if (token === "token_divya") {
        return {
          uid: "divya_lead_artist_cms_test",
          phone_number: "+917827437985",
          roles: ["artist_divya"],
        };
      }
      if (token === "token_super") {
        return {
          uid: "super_operator_cms_test",
          phone_number: "+919999900001",
          roles: ["super_operator"],
        };
      }
      if (token === "token_staff") {
        return {
          uid: "staff_artist_cms_test",
          phone_number: "+919888877777",
          roles: ["staff_artist"],
        };
      }
      if (token === "token_customer") {
        return {
          uid: "customer_cms_test",
          phone_number: "+919777766666",
          roles: ["customer"],
        };
      }
      const err = new Error("Invalid test token");
      err.code = "INVALID_TOKEN";
      err.statusCode = 401;
      throw err;
    });

    // Ensure test operators exist with required permissions
    await query(
      `INSERT INTO users (firebase_uid, phone, is_active)
       VALUES ('divya_lead_artist_cms_test', '+917827437985', TRUE)
       ON CONFLICT (phone) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid;`
    );
    const divyaRes = await query(`SELECT id FROM users WHERE phone = '+917827437985';`);
    const divyaId = divyaRes.rows[0].id;
    await query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'artist_divya') ON CONFLICT DO NOTHING;`, [divyaId]);

    // Ensure reviews:moderate permission exists and is granted
    await query(`INSERT INTO permissions (id, name, description) VALUES ('reviews:moderate', 'Moderate Customer Reviews', 'Moderate reviews') ON CONFLICT DO NOTHING;`);
    await query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ('artist_divya', 'reviews:moderate') ON CONFLICT DO NOTHING;`);
    await query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_operator', 'reviews:moderate') ON CONFLICT DO NOTHING;`);

    // -------------------------------------------------------------------------
    // 1. GENUINE REVIEWS WORKFLOW & MODERATION
    // -------------------------------------------------------------------------
    console.log("🧪 1. Genuine Customer Reviews & Moderation Lifecycle");

    let submittedReviewId;

    await itAsync("Client can submit genuine feedback; review is unpublished by default", async () => {
      const res = await makeRequest("/api/reviews", {
        method: "POST",
        body: {
          customer_name: "Radhika Mehra",
          customer_phone: "+919811223344",
          rating: 5,
          title: "Flawless Bridal Press-Ons",
          review_text: "Ordered the royal gold foil set. Sizing was exact to the millimeter and stayed perfect throughout the wedding!",
          service_or_product_tag: "Handmade Press-On Nails",
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, "success");
      assert.strictEqual(res.body.review.is_approved, false, "Submitted reviews must be unpublished by default");
      assert.strictEqual(res.body.review.customer_name, "Radhika Mehra");
      submittedReviewId = res.body.review.id;
    });

    await itAsync("Public storefront (/api/reviews) excludes unpublished reviews (Zero fabricated content)", async () => {
      const res = await makeRequest("/api/reviews");
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.reviews));

      const found = res.body.reviews.find((r) => r.id === submittedReviewId);
      assert.strictEqual(found, undefined, "Unpublished review must NOT appear on public storefront");
    });

    await itAsync("Lead Artist Divya can view pending reviews in admin portal", async () => {
      const res = await makeRequest("/api/admin/reviews?status=pending", {
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.reviews));

      const found = res.body.reviews.find((r) => r.id === submittedReviewId);
      assert.ok(found, "Pending review must appear in admin moderation queue");
      assert.strictEqual(found.is_approved, false);
    });

    await itAsync("Lead Artist Divya approves review; review is published and audit log recorded", async () => {
      const res = await makeRequest(`/api/admin/reviews/${submittedReviewId}/approve`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { notes: "Verified against bridal press-on delivery" },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.review.is_approved, true);

      // Verify audit log
      const auditRes = await query(
        `SELECT * FROM audit_logs WHERE target_id = $1 AND action = 'review:approve';`,
        [submittedReviewId]
      );
      assert.strictEqual(auditRes.rows.length, 1, "Review approval must create an audit log entry");

      // Verify public storefront now displays approved review
      const pubRes = await makeRequest("/api/reviews");
      assert.strictEqual(pubRes.status, 200);
      const foundPublic = pubRes.body.reviews.find((r) => r.id === submittedReviewId);
      assert.ok(foundPublic, "Approved review must appear on public storefront");
      assert.strictEqual(foundPublic.customer_name, "Radhika Mehra");
    });

    await itAsync("Lead Artist Divya can reject / unpublish review", async () => {
      const res = await makeRequest(`/api/admin/reviews/${submittedReviewId}/reject`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { notes: "Moderator unpublished review" },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.review.is_approved, false);

      const pubRes = await makeRequest("/api/reviews");
      const foundPublic = pubRes.body.reviews.find((r) => r.id === submittedReviewId);
      assert.strictEqual(foundPublic, undefined, "Rejected review must be removed from storefront");
    });

    // -------------------------------------------------------------------------
    // 2. PRODUCT CMS OPERATIONS
    // -------------------------------------------------------------------------
    console.log("\n🧪 2. Product CMS (Create, Update, Archive, Images)");

    let testProductId;
    const testSuffix = Date.now().toString().slice(-6);
    const testSku = `TEST-CMS-${testSuffix}`;
    const testProductName = `Imperial Emerald Velvet ${testSuffix}`;

    await itAsync("Lead Artist Divya can create a new press-on product", async () => {
      const res = await makeRequest("/api/admin/products", {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          name: testProductName,
          sku: testSku,
          category_id: "wedding",
          base_price: 1399.00,
          description: "Handcrafted magnetic cat-eye emerald gel polish with 24K gold French border.",
          craftsmanship_details: "7-layer soft gel sculpt with sealed gold leaf.",
          is_available: true,
          is_made_to_order: true,
          images: [
            { image_url: "assets/press-on/1.png", alt_text: "Emerald Velvet Main", is_hero: true },
          ],
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.product.sku, testSku);
      assert.strictEqual(parseFloat(res.body.product.basePrice), 1399.00);
      assert.strictEqual(res.body.product.is_archived, false);
      testProductId = res.body.product.id;
    });

    await itAsync("Product appears in public catalog (/api/products)", async () => {
      const res = await makeRequest(`/api/products?search=${testSku}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.products.length >= 1);
      const prod = res.body.products.find((p) => p.sku === testSku);
      assert.ok(prod);
      assert.strictEqual(prod.name, testProductName);
    });

    await itAsync("Lead Artist Divya can update product details and price", async () => {
      const res = await makeRequest(`/api/admin/products/${testProductId}`, {
        method: "PUT",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          name: "Imperial Emerald Velvet (Refined)",
          base_price: 1499.00,
          description: "Updated description with enhanced Swarovski detailing.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.product.name, "Imperial Emerald Velvet (Refined)");
      assert.strictEqual(parseFloat(res.body.product.basePrice), 1499.00);
    });

    await itAsync("Lead Artist Divya can toggle product availability", async () => {
      const res = await makeRequest(`/api/admin/products/${testProductId}/availability`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { is_available: false },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.product.isAvailable, false);
    });

    await itAsync("Lead Artist Divya can add and delete gallery images", async () => {
      const addRes = await makeRequest(`/api/admin/products/${testProductId}/images`, {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          image_url: "assets/press-on/2.png",
          alt_text: "Secondary angle view",
          is_hero: false,
        },
      });

      assert.strictEqual(addRes.status, 201);
      const imgId = addRes.body.image.id;

      const delRes = await makeRequest(`/api/admin/products/${testProductId}/images/${imgId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token_divya" },
      });
      assert.strictEqual(delRes.status, 200);
      assert.strictEqual(delRes.body.success, true);
    });

    await itAsync("Lead Artist Divya can archive product (Preserving order snapshots)", async () => {
      const res = await makeRequest(`/api/admin/products/${testProductId}/archive`, {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.product.is_archived, true);
      assert.strictEqual(res.body.product.is_available, false);

      // Verify product is excluded from public catalog
      const pubRes = await makeRequest(`/api/products?search=${testSku}`);
      const found = pubRes.body.products.find((p) => p.sku === testSku);
      assert.strictEqual(found, undefined, "Archived product must NOT appear in public catalog");
    });

    // -------------------------------------------------------------------------
    // 3. PORTFOLIO CMS OPERATIONS
    // -------------------------------------------------------------------------
    console.log("\n🧪 3. Portfolio CMS (Create, Update, Toggle, Delete)");

    let testArtworkId;

    await itAsync("Public storefront can fetch lookbook artworks (/api/portfolio)", async () => {
      const res = await makeRequest("/api/portfolio");
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.artworks));
      assert.ok(res.body.artworks.length > 0);
    });

    await itAsync("Lead Artist Divya can upload/create new lookbook artwork", async () => {
      const res = await makeRequest("/api/admin/portfolio", {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          name: "Molten Platinum French",
          category_id: "chrome",
          image_url: "assets/portfolio/dv2.jpeg",
          alt_text: "Molten platinum chrome on almond gel tip",
          is_active: true,
        },
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.artwork.name, "Molten Platinum French");
      assert.strictEqual(res.body.artwork.category_id, "chrome");
      testArtworkId = res.body.artwork.id;
    });

    await itAsync("Lead Artist Divya can update artwork details", async () => {
      const res = await makeRequest(`/api/admin/portfolio/${testArtworkId}`, {
        method: "PUT",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          name: "Molten Platinum French (Lookbook Edit)",
          category_id: "chrome",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.artwork.name, "Molten Platinum French (Lookbook Edit)");
    });

    await itAsync("Lead Artist Divya can toggle artwork visibility", async () => {
      const res = await makeRequest(`/api/admin/portfolio/${testArtworkId}/availability`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_divya" },
        body: { is_active: false },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.artwork.is_active, false);
    });

    await itAsync("Lead Artist Divya can safely delete artwork", async () => {
      const res = await makeRequest(`/api/admin/portfolio/${testArtworkId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token_divya" },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    // -------------------------------------------------------------------------
    // 4. PERSISTENT ZERO-COST IMAGE STORAGE
    // -------------------------------------------------------------------------
    console.log("\n🧪 4. Zero-Cost Persistent Media Uploads");

    await itAsync("Lead Artist Divya can upload Base64 photograph; stored persistently", async () => {
      // 1x1 transparent PNG Base64
      const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const res = await makeRequest("/api/admin/uploads", {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          filename: "test_press_on.png",
          contentType: "image/png",
          data: tinyPngBase64,
        },
      });

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.url.startsWith("/uploads/upload_"));
      assert.strictEqual(res.body.mimeType, "image/png");

      // Verify file exists on disk
      const diskPath = path.join(__dirname, "../uploads", res.body.filename);
      assert.ok(fs.existsSync(diskPath), "Uploaded file must exist on disk");

      // Verify file is accessible via HTTP static route
      const staticRes = await makeRequest(res.body.url);
      assert.strictEqual(staticRes.status, 200);
    });

    await itAsync("Upload rejects unsupported MIME types", async () => {
      const res = await makeRequest("/api/admin/uploads", {
        method: "POST",
        headers: { Authorization: "Bearer token_divya" },
        body: {
          filename: "malicious.exe",
          contentType: "application/x-msdownload",
          data: "dGVzdA==",
        },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "UNSUPPORTED_MEDIA_TYPE");
    });

    // -------------------------------------------------------------------------
    // 5. SECURITY, RBAC & UNAPPROVED ACCESS GUARDS
    // -------------------------------------------------------------------------
    console.log("\n🧪 5. RBAC & Security Access Boundaries");

    await itAsync("Unauthenticated visitor is rejected from /api/admin/* with 401", async () => {
      const res = await makeRequest("/api/admin/products", {
        method: "POST",
        body: { name: "Hacker Product" },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "AUTH_REQUIRED");
    });

    await itAsync("Regular customer is rejected from /api/admin/* with 403", async () => {
      const res = await makeRequest("/api/admin/products", {
        method: "POST",
        headers: { Authorization: "Bearer token_customer" },
        body: { name: "Customer Product" },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, "FORBIDDEN_ROLE");
    });

    await itAsync("Staff artist (lacking reviews:moderate) is rejected from moderating reviews with 403", async () => {
      const res = await makeRequest(`/api/admin/reviews/${submittedReviewId}/approve`, {
        method: "PATCH",
        headers: { Authorization: "Bearer token_staff" },
        body: { notes: "Unauthorized approve" },
      });
      assert.strictEqual(res.status, 403);
    });

    // Clean up test data
    if (submittedReviewId) {
      await query(`DELETE FROM customer_reviews WHERE id = $1;`, [submittedReviewId]);
    }
    if (testProductId) {
      await query(`DELETE FROM products WHERE id = $1;`, [testProductId]);
    }

  } finally {
    clearTestTokenVerifier();
    await cleanupTestArtifacts();
    if (server) {
      await new Promise((r) => server.close(r));
    }
  }

  console.log("\n==================================================================");
  console.log("🏁 ADMIN DASHBOARD & CMS SUITE COMPLETE: All Tests Passed!");
  console.log("==================================================================\n");
}

if (require.main === module) {
  runAdminDashboardCMSSuite().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runAdminDashboardCMSSuite };
