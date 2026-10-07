// Service worker: fetches listing images, sends them to an OpenRouter image model for a
// Minecraft-style re-render, caches results, and hands back data URLs.

importScripts("canon.js"); // photoInfo(): one id per photo across size variants

const DEFAULTS = {
  enabled: true,
  apiKey: "",
  model: "google/gemini-3.1-flash-image",
  concurrency: 1,
  prefetchLimit: 30, // off-screen photos per page to pre-generate; 0 = only what's on screen
  prompt:
    "Transform this real estate listing photo into a Minecraft screenshot. " +
    "Rebuild every element (house, rooms, furniture, yard, sky, trees) out of " +
    "blocky voxel Minecraft blocks with pixelated 16x16 textures. Keep the exact " +
    "same camera angle, composition, layout and lighting so it is clearly the same " +
    "property. No text, no UI, no watermark.",
};

// Not persisted on install, so edits to .env take effect after a reload
// unless the user has typed an override into the popup.
const ENV_BACKED = ["apiKey", "model"];

const MAX_INPUT_DIM = 1024;
const MODEL_TIMEOUT_MS = 90_000; // a hung request would otherwise block the queue
const SOURCE_TIMEOUT_MS = 20_000;
const CACHE_PREFIX = "img:";

// config.json is generated from .env by `npm run env` and is optional.
// Loaded via fetch rather than importScripts: a missing importScripts target
// breaks service worker registration even inside try/catch.
let envPromise;
function getEnv() {
  envPromise ??= fetch(chrome.runtime.getURL("config.json"))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return envPromise;
}

// Precedence: popup value > .env > built-in default.
async function getSettings() {
  const env = await getEnv();
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const s = { ...DEFAULTS };
  if (env.OPENROUTER_API_KEY) s.apiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_MODEL) s.model = env.OPENROUTER_MODEL;
  for (const [k, v] of Object.entries(stored)) if (v !== "" && v != null) s[k] = v;
  return s;
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  // Pre-OpenRouter installs stored a bare Gemini model id and a Google key.
  if (current.model && !current.model.includes("/")) {
    current.model = undefined;
    current.apiKey = undefined;
    await chrome.storage.local.remove(["model", "apiKey"]);
  }
  // Earlier versions persisted the default model, which would shadow .env.
  if (current.model === "google/gemini-2.5-flash-image") {
    current.model = undefined;
    await chrome.storage.local.remove("model");
  }
  // One-at-a-time is now the default; drop older stored values.
  if (current.concurrency !== undefined && current.concurrency !== 1) {
    current.concurrency = undefined;
    await chrome.storage.local.remove("concurrency");
  }
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([k]) => current[k] === undefined && !ENV_BACKED.includes(k))
  );
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

// ---------- priority queue + in-flight dedupe ----------
// Two lanes: "high" = on screen now (LIFO, newest first), "low" = pre-generation
// of off-screen photos (FIFO, page order). High always runs before low.

const inflight = new Map(); // photo id -> Promise<entry>
const lanes = new Map(); // photo id -> "high" | "low" | "cancel"
const queue = [];
let active = 0;

function setLane(id, lane) {
  if (lane === "low" && lanes.get(id) === "high") return; // never demote via a prefetch request
  lanes.set(id, lane);
  const job = queue.find((j) => j.id === id);
  if (!job) return;
  if (lane === "cancel") {
    queue.splice(queue.indexOf(job), 1);
    job.reject(new Error("cancelled"));
  } else {
    job.lane = lane;
  }
}

function schedule(id, task) {
  if (lanes.get(id) === "cancel") return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    queue.push({ id, lane: lanes.get(id) || "low", task, resolve, reject });
    pump();
  });
}

function nextJob() {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].lane === "high") return queue.splice(i, 1)[0];
  return queue.shift();
}

async function pump() {
  const { concurrency } = await getSettings();
  while (active < concurrency && queue.length) {
    const { task, resolve, reject } = nextJob();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

// ---------- image helpers ----------

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Re-encode as JPEG, scaled to fit maxDim, or cover-cropped to exactly w x h.
async function toJpeg(blob, { maxDim, w, h, quality = 0.85 }) {
  const bmp = await createImageBitmap(blob);
  if (!w || !h) {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    w = Math.round(bmp.width * scale);
    h = Math.round(bmp.height * scale);
  }
  const s = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  bmp.close();
  return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality }), w, h };
}

const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function nearestAspect(w, h) {
  const r = Math.log(w / h);
  return ASPECTS.reduce((best, a) => {
    const [x, y] = a.split(":").map(Number);
    const [bx, by] = best.split(":").map(Number);
    return Math.abs(Math.log(x / y) - r) < Math.abs(Math.log(bx / by) - r) ? a : best;
  });
}

async function cacheKey(url) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url));
  return CACHE_PREFIX + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- OpenRouter ----------

async function callModel(inputDataUrl, aspectRatio, settings, attempt = 0) {
  const res = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
      "X-Title": "Minecraftify Listings",
    },
    body: JSON.stringify({
      model: settings.model,
      prompt: settings.prompt,
      input_references: [{ type: "image_url", image_url: { url: inputDataUrl } }],
      aspect_ratio: aspectRatio,
      resolution: "1K",
      output_format: "jpeg",
      n: 1,
    }),
  });

  if ([429, 500, 502, 524, 529].includes(res.status) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return callModel(inputDataUrl, aspectRatio, settings, attempt + 1);
  }
  if (!res.ok) {
    let msg = await res.text();
    try {
      msg = JSON.parse(msg).error?.message || msg;
    } catch {}
    throw new Error(`OpenRouter ${res.status}: ${msg.slice(0, 300)}`);
  }

  const json = await res.json();
  const img = json.data?.[0];
  if (!img?.b64_json) throw new Error("OpenRouter: no image returned");
  return `data:${img.media_type || "image/jpeg"};base64,${img.b64_json}`;
}

