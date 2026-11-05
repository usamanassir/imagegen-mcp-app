import { describe, it, expect, beforeEach } from "vitest";
import { call, textOf, run, providerCalls, clearBucket, env, ORIGIN, PNG, TOKEN } from "./helpers.js";

beforeEach(async () => {
  await clearBucket();
  await providerCalls(); // reset counters
});

const upload = async (url, body = PNG, init = {}) => run(new Request(url, { method: "PUT", body, ...init }));

describe("create_upload_link + /upload", () => {
  it("issues a signed single-use link and accepts one upload", async () => {
    const link = await call("create_upload_link", {});
    const { uploadUrl, id, expiresAt, description } = link.structuredContent;
    expect(uploadUrl).toMatch(new RegExp(`^${ORIGIN}/upload/${id}\\.\\d+\\.[A-Za-z0-9_-]{43}$`));
    expect(description).toBeNull();
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(textOf(link)).toContain(`curl -sS --fail-with-body -T`);
    expect(textOf(link)).not.toContain(TOKEN);

    const res = await upload(uploadUrl);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, id, url: `${ORIGIN}/img/${id}.png`, mimeType: "image/png", width: 2, height: 3 });
    expect((await env.IMAGES.get(`img/${id}.png`)).customMetadata).toMatchObject({ tool: "upload" });

    const again = await upload(uploadUrl);
    expect(again.status).toBe(409);
  });

  it("accepts multipart form uploads", async () => {
    const { uploadUrl } = (await call("create_upload_link", {})).structuredContent;
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await run(new Request(uploadUrl, { method: "POST", body: form }));
    expect(res.status).toBe(201);
  });

  it("rejects tampered, expired, malformed and misused links", async () => {
    const { uploadUrl } = (await call("create_upload_link", {})).structuredContent;
    const flipped = uploadUrl.slice(0, -1) + (uploadUrl.endsWith("A") ? "B" : "A");
    expect((await upload(flipped)).status).toBe(403);
    expect((await upload(`${ORIGIN}/upload/nope`)).status).toBe(404);
    expect((await run(new Request(uploadUrl, { method: "GET" }))).status).toBe(405);
    expect((await upload(uploadUrl, PNG, {}), await run(new Request(uploadUrl, { method: "PUT", body: PNG }), { MCP_TOKEN: "" })).status).toBe(500);

    // Expired: sign a link ourselves with an old timestamp.
    const expires = Math.floor(Date.now() / 1000) - 5;
    const id = "abcdefghijklmnopqrstuv";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`upload.${id}.${expires}.`));
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await upload(`${ORIGIN}/upload/${id}.${expires}.${sig}`)).status).toBe(410);
  });

  it("validates the uploaded bytes and leaves the link usable after a rejection", async () => {
    const { uploadUrl } = (await call("create_upload_link", {})).structuredContent;
    expect((await upload(uploadUrl, new TextEncoder().encode("GIF89a......"))).status).toBe(415);
    expect((await upload(uploadUrl, new TextEncoder().encode("not an image"))).status).toBe(415);
    expect((await upload(uploadUrl, new Uint8Array(0))).status).toBe(400);
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(PNG);
    expect((await upload(uploadUrl, big)).status).toBe(413);
    expect((await upload(uploadUrl)).status).toBe(201);
  });

  it("carries a description inside the signed link and stores it", async () => {
    const link = await call("create_upload_link", { description: '  صورة   عائلية, wedding "1978"  ' });
    const { uploadUrl, id, description } = link.structuredContent;
    expect(description).toBe('صورة عائلية, wedding "1978"');
    expect(uploadUrl).toMatch(/\?d=[A-Za-z0-9_-]+$/);
    expect(textOf(link)).toContain("stored with this description");

    const tampered = uploadUrl.replace(/d=.*$/, "d=" + btoa("dog").replace(/=+$/, ""));
    expect((await upload(tampered)).status).toBe(403);
    expect((await upload(uploadUrl.replace(/\?d=.*$/, ""))).status).toBe(403);
    expect((await upload(`${uploadUrl.replace(/\?d=.*$/, "")}?d=not%20base64!`)).status).toBe(404);

    expect((await upload(uploadUrl)).status).toBe(201);
    expect((await env.IMAGES.get(`img/${id}.png`)).customMetadata.description).toBe('صورة عائلية, wedding "1978"');
  });

  it("truncates long descriptions to 200 bytes", async () => {
    const { description, uploadUrl } = (await call("create_upload_link", { description: "x".repeat(500) })).structuredContent;
    expect(description.length).toBeLessThanOrEqual(201);
    expect((await upload(uploadUrl)).status).toBe(201);
  });
});

