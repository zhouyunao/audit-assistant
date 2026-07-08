import * as vscode from 'vscode';
import { AuditStore } from '../store/auditStore';
import { Mark } from '../types';

class Node extends vscode.TreeItem {
  children?: Node[];
  markId?: string;
  parent?: Node;
}

const STATUS_ORDER: Record<Mark['status'], number> = { confirmed: 0, candidate: 1, excluded: 2 };

const STATUS_ICON: Record<Mark['status'], vscode.ThemeIcon> = {
  confirmed: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
  candidate: new vscode.ThemeIcon('question'),
  excluded: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
};

const STATUS_LABEL: Record<Mark['status'], string> = { confirmed: 'Confirmed', candidate: 'Candidate', excluded: 'Excluded' };

/** Stable TreeItem id for a file (document) node. */
function fileNodeId(file: string): string {
  return `f:${file}`;
}

/**
 * Source/Sink view: top level is one node per file (document); all marks from the same file are
 * collected under that path, listed by line. Each mark leaf shows its kind and status.
 */
export class SourceSinkTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: AuditStore) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      return element.children ?? [];
    }
    return this.buildFileGroups();
  }

  /** Required for TreeView.reveal(); file nodes are top-level, leaves point back to their file node. */
  getParent(element: Node): Node | undefined {
    return element.parent;
  }

  /** Return the file node for a given path, or undefined if the file has no marks. Used to sync selection with the active editor. */
  nodeForFile(file: string): Node | undefined {
    return this.buildFileGroups().find((n) => n.id === fileNodeId(file));
  }

  /** Build one file node per document, each holding its marks (sorted by line). */
  private buildFileGroups(): Node[] {
    const marks = this.store.loadMarks();
    if (!marks.length) {
      return [];
    }
    const byFile = new Map<string, Mark[]>();
    for (const m of marks) {
      (byFile.get(m.file) ?? byFile.set(m.file, []).get(m.file)!).push(m);
    }
    return [...byFile.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([file, fileMarks]) => this.fileGroup(file, fileMarks));
  }

  /** A file node containing all its source/sink marks. */
  private fileGroup(file: string, marks: Mark[]): Node {
    const confirmed = marks.filter((m) => m.status === 'confirmed').length;
    const sinks = marks.filter((m) => m.kind === 'sink').length;
    const sources = marks.length - sinks;

    const node = new Node(file, vscode.TreeItemCollapsibleState.Expanded);
    // Stable id so selection/expansion survive refreshes and TreeView.reveal() can match across rebuilds
    node.id = fileNodeId(file);
    node.description = `${sinks} sink / ${sources} source · ${confirmed} confirmed`;
    node.tooltip = file;
    node.iconPath = new vscode.ThemeIcon('file-code');
    node.children = marks
      .slice()
      // Reading order within the document: by line, then confirmed-first on ties
      .sort((a, b) => a.line - b.line || STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
      .map((m) => this.leaf(m, node));
    return node;
  }

  private leaf(m: Mark, parent: Node): Node {
    const kindLabel = m.kind === 'sink' ? 'Sink' : 'Source';
    const node = new Node(`${m.symbol ? m.symbol + '  ' : ''}${m.anchor ?? ''}`.trim() || m.category || kindLabel);
    node.parent = parent;
    node.description = `L${m.line} · ${kindLabel} · ${STATUS_LABEL[m.status]}${m.category ? ' · ' + m.category : ''}`;
    node.tooltip = new vscode.MarkdownString(
      [
        `**${kindLabel}** · ${STATUS_LABEL[m.status]}`,
        m.category ? `Category: ${m.category}${m.cwe ? ` (${m.cwe})` : ''}` : '',
        `Location: ${m.file}:${m.line}`,
        m.author ? `Marked by: ${m.author}` : '',
        m.note ? `Note: ${m.note}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    node.iconPath = STATUS_ICON[m.status];
    node.markId = m.id;
    node.contextValue = `auditMark.${m.kind}.${m.status}`;
    node.command = { command: 'auditAssistant.revealLocation', title: 'Go to', arguments: [m.file, m.line] };
    return node;
  }
}
