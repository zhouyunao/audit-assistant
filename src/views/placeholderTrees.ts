import * as vscode from 'vscode';
import { AuditStore } from '../store/auditStore';

/**
 * Source/Sink 与调用链结论视图。
 * 完整的扫描/标记/确认交互在 M5/M6 提供；当前先把 .audit/ 里已有的数据展示出来，
 * 保证团队成员拿到共享的 .audit/ 目录后能立即看到既有标记与结论。
 */

class Item extends vscode.TreeItem {}

export class SourceSinkTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: AuditStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Item): Item[] {
    if (element) {
      return [];
    }
    const marks = this.store.loadMarks();
    return marks.map((m) => {
      const item = new Item(`${m.kind === 'source' ? '⬇ source' : '⬆ sink'} ${m.symbol ?? ''}`);
      item.description = `${m.file}:${m.line} · ${m.status} · ${m.author}`;
      item.tooltip = m.note ?? '';
      item.command = {
        command: 'auditAssistant.revealLocation',
        title: '跳转',
        arguments: [m.file, m.line],
      };
      return item;
    });
  }
}

export class FindingsTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: AuditStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Item): Item[] {
    if (element) {
      return [];
    }
    const verdictLabel: Record<string, string> = {
      reachable: '✗ 可达',
      unreachable: '✓ 不可达',
      undetermined: '? 待定',
    };
    return this.store.loadFindings().map((f) => {
      const item = new Item(`${verdictLabel[f.verdict] ?? f.verdict} ${f.title}`);
      item.description = `${f.chain.length} 跳 · ${f.author}`;
      item.tooltip = f.analysis;
      if (f.chain.length) {
        item.command = {
          command: 'auditAssistant.revealLocation',
          title: '跳转',
          arguments: [f.chain[0].file, f.chain[0].line],
        };
      }
      return item;
    });
  }
}
