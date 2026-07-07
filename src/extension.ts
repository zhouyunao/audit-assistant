import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { getLlmConfig, getSettings, setApiKeyCommand } from './config';
import { createLlmProvider } from './llm/provider';
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
    // With no workspace open, only register setApiKey to avoid null pointers in other features
    context.subscriptions.push(
      vscode.commands.registerCommand('auditAssistant.setApiKey', () => setApiKeyCommand(context)),
    );
    return;
  }

  const pool = new ParserPool(context.asAbsolutePath('grammars'));
  const index = new ProjectIndex(pool);
  projectIndex = index;
  const store = new AuditStore(workspaceRoot);

  // Index cache: globalStorage/<workspace-hash>.json, avoids re-scanning on reopen
  const wsKey = crypto.createHash('sha1').update(workspaceRoot).digest('hex');
  indexCache = new IndexCache(path.join(context.globalStorageUri.fsPath, `index-${wsKey}.json`));
  index.restore(indexCache.load());

  const relPathOf = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');

  /** Read the content of a workspace-relative file (used by chain-verification tools/pre-fetch) */
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

  /** Draw the current file's source/sink marks in the editor */
  const showMarksFor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const rel = relPathOf(editor.document.uri);
    markDecorations.apply(editor, store.loadMarks().filter((m) => m.file === rel));
  };

  /** After mark data changes, refresh everything: view, CodeLens, current editor decorations */
  const refreshMarks = () => {
    sourceSinkTree.refresh();
    markCodeLens.refresh();
    showMarksFor(vscode.window.activeTextEditor);
  };

  /** The command argument may be a mark id string, or a TreeView item (with markId) */
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
      vscode.window.showWarningMessage('Audit: Select the line to mark in a code file first');
      return;
    }
    const rel = relPathOf(editor.document.uri);
    const line0 = editor.selection.active.line;
    // Prefer already-indexed symbols; index on the fly if not indexed yet
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
    vscode.window.showInformationMessage(`Audit: Marked ${kind === 'sink' ? 'Sink' : 'Source'} — ${rel}:${line0 + 1}`);
  };

  /** Show the existing analysis for an editor's file (with staleness check) */
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

  // ---------- Commands ----------

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
        vscode.window.showWarningMessage('Audit Assistant: Open a code file to analyze first');
        return;
      }
      const llmCfg = await getLlmConfig(context);
      if (!llmCfg.model) {
        const pick = await vscode.window.showWarningMessage(
          'Audit Assistant: LLM endpoint/model not configured yet',
          'Open Settings',
        );
        if (pick === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'auditAssistant.llm');
        }
        return;
      }
      const settings = getSettings();
      const client = createLlmProvider(llmCfg);
      const relPath = relPathOf(editor.document.uri);
      const content = editor.document.getText();

      analysisTree.update(undefined, 'analyzing', editor.document.uri);
      try {
        const analysis = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Audit: Analyzing ${path.basename(relPath)}`,
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
        output.appendLine(`[analyze] ${relPath} failed: ${msg}`);
        vscode.window.showErrorMessage(`Audit Assistant analysis failed: ${msg}`);
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
          'Audit: No index cache yet. Run "Audit: Index Workspace" first; the cache will be written to ' + cachePath,
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
        vscode.window.showWarningMessage('Audit: Index is empty; cannot generate the structure tree');
        return;
      }
      // Without LLM config the tree is still produced, just without module responsibility annotations
      const llmCfg = await getLlmConfig(context);
      const client = llmCfg.model ? createLlmProvider(llmCfg) : undefined;
      const settings = getSettings();
      const { architecture, llmError } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Audit: Generating structure tree', cancellable: false },
        (progress) =>
          generateArchitecture(index, store, client, {
            outputLanguage: settings.outputLanguage,
            onProgress: (message) => progress.report({ message }),
          }),
      );
      if (llmError) {
        output.appendLine(`[architecture] LLM annotation failed: ${llmError}`);
        vscode.window.showWarningMessage(`Audit: Structure tree generated, but LLM responsibility annotation failed (${llmError})`);
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(store.root, 'architecture.md')));
      output.appendLine(`[architecture] ${architecture.modules.length} modules, ${architecture.edges.length} dependency edges -> .audit/architecture.md`);
    }),

    vscode.commands.registerCommand('auditAssistant.showArchitecture', async () => {
      if (!store.loadArchitecture()) {
        const pick = await vscode.window.showInformationMessage('No structure tree has been generated yet', 'Generate now');
        if (pick === 'Generate now') {
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
        vscode.window.showWarningMessage('Audit: Index is empty; cannot scan for source/sink');
        return;
      }
      const compiled = compileRules(TAINT_RULES);
      const now = new Date().toISOString();
      const candidates = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Audit: Scanning Source/Sink candidates', cancellable: true },
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
              output.appendLine(`[taint] ${fi.file} scan failed: ${e}`);
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
        `Audit: Scan complete — ${candidates.length} candidates matched (${newCandidates} candidates awaiting review). Confirm/exclude via editor right-click or CodeLens.`,
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
        vscode.window.showWarningMessage('Audit: Run call-chain verification on a Sink mark (scan or manually mark a Sink first)');
        return;
      }
      const llmCfg = await getLlmConfig(context);
      if (!llmCfg.model) {
        const pick = await vscode.window.showWarningMessage('Audit: Call-chain verification requires an LLM endpoint/model', 'Open Settings');
        if (pick === 'Open Settings') {
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
        vscode.window.showInformationMessage('Audit: No candidate call chains found leading to this Sink');
        return;
      }

      // With multiple candidates, let the user pick one (default to the highest score)
      let chosen = candidates[0];
      if (candidates.length > 1) {
        const items = candidates.map((c, i) => ({
          label: `${c.hops[0].name} → … → ${c.hops[c.hops.length - 1].name}`,
          description: `${c.hops.length} hops · ${c.reachedSourceMarkId ? 'reaches Source' : c.entryReason ?? ''} · score ${c.score}`,
          detail: c.hops.map((h) => h.name).join(' → '),
          index: i,
        }));
        const picked = await vscode.window.showQuickPick(items, { title: `Select a call chain to verify (${candidates.length} candidates)` });
        if (!picked) {
          return;
        }
        chosen = candidates[picked.index];
      }

      const source = chosen.reachedSourceMarkId ? sourceMarks.find((m) => m.id === chosen.reachedSourceMarkId) : undefined;
      const settings = getSettings();
      const client = createLlmProvider(llmCfg);
      try {
        const finding = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Audit: LLM verifying call chain', cancellable: false },
          () =>
            verifyChain(index, client, readFileRel, chosen, sink, source, {
              author: settings.author,
              outputLanguage: settings.outputLanguage,
            }),
        );
        store.saveFinding(finding);
        findingsTree.refresh();
        output.appendLine(`[verify] ${finding.title} — ${finding.chain.length} hops`);
        vscode.commands.executeCommand('auditFindings.focus');
        vscode.window.showInformationMessage(`Audit: Call-chain verdict — ${finding.verdict}. Saved to .audit/findings/`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        output.appendLine(`[verify] failed: ${msg}`);
        vscode.window.showErrorMessage(`Audit: Call-chain verification failed: ${msg}`);
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
          title: 'Audit: Indexing workspace',
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
              output.appendLine(`[index] ${uri.fsPath} failed: ${e}`);
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
        `Audit: Indexing complete — ${s.files} files, ${s.symbols} symbols, ${s.calls} call sites`,
      );
    }),
  );

  // ---------- Events ----------

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
