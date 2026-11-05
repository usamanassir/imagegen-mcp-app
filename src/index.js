/**
 * imagegen-mcp — a remote MCP server on Cloudflare Workers that lets Claude
 * (web, mobile, desktop, Claude Code) generate and edit images with
 * OpenAI GPT Image 2.5 and Google Nano Banana.
 *
 * Endpoints
 *   POST /mcp/<MCP_TOKEN>   MCP endpoint (token in the URL), or
 *   POST /mcp               MCP endpoint with "Authorization: Bearer <MCP_TOKEN>"
 *   GET  /img/<id>.<ext>    Generated images (public, unguessable ids, stored in R2)
 *   GET  /audio/<id>.wav    Speech from the text_to_speech tool (public, unguessable ids, stored in R2)
 *   PUT  /upload/<link>     Single-use upload link from the create_upload_link tool (raw body or multipart)
 *
 * A daily cron (see "triggers" in wrangler.jsonc) deletes images and audio older than RETENTION_DAYS.
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

// Speech models and voices for text_to_speech (Gemini only; the tool is hidden without GEMINI_API_KEY).
const TTS_MODELS = {
  "gemini-3.8-flash-tts": {
    label: "Gemini 3.8 Flash TTS",
    note: "most expressive, 130+ languages; good default",
  },
  "gemini-3.8-flash-lite-tts": {
    label: "Gemini 3.8 Flash-Lite TTS",
    note: "faster and cheaper, 100+ languages",
  },
};
const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
const TTS_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];
const DEFAULT_TTS_VOICE = "Kore";
const MAX_TTS_CHARS = 5000; // about 5 minutes of speech, or 15 MB of WAV; keeps decoding within reach of the Workers CPU limit
const MAX_TTS_STYLE_CHARS = 500;

const MAX_PROMPT_CHARS = 32000;
const MAX_INPUT_IMAGES = 8;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_COUNT = 4; // variations per call
const MAX_LIST = 50; // images per list_images call
const MAX_LIST_SCAN = 5000; // most stored images list_images will look through
const DEFAULT_PREVIEW_MAX_BYTES = 1_500_000; // total preview bytes per call; larger results are linked only (keeps CPU low on the Workers Free plan)
const UPLOAD_LINK_TTL_MS = 10 * 60 * 1000;
const MAX_DESCRIPTION_BYTES = 200; // description of an uploaded image (stored as R2 metadata, searchable with list_images)

const INSTRUCTIONS = [
  "Image generation tools.",
  "Use generate_image when the user wants a new picture (photo, illustration, logo, poster, icon, mockup art).",
  "Use edit_image to change or remix an image: pass the URL of an image returned earlier (or a public image URL).",
  "Set count (2-4) when the user wants several variations of one prompt; use prompts (up to 4) when they want different versions, e.g. three styles.",
  "If the user attached an image in the chat (e.g. to restore, fix or edit it), you can't pass the attachment directly:",
  "call create_upload_link, upload the file with the curl command it returns from your code execution environment,",
  "then call edit_image with the returned image id.",
  "Use list_images to find images from earlier conversations (e.g. 'the logo from yesterday') by date or prompt text.",
  "Use text_to_speech when the user wants text read aloud as an audio file; it is read word for word, so put delivery directions in style, not in text.",
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
      if (url.pathname.startsWith("/audio/")) return await serveAudio(request, env, url);
      if (url.pathname.startsWith("/upload/")) return await handleUpload(request, env, url);

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

  // Cron trigger: delete images and audio older than RETENTION_DAYS (0 or unset keeps everything).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOldImages(env));
  },
};

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP (stateless; protocol revisions 2024-11-05 .. 2025-11-25)
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  const working = msg.params?.name === "text_to_speech" ? "Generating audio" : "Generating image";

  const run = (async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      let chunk = ": keep-alive\n\n";
      if (progressToken !== undefined) {
        const note = {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: ticks, message: `${working} (${Math.round((ticks * interval) / 1000)} s)…` },
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
      if (name === "create_upload_link") return { result: await createUploadLink(state, params.arguments || {}) };
      if (name === "list_images") return { result: await listImages(state, params.arguments || {}) };
      if (name === "text_to_speech") return { result: await runSpeechTool(params.arguments || {}, state) };
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
              _meta: {
                ui: {
                  // Images load from this origin; the viewer's upload button also PUTs to it.
                  csp: { resourceDomains: [state.origin], connectDomains: [state.origin] },
                  prefersBorder: true,
                },
              },
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

/** Models to recommend for faithful edits, limited to the ones whose provider key is set. */
function bestEditModels(models) {
  const picks = ["gemini-nano-banana-2.1", "gpt-image-2.5-sunburst"].filter((m) => models.includes(m));
  return (picks.length ? picks : models.slice(0, 1)).join(" or ");
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
    count: {
      type: "integer",
      minimum: 1,
      maximum: MAX_COUNT,
      default: 1,
      description: `Variations per prompt (1-${MAX_COUNT}). Each one is billed as a separate image. prompts × count may not exceed ${MAX_COUNT}.`,
    },
    prompts: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: MAX_COUNT,
      description:
        `Instead of 'prompt': up to ${MAX_COUNT} different prompts made in one call, e.g. the same logo in three styles. ` +
        "The result is one set of images labelled by prompt, so the user can compare them.",
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
        "and the image itself so you can check the result. Set count to 2-4 for variations of one prompt, or pass prompts for " +
        "different versions (e.g. three styles) in one call. Takes roughly 10-60 seconds.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed description: subject, setting, style or medium, composition, lighting, colors, mood. Put exact text to render in quotes. " +
              "Required unless 'prompts' is given.",
          },
          aspect_ratio: { type: "string", enum: ASPECT_RATIOS, default: "1:1", description: "Width:height of the image." },
          ...common,
        },
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
        "by earlier generate_image/edit_image calls (or their ids, or public https image URLs). For an image the user attached in " +
        "the chat, upload it first with create_upload_link and pass the returned id. For photo restoration or other faithful fixes, " +
        `prefer ${bestEditModels(models)} and ask to keep everything else unchanged. Returns a new image link.`,
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
            description:
              "What to change or create, e.g. 'make it night time, keep everything else identical'. Required unless 'prompts' is given.",
          },
          aspect_ratio: {
            type: "string",
            enum: ASPECT_RATIOS,
            description: "Optional. Leave out to keep the first image's shape.",
          },
          ...common,
        },
        required: ["images"],
        additionalProperties: false,
      },
      annotations: { title: "Edit image", ...annotations },
      ...meta,
    },
    {
      name: "create_upload_link",
      title: "Create image upload link",
      description:
        "Get a single-use link (valid 10 minutes) for uploading an image file to this server, such as an image the user attached " +
        "in the chat. Upload it from your code execution environment with the curl command in the result (attachments are usually " +
        "under /mnt/user-data/uploads/), then pass the returned image id to edit_image. PNG, JPEG or WebP, up to 20 MB. " +
        "Give a short description of the image so list_images can find it later. " +
        "Only if the upload itself fails (curl can't connect or is blocked), tell the user to add this server's domain to the " +
        "allowed domains for code execution in Claude's settings; otherwise don't mention it.",
      inputSchema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            maxLength: MAX_DESCRIPTION_BYTES,
            description: "What the image shows, in a few words (e.g. 'old family photo, wedding 1978'). Stored with the image and searchable.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Create image upload link",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "list_images",
      title: "List images",
      description:
        "List images stored on this server, newest first, with the prompt and model that made each one. Use it to find images " +
        "from earlier conversations (e.g. 'the café logo from yesterday'): filter with query, then pass the id or link to edit_image. " +
        "When several images match, show the user the candidates and ask which one they mean.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional. Case-insensitive text to look for in the prompt, model or image id.",
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIST, default: 20, description: "How many images to return." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List images", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ...meta,
    },
    ...(env.GEMINI_API_KEY ? [speechToolDefinition(annotations)] : []),
  ];
}

