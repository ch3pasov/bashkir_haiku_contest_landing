import { cpSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "cloudflare/public");
const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url)));
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(path.join(root, "html"), output, { recursive: true,
  filter: source => path.basename(source) !== ".DS_Store" });
if (config.name === "anatoliy-portfolio") {
  copyFileSync(path.join(output, "img/favicon_64.png"), path.join(output, "favicon.ico"));
  for (const alias of ["apple-touch-icon.png", "apple-touch-icon-precomposed.png"])
    copyFileSync(path.join(output, "img/favicon_180.png"), path.join(output, alias));
  writeFileSync(path.join(output, "_headers"), "/files/*.glb\n  Content-Type: model/gltf-binary\n/files/*.usdz\n  Content-Type: model/vnd.usdz+zip\n/favicon.ico\n  Content-Type: image/png\n");
}
readFileSync(path.join(output, "index.html"));
console.log("Built original html/ assets for " + config.name);
