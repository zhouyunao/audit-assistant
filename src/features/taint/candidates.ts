import { CallSite, Mark, SymbolInfo } from '../../types';
import { enclosingSymbol } from '../../indexer/callGraph';
import { TaintRule } from './rules';
import { markId } from './marks';

export interface ScanFileInput {
  file: string;
  languageId: string;
  lines: string[];
  calls: CallSite[];
  symbols: SymbolInfo[];
}

export interface CompiledRules {
  byCallName: Map<string, TaintRule[]>;
  textRules: { rule: TaintRule; re: RegExp }[];
}

export function compileRules(rules: TaintRule[]): CompiledRules {
  const byCallName = new Map<string, TaintRule[]>();
  const textRules: { rule: TaintRule; re: RegExp }[] = [];
  for (const rule of rules) {
    for (const name of rule.callNames ?? []) {
      (byCallName.get(name) ?? byCallName.set(name, []).get(name)!).push(rule);
    }
    for (const pattern of rule.textPatterns ?? []) {
      try {
        textRules.push({ rule, re: new RegExp(pattern) });
      } catch {
        // 跳过非法正则，不影响其余规则
      }
    }
  }
  return { byCallName, textRules };
}

const langAllowed = (rule: TaintRule, lang: string) => !rule.languages || rule.languages.includes(lang);

/**
 * 扫描单个文件，产出候选标记（status=candidate, origin=scan）。
 * 每个 (kind, line) 只保留一个候选：调用点匹配优先于文本匹配。
 */
export function scanFile(input: ScanFileInput, compiled: CompiledRules, now: string): Mark[] {
  const byKey = new Map<string, Mark>();

  const emit = (kind: 'source' | 'sink', line0: number, rule: TaintRule, anchor: string) => {
    const key = `${kind}:${line0}`;
    if (byKey.has(key)) {
      return;
    }
    const sym = enclosingSymbol(input.symbols, line0);
    byKey.set(key, {
      id: markId(kind, input.file, line0 + 1),
      kind,
      status: 'candidate',
      origin: 'scan',
      file: input.file,
      symbol: sym?.name,
      line: line0 + 1,
      anchor,
      category: rule.category,
      cwe: rule.cwe,
      ruleId: rule.id,
      author: '',
      time: now,
    });
  };

  // 调用点匹配（更精确，先处理）
  for (const call of input.calls) {
    const rules = compiled.byCallName.get(call.callee);
    if (!rules) {
      continue;
    }
    for (const rule of rules) {
      if (langAllowed(rule, input.languageId)) {
        emit(rule.kind, call.line, rule, call.callee + '()');
        break;
      }
    }
  }

  // 文本匹配（补充非调用形式的 source/sink）
  for (let i = 0; i < input.lines.length; i++) {
    const text = input.lines[i];
    for (const { rule, re } of compiled.textRules) {
      if (langAllowed(rule, input.languageId) && re.test(text)) {
        const m = re.exec(text);
        emit(rule.kind, i, rule, m ? m[0].trim().slice(0, 40) : rule.category);
      }
    }
  }

  return [...byKey.values()];
}

/**
 * 把新扫描的候选并入已有标记：
 *   - 已有同 id 标记（人工确认/排除/备注）保留，不被候选覆盖；
 *   - 上次扫描遗留、这次未再命中的候选（origin=scan 且 status=candidate）视为过期删除；
 *   - 人工标记（origin=manual）与已确认/排除的标记一律保留。
 */
export function mergeCandidates(existing: Mark[], candidates: Mark[]): Mark[] {
  const candidateIds = new Set(candidates.map((c) => c.id));
  const kept = existing.filter((m) => {
    if (m.origin === 'manual' || m.status !== 'candidate') {
      return true;
    }
    return candidateIds.has(m.id); // 仍被命中的旧候选保留（下面按 id 去重）
  });
  const keptIds = new Set(kept.map((m) => m.id));
  const added = candidates.filter((c) => !keptIds.has(c.id));
  return [...kept, ...added];
}
