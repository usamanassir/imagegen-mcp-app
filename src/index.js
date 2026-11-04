/**
 * imagegen-mcp — a remote MCP server on Cloudflare Workers that lets Claude
 * (web, mobile, desktop, Claude Code) generate and edit images with
 * OpenAI GPT Image 2.5 and Google Nano Banana.
 *
 * Endpoints
 *   POST /mcp/<MCP_TOKEN>   MCP endpoint (token in the URL), or
 *   POST /mcp               MCP endpoint with "Authorization: Bearer <MCP_TOKEN>"
 *   GET  /img/<id>.<ext>    Generated images (public, unguessable ids, stored in R2)
 *
 * Secrets (npx wrangler secret put NAME): MCP_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY
 * Settings ("vars" in wrangler.jsonc): DEFAULT_MODEL, DEFAULT_QUALITY, DAILY_LIMIT, ...
 */
import { Buffer } from "node:buffer";
import { VIEWER_HTML } from "./viewer.js";

const SERVER_INFO = { name: "imagegen-mcp", title: "Image Generator", version: "1.0.0" };

// MCP protocol revisions this server speaks (initialize-based "legacy" era).
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// MCP Apps (inline viewer shown in the chat by hosts that support it).
const UI_URI = "ui://imagegen/viewer.html";
const UI_MIME = "text/html;profile=mcp-app";
const UI_EXTENSION = "io.modelcontextprotocol/ui";

// Models the tools offer. A model only shows up if its provider's API key is set.
// To add another model from the same providers, add a line here.
const MODELS = {
  "gpt-image-2.5-flare": {
    provider: "openai",
    label: "OpenAI GPT Image 2.5 Flare",
    note: "fast, high quality, excellent text rendering; good default",
  },
  "gpt-image-2.5-sunburst": {
    provider: "openai",
    label: "OpenAI GPT Image 2.5 Sunburst",
    note: "slower; best fidelity and the most precise edits",
  },
  "gemini-nano-banana-2.1": {
    provider: "google",
    label: "Google Nano Banana 2.1",
    note: "strong at editing and at combining several reference images",
  },
  "gemini-3.1-flash-image": {
    provider: "google",
    label: "Google Nano Banana 2",
    note: "cheaper, faster Google model",
  },
};

// Ratios accepted by both the OpenAI and the Gemini image APIs.
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const RESOLUTIONS = ["1K", "2K", "4K"];
const QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"];
const FORMATS = ["jpeg", "png", "webp"];
const BACKGROUNDS = ["auto", "transparent", "opaque"];

const MAX_PROMPT_CHARS = 32000;
const MAX_INPUT_IMAGES = 8;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_PREVIEW_MAX_BYTES = 1_500_000; // larger images are linked only (keeps CPU low on the Workers Free plan)

