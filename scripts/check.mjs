#!/usr/bin/env node
// Quick check of a deployed imagegen-mcp server (Node 18+, no dependencies).
//
//   node scripts/check.mjs "https://imagegen-mcp.<you>.workers.dev/mcp/<MCP_TOKEN>"
//   node scripts/check.mjs "<connector URL>" --generate "a red bicycle in the rain" [--model gemini-nano-banana-2.1] [--count 2]
//   node scripts/check.mjs "<connector URL>" --generate "a cat, watercolor" --generate "a cat, pencil sketch"   (several prompts)
//   node scripts/check.mjs "<connector URL>" --upload photo.jpg
//   node scripts/check.mjs "<connector URL>" --list [--query logo]
//
// The second form makes real images (billed by OpenAI/Google) and prints their links.
// The third uploads a local image through create_upload_link (free) and prints its id.
// The fourth lists stored images, newest first.

import { readFile } from "node:fs/promises";

const [url, ...rest] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) {
  console.error(
    'Usage: node scripts/check.mjs "<connector URL>" [--generate "<prompt>"] [--model <model>] [--count <n>] [--upload <file>] [--list] [--query <text>]',
  );
  process.exit(2);
}
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

let sessionId;
let nextId = 1;
async function rpc(method, params, { notification = false } = {}) {
  const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (notification) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  sessionId = res.headers.get("mcp-session-id") || sessionId;
  const json = JSON.parse(text);
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "imagegen-check", version: "1.0.0" },
  });
  console.log(`✔ Connected: ${init.serverInfo.name} ${init.serverInfo.version} (MCP ${init.protocolVersion})`);
  await rpc("notifications/initialized", {}, { notification: true });

  const { tools } = await rpc("tools/list", {});
  const models = tools[0]?.inputSchema?.properties?.model;
  console.log(`✔ Tools: ${tools.map((t) => t.name).join(", ")}`);
  console.log(`✔ Models available: ${models?.enum?.join(", ")} (default ${models?.default})`);

  const prompt = flag("--generate");
  const uploadFile = flag("--upload");
  if (uploadFile) {
    const link = await rpc("tools/call", { name: "create_upload_link", arguments: {} });
    if (link.isError) throw new Error(`create_upload_link: ${link.content?.[0]?.text}`);
    const { uploadUrl, id } = link.structuredContent;
    const res = await fetch(uploadUrl, { method: "PUT", body: await readFile(uploadFile) });
    const text = await res.text();
    if (!res.ok) throw new Error(`upload: HTTP ${res.status} ${text.slice(0, 300)}`);
    const info = JSON.parse(text);
    console.log(`✔ Uploaded ${uploadFile}: ${info.width}x${info.height} ${info.mimeType}\n  id:  ${id}\n  url: ${info.url}`);
  }
  if (prompt) {
    const args = { prompt };
    if (flag("--model")) args.model = flag("--model");
    if (flag("--count")) args.count = Number(flag("--count"));
    if (rest.filter((x) => x === "--generate").length > 1) {
      args.prompts = rest.flatMap((x, i) => (x === "--generate" ? [rest[i + 1]] : []));
      delete args.prompt;
    }
    console.log("… generating (this can take up to a minute)");
    const started = Date.now();
    const result = await rpc("tools/call", { name: "generate_image", arguments: args });
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (result.isError) {
      console.error(`✘ Generation failed: ${text}`);
      process.exit(1);
    }
    console.log(`✔ Done in ${Math.round((Date.now() - started) / 1000)} s\n${text}`);
  } else if (!uploadFile && !rest.includes("--list")) {
    console.log("All good. Add --generate \"<prompt>\" to make a test image.");
  }
  if (rest.includes("--list")) {
    const args = {};
    if (flag("--query")) args.query = flag("--query");
    const result = await rpc("tools/call", { name: "list_images", arguments: args });
    console.log(result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
  }
} catch (err) {
  console.error(`✘ ${err.message}`);
  if (/HTTP 401/.test(err.message)) console.error("  The token in the URL doesn't match the MCP_TOKEN secret.");
  if (/HTTP 500/.test(err.message)) console.error("  Is the MCP_TOKEN secret set? (npx wrangler secret put MCP_TOKEN)");
  process.exit(1);
}
