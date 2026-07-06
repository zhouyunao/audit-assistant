import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Architecture, FileAnalysis, Finding, Mark } from '../types';

/**
 * .audit/ 目录读写。所有数据人类可读、git 友好：
 *   audit.json / files/<hash>.json / marks.json / findings/<id>.json / architecture.md / report.md
 */
export class AuditStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, '.audit');
  }

  private ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  private writeJson(file: string, data: unknown): void {
    this.ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  private readJson<T>(file: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  init(): void {
    this.ensureDir(this.root);
    const meta = path.join(this.root, 'audit.json');
    if (!fs.existsSync(meta)) {
      this.writeJson(meta, {
        version: 1,
        createdAt: new Date().toISOString(),
        tool: 'audit-assistant',
      });
    }
  }

  // ---------- 文件分析 ----------

  /** 文件名用相对路径的 sha1，避免路径分隔符/长度问题；内容里保留原始 path 供人读 */
  private analysisPath(relPath: string): string {
    const key = crypto.createHash('sha1').update(relPath.replace(/\\/g, '/')).digest('hex');
    return path.join(this.root, 'files', `${key}.json`);
  }

  saveFileAnalysis(analysis: FileAnalysis): void {
    this.init();
    this.writeJson(this.analysisPath(analysis.path), analysis);
  }

  /** 读取文件分析；currentHash 不匹配时仍返回（标记 stale 由调用方处理） */
  loadFileAnalysis(relPath: string): FileAnalysis | undefined {
    return this.readJson<FileAnalysis>(this.analysisPath(relPath.replace(/\\/g, '/')));
  }

  // ---------- 项目结构图 ----------

  /** 同时写 architecture.json（webview 复用）和 architecture.md（人读/git 共享） */
  saveArchitecture(arch: Architecture): void {
    this.init();
    this.writeJson(path.join(this.root, 'architecture.json'), arch);
    fs.writeFileSync(path.join(this.root, 'architecture.md'), architectureMarkdown(arch), 'utf8');
  }

  loadArchitecture(): Architecture | undefined {
    return this.readJson<Architecture>(path.join(this.root, 'architecture.json'));
  }

  // ---------- source/sink 标记 ----------

  loadMarks(): Mark[] {
    return this.readJson<Mark[]>(path.join(this.root, 'marks.json')) ?? [];
  }

  saveMarks(marks: Mark[]): void {
    this.init();
    this.writeJson(path.join(this.root, 'marks.json'), marks);
  }

  upsertMark(mark: Mark): void {
    const marks = this.loadMarks();
    const i = marks.findIndex((m) => m.id === mark.id);
    if (i >= 0) {
      marks[i] = mark;
    } else {
      marks.push(mark);
    }
    this.saveMarks(marks);
  }

  // ---------- 调用链结论 ----------

  loadFindings(): Finding[] {
    const dir = path.join(this.root, 'findings');
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const findings: Finding[] = [];
    for (const n of names) {
      const f = this.readJson<Finding>(path.join(dir, n));
      if (f) {
        findings.push(f);
      }
    }
    return findings;
  }

  saveFinding(finding: Finding): void {
    this.init();
    this.writeJson(path.join(this.root, 'findings', `${finding.id}.json`), finding);
  }
}

function architectureMarkdown(arch: Architecture): string {
  const lines: string[] = [
    '# 项目结构图',
    '',
    `> 由 Audit Assistant 生成于 ${arch.generatedAt}${arch.model ? `（模型 ${arch.model}）` : ''}`,
    '',
  ];
  if (arch.overview) {
    lines.push(arch.overview, '');
  }
  lines.push('## 结构树', '', '```text', arch.tree, '```', '', '## 模块职责', '');
  for (const m of arch.modules) {
    lines.push(
      `- **${m.name}**（${m.fileCount} 个文件，${m.loc.toLocaleString('en-US')} 行）${m.description ? `：${m.description}` : ''}`,
    );
    for (const f of m.sampleFiles.slice(0, 3)) {
      lines.push(`  - ${f}`);
    }
  }
  if (arch.edges.length) {
    lines.push('', '## 模块依赖', '');
    for (const e of arch.edges.slice(0, 40)) {
      lines.push(`- ${e.from} → ${e.to}${e.weight > 1 ? `（${e.weight} 处引用）` : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
