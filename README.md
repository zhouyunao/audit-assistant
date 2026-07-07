# Audit Assistant

**English** | [简体中文](README.zh-CN.md)

An LLM-assisted, multi-language code-security auditing VSCode extension. Built for whole-project manual security audits (not commit/PR/CI granularity). It aims to save the time spent hand-drawing structure diagrams and "guessing" what functions do, and to let audit conclusions be shared across the team as files.

## Feature status

| Feature | Status |
| --- | --- |
| Multi-language static index (symbol table + approximate call graph) | ✅ M2 |
| Current-file analysis: summary, per-function description, vulnerability triage, attention highlighting | ✅ M3 |
| Audit data stored in `.audit/`, team-shared | ✅ (file analysis, structure tree) |
| Project structure tree (directory tree + module responsibilities + dependencies) | ✅ M4 |
| Source/sink rule scanning, manual marking | ✅ M5 |
| Call-chain verification (reverse path search + per-hop LLM evidence) | ✅ M6 |
| Summary report export | ⏳ M7 planned |

Supported languages: Java, JavaScript/JSX, TypeScript/TSX, Python, Go, PHP, C, C++, C#. To add a language, add one spec in `src/indexer/languages.ts` and the matching grammar in `scripts/copy-wasm.js` (the `tree-sitter-wasms` package also ships Kotlin/Ruby/Rust/Swift, etc.).

## Quick start

### Build

```bash
npm install
npm run build      # copy wasm + bundle dist/extension.js
```

Debugging: open this project in VSCode and press F5 to launch the Extension Development Host. Packaging: `npx @vscode/vsce package` produces a .vsix that teammates install via "Install from VSIX".

### Configure the LLM

Choose the backend with `auditAssistant.llm.provider`; code is only sent to the endpoint you configure. Auth credentials are stored in VSCode SecretStorage via the **`Audit: Set LLM API Key`** command (never written to settings or the repo).

**A) OpenAI-compatible endpoint (default, `provider: openai`)** — vLLM / Ollama / OneAPI / cloud providers:

1. `auditAssistant.llm.baseUrl` (e.g. `http://host:8000/v1`) + `auditAssistant.llm.model` (model name).
2. If the endpoint requires auth, set the API key with the command above.

**B) opencode serve (`provider: opencode`)** — reuse your local opencode model config:

1. Start the server: `opencode serve` (default `http://127.0.0.1:4096`; supports `--port` / `--hostname`).
2. Set `auditAssistant.llm.provider` to `opencode`; set `auditAssistant.llm.model` to `providerID/modelID` (e.g. `anthropic/claude-3-5-sonnet-20241022`); leaving `baseUrl` at its default auto-points to `http://127.0.0.1:4096`.
3. If the server sets `OPENCODE_SERVER_PASSWORD`, store that password with the command above.

> opencode is a session-based API (not OpenAI-compatible); the extension talks to it via "create session → send message → read reply". opencode runs its own agent/tool loop, so call-chain verification uses the "pre-fetch each hop's source into the prompt" evidence mode (it does not rely on OpenAI tool-calling); all other features are identical.

Analysis output language is controlled by `auditAssistant.analysis.outputLanguage`: `en` (default), `zh`, or `ja`. The extension UI is English.

### Usage

