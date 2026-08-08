const crypto = require("node:crypto");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function sha256(value) {
  const input = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(canonicalize(value)));
  return crypto.createHash("sha256").update(input).digest("hex");
}

function localId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.join("|")).slice(0, 20)}`;
}

function localTxHash(...parts) {
  return `0x${sha256(parts.join("|"))}`;
}

module.exports = { canonicalize, sha256, localId, localTxHash };
