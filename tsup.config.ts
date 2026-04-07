import { defineConfig } from "tsup";
import { cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  minify: true,
  sourcemap: "hidden",
  banner: {
    js: "#!/usr/bin/env node",
  },
  async onSuccess() {
    // Copy default config into dist/ so it ships with the npm package
    cpSync(
      resolve(__dirname, "src/defaults/config.yaml"),
      resolve(__dirname, "dist/config.defaults.yaml"),
    );
  },
});
