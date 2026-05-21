// Copies the kuromoji dictionary (~12 MB of .dat.gz files) from the npm package
// into public/dict so the deployed app serves it from its own domain — no runtime
// CDN dependency, no CORS, and no file:// blocking. Runs automatically on
// postinstall / predev / prebuild. Idempotent and safe to re-run.
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const src = join(root, "node_modules", "kuromoji", "dict");
const dest = join(root, "public", "dict");

if (!existsSync(src)) {
  console.warn(
    "[copy-dict] kuromoji dictionary not found yet (node_modules/kuromoji/dict). " +
      "Run `npm install` first — this is expected on the very first install pass."
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

let copied = 0;
for (const file of readdirSync(src)) {
  const from = join(src, file);
  const to = join(dest, file);
  if (!statSync(from).isFile()) continue;
  // Skip if already present and same size (cheap idempotency check).
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}

console.log(
  copied > 0
    ? `[copy-dict] Copied ${copied} dictionary file(s) to public/dict`
    : "[copy-dict] Dictionary already in place."
);
