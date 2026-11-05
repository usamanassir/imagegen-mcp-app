// Inline viewer (MCP Apps, spec 2026-01-26). Hosts that support MCP Apps render this page in a
// sandboxed iframe next to the tool call and pass it the tool result over postMessage.
//
// Shows: a single image, a grid of variations (count > 1) or of list_images results, and a
// before/after pair for edits. Each image has Open, Download and Copy-link buttons. On hosts that
// let apps call server tools, an Upload button sends a local image through create_upload_link and
// posts its id into the chat.
//
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
    --bg2: var(--color-background-secondary, rgba(127, 127, 127, 0.08));
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  }
  html, body { margin: 0; padding: 0; background: transparent; color: var(--fg); }
  #wrap { padding: 8px; }
  #status { display: flex; align-items: center; gap: 10px; padding: 14px 6px; font-size: 13px; color: var(--muted); }
  #status.error { color: var(--danger); white-space: pre-wrap; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--muted);
             animation: spin 0.9s linear infinite; flex: none; }
  #status.error .spinner { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #heading { font-size: 12px; color: var(--muted); margin: 0 0 8px 2px; }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .grid.one { grid-template-columns: 1fr; }
  .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .card { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .card img { display: block; width: 100%; height: auto; max-height: var(--maxh, 640px); object-fit: contain;
              border-radius: 10px; background: var(--bg2); }
  .grid.one .card img { width: auto; max-width: 100%; margin: 0 auto; }
  .label { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label b { color: var(--fg); font-weight: 600; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  button { font: inherit; font-size: 12px; color: var(--fg); background: transparent; border: 1px solid var(--line);
           border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  #compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
  #sources { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  #sources img { height: 64px; width: auto; border-radius: 6px; background: var(--bg2); }
  #footer { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
  #toast { font-size: 12px; color: var(--muted); margin-top: 6px; min-height: 1em; }
  #copybox, #desc { box-sizing: border-box; font: inherit; font-size: 12px; padding: 4px 6px;
             border: 1px solid var(--line); border-radius: 6px; color: var(--fg); background: transparent; }
  #copybox { width: 100%; margin-top: 6px; }
  #desc { width: 200px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div id="wrap">
  <div id="status"><span class="spinner"></span><span id="statusText">Generating image…</span></div>
  <div id="result" hidden>
    <p id="heading" hidden></p>
    <div id="sources" hidden></div>
    <div id="compare" hidden></div>
    <div id="grid" class="grid"></div>
    <div id="toast"></div>
    <input id="copybox" type="text" readonly hidden>
  </div>
  <div id="footer" hidden>
    <button id="uploadBtn" type="button">Upload an image to edit…</button>
    <input id="desc" type="text" maxlength="200" placeholder="Description (optional)">
    <input id="file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
    <span id="uploadText"></span>
  </div>
</div>
<script>
(function () {
  "use strict";
  var PROTOCOL_VERSION = "2026-01-26";
  var nextId = 1;
  var pending = {};
  var maxImageHeight = 640;
  var canCallTools = false;
  var lastToolArgs = null;

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
  function toast(text) {
    el("toast").textContent = text || "";
    if (text) setTimeout(function () { if (el("toast").textContent === text) el("toast").textContent = ""; }, 4000);
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
      maxImageHeight = Math.max(120, dims.maxHeight - 90);
    } else if (dims && typeof dims.height === "number" && dims.height > 120) {
      maxImageHeight = Math.max(120, dims.height - 90);
    }
    root.style.setProperty("--maxh", maxImageHeight + "px");
  }

  // ---- links -----------------------------------------------------------------

  function openLink(url) {
    request("ui/open-link", { url: url }).catch(function () {
      try { window.open(url, "_blank", "noopener"); } catch (e) { /* ignore */ }
    });
  }
  function downloadUrl(url) { return url + (url.indexOf("?") >= 0 ? "&" : "?") + "download=1"; }
  function copyText(text) {
    var done = function () { toast("Link copied."); el("copybox").hidden = true; };
    var fallback = function () {
      var box = el("copybox");
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      if (ok) done(); else toast("Copy isn't allowed here. The link is selected below; copy it yourself.");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function button(text, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch (e) { return false; }
  }

  function textOf(result) {
    return ((result && result.content) || [])
      .filter(function (c) { return c && c.type === "text"; })
      .map(function (c) { return c.text; })
      .join("\\n");
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // ---- rendering -------------------------------------------------------------

  function makeCard(im, src, label, title) {
    var card = document.createElement("div");
    card.className = "card";
    var img = document.createElement("img");
    img.alt = title || label || "Image";
    img.loading = "lazy";
    img.onerror = function () {
      if (im.url && img.src !== im.url) { img.src = im.url; return; }
      img.alt = "Couldn't load this image. Use the link in Claude's reply.";
    };
    img.src = src;
    if (im.url) {
      img.style.cursor = "zoom-in";
      img.addEventListener("click", function () { openLink(im.url); });
    }
    card.appendChild(img);

    var lab = document.createElement("div");
    lab.className = "label";
    lab.innerHTML = label;
    if (title) lab.title = title;
    card.appendChild(lab);

    if (im.url) {
      var acts = document.createElement("div");
      acts.className = "actions";
      acts.appendChild(button("Open", function () { openLink(im.url); }));
      acts.appendChild(button("Download", function () { openLink(downloadUrl(im.url)); }));
      acts.appendChild(button("Copy link", function () { copyText(im.url); }));
      card.appendChild(acts);
    }
    return card;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  function showResult(result) {
    if (!result) return;
    if (result.isError) { setStatus(textOf(result) || "Image generation failed.", "error"); return; }
    var sc = result.structuredContent || {};
    var images = Array.isArray(sc.images) ? sc.images : (sc.url ? [sc] : []);
    var blocks = (result.content || []).filter(function (c) { return c && c.type === "image" && c.data; });
    if (!images.length && !blocks.length) {
      setStatus("The result has no image. Use the link in Claude's reply.", "error");
      return;
    }
    if (!images.length) images = [{ url: null }];

    var grid = el("grid");
    grid.innerHTML = "";
    el("compare").innerHTML = "";
    el("compare").hidden = true;
    el("sources").innerHTML = "";
    el("sources").hidden = true;
    el("heading").hidden = true;
    el("copybox").hidden = true;

    var isList = sc.kind === "list";
    var firstUrl = (images[0] && images[0].url) || sc.url || "";

    // Base64 previews are in the same order as images with preview !== false.
    var bi = 0;
    var cards = images.map(function (im, i) {
      var block = null;
      if (im.preview !== false && blocks[bi]) { block = blocks[bi]; bi++; }
      var src = block ? "data:" + (block.mimeType || "image/png") + ";base64," + block.data : im.url;
      var label, title;
      if (isList) {
        var what = im.tool === "upload" ? "uploaded" : (im.model || im.tool || "");
        var desc = im.prompt || im.description || "";
        label = "<b>" + esc(fmtDate(im.created)) + "</b> · " + esc(what) + (desc ? " · " + esc(desc) : "");
        title = desc + "\\n" + (im.created || "") + "\\nid " + (im.id || "");
      } else {
        var parts = [];
        if (im.prompt) parts.push("<b>" + esc(im.prompt.length > 60 ? im.prompt.slice(0, 60) + "…" : im.prompt) + "</b>");
        else if (images.length > 1) parts.push("<b>Variation " + (i + 1) + "</b>");
        else if (sc.modelLabel || sc.model) parts.push(esc(sc.modelLabel || sc.model));
        if (im.width && im.height) parts.push(im.width + " × " + im.height);
        label = parts.join(" · ");
        title = (im.prompt ? im.prompt + "\\n" : "") + (im.id ? "id " + im.id : "");
      }
      return makeCard(im, src, label, title);
    });

    // Before/after for an edit with one result; a source strip otherwise.
    var sources = (Array.isArray(sc.sources) ? sc.sources : []).filter(function (s) {
      return s && typeof s.url === "string" && sameOrigin(s.url, firstUrl);
    });
    if (!isList && sources.length && cards.length === 1) {
      var before = makeCard(sources[0], sources[0].url, "<b>Before</b>", sources[0].id ? "id " + sources[0].id : "");
      var afterLabel = cards[0].querySelector(".label");
      afterLabel.innerHTML = "<b>After</b>" + (afterLabel.innerHTML ? " · " + afterLabel.innerHTML : "");
      el("compare").appendChild(before);
      el("compare").appendChild(cards[0]);
      el("compare").hidden = false;
      cards = [];
    } else if (!isList && sources.length) {
      var strip = el("sources");
      var cap = document.createElement("span");
      cap.className = "label";
      cap.textContent = "Source" + (sources.length > 1 ? "s" : "") + ":";
      strip.appendChild(cap);
      sources.forEach(function (s) {
        var t = document.createElement("img");
        t.src = s.url;
        t.alt = "Source image";
        t.style.cursor = "zoom-in";
        t.addEventListener("click", function () { openLink(s.url); });
        strip.appendChild(t);
      });
      strip.hidden = false;
    }

    if (isList) {
      var h = el("heading");
      h.textContent = images.length
        ? images.length + (sc.total > images.length ? " of " + sc.total : "") + " image" + (sc.total === 1 ? "" : "s") +
          (sc.query ? ' matching "' + sc.query + '"' : "") + ", newest first"
        : (sc.query ? 'No images match "' + sc.query + '".' : "No images stored yet.");
      h.hidden = false;
    }

    grid.className = "grid " + (cards.length === 1 ? "one" : cards.length === 2 || cards.length === 4 ? "two" : "");
    cards.forEach(function (c) { grid.appendChild(c); });

    el("status").hidden = true;
    el("result").hidden = false;
  }

  // ---- upload (hosts that allow server tool calls) ----------------------------

  function setUploadText(t) { el("uploadText").textContent = t || ""; }

  el("uploadBtn").addEventListener("click", function () { el("file").click(); });
  el("file").addEventListener("change", function () {
    var file = el("file").files && el("file").files[0];
    el("file").value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setUploadText("That file is over 20 MB."); return; }
    el("uploadBtn").disabled = true;
    setUploadText("Uploading " + file.name + "…");
    var info = null;
    var description = el("desc").value.trim();
    request("tools/call", { name: "create_upload_link", arguments: description ? { description: description } : {} })
      .then(function (res) {
        var sc = (res && res.structuredContent) || {};
        if (res && res.isError || !sc.uploadUrl) throw new Error(textOf(res) || "Couldn't get an upload link.");
        return fetch(sc.uploadUrl, { method: "PUT", body: file });
      })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t }; }); })
      .then(function (r) {
        var j = {};
        try { j = JSON.parse(r.text); } catch (e) { /* ignore */ }
        if (!r.ok) throw new Error(j.error || ("Upload failed (HTTP " + r.status + ")."));
        info = j;
        el("desc").value = "";
        var text = "I uploaded an image to the image server (id " + j.id + ", " + j.url + ")" +
          (description ? ": " + description : "") + ". Please use it for the edit I asked for.";
        return request("ui/message", { role: "user", content: [{ type: "text", text: text }] })
          .then(function () { setUploadText("Uploaded. Its id was sent to the chat: " + j.id); })
          .catch(function () {
            setUploadText("Uploaded. Tell Claude to edit image id " + j.id + ".");
            copyText(j.id);
          });
      })
      .catch(function (err) { setUploadText((err && err.message) || "Upload failed."); })
      .then(function () { el("uploadBtn").disabled = false; });
  });

  // ---- host protocol ---------------------------------------------------------

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
      case "ui/notifications/tool-input": {
        var a = (msg.params && msg.params.arguments) || {};
        lastToolArgs = a;
        var n = (Number(a.count) || 1) * (Array.isArray(a.prompts) ? a.prompts.length : 1);
        setStatus(a.prompt || a.prompts ? (n > 1 ? "Generating " + n + " images…" : "Generating image…") : "Loading…", "");
        break;
      }
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
    appInfo: { name: "imagegen-viewer", version: "1.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] }
  }).then(function (res) {
    applyContext(res && res.hostContext);
    var caps = (res && res.hostCapabilities) || {};
    canCallTools = !!caps.serverTools;
    el("footer").hidden = !canCallTools;
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