const INSTRUCTIONS = [
  "Image generation tools.",
  "Use generate_image when the user wants a new picture (photo, illustration, logo, poster, icon, mockup art).",
  "Use edit_image to change or remix an image: pass the URL of an image returned earlier (or a public image URL).",
  "Write rich prompts: subject, setting, style or medium, composition, lighting, colors, mood; put any text that must appear in the image in quotes.",
  "After each call, give the user the image link from the result so they can open or download it.",
].join(" ");

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

      if (url.pathname.startsWith("/img/")) return await serveImage(request, env, url);

      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        return await handleMcp(request, env, ctx, url);
      }

      if (url.pathname === "/" || url.pathname === "") return statusPage(env, url);
      return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (err) {
      console.error("Unhandled error", err?.stack || err);
      return new Response("Internal error\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  },
};

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP (stateless; protocol revisions 2024-11-05 .. 2025-11-25)
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "86400",
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class ToolError extends Error {}

async function handleMcp(request, env, ctx, url) {
  // 1. Origin check (DNS-rebinding protection required by the MCP spec).
  const origin = request.headers.get("origin");
  if (origin && !originAllowed(origin, env, url)) {
    return jsonResponse(rpcErrorBody(null, -32600, `Origin not allowed: ${origin}`), 403);
  }

  // 2. Authentication: token in the path (/mcp/<token>) or as a Bearer token.
  const problem = tokenProblem(env);
  if (problem) {
    return textResponse(
      `Server not configured: ${problem}. Set it in the Cloudflare dashboard (Worker → Settings → Variables and Secrets) ` +
        "or with: npx wrangler secret put MCP_TOKEN",
      500,
    );
  }
  const pathToken = url.pathname.startsWith("/mcp/") ? safeDecode(url.pathname.slice(5)) : "";
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = pathToken || bearer;
  if (!token || !safeEqual(token, env.MCP_TOKEN)) {
    return new Response(JSON.stringify(rpcErrorBody(null, -32001, "Unauthorized")), {
      status: 401,
      headers: { ...CORS_HEADERS, "content-type": "application/json", "www-authenticate": 'Bearer realm="imagegen-mcp"' },
    });
  }

  // 3. Only POST is used; no standalone SSE stream and no session termination.
  if (request.method !== "POST") {
    return new Response("Method not allowed\n", { status: 405, headers: { ...CORS_HEADERS, allow: "POST, OPTIONS" } });
  }

  // 4. Protocol version header. Unsupported (including newer, stateless) revisions get a plain
  //    400 so dual-era clients fall back to the initialize handshake.
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion)) {
    return unsupportedVersion(headerVersion);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcErrorBody(null, -32700, "Parse error: body must be JSON"), 400);
  }

  const sessionId = request.headers.get("mcp-session-id") || "";
  const state = {
    env,
    ctx,
    origin: url.origin,
    // Sessions are stateless: the id minted at initialize records whether the client
    // advertised MCP Apps support ("u1.") or not ("u0.").
    ui: !sessionId.startsWith("u0."),
  };
  const wantsSse = (request.headers.get("accept") || "").includes("text/event-stream");

  // Batches (allowed by 2025-03-26 clients): answer as a JSON array.
  if (Array.isArray(body)) {
    if (body.some(isModernMessage)) return unsupportedVersion(modernVersionOf(body.find(isModernMessage)));
    const responses = [];
    for (const msg of body) {
      const out = await dispatch(msg, state);
      if (out?.response) responses.push(out.response);
    }
    if (!responses.length) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return jsonResponse(responses, 200);
  }

  if (!body || typeof body !== "object" || body.jsonrpc !== "2.0") {
    return jsonResponse(rpcErrorBody(null, -32600, "Invalid Request"), 400);
  }
  if (isModernMessage(body)) return unsupportedVersion(modernVersionOf(body));

  // Notifications and client responses: acknowledge.
  if (body.method === undefined || body.id === undefined || body.id === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  // tools/call can take a while (image generation): stream SSE with keep-alives.
  if (body.method === "tools/call" && wantsSse) {
    return streamToolCall(body, state);
  }

  const out = await dispatch(body, state);
  const headers = {};
  if (out?.sessionId) headers["mcp-session-id"] = out.sessionId;
  return jsonResponse(out.response, 200, headers);
}

function streamToolCall(msg, state) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const progressToken = msg.params?._meta?.progressToken;
  const interval = clampInt(state.env.KEEPALIVE_MS, 1000, 60000, 10000);

  const run = (async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      let chunk = ": keep-alive\n\n";
      if (progressToken !== undefined) {
        const note = {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: ticks, message: `Generating image (${Math.round((ticks * interval) / 1000)} s)…` },
        };
        chunk += `event: message\ndata: ${JSON.stringify(note)}\n\n`;
      }
      writer.write(encoder.encode(chunk)).catch(() => {});
    }, interval);
    try {
      const out = await dispatch(msg, state);
      await writer.write(encoder.encode(`event: message\ndata: ${stringifyFast(out.response)}\n\n`));
    } catch (err) {
      console.error("stream error", err?.stack || err);
    } finally {
      clearInterval(timer);
      await writer.close().catch(() => {});
    }
  })();
  state.ctx?.waitUntil?.(run);

  return new Response(readable, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function dispatch(msg, state) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return { response: rpcErrorBody(msg?.id ?? null, -32600, "Invalid Request") };
  }
  const isRequest = msg.method !== undefined && msg.id !== undefined && msg.id !== null;
  if (!isRequest) return null; // notification or client response: nothing to send back

  try {
    const { result, sessionId } = await handleRequest(msg.method, msg.params || {}, state);
    return { response: { jsonrpc: "2.0", id: msg.id, result }, sessionId };
  } catch (err) {
    if (err instanceof RpcError) return { response: rpcErrorBody(msg.id, err.code, err.message, err.data) };
    console.error("request failed", msg.method, err?.stack || err);
    return { response: rpcErrorBody(msg.id, -32603, "Internal error") };
  }
}

