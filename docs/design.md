# Design

imagegen-mcp is a single Cloudflare Worker with no runtime dependencies. It speaks MCP over
Streamable HTTP to Claude, calls OpenAI and Google image APIs, and stores results in R2.

```
Claude (web / phone / desktop / Code)
   │  JSON-RPC over HTTPS (POST /mcp/<token>)
   ▼
┌──────────────────────── Worker (src/index.js) ────────────────────────┐
│  auth → protocol checks → dispatch → tools                            │
│     generate_image / edit_image ──► OpenAI  /v1/images/{generations,edits}
│                                 ──► Gemini  models/<id>:generateContent
│     create_upload_link          ──► signed single-use /upload URL
│     list_images                 ──► R2 list + customMetadata
│  GET /img/<id>.<ext>            ──► R2 object                          │
│  PUT /upload/<link>             ──► R2 object                          │
│  cron (daily)                   ──► purge objects older than RETENTION_DAYS
└───────────────────────────────────────────────────────────────────────┘
   │
   ▼
 R2 bucket  img/<id>.<ext>  (customMetadata: tool, model, prompt | description, created)
            usage/<YYYY-MM-DD>  (daily counter)
```

`src/viewer.js` is an MCP App (HTML in a template literal) that hosts with MCP Apps support render
next to the tool result.

## Request flow

1. **Origin check.** Browser origins other than the Worker's own, claude.ai/claude.com/anthropic.com,
   localhost, or `ALLOWED_ORIGINS` get a 403. This is the DNS-rebinding protection the MCP spec asks for.
2. **Authentication.** The token comes from the path (`/mcp/<token>`) or an `Authorization: Bearer`
   header and is compared in constant time with `MCP_TOKEN`. Short or placeholder tokens make the server
   refuse to start (500 with an explanation) rather than run insecurely.
3. **Protocol.** Supported MCP revisions are 2024-11-05 through 2025-11-25 (initialize-based). Newer,
   stateless-era messages (`_meta["io.modelcontextprotocol/protocolVersion"]`) and unknown
   `mcp-protocol-version` headers get a plain 400 so dual-era clients fall back to the handshake.
4. **Dispatch.** Single messages and JSON-RPC batches are handled; notifications are acknowledged with 202.
   `tools/call` with `Accept: text/event-stream` is answered as an SSE stream with keep-alive comments and
   `notifications/progress` every `KEEPALIVE_MS` (default 10 s), because image generation can take a minute.

## Stateless sessions

The Worker keeps no session state. The id minted at `initialize` is `u1.<random>` when the client
advertised MCP Apps support (`capabilities.extensions["io.modelcontextprotocol/ui"]`) and `u0.<random>`
otherwise. `tools/list` reads that prefix to decide whether to attach `_meta.ui.resourceUri` to the tools.
Any other session id is treated as "supports UI".

## Tools

### generate_image / edit_image

`normalizeArgs` validates the arguments and produces `opts`:

- `prompts`: either `[prompt]` or the `prompts` array (1–4). `prompts.length × count ≤ 4`.
- `count`: variations per prompt (1–4).
- model, aspect ratio, resolution, quality, format, background: validated against the enums at the top of
  `src/index.js`. `transparent` background forces `png` when `jpeg` was requested.

`runImageTool` then:

1. Checks `DAILY_LIMIT` (reserving `total` images). The counter is a read-then-write on an R2 object, so two
   calls at the same instant can go slightly over. Accepted for a personal server.
2. For `edit_image`, resolves each input (see below) and uses the first image's dimensions as the OpenAI
   size hint when no `aspect_ratio` was given.
3. Runs one provider job per prompt in parallel (`Promise.allSettled`). OpenAI makes `count` images in one
   request (`n`); Gemini needs one request per image, also in parallel. A failed prompt is reported in a
   note; the call only fails if every prompt failed.
4. Stores each image in R2 as `img/<22-char base64url id>.<ext>` with `customMetadata`
   `{ tool, model, prompt (≤600 bytes), created }`.
5. Builds the result: a text block listing links and ids, base64 `image` blocks while they fit the
   `PREVIEW_MAX_BYTES` budget (total per call), and `structuredContent` (see [api.md](api.md)).

Input resolution for `edit_image`:

