# imagegen-mcp: image generation for Claude (web, phone, desktop)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/usamanassir/imagegen-mcp-app)

A small remote MCP server on **Cloudflare Workers** that gives Claude these tools:

- **`generate_image`**: creates a new image from a description.
- **`edit_image`**: changes earlier images or combines several reference images.
- **`create_upload_link`**: lets Claude upload an image you attached in the chat so it can edit or restore it.
- **`list_images`**: finds earlier images by date or prompt, so you can say "edit the logo from yesterday".
- **`text_to_speech`**: reads text aloud and gives you a link to the audio file (needs a Gemini API key).

It works with **OpenAI GPT Image 2.5** (Flare, Sunburst) and **Google Nano Banana** (2.1 and 2). Images are saved
in Cloudflare R2, and each one gets its own link. Claude also gets a copy of the image so it can look
at the result, and apps that support MCP Apps show the image right in the chat.

You add it once on claude.ai as a custom connector, and it then works on the web, in the phone app, and in Claude
Desktop.

---

## What you need

| | |
|---|---|
| Cloudflare account (free) | Workers free plan is enough to start. R2 asks for a card or PayPal once to activate, but the free tier (10 GB) costs nothing. |
| OpenAI API key | For the GPT Image 2.5 models. It's billed per image, separately from ChatGPT Plus. OpenAI may ask you to verify your organization before GPT Image models work. |
| Gemini API key | For the Nano Banana models and text to speech (from Google AI Studio). Optional: you can use just one provider, but text to speech needs this key. |
| A GitHub account | Only for the Deploy button (option A). |
| A computer with Node.js 18+ | Only if you deploy from the command line (option B). |

## 1. Deploy

### Option A: the Deploy button (works from a phone)

1. **Turn on R2 once.** Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com), open **R2** and enable
   it. It asks for a card or PayPal, but the free tier costs nothing. The button can't create the image bucket
   until R2 is on.
2. **Tap _Deploy to Cloudflare_** at the top of this page. Sign in and connect GitHub when asked. Cloudflare copies
   this repo into your GitHub account (give the copy a name like `imagegen-mcp-app`) and redeploys it whenever that
   copy changes.
3. **Fill in the three secrets:**
   - `MCP_TOKEN`: let your password manager generate a long random password (32+ characters) and save it.
     It's the password in your connector URL.
   - `OPENAI_API_KEY` and `GEMINI_API_KEY`: your API keys.

   Leave the other settings as they are and tap **Deploy**.
4. **Open your Worker's address** (`https://imagegen-mcp-app.<your-subdomain>.workers.dev`). It shows a setup check.
   Every line should have a ✓. If one doesn't, fix it in the dashboard under **Workers & Pages → imagegen-mcp-app →
   Settings → Variables and Secrets**.

Your **connector URL** is that address followed by `/mcp/<MCP_TOKEN>`. Now go to step 2 below.

### Option B: from a computer (about 10 minutes)

```bash
git clone https://github.com/usamanassir/imagegen-mcp-app
cd imagegen-mcp-app
npm install
npx wrangler login                                  # opens the browser and signs you in to Cloudflare
npx wrangler r2 bucket create imagegen-images       # the bucket for the images
npx wrangler deploy                                 # prints https://imagegen-mcp-app.<your-subdomain>.workers.dev
```

The first time you deploy, Wrangler may ask you to pick a `workers.dev` subdomain. If creating the bucket says
R2 isn't enabled, open **R2** once in the Cloudflare dashboard to activate it, then run the command again.

