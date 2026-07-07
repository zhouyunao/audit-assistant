import * as vscode from 'vscode';
import { AuditStore } from '../store/auditStore';
import { Finding } from '../types';

class Node extends vscode.TreeItem {
  children?: Node[];
  findingId?: string;
}

const VERDICT: Record<Finding['verdict'], { label: string; icon: vscode.ThemeIcon }> = {
  reachable: { label: 'Reachable', icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) },
  unreachable: { label: 'Unreachable', icon: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')) },
  undetermined: { label: 'Undetermined', icon: new vscode.ThemeIcon('question') },
};

/** Call-chain findings view: each finding expands into its per-hop chain; click a hop to jump to code. */
export class FindingsTreeProvider implements vscode.TreeDataProvider<Node> {
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
    const findings = this.store.loadFindings();
    const order: Record<Finding['verdict'], number> = { reachable: 0, undetermined: 1, unreachable: 2 };
    return findings
      .slice()
      .sort((a, b) => order[a.verdict] - order[b.verdict])
      .map((f) => this.findingNode(f));
  }

  private findingNode(f: Finding): Node {
    const v = VERDICT[f.verdict];
    const node = new Node(f.title, vscode.TreeItemCollapsibleState.Collapsed);
    node.description = `${f.chain.length} hops · ${f.author}`;
    node.tooltip = new vscode.MarkdownString(`**Verdict: ${v.label}**\n\n${f.analysis}`);
    node.iconPath = v.icon;
    node.findingId = f.id;
    node.contextValue = 'auditFinding';
    node.children = f.chain.map((h, i) => {
      const hop = new Node(`${i + 1}. ${h.symbol || '(?)'}`);
      hop.description = `${h.file}:${h.line}`;
      hop.tooltip = h.evidence || undefined;
      hop.iconPath = new vscode.ThemeIcon(i === f.chain.length - 1 ? 'flame' : 'arrow-small-right');
      hop.command = { command: 'auditAssistant.revealLocation', title: 'Go to', arguments: [h.file, h.line] };
      return hop;
    });
    return node;
  }
}
