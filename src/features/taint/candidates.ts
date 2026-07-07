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
        // Skip invalid regex without affecting other rules
      }
    }
  }
  return { byCallName, textRules };
}

const langAllowed = (rule: TaintRule, lang: string) => !rule.languages || rule.languages.includes(lang);

/**
 * Scan a single file and produce candidate marks (status=candidate, origin=scan).
 * At most one candidate per (kind, line): call-site matches take priority over text matches.
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

  // Call-site matches (more precise, processed first)
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

  // Text matches (cover non-call forms of source/sink)
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
 * Merge newly scanned candidates into existing marks:
 *   - existing marks with the same id (user confirmed/excluded/noted) are kept, not overwritten by candidates;
 *   - candidates left from a previous scan that are no longer matched (origin=scan and status=candidate) are dropped as stale;
 *   - manual marks (origin=manual) and any confirmed/excluded marks are always kept.
 */
export function mergeCandidates(existing: Mark[], candidates: Mark[]): Mark[] {
  const candidateIds = new Set(candidates.map((c) => c.id));
  const kept = existing.filter((m) => {
    if (m.origin === 'manual' || m.status !== 'candidate') {
      return true;
    }
    return candidateIds.has(m.id); // keep still-matched old candidates (deduped by id below)
  });
  const keptIds = new Set(kept.map((m) => m.id));
  const added = candidates.filter((c) => !keptIds.has(c.id));
  return [...kept, ...added];
}
