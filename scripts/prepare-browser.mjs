import { cp, mkdir, readFile, writeFile, chmod, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "24.14.1";
const targets = {
  "x86_64-pc-windows-msvc": ["win-x64.zip", "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70"],
  "x86_64-apple-darwin": ["darwin-x64.tar.gz", "2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d"],
  "aarch64-apple-darwin": ["darwin-arm64.tar.gz", "25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe"],
  "x86_64-unknown-linux-gnu": ["linux-x64.tar.xz", "84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be"],
};
// 官方v24.14.1分发的固定摘要，构建不接受未核对的替代运行时。
const target = process.env.SUPER_OFFER_BUILD_TARGET || {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
}[`${process.platform}-${process.arch}`];
if (!targets[target]) throw Error("浏览器辅助运行时只支持已声明的四个目标架构。");
const [suffix, expected] = targets[target];
const filename = `node-v${version}-${suffix}`;
const url = `https://nodejs.org/dist/v${version}/${filename}`;
const cache = join(root, ".s0-work", "node-cache", filename);
let archive;
try { archive = await readFile(cache); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (!archive) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error(`Node下载失败：HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 150 * 1024 * 1024) throw Error("Node分发包大小不符合预期。");
}
if (createHash("sha256").update(archive).digest("hex") !== expected)
  throw Error(`Node缓存或下载包校验失败，请核对 ${cache}；未生成运行资源。`);
await mkdir(dirname(cache), { recursive: true });
await writeFile(cache, archive);
const prefix = `node-v${version}-${suffix.replace(/\.(zip|tar\.gz|tar\.xz)$/, "")}`;
const windows = target === "x86_64-pc-windows-msvc";
const work = join(root, ".s0-work");
const staging = join(work, `browser-runtime-build-${process.pid}`);
const destination = join(work, "browser-runtime");
const assertGenerated = p => {
  const rel = relative(resolve(work), resolve(p));
  if (!rel || rel.startsWith("..") || !rel.startsWith("browser-runtime")) throw Error("资源清理范围无效。");
};
assertGenerated(staging); assertGenerated(destination);
await mkdir(staging, { recursive: true });
try {
  for (const [member, name] of [[windows ? "node.exe" : "bin/node", windows ? "node.exe" : "node"], ["LICENSE", "NODE-LICENSE.txt"]]) {
    const bytes = execFileSync("tar", ["-xOf", cache, `${prefix}/${member}`], { windowsHide: true, maxBuffer: 160 * 1024 * 1024 });
    await writeFile(join(staging, name), bytes);
  }
  if (!windows) await chmod(join(staging, "node"), 0o755);
  const playwright = join(root, "node_modules", "playwright-core");
  const manifest = JSON.parse(await readFile(join(playwright, "package.json"), "utf8"));
  if (manifest.version !== "1.65.0") throw Error("Playwright版本与锁定方案不一致。");
  if (Object.keys(manifest.dependencies || {}).length) throw Error("Playwright新增运行依赖，须先核对随包清单。");
  await mkdir(join(staging, "node_modules"), { recursive: true });
  await cp(playwright, join(staging, "node_modules", "playwright-core"), { recursive: true });
  await cp(join(root, "browser"), join(staging, "browser"), { recursive: true });
  await stat(join(staging, "browser", "host.mjs"));
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  console.log(`已准备Node ${version} / Playwright 1.65.0：${target}（不含浏览器）。`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