1. Open the project to audit and run **`Audit: Index Workspace`** (optional but recommended; results are cached, so reopening skips re-scanning).
2. Run **`Audit: Generate Structure Tree`**: produces an annotated directory tree — each module directory shows its file count, an LLM-inferred responsibility, and dependency targets (aggregated from imports and cross-file calls; the tree is produced even without an LLM, just without responsibility text). The result is written to `.audit/architecture.md` and opened in the Markdown preview. Reopen it later with **`Audit: Show Structure Tree`**.
3. Open any code file and run **`Audit: Analyze Current File`** (command palette / editor right-click / sidebar button). The Audit Assistant panel on the left shows: file summary, a one-line description per function (click to jump), suspected vulnerabilities (severity/confidence/reason/advice), and code spans that need attention; the corresponding lines are highlighted in the editor with hover details.
4. **Source/Sink**: run **`Audit: Scan Source/Sink Candidates`**. A built-in multi-language rule library (command execution, SQL, eval, deserialization, XSS, HTTP input, environment variables, etc.) finds candidates, listed in the "Source / Sink" view (grouped by Sink/Source, sorted Confirmed → Candidate → Excluded). Click "Confirm/Exclude" on a candidate's CodeLens, or right-click in the editor and choose **`Mark as Source/Sink`** to mark manually (manual marks are never removed by re-scan); marked lines get a colored indicator in the editor's left border. Marks are stored in `.audit/marks.json`.
5. **Call-chain verification**: click **`Verify Call Chain`** on a Sink item in the "Source / Sink" view (or on the CodeLens above a Sink line). It first reverse-searches candidate chains from that Sink on the approximate call graph (a chain is complete when it reaches a source mark or a call entry); if there are several, you pick one. Then the LLM reads the source hop by hop to gather evidence (does data really reach the sink, is there sanitization along the way), calling the `get_callers` / `read_function` / `search_text` tools as needed. The verdict (reachable / unreachable / undetermined + per-hop evidence) is stored in `.audit/findings/` and can be replayed in the "Call Chains" view, clicking each hop to jump to code. When the endpoint doesn't support tool-calling it degrades gracefully (each hop's source is already pre-fetched into the prompt).
6. Results are written to the project's `.audit/` directory. **Commit `.audit/` to git (or copy it to a teammate) to share** — teammates opening the same file see the existing analysis and marks; after code changes it shows "analysis may be stale".

## `.audit/` directory format

```
.audit/
├── audit.json          # project metadata
├── architecture.md     # structure tree + module responsibilities + dependencies (human-readable / git-shared)
├── architecture.json   # structure data (for programmatic reuse)
├── files/<hash>.json   # per-file analysis: summary / functions / issues / attention (with contentHash and auditor)
├── marks.json          # source/sink marks (kind/status/origin/category/cwe/author)
├── findings/<id>.json  # call-chain findings (verdict + per-hop evidence chain + linked source/sink marks)
└── report.md           # summary report (M7)
```

Everything is human-readable JSON/Markdown and git-friendly.

## Development

Prerequisites: Node.js ≥ 18 (developed/verified on v22), npm. Run `npm install` after cloning.

### npm scripts

| Command | Purpose |
| --- | --- |
| `npm run copy-wasm` | Copy the tree-sitter runtime and per-language grammar `.wasm` files from `node_modules` into `grammars/` (`build`/`test` run it automatically first) |
| `npm run build` | `copy-wasm` + esbuild bundle → `dist/extension.js` (the extension's runtime entry) |
| `npm run watch` | esbuild watch mode; re-bundles on source changes (pair with the dev host) |
| `npm run typecheck` | `tsc --noEmit`, type-check only, no output |
| `npm run compile-test` | Compile the non-vscode modules in `src/` to `out/` per `tsconfig.test.json` (for node tests to require) |
| `npm run test` | `copy-wasm` + `compile-test` + run `test/*.test.cjs` (node:test, no VSCode needed) + the bundle smoke test |
| `npm run vscode:prepublish` | Production bundle triggered automatically before packaging a vsix (`build -- --production`, minified, no sourcemap) |

### Build / debug workflow

```bash
# 1. Install dependencies
npm install

# 2. Bundle the extension (produces dist/extension.js and copies wasm into grammars/)
npm run build

# 3. Press F5 in VSCode to launch the Extension Development Host
#    While editing, run `npm run watch` in another terminal, then Reload Window in the host to pick up changes

# 4. Pre-commit checks: types + tests
npm run typecheck
npm run test
```

> Note: `dist/`, `out/`, and `grammars/` are generated (already in `.gitignore`); after cloning you must run `npm run build` before F5 debugging. `out/` is generated on demand only during `npm run test`.

### Packaging

```bash
npx @vscode/vsce package    # produces audit-assistant-<version>.vsix
```

`vsce package` automatically triggers `vscode:prepublish` (a production re-bundle). Teammates install via VSCode "Extensions: Install from VSIX…".

### Code structure

Under `src/`: `indexer/` (tree-sitter multi-language parsing, symbol table, approximate call graph, cache); `llm/` (`client` OpenAI-compatible client + the `LlmProvider` interface, `opencodeClient` opencode serve session backend, `provider` backend factory, `agentLoop` generic tool-calling loop); `features/` (`fileAnalysis` file analysis, `architecture` structure tree, `taint/` source/sink rules and scanning, `taint/pathSearch` call-chain reverse search, `taint/chainVerify` per-hop LLM evidence); `store/` (`.audit/` I/O); `views/` (sidebar TreeViews, CodeLens, editor decorations); `extension.ts` (activation entry, registers commands/views/events).
