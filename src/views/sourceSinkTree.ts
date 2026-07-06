import * as vscode from 'vscode';
import { AuditStore } from '../store/auditStore';
import { Mark } from '../types';

class Node extends vscode.TreeItem {
  children?: Node[];
  markId?: string;
}

const STATUS_ORDER: Record<Mark['status'], number> = { confirmed: 0, candidate: 1, excluded: 2 };

const STATUS_ICON: Record<Mark['status'], vscode.ThemeIcon> = {
  confirmed: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
  candidate: new vscode.ThemeIcon('question'),
  excluded: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
};

const STATUS_LABEL: Record<Mark['status'], string> = { confirmed: '已确认', candidate: '候选', excluded: '已排除' };

/** Source/Sink 视图：按 Sink / Source 两组，组内按 已确认→候选→已排除 排序 */
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
    const marks = this.store.loadMarks();
    if (!marks.length) {
      return [];
    }
    return (['sink', 'source'] as const)
      .map((kind) => this.group(kind, marks.filter((m) => m.kind === kind)))
      .filter((g): g is Node => g !== undefined);
  }

  private group(kind: 'source' | 'sink', marks: Mark[]): Node | undefined {
    if (!marks.length) {
      return undefined;
    }
    const confirmed = marks.filter((m) => m.status === 'confirmed').length;
    const group = new Node(
      kind === 'sink' ? 'Sink' : 'Source',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    group.description = `${marks.length} 个（已确认 ${confirmed}）`;
    group.iconPath = new vscode.ThemeIcon(kind === 'sink' ? 'flame' : 'sign-in');
    group.children = marks
      .slice()
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.file.localeCompare(b.file) || a.line - b.line)
      .map((m) => this.leaf(m));
    return group;
  }

  private leaf(m: Mark): Node {
    const node = new Node(`${m.symbol ? m.symbol + '  ' : ''}${m.anchor ?? ''}`.trim() || m.category || m.kind);
    node.description = `${m.file}:${m.line} · ${STATUS_LABEL[m.status]}${m.category ? ' · ' + m.category : ''}`;
    node.tooltip = new vscode.MarkdownString(
      [
        `**${m.kind === 'sink' ? 'Sink' : 'Source'}** · ${STATUS_LABEL[m.status]}`,
        m.category ? `分类：${m.category}${m.cwe ? ` (${m.cwe})` : ''}` : '',
        `位置：${m.file}:${m.line}`,
        m.author ? `标记人：${m.author}` : '',
        m.note ? `备注：${m.note}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    node.iconPath = STATUS_ICON[m.status];
    node.markId = m.id;
    node.contextValue = `auditMark.${m.status}`;
    node.command = { command: 'auditAssistant.revealLocation', title: '跳转', arguments: [m.file, m.line] };
    return node;
  }
}
