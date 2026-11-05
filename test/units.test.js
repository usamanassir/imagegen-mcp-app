import { describe, it, expect } from "vitest";
import { openAiSize, sniffMime, imageDimensions } from "../src/index.js";
import { PNG } from "./helpers.js";

describe("openAiSize", () => {
  const limits = (s) => {
    const [w, h] = s.split("x").map(Number);
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
    expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
    expect(w * h).toBeGreaterThanOrEqual(655_360);
    expect(w * h).toBeLessThanOrEqual(8_294_400);
    return [w, h];
  };

  it("square 1K is 1024x1024", () => expect(openAiSize("1:1", "1K")).toBe("1024x1024"));
  it("2K square is 2048x2048", () => expect(openAiSize("1:1", "2K")).toBe("2048x2048"));

  it("stays inside the documented limits for every ratio and size", () => {
    for (const r of ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]) {
      for (const s of ["1K", "2K", "4K"]) limits(openAiSize(r, s));
    }
  });

  it("keeps the requested orientation", () => {
    const [w, h] = limits(openAiSize("9:16", "1K"));
    expect(h).toBeGreaterThan(w);
    const [w2, h2] = limits(openAiSize("21:9", "4K"));
    expect(w2 / h2).toBeCloseTo(21 / 9, 1);
  });

  it("clamps extreme ratios to 3:1 and handles garbage", () => {
    const [w, h] = limits(openAiSize("100:1", "1K"));
    expect(w / h).toBeLessThanOrEqual(3.05);
    limits(openAiSize("nonsense", "1K"));
    limits(openAiSize("1:1", "8K"));
  });

  it("uses pixel dimensions as a ratio (edit size hint)", () => {
    const [w, h] = limits(openAiSize("1536:1024", "1K"));
    expect(w / h).toBeCloseTo(1.5, 1);
  });
});

describe("sniffMime / imageDimensions", () => {
  it("detects PNG and reads its size", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(imageDimensions(PNG)).toEqual({ width: 2, height: 3 });
  });

  it("detects JPEG (SOF0) and reads its size", () => {
    // SOI, APP0 (empty), SOF0 with 8 bits, 480 high, 640 wide, 3 components.
    const jpg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0xff, 0xd9,
    ]);
    expect(sniffMime(jpg)).toBe("image/jpeg");
    expect(imageDimensions(jpg)).toEqual({ width: 640, height: 480 });
  });

  it("detects WebP VP8X and reads its size", () => {
    const w = new Uint8Array(30);
    w.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    w.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    w.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
    // width-1 = 799 (0x31f), height-1 = 599 (0x257), little-endian 24-bit
    w.set([0x1f, 0x03, 0x00], 24);
    w.set([0x57, 0x02, 0x00], 27);
    expect(sniffMime(w)).toBe("image/webp");
    expect(imageDimensions(w)).toEqual({ width: 800, height: 600 });
  });

  it("detects GIF and rejects other data", () => {
    expect(sniffMime(new TextEncoder().encode("GIF89a......"))).toBe("image/gif");
    expect(sniffMime(new TextEncoder().encode("hello world"))).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
    expect(imageDimensions(new TextEncoder().encode("hello world"))).toBeNull();
  });
});
