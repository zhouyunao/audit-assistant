import * as vscode from 'vscode';
import { AuditStore } from '../store/auditStore';

/** Above marked source/sink lines, show status and quick actions (confirm/exclude/restore/delete). */
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
        m.status === 'confirmed' ? 'Confirmed' : m.status === 'excluded' ? 'Excluded' : 'Candidate'
      }${m.category ? ' · ' + m.category : ''}`;
      lenses.push(new vscode.CodeLens(range, { command: '', title: label }));

      const actions: Array<[string, string]> =
        m.status === 'candidate'
          ? [['Confirm', 'auditAssistant.confirmMark'], ['Exclude', 'auditAssistant.excludeMark'], ['Delete', 'auditAssistant.deleteMark']]
          : m.status === 'confirmed'
            ? [['To candidate', 'auditAssistant.restoreMark'], ['Delete', 'auditAssistant.deleteMark']]
            : [['Restore', 'auditAssistant.restoreMark'], ['Delete', 'auditAssistant.deleteMark']];
      for (const [title, command] of actions) {
        lenses.push(new vscode.CodeLens(range, { title, command, arguments: [m.id] }));
      }
      if (m.kind === 'sink' && m.status !== 'excluded') {
        lenses.push(new vscode.CodeLens(range, { title: 'Verify Call Chain', command: 'auditAssistant.verifyChain', arguments: [m.id] }));
      }
    }
    return lenses;
  }
}
