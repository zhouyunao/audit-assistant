import { ProjectIndex } from '../indexer/indexer';
import { resolveImport } from '../indexer/imports';
import { LlmProvider } from '../llm/client';
import { AuditStore } from '../store/auditStore';
import { Architecture, ArchEdge, ArchModule, FileIndex } from '../types';

const MAX_MODULES = 24;
const OTHER = '(other)';

/**
 * File-level dependency edges: import resolution + cross-file calls (name-matched; only count an
 * edge when there are <=3 definitions, to reduce noise).
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
 * Module assignment: default to the top-level directory; if one top-level directory (e.g. src/)
 * holds more than half the files and has subdirectories, drill one level deeper for a more
 * informative graph.
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

  // module -> files (pick representative files by symbol count)
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
  /** Relative path (/ separated), root is '' */
  path: string;
  fileCount: number;
  loc: number;
  children: Map<string, DirNode>;
}

/** Tree rendering only needs the path and line count */
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
 * Annotated plain-text directory tree: module-level directories get a responsibility description and dependency targets.
 */
export function renderTree(files: TreeFile[], modules: ArchModule[], edges: ArchEdge[], maxDepth = MAX_TREE_DEPTH): string {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    (deps.get(e.from) ?? deps.set(e.from, []).get(e.from)!).push(e.to);
  }

  const annotate = (node: DirNode): string => {
    let line = `${node.name}/ (${node.fileCount} files, ${node.loc.toLocaleString('en-US')} LOC)`;
    const mod = byName.get(node.path);
    if (mod?.description) {
      line += ` — ${mod.description}`;
    }
    const d = deps.get(node.path);
    if (d?.length) {
      line += `  [depends on: ${d.slice(0, 4).join(', ')}]`;
    }
    return line;
  };

  const root = buildDirTree(files);
  let rootLine = `./ (${root.fileCount} files, ${root.loc.toLocaleString('en-US')} LOC total)`;
  const rootMod = byName.get('(root)');
  if (rootMod?.description) {
    rootLine += ` — root files: ${rootMod.description}`;
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
      lines.push(`${prefix}└── … ${children.length - MAX_CHILDREN_SHOWN} more directories`);
    }
  };
  walk(root, '', 1);
  return lines.join('\n');
}

interface RawAnnotation {
  overview?: string;
  modules?: Array<{ name?: string; description?: string }>;
}

/** Use the LLM to annotate each module with a one-line responsibility. On failure/no-config it's silently skipped and the tree still works. */
async function annotate(
  graph: ModuleGraph,
  files: FileIndex[],
  store: AuditStore,
  client: LlmProvider,
  outputLanguage: string,
): Promise<{ overview?: string; byModule: Map<string, string> }> {
  const lang = outputLanguage === 'zh' ? 'Simplified Chinese' : outputLanguage === 'ja' ? 'Japanese' : 'English';
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
        `Module ${m.name} (${m.fileCount} files, ${m.loc} LOC)`,
        `  representative files: ${m.sampleFiles.slice(0, 5).join(', ')}`,
        symbolNames.length ? `  main symbols: ${symbolNames.join(', ')}` : '',
        ...summaries.map((s) => `  existing file summary: ${s}`),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const raw = await client.completeJson<RawAnnotation>(
    [
      'You are a senior code auditor. Infer each module\'s responsibility from its file names and symbol names, and output JSON:',
      '{"overview": "what the project does overall, 2-3 sentences", "modules": [{"name": "module name", "description": "the module\'s responsibility in one line"}]}',
      `Write prose in ${lang}. Module names must match the input exactly. Omit modules you are unsure about.`,
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
  client: LlmProvider | undefined,
  opts: GenerateOptions,
): Promise<{ architecture: Architecture; llmError?: string }> {
  const files = index.allFiles();
  opts.onProgress?.('Aggregating dependencies…');
  const graph = buildModuleGraph(files, index);

  let overview: string | undefined;
  let llmError: string | undefined;
  if (client) {
    opts.onProgress?.('LLM annotating module responsibilities…');
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
