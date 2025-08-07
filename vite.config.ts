import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

/**
 * Vite configuration for the application.
 *
 * @remarks
 * This configuration is mostly standard Vite + Vue setup, with specific accommodations for:
 * - WASM decoders used by Cornerstone libraries
 * - DICOM parser which currently uses CommonJS format (planned migration to ESM)
 *
 * @description
 * Key configuration points:
 * - Uses vite-plugin-commonjs to handle the DICOM parser's CommonJS format
 * - Configures worker format as ES modules
 * - Excludes Cornerstone CODEC packages from dependency optimization to handle WASM properly
 * - Explicitly includes dicom-parser in optimization
 * - Ensures WASM files are properly handled as assets
 *
 * @example
 * To use additional WASM decoders, add them to the optimizeDeps.exclude array:
 * ```ts
 * optimizeDeps: {
 *   exclude: [
 *     "@cornerstonejs/dicom-image-loader",
 *     // ... existing codecs
 *   ]
 * }
 * ```
 */
export default defineConfig({
  plugins: [
    vue(),
    vueJsx(),
    // for dicom-parser
    viteCommonjs(),
    // for WASM support
    wasm(),
    topLevelAwait(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  assetsInclude: ["**/*.wasm"],
  // server: {
  //   fs: {
  //     strict: false,
  //   },
  // },
  // seems like only required in dev mode
  optimizeDeps: {
    exclude: [
      "@cornerstonejs/dicom-image-loader",
      "@cornerstonejs/polymorphic-segmentation",
      "@icr/polyseg-wasm",
    ],
    include: ["dicom-parser"],
  },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
  server: {
    host: true,
    port: 3000,
  },
});
