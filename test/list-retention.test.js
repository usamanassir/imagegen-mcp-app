import { describe, it, expect, beforeEach } from "vitest";
import { call, textOf, clearBucket, env, worker, createExecutionContext, waitOnExecutionContext, ORIGIN, PNG } from "./helpers.js";


describe("list_images", () => {
  beforeEach(clearBucket);
  // Put images straight into R2 with controlled metadata so ordering is deterministic.
  const seed = async (items) => {
    for (const [id, meta] of items) {
      await env.IMAGES.put(`img/${id}.png`, PNG, { httpMetadata: { contentType: "image/png" }, customMetadata: meta });
    }
  };
  const ids = ["AAAAAAAAAAAAAAAAAAAAA1", "AAAAAAAAAAAAAAAAAAAAA2", "AAAAAAAAAAAAAAAAAAAAA3", "AAAAAAAAAAAAAAAAAAAAA4"];

  it("returns an empty result on a fresh server", async () => {
    const r = await call("list_images", {});
    expect(r.structuredContent).toMatchObject({ kind: "list", total: 0, count: 0, images: [] });
    expect(textOf(r)).toContain("No images are stored");
  });

  it("lists newest first with prompt, model, description and server time", async () => {
    await seed([
      [ids[0], { tool: "generate_image", model: "gpt-image-2.5-flare", prompt: "cafe logo, flat", created: "2026-11-01T10:00:00.000Z" }],
      [ids[1], { tool: "edit_image", model: "gemini-nano-banana-2.1", prompt: "make it night", created: "2026-11-03T10:00:00.000Z" }],
      [ids[2], { tool: "upload", description: "old family photo", created: "2026-11-02T10:00:00.000Z" }],
    ]);
    const r = await call("list_images", {});
    const sc = r.structuredContent;
    expect(sc.total).toBe(3);
    expect(sc.images.map((i) => i.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(sc.images[1]).toMatchObject({ tool: "upload", description: "old family photo", prompt: null, url: `${ORIGIN}/img/${ids[2]}.png`, bytes: PNG.length });
    expect(sc.images[2]).toMatchObject({ model: "gpt-image-2.5-flare", prompt: "cafe logo, flat" });
    expect(sc.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const t = textOf(r);
    expect(t).toContain("3 of 3 stored images, newest first. Server time now:");
    expect(t).toContain('2026-11-03 10:00 UTC · id AAAAAAAAAAAAAAAAAAAAA2 · edit_image with gemini-nano-banana-2.1 · "make it night"');
    expect(t).toContain('uploaded by the user · "old family photo"');
  });

  it("filters by query over prompt, description, model and id, and honours limit", async () => {
    await seed([
      [ids[0], { tool: "generate_image", model: "gpt-image-2.5-flare", prompt: "Cafe Logo", created: "2026-11-01T10:00:00.000Z" }],
      [ids[1], { tool: "generate_image", model: "gpt-image-2.5-flare", prompt: "a dog", created: "2026-11-02T10:00:00.000Z" }],
      [ids[2], { tool: "upload", description: "logo sketch", created: "2026-11-03T10:00:00.000Z" }],
      [ids[3], { tool: "generate_image", model: "gemini-nano-banana-2.1", prompt: "a cat", created: "2026-11-04T10:00:00.000Z" }],
    ]);
    let r = await call("list_images", { query: "LOGO" });
    expect(r.structuredContent.images.map((i) => i.id)).toEqual([ids[2], ids[0]]);
    r = await call("list_images", { query: "nano" });
    expect(r.structuredContent.images.map((i) => i.id)).toEqual([ids[3]]);
    r = await call("list_images", { query: ids[1] });
    expect(r.structuredContent.count).toBe(1);
    r = await call("list_images", { query: "zzz" });
    expect(r.structuredContent.count).toBe(0);
    expect(textOf(r)).toContain('No stored images match "zzz"');

    r = await call("list_images", { limit: 2 });
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.total).toBe(4);
    expect(textOf(r)).toContain("(2 more;");
    r = await call("list_images", { limit: 999 });
    expect(r.structuredContent.count).toBe(4); // clamped to MAX_LIST, which is > 4
  });

  it("ignores non-image keys and falls back to the upload date when metadata is missing", async () => {
    await env.IMAGES.put("usage/2026-11-05", "3");
    await env.IMAGES.put(`img/${ids[0]}.png`, PNG);
    const r = await call("list_images", {});
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.images[0]).toMatchObject({ id: ids[0], tool: "unknown", prompt: null });
    expect(r.structuredContent.images[0].created).toMatch(/^\d{4}-/);
  });

  it("sees images made by the tools in the same session", async () => {
    await call("generate_image", { prompt: "fresh one" });
    const r = await call("list_images", { query: "fresh" });
    expect(r.structuredContent.count).toBe(1);
  });
});

describe("retention (scheduled)", () => {
  const day = 86_400_000;
  const now = Date.now();
  // The in-memory R2 can't backdate objects, so the purge logic is tested with a fake bucket.
  const fakeBucket = (objects) => {
    const deleted = [];
    return {
      deleted,
      bucket: {
        async list({ prefix, cursor }) {
          const all = objects.filter((o) => o.key.startsWith(prefix));
          const i = Number(cursor || 0); // one object per page, to exercise pagination
          return { objects: all.slice(i, i + 1), truncated: i + 1 < all.length, cursor: String(i + 1) };
        },
        async delete(keys) {
          deleted.push(...keys);
        },
      },
    };
  };
  const objects = [
    { key: "img/old45.png", uploaded: new Date(now - 45 * day) },
    { key: "img/old15.jpg", uploaded: new Date(now - 15 * day) },
    { key: "img/edge.png", uploaded: new Date(now - 13.9 * day) },
    { key: "img/new.png", uploaded: new Date(now - 0.5 * day) },
    { key: "usage/2026-10-01", uploaded: new Date(now - 10 * day) },
    { key: "usage/today", uploaded: new Date(now) },
  ];
  const purge = async (vars) => {
    const { bucket, deleted } = fakeBucket(objects);
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "23 3 * * *", scheduledTime: now }, { ...env, IMAGES: bucket, ...vars }, ctx);
    await waitOnExecutionContext(ctx);
    return deleted.sort();
  };

  it("deletes images older than RETENTION_DAYS and stale usage counters", async () => {
    expect(await purge({ RETENTION_DAYS: "14" })).toEqual(["img/old15.jpg", "img/old45.png", "usage/2026-10-01"]);
    expect(await purge({ RETENTION_DAYS: "1" })).toEqual(["img/edge.png", "img/old15.jpg", "img/old45.png", "usage/2026-10-01"]);
  });

  it("deletes nothing when retention is 0, unset or invalid", async () => {
    expect(await purge({ RETENTION_DAYS: "0" })).toEqual([]);
    expect(await purge({ RETENTION_DAYS: undefined })).toEqual([]);
    expect(await purge({ RETENTION_DAYS: "soon" })).toEqual([]);
  });

  it("runs against the real bucket without deleting fresh images", async () => {
    const { id } = (await call("generate_image", { prompt: "keep me" })).structuredContent;
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "23 3 * * *", scheduledTime: Date.now() }, { ...env, RETENTION_DAYS: "14" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.IMAGES.head(`img/${id}.png`)).not.toBeNull();
  });
});
