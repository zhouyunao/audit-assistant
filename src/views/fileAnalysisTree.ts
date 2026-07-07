import * as vscode from 'vscode';
import { FileAnalysis } from '../types';

type Status = 'none' | 'analyzing' | 'fresh' | 'stale' | 'unsaved';

class Item extends vscode.TreeItem {
  children?: Item[];
}

const SEVERITY_ICON: Record<string, vscode.ThemeIcon> = {
  high: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
  medium: new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground')),
  low: new vscode.ThemeIcon('info'),
};

/** "File Analysis" sidebar: summary / function list / suspected issues / attention points; click to jump to the line */
export class FileAnalysisTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private analysis: FileAnalysis | undefined;
  private status: Status = 'none';
  private fileUri: vscode.Uri | undefined;

  update(analysis: FileAnalysis | undefined, status: Status, fileUri?: vscode.Uri): void {
    this.analysis = analysis;
    this.status = status;
    this.fileUri = fileUri;
    this.emitter.fire();
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Item): Item[] {
    if (element) {
      return element.children ?? [];
    }
    if (this.status === 'none' || !this.analysis) {
      if (this.status === 'analyzing') {
        const item = new Item('Analyzing…');
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return [item];
      }
      return []; // show viewsWelcome
    }

    const a = this.analysis;
    const items: Item[] = [];

    const statusItem = new Item(
      this.status === 'stale'
        ? '⚠ Code changed; analysis may be stale'
        : `Analyzed ${new Date(a.analyzedAt).toLocaleString()} · ${a.author}`,
    );
    statusItem.description = a.model;
    statusItem.iconPath = new vscode.ThemeIcon(this.status === 'stale' ? 'history' : 'check');
    statusItem.tooltip = a.path;
    items.push(statusItem);

    const summaryItem = new Item('Summary', vscode.TreeItemCollapsibleState.Expanded);
    summaryItem.iconPath = new vscode.ThemeIcon('book');
    summaryItem.children = [this.textItem(a.summary)];
    items.push(summaryItem);

    if (a.issues.length) {
      const g = new Item(`Suspected Issues (${a.issues.length})`, vscode.TreeItemCollapsibleState.Expanded);
      g.iconPath = new vscode.ThemeIcon('shield');
      g.children = a.issues.map((i) => {
        const item = new Item(`${i.title}${i.cwe ? ` [${i.cwe}]` : ''}`);
        item.description = `L${i.startLine} · ${i.severity}/${i.confidence}`;
        item.iconPath = SEVERITY_ICON[i.severity] ?? SEVERITY_ICON.medium;
        item.tooltip = new vscode.MarkdownString(
          `**${i.title}**\n\n${i.reason}${i.advice ? `\n\n**Advice**: ${i.advice}` : ''}`,
        );
        item.command = this.jumpCommand(i.startLine);
        return item;
      });
      items.push(g);
    }

    if (a.functions.length) {
      const g = new Item(`Functions (${a.functions.length})`, vscode.TreeItemCollapsibleState.Expanded);
      g.iconPath = new vscode.ThemeIcon('symbol-function');
      g.children = a.functions.map((f) => {
        const item = new Item(f.name);
        item.description = f.description;
        item.tooltip = `L${f.line}  ${f.description}`;
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        item.command = this.jumpCommand(f.line);
        return item;
      });
      items.push(g);
    }

    if (a.attention.length) {
      const g = new Item(`Attention (${a.attention.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      g.iconPath = new vscode.ThemeIcon('eye');
      g.children = a.attention.map((s) => {
        const item = new Item(`L${s.startLine}~${s.endLine}`);
        item.description = s.note;
        item.tooltip = s.note;
        item.iconPath = new vscode.ThemeIcon('bookmark');
        item.command = this.jumpCommand(s.startLine);
        return item;
      });
      items.push(g);
    }

    return items;
  }

  private textItem(text: string): Item {
    const item = new Item(text);
    item.tooltip = text;
    return item;
  }

  private jumpCommand(line: number): vscode.Command | undefined {
    if (!this.fileUri) {
      return undefined;
    }
    return {
      command: 'auditAssistant.revealLine',
      title: 'Go to',
      arguments: [this.fileUri, line],
    };
  }
}
