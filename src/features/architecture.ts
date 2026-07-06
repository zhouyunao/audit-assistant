import { ProjectIndex } from '../indexer/indexer';
import { resolveImport } from '../indexer/imports';
import { LlmClient } from '../llm/client';
import { AuditStore } from '../store/auditStore';
import { Architecture, ArchEdge, ArchModule, FileIndex } from '../types';

const MAX_MODULES = 24;
const OTHER = '(其他)';

/**
 * 文件级依赖边：import 解析 + 跨文件调用（名称匹配，定义方 ≤3 个才计边以降噪）。
 */
export function buildFileEdges(files: FileIndex[], index: ProjectIndex): Map<string, Map<string, number>> {
  const allFiles = new Set(files.map((f) => f.file));
  const edges = new Map<string, Map<string, number>>();
  const add = (from: string, to: string) => {
    if (from === to) {
      return;
    }
    let m = edges.get(from);
    if (!m) {
      m = new Map();
      edges.set(from, m);
    }
    m.set(to, (m.get(to) ?? 0) + 1);
  };

  for (const f of files) {
    for (const imp of f.imports) {
      const target = resolveImport(f.file, imp, allFiles);
      if (target) {
        add(f.file, target);
      }
    }
    for (const call of f.calls) {
      const defs = index.symbolsByName(call.callee).filter((s) => s.file !== f.file && s.kind !== 'class');
      if (defs.length >= 1 && defs.length <= 3) {
        const targets = new Set(defs.map((d) => d.file));
        for (const t of targets) {
          add(f.file, t);
        }
      }
    }
  }
  return edges;
}

/**
 * 模块归属：默认取顶层目录；若某个顶层目录（如 src/）占了一半以上文件且有子目录，
 * 则对它下钻一层，让图更有信息量。
 */
export function makeModuleAssigner(files: string[]): (file: string) => string {
  const topCount = new Map<string, number>();
  const hasSub = new Map<string, boolean>();
  for (const f of files) {
    const parts = f.split('/');
    const top = parts.length > 1 ? parts[0] : '(root)';
    topCount.set(top, (topCount.get(top) ?? 0) + 1);
    if (parts.length > 2) {
      hasSub.set(top, true);
    }
  }
  const expand = new Set<string>();
  for (const [top, count] of topCount) {
    if (top !== '(root)' && count / files.length > 0.5 && hasSub.get(top)) {
      expand.add(top);
    }
  }
  return (file: string) => {
    const parts = file.split('/');
    if (parts.length === 1) {
      return '(root)';
    }
    if (expand.has(parts[0]) && parts.length > 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
  };
}

export interface ModuleGraph {
  modules: ArchModule[];
  edges: ArchEdge[];
}

export function buildModuleGraph(files: FileIndex[], index: ProjectIndex): ModuleGraph {
  const assignRaw = makeModuleAssigner(files.map((f) => f.file));

  // 模块 -> 文件（按符号数排序取代表文件）
  const byModule = new Map<string, FileIndex[]>();
  for (const f of files) {
    const m = assignRaw(f.file);
    (byModule.get(m) ?? byModule.set(m, []).get(m)!).push(f);
  }
  const keep = new Set(
    [...byModule.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_MODULES)
      .map(([name]) => name),
  );
  const assign = (file: string) => (keep.has(assignRaw(file)) ? assignRaw(file) : OTHER);

  const modules: ArchModule[] = [...byModule.entries()]
    .map(([name, fs]) => ({ name: keep.has(name) ? name : OTHER, files: fs }))
    .reduce((acc, cur) => {
      const existing = acc.find((m) => m.name === cur.name);
      if (existing) {
        existing.files.push(...cur.files);
      } else {
        acc.push(cur);
      }
      return acc;
    }, [] as Array<{ name: string; files: FileIndex[] }>)
    .map(({ name, files: fs }) => ({
      name,
      fileCount: fs.length,
      loc: fs.reduce((n, f) => n + f.lines, 0),
      sampleFiles: fs
        .slice()
        .sort((a, b) => b.symbols.length - a.symbols.length)
        .slice(0, 5)
        .map((f) => f.file),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  const fileEdges = buildFileEdges(files, index);
  const moduleEdges = new Map<string, Map<string, number>>();
  for (const [from, targets] of fileEdges) {
    for (const [to, w] of targets) {
      const mf = assign(from);
      const mt = assign(to);
      if (mf === mt) {
        continue;
      }
      let m = moduleEdges.get(mf);
      if (!m) {
        m = new Map();
        moduleEdges.set(mf, m);
      }
      m.set(mt, (m.get(mt) ?? 0) + w);
    }
  }
  const edges: ArchEdge[] = [];
  for (const [from, targets] of moduleEdges) {
    for (const [to, weight] of targets) {
      edges.push({ from, to, weight });
    }
  }
  edges.sort((a, b) => b.weight - a.weight);

  return { modules, edges };
}

interface DirNode {
  name: string;
  /** 相对路径（/ 分隔），根为 '' */
  path: string;
  fileCount: number;
  loc: number;
  children: Map<string, DirNode>;
}

/** 树渲染只需要路径和行数 */
export type TreeFile = Pick<FileIndex, 'file' | 'lines'>;

function buildDirTree(files: TreeFile[]): DirNode {
  const root: DirNode = { name: '.', path: '', fileCount: 0, loc: 0, children: new Map() };
  for (const f of files) {
    const parts = f.file.split('/');
    root.fileCount++;
    root.loc += f.lines;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = cur.children.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: cur.path ? `${cur.path}/${seg}` : seg,
          fileCount: 0,
          loc: 0,
          children: new Map(),
        };
        cur.children.set(seg, child);
      }
      child.fileCount++;
      child.loc += f.lines;
      cur = child;
    }
  }
  return root;
}

const MAX_TREE_DEPTH = 3;
const MAX_CHILDREN_SHOWN = 30;

/**
 * 带注释的纯文本目录树：模块级目录附上职责描述与依赖去向。
 */
export function renderTree(files: TreeFile[], modules: ArchModule[], edges: ArchEdge[], maxDepth = MAX_TREE_DEPTH): string {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    (deps.get(e.from) ?? deps.set(e.from, []).get(e.from)!).push(e.to);
  }

  const annotate = (node: DirNode): string => {
    let line = `${node.name}/ (${node.fileCount} 个文件, ${node.loc.toLocaleString('en-US')} 行)`;
    const mod = byName.get(node.path);
    if (mod?.description) {
      line += ` — ${mod.description}`;
    }
    const d = deps.get(node.path);
    if (d?.length) {
      line += `  [依赖 → ${d.slice(0, 4).join(', ')}]`;
    }
    return line;
  };

  const root = buildDirTree(files);
  let rootLine = `./ (共 ${root.fileCount} 个文件, ${root.loc.toLocaleString('en-US')} 行)`;
  const rootMod = byName.get('(root)');
  if (rootMod?.description) {
    rootLine += ` — 根目录文件：${rootMod.description}`;
  }
  const lines: string[] = [rootLine];
  const walk = (node: DirNode, prefix: string, depth: number) => {
    const children = [...node.children.values()].sort((a, b) => b.fileCount - a.fileCount);
    const shown = children.slice(0, MAX_CHILDREN_SHOWN);
    shown.forEach((child, i) => {
      const isLast = i === shown.length - 1 && children.length <= MAX_CHILDREN_SHOWN;
      const branch = isLast ? '└── ' : '├── ';
      const suffix = depth >= maxDepth && child.children.size > 0 ? ' …' : '';
      lines.push(prefix + branch + annotate(child) + suffix);
      if (depth < maxDepth) {
        walk(child, prefix + (isLast ? '    ' : '│   '), depth + 1);
      }
    });
    if (children.length > MAX_CHILDREN_SHOWN) {
      lines.push(`${prefix}└── … 其余 ${children.length - MAX_CHILDREN_SHOWN} 个目录`);
    }
  };
  walk(root, '', 1);
  return lines.join('\n');
}

