# Development

## Layout

```
src/index.js          the Worker: MCP server, tools, providers, storage, upload, retention
src/viewer.js         the MCP App shown inline in the chat (HTML in a template literal)
scripts/check.mjs     smoke test against a deployed server (needs the connector URL)
test/*.test.js        Vitest suites (run inside workerd)
test/helpers.js       request helpers, bucket reset, provider call counters
test/mock-providers.js fake OpenAI / Gemini / image host used by the tests
docs/                 this folder
wrangler.jsonc        Worker config: bucket binding, vars, cron trigger
```

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars        # fill in MCP_TOKEN and at least one API key
npm run dev                           # http://localhost:8787, R2 emulated on disk
node scripts/check.mjs "http://localhost:8787/mcp/<MCP_TOKEN>"
```

`npx wrangler dev --test-scheduled` also exposes `GET /__scheduled` to run the retention job by hand.

## Tests

```bash
npm test              # one run
npm run test:watch    # re-run on change
```

The suite runs inside the Workers runtime with an in-memory R2 bucket. All outbound requests from the
Worker go to `test/mock-providers.js`, so tests need no network and no keys. Prompts containing `fail-me`
make the fake provider fail; `blocked` makes Gemini return no image; `no-audio` and `not-wav` do the same for
speech; `https://images.test/…` serves test images, including a 25 MB stream with a lying `content-length`.

Conventions:

- `run(request, envOverrides)` calls the Worker's `fetch` and waits for `waitUntil` work. Pass env
  overrides to test settings (`{ DAILY_LIMIT: "3" }`) instead of changing the config.
- `call(tool, args, { env })` is a `tools/call` shortcut returning the tool result.
- `beforeEach(clearBucket)` where tests depend on bucket contents; storage is shared within a file.
- `providerCalls()` returns and resets how many requests each fake provider received.
- `GET https://mock.test/__speech` returns the last speech request, to check what was sent to Google.
- Streaming responses: read the body before `waitOnExecutionContext`, or the writer blocks.

What is not covered: the viewer's browser behaviour. It was checked by hand with Playwright against a
fake MCP Apps host; the scenarios are described in [design.md](design.md#viewer-srcviewerjs).

## Deploy

Pushing to `main` triggers Workers Builds if the Worker is connected to the GitHub repo (Deploy button
setups are). Otherwise `npm run deploy`. Secrets are set once with `npx wrangler secret put` and survive
deploys. After adding or changing tools, remove and re-add the connector in claude.ai so it refreshes
the tool list.

## Adding a model

Add an entry to `MODELS` in `src/index.js` with `provider: "openai" | "google"`. Nothing else is needed:
the enum, defaults and status page derive from that table. A new provider needs a `<name>Image()` function
returning `{ images: [{ b64, mimeType }], note? }` and a branch in `runImageTool`.

## Adding a tool

1. Add the definition in `toolDefinitions()` (schema, annotations, `...meta` if the viewer should show it).
2. Route it in `handleRequest` under `tools/call`.
3. Return `{ content: [...], structuredContent?: {...}, isError?: true }`.
4. Add tests; the mock provider rarely needs changes.
5. Update `docs/api.md` and, if users see it, the README.
