const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/services/firebaseService"), "utf8");
const production = "nails-by-divya";
const staging = "nails-by-divya-staging";

function load({ env = "staging", config = {}, existing = [], credentialFile }) {
  const errors = [];
  const initialized = [];
  const mod = { exports: {} };
  const sdk = {
    getApps: () => existing,
    cert: value => value,
    initializeApp: (options) => {
      initialized.push(options.projectId);
      return { options };
    },
  };
  vm.runInNewContext(source, {
    module: mod, process,
    console: { log() {}, warn() {}, error: (...parts) => errors.push(parts.join(" ")) },
    require(name) {
      switch (name) {
        case "firebase-admin/app": return sdk;
        case "firebase-admin/auth": return {};
        case "fs": return {
          existsSync: () => Boolean(credentialFile),
          readFileSync: () => JSON.stringify(credentialFile),
        };
        case "../config": return {
          firebase: config,
          nodeEnv: env,
          isStaging: () => env === "staging",
          isProduction: () => env === "production",
        };
        default: return require(name);
      }
    },
  });
  return { errors, initialized, configured: () => mod.exports.isFirebaseAdminConfigured() };
}

const credentials = projectId => ({
  projectId, clientEmail: `fixture@${projectId}.iam.gserviceaccount.com`, privateKey: "fixture",
});

const missing = load({});
assert.equal(missing.configured(), false);
assert.match(missing.errors[0], /not configured in staging/);
for (const fixture of [
  { config: credentials(production) },
  { config: credentials(production), env: "preview" },
  { config: { ...credentials(staging), clientEmail: credentials(production).clientEmail } },
  { config: { ...credentials(staging), serviceAccountJson: {
    project_id: production, client_email: credentials(production).clientEmail, private_key: "fixture",
  } } },
  { config: { projectId: staging, serviceAccountPath: "fixture.json" }, credentialFile: {
    project_id: production, client_email: credentials(production).clientEmail, private_key: "fixture",
  } },
  { existing: [{ options: { projectId: production } }] },
]) {
  const blocked = load(fixture);
  assert.equal(blocked.configured(), false);
  assert.deepEqual(blocked.initialized, []);
  assert.match(blocked.errors[0], /dedicated nails-by-divya-staging project/);
}
console.log("PASS staging and preview Admin SDK reject missing or production credentials");

const dedicated = load({ config: credentials(staging) });
assert.equal(dedicated.configured(), true);
assert.deepEqual(dedicated.initialized, [staging]);
const prod = load({ env: "production", config: credentials(production) });
assert.equal(prod.configured(), true);
assert.deepEqual(prod.initialized, [production]);
console.log("PASS dedicated staging and existing production Firebase Admin configurations initialize");
