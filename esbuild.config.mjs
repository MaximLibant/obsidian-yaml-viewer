import esbuild from "esbuild";
import process from "node:process";

const production = process.env.NODE_ENV === "production" || process.argv.includes("production");

await esbuild.build({
  banner: {
    js: "/* YAML Viewer for Obsidian - generated bundle */",
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  // Obsidian provides these at runtime. Bundling a second copy breaks the editor.
  external: ["obsidian", "@codemirror/commands", "@codemirror/language", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "main.js",
  platform: "browser",
  sourcemap: production ? false : "inline",
  target: "es2022",
});
