import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { getLlmConfig, getSettings, setApiKeyCommand } from './config';
import { LlmClient } from './llm/client';
import { ParserPool } from './indexer/parser';
import { ProjectIndex, contentHash, isSupportedFile } from './indexer/indexer';
import { IndexCache } from './indexer/cache';
import { LANGUAGES } from './indexer/languages';
import { AuditStore } from './store/auditStore';
import { analyzeFileContent } from './features/fileAnalysis';
import { generateArchitecture } from './features/architecture';
import { FileAnalysisTreeProvider } from './views/fileAnalysisTree';
import { AnalysisDecorations } from './views/decorations';
import { FindingsTreeProvider, SourceSinkTreeProvider } from './views/placeholderTrees';

let indexCache: IndexCache | undefined;
let projectIndex: ProjectIndex | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Audit Assistant');
  context.subscriptions.push(output);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    // 没有打开工作区时只注册 setApiKey，避免其余功能空指针
    context.subscriptions.push(
      vscode.commands.registerCommand('auditAssistant.setApiKey', () => setApiKeyCommand(context)),
    );
    return;
  }

  const pool = new ParserPool(context.asAbsolutePath('grammars'));
  const index = new ProjectIndex(pool);
  projectIndex = index;
  const store = new AuditStore(workspaceRoot);

  // 索引缓存：globalStorage/<workspace-hash>.json，二次打开免重扫
  const wsKey = crypto.createHash('sha1').update(workspaceRoot).digest('hex');
  indexCache = new IndexCache(path.join(context.globalStorageUri.fsPath, `index-${wsKey}.json`));
  index.restore(indexCache.load());

  const analysisTree = new FileAnalysisTreeProvider();
  const sourceSinkTree = new SourceSinkTreeProvider(store);
  const findingsTree = new FindingsTreeProvider(store);
  const decorations = new AnalysisDecorations();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('auditFileAnalysis', analysisTree),
    vscode.window.registerTreeDataProvider('auditSourceSink', sourceSinkTree),
    vscode.window.registerTreeDataProvider('auditFindings', findingsTree),
    decorations,
  );

  const relPathOf = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');

  /** 展示某编辑器对应文件的已有分析（含过期判断） */
  const showAnalysisFor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      analysisTree.update(undefined, 'none');
      return;
    }
    const relPath = relPathOf(editor.document.uri);
    const analysis = store.loadFileAnalysis(relPath);
    if (!analysis) {
      analysisTree.update(undefined, 'none', editor.document.uri);
      decorations.clear(editor);
      return;
    }
    const stale = analysis.contentHash !== contentHash(editor.document.getText());
    analysisTree.update(analysis, stale ? 'stale' : 'fresh', editor.document.uri);
    decorations.apply(editor, analysis);
  };

  // ---------- 命令 ----------

  context.subscriptions.push(
    vscode.commands.registerCommand('auditAssistant.setApiKey', () => setApiKeyCommand(context)),

    vscode.commands.registerCommand('auditAssistant.refreshAnalysisView', () => {
      showAnalysisFor(vscode.window.activeTextEditor);
      sourceSinkTree.refresh();
      findingsTree.refresh();
    }),

    vscode.commands.registerCommand('auditAssistant.revealLine', async (uri: vscode.Uri, line: number) => {
      const editor = await vscode.window.showTextDocument(uri);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),

    vscode.commands.registerCommand('auditAssistant.revealLocation', (relFile: string, line: number) => {
      const uri = vscode.Uri.file(path.join(workspaceRoot, relFile));
      return vscode.commands.executeCommand('auditAssistant.revealLine', uri, line);
    }),

    vscode.commands.registerCommand('auditAssistant.analyzeCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Audit Assistant: 请先打开要分析的代码文件');
        return;
      }
      const llmCfg = await getLlmConfig(context);
      if (!llmCfg.model) {
        const pick = await vscode.window.showWarningMessage(
          'Audit Assistant: 尚未配置 LLM 端点/模型',
          '打开设置',
        );
        if (pick === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'auditAssistant.llm');
        }
        return;
      }
      const settings = getSettings();
      const client = new LlmClient(llmCfg);
      const relPath = relPathOf(editor.document.uri);
      const content = editor.document.getText();

      analysisTree.update(undefined, 'analyzing', editor.document.uri);
      try {
        const analysis = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Audit: 分析 ${path.basename(relPath)}`,
            cancellable: false,
          },
          (progress) =>
            analyzeFileContent(relPath, content, client, index, store, {
              author: settings.author,
              outputLanguage: settings.outputLanguage,
              onProgress: (message) => progress.report({ message }),
            }),
        );
        analysisTree.update(analysis, 'fresh', editor.document.uri);
        decorations.apply(editor, analysis);
        output.appendLine(`[analyze] ${relPath}: ${analysis.issues.length} issues, ${analysis.functions.length} functions`);
      } catch (e) {
        analysisTree.update(undefined, 'none', editor.document.uri);
        const msg = e instanceof Error ? e.message : String(e);
        output.appendLine(`[analyze] ${relPath} 失败: ${msg}`);
        vscode.window.showErrorMessage(`Audit Assistant 分析失败：${msg}`);
      }
    }),

    vscode.commands.registerCommand('auditAssistant.openIndexCache', async () => {
      const cachePath = indexCache?.filePath;
      if (!cachePath) {
        return;
      }
      const uri = vscode.Uri.file(cachePath);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        vscode.window.showInformationMessage(
          'Audit: 还没有索引缓存。先运行「Audit: 索引整个项目」，缓存会写入 ' + cachePath,
        );
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', uri);
    }),

    vscode.commands.registerCommand('auditAssistant.generateArchitecture', async () => {
      if (index.stats.files === 0) {
        await vscode.commands.executeCommand('auditAssistant.indexWorkspace');
      }
      if (index.stats.files === 0) {
        vscode.window.showWarningMessage('Audit: 索引为空，无法生成结构图');
        return;
      }
      // LLM 未配置时照常出图，只是没有模块职责标注
      const llmCfg = await getLlmConfig(context);
      const client = llmCfg.model ? new LlmClient(llmCfg) : undefined;
      const settings = getSettings();
      const { architecture, llmError } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Audit: 生成项目结构图', cancellable: false },
        (progress) =>
          generateArchitecture(index, store, client, {
            outputLanguage: settings.outputLanguage,
            onProgress: (message) => progress.report({ message }),
          }),
      );
      if (llmError) {
        output.appendLine(`[architecture] LLM 标注失败: ${llmError}`);
        vscode.window.showWarningMessage(`Audit: 结构树已生成，但 LLM 职责标注失败（${llmError}）`);
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(store.root, 'architecture.md')));
      output.appendLine(`[architecture] ${architecture.modules.length} 个模块，${architecture.edges.length} 条依赖边 -> .audit/architecture.md`);
    }),

    vscode.commands.registerCommand('auditAssistant.showArchitecture', async () => {
      if (!store.loadArchitecture()) {
        const pick = await vscode.window.showInformationMessage('还没有生成过结构树', '立即生成');
        if (pick === '立即生成') {
          vscode.commands.executeCommand('auditAssistant.generateArchitecture');
        }
        return;
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(store.root, 'architecture.md')));
    }),

    vscode.commands.registerCommand('auditAssistant.indexWorkspace', async () => {
      const settings = getSettings();
      const extensions = LANGUAGES.flatMap((l) => l.extensions.map((e) => e.slice(1)));
      const include = `**/*.{${[...new Set(extensions)].join(',')}}`;
      const exclude = settings.indexExclude.length ? `{${settings.indexExclude.join(',')}}` : undefined;
      const uris = await vscode.workspace.findFiles(include, exclude);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Audit: 索引项目',
          cancellable: true,
        },
        async (progress, token) => {
          let done = 0;
          for (const uri of uris) {
            if (token.isCancellationRequested) {
              break;
            }
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              if (bytes.byteLength <= 1024 * 1024) {
                await index.indexFile(relPathOf(uri), Buffer.from(bytes).toString('utf8'));
              }
            } catch (e) {
              output.appendLine(`[index] ${uri.fsPath} 失败: ${e}`);
            }
            done++;
            if (done % 20 === 0 || done === uris.length) {
              progress.report({
                message: `${done}/${uris.length}`,
                increment: (20 / uris.length) * 100,
              });
            }
          }
        },
      );
      indexCache?.save(index.allFiles());
      const s = index.stats;
      vscode.window.showInformationMessage(
        `Audit: 索引完成 — ${s.files} 个文件，${s.symbols} 个符号，${s.calls} 个调用点`,
      );
    }),
  );

  // ---------- 事件 ----------

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(showAnalysisFor),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme === 'file' && isSupportedFile(doc.uri.fsPath)) {
        await index.indexFile(relPathOf(doc.uri), doc.getText());
      }
      const editor = vscode.window.activeTextEditor;
      if (editor?.document === doc) {
        showAnalysisFor(editor);
      }
    }),
  );

  showAnalysisFor(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  if (indexCache && projectIndex) {
    indexCache.save(projectIndex.allFiles());
  }
}
