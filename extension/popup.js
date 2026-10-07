const fields = ["apiKey", "model", "concurrency", "prefetchLimit", "prompt"];
const $ = (id) => document.getElementById(id);

function flash(msg) {
  $("status").textContent = msg;
  setTimeout(() => ($("status").textContent = ""), 1500);
}

function refreshInfo() {
  chrome.runtime.sendMessage({ type: "cacheInfo" }, (c) => {
    chrome.storage.local.get("stats", ({ stats = {} }) => {
      const mb = ((c?.bytes || 0) / 1024 / 1024).toFixed(1);
      $("info").textContent = `${c?.count || 0} cached images (${mb} MB) · ${stats.generated || 0} generated`;
    });
  });
}

chrome.storage.local.get([...fields, "enabled"], (s) => {
  for (const f of fields) $(f).value = s[f] ?? "";
  $("enabled").checked = s.enabled !== false;
});

$("enabled").addEventListener("change", (e) => {
  chrome.storage.local.set({ enabled: e.target.checked });
  flash(e.target.checked ? "On" : "Off");
});

$("save").addEventListener("click", () => {
  const concurrency = Math.max(1, Math.min(10, parseInt($("concurrency").value, 10) || 1));
  chrome.storage.local.set(
    {
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim(),
      concurrency,
      prefetchLimit: Math.max(0, Math.min(200, parseInt($("prefetchLimit").value, 10) || 0)),
      prompt: $("prompt").value.trim(),
    },
    () => flash("Saved")
  );
});

$("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearCache" }, (r) => {
    flash(`Removed ${r?.removed ?? 0}`);
    refreshInfo();
  });
});

// Blank fields fall back to .env / built-in defaults; show that as a placeholder.
chrome.runtime.sendMessage({ type: "envInfo" }, (env) => {
  if (env?.hasKey) $("apiKey").placeholder = "Using key from .env";
  $("model").placeholder = env?.model || "";
});

refreshInfo();
