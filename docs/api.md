# API reference

## HTTP endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/mcp/<MCP_TOKEN>` | token in path | MCP endpoint (JSON-RPC 2.0, Streamable HTTP) |
| `POST` | `/mcp` | `Authorization: Bearer <MCP_TOKEN>` | Same, for clients that can set headers |
| `GET`, `HEAD` | `/img/<id>.<png\|jpg\|webp\|gif>` | none | Serve a stored image. `?download=1` sets `Content-Disposition: attachment` |
| `GET`, `HEAD` | `/audio/<id>.wav` | none | Serve stored speech. Supports single byte ranges (`206`, `416`). `?download=1` sets `Content-Disposition: attachment` |
| `PUT`, `POST` | `/upload/<id>.<expires>.<sig>[?d=…]` | signed link | Store one image for a link made by `create_upload_link` |
| `GET` | `/` | none | Plain-text setup check (never prints secret values) |
| `OPTIONS` | any | none | CORS preflight (204) |

### MCP endpoint

Headers understood: `Accept` (`text/event-stream` turns `tools/call` into an SSE stream),
`MCP-Protocol-Version` (must be one of 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 if present),
`MCP-Session-Id` (returned by `initialize`; `u0.*` disables viewer metadata), `Origin` (checked).

Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`,
`resources/templates/list`, `prompts/list`. Notifications are acknowledged with `202` and an empty body.
Batches (arrays) are answered with arrays.

Error codes: `-32700` parse error, `-32600` invalid request (also used for a rejected Origin, 403),
`-32601` method not found, `-32602` unknown tool, `-32603` internal error, `-32001` unauthorized (401),
`-32002` resource not found.

Tool failures (bad arguments, provider errors, limits) are returned as a normal result with
`isError: true` and a single text block explaining the problem, so the model can recover.

### `/upload`

Responses are JSON.

| Status | Meaning |
|---|---|
| `201` | Stored. Body: `{ ok, id, url, mimeType, bytes, width, height, next }` |
| `400` | Empty body, or no file in the multipart form |
| `403` | Signature does not match (tampered id, expiry or description) |
| `404` | Malformed link or `d` parameter |
| `405` | Method other than PUT/POST |
| `409` | Link already used |
| `410` | Link expired (10 minutes) |
| `413` | More than 20 MB |
| `415` | Not PNG, JPEG or WebP |
| `500` | Server not configured (`MCP_TOKEN` or bucket missing) |

## Tools

All image-making tools share these optional arguments:

| Argument | Values | Default | Notes |
|---|---|---|---|
| `model` | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gemini-nano-banana-2.1`, `gemini-3.1-flash-image` | `DEFAULT_MODEL` | Only models whose provider key is set are listed |
| `resolution` | `1K`, `2K`, `4K` | `1K` | |
| `quality` | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | `DEFAULT_QUALITY` | OpenAI only |
| `format` | `jpeg`, `png`, `webp` | `jpeg` | OpenAI only; `transparent` forces `png` |
| `background` | `auto`, `transparent`, `opaque` | — | OpenAI only |
| `count` | 1–4 | 1 | Variations per prompt |
| `prompts` | 1–4 strings | — | Instead of `prompt`; `prompts × count ≤ 4` |

### `generate_image`

Arguments: `prompt` (or `prompts`), `aspect_ratio` (`1:1` default; `2:3 3:2 3:4 4:3 9:16 16:9 21:9`),
plus the shared ones.

### `edit_image`

