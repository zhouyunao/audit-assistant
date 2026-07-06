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
import { TAINT_RULES } from './features/taint/rules';
import { compileRules, scanFile, mergeCandidates } from './features/taint/candidates';
import { applyManualMark, symbolAt } from './features/taint/marks';
import { searchChainsFromSink } from './features/taint/pathSearch';
import { verifyChain } from './features/taint/chainVerify';
import { FileAnalysisTreeProvider } from './views/fileAnalysisTree';
import { AnalysisDecorations } from './views/decorations';
import { SourceSinkTreeProvider } from './views/sourceSinkTree';
import { MarkCodeLensProvider } from './views/markCodeLens';
import { MarkDecorations } from './views/markDecorations';
import { FindingsTreeProvider } from './views/findingsTree';
import { Mark } from './types';

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

  const relPathOf = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');

  /** 读取工作区相对路径的文件内容（供调用链取证的工具/预取使用） */
  const readFileRel = async (relFile: string): Promise<string | undefined> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(workspaceRoot, relFile)));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  };

  const analysisTree = new FileAnalysisTreeProvider();
  const sourceSinkTree = new SourceSinkTreeProvider(store);
  const findingsTree = new FindingsTreeProvider(store);
  const decorations = new AnalysisDecorations();
  const markDecorations = new MarkDecorations();
  const markCodeLens = new MarkCodeLensProvider(store, relPathOf);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('auditFileAnalysis', analysisTree),
    vscode.window.registerTreeDataProvider('auditSourceSink', sourceSinkTree),
    vscode.window.registerTreeDataProvider('auditFindings', findingsTree),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, markCodeLens),
    decorations,
    markDecorations,
  );

  /** 把当前文件的 source/sink 标记画到编辑器上 */
  const showMarksFor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const rel = relPathOf(editor.document.uri);
    markDecorations.apply(editor, store.loadMarks().filter((m) => m.file === rel));
  };

  /** 标记数据变化后统一刷新：视图、CodeLens、当前编辑器装饰 */
  const refreshMarks = () => {
    sourceSinkTree.refresh();
    markCodeLens.refresh();
    showMarksFor(vscode.window.activeTextEditor);
  };

  /** 命令参数可能是标记 id 字符串，或 TreeView item（带 markId） */
  const resolveMarkId = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg && typeof (arg as { markId?: unknown }).markId === 'string') {
      return (arg as { markId: string }).markId;
    }
    return undefined;
  };

  const setMarkStatus = (arg: unknown, status: 'confirmed' | 'excluded' | 'candidate') => {
    const id = resolveMarkId(arg);
    if (!id) {
      return;
    }
    const mark = store.loadMarks().find((m) => m.id === id);
    if (!mark) {
      return;
    }
    if (status === 'confirmed') {
      mark.author = getSettings().author;
      mark.time = new Date().toISOString();
    }
    mark.status = status;
    store.upsertMark(mark);
    refreshMarks();
  };

  const markSelection = async (kind: 'source' | 'sink') => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      vscode.window.showWarningMessage('Audit: 请先在代码文件中选中要标记的行');
      return;
    }
    const rel = relPathOf(editor.document.uri);
    const line0 = editor.selection.active.line;
    // 尽量用已索引的符号；未索引则即时索引一次
    let fileIndex = index.getFile(rel);
    if (!fileIndex) {
      fileIndex = await index.indexFile(rel, editor.document.getText());
    }
    const sym = symbolAt(fileIndex?.symbols, line0);
    const anchor = editor.document.lineAt(line0).text.trim().slice(0, 40);
    const mark = applyManualMark(
      store.loadMarks(),
      { kind, file: rel, line: line0 + 1, symbol: sym?.name, anchor, author: getSettings().author },
      new Date().toISOString(),
    );
    store.upsertMark(mark);
    refreshMarks();
    vscode.window.showInformationMessage(`Audit: 已标记 ${kind === 'sink' ? 'Sink' : 'Source'} — ${rel}:${line0 + 1}`);
  };

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
      refreshMarks();
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

    vscode.commands.registerCommand('auditAssistant.scanTaint', async () => {
      if (index.stats.files === 0) {
        await vscode.commands.executeCommand('auditAssistant.indexWorkspace');
      }
      if (index.stats.files === 0) {
        vscode.window.showWarningMessage('Audit: 索引为空，无法扫描 source/sink');
        return;
      }
      const compiled = compileRules(TAINT_RULES);
      const now = new Date().toISOString();
      const candidates = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Audit: 扫描 Source/Sink 候选', cancellable: true },
        async (progress, token) => {
          const files = index.allFiles();
          const found: Mark[] = [];
          let done = 0;
          for (const fi of files) {
            if (token.isCancellationRequested) {
              break;
            }
            try {
              const uri = vscode.Uri.file(path.join(workspaceRoot, fi.file));
              const bytes = await vscode.workspace.fs.readFile(uri);
              const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
              found.push(...scanFile({ file: fi.file, languageId: fi.languageId, lines, calls: fi.calls, symbols: fi.symbols }, compiled, now));
            } catch (e) {
              output.appendLine(`[taint] ${fi.file} 扫描失败: ${e}`);
            }
            done++;
            if (done % 25 === 0 || done === files.length) {
              progress.report({ message: `${done}/${files.length}`, increment: (25 / files.length) * 100 });
            }
          }
          return found;
        },
      );
      const merged = mergeCandidates(store.loadMarks(), candidates);
      store.saveMarks(merged);
      refreshMarks();
      const newCandidates = candidates.filter((c) => merged.some((m) => m.id === c.id && m.status === 'candidate')).length;
      vscode.window.showInformationMessage(
        `Audit: 扫描完成 — 命中 ${candidates.length} 个候选（当前候选 ${newCandidates} 个待复核）。可在编辑器右键或 CodeLens 上确认/排除。`,
      );
      vscode.commands.executeCommand('auditSourceSink.focus');
    }),

    vscode.commands.registerCommand('auditAssistant.markAsSource', () => markSelection('source')),
    vscode.commands.registerCommand('auditAssistant.markAsSink', () => markSelection('sink')),
    vscode.commands.registerCommand('auditAssistant.confirmMark', (arg) => setMarkStatus(arg, 'confirmed')),
    vscode.commands.registerCommand('auditAssistant.excludeMark', (arg) => setMarkStatus(arg, 'excluded')),
    vscode.commands.registerCommand('auditAssistant.restoreMark', (arg) => setMarkStatus(arg, 'candidate')),
    vscode.commands.registerCommand('auditAssistant.deleteMark', (arg) => {
      const id = resolveMarkId(arg);
      if (id) {
        store.deleteMark(id);
        refreshMarks();
      }
    }),
    vscode.commands.registerCommand('auditAssistant.refreshSourceSink', () => refreshMarks()),

    vscode.commands.registerCommand('auditAssistant.verifyChain', async (arg) => {
      const id = resolveMarkId(arg);
      const marks = store.loadMarks();
      const sink = id ? marks.find((m) => m.id === id) : marks.find((m) => m.kind === 'sink');
      if (!sink || sink.kind !== 'sink') {
        vscode.window.showWarningMessage('Audit: 请在 Sink 标记上执行调用链确认（先扫描或手动标记 Sink）');
        return;
      }
      const llmCfg = await getLlmConfig(context);
      if (!llmCfg.model) {
        const pick = await vscode.window.showWarningMessage('Audit: 调用链确认需要配置 LLM 端点/模型', '打开设置');
        if (pick === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'auditAssistant.llm');
        }
        return;
      }
      if (index.stats.files === 0) {
        await vscode.commands.executeCommand('auditAssistant.indexWorkspace');
      }

      const sourceMarks = marks.filter((m) => m.kind === 'source');
      const candidates = searchChainsFromSink(index, sink.file, sink.line, { sourceMarks });
      if (!candidates.length) {
        vscode.window.showInformationMessage('Audit: 未搜索到通向该 Sink 的调用链候选');
        return;
      }

      // 多条候选时让用户选一条（默认最高分）
      let chosen = candidates[0];
      if (candidates.length > 1) {
        const items = candidates.map((c, i) => ({
          label: `${c.hops[0].name} → … → ${c.hops[c.hops.length - 1].name}`,
          description: `${c.hops.length} 跳 · ${c.reachedSourceMarkId ? '命中 Source' : c.entryReason ?? ''} · 评分 ${c.score}`,
          detail: c.hops.map((h) => h.name).join(' → '),
          index: i,
        }));
        const picked = await vscode.window.showQuickPick(items, { title: `选择要验证的调用链（共 ${candidates.length} 条候选）` });
        if (!picked) {
          return;
        }
        chosen = candidates[picked.index];
      }

      const source = chosen.reachedSourceMarkId ? sourceMarks.find((m) => m.id === chosen.reachedSourceMarkId) : undefined;
      const settings = getSettings();
      const client = new LlmClient(llmCfg);
      try {
        const finding = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Audit: LLM 验证调用链', cancellable: false },
          () =>
            verifyChain(index, client, readFileRel, chosen, sink, source, {
              author: settings.author,
              outputLanguage: settings.outputLanguage,
            }),
        );
        store.saveFinding(finding);
        findingsTree.refresh();
        output.appendLine(`[verify] ${finding.title} — ${finding.chain.length} 跳`);
        vscode.commands.executeCommand('auditFindings.focus');
        const verdictCn = finding.verdict === 'reachable' ? '可达' : finding.verdict === 'unreachable' ? '不可达' : '待定';
        vscode.window.showInformationMessage(`Audit: 调用链结论 — ${verdictCn}。已存入 .audit/findings/`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        output.appendLine(`[verify] 失败: ${msg}`);
        vscode.window.showErrorMessage(`Audit: 调用链验证失败：${msg}`);
      }
    }),

    vscode.commands.registerCommand('auditAssistant.deleteFinding', (arg) => {
      const fid = typeof arg === 'string' ? arg : (arg as { findingId?: string })?.findingId;
      if (fid) {
        store.deleteFinding(fid);
        findingsTree.refresh();
      }
    }),

    vscode.commands.registerCommand('auditAssistant.refreshFindings', () => findingsTree.refresh()),

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
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      showAnalysisFor(editor);
      showMarksFor(editor);
    }),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme === 'file' && isSupportedFile(doc.uri.fsPath)) {
        await index.indexFile(relPathOf(doc.uri), doc.getText());
      }
      const editor = vscode.window.activeTextEditor;
      if (editor?.document === doc) {
        showAnalysisFor(editor);
        showMarksFor(editor);
      }
    }),
  );

  showAnalysisFor(vscode.window.activeTextEditor);
  showMarksFor(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  if (indexCache && projectIndex) {
    indexCache.save(projectIndex.allFiles());
  }
}