function speechToolDefinition(annotations) {
  const modelHelp = Object.entries(TTS_MODELS)
    .map(([id, m]) => `${id}: ${m.label} (${m.note})`)
    .join("; ");
  return {
    name: "text_to_speech",
    title: "Text to speech",
    description:
      "Turn text into a spoken audio file (WAV). The text is read word for word, so leave out anything that shouldn't be spoken; " +
      "the language is detected automatically. Returns a public link to the audio (always share it with the user).",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          maxLength: MAX_TTS_CHARS,
          description:
            "The exact words to speak. May contain inline tags such as <short pause>, <long pause>, <laugh> or <sigh>, and capitalized words for emphasis.",
        },
        voice: {
          type: "string",
          enum: TTS_VOICES,
          default: DEFAULT_TTS_VOICE,
          description: "The voice to speak with.",
        },
        style: {
          type: "string",
          maxLength: MAX_TTS_STYLE_CHARS,
          description: "Optional. How to deliver the whole text, e.g. 'cheerful and friendly' or 'slow, calm whisper'. Not spoken.",
        },
        model: {
          type: "string",
          enum: Object.keys(TTS_MODELS),
          default: DEFAULT_TTS_MODEL,
          description: `Speech model. ${modelHelp}.`,
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { title: "Text to speech", ...annotations },
  };
}