Arguments: `images` (1–8 references: an id, `<id>.<ext>`, a link to this server, or a public `https`
image URL), `prompt` (or `prompts`), optional `aspect_ratio` (default: keep the first image's shape),
plus the shared ones.

### Result of `generate_image` / `edit_image`

`content`: one text block (links, ids, model, notes) followed by `image` blocks (base64) for every image
that fits the `PREVIEW_MAX_BYTES` budget.

`structuredContent`:

```jsonc
{
  // first image, kept for compatibility with older viewers
  "url": "https://…/img/<id>.png", "id": "<id>", "model": "gpt-image-2.5-flare",
  "modelLabel": "OpenAI GPT Image 2.5 Flare", "provider": "openai",
  "width": 1024, "height": 1024, "mimeType": "image/png", "bytes": 123456,

  "count": 3,
  "prompts": ["…"],                       // the prompt(s) used
  "images": [
    { "url", "id", "width", "height", "mimeType", "bytes",
      "preview": true,                     // false when not attached as a base64 block
      "prompt": "…" }                      // only present when prompts[] was used
  ],
  "sources": [ { "url": "…", "id": "<id>|null" } ]   // edit_image inputs; [] for generate_image
}
```

### `create_upload_link`

Arguments: `description` (optional, ≤ 200 bytes; stored with the image, searchable).

Result text: the link, a ready-made `curl -T` command, the future image id and the next step.
`structuredContent`: `{ uploadUrl, id, expiresAt, description }`.

### `list_images`

Arguments: `query` (optional, case-insensitive substring over prompt, description, model and id),
`limit` (1–50, default 20).

`structuredContent`:

```jsonc
{
  "kind": "list", "now": "2026-11-05T12:00:00.000Z", "query": "logo" | null,
  "total": 12,            // matches before limit
  "count": 5,             // returned
  "images": [
    { "id", "url", "created", "tool": "generate_image|edit_image|upload|unknown",
      "model": "…|null", "prompt": "…|null", "description": "…|null", "bytes": 123 }
  ]
}
```

The text block lists one line per image: `YYYY-MM-DD HH:MM UTC · id … · <tool> with <model> · "<prompt>" · <url>`.

### `text_to_speech`

Only listed when `GEMINI_API_KEY` is set.

| Argument | Values | Default | Notes |
|---|---|---|---|
| `text` | string, 1–5,000 characters | required | Read verbatim. May contain inline tags such as `<short pause>` |
| `voice` | one of 30 prebuilt voices | `Kore` | |
| `style` | string, ≤ 500 characters | — | Delivery direction for the whole text; not spoken |
| `model` | `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` | `gemini-3.8-flash-tts` | |

`content`: one text block with the link, id, length and size. Audio is not attached as a content block.

`structuredContent`:

```jsonc
{
  "url": "https://…/audio/<id>.wav", "id": "<id>", "model": "gemini-3.8-flash-tts",
  "modelLabel": "Gemini 3.8 Flash TTS", "voice": "Kore", "mimeType": "audio/wav",
  "bytes": 48044, "seconds": 1      // seconds is null if the WAV header has no byte rate
}
```

## Resources

| URI | MIME type | Content |
|---|---|---|
| `ui://imagegen/viewer.html` | `text/html;profile=mcp-app` | The viewer. `_meta.ui.csp` allows images and `fetch` to this origin; `prefersBorder: true` |

Tools `generate_image`, `edit_image` and `list_images` carry `_meta.ui.resourceUri` pointing at it when
the client advertised MCP Apps support.

## Configuration

Secrets (`npx wrangler secret put NAME`): `MCP_TOKEN` (≥ 16 chars, not a placeholder), `OPENAI_API_KEY`,
`GEMINI_API_KEY` (either key may be omitted; its models disappear).

Vars (`wrangler.jsonc` → `vars`):

| Var | Default | Range |
|---|---|---|
| `DEFAULT_MODEL` | `gpt-image-2.5-flare` | any available model id |
| `DEFAULT_QUALITY` | `auto` | quality enum; invalid → `medium` |
| `DAILY_LIMIT` | `100` | 0 (off) – 1,000,000 images and audio clips per UTC day |
| `RETENTION_DAYS` | `14` | 0 (keep) – 3650 |
| `PREVIEW_MAX_BYTES` | `1500000` | 0 – 4,500,000 total preview bytes per call |
| `PREVIEW_TO_CLAUDE` | `true` | `false` sends links only |
| `KEEPALIVE_MS` | `10000` | 1,000 – 60,000 ms between SSE keep-alives |
| `PROVIDER_TIMEOUT_MS` | `300000` | 10,000 – 600,000 ms |
| `ALLOWED_ORIGINS` | — | comma-separated origins, or `*` |
| `OPENAI_BASE_URL`, `GEMINI_BASE_URL` | provider defaults | for proxies and tests |

Binding: `IMAGES` (R2 bucket). Cron: `triggers.crons` (default `23 3 * * *`).
