import { readFile, writeFile, mkdir } from "node:fs/promises";
import { minify } from "terser";

const pixelId = process.env.PIXEL_ID;
const debug = process.env.DEBUG === "true";

if (!pixelId) {
  console.error("Usage: PIXEL_ID=<your pixel id> [DEBUG=true] npm run build");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]+$/.test(pixelId)) {
  console.error("PIXEL_ID contains unexpected characters.");
  process.exit(1);
}

const source = await readFile("src/openai-ads-pixel.js", "utf8");
const configured = source
  .replace('const PIXEL_ID = "YOUR_PIXEL_ID";', `const PIXEL_ID = "${pixelId}";`)
  .replace("const DEBUG = false;", `const DEBUG = ${debug};`);

if (!configured.includes(`"${pixelId}"`)) {
  console.error("Could not set PIXEL_ID in source.");
  process.exit(1);
}

const { code } = await minify(configured, {
  ecma: 2020,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
});

await mkdir("dist", { recursive: true });
await writeFile("dist/openai-ads-pixel.min.js", code);
console.log(`dist/openai-ads-pixel.min.js (${code.length} bytes, debug=${debug})`);
