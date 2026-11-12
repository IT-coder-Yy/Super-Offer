# 第三方组件与许可

Super-Offer 的原创代码采用 MIT。以下组件及其传递依赖保持各自许可；未将参考项目的业务源码合并进本项目。

| 使用位置 | 组件及锁定版本 | 许可 |
| --- | --- | --- |
| 桌面与 IPC | Tauri 2.12.5、API/CLI 2.12.4、dialog 2.8.4 | MIT OR Apache-2.0 |
| 界面 | React/React DOM 19.3.1 | MIT |
| PDF 提取 | PDF.js 6.5.438 | Apache-2.0；CMap 另遵循 Adobe BSD 声明 |
| DOCX 提取 | Mammoth 1.13.0 | BSD-2-Clause；传递依赖另列 |
| SQLite | rusqlite 0.42.0 | MIT；SQLite 公有领域声明随依赖保留 |
| 系统凭证 | keyring 4.2.0 | MIT OR Apache-2.0 |
| HTTP / 流式 | reqwest 0.13.5、eventsource-stream 0.2.3 | MIT OR Apache-2.0 |
| 压缩 / 临时目录 | zip 9.5.1、tempfile 3.27.0 | MIT；MIT OR Apache-2.0 |
| 开发与测试 | Vite 8.3.8、TypeScript 7.0.2、Playwright Core 1.65.0 | MIT；Apache-2.0；Apache-2.0 |

`npm run licenses` 从已安装依赖和 Cargo 锁文件收集许可全文。缺少独立全文的三个补充来源在首次构建时下载，按脚本中固定的 SHA-256 校验后缓存到 `.s0-work/license-cache`；后续使用缓存仍校验哈希，不依赖仓库内的三份许可证副本。构建将 `third-party-notices.txt` 与 `cmaps/LICENSE` 嵌入应用资源；“数据备份 → 第三方许可”可离线查看。该清单也包含编译期依赖，不表示其中每个包都进入最终运行代码。发布前仍需针对各架构实际构建复核。

补充来源：

- alloc-stdlib 的 BSD-3-Clause 原文来自 [Dropbox 锁定源码](https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE)，版权为 Dropbox, Inc.。
- webview2-com、macros、sys 的 MIT 原文来自 [webview2-rs 锁定源码](https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE)，版权为 Bill Avery。
- selectors 0.38.0 为 Servo Project Developers 的 MPL-2.0 组件。未修改其源码；可从 [准确版本源码](https://github.com/servo/stylo/tree/572ecba2d1600e7c3d490586692a209faf703baa/selectors) 或 [该版本 crate](https://crates.io/crates/selectors/0.38.0) 获取源代码。许可全文采用 [Mozilla 官方 MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/)，保留此源码获取说明及原始文件版权头。
- isarray 1.0.0 的 MIT 全文位于其发布包 README 的 License 段，保留 Julian Gruber 版权。
- eventsource-stream 0.2.3 和 tauri-plugin 2.7.2 发布包未附独立许可证文件，Cargo 明示 `MIT OR Apache-2.0`；本分发选择 Apache-2.0 并附完整许可，不将它们声明为原创 MIT。eventsource-stream 的准确源码为 [3d46f1c](https://github.com/jpopesculian/eventsource-stream/tree/3d46f1c758f9ee4681e9da0427556d24c53f9c01)。

所有研究中的 AGPL、CC BY-NC-SA、无明确许可证的候选代码或知识内容均未复制进应用。题库和知识内容仍须在后续阶段逐条审核来源。