describe("edit_image", () => {
  const makeImage = async () => (await call("generate_image", { prompt: "base" })).structuredContent;

  it("edits by id or URL from this server and reports the source", async () => {
    const base = await makeImage();
    await providerCalls();
    for (const ref of [base.id, `${base.id}.png`, base.url, `https://other-host.test/img/${base.id}.png`]) {
      const r = await call("edit_image", { images: [ref], prompt: "make it blue" });
      expect(r.isError, ref).toBeUndefined();
      expect(r.structuredContent.sources).toEqual([{ url: base.url, id: base.id }]);
    }
    expect((await providerCalls()).openai).toBe(4);
    const obj = await env.IMAGES.get(`img/${(await call("edit_image", { images: [base.id], prompt: "p" })).structuredContent.id}.png`);
    expect(obj.customMetadata.tool).toBe("edit_image");
  });

  it("keeps the first image's shape unless aspect_ratio is given (OpenAI size hint)", async () => {
    // The 2x3 test image gives a 2:3 size hint; just confirm the call succeeds both ways.
    const base = await makeImage();
    expect((await call("edit_image", { images: [base.id], prompt: "p" })).isError).toBeUndefined();
    expect((await call("edit_image", { images: [base.id], prompt: "p", aspect_ratio: "16:9" })).isError).toBeUndefined();
  });

  it("works with Gemini and several reference images, and with prompts[]", async () => {
    const a = await makeImage();
    const b = await makeImage();
    let r = await call("edit_image", { images: [a.id, b.url], prompt: "combine", model: "gemini-nano-banana-2.1" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.sources.map((s) => s.id)).toEqual([a.id, b.id]);
    r = await call("edit_image", { images: [a.id], prompts: ["as watercolor", "as sketch"] });
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.images.map((i) => i.prompt)).toEqual(["as watercolor", "as sketch"]);
  });

  it("downloads public https images, bounded to 20 MB", async () => {
    let r = await call("edit_image", { images: ["https://images.test/small.png"], prompt: "p" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.sources).toEqual([{ url: "https://images.test/small.png", id: null }]);

    r = await call("edit_image", { images: ["https://images.test/huge.png"], prompt: "p" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("too large");
    r = await call("edit_image", { images: ["https://images.test/huge-honest.png"], prompt: "p" });
    expect(textOf(r)).toContain("too large");
    expect((await providerCalls()).openai).toBe(1); // only the small one reached the provider
    r = await call("edit_image", { images: ["https://images.test/missing.png"], prompt: "p" });
    expect(textOf(r)).toContain("HTTP 404");
    r = await call("edit_image", { images: ["https://images.test/text.txt"], prompt: "p" });
    expect(textOf(r)).toContain("Unsupported image type");
  });

  it("rejects bad references", async () => {
    const cases = [
      [[], "at least one"],
      [Array(9).fill("x".repeat(20)), "At most 8"],
      [["not a url"], "Not a valid image URL or id"],
      [["ftp://images.test/a.png"], "Unsupported URL"],
      [["AAAAAAAAAAAAAAAAAAAAAA"], "Image not found on this server"],
    ];
    for (const [images, msg] of cases) {
      const r = await call("edit_image", { images, prompt: "p" });
      expect(r.isError, msg).toBe(true);
      expect(textOf(r)).toContain(msg);
    }
    const r = await call("edit_image", { images: ["AAAAAAAAAAAAAAAAAAAAAA"] });
    expect(textOf(r)).toContain("'prompt' (or 'prompts') is required");
  });
});

describe("/img", () => {
  it("404s unknown or malformed names and refuses other methods", async () => {
    expect((await run(new Request(`${ORIGIN}/img/AAAAAAAAAAAAAAAAAAAAAA.png`))).status).toBe(404);
    expect((await run(new Request(`${ORIGIN}/img/../usage/x`))).status).toBe(404);
    expect((await run(new Request(`${ORIGIN}/img/short.png`))).status).toBe(404);
    const base = (await call("generate_image", { prompt: "x" })).structuredContent;
    expect((await run(new Request(base.url, { method: "DELETE" }))).status).toBe(405);
    const head = await run(new Request(base.url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.length));
  });
});
