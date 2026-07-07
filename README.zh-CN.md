# Audit Assistant

[English](README.md) | **简体中文**

LLM 辅助的多语言代码安全审计 VSCode 扩展。面向"整个项目"的人工安全审计场景（非 commit/PR/CI 粒度），目标是省掉手画结构图和"猜"函数功能的时间，并让审计结论以文件形式在团队内共享。

> 扩展界面为英文；命令、视图名称以英文显示。分析结果的输出语言可通过 `auditAssistant.analysis.outputLanguage` 选择 `en`（默认）/ `zh` / `ja`。

## 功能现状

| 功能 | 状态 |
| --- | --- |
| 多语言静态索引（符号表 + 近似调用图） | ✅ M2 已完成 |
| 当前文件分析：功能总结、逐函数说明、漏洞初筛、注意点高亮 | ✅ M3 已完成 |
| 审计数据保存在 `.audit/`，团队共享 | ✅ 已完成（文件分析、结构图部分） |
| 项目结构树（目录树 + 模块职责 + 依赖关系） | ✅ M4 已完成 |
| source/sink 规则扫描、手动标记 | ✅ M5 已完成 |
| 调用链确认（反向路径搜索 + LLM agent 逐跳取证） | ✅ M6 已完成 |
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

通过 `auditAssistant.llm.provider` 选择后端，代码只会发送到你配置的端点。鉴权凭据统一用命令 **`Audit: Set LLM API Key`** 保存在 VSCode SecretStorage（不进设置文件、不进仓库）。

**A) OpenAI 兼容端点（默认，`provider: openai`）**——vLLM / Ollama / OneAPI / 各云厂商：

1. `auditAssistant.llm.baseUrl`（如 `http://内网host:8000/v1`）+ `auditAssistant.llm.model`（模型名）。
2. 端点需要鉴权时用上面的命令填 API Key。

**B) opencode serve（`provider: opencode`）**——复用本机 opencode 的模型配置：

1. 先起服务：`opencode serve`（默认 `http://127.0.0.1:4096`；可加 `--port` / `--hostname`）。
2. `auditAssistant.llm.provider` 设为 `opencode`；`auditAssistant.llm.model` 填 `providerID/modelID`（如 `anthropic/claude-3-5-sonnet-20241022`）；`baseUrl` 保持默认会自动指向 `http://127.0.0.1:4096`。
3. 若服务端设了 `OPENCODE_SERVER_PASSWORD`，用上面的命令把密码填进去。

> opencode 是会话式 API（非 OpenAI 兼容），扩展内部通过「建会话 → 发消息 → 取回复」对接。opencode 自带 agent/工具循环，因此调用链确认走「每跳源码预取进 prompt」的取证模式（不依赖 OpenAI tool-calling），其余功能一致。

### 使用

1. 打开被审计项目，运行 **`Audit: Index Workspace`**（可选但推荐；结果缓存，二次打开免重扫）。
2. 运行 **`Audit: Generate Structure Tree`**：生成带注释的目录树——每个模块目录标注文件数、LLM 推断的职责、依赖去向（基于 import 关系与跨文件调用聚合；未配置 LLM 也能出树，只是没有职责文字）。结果写入 `.audit/architecture.md` 并自动打开 Markdown 预览。之后用 **`Audit: Show Structure Tree`** 直接打开。
3. 打开任意代码文件，运行 **`Audit: Analyze Current File`**（命令面板 / 编辑器右键 / 侧边栏按钮）。左侧 Audit Assistant 面板查看：文件功能总结、逐函数一句话说明（点击跳转）、疑似漏洞（严重度/置信度/理由/建议）、需人工注意的代码段；编辑器内相应行有高亮和 hover 详情。
4. **Source/Sink**：运行 **`Audit: Scan Source/Sink Candidates`**，内置多语言规则库（命令执行、SQL、eval、反序列化、XSS、HTTP 入参、环境变量等）扫出候选，列在「Source / Sink」视图（按 Sink/Source 分组，已确认→候选→已排除 排序）。对候选行的 CodeLens 点「Confirm/Exclude」，或在编辑器右键 **`Mark as Source/Sink`** 手动标记（人工标记不会被重扫清除）；已标记行在编辑器左侧有颜色标示。标记存入 `.audit/marks.json`。
5. **调用链确认**：在「Source / Sink」视图的 Sink 条目（或编辑器里 Sink 行的 CodeLens）上点 **`Verify Call Chain`**——先在近似调用图上从该 Sink 反向搜出候选链（命中 source 标记或调用入口即为完整链），多条候选时弹出选择；再由 LLM 沿链逐跳读源码取证（数据是否真的流到 sink、中途有无净化），需要时自动调用 `get_callers`/`read_function`/`search_text` 工具补充上下文。结论（可达/不可达/待定 + 逐跳证据）存入 `.audit/findings/`，在「Call Chains」视图可展开回放，点每一跳跳转代码。端点不支持 tool-calling 时自动降级（每跳源码已预取进 prompt，仍能给结论）。
6. 结果自动写入项目根的 `.audit/` 目录。**把 `.audit/` 提交进 git（或直接拷给同事）即可共享**——同事打开同一文件时直接看到已有分析与标记；代码改动后会显示"分析结果可能过期"。

