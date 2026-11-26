const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");

require("./withDisposableCheckoutDb").verifyFixture();
const { requestMagicLink, verifyMagicLink, hashLoginToken } = require("../src/services/emailAuthService");
const { setTestEmailCustomTokenIssuer } = require("../src/services/firebaseService");
const { query, closePool } = require("../src/db/pool");
const CONFIG = require("../src/config");

const success = { status: 200, bodyStatus: "success" };

if (process.argv[2] === "--worker") {
  CONFIG.emailAuth.isResendConfigured = true;
  let mode;
  const fixtureFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url !== "https://api.resend.com/emails") return fixtureFetch(url, options);
    const message = JSON.parse(options.body);
    const token = /email_token=([\w-]+)/.exec(message.text)[1];
    assert.match(options.headers["Idempotency-Key"], /^email-login\/[\da-f-]+$/i);
    process.send({ send: { token, key: options.headers["Idempotency-Key"] } });
    if (mode === "reject") return new Response(null, { status: 422 });
    if (mode === "uncertain") throw new DOMException("Fixture response lost", "AbortError");
    if (mode === "upstream") return new Response(null, { status: 503 });
    return new Response(null, { status: 200 });
  };
  process.on("message", async ({ email, outcome }) => {
    mode = outcome;
    try {
      const result = await requestMagicLink({ email });
      process.send({ result: { status: 200, bodyStatus: result.status } });
    } catch (err) {
      process.send({ result: { status: err.statusCode || 500, code: err.code } });
    }
  });
  process.on("disconnect", () => closePool());
} else {
  function worker() {
    const child = fork(__filename, ["--worker"]);
    const calls = [];
    child.on("message", (message) => { if (message.send) calls.push(message.send); });
    return {
      calls,
      request(email, outcome) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Email worker did not respond")), 10000);
          const onMessage = (message) => {
            if (!message.result) return;
            clearTimeout(timer);
            child.off("message", onMessage);
            resolve(message.result);
          };
          child.on("message", onMessage);
          child.send({ email, outcome });
        });
      },
      async stop() {
        const exited = once(child, "exit");
        child.disconnect();
        await exited;
      },
    };
  }

  async function active(email) {
    const { rows } = await query(
      "SELECT token_hash, extract(epoch from expires_at - created_at)::int AS ttl FROM email_login_tokens WHERE email=$1 AND used_at IS NULL",
      [email]
    );
    return rows;
  }

  async function passCooldown(email) {
    await query("UPDATE email_login_tokens SET created_at = created_at - interval '61 seconds' WHERE email=$1", [email]);
  }

  async function main() {
    const a = worker();
    const b = worker();
    try {
      const email = "cooldown@example.invalid";
      const [first, second] = await Promise.all([a.request(" COOLDOWN@Example.Invalid "), b.request(email)]);
      assert.deepEqual(first, success);
      assert.deepEqual(second, success);
      const sent = [...a.calls, ...b.calls];
      assert.equal(sent.length, 1);
      assert.deepEqual(await active(email), [{ token_hash: hashLoginToken(sent[0].token), ttl: 900 }]);
      assert.deepEqual(await b.request(email), success);
      assert.equal(a.calls.length + b.calls.length, 1);

      await passCooldown(email);
      assert.deepEqual(await b.request(email), success);
      assert.equal(a.calls.length + b.calls.length, 2);
      assert.notEqual(b.calls.at(-1).key, sent[0].key);
      setTestEmailCustomTokenIssuer(async () => ({ uid: "fixture-deliberate-resend", customToken: "fixture-custom" }));
      assert.equal((await verifyMagicLink({ token: b.calls.at(-1).token })).status, "success");
      assert.deepEqual(await active(email), []);
      console.log("PASS concurrent workers issue only one link; deliberate resend works after cooldown");

      const rejected = "rejected@example.invalid";
      assert.deepEqual(await a.request(rejected), success);
      const previousToken = a.calls.at(-1).token;
      await passCooldown(rejected);
      assert.deepEqual(await b.request(rejected, "reject"), { status: 502, code: "EMAIL_DELIVERY_FAILED" });
      assert.deepEqual((await active(rejected)).map(row => row.token_hash), [hashLoginToken(previousToken)]);
      const sends = b.calls.length;
      assert.deepEqual(await b.request(rejected), success);
      assert.equal(b.calls.length, sends);
      console.log("PASS definite rejection disables only its own link and retains cooldown");

      for (const outcome of ["uncertain", "upstream"]) {
        const recipient = outcome + "@example.invalid";
        const before = a.calls.length;
        assert.deepEqual(await a.request(recipient, outcome), success);
        assert.deepEqual(await b.request(recipient), success);
        assert.equal(a.calls.length, before + 1);
        const captured = a.calls.at(-1).token;
        assert.deepEqual(await active(recipient), [{ token_hash: hashLoginToken(captured), ttl: 900 }]);
        setTestEmailCustomTokenIssuer(async () => ({ uid: "fixture-" + outcome, customToken: "fixture-custom" }));
        assert.equal((await verifyMagicLink({ token: captured })).status, "success");
      }
      console.log("PASS an ambiguous response preserves a working link and suppresses repeat sends");
    } finally {
      await Promise.all([a.stop(), b.stop(), closePool()]);
    }
  }

  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