// Cache entry: { dataUrl, w, h } generated at the source photo's own shape.
async function minecraftify(info) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("No OpenRouter API key set. Open the extension popup.");

  const key = await cacheKey(info.id);
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached?.dataUrl) return cached;

  const srcRes = await fetch(info.src, { credentials: "omit", signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!srcRes.ok) throw new Error(`Fetch source ${srcRes.status}`);
  const input = await toJpeg(await srcRes.blob(), { maxDim: MAX_INPUT_DIM });
  const inputDataUrl = `data:image/jpeg;base64,${await blobToBase64(input.blob)}`;

  const out = await schedule(info.id, async () => {
    const t0 = performance.now();
    const r = await callModel(inputDataUrl, nearestAspect(input.w, input.h), settings);
    console.log(
      `[minecraftify] ${settings.model} ${Math.round(performance.now() - t0)}ms (${lanes.get(info.id)})`,
      info.id
    );
    return r;
  });

  // Crop to the source's exact shape (models snap to preset ratios) and keep the cache small.
  const outBlob = await (await fetch(out)).blob();
  const outJpeg = await toJpeg(outBlob, { w: input.w, h: input.h, quality: 0.88 });
  const entry = { dataUrl: `data:image/jpeg;base64,${await blobToBase64(outJpeg.blob)}`, w: input.w, h: input.h };

  await chrome.storage.local.set({ [key]: entry });
  await bumpStat("generated");
  return entry;
}

// The same photo shows up at other aspect ratios (e.g. 4:3 hero, 3:2 gallery
// crop). Re-crop the cached render locally instead of generating again.
const cropMemo = new Map();
async function fitToAspect(entry, w, h) {
  if (!w || !h || !entry.w || !entry.h) return entry.dataUrl;
  const want = w / h;
  const have = entry.w / entry.h;
  if (Math.abs(Math.log(want / have)) < 0.03) return entry.dataUrl;
  const [cw, ch] = want > have ? [entry.w, Math.round(entry.w / want)] : [Math.round(entry.h * want), entry.h];
  const memoKey = `${entry.dataUrl.length}:${entry.dataUrl.slice(-32)}:${cw}x${ch}`;
  if (!cropMemo.has(memoKey)) {
    if (cropMemo.size > 100) cropMemo.delete(cropMemo.keys().next().value);
    const blob = await (await fetch(entry.dataUrl)).blob();
    const out = await toJpeg(blob, { w: cw, h: ch, quality: 0.88 });
    cropMemo.set(memoKey, `data:image/jpeg;base64,${await blobToBase64(out.blob)}`);
  }
  return cropMemo.get(memoKey);
}

function generate(info) {
  let p = inflight.get(info.id);
  if (!p) {
    p = minecraftify(info).finally(() => {
      inflight.delete(info.id);
      lanes.delete(info.id);
    });
    inflight.set(info.id, p);
  }
  return p;
}

async function bumpStat(name) {
  const { stats = {} } = await chrome.storage.local.get("stats");
  stats[name] = (stats[name] || 0) + 1;
  await chrome.storage.local.set({ stats });
}

// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // { url, w, h, priority: "high" | "low" } -> { id, dataUrl } | { error }
  if (msg?.type === "minecraftify") {
    const info = photoInfo(msg.url);
    setLane(info.id, msg.priority === "high" ? "high" : "low");
    generate(info)
      .then((entry) => fitToAspect(entry, msg.w, msg.h))
      .then(
        (dataUrl) => sendResponse({ id: info.id, dataUrl }),
        (err) => {
          const error = String(err.message || err);
          if (error !== "cancelled") console.warn("[minecraftify]", info.id, err);
          sendResponse({ id: info.id, error });
        }
      );
    return true; // async response
  }

  // Cache-only lookup: never queues a generation.
  if (msg?.type === "lookup") {
    const info = photoInfo(msg.url);
    cacheKey(info.id)
      .then((key) => chrome.storage.local.get(key).then((r) => r[key]))
      .then((entry) => (entry?.dataUrl ? fitToAspect(entry, msg.w, msg.h) : null))
      .then((dataUrl) => sendResponse({ id: info.id, dataUrl }), () => sendResponse({ id: info.id }));
    return true;
  }

  // Image left the screen before its turn: keep it as background work, or drop it.
  if (msg?.type === "leave") {
    const id = photoInfo(msg.url).id;
    if (lanes.get(id) !== "high") return;
    getSettings().then((s) => setLane(id, s.prefetchLimit > 0 ? "low" : "cancel"));
    return;
  }

  if (msg?.type === "envInfo") {
    getEnv().then((env) =>
      sendResponse({ hasKey: !!env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || DEFAULTS.model })
    );
    return true;
  }

  if (msg?.type === "clearCache") {
    chrome.storage.local.get(null).then(async (all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
      await chrome.storage.local.remove(keys);
      await chrome.storage.local.set({ stats: {} });
      sendResponse({ removed: keys.length });
    });
    return true;
  }

  if (msg?.type === "cacheInfo") {
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
      const bytes = keys.reduce((n, k) => n + (all[k].dataUrl ?? all[k]).length, 0);
      sendResponse({ count: keys.length, bytes });
    });
    return true;
  }
});
