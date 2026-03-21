import { defineConfig } from "tsup";

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
});
