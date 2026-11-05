// Fake OpenAI, Gemini and a public image host. All outbound fetches from the Worker under test are
// routed here (see vitest.config.js: miniflare.outboundService), so tests never reach the internet.
//
// Prompts containing "fail-me" make the provider return an error; "blocked" makes Gemini return no
// image. GET https://mock.test/__calls returns and resets the request counters.

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeBgMBmgS2IwAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

const counts = { openai: 0, gemini: 0, remote: 0 };
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.hostname === "mock.test" && url.pathname === "/__calls") {
      const out = { ...counts };
      counts.openai = counts.gemini = counts.remote = 0;
      return json(200, out);
    }

    if (url.hostname === "openai.test") {
      counts.openai++;
      if (request.headers.get("authorization") !== "Bearer sk-test") return json(401, { error: { message: "bad key" } });
      const body = new TextDecoder("latin1").decode(await request.arrayBuffer());
      if (body.includes("fail-me")) return json(400, { error: { message: "simulated openai failure" } });
      let n = 1;
      if (url.pathname === "/v1/images/generations") n = Number(JSON.parse(body).n || 1);
      else n = Number(/name="n"\r\n\r\n(\d+)/.exec(body)?.[1] || 1);
      return json(200, { data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })), output_format: "png" });
    }

    if (url.hostname === "gemini.test") {
      counts.gemini++;
      if (request.headers.get("x-goog-api-key") !== "gm-test") return json(403, { error: { message: "bad key" } });
      const body = new TextDecoder("latin1").decode(await request.arrayBuffer());
      if (body.includes("fail-me")) return json(500, { error: { message: "simulated gemini failure" } });
      if (body.includes("blocked")) {
        return json(200, { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "Nope." }] } }] });
      }
      return json(200, {
        candidates: [
          { content: { parts: [{ text: "Here is your image." }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }] } },
        ],
      });
    }

    if (url.hostname === "images.test") {
      counts.remote++;
      switch (url.pathname) {
        case "/small.png":
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        case "/missing.png":
          return new Response("nope", { status: 404 });
        case "/text.txt":
          return new Response("not an image", { headers: { "content-type": "text/plain" } });
        case "/huge.png": {
          // Claims to be small, streams 25 MB: the Worker must stop reading at its 20 MB limit.
          const { readable, writable } = new TransformStream();
          (async () => {
            const w = writable.getWriter();
            await w.write(PNG);
            const chunk = new Uint8Array(1024 * 1024);
            for (let i = 0; i < 25; i++) await w.write(chunk).catch(() => {});
            await w.close().catch(() => {});
          })();
          return new Response(readable, { headers: { "content-type": "image/png", "content-length": "100" } });
        }
        case "/huge-honest.png": {
          const big = new Uint8Array(21 * 1024 * 1024);
          big.set(PNG);
          return new Response(big, { headers: { "content-type": "image/png" } });
        }
      }
    }
    return json(404, { error: { message: `mock: no route for ${request.url}` } });
  },
};
