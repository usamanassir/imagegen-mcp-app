import { describe, it, expect } from "vitest";
import { run, rpc, rpcRequest, call, textOf, env, worker, createExecutionContext, waitOnExecutionContext, MCP_URL, ORIGIN, TOKEN } from "./helpers.js";


describe("routing and status", () => {
  it("serves a plain-text setup check at /", async () => {
    const res = await run(new Request(`${ORIGIN}/`));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("✓ MCP_TOKEN");
    expect(body).toContain("✓ OPENAI_API_KEY");
    expect(body).toContain("Retention       off");
    expect(body).not.toContain(TOKEN);
  });

  it("reports missing keys and retention on the status page", async () => {
    const res = await run(new Request(`${ORIGIN}/`), { GEMINI_API_KEY: "", RETENTION_DAYS: "14" });
    const body = await res.text();
    expect(body).toContain("✗ GEMINI_API_KEY");
    expect(body).toContain("deleted after 14 days");
  });

  it("404s unknown paths and answers CORS preflight", async () => {
    expect((await run(new Request(`${ORIGIN}/nope`))).status).toBe(404);
    const pre = await run(new Request(MCP_URL, { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
  });
});

describe("authentication", () => {
  it("accepts the token in the path", async () => {
    const out = await rpc("ping");
    expect(out.result).toEqual({});
  });

  it("accepts a Bearer token on /mcp", async () => {
    const out = await rpc("ping", {}, { url: `${ORIGIN}/mcp`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(out.result).toEqual({});
  });

  it("rejects a wrong or missing token with 401", async () => {
    const bad = await run(rpcRequest("ping", {}, { url: `${ORIGIN}/mcp/wrong-token-0123456789` }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("Bearer");
    const none = await run(rpcRequest("ping", {}, { url: `${ORIGIN}/mcp` }));
    expect(none.status).toBe(401);
  });

  it("refuses to run with a missing, short or placeholder MCP_TOKEN", async () => {
    for (const t of ["", "short", "change-me"]) {
      const res = await run(rpcRequest("ping", {}, { url: `${ORIGIN}/mcp/${t}` }), { MCP_TOKEN: t });
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("Server not configured");
    }
  });

  it("rejects non-POST methods", async () => {
    expect((await run(new Request(MCP_URL, { method: "GET" }))).status).toBe(405);
  });
});

describe("origin check", () => {
  const withOrigin = (origin, env) => run(rpcRequest("ping", {}, { headers: { origin } }), env);

  it("allows claude.ai, localhost and the server's own origin", async () => {
    for (const o of ["https://claude.ai", "https://app.claude.com", "http://localhost:3000", ORIGIN]) {
      expect((await withOrigin(o)).status, o).toBe(200);
    }
  });

  it("blocks other origins unless listed in ALLOWED_ORIGINS", async () => {
    expect((await withOrigin("https://evil.example")).status).toBe(403);
    expect((await withOrigin("http://claude.ai")).status).toBe(403); // plain http
    expect((await withOrigin("https://evil.example", { ALLOWED_ORIGINS: "https://evil.example" })).status).toBe(200);
    expect((await withOrigin("https://evil.example", { ALLOWED_ORIGINS: "*" })).status).toBe(200);
  });
});

describe("protocol handling", () => {
  it("initialize negotiates a supported version and mints a session id", async () => {
    const res = await run(rpcRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
    const out = await res.json();
    expect(out.result.protocolVersion).toBe("2025-06-18");
    expect(out.result.serverInfo.name).toBe("imagegen-mcp");
    expect(out.result.instructions).toContain("generate_image");
    expect(res.headers.get("mcp-session-id")).toMatch(/^u0\./);
  });

  it("falls back to the newest supported version for unknown ones", async () => {
    const out = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    expect(out.result.protocolVersion).toBe("2025-11-25");
  });

  it("records MCP Apps support in the session id and attaches viewer meta to tools", async () => {
    const caps = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
    const res = await run(rpcRequest("initialize", { protocolVersion: "2025-11-25", capabilities: caps }));
    const sid = res.headers.get("mcp-session-id");
    expect(sid).toMatch(/^u1\./);

    const withUi = await rpc("tools/list", {}, { headers: { "mcp-session-id": sid } });
    expect(withUi.result.tools.find((t) => t.name === "generate_image")._meta.ui.resourceUri).toBe("ui://imagegen/viewer.html");
    const noUi = await rpc("tools/list", {}, { headers: { "mcp-session-id": "u0.x" } });
    expect(noUi.result.tools.find((t) => t.name === "generate_image")._meta).toBeUndefined();
  });

  it("rejects unsupported protocol version headers with 400", async () => {
    const res = await run(rpcRequest("ping", {}, { headers: { "mcp-protocol-version": "2030-01-01" } }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unsupported MCP protocol version");
  });

  it("rejects stateless-era messages (protocolVersion in _meta)", async () => {
    const res = await run(rpcRequest("ping", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-03-01" } }));
    expect(res.status).toBe(400);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await run(rpcRequest("notifications/initialized", {}, { id: null }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers batches as arrays, skipping notifications", async () => {
    const body = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "nope" },
    ];
    const res = await run(new Request(MCP_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const out = await res.json();
    expect(out).toHaveLength(2);
    expect(out[0].result).toEqual({});
    expect(out[1].error.code).toBe(-32601);
  });

  it("returns JSON-RPC errors for bad input", async () => {
    const parse = await run(new Request(MCP_URL, { method: "POST", body: "{not json" }));
    expect(parse.status).toBe(400);
    expect((await parse.json()).error.code).toBe(-32700);

    const invalid = await run(new Request(MCP_URL, { method: "POST", body: JSON.stringify({ hello: 1 }) }));
    expect((await invalid.json()).error.code).toBe(-32600);

    expect((await rpc("no/such")).error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "no_such_tool" })).error.code).toBe(-32602);
    expect((await rpc("resources/read", { uri: "ui://other" })).error.code).toBe(-32002);
  });

  it("lists the viewer resource and serves it with a CSP for this origin", async () => {
    const list = await rpc("resources/list");
    expect(list.result.resources[0].uri).toBe("ui://imagegen/viewer.html");
    const read = await rpc("resources/read", { uri: "ui://imagegen/viewer.html" });
    const c = read.result.contents[0];
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toContain("<!doctype html>");
    expect(c._meta.ui.csp).toEqual({ resourceDomains: [ORIGIN], connectDomains: [ORIGIN] });
    expect((await rpc("prompts/list")).result.prompts).toEqual([]);
    expect((await rpc("resources/templates/list")).result.resourceTemplates).toEqual([]);
  });

  it("streams tools/call as SSE when the client accepts it", async () => {
    // Read the stream before waiting on the context: the writer blocks until the body is consumed.
    const ctx = createExecutionContext();
    const req = rpcRequest("tools/call", { name: "generate_image", arguments: { prompt: "x" } }, { headers: { accept: "text/event-stream" } });
    const res = await worker.fetch(req, { ...env, KEEPALIVE_MS: "1000" }, ctx);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    await waitOnExecutionContext(ctx);
    const events = body.split("\n\n").filter((e) => e.startsWith("event: message"));
    const last = JSON.parse(events.at(-1).replace("event: message\ndata: ", ""));
    expect(last.result.structuredContent.count).toBe(1);
  });
});

describe("tools/list", () => {
  it("lists five tools with model enums limited to configured providers", async () => {
    const all = (await rpc("tools/list")).result.tools;
    expect(all.map((t) => t.name)).toEqual(["generate_image", "edit_image", "create_upload_link", "list_images", "text_to_speech"]);
    expect(all[0].inputSchema.properties.model.enum).toHaveLength(4);

    const openaiOnly = (await rpc("tools/list", {}, { env: { GEMINI_API_KEY: "" } })).result.tools;
    expect(openaiOnly.map((t) => t.name)).not.toContain("text_to_speech");
    expect(openaiOnly[0].inputSchema.properties.model.enum).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
    expect(openaiOnly[1].description).toContain("prefer gpt-image-2.5-sunburst and");
    expect(openaiOnly[1].description).not.toContain("nano-banana");
  });

  it("uses DEFAULT_MODEL and DEFAULT_QUALITY when valid, else falls back", async () => {
    let t = (await rpc("tools/list", {}, { env: { DEFAULT_MODEL: "gemini-3.1-flash-image", DEFAULT_QUALITY: "high" } })).result.tools[0];
    expect(t.inputSchema.properties.model.default).toBe("gemini-3.1-flash-image");
    expect(t.inputSchema.properties.quality.default).toBe("high");
    t = (await rpc("tools/list", {}, { env: { DEFAULT_MODEL: "bogus", DEFAULT_QUALITY: "bogus" } })).result.tools[0];
    expect(t.inputSchema.properties.model.default).toBe("gpt-image-2.5-flare");
    expect(t.inputSchema.properties.quality.default).toBe("medium");
  });

  it("falls back to all models when no key is set, and errors clearly on call", async () => {
    const env = { OPENAI_API_KEY: "", GEMINI_API_KEY: "" };
    const t = (await rpc("tools/list", {}, { env })).result.tools[0];
    expect(t.inputSchema.properties.model.enum).toHaveLength(4);
    const r = await call("generate_image", { prompt: "x" }, { env });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("OPENAI_API_KEY is not set");
  });
});
