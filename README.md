# Super-Offer

面向国内求职者的本地优先开源桌面客户端。

当前已实现 S1 本地业务基础：多份档案、文字 PDF / DOCX 简历预填与人工确认、版本与复制、自定义问答、七阶段申请和多轮面试、独立聊天 / ASR 配置、任务停止与用量、备份整体恢复。

浏览器填写、项目源码分析、面试练习、语音复盘、题库和自动更新属于后续阶段，尚未实现。当前提供源码及本机开发构建，尚未发布安装包；Windows 本机运行验证不代表其它架构已经通过。

## 本地开发

本次验证使用 Node.js 24.14.1、npm 11.11.0、Rust 1.99.1、Windows x64、MSVC 与 WebView2。其它平台需要 Tauri 2 对应的系统依赖。终端用户运行已构建程序不需要 Node 或 Python。

```sh
npm ci
cargo fetch --manifest-path src-tauri/Cargo.toml
npm run desktop
```

`npm run assets` 从源码图标和已安装依赖准备图标、中文 PDF CMap 与完整许可，输出到 `.s0-work`。首次执行会从固定上游地址下载三份缺失的许可全文，校验 SHA-256 后缓存；缓存和生成资源不进入源码仓库。构建阶段会自动调用；离线构建前先联网安装依赖、执行 `cargo fetch` 和 `npm run assets`。许可清单默认使用当前 Rust 主机目标，也可通过 `SUPER_OFFER_BUILD_TARGET` 指定发行目标。

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run desktop:build -- --debug
```

`tests/native-s1.mjs` 是 Windows 原生回归，自动启动自有 WebView、使用独立合成数据目录及本机服务替身。用 `SUPER_OFFER_TEST_EXE` 指定刚构建的程序路径后执行 `node tests/native-s1.mjs`。它不连接用户的 Chrome / Edge，也不调用付费模型。

## 数据与服务

数据保存在系统应用数据目录 `io.superoffer.desktop` 下，可在“数据备份”查看。开发时可用 `SUPER_OFFER_DATA_DIR` 指向独立目录。SQLite 与应用材料副本由宿主管理，同一工作区禁止两个进程同时打开；用户原件不修改。

文字简历上限 10 MB，PDF 上限 100 页，提取文字上限 1 MB；扫描件不提供 OCR。字段建议须人工确认，未知内容保持缺项。ASR 设置页提供 MP3 / WAV / M4A 接口测试，单文件上限 50 MB，尚不代表后续音频识别质量或完整复盘验收。

聊天填写完整 Chat Completions 地址，ASR 填写完整 multipart 转写地址；Key 仅通过系统凭证库保存。运行中的任务固定输入与配置版本，取消保留已收内容；用量未知显示“未知”，不设置客户端调用次数配额。

备份仅包含已保存内容，不含 Key 或浏览器登录态；可选择是否包含音频。备份格式 v1，压缩包最大 256 MB、展开后最大 512 MB。恢复先预检、展示范围并确认，再备份当前数据并整体替换，不合并。恢复后需要重新配置 Key，原数据集及恢复前备份继续保留。

## 许可证

原创代码采用 [MIT 许可证](LICENSE)。第三方组件及源码获取方式见 [第三方声明](THIRD_PARTY_NOTICES.md)；许可全文随应用资源提供，可在“数据备份 → 第三方许可”离线查看。
