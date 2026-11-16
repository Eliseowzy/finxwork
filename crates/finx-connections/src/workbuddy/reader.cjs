// Runs only in the installed WorkBuddy runtime, in Node mode. No app startup,
// files, network, refresh, or key persistence. stdin/stdout are private pipes.
const crypto = require("node:crypto");

function lengthPrefixed(text) {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function decodeAccessToken(value, payload) {
  if (typeof value === "string") return value;
  if (value?.$wbEncrypted !== 1 || typeof value.envelope !== "string") throw Error("unsupported");
  if (payload.version !== 1 || typeof payload.atRestSecretKey !== "string" || !payload.atRestSecretKey) throw Error("unsupported");
  const key = crypto.createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
  let plain;
  try {
    const keyId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    const envelope = JSON.parse(Buffer.from(value.envelope, "base64").toString("utf8"));
    if (envelope.suite !== 1 || envelope.keyId !== keyId || envelope.scheme !== undefined) throw Error("unsupported");
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.authTag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw Error("invalid");
    const aad = Buffer.concat([
      Buffer.from("WB-AAD\0"), Buffer.from([1]), lengthPrefixed("WBEV1"),
      lengthPrefixed("sym-v1"), Buffer.from([0, 0, 0, 1]), lengthPrefixed(keyId),
      Buffer.from([2, 0, 0]),
    ]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

async function run() {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Error("too large");
      chunks.push(chunk);
    }
    const session = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const field = session.auth?.accessToken;
    const payload = typeof field === "string" ? {} : JSON.parse(
      process._linkedBinding("electron_browser_workbuddy_storage").loggerGet(),
    );
    const accessToken = decodeAccessToken(field, payload);
    // Never return refresh tokens, wrapping keys, or unrelated account data.
    process.stdout.write(JSON.stringify({ account: {
      uid: session.account?.uid, enterpriseId: session.account?.enterpriseId,
    }, auth: { accessToken, expiresAt: session.auth?.expiresAt, domain: session.auth?.domain } }));
  } catch {
    // Native/runtime exceptions can contain sensitive material. Do not print them.
    process.exitCode = 1;
  }
}

module.exports = { decodeAccessToken };
if (!module.parent) void run();