## `.audit/` 目录格式

```
.audit/
├── audit.json          # 项目元信息
├── architecture.md     # 结构树 + 模块职责 + 模块依赖（人读/git 共享）
├── architecture.json   # 结构数据（程序复用）
├── files/<hash>.json   # 每文件分析：summary / functions / issues / attention（含 contentHash 与审计人）
├── marks.json          # source/sink 标记（含 kind/status/origin/category/cwe/作者）
├── findings/<id>.json  # 调用链结论（verdict + 逐跳证据 chain + 关联的 source/sink 标记）
└── report.md           # 汇总报告（M7）
```

全部为人类可读的 JSON/Markdown，git 友好。

## 开发

前置：Node.js ≥ 18（开发用 v22 验证过）、npm。首次克隆后先 `npm install`。

### npm 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run copy-wasm` | 把 tree-sitter 运行时和各语言 grammar 的 `.wasm` 从 `node_modules` 拷到 `grammars/`（`build`/`test` 会自动先跑它） |
| `npm run build` | `copy-wasm` + esbuild 打包 → `dist/extension.js`（扩展的运行入口） |
| `npm run watch` | esbuild 监听模式，改动源码自动重新打包（配合调试宿主） |
| `npm run typecheck` | `tsc --noEmit`，只做类型检查、不产出文件 |
| `npm run compile-test` | 按 `tsconfig.test.json` 把 `src/` 中不依赖 vscode 的模块编译到 `out/`（供 node 测试 require） |
| `npm run test` | `copy-wasm` + `compile-test` + 跑 `test/*.test.cjs`（node:test，无需 VSCode）+ 打包冒烟测试 |
| `npm run vscode:prepublish` | 打 vsix 前自动触发的生产模式打包（`build -- --production`，压缩、不出 sourcemap） |

### 编译 / 调试流程

```bash
# 1. 安装依赖
npm install

# 2. 打包扩展（生成 dist/extension.js，并把 wasm 拷到 grammars/）
npm run build

# 3. 在 VSCode 中按 F5 启动 Extension Development Host 调试
#    改代码时可另开一个终端跑 npm run watch，保存后在宿主窗口 Reload Window 生效

# 4. 提交前自检：类型 + 测试
npm run typecheck
npm run test
```

> 说明：`dist/`、`out/`、`grammars/` 均为生成物（已在 `.gitignore`），克隆后需先 `npm run build` 才能 F5 调试；`out/` 只在 `npm run test` 时按需生成。

### 打包分发

```bash
npx @vscode/vsce package    # 生成 audit-assistant-<version>.vsix
```

`vsce package` 会自动触发 `vscode:prepublish`（生产模式重新打包）。团队成员通过 VSCode「Extensions: Install from VSIX…」安装。

### 代码结构

`src/` 下：`indexer/`（tree-sitter 多语言解析、符号表、近似调用图、缓存）、`llm/`（`client` OpenAI 兼容客户端 + `LlmProvider` 接口、`opencodeClient` opencode serve 会话式后端、`provider` 后端工厂、`agentLoop` 通用 tool-calling 循环）、`features/`（`fileAnalysis` 文件分析、`architecture` 结构树、`taint/` source/sink 规则与扫描、`taint/pathSearch` 调用链反向搜索、`taint/chainVerify` LLM 逐跳取证）、`store/`（`.audit/` 读写）、`views/`（侧边栏 TreeView、CodeLens、编辑器装饰）、`extension.ts`（激活入口，注册命令/视图/事件）。
