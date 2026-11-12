import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}/.s0-work/web-assets/cmaps`, { recursive: true });
await cp(
  `${root}/node_modules/pdfjs-dist/cmaps`,
  `${root}/.s0-work/web-assets/cmaps`,
  { recursive: true },
);
