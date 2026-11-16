import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
const root = resolve(".");
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
const records = [];
const supplements = {
  "alloc-stdlib": {
    url: "https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE",
    sha256: "c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae",
  },
  selectors: {
    url: "https://www.mozilla.org/media/MPL/2.0/index.txt",
    sha256: "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04",
  },
  "webview2-com": {
    url: "https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE",
    sha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
  },
};
async function supplement(name) {
  const { url, sha256 } = supplements[name];
  const file = join(root, ".s0-work", "license-cache", `${name}.LICENSE.txt`);
  let content;
  try {
    content = await readFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const downloaded = !content;
  if (downloaded) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok)
      throw Error(`获取 ${name} 许可失败：HTTP ${response.status}`);
    content = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(content).digest("hex") !== sha256)
    throw Error(`${name} 许可 SHA-256 不匹配，请核对来源及 ${file}`);
  if (downloaded) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return content.toString("utf8");
}
async function record(name, version, license, folder, source) {
  const names = await readdir(folder);
  const files = names.filter((name) =>
    /^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i.test(name),
  );
  const texts = [];
  for (const file of files) {
    try {
      texts.push(
        `--- ${file} ---\n${await readFile(join(folder, file), "utf8")}`,
      );
    } catch (error) {
      if (error.code !== "EISDIR") throw error;
    }
  }
  if (!texts.length) {
    const supplementNames = {
      "alloc-stdlib": "alloc-stdlib",
      selectors: "selectors",
      "webview2-com": "webview2-com",
      "webview2-com-sys": "webview2-com",
      "webview2-com-macros": "webview2-com",
    };
    if (supplementNames[name]) {
      texts.push(await supplement(supplementNames[name]));
      files.push(supplements[supplementNames[name]].url);
    } else if (name === "isarray") {
      texts.push(
        (await readFile(join(folder, "README.md"), "utf8")).split(
          "## License",
        )[1],
      );
      files.push("README.md#License");
    }
  }
  records.push({
    name,
    version,
    license,
    source,
    files,
    text: texts.join("\n\n"),
  });
}
for (const [folder, info] of Object.entries(lock.packages)) {
  if (!folder || info.dev || info.optional) continue;
  const manifest = JSON.parse(
    await readFile(join(root, folder, "package.json"), "utf8"),
  );
  await record(
    manifest.name,
    manifest.version,
    manifest.license || info.license || "未声明",
    join(root, folder),
    manifest.repository?.url || manifest.repository || info.resolved || "",
  );
}
const cargo = process.env.CARGO || "cargo";
const target =
  process.env.SUPER_OFFER_BUILD_TARGET ||
  execFileSync(process.env.RUSTC || "rustc", ["-vV"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "))
    ?.slice(6);
if (!target) throw Error("无法确定目标架构，请设置 SUPER_OFFER_BUILD_TARGET");
const metadata = JSON.parse(
  execFileSync(
    cargo,
    [
      "metadata",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--offline",
      "--format-version",
      "1",
      "--filter-platform",
      target,
    ],
    { encoding: "utf8", maxBuffer: 24 * 1024 * 1024, windowsHide: true },
  ),
);
const resolved = new Set(metadata.resolve.nodes.map((node) => node.id));
for (const item of metadata.packages.filter(
  (p) => p.source && resolved.has(p.id),
))
  await record(
    item.name,
    item.version,
    item.license || "参见许可文件",
    dirname(item.manifest_path),
    item.repository || item.source,
  );
records.sort((a, b) => a.name.localeCompare(b.name));
const apache = await readFile("node_modules/pdfjs-dist/LICENSE", "utf8");
const unresolved = records.filter(
  (item) => !item.text && !item.license.includes("Apache-2.0"),
);
if (unresolved.length)
  throw Error(`许可缺失：${unresolved.map((item) => item.name).join(", ")}`);
const text =
  (await readFile("THIRD_PARTY_NOTICES.md", "utf8")) +
  "\n\n# 完整依赖许可\n\n包括当前目标的 Rust 依赖（含编译期依赖）及前端生产依赖。PDF CMap 的 Adobe 许可另随 cmaps/LICENSE 分发。\n\n" +
  records
    .map(
      (item) =>
        `## ${item.name} ${item.version}\n声明许可：${item.license}\n来源：${item.source}\n\n${item.text || `发布包未提供独立许可文件；Cargo 声明允许 Apache-2.0，本分发依此选项附许可全文。\n${apache}`}\n`,
    )
    .join("\n");
await mkdir(".s0-work/web-assets", { recursive: true });
await writeFile(".s0-work/web-assets/third-party-notices.txt", text);
await mkdir(".s0-work/s1-research", { recursive: true });
await writeFile(
  ".s0-work/s1-research/installed-licenses.json",
  JSON.stringify(
    records.map(({ text, ...item }) => item),
    null,
    2,
  ),
);
console.log(
  `已保留 ${records.length} 个依赖的许可与声明；缺独立许可文件：${
    records
      .filter((r) => !r.files.length)
      .map((r) => `${r.name} (${r.license})`)
      .join(", ") || "无"
  }`,
);
