import * as vscode from 'vscode';
import { AuditStore } from '../store/auditStore';

/** 在已标记的 source/sink 行上方显示状态与快捷操作（确认/排除/恢复/删除）。 */
export class MarkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly store: AuditStore,
    private readonly relPathOf: (uri: vscode.Uri) => string,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file') {
      return [];
    }
    const rel = this.relPathOf(document.uri);
    const marks = this.store.loadMarks().filter((m) => m.file === rel);
    const lenses: vscode.CodeLens[] = [];
    for (const m of marks) {
      const line = Math.min(Math.max(0, m.line - 1), Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const label = `${m.kind === 'sink' ? '⬇ Sink' : '⬇ Source'} · ${
        m.status === 'confirmed' ? '已确认' : m.status === 'excluded' ? '已排除' : '候选'
      }${m.category ? ' · ' + m.category : ''}`;
      lenses.push(new vscode.CodeLens(range, { command: '', title: label }));

      const actions: Array<[string, string]> =
        m.status === 'candidate'
          ? [['确认', 'auditAssistant.confirmMark'], ['排除', 'auditAssistant.excludeMark'], ['删除', 'auditAssistant.deleteMark']]
          : m.status === 'confirmed'
            ? [['转为候选', 'auditAssistant.restoreMark'], ['删除', 'auditAssistant.deleteMark']]
            : [['恢复', 'auditAssistant.restoreMark'], ['删除', 'auditAssistant.deleteMark']];
      for (const [title, command] of actions) {
        lenses.push(new vscode.CodeLens(range, { title, command, arguments: [m.id] }));
      }
      if (m.kind === 'sink' && m.status !== 'excluded') {
        lenses.push(new vscode.CodeLens(range, { title: '确认调用链', command: 'auditAssistant.verifyChain', arguments: [m.id] }));
      }
    }
    return lenses;
  }
}
