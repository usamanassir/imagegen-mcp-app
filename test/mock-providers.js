// Fake OpenAI, Gemini and a public image host. All outbound fetches from the Worker under test are
// routed here (see vitest.config.js: miniflare.outboundService), so tests never reach the internet.
//
// Prompts containing "fail-me" make the provider return an error; "blocked" makes Gemini return no
// image. For speech, "no-audio" returns no audio block and "not-wav" returns bytes that aren't WAV.
// GET https://mock.test/__calls returns and resets the request counters; GET https://mock.test/__speech
// returns the last speech request.

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeBgMBmgS2IwAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

// One second of silence as a 24 kHz, mono, 16-bit WAV: 44-byte header plus 48,000 bytes of samples.
function makeWav() {
  const wav = new Uint8Array(44 + 48000);
  const dv = new DataView(wav.buffer);
  const tag = (at, s) => [...s].forEach((c, i) => (wav[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  dv.setUint32(4, 36 + 48000, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true);
  dv.setUint32(28, 48000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(36, "data");
  dv.setUint32(40, 48000, true);
  return wav;
}
const WAV_B64 = btoa(Array.from(makeWav(), (b) => String.fromCharCode(b)).join(""));
let lastSpeech = null;

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
    if (url.hostname === "mock.test" && url.pathname === "/__speech") return json(200, lastSpeech);

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
      if (url.pathname === "/v1beta/interactions") {
        lastSpeech = JSON.parse(body);
        const output = (content) => json(200, { steps: [{ type: "user_input" }, { type: "model_output", content }] });
        if (body.includes("no-audio")) return output([{ type: "text", text: "Nope." }]);
        if (body.includes("not-wav")) return output([{ type: "audio", data: PNG_B64 }]);
        return output([{ type: "audio", data: WAV_B64 }]);
      }
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