function normalizeArgs(tool, args, env) {
  if (!args || typeof args !== "object") throw new ToolError("Arguments must be an object.");
  const clean = (p, name) => {
    const s = typeof p === "string" ? p.trim() : "";
    if (!s) throw new ToolError(`'${name}' must be a non-empty string.`);
    if (s.length > MAX_PROMPT_CHARS) throw new ToolError(`'${name}' is too long (max ${MAX_PROMPT_CHARS} characters).`);
    return s;
  };
  let prompts;
  if (args.prompts !== undefined) {
    if (args.prompt !== undefined) throw new ToolError("Pass either 'prompt' or 'prompts', not both.");
    if (!Array.isArray(args.prompts) || !args.prompts.length) throw new ToolError("'prompts' must be a non-empty array of strings.");
    if (args.prompts.length > MAX_COUNT) throw new ToolError(`'prompts' can hold at most ${MAX_COUNT} entries.`);
    prompts = args.prompts.map((p, i) => clean(p, `prompts[${i}]`));
  } else {
    if (args.prompt === undefined) throw new ToolError("'prompt' (or 'prompts') is required.");
    prompts = [clean(args.prompt, "prompt")];
  }

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
    prompts,
    model,
    provider: MODELS[model].provider,
    aspectRatio: pick("aspect_ratio", ASPECT_RATIOS, tool === "generate_image" ? "1:1" : undefined),
    resolution: pick("resolution", RESOLUTIONS, "1K"),
    quality: pick("quality", QUALITIES, defaultQuality(env)),
    format: pick("format", FORMATS, "jpeg"),
    background: pick("background", BACKGROUNDS, undefined),
    count: 1,
    total: prompts.length,
    images: [],
  };
  if (opts.background === "transparent" && opts.format === "jpeg") opts.format = "png";
  if (args.count !== undefined) {
    const n = Number(args.count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) throw new ToolError(`'count' must be a whole number from 1 to ${MAX_COUNT}.`);
    opts.count = n;
    opts.total = n * prompts.length;
    if (opts.total > MAX_COUNT) {
      throw new ToolError(`${prompts.length} prompts × count ${n} = ${opts.total} images; at most ${MAX_COUNT} per call.`);
    }
  }

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

    const usage = await checkDailyLimit(env, opts.total);
    const inputs = tool === "edit_image" ? await loadInputImages(env, origin, opts.images) : [];

    // First input image decides the shape of an edit when no aspect ratio was given.
    let sizeHint = null;
    if (!opts.aspectRatio && inputs[0]?.dims) sizeHint = inputs[0].dims;

    // One job per prompt, run in parallel; each job makes `count` images.
    const started = Date.now();
    const jobs = await Promise.allSettled(
      opts.prompts.map((prompt) => {
        const o = { ...opts, prompt };
        return opts.provider === "openai" ? openAiImage(env, o, inputs, sizeHint) : geminiImage(env, o, inputs);
      }),
    );
    const gen = { images: [], notes: [], failed: 0, failedReason: null };
    jobs.forEach((job, i) => {
      if (job.status === "fulfilled") {
        for (const im of job.value.images) gen.images.push({ ...im, prompt: opts.prompts[i] });
        if (job.value.note) gen.notes.push(job.value.note);
        if (job.value.failed) {
          gen.failed += job.value.failed;
          gen.failedReason ||= job.value.failedReason;
        }
      } else {
        gen.failed += opts.count;
        gen.failedReason ||= String(job.reason?.message || job.reason).slice(0, 300);
      }
    });
    if (!gen.images.length) throw jobs.find((j) => j.status === "rejected").reason;
    gen.note = gen.notes[0];

    const created = new Date().toISOString();
    const results = [];
    for (const g of gen.images) {
      const bytes = Buffer.from(g.b64, "base64");
      const mimeType = sniffMime(bytes) || g.mimeType || "image/png";
      const stored = await storeImage(env, origin, bytes, mimeType, {
        model: opts.model,
        tool,
        prompt: truncateUtf8(g.prompt, 600),
        created,
      });
      results.push({ ...stored, bytes, mimeType, dims: imageDimensions(bytes), prompt: g.prompt });
    }
    await bumpDailyCount(env, usage, results.length);
    console.log(
      JSON.stringify({
        event: "image",
        tool,
        model: opts.model,
        prompts: opts.prompts.length,
        count: results.length,
        ms: Date.now() - started,
        bytes: results.reduce((n, r) => n + r.bytes.length, 0),
      }),
    );

    // Attach previews while they fit the total budget (base64 of big images costs CPU and tokens).
    const previewMax = clampInt(env.PREVIEW_MAX_BYTES, 0, 4_500_000, DEFAULT_PREVIEW_MAX_BYTES);
    let budget = env.PREVIEW_TO_CLAUDE === "false" ? -1 : previewMax;
    const lines = [];
    const content = [];
    const images = [];
    const many = results.length > 1;
    const multiPrompt = opts.prompts.length > 1;
    results.forEach((r, i) => {
      const size = r.dims ? `${r.dims.width}x${r.dims.height}` : "unknown size";
      const tag = multiPrompt ? ` (prompt: "${truncateUtf8(r.prompt, 80)}")` : "";
      lines.push(`${many ? `Image ${i + 1}${tag}: ` : "Image ready: "}${r.url}`);
      lines.push(`${many ? "  " : ""}Image id: ${r.id} · ${size} · ${r.mimeType}`);
      const attach = budget >= r.bytes.length;
      if (attach) budget -= r.bytes.length;
      images.push({
        url: r.url,
        id: r.id,
        width: r.dims?.width ?? null,
        height: r.dims?.height ?? null,
        mimeType: r.mimeType,
        bytes: r.bytes.length,
        preview: attach,
        prompt: multiPrompt ? r.prompt : undefined,
      });
      // Re-encode from the decoded bytes so the payload is guaranteed to be plain base64.
      if (attach) content.push({ type: "image", data: r.bytes.toString("base64"), mimeType: r.mimeType });
    });
    lines.push(`Model: ${MODELS[opts.model].label}`);
    lines.push(
      many
        ? "Share the links with the user and ask which one they prefer. Pass a link or id to edit_image to change it."
        : "Share the link with the user so they can open or download the full-size image. Pass it to edit_image to change it.",
    );
    if (gen.note) lines.push(`Model note: ${gen.note}`);
    if (gen.failed) lines.push(`Note: ${gen.failed} of ${opts.total} images failed: ${gen.failedReason}`);
    if (images.some((im) => !im.preview)) lines.push("(Some images are large and not attached here; open the links to see them.)");

    content.unshift({ type: "text", text: lines.join("\n") });
    const first = images[0];
    return {
      content,
      structuredContent: {
        // Fields for the first image (kept for compatibility) …
        url: first.url,
        id: first.id,
        model: opts.model,
        modelLabel: MODELS[opts.model].label,
        provider: opts.provider,
        width: first.width,
        height: first.height,
        mimeType: first.mimeType,
        bytes: first.bytes,
        // … and the full set, plus the inputs of an edit so the viewer can show before/after.
        count: images.length,
        prompts: opts.prompts,
        images,
        sources: inputs.map((inp) => ({ url: inp.url, id: inp.id ?? null })),
      },
    };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `Image generation failed: ${err?.message || String(err)}`;
    if (!(err instanceof ToolError)) console.error("tool error", err?.stack || err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function normalizeSpeechArgs(args) {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new ToolError("'text' must be a non-empty string.");
  if (text.length > MAX_TTS_CHARS) {
    throw new ToolError(`'text' is too long (${text.length} characters, max ${MAX_TTS_CHARS}). Split it into several calls.`);
  }
  const style = typeof args.style === "string" ? args.style.trim() : "";
  if (style.length > MAX_TTS_STYLE_CHARS) throw new ToolError(`'style' is too long (max ${MAX_TTS_STYLE_CHARS} characters).`);
  const model = args.model ?? DEFAULT_TTS_MODEL;
  if (!Object.hasOwn(TTS_MODELS, model)) {
    throw new ToolError(`Unknown speech model '${model}'. Available: ${Object.keys(TTS_MODELS).join(", ")}.`);
  }
  const voice = args.voice ?? DEFAULT_TTS_VOICE;
  if (!TTS_VOICES.includes(voice)) throw new ToolError(`Unknown voice '${voice}'. Available: ${TTS_VOICES.join(", ")}.`);
  return { text, style, model, voice };
}

async function runSpeechTool(args, state) {
  const { env, origin } = state;
  try {
    const opts = normalizeSpeechArgs(args);
    if (!env.GEMINI_API_KEY) throw new ToolError("GEMINI_API_KEY is not set on the server, so text_to_speech can't be used.");
    if (!env.IMAGES) throw new ToolError("R2 bucket binding IMAGES is missing (see wrangler.jsonc).");

    const usage = await checkDailyLimit(env, 1, "images and audio clips");
    const started = Date.now();
    const bytes = await geminiSpeech(env, opts);
    const wav = wavInfo(bytes);
    if (!wav) throw new ToolError("Google returned audio in an unexpected format (expected WAV).");

    const meta = { tool: "text_to_speech", model: opts.model, voice: opts.voice, text: truncateUtf8(opts.text, 600), created: new Date().toISOString() };
    const { id, url } = await storeAudio(env, origin, bytes, meta);
    await bumpDailyCount(env, usage, 1);
    console.log(JSON.stringify({ event: "speech", model: opts.model, voice: opts.voice, chars: opts.text.length, ms: Date.now() - started, bytes: bytes.length }));

    const lines = [
      `Audio ready: ${url}`,
      `Audio id: ${id} · ${formatDuration(wav.seconds)} · audio/wav · ${(bytes.length / 1048576).toFixed(1)} MB`,
      `Model: ${TTS_MODELS[opts.model].label} · Voice: ${opts.voice}`,
      "Share the link with the user so they can play or download the audio.",
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        url,
        id,
        model: opts.model,
        modelLabel: TTS_MODELS[opts.model].label,
        voice: opts.voice,
        mimeType: "audio/wav",
        bytes: bytes.length,
        seconds: wav.seconds,
      },
    };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `Speech generation failed: ${err?.message || String(err)}`;
    if (!(err instanceof ToolError)) console.error("tool error", err?.stack || err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Gemini Interactions API with audio output; returns the WAV bytes. The text is read verbatim and
 * style only directs the delivery. store: false, because Google otherwise keeps the interaction
 * (up to 55 days) and a one-shot call never refers back to it.
 */
async function geminiSpeech(env, opts) {
  const base = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const content = { type: "text", text: opts.text };
  if (opts.style) content.annotations = [{ type: "speech_metadata", style: opts.style }];

  const res = await fetch(`${base}/v1beta/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      input: [{ type: "user_input", content: [content] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: opts.voice }] },
      store: false,
    }),
    signal: AbortSignal.timeout(clampInt(env.PROVIDER_TIMEOUT_MS, 10000, 600000, 300000)),
  });
  const json = await readJson(res);
  if (!res.ok) {
    const detail = json?.error?.message || json?._raw || res.statusText;
    throw new ToolError(`Google returned an error (${res.status}): ${String(detail).slice(0, 600)}`);
  }
  const blocks = (json?.steps || []).filter((s) => s?.type === "model_output").flatMap((s) => s.content || []);
  const audio = blocks.filter((c) => c?.type === "audio" && c.data).pop();
  if (!audio) throw new ToolError("Google returned no audio.");
  return Buffer.from(audio.data, "base64");
}

/** OpenAI Image API: /v1/images/generations, or /v1/images/edits when input images are given. */
async function openAiImage(env, opts, inputs, sizeHint) {
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const size = sizeHint
    ? openAiSize(`${sizeHint.width}:${sizeHint.height}`, opts.resolution)
    : openAiSize(opts.aspectRatio || "1:1", opts.resolution);
  // One request makes all variations (n); the API returns them together.
  const fields = { model: opts.model, prompt: opts.prompt, size, quality: opts.quality, output_format: opts.format, n: opts.count };
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
  const items = (json?.data || []).filter((d) => d?.b64_json);
  if (!items.length) throw new ToolError("OpenAI returned no image data.");
  const mimeType = mimeFor(json.output_format || opts.format);
  return { images: items.map((d) => ({ b64: d.b64_json, mimeType })) };
}

/** Gemini API generateContent with image output (Nano Banana models). One request per variation, run in parallel. */
async function geminiImage(env, opts, inputs) {
  if (opts.count === 1) {
    const one = await geminiOne(env, opts, inputs);
    return { images: [one], note: one.note };
  }
  const settled = await Promise.allSettled(Array.from({ length: opts.count }, () => geminiOne(env, opts, inputs)));
  const images = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const failures = settled.filter((s) => s.status === "rejected");
  if (!images.length) throw failures[0].reason;
  const note = images.find((im) => im.note)?.note;
  return {
    images,
    note,
    failed: failures.length || undefined,
    failedReason: failures.length ? String(failures[0].reason?.message || failures[0].reason).slice(0, 300) : undefined,
  };
}

async function geminiOne(env, opts, inputs) {
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

async function storeImage(env, origin, bytes, mimeType, meta, id = randomId()) {
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

async function storeAudio(env, origin, bytes, meta) {
  const id = randomId();
  await env.IMAGES.put(`audio/${id}.wav`, bytes, {
    httpMetadata: { contentType: "audio/wav", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: meta,
  });
  return { id, url: `${origin}/audio/${id}.wav` };
}

/** Serve stored speech. Supports byte ranges, which players use to seek and which Safari asks for before playing. */
async function serveAudio(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const name = url.pathname.slice("/audio/".length);
  if (!/^[A-Za-z0-9_-]{16,64}\.wav$/.test(name) || !env.IMAGES) {
    return new Response("Not found\n", { status: 404 });
  }
  const key = `audio/${name}`;
  const info = await env.IMAGES.head(key);
  if (!info) return new Response("Not found\n", { status: 404 });

  const headers = new Headers();
  info.writeHttpMetadata(headers);
  headers.set("etag", info.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "content-disposition",
    `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="speech-${name}"`,
  );

  const range = parseRange(request.headers.get("range"), info.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${info.size}`);
    headers.set("content-length", String(range.length));
  } else {
    headers.set("content-length", String(info.size));
  }
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const object = await env.IMAGES.get(key, range ? { range } : undefined);
  if (!object) return new Response("Not found\n", { status: 404 });
  return new Response(object.body, { status, headers });
}

/**
 * Parse a single-range "Range: bytes=..." header. Returns { offset, length }, "unsatisfiable", or
 * null to serve the whole file (no header, or a form we don't support, as RFC 9110 allows).
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(m[1]);
  if (offset >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

// ---------------------------------------------------------------------------
// Uploads: single-use links so Claude can push a chat attachment from its code sandbox.
// Link format: /upload/<id>.<expires unix s>.<HMAC-SHA256(MCP_TOKEN, "upload.<id>.<expires>")>
// Stateless: the signature proves we issued it, the expiry bounds it, and the link is spent
// once img/<id>.* exists. Rotating MCP_TOKEN invalidates all open links. The MCP_TOKEN itself
// is never handed to the sandbox.
// ---------------------------------------------------------------------------

// Link format: /upload/<id>.<expires unix s>.<HMAC>[?d=<base64url description>]
// HMAC-SHA256(MCP_TOKEN, "upload.<id>.<expires>.<d>") covers the description too.
async function signUpload(env, id, expires, d = "") {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.MCP_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`upload.${id}.${expires}.${d}`));
  return Buffer.from(sig).toString("base64url");
}

async function createUploadLink(state, args = {}) {
  const { env, origin } = state;
  if (!env.IMAGES) {
    return { content: [{ type: "text", text: "R2 bucket binding IMAGES is missing (see wrangler.jsonc)." }], isError: true };
  }
  let description = typeof args.description === "string" ? args.description.replace(/\s+/g, " ").trim() : "";
  if (description) description = truncateUtf8(description, MAX_DESCRIPTION_BYTES);
  const d = description ? Buffer.from(description).toString("base64url") : "";

  const id = randomId();
  const expires = Math.floor((Date.now() + UPLOAD_LINK_TTL_MS) / 1000);
  const uploadUrl = `${origin}/upload/${id}.${expires}.${await signUpload(env, id, expires, d)}${d ? `?d=${d}` : ""}`;
  const expiresAt = new Date(expires * 1000).toISOString();
  const text = [
    `Upload link (single use, expires ${expiresAt}):`,
    uploadUrl,
    "",
    "Upload the file from your code execution environment, for example:",
    `  curl -sS --fail-with-body -T "/mnt/user-data/uploads/<file>" "${uploadUrl}"`,
    "",
    `Image id after upload: ${id}`,
    `Then call edit_image with images: ["${id}"].`,
    description ? `The image will be stored with this description: "${description}"` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return { content: [{ type: "text", text }], structuredContent: { uploadUrl, id, expiresAt, description: description || null } };
}

async function handleUpload(request, env, url) {
  const fail = (status, error) =>
    new Response(JSON.stringify({ error }) + "\n", { status, headers: { ...CORS_HEADERS, "content-type": "application/json" } });

  if (request.method !== "PUT" && request.method !== "POST") {
    return new Response("Method not allowed\n", { status: 405, headers: { ...CORS_HEADERS, allow: "PUT, POST, OPTIONS" } });
  }
  if (tokenProblem(env) || !env.IMAGES) return fail(500, "Server not configured.");

  const m = url.pathname.match(/^\/upload\/([A-Za-z0-9_-]{16,64})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return fail(404, "Invalid upload link.");
  const [, id, expires, sig] = m;
  const d = url.searchParams.get("d") || "";
  if (!/^[A-Za-z0-9_-]{0,400}$/.test(d)) return fail(404, "Invalid upload link.");
  if (!safeEqual(sig, await signUpload(env, id, expires, d))) return fail(403, "Invalid upload link.");
  const description = d ? Buffer.from(d, "base64url").toString("utf8") : "";
  if (Number(expires) * 1000 < Date.now()) return fail(410, "This upload link has expired. Call create_upload_link again.");
  const used = await env.IMAGES.list({ prefix: `img/${id}.`, limit: 1 });
  if (used.objects.length) return fail(409, "This upload link has already been used. Call create_upload_link again.");

  const tooLarge = `Image too large (max ${MAX_INPUT_BYTES / 1048576} MB).`;
  if (Number(request.headers.get("content-length") || 0) > MAX_INPUT_BYTES + 65536) return fail(413, tooLarge);

  let bytes;
  if ((request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "Couldn't read the multipart form.");
    }
    const file = [...form.values()].find((v) => typeof v !== "string");
    if (!file) return fail(400, "No file found in the form. Use curl -T <file> <url> or curl -F file=@<file> <url>.");
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    try {
      bytes = await readBounded(request, MAX_INPUT_BYTES);
    } catch (err) {
      if (err instanceof ToolError) return fail(413, tooLarge);
      throw err;
    }
  }

  if (bytes.length === 0) return fail(400, "The upload was empty.");
  if (bytes.length > MAX_INPUT_BYTES) return fail(413, tooLarge);
  const mimeType = sniffMime(bytes);
  if (!mimeType || mimeType === "image/gif") return fail(415, "Unsupported image type (use PNG, JPEG or WebP).");

  const meta = { tool: "upload", created: new Date().toISOString() };
  if (description) meta.description = description;
  const stored = await storeImage(env, url.origin, bytes, mimeType, meta, id);
  const dims = imageDimensions(bytes);
  console.log(JSON.stringify({ event: "upload", bytes: bytes.length, mimeType, dims }));
  return new Response(
    JSON.stringify({
      ok: true,
      id: stored.id,
      url: stored.url,
      mimeType,
      bytes: bytes.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      next: `Call edit_image with images: ["${stored.id}"].`,
    }) + "\n",
    { status: 201, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
  );
}

/** Resolve edit inputs: our own image URLs/ids (read from R2) or public https URLs. */
async function loadInputImages(env, origin, refs) {
  const out = [];
  for (const raw of refs) {
    const ref = raw.trim();
    let bytes = null;
    let ownName = null;
    let sourceUrl = null;
    let sourceId = null;

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
        // Read at most MAX_INPUT_BYTES, whatever content-length claims.
        bytes = await readBounded(res, MAX_INPUT_BYTES);
        sourceUrl = u.toString();
      }
    }

    if (ownName) {
      let object = null;
      if (ownName.includes(".")) object = await env.IMAGES.get(`img/${ownName}`);
      else {
        const listed = await env.IMAGES.list({ prefix: `img/${ownName}.`, limit: 1 });
        if (listed.objects[0]) object = await env.IMAGES.get(listed.objects[0].key);
      }
      if (!object) {
        throw new ToolError(
          `Image not found on this server: ${ref.slice(0, 120)}. If it came from create_upload_link, upload the file first.`,
        );
      }
      bytes = new Uint8Array(await object.arrayBuffer());
      sourceUrl = `${origin}/${object.key}`;
      sourceId = object.key.slice("img/".length).replace(/\.[a-z]+$/, "");
    }

    if (!bytes || bytes.length === 0) throw new ToolError(`Empty image: ${ref.slice(0, 120)}`);
    if (bytes.length > MAX_INPUT_BYTES) throw new ToolError(`Image too large (max ${MAX_INPUT_BYTES / 1048576} MB).`);
    const mimeType = sniffMime(bytes);
    if (!mimeType || mimeType === "image/gif") {
      throw new ToolError(`Unsupported image type for ${ref.slice(0, 120)} (use PNG, JPEG or WebP).`);
    }
    out.push({ bytes, mimeType, dims: imageDimensions(bytes), url: sourceUrl, id: sourceId });
  }
  return out;
}

