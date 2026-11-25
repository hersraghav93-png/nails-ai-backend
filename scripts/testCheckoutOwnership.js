"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
require("./withDisposableCheckoutDb").verifyFixture();
const { query, getClient, closePool } = require("../src/db/pool");
const firebase = require("../src/services/firebaseService");
const { setTestEmailSender } = require("../src/services/emailAuthService");
const app = require("../index");

const sql = file => fs.readFileSync(path.resolve(__dirname, "../database/migrations", file), "utf8");
const up = sql("009_checkout_attempts.sql");
const down = sql("009_checkout_attempts_rollback.sql");
const item = {
  sku: "WED-005", shape: "Almond", length: "Medium", sizing_preset: "Custom", quantity: 1,
  custom_measurements: { thumb: 15, index: 12, middle: 13, ring: 12, pinky: 9 },
};
const payload = {
  customer: { name: "Fixture Buyer", phone: "9000000001", email: "receipt@example.invalid" },
  shipping_address: {
    recipient_name: "Fixture Buyer", phone: "9000000001", address_line1: "123 Fixture Street",
    city: "Delhi", state: "Delhi", postal_code: "110001",
  },
  customer_notes: "Synthetic order",
};

const account = name => ({ Authorization: "Bearer " + name });
const guest = cart => ({ "X-Cart-Session": cart.sessionToken });
const A = account("a"), B = account("b");
let base;
async function api(method, route, headers = {}, body) {
  const res = await fetch(base + route, {
    method, headers: { "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ...await res.json(), httpStatus: res.status };
}
async function expectStatus(response, status) {
  const result = await response;
  assert.equal(result.httpStatus, status, result.code || result.error);
  return result;
}
const bag = async (headers = {}) => (await expectStatus(api("GET", "/api/cart", headers), 200)).cart;
const add = (headers, fields = {}) => expectStatus(api("POST", "/api/cart/items", headers, { ...item, ...fields }), 201);
const place = (headers, cart, key, changes) => api("POST", "/api/orders", headers, {
  ...payload, cart_id: cart.id, idempotency_key: key, ...changes,
});
const lookup = (headers, cart, key) => api("POST", "/api/orders", headers, {
  cart_id: cart.id, idempotency_key: key, retry_only: true,
});
const detail = (id, headers) => api("GET", "/api/orders/" + id, headers);
const cancel = (id, headers) => api("POST", "/api/orders/" + id + "/cancel", headers, {});
const claim = (cart, headers) => api("POST", "/api/cart/claim", headers, { guest_session_token: cart.sessionToken });
const expire = cart => query("UPDATE carts SET expires_at = now() - interval '1 second' WHERE id = $1", [cart.id]);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}

// Prove both requests reached PostgreSQL's lock queue before releasing the cart.
async function raceAtCart(cart, first, second) {
  const lock = await getClient();
  let requests;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM carts WHERE id = $1 FOR UPDATE", [cart.id]);
    requests = Promise.all([first(), second()]);
    const until = Date.now() + 8000;
    for (;;) {
      const result = await query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      if (result.rows[0].n >= 2) break;
      assert.ok(Date.now() < until, "Expected two concurrent database lock waiters");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  return requests;
}

async function main() {
  firebase.setTestTokenVerifier(async name => {
    if (!["a", "b", "support", "artist", "linked"].includes(name)) throw new Error("Unknown test identity");
    return { uid: "fixture-" + name, email: name === "linked" ? payload.customer.email : name + "@example.invalid", email_verified: true };
  });
  firebase.setTestEmailCustomTokenIssuer(async () => ({ uid: "fixture-linked", customToken: "fixture-custom" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  let legacy, legacyCart, owned, ownedCart, receipt, receiptCart, receiptKey, otherCart;

  try {
    await test("009 is outside automatic startup and applies over an existing keyless guest order", async () => {
      const manifest = require("../database/manifest.json");
      assert.ok(!manifest.migrations.some(m => m.id === "009" || m.up_file.includes("checkout_attempts")));
      legacyCart = await bag();
      await add(guest(legacyCart));
      legacy = await expectStatus(place(guest(legacyCart), legacyCart), 201);
      assert.ok(legacy.claimSecret);
      await expectStatus(place(guest(legacyCart), legacyCart, randomUUID()), 503);
      await query(up);
      assert.equal((await expectStatus(detail(legacy.order.id, guest(legacyCart)), 200)).order.id, legacy.order.id);
    });

    await test("explicit cart operations require guest proof or the verified account owner", async () => {
      ownedCart = await bag(A);
      const own = await add(A);
      const outsider = await bag(B);
      otherCart = await bag();
      const gid = (await add(guest(otherCart))).items[0].id;
      for (const [cart, id, headers] of [
        [ownedCart, own.items[0].id, guest(ownedCart)], [ownedCart, own.items[0].id, { ...B, ...guest(ownedCart) }],
        [otherCart, gid, {}], [otherCart, gid, A], [otherCart, gid, guest(legacyCart)],
      ]) {
        const param = "?cart_id=" + cart.id;
        await expectStatus(api("GET", "/api/cart" + param, headers), 404);
        await expectStatus(api("POST", "/api/cart/items" + param, headers, item), 404);
        await expectStatus(api("PUT", "/api/cart/items/" + id + param, headers, { quantity: 2 }), 404);
        await expectStatus(api("DELETE", "/api/cart/items/" + id + param, headers), 404);
        await expectStatus(api("DELETE", "/api/cart" + param, headers), 404);
        await expectStatus(place(headers, cart, randomUUID()), 404);
      }
      assert.equal((await bag({ ...B, ...guest(ownedCart) })).id, outsider.id);
      assert.notEqual((await bag(guest(ownedCart))).id, ownedCart.id);
      await expectStatus(claim(ownedCart, B), 404);
      assert.equal((await api("GET", "/api/cart", A)).items[0].quantity, 1);
      assert.equal((await api("GET", "/api/cart", guest(otherCart))).items[0].quantity, 1);
    });

    await test("account order detail, history, cancellation and retry require the owner", async () => {
      owned = await expectStatus(place(A, ownedCart, "shared"), 201);
      assert.equal(owned.claimSecret, null);
      for (const headers of [{}, guest(ownedCart), B, { ...B, ...guest(ownedCart) }]) {
        await expectStatus(detail(owned.order.id, headers), 403);
        await expectStatus(cancel(owned.order.id, headers), 403);
        await expectStatus(lookup(headers, ownedCart, "shared"), 404);
      }
      const ownDetail = await expectStatus(detail(owned.order.id, A), 200);
      assert.deepEqual(ownDetail.items[0].variantDetails.custom_measurements, item.custom_measurements);
      assert.ok((await api("GET", "/api/orders", A)).orders.some(o => o.id === owned.order.id));
      assert.ok(!(await api("GET", "/api/orders", B)).orders.some(o => o.id === owned.order.id));
      await expectStatus(lookup(A, ownedCart, "shared"), 200);
    });

    await test("independent account and guest buyers can reuse one key without sharing receipts", async () => {
      const bCart = await bag(B);
      await add(B);
      const bOrder = await expectStatus(place(B, bCart, "shared"), 201);
      const guestOrder = await expectStatus(place(guest(otherCart), otherCart, "shared"), 201);
      const secondGuest = await bag();
      await add(guest(secondGuest));
      const independent = await expectStatus(place(guest(secondGuest), secondGuest, "shared"), 201);
      assert.equal(new Set([independent.order.id, bOrder.order.id, guestOrder.order.id, owned.order.id]).size, 4);
      await expectStatus(detail(guestOrder.order.id, guest(secondGuest)), 403);
      assert.equal((await expectStatus(lookup(B, bCart, "shared"), 200)).order.id, bOrder.order.id);
      await expectStatus(lookup(B, ownedCart, "shared"), 409);
      const conflict = await lookup(guest(otherCart), ownedCart, "shared");
      assert.equal(conflict.httpStatus, 409);
      assert.ok(!conflict.order);
    });

    await test("two accounts claiming the same guest cart transfer its custom item exactly once", async () => {
      const cart = await bag();
      await add(guest(cart), { shape: "Stiletto", quantity: 3 });
      const outcomes = await raceAtCart(cart, () => claim(cart, A), () => claim(cart, B));
      assert.deepEqual(outcomes.map(r => r.httpStatus).sort(), [200, 404]);
      const bags = await Promise.all([api("GET", "/api/cart", A), api("GET", "/api/cart", B)]);
      const claimed = bags.flatMap(b => b.items).filter(i => i.shape === "Stiletto");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].quantity, 3);
      assert.deepEqual(claimed[0].customMeasurements, item.custom_measurements);
      assert.equal((await api("GET", "/api/cart", guest(cart))).items.length, 0);
    });

    await test("first-time sign-in claims a guest cart, rotates its token and isolates logout", async () => {
      const cart = await bag();
      await add(guest(cart));
      const auth = account("artist");
      const signedIn = await expectStatus(api("GET", "/api/cart", { ...auth, ...guest(cart) }), 200);
      assert.equal(signedIn.cart.id, cart.id);
      assert.notEqual(signedIn.cart.sessionToken, cart.sessionToken);
      await expectStatus(place(guest(cart), cart), 404);
      assert.equal((await api("GET", "/api/cart", guest(signedIn.cart))).items.length, 0);
      assert.equal((await api("GET", "/api/cart", auth)).items.length, 1);
    });

    await test("previously adopted account carts do not disclose a still-valid guest receipt token to another device", async () => {
      const cart = await bag();
      await add(guest(cart));
      const placed = await expectStatus(place(guest(cart), cart), 201);
      // Reproduce the historical stored relationship without using an old server.
      const accountCart = await bag(account("support"));
      await expire(accountCart);
      await query("UPDATE carts SET user_id=$1 WHERE id=$2", [accountCart.userId, cart.id]);
      const accountView = await bag(account("support"));
      assert.equal(accountView.id, cart.id);
      assert.notEqual(accountView.sessionToken, cart.sessionToken);
      await expectStatus(detail(placed.order.id, { ...account("support"), ...guest(accountView) }), 403);
      await expectStatus(detail(placed.order.id, guest(cart)), 200);
    });

    await test("competing claim and guest checkout have one serial outcome", async () => {
      const cart = await bag();
      await add(guest(cart), { shape: "Ballerina" });
      const [claimed, purchase] = await raceAtCart(cart, () => claim(cart, A), () => place(guest(cart), cart, randomUUID()));
      assert.equal(claimed.httpStatus, 200);
      assert.ok([201, 404].includes(purchase.httpStatus));
      const transferred = claimed.items.some(row => row.shape === "Ballerina");
      assert.equal(transferred, purchase.httpStatus === 404);
      await expectStatus(place(guest(cart), cart, randomUUID()), 404);
    });

    await test("a failed merge rolls back all item and ownership changes", async () => {
      const cart = await bag();
      await add(guest(cart), { shape: "Coffin" });
      await add(guest(cart), { shape: "Oval" });
      await query("CREATE FUNCTION fail_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$");
      await query("CREATE TRIGGER fail_merge BEFORE DELETE ON carts FOR EACH ROW EXECUTE FUNCTION fail_merge()");
      try {
        assert.ok((await claim(cart, A)).httpStatus >= 400);
      } finally {
        await query("DROP TRIGGER fail_merge ON carts");
      }
      assert.equal((await api("GET", "/api/cart", guest(cart))).items.length, 2);
      const dest = await api("GET", "/api/cart", A);
      assert.ok(!dest.items.some(i => ["Coffin", "Oval"].includes(i.shape)));
      await expectStatus(claim(cart, A), 200);
    });

    await test("concurrent checkout plus a lost response yields one receipt, snapshot, audit and confirmation", async () => {
      receiptCart = await bag();
      receiptKey = randomUUID();
      await add(guest(receiptCart));
      const submit = () => place(guest(receiptCart), receiptCart, receiptKey);
      const results = await raceAtCart(receiptCart, submit, submit);
      assert.deepEqual(results.map(r => r.httpStatus).sort(), [200, 201]);
      receipt = results.find(r => r.httpStatus === 201);
      const recovered = await expectStatus(lookup(guest(receiptCart), receiptCart, receiptKey), 200);
      assert.equal(recovered.order.id, receipt.order.id);
      assert.equal(results[0].order.orderNumber, results[1].order.orderNumber);
      assert.equal((await expectStatus(submit(), 200)).order.id, receipt.order.id);
      const counts = await query(`SELECT
        (SELECT count(*)::int FROM checkout_attempts WHERE order_id=$1::uuid) attempts,
        (SELECT count(*)::int FROM order_items WHERE order_id=$1::uuid) items,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$1::text AND action='ORDER_CREATED') audits,
        (SELECT count(*)::int FROM notification_jobs WHERE template_variables->>'orderId'=$1::text) jobs`, [receipt.order.id]);
      assert.deepEqual(counts.rows[0], { attempts: 1, items: 1, audits: 1, jobs: 1 });
      await add(guest(receiptCart), { shape: "Square" });
      await expectStatus(submit(), 200);
      assert.equal((await api("GET", "/api/cart", guest(receiptCart))).items[0].shape, "Square");
    });

    await test("changed notes, delivery or cart conflict, and concurrent distinct carts cannot both commit", async () => {
      for (const changes of [{ customer_notes: "Different" }, { shipping_address: { ...payload.shipping_address, city: "Mumbai" } }, { cart_id: otherCart.id }]) {
        const result = await expectStatus(place(guest(receiptCart), receiptCart, receiptKey, changes), 409);
        assert.equal(result.code, "IDEMPOTENCY_KEY_CONFLICT");
        assert.ok(!result.order);
      }
      const extra = await query("INSERT INTO carts(user_id,session_token,expires_at) VALUES ($1,$2,now()+interval '1 day') RETURNING id", [ownedCart.userId, randomUUID()]);
      const second = extra.rows[0];
      await add(A, { cart_id: ownedCart.id });
      await add(A, { cart_id: second.id });
      const key = randomUUID();
      const results = await Promise.all([place(A, ownedCart, key), place(A, second, key)]);
      assert.deepEqual(results.map(r => r.httpStatus).sort(), [201, 409]);
      const losing = results[0].httpStatus === 409 ? ownedCart : second;
      assert.ok((await api("GET", "/api/cart?cart_id=" + losing.id, A)).items.length);
    });

    await test("failed checkout is retryable after transaction rollback", async () => {
      const cart = await bag();
      await add(guest(cart));
      for (const invalidKey of ["", " ", 123, "x".repeat(257)]) {
        await expectStatus(place(guest(cart), cart, invalidKey), 400);
      }
      const key = randomUUID();
      await query("CREATE TRIGGER fail_checkout BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION fail_merge()");
      try {
        assert.ok((await place(guest(cart), cart, key)).httpStatus >= 400);
      } finally {
        await query("DROP TRIGGER fail_checkout ON order_items");
      }
      await expectStatus(lookup(guest(cart), cart, key), 404);
      // A failed confirmation enqueue must also roll back the order, receipt and cart consumption.
      await query("CREATE TRIGGER fail_enqueue BEFORE INSERT ON notification_jobs FOR EACH ROW EXECUTE FUNCTION fail_merge()");
      try {
        await expectStatus(place(guest(cart), cart, key), 500);
      } finally {
        await query("DROP TRIGGER fail_enqueue ON notification_jobs");
      }
      await expectStatus(lookup(guest(cart), cart, key), 404);
      assert.equal((await api("GET", "/api/cart", guest(cart))).items.length, 1);
      await expectStatus(place(guest(cart), cart, key), 201);
    });

    await test("expired cart cannot create or claim, while the original unclaimed guest receipt survives", async () => {
      await expire(receiptCart);
      await expectStatus(place(guest(receiptCart), receiptCart, randomUUID()), 404);
      await expectStatus(claim(receiptCart, B), 404);
      const next = await bag(guest(receiptCart));
      assert.notEqual(next.sessionToken, receiptCart.sessionToken);
      assert.notEqual(next.id, receiptCart.id);
      await expectStatus(lookup(guest(receiptCart), receiptCart, receiptKey), 200);
      await expectStatus(detail(receipt.order.id, { "X-Claim-Secret": receipt.claimSecret }), 200);
      await expectStatus(detail(receipt.order.id, guest(next)), 403);
      await query("DELETE FROM carts WHERE id=$1", [receiptCart.id]);
      await expectStatus(lookup(guest(receiptCart), receiptCart, receiptKey), 200);
      assert.notEqual((await bag({ "X-Cart-Session": "unissued-fixture" })).sessionToken, "unissued-fixture");
    });

    await test("legacy keyed guest receipt remains valid by claim secret and the key is never a credential", async () => {
      await query("UPDATE orders SET guest_session_token='idem:old-key',artist_internal_notes='[IDEMPOTENCY_KEY: old-key]' WHERE id=$1", [legacy.order.id]);
      await expectStatus(detail(legacy.order.id, { "X-Claim-Secret": legacy.claimSecret }), 200);
      for (const token of ["old-key", "idem:old-key"]) {
        await expectStatus(detail(legacy.order.id, { "X-Cart-Session": token }), 403);
        await expectStatus(cancel(legacy.order.id, { "X-Cart-Session": token }), 403);
      }
      await expectStatus(cancel(legacy.order.id, { "X-Claim-Secret": legacy.claimSecret }), 200);
    });

    await test("verified email links the guest receipt and revokes both old capabilities for read, cancellation and retry", async () => {
      let email;
      setTestEmailSender(async message => { email = message; return { id: "fixture-email" }; });
      await expectStatus(api("POST", "/api/auth/email/request-link", {}, { email: payload.customer.email }), 200);
      await expectStatus(detail(receipt.order.id, guest(receiptCart)), 200);
      const token = /[?&]email_token=([A-Za-z0-9_-]+)/.exec(email.text)[1];
      const linked = await expectStatus(api("POST", "/api/auth/email/verify-link", {}, { token }), 200);
      assert.ok(linked.linkedOrdersCount > 0);
      for (const headers of [guest(receiptCart), { "X-Claim-Secret": receipt.claimSecret }, { ...B, ...guest(receiptCart), "X-Claim-Secret": receipt.claimSecret }]) {
        await expectStatus(detail(receipt.order.id, headers), 403);
        await expectStatus(cancel(receipt.order.id, headers), 403);
      }
      await expectStatus(lookup(guest(receiptCart), receiptCart, receiptKey), 403);
      const owner = account("linked");
      assert.ok((await api("GET", "/api/orders", owner)).orders.some(o => o.id === receipt.order.id));
      await expectStatus(cancel(receipt.order.id, owner), 200);
      await expectStatus(detail(owned.order.id, owner), 403);
    });

    await test("studio read and cancellation retain their separate role permissions", async () => {
      for (const [actor, role] of [["support", "support_staff"], ["artist", "artist_divya"]]) {
        const cart = await bag(account(actor));
        await query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [cart.userId, role]);
        await expectStatus(detail(owned.order.id, account(actor)), 200);
      }
      await expectStatus(cancel(owned.order.id, account("support")), 403);
      await expectStatus(cancel(owned.order.id, account("artist")), 200);
    });

    await test("rolling back 009 preserves existing customers, orders, items, history, payments and bookings", async () => {
      await query("INSERT INTO payments(order_id,payment_method,amount,idempotency_key) VALUES($1,'cash',25,'fixture-payment')", [owned.order.id]);
      await query(`INSERT INTO bookings(booking_number, customer_name, customer_phone, service_id, service_address, postal_code,
        requested_date, requested_time_slot, estimated_total) VALUES('FIXTURE-1','Fixture','+919000000001','gel_extensions','{}','110001',current_date,'morning',1)`);
      const tables = ["users", "orders", "order_items", "order_status_history", "payments", "bookings", "audit_logs", "notification_jobs"];
      async function snapshot() {
        return Promise.all(tables.map(async name => (await query("SELECT * FROM " + name + " ORDER BY id")).rows));
      }
      const before = await snapshot();
      assert.ok(before.every(rows => rows.length > 0));
      await query(down);
      assert.equal((await query("SELECT to_regclass('checkout_attempts') AS rel")).rows[0].rel, null);
      assert.deepEqual(await snapshot(), before);
      await query(up);
      assert.deepEqual(await snapshot(), before);
    });
    console.log(passed + " checkout ownership and migration groups passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await closePool();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
