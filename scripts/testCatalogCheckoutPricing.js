
"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
require("./withDisposableCheckoutDb").verifyFixture();
const { query, closePool } = require("../src/db/pool");
const app = require("../index");

const seasonalPrice = 599;
const basePrices = {
  "CAS-004": 899, "CAS-005": 799, "CAS-007": 1199, "CAS-008": 1199,
  "PAR-003": 1299, "PAR-004": 1299, "PAR-008": 999, "PAR-009": 1199, "PAR-0010": 1299, "PAR-0011": 799,
  "WED-001": 999, "WED-002": 799, "WED-005": 999, "WED-006": 1399, "WED-007": 1299, "WED-008": 699, "WED-009": 1399,
  "WORK-002": 1099, "WORK-003": 799, "WORK-004": 999, "WORK-006": 1199, "WORK-007": 1299,
};

async function main() {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  async function request(method, route, expectedStatus, headers = {}, data) {
    const response = await fetch(origin + route, {
      method, headers: { "Content-Type": "application/json", ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    assert.equal(response.status, expectedStatus, method + " " + route + ": " + (body.code || body.error || ""));
    return body;
  }
  const getCart = () => request("GET", "/api/cart", 200);
  const addItem = (headers, sku) => request("POST", "/api/cart/items", 201, headers, {
    sku, shape: "Almond", length: "Medium", sizing_preset: "M", quantity: 1,
    unit_price: 1, base_price: 1, discount_amount: 0, total_amount: 1,
  });
  const checkout = (cart, headers, status, contact, shipping = contact, key = randomUUID()) =>
    request("POST", "/api/orders", status, headers, {
      cart_id: cart.id, idempotency_key: key,
      customer: { name: "Pricing Fixture", phone: contact },
      shipping_address: { recipient_name: "Pricing Fixture", phone: shipping, address_line1: "123 Sample Road",
        city: "Delhi", state: "Delhi", postal_code: "110001" },
      total_amount: 1, discount_amount: 999999, items: [{ sku: "CAS-004", unit_price: 1 }],
    });

  try {
    const list = await request("GET", "/api/products", 200);
    assert.deepEqual(list.products.map(p => p.sku).sort(), Object.keys(basePrices).sort());
    const { cart } = await getCart();
    const headers = { "X-Cart-Session": cart.sessionToken };
    let cartResult;
    for (const product of list.products) {
      const sku = product.sku;
      const detail = (await request("GET", "/api/products/" + sku, 200)).product;
      for (const listing of [product, detail]) {
        assert.equal(listing.basePrice, basePrices[sku], sku);
        assert.equal(listing.effectivePrice, seasonalPrice, sku);
        assert.equal(listing.isPromoApplied, true, sku);
      }
      cartResult = await addItem(headers, sku);
    }
    const subtotal = Object.values(basePrices).reduce((sum, price) => sum + price, 0);
    const total = 22 * seasonalPrice;
    assert.equal(cartResult.items.length, 22);
    for (const item of cartResult.items) {
      assert.equal(item.basePrice, basePrices[item.sku], item.sku);
      assert.equal(item.unitPrice, seasonalPrice, item.sku);
      assert.equal(item.isPromoApplied, true, item.sku);
    }
    assert.equal(cartResult.totals.subtotal, subtotal);
    assert.equal(cartResult.totals.discountAmount, subtotal - total);
    assert.equal(cartResult.totals.totalAmount, total);

    const invalid = ["abc", "abc9000000001", "9+000000001", "+1 9000000001", "+91 09000000001",
      "5000000001", "900000001", "90000000012", "90000--00001", "9000000001 ext 21", 9000000001];
    const key = randomUUID();
    for (const phone of invalid) {
      assert.equal((await checkout(cart, headers, 400, phone, "9000000001", key)).code, "INVALID_PHONE");
      assert.equal((await checkout(cart, headers, 400, "9000000001", phone, key)).code, "INVALID_PHONE");
    }
    assert.equal((await query("SELECT count(*)::int AS count FROM orders")).rows[0].count, 0);

    const order = await checkout(cart, headers, 201, "9000000001", "+91 90000-00001", key);
    assert.equal(order.order.customerPhone, "+919000000001");
    assert.equal(order.order.shippingAddress.phone, "+919000000001");
    assert.equal(order.order.subtotal, subtotal);
    assert.equal(order.order.discountAmount, subtotal - total);
    assert.equal(order.order.totalAmount, total);
    assert.equal(order.items.length, 22);
    for (const item of order.items) {
      assert.equal(item.unitPrice, seasonalPrice, item.sku);
      assert.equal(item.variantDetails.base_price, basePrices[item.sku], item.sku);
    }
    for (const phone of ["90000 00001", "91-90000-00001", "0091 9000000001", "09000000001", "+91\u202f90000\u00a000001"]) {
      const replay = await checkout(cart, headers, 200, phone, phone, key);
      assert.equal(replay.order.id, order.order.id);
    }
    console.log("PASS 22 SKU listing, detail, cart and order prices, promotion savings, tamper resistance and checkout phone formats");

    // Simulate prices and categories for which the active offer does not apply.
    await query("INSERT INTO product_categories (id, name) VALUES ('fixture-non-offer', 'Fixture non-offer')");
    await query("UPDATE products SET category_id = 'fixture-non-offer' WHERE sku = 'WED-005'");
    await query("UPDATE products SET base_price = 499 WHERE sku = 'CAS-004'");
    const regular = (await getCart()).cart;
    const regularHeaders = { "X-Cart-Session": regular.sessionToken };
    for (const [sku, expected] of [["WED-005", 999], ["CAS-004", 499]]) {
      const detail = (await request("GET", "/api/products/" + sku, 200)).product;
      const item = (await addItem(regularHeaders, sku)).items.find(value => value.sku === sku);
      assert.equal(detail.effectivePrice, expected);
      assert.equal(item.unitPrice, expected);
      assert.equal(detail.isPromoApplied, false);
      assert.equal(item.isPromoApplied, false);
    }
    const undiscounted = await checkout(regular, regularHeaders, 201, "60000-00001");
    assert.equal(undiscounted.order.discountAmount, 0);
    assert.equal(undiscounted.order.totalAmount, 1498);
    console.log("PASS no promotion on an excluded category or a price below the offer amount");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await closePool();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
