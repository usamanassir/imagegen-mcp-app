import { beforeEach, describe, expect, it } from "vitest";
import { parseRange, wavInfo } from "../src/index.js";
import { ORIGIN, call, clearBucket, env, providerCalls, run, textOf } from "./helpers.js";

const lastSpeech = async () => (await fetch("https://mock.test/__speech")).json();
const WAV_BYTES = 44 + 48000;

describe("text_to_speech", () => {
  beforeEach(clearBucket);

  it("stores a WAV and returns its link, length and voice", async () => {
    const r = await call("text_to_speech", { text: "Have a wonderful day!" });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent;
    expect(sc).toMatchObject({
      model: "gemini-3.8-flash-tts",
      voice: "Kore",
      mimeType: "audio/wav",
      bytes: WAV_BYTES,
      seconds: 1,
    });
    expect(sc.url).toBe(`${ORIGIN}/audio/${sc.id}.wav`);
    expect(textOf(r)).toContain(`Audio ready: ${sc.url}`);
    expect(r.content.filter((c) => c.type !== "text")).toEqual([]);

    const stored = await env.IMAGES.head(`audio/${sc.id}.wav`);
    expect(stored.size).toBe(WAV_BYTES);
    expect(stored.customMetadata).toMatchObject({ tool: "text_to_speech", voice: "Kore", text: "Have a wonderful day!" });
  });

  it("sends the documented Interactions request, without storage at Google", async () => {
    await call("text_to_speech", {
      text: "Hello",
      voice: "Puck",
      style: "cheerful and friendly",
      model: "gemini-3.8-flash-lite-tts",
    });
    expect(await lastSpeech()).toEqual({
      model: "gemini-3.8-flash-lite-tts",
      input: [
        {
          type: "user_input",
          content: [{ type: "text", text: "Hello", annotations: [{ type: "speech_metadata", style: "cheerful and friendly" }] }],
        },
      ],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Puck" }] },
      store: false,
    });
  });

  it("leaves out annotations when there is no style", async () => {
    await call("text_to_speech", { text: "Hello" });
    expect((await lastSpeech()).input[0].content[0]).toEqual({ type: "text", text: "Hello" });
  });

  it.each([
    [{}, "'text' must be a non-empty string"],
    [{ text: "   " }, "'text' must be a non-empty string"],
    [{ text: "x".repeat(5001) }, "'text' is too long"],
    [{ text: "x", style: "y".repeat(501) }, "'style' is too long"],
    [{ text: "x", voice: "Nobody" }, "Unknown voice 'Nobody'"],
    [{ text: "x", model: "constructor" }, "Unknown speech model 'constructor'"],
  ])("rejects bad arguments %#", async (args, message) => {
    await providerCalls();
    const r = await call("text_to_speech", args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(message);
    expect((await providerCalls()).gemini).toBe(0);
  });

  it("explains a missing key", async () => {
    const r = await call("text_to_speech", { text: "x" }, { env: { GEMINI_API_KEY: "" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("GEMINI_API_KEY is not set");
  });

  it.each([
    ["fail-me", "simulated gemini failure"],
    ["no-audio", "Google returned no audio"],
    ["not-wav", "unexpected format"],
  ])("reports a provider problem and stores nothing: %s", async (text, message) => {
    const r = await call("text_to_speech", { text });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(message);
    expect((await env.IMAGES.list({ prefix: "audio/" })).objects).toEqual([]);
    expect(await env.IMAGES.head(`usage/${new Date().toISOString().slice(0, 10)}`)).toBeNull();
  });

  it("counts toward DAILY_LIMIT, shared with images", async () => {
    const limited = { env: { DAILY_LIMIT: "2" } };
    expect((await call("generate_image", { prompt: "one" }, limited)).isError).toBeUndefined();
    expect((await call("text_to_speech", { text: "two" }, limited)).isError).toBeUndefined();
    const r = await call("text_to_speech", { text: "three" }, limited);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Daily limit of 2 images and audio clips reached");
  });

  it("isn't included in list_images", async () => {
    await call("text_to_speech", { text: "not an image" });
    expect((await call("list_images")).structuredContent.total).toBe(0);
  });
});

describe("/audio", () => {
  let url;
  beforeEach(async () => {
    await clearBucket();
    ({ url } = (await call("text_to_speech", { text: "hello" })).structuredContent);
  });
  const get = (headers = {}, target = url, method = "GET") => run(new Request(target, { method, headers }));

  it("serves the whole file and advertises ranges", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(WAV_BYTES));
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect((await res.arrayBuffer()).byteLength).toBe(WAV_BYTES);
  });

  it("serves a byte range, as Safari asks for", async () => {
    const res = await get({ range: "bytes=0-1" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${WAV_BYTES}`);
    expect(res.headers.get("content-length")).toBe("2");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("RI");
  });

  it("answers 416 for a range past the end", async () => {
    const res = await get({ range: `bytes=${WAV_BYTES}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${WAV_BYTES}`);
  });

  it("answers HEAD without a body, and honours ?download", async () => {
    const head = await get({}, url, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(WAV_BYTES));
    expect(await head.text()).toBe("");
    expect((await get({}, `${url}?download=1`)).headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("rejects bad names, unknown ids and other methods", async () => {
    expect((await get({}, `${ORIGIN}/audio/..%2Fusage.wav`)).status).toBe(404);
    expect((await get({}, `${ORIGIN}/audio/${"a".repeat(22)}.wav`)).status).toBe(404);
    expect((await get({}, url, "POST")).status).toBe(405);
  });
});

describe("parseRange", () => {
  it.each([
    [null, null],
    ["", null],
    ["bytes=0-9", { offset: 0, length: 10 }],
    ["bytes=90-", { offset: 90, length: 10 }],
    ["bytes=90-500", { offset: 90, length: 10 }],
    ["bytes=-10", { offset: 90, length: 10 }],
    ["bytes=-500", { offset: 0, length: 100 }],
    ["bytes=100-", "unsatisfiable"],
    ["bytes=-0", "unsatisfiable"],
    ["bytes=5-2", null],
    ["bytes=-", null],
    ["bytes=0-1,5-6", null],
    ["items=0-1", null],
  ])("%s", (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });
});

describe("wavInfo", () => {
  const bytes = (s, n = 44) => {
    const b = new Uint8Array(n);
    [...s].forEach((c, i) => (b[i] = c.charCodeAt(0)));
    return b;
  };

  it("rejects anything that isn't a WAV header", () => {
    expect(wavInfo(new Uint8Array(10))).toBeNull();
    expect(wavInfo(bytes("not a wav file at all, but long enough"))).toBeNull();
    expect(wavInfo(bytes("RIFF0000WAVE"))).toBeNull();
  });

  it("works out the length from the byte rate, tolerating a missing rate", () => {
    const b = bytes("RIFF0000WAVEfmt ", 44 + 96000);
    expect(wavInfo(b)).toEqual({ seconds: null });
    new DataView(b.buffer).setUint32(28, 48000, true);
    expect(wavInfo(b)).toEqual({ seconds: 2 });
  });
});