interface RawAnnotation {
  overview?: string;
  modules?: Array<{ name?: string; description?: string }>;
}

/** 用 LLM 给模块标注一句话职责。失败/未配置时静默跳过，图照常可用。 */
async function annotate(
  graph: ModuleGraph,
  files: FileIndex[],
  store: AuditStore,
  client: LlmClient,
  outputLanguage: string,
): Promise<{ overview?: string; byModule: Map<string, string> }> {
  const lang = outputLanguage === 'en' ? 'English' : '简体中文';
  const byFile = new Map(files.map((f) => [f.file, f]));
  const moduleDesc = graph.modules
    .filter((m) => m.name !== OTHER)
    .map((m) => {
      const symbolNames = m.sampleFiles
        .flatMap((sf) => byFile.get(sf)?.symbols.map((s) => s.name) ?? [])
        .slice(0, 12);
      const summaries = m.sampleFiles
        .map((sf) => store.loadFileAnalysis(sf)?.summary)
        .filter(Boolean)
        .slice(0, 2);
      return [
        `模块 ${m.name}（${m.fileCount} 个文件，${m.loc} 行）`,
        `  代表文件: ${m.sampleFiles.slice(0, 5).join(', ')}`,
        symbolNames.length ? `  主要符号: ${symbolNames.join(', ')}` : '',
        ...summaries.map((s) => `  已有文件总结: ${s}`),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const raw = await client.completeJson<RawAnnotation>(
    [
      '你是资深代码审计专家。根据模块的文件名和符号名推断每个模块的职责，输出 JSON：',
      '{"overview": "项目整体是做什么的，2~3 句", "modules": [{"name": "模块名", "description": "该模块职责，一句话"}]}',
      `说明文字使用${lang}。模块名必须与输入完全一致。没把握的模块可以省略。`,
    ].join('\n'),
    moduleDesc,
  );
  const byModule = new Map<string, string>();
  for (const m of raw.modules ?? []) {
    if (m?.name && m.description) {
      byModule.set(m.name, m.description);
    }
  }
  return { overview: raw.overview, byModule };
}

export interface GenerateOptions {
  outputLanguage: string;
  onProgress?: (message: string) => void;
}

export async function generateArchitecture(
  index: ProjectIndex,
  store: AuditStore,
  client: LlmClient | undefined,
  opts: GenerateOptions,
): Promise<{ architecture: Architecture; llmError?: string }> {
  const files = index.allFiles();
  opts.onProgress?.('聚合依赖关系…');
  const graph = buildModuleGraph(files, index);

  let overview: string | undefined;
  let llmError: string | undefined;
  if (client) {
    opts.onProgress?.('LLM 标注模块职责…');
    try {
      const ann = await annotate(graph, files, store, client, opts.outputLanguage);
      overview = ann.overview;
      for (const m of graph.modules) {
        m.description = ann.byModule.get(m.name);
      }
    } catch (e) {
      llmError = e instanceof Error ? e.message : String(e);
    }
  }

  const architecture: Architecture = {
    generatedAt: new Date().toISOString(),
    model: client?.model,
    overview,
    modules: graph.modules,
    edges: graph.edges,
    tree: renderTree(files, graph.modules, graph.edges),
  };
  store.saveArchitecture(architecture);
  return { architecture, llmError };
}