/** Read a response body up to maxBytes; throws a ToolError (and stops downloading) when it is larger. */
async function readBounded(res, maxBytes) {
  const tooLarge = new ToolError(`Image too large (max ${maxBytes / 1048576} MB).`);
  if (Number(res.headers.get("content-length") || 0) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Simple daily cap so a leaked URL or a runaway loop can't run up a large bill.
// Note: read-then-write, so calls running at the same moment can go slightly over the limit.
async function checkDailyLimit(env, count = 1, unit = "images") {
  const limit = clampInt(env.DAILY_LIMIT, 0, 1_000_000, 100);
  if (limit === 0) return null;
  const key = `usage/${new Date().toISOString().slice(0, 10)}`;
  const object = await env.IMAGES.get(key);
  const used = object ? parseInt(await object.text(), 10) || 0 : 0;
  if (used + count > limit) {
    const left = Math.max(0, limit - used);
    throw new ToolError(
      `Daily limit of ${limit} ${unit} reached (${left} left today, ${count} requested). It resets at midnight UTC (or raise DAILY_LIMIT).`,
    );
  }
  return { key, count: used };
}

async function bumpDailyCount(env, usage, n = 1) {
  if (usage) await env.IMAGES.put(usage.key, String(usage.count + n));
}

// ---------------------------------------------------------------------------
// Image history (list_images) and retention
// ---------------------------------------------------------------------------

async function listImages(state, args) {
  const { env, origin } = state;
  if (!env.IMAGES) {
    return { content: [{ type: "text", text: "R2 bucket binding IMAGES is missing (see wrangler.jsonc)." }], isError: true };
  }
  const limit = clampInt(args.limit, 1, MAX_LIST, 20);
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";

  // Keys are random, so R2 can't return them by date: read the metadata of every stored image
  // (one list call per 1000) and sort here. Fine for a personal server, and RETENTION_DAYS keeps it small.
  const items = [];
  let cursor;
  let scanned = 0;
  do {
    const page = await env.IMAGES.list({ prefix: "img/", limit: 1000, cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      const m = /^img\/([A-Za-z0-9_-]{16,64})\.(png|jpg|webp|gif)$/.exec(o.key);
      if (!m) continue;
      const meta = o.customMetadata || {};
      const item = {
        id: m[1],
        url: `${origin}/${o.key}`,
        created: meta.created || o.uploaded.toISOString(),
        tool: meta.tool || "unknown",
        model: meta.model || null,
        prompt: meta.prompt || null,
        description: meta.description || null,
        bytes: o.size,
      };
      if (query && !`${item.prompt || ""} ${item.description || ""} ${item.model || ""} ${item.id}`.toLowerCase().includes(query)) continue;
      items.push(item);
    }
    scanned += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && scanned < MAX_LIST_SCAN);

  items.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const total = items.length;
  const images = items.slice(0, limit);
  const now = new Date().toISOString();

  const lines = [];
  if (!images.length) {
    lines.push(query ? `No stored images match "${query}".` : "No images are stored on this server yet.");
  } else {
    lines.push(
      `${images.length} of ${total} stored image${total === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}, newest first. Server time now: ${now}.`,
    );
    for (const im of images) {
      const what = im.tool === "upload" ? "uploaded by the user" : `${im.tool} with ${im.model || "unknown model"}`;
      const label = im.prompt || im.description;
      const prompt = label ? ` · "${label.length > 160 ? `${label.slice(0, 160)}…` : label}"` : "";
      lines.push(`- ${im.created.slice(0, 16).replace("T", " ")} UTC · id ${im.id} · ${what}${prompt} · ${im.url}`);
    }
    if (total > images.length) lines.push(`(${total - images.length} more; raise limit or narrow query to see them.)`);
    if (scanned >= MAX_LIST_SCAN) lines.push(`(Only the first ${MAX_LIST_SCAN} stored images were searched.)`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { kind: "list", now, query: query || null, total, count: images.length, images },
  };
}

/** Delete images and audio older than RETENTION_DAYS, plus stale daily counters. Runs from the cron trigger. */
async function purgeOldImages(env) {
  const days = clampInt(env.RETENTION_DAYS, 0, 3650, 0);
  if (!env.IMAGES || days === 0) return { deleted: 0, skipped: true };
  const cutoff = Date.now() - days * 86_400_000;
  const usageCutoff = Date.now() - 2 * 86_400_000;
  let deleted = 0;
  for (const prefix of ["img/", "audio/", "usage/"]) {
    let cursor;
    do {
      const page = await env.IMAGES.list({ prefix, limit: 1000, cursor });
      const limitMs = prefix === "usage/" ? usageCutoff : cutoff;
      const old = page.objects.filter((o) => o.uploaded.getTime() < limitMs).map((o) => o.key);
      if (old.length) {
        await env.IMAGES.delete(old);
        deleted += old.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  console.log(JSON.stringify({ event: "purge", retentionDays: days, deleted }));
  return { deleted };
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
    `  ${mark(!!env.GEMINI_API_KEY)} GEMINI_API_KEY  ${env.GEMINI_API_KEY ? "set (Nano Banana models and text to speech available)" : "not set (Google models and text to speech disabled)"}`,
    `  ${mark(!!env.IMAGES)} R2 bucket       ${env.IMAGES ? "connected" : "missing IMAGES binding"}`,
    `  ${mark(true)} Retention       ${clampInt(env.RETENTION_DAYS, 0, 3650, 0) ? `images are deleted after ${clampInt(env.RETENTION_DAYS, 0, 3650, 0)} days` : "off (images are kept)"}`,
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

/** Check for a RIFF/WAVE header and work out the length from the byte rate in its fmt chunk. */
export function wavInfo(b) {
  if (b.length < 44 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 12) !== "WAVE" || ascii(b, 12, 16) !== "fmt ") return null;
  const byteRate = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(28, true);
  return { seconds: byteRate ? Math.round(((b.length - 44) / byteRate) * 10) / 10 : null };
}

function formatDuration(seconds) {
  if (seconds === null) return "unknown length";
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
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
