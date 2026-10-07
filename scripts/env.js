// Generates extension/config.json from .env so the extension can pick up
// OPENROUTER_API_KEY / OPENROUTER_MODEL without typing them into the popup.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");
const outPath = path.join(root, "extension", "config.json");
const ALLOWED = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"];

if (!fs.existsSync(envPath)) {
  console.error("No .env found. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!m || !ALLOWED.includes(m[1])) continue;
  const quoted = m[2].match(/^(['"])(.*)\1(?:\s+#.*)?$/);
  const v = quoted ? quoted[2] : m[2].replace(/\s*#.*$/, "");
  if (v) env[m[1]] = v;
}

fs.writeFileSync(outPath, JSON.stringify(env, null, 2) + "\n");
console.log(`Wrote ${path.relative(root, outPath)} (${Object.keys(env).join(", ") || "no vars"})`);