async function handleRequest(method, params, state) {
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      const uiCap = params.capabilities?.extensions?.[UI_EXTENSION];
      const ui = Array.isArray(uiCap?.mimeTypes) && uiCap.mimeTypes.includes(UI_MIME);
      return {
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
        sessionId: `${ui ? "u1" : "u0"}.${randomId()}`,
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: toolDefinitions(state.env, state.ui) } };
    case "tools/call": {
      const name = params.name;
      if (name !== "generate_image" && name !== "edit_image") {
        throw new RpcError(-32602, `Unknown tool: ${name}`);
      }
      return { result: await runImageTool(name, params.arguments || {}, state) };
    }
    case "resources/list":
      return {
        result: {
          resources: [
            {
              uri: UI_URI,
              name: "image_viewer",
              title: "Image viewer",
              description: "Shows generated images inline in the conversation.",
              mimeType: UI_MIME,
            },
          ],
        },
      };
    case "resources/templates/list":
      return { result: { resourceTemplates: [] } };
    case "resources/read": {
      if (params.uri !== UI_URI) throw new RpcError(-32002, "Resource not found", { uri: params.uri });
      return {
        result: {
          contents: [
            {
              uri: UI_URI,
              mimeType: UI_MIME,
              text: VIEWER_HTML,
              _meta: { ui: { csp: { resourceDomains: [state.origin] }, prefersBorder: true } },
            },
          ],
        },
      };
    }
    case "prompts/list":
      return { result: { prompts: [] } };
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function availableModels(env) {
  const ids = Object.keys(MODELS).filter((id) => {
    const p = MODELS[id].provider;
    return (p === "openai" && env.OPENAI_API_KEY) || (p === "google" && env.GEMINI_API_KEY);
  });
  return ids.length ? ids : Object.keys(MODELS);
}

function defaultModel(env) {
  const models = availableModels(env);
  return models.includes(env.DEFAULT_MODEL) ? env.DEFAULT_MODEL : models[0];
}

function defaultQuality(env) {
  return QUALITIES.includes(env.DEFAULT_QUALITY) ? env.DEFAULT_QUALITY : "medium";
}

