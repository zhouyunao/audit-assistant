# Audit Assistant

LLM 辅助的多语言代码安全审计 VSCode 扩展。面向"整个项目"的人工安全审计场景（非 commit/PR/CI 粒度），目标是省掉手画结构图和"猜"函数功能的时间，并让审计结论以文件形式在团队内共享。

## 功能现状

| 功能 | 状态 |
| --- | --- |
| 多语言静态索引（符号表 + 近似调用图） | ✅ M2 已完成 |
| 当前文件分析：功能总结、逐函数说明、漏洞初筛、注意点高亮 | ✅ M3 已完成 |
| 审计数据保存在 `.audit/`，团队共享 | ✅ 已完成（文件分析、结构图部分） |
| 项目结构树（目录树 + 模块职责 + 依赖关系） | ✅ M4 已完成 |
| source/sink 规则扫描、手动标记 | ⏳ M5 计划中（数据格式与展示视图已就绪） |
| 调用链确认（LLM agent 逐跳取证） | ⏳ M6 计划中（数据格式与展示视图已就绪） |
| 汇总报告导出 | ⏳ M7 计划中 |

支持语言：Java、JavaScript/JSX、TypeScript/TSX、Python、Go、PHP、C、C++、C#。加新语言只需在 `src/indexer/languages.ts` 加一条 spec 并在 `scripts/copy-wasm.js` 里加对应 grammar（`tree-sitter-wasms` 包里还有 Kotlin/Ruby/Rust/Swift 等现成的）。

## 快速开始

### 构建

```bash
npm install
npm run build      # 拷贝 wasm + 打包 dist/extension.js
```

开发调试：在 VSCode 里打开本工程按 F5 启动 Extension Development Host；打包分发：`npx @vscode/vsce package` 生成 .vsix，团队成员通过「Install from VSIX」安装。

### 配置 LLM

任何 OpenAI 兼容端点均可（vLLM / Ollama / OneAPI / 各云厂商），代码只会发送到你配置的端点：

1. 设置 `auditAssistant.llm.baseUrl`（如 `http://内网host:8000/v1`）和 `auditAssistant.llm.model`。
2. 端点需要鉴权时，运行命令 **`Audit: 设置 LLM API Key`**（保存在 VSCode SecretStorage，不进设置文件、不进仓库）。

### 使用

1. 打开被审计项目，运行 **`Audit: 索引整个项目`**（可选但推荐；结果缓存，二次打开免重扫）。
2. 运行 **`Audit: 生成项目结构树`**：生成带注释的目录树——每个模块目录标注文件数、LLM 推断的职责、依赖去向（基于 import 关系与跨文件调用聚合；未配置 LLM 也能出树，只是没有职责文字）。结果写入 `.audit/architecture.md` 并自动打开 Markdown 预览。之后用 **`Audit: 查看项目结构树`** 直接打开。
3. 打开任意代码文件，运行 **`Audit: 分析当前文件`**（命令面板 / 编辑器右键 / 侧边栏按钮）。
3. 左侧 Audit Assistant 面板查看：文件功能总结、逐函数一句话说明（点击跳转）、疑似漏洞（严重度/置信度/理由/建议）、需人工注意的代码段；编辑器内相应行有高亮和 hover 详情。
4. 结果自动写入项目根的 `.audit/` 目录。**把 `.audit/` 提交进 git（或直接拷给同事）即可共享**——同事打开同一文件时直接看到已有分析；代码改动后会显示"分析结果可能过期"。

## `.audit/` 目录格式

```
.audit/
├── audit.json          # 项目元信息
├── architecture.md     # 结构树 + 模块职责 + 模块依赖（人读/git 共享）
├── architecture.json   # 结构数据（程序复用）
├── files/<hash>.json   # 每文件分析：summary / functions / issues / attention（含 contentHash 与审计人）
├── marks.json          # source/sink 标记（M5 起写入；已有数据会在侧边栏展示）
├── findings/<id>.json  # 调用链结论（M6 起写入；已有数据会在侧边栏展示）
└── report.md           # 汇总报告（M7）
```

全部为人类可读的 JSON/Markdown，git 友好。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run test        # 索引层/工具函数单元测试（node:test，无需 VSCode）
npm run watch       # esbuild watch
```

代码结构见 `src/`：`indexer/`（tree-sitter 多语言解析、符号表、近似调用图、缓存）、`llm/`（OpenAI 兼容客户端）、`features/`（分析编排）、`store/`（.audit 读写）、`views/`（侧边栏与编辑器装饰）。
