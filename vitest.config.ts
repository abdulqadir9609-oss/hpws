import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.json",
      },
      miniflare: {
        bindings: {
          DEVICE_REGISTRATION_SECRET: "hpws-vitest-only-secret-not-production",
        },
      },
    }),
  ],
});