function toolDefinitions(env, ui) {
  const models = availableModels(env);
  const modelHelp = models.map((id) => `${id}: ${MODELS[id].label} (${MODELS[id].note})`).join("; ");
  const common = {
    model: {
      type: "string",
      enum: models,
      default: defaultModel(env),
      description: `Image model. ${modelHelp}.`,
    },
    resolution: {
      type: "string",
      enum: RESOLUTIONS,
      default: "1K",
      description: "Output size class. 1K is fastest and cheapest; 2K and 4K are slower and cost more.",
    },
    quality: {
      type: "string",
      enum: QUALITIES,
      default: defaultQuality(env),
      description: "OpenAI models only. Higher quality is slower and costs more; use high/xhigh/max only when asked for the best quality.",
    },
    format: {
      type: "string",
      enum: FORMATS,
      default: "jpeg",
      description: "OpenAI models only. Output file format; png or webp keep transparency.",
    },
    background: {
      type: "string",
      enum: BACKGROUNDS,
      description: "OpenAI models only. 'transparent' needs png or webp and is not supported by every model.",
    },
  };
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const meta = ui ? { _meta: { ui: { resourceUri: UI_URI } } } : {};

  return [
    {
      name: "generate_image",
      title: "Generate image",
      description:
        "Create a new image from a text description. Returns a public link to the full-size image (always share it with the user) " +
        "and the image itself so you can check the result. Takes roughly 10-60 seconds.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed description: subject, setting, style or medium, composition, lighting, colors, mood. Put exact text to render in quotes.",
          },
          aspect_ratio: { type: "string", enum: ASPECT_RATIOS, default: "1:1", description: "Width:height of the image." },
          ...common,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: { title: "Generate image", ...annotations },
      ...meta,
    },
    {
      name: "edit_image",
      title: "Edit image",
      description:
        "Edit or remix existing images, or combine several reference images, following a text instruction. Pass image URLs returned " +
        "by earlier generate_image/edit_image calls (or their ids, or public https image URLs). Returns a new image link.",
      inputSchema: {
        type: "object",
        properties: {
          images: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_INPUT_IMAGES,
            description: "Images to edit or use as references (URLs from earlier results preferred).",
          },
          prompt: {
            type: "string",
            description: "What to change or create, e.g. 'make it night time, keep everything else identical'.",
          },
          aspect_ratio: {
            type: "string",
            enum: ASPECT_RATIOS,
            description: "Optional. Leave out to keep the first image's shape.",
          },
          ...common,
        },
        required: ["images", "prompt"],
        additionalProperties: false,
      },
      annotations: { title: "Edit image", ...annotations },
      ...meta,
    },
  ];
}