Next, create the secrets. Make a long random token first. It works like a password, and it becomes part of your
connector URL:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put MCP_TOKEN          # paste the token
npx wrangler secret put OPENAI_API_KEY     # paste your OpenAI key (skip if you only want Google)
npx wrangler secret put GEMINI_API_KEY     # paste your Gemini key (skip if you only want OpenAI)
```

Secrets take effect right away. You don't need to redeploy.

Your **connector URL** is:

```
https://imagegen-mcp-app.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>
```

Check that it works. The second command makes one real (billed) test image:

```bash
node scripts/check.mjs "https://imagegen-mcp-app.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>"
node scripts/check.mjs "<connector URL>" --generate "a lighthouse at dusk, oil painting"
```

## 2. Connect it to Claude

1. Open **claude.ai** in a browser. A phone browser works too, but the Claude phone app itself can't add custom
   connectors.
2. Go to **Customize → Connectors**, click **+**, then **Add custom connector**.
3. Name it `Image Generator` and paste the **connector URL**. You don't need to sign in, because the token is in the
   URL. Then click **Add**.
4. It now shows up in the phone app and in Claude Desktop on its own. In a chat, check that it's switched on under
   **+ → Connectors**.

Then just ask, for example:

- "Create an image of a cozy reading nook with rain on the window, 16:9."
- "Make a flat vector logo for a café called 'Olive & Ember', transparent background, png."
- "Now make it night time and keep everything else the same." (Claude calls `edit_image` on the last image.)
- "Do the same prompt with Nano Banana so I can compare."

### Editing images you attach in the chat

Claude can't pass a chat attachment straight to an MCP tool, so it uploads the file with code instead. Attach a
photo and ask, for example, "Restore this old photo: remove the scratches and fix the faded colors." Claude then:

1. calls `create_upload_link`, with a short description of the image so `list_images` can find it later; the
   tool returns a single-use upload link that expires after 10 minutes,
2. uploads the file from its code sandbox with `curl`,
3. calls `edit_image` with the new image id.

For this to work on claude.ai (web and phone):

- Turn on **Settings → Capabilities → Code execution and file creation**.
- Add your Worker's domain (`imagegen-mcp-app.<your-subdomain>.workers.dev`) to the **allowed domains** for code
  execution. Without it the sandbox can't reach the Worker.

Claude Code needs no setup, since it runs `curl` on your own machine. The upload link never contains your
`MCP_TOKEN`; it is signed with it, so changing the token cancels all open links. Uploads don't count toward
`DAILY_LIMIT`, because they cost nothing at OpenAI or Google.

To test the upload from a computer: `node scripts/check.mjs "<connector URL>" --upload photo.jpg`

### Variations, history and the inline viewer

- **Variations:** ask for "3 options" or "a few versions" and Claude sets `count` (up to 4). For different versions,
  such as "the logo in flat, vintage and 3D style", Claude passes `prompts` (up to 4) and you get one set of images
  labelled by prompt. `prompts × count` is capped at 4 per call. Each image is billed separately and counts toward
  `DAILY_LIMIT`. The result lists every link, and you pick one to continue editing.
- **History:** say "edit the café logo from yesterday" and Claude calls `list_images`, which returns your stored
  images newest first with the prompt and model that made each one. It matches on the prompt text and date, not on
  what the image looks like, so Claude may show you the candidates and ask which one you mean. Images are only
  listed while they are stored (see `RETENTION_DAYS`).
- **Viewer:** in apps that support MCP Apps, the result appears inline with Open, Download and Copy-link buttons,
  a grid for variations and lists, and a before/after pair for edits. On hosts that let apps call server tools, an
  **Upload an image to edit…** button sends a file from your device, with an optional description, and posts its id into the chat. Whether that
  button appears depends on the host.

**Bearer token instead of the URL token:** claude.ai's custom connector form only takes a URL, so there the token
has to be in the URL. Clients that let you set request headers, such as Claude Code and most MCP SDKs, can use
`https://…workers.dev/mcp` as the URL with `Authorization: Bearer <MCP_TOKEN>` instead.

**Claude Code:** `claude mcp add --transport http imagegen "<connector URL>"`
(or `claude mcp add --transport http imagegen https://…workers.dev/mcp --header "Authorization: Bearer <MCP_TOKEN>"`)

## Models and options

| Model id | Use it for |
|---|---|
| `gpt-image-2.5-flare` (default) | Fast, high quality, excellent text rendering |
| `gpt-image-2.5-sunburst` | Slower; the highest fidelity and the most precise edits |
| `gemini-nano-banana-2.1` | Editing, and combining up to 8 reference images |
| `gemini-3.1-flash-image` | Nano Banana 2: cheaper and faster |

A model only appears if its provider's key is set. Claude picks the options from your request:

- `aspect_ratio`: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9 or 21:9.
- `resolution`: 1K (default), 2K or 4K.
- `quality` (OpenAI only): low, medium, high, xhigh, max or auto. The default is `DEFAULT_QUALITY` (`auto`).
- `format` (OpenAI only): jpeg (default), png or webp.
- `background` (OpenAI only): transparent or opaque.
- `count`: 1 (default) to 4 variations per prompt.
- `prompts`: up to 4 different prompts in one call, instead of `prompt`.

To add another model from the same providers, add a line to `MODELS` at the top of `src/index.js` and run
`npm run deploy`.

### Text to speech

Ask for example "Read this aloud in a calm voice: …". Claude calls `text_to_speech`, and you get a link to a WAV file
you can play or download.

- `text`: the exact words to speak, up to 5,000 characters (about 5 minutes). It can contain tags such as
  `<short pause>` or `<laugh>`. The language is detected automatically.
