import * as vscode from 'vscode';
import { Mark } from '../types';

/** Mark source/sink lines in the editor's left border and overview ruler. */
export class MarkDecorations implements vscode.Disposable {
  private readonly sink = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorError.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly source = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('charts.blue'),
    overviewRulerColor: new vscode.ThemeColor('charts.blue'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  apply(editor: vscode.TextEditor, marks: Mark[]): void {
    const max = editor.document.lineCount;
    const line = (n: number) => new vscode.Range(Math.min(Math.max(0, n - 1), max - 1), 0, Math.min(Math.max(0, n - 1), max - 1), 0);
    const active = marks.filter((m) => m.status !== 'excluded');
    editor.setDecorations(this.sink, active.filter((m) => m.kind === 'sink').map((m) => ({ range: line(m.line) })));
    editor.setDecorations(this.source, active.filter((m) => m.kind === 'source').map((m) => ({ range: line(m.line) })));
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.sink, []);
    editor.setDecorations(this.source, []);
  }

  dispose(): void {
    this.sink.dispose();
    this.source.dispose();
  }
}
