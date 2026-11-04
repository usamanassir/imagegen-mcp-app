// Inline viewer (MCP Apps, spec 2026-01-26). Hosts that support MCP Apps render this page in a
// sandboxed iframe next to the tool call and pass it the tool result over postMessage.
// Note: keep this free of backticks and "${" because it lives inside a template literal.
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generated image</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: var(--color-text-primary, CanvasText);
    --muted: var(--color-text-secondary, GrayText);
    --line: var(--color-border-primary, rgba(127, 127, 127, 0.3));
    --danger: var(--color-text-danger, #c62828);
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  }
  html, body { margin: 0; padding: 0; background: transparent; color: var(--fg); }
  #wrap { padding: 8px; }
  #status { display: flex; align-items: center; gap: 10px; padding: 14px 6px; font-size: 13px; color: var(--muted); }
  #status.error { color: var(--danger); white-space: pre-wrap; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--muted);
             animation: spin 0.9s linear infinite; flex: none; }
  #status.error .spinner, #status.done .spinner { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  figure { margin: 0; }
  #img { display: block; max-width: 100%; height: auto; margin: 0 auto; border-radius: 10px; }
  figcaption { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
               margin-top: 8px; font-size: 12px; color: var(--muted); }
  button { font: inherit; font-size: 12px; color: var(--fg); background: transparent; border: 1px solid var(--line);
           border-radius: 8px; padding: 5px 12px; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div id="wrap">
  <div id="status"><span class="spinner"></span><span id="statusText">Generating image…</span></div>
  <figure id="figure" hidden>
    <img id="img" alt="Generated image">
    <figcaption><span id="info"></span><button id="open" type="button" hidden>Open full size</button></figcaption>
  </figure>
</div>
<script>
(function () {
  "use strict";
  var PROTOCOL_VERSION = "2026-01-26";
  var nextId = 1;
  var pending = {};
  var fullUrl = null;
  var maxImageHeight = 640;

  function el(id) { return document.getElementById(id); }
  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function setStatus(text, kind) {
    var s = el("status");
    s.className = kind || "";
    el("statusText").textContent = text;
    s.hidden = false;
  }

  function applyContext(ctx) {
    if (!ctx) return;
    var root = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") root.style.colorScheme = ctx.theme;
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        if (k.indexOf("--") === 0 && typeof vars[k] === "string") root.style.setProperty(k, vars[k]);
      });
    }
    var dims = ctx.containerDimensions;
    if (dims && typeof dims.maxHeight === "number" && dims.maxHeight > 120) {
      maxImageHeight = Math.max(120, dims.maxHeight - 60);
    } else if (dims && typeof dims.height === "number" && dims.height > 120) {
      maxImageHeight = Math.max(120, dims.height - 60);
    }
    el("img").style.maxHeight = maxImageHeight + "px";
  }

  function textOf(result) {
    return ((result && result.content) || [])
      .filter(function (c) { return c && c.type === "text"; })
      .map(function (c) { return c.text; })
      .join("\\n");
  }

  function showResult(result) {
    if (!result) return;
    if (result.isError) { setStatus(textOf(result) || "Image generation failed.", "error"); return; }
    var sc = result.structuredContent || {};
    var block = ((result.content || []).filter(function (c) { return c && c.type === "image" && c.data; }))[0];
    fullUrl = typeof sc.url === "string" && /^https?:\\/\\//.test(sc.url) ? sc.url : null;
    var src = block ? "data:" + (block.mimeType || "image/png") + ";base64," + block.data : fullUrl;
    if (!src) { setStatus("The result has no image. Use the link in Claude's reply.", "error"); return; }

    var img = el("img");
    img.onload = function () { el("status").hidden = true; el("figure").hidden = false; };
    img.onerror = function () {
      if (fullUrl && img.src !== fullUrl) { img.src = fullUrl; return; }
      setStatus("Couldn't display the image here. Use the link in Claude's reply.", "error");
    };
    var parts = [];
    if (sc.modelLabel || sc.model) parts.push(sc.modelLabel || sc.model);
    if (sc.width && sc.height) parts.push(sc.width + " × " + sc.height);
    el("info").textContent = parts.join(" · ");
    el("open").hidden = !fullUrl;
    img.src = src;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;

    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      var p = pending[msg.id];
      if (p) { delete pending[msg.id]; if (msg.error) p.reject(msg.error); else p.resolve(msg.result); }
      return;
    }
    // Request from the host
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "ui/resource-teardown" || msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    // Notifications from the host
    switch (msg.method) {
      case "ui/notifications/tool-input":
        setStatus("Generating image…", "");
        break;
      case "ui/notifications/tool-result":
        showResult(msg.params);
        break;
      case "ui/notifications/tool-cancelled":
        setStatus("Cancelled.", "error");
        break;
      case "ui/notifications/host-context-changed":
        applyContext(msg.params);
        break;
    }
  });

  el("open").addEventListener("click", function () {
    if (!fullUrl) return;
    request("ui/open-link", { url: fullUrl }).catch(function () {
      try { window.open(fullUrl, "_blank", "noopener"); } catch (e) { /* ignore */ }
    });
  });

  var lastW = 0, lastH = 0;
  function reportSize() {
    var r = el("wrap").getBoundingClientRect();
    var w = Math.ceil(r.width), h = Math.ceil(r.height);
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    notify("ui/notifications/size-changed", { width: w, height: h });
  }

  request("ui/initialize", {
    protocolVersion: PROTOCOL_VERSION,
    appInfo: { name: "imagegen-viewer", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] }
  }).then(function (res) {
    applyContext(res && res.hostContext);
    notify("ui/notifications/initialized", {});
    if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(el("wrap"));
    reportSize();
  }).catch(function () {
    setStatus("The image viewer couldn't connect. Use the link in Claude's reply.", "error");
  });
})();
</script>
</body>
</html>
`;
