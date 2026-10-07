// Times Minecraft-style edits of one photo across fast OpenRouter image models.
// Usage: npm run bench -- <image path or URL> [model ...]
// Reads OPENROUTER_API_KEY from .env. Each model run is a paid generation.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "bench-out");

const CANDIDATES = [
  "google/gemini-3.1-flash-lite-image",
  "google/gemini-2.5-flash-image",
  "google/gemini-3.1-flash-image",
  "bytedance-seed/seedream-5-0-flash",
  "black-forest-labs/flux.2-klein-4b",
  "krea/krea-2-medium-turbo",
  "sourceful/riverflow-v2.5-fast",
  "microsoft/mai-image-2.6-flash",
  "openai/gpt-image-1-mini",
];

const PROMPT =
  "Transform this real estate listing photo into a Minecraft screenshot. " +
  "Rebuild every element out of blocky voxel Minecraft blocks with pixelated 16x16 textures. " +
  "Keep the exact same camera angle, composition and layout. No text, no UI, no watermark.";

function readKey() {
  const env = fs.readFileSync(path.join(root, ".env"), "utf8");
  const m = env.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*['"]?([^'"\s#]+)/m);
  if (!m) throw new Error("OPENROUTER_API_KEY missing from .env");
  return m[1];
}

async function loadImage(src) {
  if (/^https?:/.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`fetch ${src}: ${r.status}`);
    const type = r.headers.get("content-type") || "image/jpeg";
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
  }
  const ext = path.extname(src).slice(1).toLowerCase().replace("jpg", "jpeg");
  return `data:image/${ext};base64,${fs.readFileSync(src).toString("base64")}`;
}

async function run(model, image, key) {
  const t0 = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      prompt: PROMPT,
      input_references: [{ type: "image_url", image_url: { url: image } }],
      resolution: "1K",
      output_format: "jpeg",
      n: 1,
    }),
  });
  const ms = Math.round(performance.now() - t0);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.data?.[0]?.b64_json) {
    return { model, ms, error: json.error?.message || `HTTP ${res.status}` };
  }
  const file = path.join(outDir, model.replace(/\//g, "__") + ".jpg");
  fs.writeFileSync(file, Buffer.from(json.data[0].b64_json, "base64"));
  return { model, ms, cost: json.usage?.cost, file: path.relative(root, file) };
}

(async () => {
  const [src, ...models] = process.argv.slice(2);
  if (!src) {
    console.error("Usage: npm run bench -- <image path or URL> [model ...]");
    process.exit(1);
  }
  const key = readKey();
  const image = await loadImage(src);
  fs.mkdirSync(outDir, { recursive: true });

  // Sequential so timings aren't skewed by our own concurrency.
  const results = [];
  for (const model of models.length ? models : CANDIDATES) {
    process.stdout.write(`${model} ... `);
    const r = await run(model, image, key).catch((e) => ({ model, ms: NaN, error: e.message }));
    console.log(r.error ? `FAIL ${r.error}` : `${r.ms}ms`);
    results.push(r);
  }

  console.log("\nFastest first:");
  for (const r of results.filter((r) => !r.error).sort((a, b) => a.ms - b.ms)) {
    const cost = r.cost != null ? ` $${r.cost.toFixed(4)}` : "";
    console.log(`  ${String(r.ms).padStart(6)}ms${cost}  ${r.model}  -> ${r.file}`);
  }
})();
