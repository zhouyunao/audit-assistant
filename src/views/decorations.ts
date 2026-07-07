import * as vscode from 'vscode';
import { FileAnalysis } from '../types';

/** In-editor highlighting of issues/attention points. Hover shows the reason and advice. */
export class AnalysisDecorations implements vscode.Disposable {
  private readonly issueType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    isWholeLine: true,
  });

  private readonly attentionType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('inputValidation.warningBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    isWholeLine: true,
  });

  apply(editor: vscode.TextEditor, analysis: FileAnalysis | undefined): void {
    if (!analysis) {
      this.clear(editor);
      return;
    }
    const maxLine = editor.document.lineCount;
    const toRange = (start: number, end: number) =>
      new vscode.Range(Math.min(start, maxLine) - 1, 0, Math.min(end, maxLine) - 1, 0);

    const issues: vscode.DecorationOptions[] = analysis.issues.map((i) => ({
      range: toRange(i.startLine, i.endLine),
      hoverMessage: new vscode.MarkdownString(
        `$(shield) **${i.title}**${i.cwe ? ` \`${i.cwe}\`` : ''} — ${i.severity}/${i.confidence}\n\n` +
          `${i.reason}${i.advice ? `\n\n**Advice**: ${i.advice}` : ''}`,
        true,
      ),
    }));
    const attention: vscode.DecorationOptions[] = analysis.attention.map((s) => ({
      range: toRange(s.startLine, s.endLine),
      hoverMessage: new vscode.MarkdownString(`$(eye) **Audit attention**: ${s.note}`, true),
    }));

    editor.setDecorations(this.issueType, issues);
    editor.setDecorations(this.attentionType, attention);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.issueType, []);
    editor.setDecorations(this.attentionType, []);
  }

  dispose(): void {
    this.issueType.dispose();
    this.attentionType.dispose();
  }
}
