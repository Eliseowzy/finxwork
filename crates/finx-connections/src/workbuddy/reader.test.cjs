const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { decodeAccessToken } = require("./reader.cjs");

// Synthetic sym-v1 field, with the authenticated framing laid out explicitly.
const payload = { version: 1, atRestSecretKey: "synthetic-test-key-never-an-account-credential" };
function fixture() {
  const key = crypto.createHash("sha256").update(payload.atRestSecretKey).digest();
  const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const aad = Buffer.concat([
    Buffer.from("57422d41414400010000000557424556310000000673796d2d76310000000100000010", "hex"),
    Buffer.from(id), Buffer.from([2, 0, 0]),
  ]);
  const nonce = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update("synthetic-access-token"), cipher.final()]);
  key.fill(0);
  return { suite: 1, keyId: id, nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function field(envelope) { return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope)).toString("base64") }; }
test("reads plaintext and authenticated sym-v1 fields", () => {
  assert.equal(decodeAccessToken("old-plaintext", {}), "old-plaintext");
  assert.equal(decodeAccessToken(field(fixture()), payload), "synthetic-access-token");
});
test("rejects tampering, a different key, and unknown encryption formats", () => {
  const tampered = fixture(); tampered.authTag = Buffer.alloc(16).toString("base64");
  assert.throws(() => decodeAccessToken(field(tampered), payload));
  assert.throws(() => decodeAccessToken(field(fixture()), { ...payload, atRestSecretKey: "another" }));
  assert.throws(() => decodeAccessToken(field({ ...fixture(), scheme: "asym-v1" }), payload));
  assert.throws(() => decodeAccessToken({ $wbEncrypted: 2, envelope: "" }, payload));
});