- bare id or `<id>.<ext>` → read from R2;
- any URL whose path is `/img/<id>.<ext>` and that either matches this origin or exists in the bucket →
  read from R2 (a Worker cannot reliably fetch its own URL);
- other `http(s)` URLs → fetched with a 30 s timeout and read as a stream that stops at 20 MB
  (`readBounded`), whatever `content-length` claims.

### create_upload_link / PUT /upload

Claude cannot pass a chat attachment to a tool, so it uploads the file from its code sandbox. The link is

```
/upload/<id>.<expires>.<sig>[?d=<base64url description>]
sig = base64url( HMAC-SHA256( MCP_TOKEN, "upload.<id>.<expires>.<d>" ) )
```

Properties: the server keeps no state for it; the signature proves the server issued it and covers the
description; `expires` (10 min) bounds it; the link is spent once `img/<id>.*` exists (409 afterwards);
rotating `MCP_TOKEN` cancels all open links; the sandbox never sees `MCP_TOKEN`. The endpoint accepts a raw
`PUT` body or a multipart `POST`, sniffs the bytes (PNG/JPEG/WebP only), and enforces the 20 MB limit while
reading.

### list_images

R2 keys are random, so the bucket cannot be listed by date. `list_images` lists `img/` with
`include: ["customMetadata"]` (1000 per page, at most `MAX_LIST_SCAN` = 5000 objects), filters on
`query` against prompt, description, model and id, sorts by `created` descending and returns `limit`
entries plus the server's current time so the model can interpret "yesterday". `RETENTION_DAYS` keeps the
bucket small enough for this to stay cheap.

### Retention

`wrangler.jsonc` declares a daily cron trigger. `scheduled()` lists `img/` and deletes objects whose
`uploaded` time is older than `RETENTION_DAYS` (0 = keep forever), and `usage/` counters older than two
days. It uses R2's `uploaded` timestamp, not the metadata, so uploads and generated images are treated
alike.

## Viewer (src/viewer.js)

An MCP App (spec 2026-01-26). It runs `ui/initialize`, applies the host theme and container size,
listens for `ui/notifications/tool-input` and `tool-result`, and renders:

- a single image, or a grid of `structuredContent.images` (variations, `prompts[]`, or a `list_images`
  result);
- a Before/After pair when `structuredContent.sources` has one entry on the same origin and there is one
  result; a source strip otherwise;
- Open / Download (`?download=1`) / Copy-link buttons per image, using `ui/open-link` with a
  `window.open` fallback;
- an Upload button when the host advertises `hostCapabilities.serverTools`: it calls
  `create_upload_link` through the host, `PUT`s the file straight to the Worker (hence
  `connectDomains: [origin]` in the resource CSP) and posts the resulting id into the chat with
  `ui/message`.

The HTML lives in a template literal, so it must not contain backticks or `${`.

## Performance notes (Workers Free plan: 10 ms CPU per request)

- Waiting on providers costs no CPU. CPU goes to base64 decode/encode of the images and JSON
  serialisation.
- `stringifyFast` splices large base64 `data` strings into the JSON after `JSON.stringify`, skipping the
  escaping scan (base64 never needs escaping). Only used for strings this Worker produced itself.
- `PREVIEW_MAX_BYTES` caps the base64 payload per call; big 2K/4K results are sent as links only.

## Security model

- One shared secret (`MCP_TOKEN`) in the URL or a Bearer header. Anyone holding it can generate images
  on the owner's bill; `DAILY_LIMIT` and the providers' own budgets bound the damage.
- Image links are public but unguessable (128-bit random ids). Uploads reuse the same id space.
- Provider API keys stay in Worker secrets; nothing in a tool result or the viewer reveals them.
- Remote image downloads are bounded in time (30 s) and size (20 MB), and only `http(s)` is allowed.
- CORS is open (`*`) because the token, not the origin, is the credential, and the viewer iframe must
  be able to `PUT` uploads. The Origin check on `/mcp` still rejects unknown browser origins.

## Testing

`npm test` runs Vitest with `@cloudflare/vitest-plugin`, which executes the tests inside workerd with an
in-memory R2 bucket. `vitest.config.js` sets `outboundService` to `test/mock-providers.js`, a second
Worker that plays OpenAI, Gemini and a public image host, so no request leaves the machine and no API key
is used. The tests call the Worker's `fetch`/`scheduled` handlers directly with env overrides per test.