function normalizeArgs(tool, args, env) {
  if (!args || typeof args !== "object") throw new ToolError("Arguments must be an object.");
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new ToolError("'prompt' is required.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new ToolError(`'prompt' is too long (max ${MAX_PROMPT_CHARS} characters).`);

  const models = availableModels(env);
  const model = args.model ?? defaultModel(env);
  if (!MODELS[model]) throw new ToolError(`Unknown model '${model}'. Available: ${models.join(", ")}.`);

  const pick = (name, allowed, fallback) => {
    const v = args[name] ?? fallback;
    if (v === undefined) return undefined;
    if (!allowed.includes(v)) throw new ToolError(`Invalid ${name} '${v}'. Allowed: ${allowed.join(", ")}.`);
    return v;
  };
  const opts = {
    prompt,
    model,
    provider: MODELS[model].provider,
    aspectRatio: pick("aspect_ratio", ASPECT_RATIOS, tool === "generate_image" ? "1:1" : undefined),
    resolution: pick("resolution", RESOLUTIONS, "1K"),
    quality: pick("quality", QUALITIES, defaultQuality(env)),
    format: pick("format", FORMATS, "jpeg"),
    background: pick("background", BACKGROUNDS, undefined),
    images: [],
  };
  if (opts.background === "transparent" && opts.format === "jpeg") opts.format = "png";

  if (tool === "edit_image") {
    if (!Array.isArray(args.images) || args.images.length === 0) {
      throw new ToolError("'images' must list at least one image URL or id.");
    }
    if (args.images.length > MAX_INPUT_IMAGES) throw new ToolError(`At most ${MAX_INPUT_IMAGES} images.`);
    opts.images = args.images.map((s) => String(s));
  }
  return opts;
}

async function runImageTool(tool, args, state) {
  const { env, origin } = state;
  try {
    const opts = normalizeArgs(tool, args, env);
    const keyName = opts.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    if (!env[keyName]) {
      throw new ToolError(`${keyName} is not set on the server, so ${opts.model} can't be used. Pick another model or add the key.`);
    }
    if (!env.IMAGES) throw new ToolError("R2 bucket binding IMAGES is missing (see wrangler.jsonc).");

    const usage = await checkDailyLimit(env);
    const inputs = tool === "edit_image" ? await loadInputImages(env, origin, opts.images) : [];

    // First input image decides the shape of an edit when no aspect ratio was given.
    let sizeHint = null;
    if (!opts.aspectRatio && inputs[0]?.dims) sizeHint = inputs[0].dims;

    const started = Date.now();
    const gen =
      opts.provider === "openai"
        ? await openAiImage(env, opts, inputs, sizeHint)
        : await geminiImage(env, opts, inputs);
    const bytes = Buffer.from(gen.b64, "base64");
    const mimeType = sniffMime(bytes) || gen.mimeType || "image/png";
    const dims = imageDimensions(bytes);

    const stored = await storeImage(env, origin, bytes, mimeType, {
      model: opts.model,
      tool,
      prompt: truncateUtf8(opts.prompt, 600),
      created: new Date().toISOString(),
    });
    await bumpDailyCount(env, usage);
    console.log(
      JSON.stringify({ event: "image", tool, model: opts.model, ms: Date.now() - started, bytes: bytes.length, dims }),
    );

    const previewMax = clampInt(env.PREVIEW_MAX_BYTES, 0, 4_500_000, DEFAULT_PREVIEW_MAX_BYTES);
    const attachPreview = env.PREVIEW_TO_CLAUDE !== "false" && bytes.length <= previewMax;
    const size = dims ? `${dims.width}x${dims.height}` : "unknown size";
    const lines = [
      `Image ready: ${stored.url}`,
      `Model: ${MODELS[opts.model].label} · ${size} · ${mimeType}`,
      `Image id: ${stored.id} (pass the link to edit_image to change it)`,
      "Share the link with the user so they can open or download the full-size image.",
    ];
    if (gen.note) lines.push(`Model note: ${gen.note}`);
    if (!attachPreview) lines.push("(The image is large, so it is not attached here; open the link to see it.)");

    const content = [{ type: "text", text: lines.join("\n") }];
    // Re-encode from the decoded bytes so the payload is guaranteed to be plain base64.
    if (attachPreview) content.push({ type: "image", data: bytes.toString("base64"), mimeType });
    return {
      content,
      structuredContent: {
        url: stored.url,
        id: stored.id,
        model: opts.model,
        modelLabel: MODELS[opts.model].label,
        provider: opts.provider,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        mimeType,
        bytes: bytes.length,
      },
    };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `Image generation failed: ${err?.message || String(err)}`;
    if (!(err instanceof ToolError)) console.error("tool error", err?.stack || err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** OpenAI Image API: /v1/images/generations, or /v1/images/edits when input images are given. */
async function openAiImage(env, opts, inputs, sizeHint) {
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const size = sizeHint
    ? openAiSize(`${sizeHint.width}:${sizeHint.height}`, opts.resolution)
    : openAiSize(opts.aspectRatio || "1:1", opts.resolution);
  const fields = { model: opts.model, prompt: opts.prompt, size, quality: opts.quality, output_format: opts.format, n: 1 };
  if (opts.format !== "png") fields.output_compression = 90;
  if (opts.background && opts.background !== "auto") fields.background = opts.background;

  let res;
  const signal = AbortSignal.timeout(clampInt(env.PROVIDER_TIMEOUT_MS, 10000, 600000, 300000));
  if (inputs.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    inputs.forEach((img, i) => {
      form.append("image[]", new Blob([img.bytes], { type: img.mimeType }), `input-${i + 1}.${extFor(img.mimeType)}`);
    });
    res = await fetch(`${base}/v1/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal,
    });
  } else {
    res = await fetch(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(fields),
      signal,
    });
  }
  const json = await readJson(res);
  if (!res.ok) {
    const detail = json?.error?.message || json?._raw || res.statusText;
    throw new ToolError(`OpenAI returned an error (${res.status}): ${String(detail).slice(0, 600)}`);
  }
  const item = json?.data?.[0];
  if (!item?.b64_json) throw new ToolError("OpenAI returned no image data.");
  return { b64: item.b64_json, mimeType: mimeFor(json.output_format || opts.format) };
}

/** Gemini API generateContent with image output (Nano Banana models). */
async function geminiImage(env, opts, inputs) {
  const base = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const parts = inputs.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: Buffer.from(img.bytes).toString("base64") },
  }));
  parts.push({ text: opts.prompt });
  const imageConfig = { imageSize: opts.resolution };
  if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;

  const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: stringifyFast({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig },
    }),
    signal: AbortSignal.timeout(clampInt(env.PROVIDER_TIMEOUT_MS, 10000, 600000, 300000)),
  });
  const json = await readJson(res);
  if (!res.ok) {
    const detail = json?.error?.message || json?._raw || res.statusText;
    throw new ToolError(`Google returned an error (${res.status}): ${String(detail).slice(0, 600)}`);
  }
  const candidate = json?.candidates?.[0];
  const allParts = candidate?.content?.parts || [];
  const images = allParts.filter((p) => (p.inlineData || p.inline_data) && !p.thought);
  const last = images[images.length - 1];
  const text = allParts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (!last) {
    const reason = json?.promptFeedback?.blockReason || candidate?.finishReason;
    throw new ToolError(
      `Google returned no image${reason ? ` (reason: ${reason})` : ""}${text ? `: ${text.slice(0, 400)}` : "."}`,
    );
  }
  const data = last.inlineData || last.inline_data;
  return { b64: data.data, mimeType: data.mimeType || data.mime_type || "image/png", note: text ? text.slice(0, 300) : undefined };
}

/**
 * Pick a GPT Image size for an aspect ratio and size class, within the documented limits:
 * both edges multiples of 16, longest edge <= 3840, ratio <= 3:1, 655,360..8,294,400 pixels.
 */
export function openAiSize(aspect, resolution) {
  const [aw, ah] = String(aspect).split(":").map(Number);
  let ratio = aw > 0 && ah > 0 ? aw / ah : 1;
  ratio = Math.min(3, Math.max(1 / 3, ratio));
  const target = { "1K": 1024 * 1024, "2K": 2048 * 2048, "4K": 3840 * 2160 }[resolution] || 1024 * 1024;
  let w = Math.sqrt(target * ratio);
  let h = w / ratio;
  const longest = Math.max(w, h);
  if (longest > 3840) {
    w *= 3840 / longest;
    h *= 3840 / longest;
  }
  let W = Math.max(16, Math.round(w / 16) * 16);
  let H = Math.max(16, Math.round(h / 16) * 16);
  while (W * H > 8_294_400 || Math.max(W, H) > 3840) {
    if (W >= H) W -= 16;
    else H -= 16;
  }
  while (W * H < 655_360) {
    if (W <= H) W += 16;
    else H += 16;
  }
  return `${W}x${H}`;
}

// ---------------------------------------------------------------------------
// Storage (R2)
// ---------------------------------------------------------------------------

async function storeImage(env, origin, bytes, mimeType, meta) {
  const id = randomId();
  const ext = extFor(mimeType);
  await env.IMAGES.put(`img/${id}.${ext}`, bytes, {
    httpMetadata: { contentType: mimeType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: meta,
  });
  return { id, url: `${origin}/img/${id}.${ext}` };
}

async function serveImage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const name = url.pathname.slice("/img/".length);
  if (!/^[A-Za-z0-9_-]{16,64}\.(png|jpg|webp|gif)$/.test(name) || !env.IMAGES) {
    return new Response("Not found\n", { status: 404 });
  }
  const object = await env.IMAGES.get(`img/${name}`);
  if (!object) return new Response("Not found\n", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("x-content-type-options", "nosniff");
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "content-disposition",
    `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="imagegen-${name}"`,
  );
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

/** Resolve edit inputs: our own image URLs/ids (read from R2) or public https URLs. */
async function loadInputImages(env, origin, refs) {
  const out = [];
  for (const raw of refs) {
    const ref = raw.trim();
    let bytes = null;
    let ownName = null;

    const bare = ref.match(/^([A-Za-z0-9_-]{16,64})(?:\.(png|jpg|jpeg|webp|gif))?$/);
    if (bare) {
      ownName = bare[2] ? `${bare[1]}.${bare[2] === "jpeg" ? "jpg" : bare[2]}` : bare[1];
    } else {
      let u;
      try {
        u = new URL(ref);
      } catch {
        throw new ToolError(`Not a valid image URL or id: ${ref.slice(0, 120)}`);
      }
      // Links to images from this server (any hostname it has been reachable under) are read
      // straight from R2; a Worker can't reliably fetch its own URL.
      const m = u.pathname.match(/^\/img\/([A-Za-z0-9_-]{16,64}\.(?:png|jpg|webp|gif))$/);
      const own = m && (u.origin === origin || (await env.IMAGES.head(`img/${m[1]}`)));
      if (own) ownName = m[1];
      else {
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new ToolError(`Unsupported URL: ${ref.slice(0, 120)}`);
        const res = await fetch(u.toString(), { signal: AbortSignal.timeout(30000), headers: { accept: "image/*" } });
        if (!res.ok) throw new ToolError(`Couldn't download ${u.toString().slice(0, 120)} (HTTP ${res.status}).`);
        const len = Number(res.headers.get("content-length") || 0);
        if (len > MAX_INPUT_BYTES) throw new ToolError(`Image too large (max ${MAX_INPUT_BYTES / 1048576} MB).`);
        bytes = new Uint8Array(await res.arrayBuffer());
      }
    }

    if (ownName) {
      let object = null;
      if (ownName.includes(".")) object = await env.IMAGES.get(`img/${ownName}`);
      else {
        const listed = await env.IMAGES.list({ prefix: `img/${ownName}.`, limit: 1 });
        if (listed.objects[0]) object = await env.IMAGES.get(listed.objects[0].key);
      }
      if (!object) throw new ToolError(`Image not found on this server: ${ref.slice(0, 120)}`);
      bytes = new Uint8Array(await object.arrayBuffer());
    }

    if (!bytes || bytes.length === 0) throw new ToolError(`Empty image: ${ref.slice(0, 120)}`);
    if (bytes.length > MAX_INPUT_BYTES) throw new ToolError(`Image too large (max ${MAX_INPUT_BYTES / 1048576} MB).`);
    const mimeType = sniffMime(bytes);
    if (!mimeType || mimeType === "image/gif") {
      throw new ToolError(`Unsupported image type for ${ref.slice(0, 120)} (use PNG, JPEG or WebP).`);
    }
    out.push({ bytes, mimeType, dims: imageDimensions(bytes) });
  }
  return out;
}

// Simple daily cap so a leaked URL or a runaway loop can't run up a large bill.
async function checkDailyLimit(env) {
  const limit = clampInt(env.DAILY_LIMIT, 0, 1_000_000, 100);
  if (limit === 0) return null;
  const key = `usage/${new Date().toISOString().slice(0, 10)}`;
  const object = await env.IMAGES.get(key);
  const count = object ? parseInt(await object.text(), 10) || 0 : 0;
  if (count >= limit) {
    throw new ToolError(`Daily limit of ${limit} images reached. It resets at midnight UTC (or raise DAILY_LIMIT).`);
  }
  return { key, count };
}

async function bumpDailyCount(env, usage) {
  if (usage) await env.IMAGES.put(usage.key, String(usage.count + 1));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLACEHOLDER_TOKENS = new Set([
  "change-me",
  "changeme",
  "change-me-to-a-long-random-string",
  "your-token",
  "your_token",
  "token",
  "secret",
  "password",
]);

/** Returns why MCP_TOKEN is unusable, or null when it is fine. */
function tokenProblem(env) {
  const token = env.MCP_TOKEN;
  if (!token) return "the MCP_TOKEN secret is not set";
  if (token.length < 16) return "MCP_TOKEN is too short (use at least 16 random characters)";
  if (PLACEHOLDER_TOKENS.has(token.toLowerCase())) return "MCP_TOKEN is still a placeholder value";
  return null;
}

/** Plain-text setup check at "/", handy after deploying from a phone. Never prints secret values. */
function statusPage(env, url) {
  const mark = (ok) => (ok ? "✓" : "✗");
  const problem = tokenProblem(env);
  const lines = [
    `${SERVER_INFO.title} (${SERVER_INFO.name} ${SERVER_INFO.version}) is running.`,
    "",
    "Setup check",
    `  ${mark(!problem)} MCP_TOKEN       ${problem ? problem : "set"}`,
    `  ${mark(!!env.OPENAI_API_KEY)} OPENAI_API_KEY  ${env.OPENAI_API_KEY ? "set (GPT Image 2.5 models available)" : "not set (OpenAI models disabled)"}`,
    `  ${mark(!!env.GEMINI_API_KEY)} GEMINI_API_KEY  ${env.GEMINI_API_KEY ? "set (Nano Banana models available)" : "not set (Google models disabled)"}`,
    `  ${mark(!!env.IMAGES)} R2 bucket       ${env.IMAGES ? "connected" : "missing IMAGES binding"}`,
    "",
    "Your connector URL for Claude:",
    `  ${url.origin}/mcp/<your MCP_TOKEN>`,
    "",
    "Add it on claude.ai: Customize → Connectors → + → Add custom connector.",
    "It then shows up in the Claude phone and desktop apps too.",
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function isModernMessage(msg) {
  const meta = msg?.params?._meta;
  return !!meta && typeof meta === "object" && "io.modelcontextprotocol/protocolVersion" in meta;
}

function modernVersionOf(msg) {
  return String(msg?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? "unknown");
}

function unsupportedVersion(version) {
  return textResponse(
    `Unsupported MCP protocol version "${version}". This server uses the initialize handshake and supports: ` +
      `${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
    400,
  );
}

function originAllowed(origin, env, url) {
  if (origin === url.origin) return true;
  const extra = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes("*") || extra.includes(origin)) return true;
  let host;
  try {
    const u = new URL(origin);
    host = u.hostname;
    if ((host === "localhost" || host === "127.0.0.1" || host === "[::1]") && (u.protocol === "http:" || u.protocol === "https:")) {
      return true;
    }
    if (u.protocol !== "https:") return false;
  } catch {
    return false;
  }
  return ["claude.ai", "claude.com", "anthropic.com"].some((d) => host === d || host.endsWith(`.${d}`));
}

function rpcErrorBody(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * JSON.stringify that splices large base64 "data" strings in afterwards. Escaping-checking a
 * multi-megabyte string costs several ms of CPU (the Workers Free plan allows 10 ms per request);
 * base64 never needs escaping, so it can be copied in as-is. Only used for "data" fields this
 * Worker produced itself from raw bytes.
 */
function stringifyFast(obj) {
  const blobs = [];
  const json = JSON.stringify(obj, (key, value) => {
    if (key === "data" && typeof value === "string" && value.length > 8192) {
      blobs.push(value);
      return `\u0000blob:${blobs.length - 1}\u0000`;
    }
    return value;
  });
  if (!blobs.length) return json;
  return json.replace(/"\\u0000blob:(\d+)\\u0000"/g, (_, i) => `"${blobs[Number(i)]}"`);
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(stringifyFast(obj), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", ...extraHeaders },
  });
}

function textResponse(text, status = 200) {
  return new Response(text + "\n", { status, headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" } });
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 600) };
  }
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.byteLength !== y.byteLength) return false;
  if (crypto.subtle?.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function randomId(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function truncateUtf8(s, maxBytes) {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, "") + "…";
}

function mimeFor(format) {
  return { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[format] || "image/png";
}

function extFor(mimeType) {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[mimeType] || "png";
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function sniffMime(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && ascii(b, 0, 3) === "GIF") return "image/gif";
  return null;
}

/** Read width/height from PNG, JPEG or WebP headers. */
export function imageDimensions(b) {
  try {
    const type = sniffMime(b);
    if (type === "image/png" && b.length >= 24) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = (b[i + 2] << 8) | b[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
        }
        i += 2 + len;
      }
    }
    if (type === "image/webp" && b.length >= 30) {
      const chunk = ascii(b, 12, 16);
      if (chunk === "VP8X") {
        return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
      if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    // fall through
  }
  return null;
}
