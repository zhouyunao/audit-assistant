import * as crypto from 'crypto';
import { ParserPool } from './parser';
import { extractSymbols } from './symbols';
import { extractCalls } from './callGraph';
import { extractImports } from './imports';
import { specForFile } from './languages';
import { CallSite, FileIndex, SymbolInfo } from '../types';

export function contentHash(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

export function isSupportedFile(filePath: string): boolean {
  return specForFile(filePath) !== undefined;
}

/**
 * 项目级索引：文件 -> 符号表 + 调用点。
 * 调用图为名称匹配的近似图，精确性由 LLM 沿链取证弥补（见 chainVerify）。
 */
export class ProjectIndex {
  private files = new Map<string, FileIndex>();

  constructor(private readonly pool: ParserPool) {}

  /** 解析并索引一个文件；内容未变化时直接返回缓存。 */
  async indexFile(relPath: string, content: string): Promise<FileIndex | undefined> {
    const hash = contentHash(content);
    const existing = this.files.get(relPath);
    if (existing && existing.contentHash === hash) {
      return existing;
    }
    const parsed = await this.pool.parse(relPath, content);
    if (!parsed) {
      return undefined;
    }
    const { tree, spec } = parsed;
    try {
      const symbols = extractSymbols(tree.rootNode, spec, relPath);
      const calls = extractCalls(tree.rootNode, spec, relPath, symbols);
      const imports = extractImports(tree.rootNode, spec);
      const fileIndex: FileIndex = {
        file: relPath,
        contentHash: hash,
        languageId: spec.id,
        lines: content.split('\n').length,
        symbols,
        calls,
        imports,
      };
      this.files.set(relPath, fileIndex);
      return fileIndex;
    } finally {
      tree.delete();
    }
  }

  /** 从持久化缓存恢复（不重新解析） */
  restore(entries: FileIndex[]): void {
    for (const e of entries) {
      this.files.set(e.file, e);
    }
  }

  removeFile(relPath: string): void {
    this.files.delete(relPath);
  }

  getFile(relPath: string): FileIndex | undefined {
    return this.files.get(relPath);
  }

  allFiles(): FileIndex[] {
    return [...this.files.values()];
  }

  /** 全项目同名符号（调用图解析用）。优先返回同文件、再同目录的定义。 */
  symbolsByName(name: string, preferFile?: string): SymbolInfo[] {
    const result: SymbolInfo[] = [];
    for (const f of this.files.values()) {
      for (const s of f.symbols) {
        if (s.name === name) {
          result.push(s);
        }
      }
    }
    if (preferFile) {
      const dir = preferFile.replace(/[^/\\]*$/, '');
      result.sort((a, b) => rank(a) - rank(b));
      function rank(s: SymbolInfo): number {
        if (s.file === preferFile) {
          return 0;
        }
        return s.file.startsWith(dir) ? 1 : 2;
      }
    }
    return result;
  }

  /** 按符号 id（<file>#<name>@<row>）查符号定义 */
  symbolById(id: string): SymbolInfo | undefined {
    const file = id.split('#')[0];
    const fi = this.files.get(file);
    return fi?.symbols.find((s) => s.id === id);
  }

  /** 谁调用了名为 name 的符号 */
  callersOf(name: string): CallSite[] {
    const result: CallSite[] = [];
    for (const f of this.files.values()) {
      for (const c of f.calls) {
        if (c.callee === name) {
          result.push(c);
        }
      }
    }
    return result;
  }

  get stats(): { files: number; symbols: number; calls: number } {
    let symbols = 0;
    let calls = 0;
    for (const f of this.files.values()) {
      symbols += f.symbols.length;
      calls += f.calls.length;
    }
    return { files: this.files.size, symbols, calls };
  }
}
