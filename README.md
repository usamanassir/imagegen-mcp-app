# imagegen-mcp: image generation for Claude (web, phone, desktop)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/usamanassir/imagegen-mcp)

A small remote MCP server on **Cloudflare Workers** that gives Claude these tools:

- **`generate_image`**: creates a new image from a description.
- **`edit_image`**: changes earlier images or combines several reference images.
- **`create_upload_link`**: lets Claude upload an image you attached in the chat so it can edit or restore it.

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
| Gemini API key | For the Nano Banana models (from Google AI Studio). Optional: you can use just one provider. |
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
4. **Open your Worker's address** (`https://imagegen-mcp.<your-subdomain>.workers.dev`). It shows a setup check.
   Every line should have a ✓. If one doesn't, fix it in the dashboard under **Workers & Pages → imagegen-mcp →
   Settings → Variables and Secrets**.

Your **connector URL** is that address followed by `/mcp/<MCP_TOKEN>`. Now go to step 2 below.

### Option B: from a computer (about 10 minutes)

```bash
git clone https://github.com/usamanassir/imagegen-mcp
cd imagegen-mcp
npm install
npx wrangler login                                  # opens the browser and signs you in to Cloudflare
npx wrangler r2 bucket create imagegen-images       # the bucket for the images
npx wrangler deploy                                 # prints https://imagegen-mcp.<your-subdomain>.workers.dev
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
https://imagegen-mcp.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>
```

Check that it works. The second command makes one real (billed) test image:

```bash
node scripts/check.mjs "https://imagegen-mcp.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>"
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

1. calls `create_upload_link`, which returns a single-use upload link that expires after 10 minutes,
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

**If you'd rather not put the token in the URL**, use `https://…workers.dev/mcp` as the URL and add the request
header `Authorization: Bearer <MCP_TOKEN>` in the connector's settings.

**Claude Code:** `claude mcp add --transport http imagegen "<connector URL>"`

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
- `quality` (OpenAI only): low, medium (default), high, xhigh, max or auto.
- `format` (OpenAI only): jpeg (default), png or webp.
- `background` (OpenAI only): transparent or opaque.

To add another model from the same providers, add a line to `MODELS` at the top of `src/index.js` and run
`npm run deploy`.

## Settings

Change these in `wrangler.jsonc` → `vars`, then run `npm run deploy`:

| Variable | Default | What it does |
|---|---|---|
| `DEFAULT_MODEL` | `gpt-image-2.5-flare` | The model used when you don't name one |
| `DEFAULT_QUALITY` | `medium` | The default OpenAI quality |
| `DAILY_LIMIT` | `100` | The most images per day (UTC); `0` turns the limit off |
| `PREVIEW_MAX_BYTES` | `1500000` | Images bigger than this are sent to Claude as a link only |
| `PREVIEW_TO_CLAUDE` | `true` | `false` means Claude never gets a copy of the image, which saves tokens |
| `ALLOWED_ORIGINS` | — | Extra browser origins allowed to call `/mcp` (claude.ai and localhost are always allowed) |

## Costs and limits

- **OpenAI and Google** charge per image. The cost goes up with resolution and quality. Set a monthly budget in
  each provider's billing settings; `DAILY_LIMIT` is a second safety net.
- **Cloudflare Workers Free** allows 100,000 requests a day and **10 ms of CPU per request**. Waiting for OpenAI or
  Google doesn't count toward that, and 1K images fit easily. Large 2K/4K outputs, especially Nano Banana PNGs, can
  go over it. If a call fails with *"Worker exceeded CPU time limit"* (error 1102), switch to **Workers Paid**
  ($5/month), or stick to 1K.
- **R2** gives you 10 GB free with no download fees. To delete old images automatically after 30 days:
  `npx wrangler r2 bucket lifecycle add imagegen-images expire-old img/ --expire-days 30`

## Security notes

- Anyone with your connector URL can make images on your bill. Keep it private. To change the token, edit it in the
  dashboard (**Settings → Variables and Secrets**) or run `npx wrangler secret put MCP_TOKEN`, then remove the
  connector and add it back with the new URL.
- Image links aren't password-protected, but they contain a random 128-bit id, so nobody can guess them.
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

- `POST /mcp/<token>` is the MCP endpoint. It uses Streamable HTTP and is stateless. It supports protocol versions
  2024-11-05 through 2025-11-25. Tool calls stream SSE keep-alives and progress while the image is being made.
- `GET /img/<id>.<ext>` serves the images from R2. Add `?download=1` to download a file.
- `PUT /upload/<link>` accepts one image (raw body or multipart form) for a link made by `create_upload_link`. The
  link is `<id>.<expiry>.<HMAC signature>`, so the server keeps no state for it; it is spent once the image exists.
- `ui://imagegen/viewer.html` is a small MCP App (spec 2026-01-26) that shows the image in the chat.
- OpenAI is called through `/v1/images/generations` and `/v1/images/edits`. Google is called through
  `models/<id>:generateContent` with image output. The code is all in `src/index.js` and `src/viewer.js` and has no
  runtime dependencies.
