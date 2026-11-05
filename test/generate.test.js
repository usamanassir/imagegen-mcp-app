import { describe, it, expect, beforeEach } from "vitest";
import { call, textOf, run, providerCalls, clearBucket, env, ORIGIN, PNG } from "./helpers.js";

beforeEach(async () => {
  await clearBucket();
  await providerCalls(); // reset counters
});

describe("generate_image: single", () => {
  it("returns link, id, preview and structuredContent, and stores the image", async () => {
    const r = await call("generate_image", { prompt: "a lighthouse at dusk" });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent;
    expect(sc.url).toBe(`${ORIGIN}/img/${sc.id}.png`);
    expect(sc).toMatchObject({ count: 1, model: "gpt-image-2.5-flare", width: 2, height: 3, mimeType: "image/png", sources: [] });
    expect(sc.images[0].preview).toBe(true);
    expect(sc.images[0].prompt).toBeUndefined();
    expect(r.content[0].type).toBe("text");
    expect(textOf(r)).toMatch(/^Image ready: /);
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((await providerCalls()).openai).toBe(1);

    // Stored with metadata and served back.
    const obj = await env.IMAGES.get(`img/${sc.id}.png`);
    expect(obj.customMetadata).toMatchObject({ tool: "generate_image", model: "gpt-image-2.5-flare", prompt: "a lighthouse at dusk" });
    const served = await run(new Request(sc.url));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    const dl = await run(new Request(`${sc.url}?download=1`));
    expect(dl.headers.get("content-disposition")).toContain("attachment");
  });

  it("uses the Gemini API for Nano Banana models and passes on the model note", async () => {
    const r = await call("generate_image", { prompt: "sunset", model: "gemini-nano-banana-2.1" });
    expect(r.isError).toBeUndefined();
    expect((await providerCalls()).gemini).toBe(1);
    expect(textOf(r)).toContain("Model note: Here is your image.");
  });

  it("reports a blocked Gemini response as a tool error", async () => {
    const r = await call("generate_image", { prompt: "blocked", model: "gemini-nano-banana-2.1" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("reason: SAFETY");
  });

  it("validates arguments", async () => {
    const cases = [
      [{}, "'prompt' (or 'prompts') is required"],
      [{ prompt: "   " }, "non-empty"],
      [{ prompt: "x".repeat(32001) }, "too long"],
      [{ prompt: "x", model: "dall-e" }, "Unknown model"],
      [{ prompt: "x", aspect_ratio: "5:4" }, "Invalid aspect_ratio"],
      [{ prompt: "x", resolution: "8K" }, "Invalid resolution"],
      [{ prompt: "x", quality: "ultra" }, "Invalid quality"],
      [{ prompt: "x", count: 5 }, "1 to 4"],
      [{ prompt: "x", count: 1.5 }, "1 to 4"],
      [{ prompt: "x", prompts: ["y"] }, "not both"],
      [{ prompts: [] }, "non-empty array"],
      [{ prompts: ["a", ""] }, "prompts[1]"],
      [{ prompts: ["a", "b", "c", "d", "e"] }, "at most 4"],
      [{ prompts: ["a", "b", "c"], count: 2 }, "at most 4 per call"],
    ];
    for (const [args, msg] of cases) {
      const r = await call("generate_image", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(r), JSON.stringify(args)).toContain(msg);
    }
    expect((await providerCalls()).openai).toBe(0);
  });

  it("switches jpeg to png for transparent backgrounds", async () => {
    const r = await call("generate_image", { prompt: "logo", background: "transparent" });
    expect(r.isError).toBeUndefined();
    // The mock always returns PNG bytes; what matters is the request was accepted and stored as png.
    expect(r.structuredContent.url).toMatch(/\.png$/);
  });

  it("surfaces provider errors", async () => {
    const r = await call("generate_image", { prompt: "fail-me" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("OpenAI returned an error (400): simulated openai failure");
  });
});

describe("generate_image: count and prompts", () => {
  it("count=3 makes one OpenAI request with n=3 and returns 3 images", async () => {
    const r = await call("generate_image", { prompt: "cafe logo", count: 3 });
    expect((await providerCalls()).openai).toBe(1);
    const sc = r.structuredContent;
    expect(sc.count).toBe(3);
    expect(new Set(sc.images.map((i) => i.id)).size).toBe(3);
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(3);
    expect(textOf(r)).toMatch(/Image 1: .*\n.*\nImage 2: /);
    expect(textOf(r)).toContain("ask which one they prefer");
  });

  it("count=2 on Gemini runs two parallel requests", async () => {
    const r = await call("generate_image", { prompt: "x", model: "gemini-nano-banana-2.1", count: 2 });
    expect((await providerCalls()).gemini).toBe(2);
    expect(r.structuredContent.count).toBe(2);
  });

  it("prompts[] runs one request per prompt and labels each image", async () => {
    const r = await call("generate_image", { prompts: ["cat watercolor", "cat sketch", "cat 3d"] });
    expect((await providerCalls()).openai).toBe(3);
    const sc = r.structuredContent;
    expect(sc.count).toBe(3);
    expect(sc.prompts).toEqual(["cat watercolor", "cat sketch", "cat 3d"]);
    expect(sc.images.map((i) => i.prompt)).toEqual(["cat watercolor", "cat sketch", "cat 3d"]);
    expect(textOf(r)).toContain('Image 1 (prompt: "cat watercolor")');
    const obj = await env.IMAGES.get(`img/${sc.images[2].id}.png`);
    expect(obj.customMetadata.prompt).toBe("cat 3d");
  });

  it("prompts x count is honoured up to 4", async () => {
    const r = await call("generate_image", { prompts: ["a", "b"], count: 2 });
    expect((await providerCalls()).openai).toBe(2);
    expect(r.structuredContent.count).toBe(4);
  });

  it("keeps the successful prompts when one fails, and errors when all fail", async () => {
    let r = await call("generate_image", { prompts: ["ok", "fail-me"] });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.count).toBe(1);
    expect(textOf(r)).toContain("1 of 2 images failed: OpenAI returned an error (400): simulated openai failure");

    r = await call("generate_image", { prompt: "x", model: "gemini-nano-banana-2.1", prompts: undefined, count: 1 });
    expect(r.isError).toBeUndefined();

    r = await call("generate_image", { prompts: ["fail-me", "fail-me again"] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("simulated openai failure");
  });
});

describe("previews and limits", () => {
  it("drops previews beyond the byte budget but keeps the links", async () => {
    // Each test PNG is 76 bytes; a budget of 100 fits exactly one.
    const r = await call("generate_image", { prompt: "x", count: 3 }, { env: { PREVIEW_MAX_BYTES: "100" } });
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(1);
    expect(r.structuredContent.images.map((i) => i.preview)).toEqual([true, false, false]);
    expect(textOf(r)).toContain("not attached here");
  });

  it("sends no previews when PREVIEW_TO_CLAUDE is false", async () => {
    const r = await call("generate_image", { prompt: "x" }, { env: { PREVIEW_TO_CLAUDE: "false" } });
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(0);
    expect(r.structuredContent.url).toBeTruthy();
  });

  it("enforces DAILY_LIMIT across calls, counting every image", async () => {
    const env = { DAILY_LIMIT: "3" };
    let r = await call("generate_image", { prompt: "x", count: 2 }, { env });
    expect(r.isError).toBeUndefined();
    r = await call("generate_image", { prompt: "x", count: 2 }, { env });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Daily limit of 3 images reached (1 left today, 2 requested)");
    r = await call("generate_image", { prompt: "x" }, { env });
    expect(r.isError).toBeUndefined();
    r = await call("generate_image", { prompt: "x" }, { env });
    expect(r.isError).toBe(true);
    expect((await providerCalls()).openai).toBe(2);
  });

  it("DAILY_LIMIT=0 turns the limit off", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call("generate_image", { prompt: "x", count: 4 }, { env: { DAILY_LIMIT: "0" } });
      expect(r.isError).toBeUndefined();
    }
  });
});