- `voice`: one of 30 voices, such as `Kore` (default), `Puck` or `Charon`.
- `style`: how to deliver it, such as "cheerful and friendly". This isn't spoken.
- `model`: `gemini-3.8-flash-tts` (default) or the cheaper `gemini-3.8-flash-lite-tts`, which covers fewer languages.

WAV files are about 2.9 MB per minute. To test it from a computer:
`node scripts/check.mjs "<connector URL>" --speak "Hello there"`

## Settings

Change these in `wrangler.jsonc` → `vars`, then run `npm run deploy`:

| Variable | Default | What it does |
|---|---|---|
| `DEFAULT_MODEL` | `gpt-image-2.5-flare` | The model used when you don't name one |
| `DEFAULT_QUALITY` | `auto` | The default OpenAI quality (`medium` if the value is unset or invalid) |
| `DAILY_LIMIT` | `100` | The most images and audio clips per day (UTC); `0` turns the limit off |
| `RETENTION_DAYS` | `14` | Images and audio older than this are deleted by a daily job (03:23 UTC); `0` keeps them forever |
| `PREVIEW_MAX_BYTES` | `1500000` | Total size of the image copies sent to Claude per call; bigger results are sent as links only |
| `PREVIEW_TO_CLAUDE` | `true` | `false` means Claude never gets a copy of the image, which saves tokens |
| `ALLOWED_ORIGINS` | — | Extra browser origins allowed to call `/mcp` (claude.ai and localhost are always allowed) |

## Costs and limits

- **OpenAI and Google** charge per image. The cost goes up with resolution and quality. Set a monthly budget in
  each provider's billing settings; `DAILY_LIMIT` is a second safety net.
- **Text to speech** is billed by Google per token. Gemini 3.8 Flash TTS is about $0.0135 per minute of speech through
  December 31, 2026 and about $0.027 after that; Flash-Lite is about $0.009, then $0.018. A key from a Google project
  with no billing uses the free tier: it costs nothing and has lower limits, but Google may use what you send to
  improve its products, so use a paid key for private text.
- **Cloudflare Workers Free** allows 100,000 requests a day and **10 ms of CPU per request**. Waiting for OpenAI or
  Google doesn't count toward that, and 1K images fit easily. Large 2K/4K outputs, especially Nano Banana PNGs, can
  go over it. If a call fails with *"Worker exceeded CPU time limit"* (error 1102), switch to **Workers Paid**
  ($5/month), or stick to 1K.
- **R2** gives you 10 GB free with no download fees. `RETENTION_DAYS` deletes old images for you (14 days by
  default), so the bucket stays small. Set it to `0` if you want to keep everything.
- `DAILY_LIMIT` is checked with a read-then-write, so two calls that start at the same moment can go slightly over
  it. For one person's use that doesn't matter.

## Security notes

- Anyone with your connector URL can make images on your bill. Keep it private. To change the token, edit it in the
  dashboard (**Settings → Variables and Secrets**) or run `npx wrangler secret put MCP_TOKEN`, then remove the
  connector and add it back with the new URL.
- Image and audio links aren't password-protected, but they contain a random 128-bit id, so nobody can guess them.
- API keys stay in Cloudflare secrets. Claude, the browser and the phone never see them.

## Troubleshooting

- **Watch live logs:** run `npx wrangler tail`, or open the Worker's **Logs** tab in the Cloudflare dashboard.
- **401 Unauthorized:** the token in the URL doesn't match `MCP_TOKEN`.
- **"OPENAI_API_KEY is not set" or "GEMINI_API_KEY is not set":** add that secret.
- **OpenAI says the organization must be verified:** finish verification in the OpenAI dashboard, then try again.
- **The picture doesn't show in the chat:** Claude's reply always includes the link, so tap it. The inline viewer
  only appears in apps that support MCP Apps.
- **The connector shows no tools:** remove it and add it again, and make sure the URL ends in `/mcp/<token>`.

## How it works

The whole server is one Cloudflare Worker (`src/index.js` and the inline viewer in `src/viewer.js`) with no runtime
dependencies. `POST /mcp/<token>` is a stateless MCP endpoint (Streamable HTTP, protocol versions 2024-11-05 through
2025-11-25); images are stored in R2 and served from `GET /img/<id>.<ext>`; a daily cron deletes old ones.

For developers:

- [docs/design.md](docs/design.md): architecture, request flow, the signed upload links, the viewer, security model.
- [docs/api.md](docs/api.md): HTTP endpoints, tool arguments and result shapes, configuration.
- [docs/development.md](docs/development.md): running locally, tests (`npm test`), deploying, adding models or tools.