import { bindings, defineConfig, defineWorker, exports } from "cf/config";

export default defineConfig(({ mode }) => {
  const preview = mode === "preview";
  return {
    worker: defineWorker({
      name: preview ? "heimdall-preview" : "heimdall",
      entrypoint: "./cloudflare/entry.ts",
      compatibilityDate: "2026-09-29",
      compatibilityFlags: ["nodejs_compat"],
      observability: { enabled: true, headSamplingRate: preview ? 1 : 0.1, redactQueryString: true },
      assets: { notFoundHandling: "none" },
      exports: { HeimdallDO: exports.durableObject({ storage: "sqlite" }) },
      env: {
        ASSETS: bindings.assets(),
        HEIMDALL: bindings.durableObject({ worker: preview ? "heimdall-preview" : "heimdall", exportName: "HeimdallDO" }),
        COINAPI_KEY: bindings.secret(),
        TRUST_CLOUDFLARE_HEADERS: bindings.text("true"),
        NEXT_PUBLIC_APP_URL: bindings.text(preview
          ? "https://heimdall-preview.reidjoss.workers.dev"
          : "https://bond.thorchain.no"),
        VERSION: bindings.text(process.env.HEIMDALL_RELEASE_VERSION ?? "local"),
      },
    }),
  };
});
