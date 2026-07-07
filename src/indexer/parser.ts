import * as path from 'path';
import * as fs from 'fs';
import { Parser, Language, Tree } from 'web-tree-sitter';
import { LanguageSpec, specForFile } from './languages';

/**
 * Manages web-tree-sitter initialization and lazy-loading of per-language grammars.
 * grammarsDir points to the directory containing tree-sitter.wasm and each tree-sitter-<lang>.wasm.
 */
export class ParserPool {
  private languages = new Map<string, Language>();
  private parser: Parser | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(private readonly grammarsDir: string) {}

  private init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Parser.init({
        locateFile: (name: string) => path.join(this.grammarsDir, name),
      }).then(() => {
        this.parser = new Parser();
      });
    }
    return this.initPromise;
  }

  private async loadLanguage(spec: LanguageSpec): Promise<Language | undefined> {
    await this.init();
    const cached = this.languages.get(spec.id);
    if (cached) {
      return cached;
    }
    const wasmPath = path.join(this.grammarsDir, spec.wasm);
    if (!fs.existsSync(wasmPath)) {
      return undefined;
    }
    const lang = await Language.load(wasmPath);
    this.languages.set(spec.id, lang);
    return lang;
  }

  /** Parse file content. Returns undefined for unsupported languages. Remember to call tree.delete() when done. */
  async parse(filePath: string, content: string): Promise<{ tree: Tree; spec: LanguageSpec } | undefined> {
    const spec = specForFile(filePath);
    if (!spec) {
      return undefined;
    }
    const lang = await this.loadLanguage(spec);
    if (!lang || !this.parser) {
      return undefined;
    }
    this.parser.setLanguage(lang);
    const tree = this.parser.parse(content);
    if (!tree) {
      return undefined;
    }
    return { tree, spec };
  }
}
