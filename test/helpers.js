import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";

export const TOKEN = "test-token-0123456789abcdef";
export const ORIGIN = "https://imagegen.test";
export const MCP_URL = `${ORIGIN}/mcp/${TOKEN}`;

// 2x3 PNG, 76 bytes.
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeBgMBmgS2IwAAAABJRU5ErkJggg==";
export const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

/** Run one request through the Worker with optional env overrides, waiting for background work. */
export async function run(request, overrides = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let nextId = 1;
export function rpcRequest(method, params, { url = MCP_URL, headers = {}, id = nextId++ } = {}) {
  const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** JSON-RPC call; returns the parsed response body. */
export async function rpc(method, params = {}, opts = {}) {
  const res = await run(rpcRequest(method, params, opts), opts.env);
  return res.json();
}

/** tools/call shortcut; returns the tool result (content, structuredContent, isError). */
export async function call(name, args = {}, opts = {}) {
  const out = await rpc("tools/call", { name, arguments: args }, opts);
  if (out.error) throw new Error(`rpc error: ${out.error.message}`);
  return out.result;
}

export const textOf = (result) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** Number of requests the mock providers received since the last call (see test/mock-providers.js). */
export async function providerCalls() {
  return (await fetch("https://mock.test/__calls")).json();
}

/** Empty the R2 bucket so tests don't see each other's images or usage counters. */
export async function clearBucket() {
  let cursor;
  do {
    const page = await env.IMAGES.list({ limit: 1000, cursor });
    if (page.objects.length) await env.IMAGES.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export { env, worker, createExecutionContext, waitOnExecutionContext };
