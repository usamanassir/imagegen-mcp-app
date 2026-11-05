import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Tests run inside the real Workers runtime (workerd) with an in-memory R2 bucket.
// Every outbound fetch from the Worker is routed to test/mock-providers.js, so nothing
// leaves the machine and no API key is ever used.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_TOKEN: "test-token-0123456789abcdef",
          OPENAI_API_KEY: "sk-test",
          GEMINI_API_KEY: "gm-test",
          OPENAI_BASE_URL: "https://openai.test",
          GEMINI_BASE_URL: "https://gemini.test",
          RETENTION_DAYS: "0",
        },
        outboundService: "mock-providers",
        workers: [
          {
            name: "mock-providers",
            modules: true,
            scriptPath: "test/mock-providers.js",
            compatibilityDate: "2026-10-01",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.js"],
  },
});
