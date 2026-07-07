import * as fs from 'fs';
import * as path from 'path';
import { FileIndex } from '../types';

// v3: FileIndex gained the `lines` field
const CACHE_VERSION = 3;

interface CacheFile {
  version: number;
  entries: FileIndex[];
}

/** Persistent index cache (stored in the extension's globalStorage, one file per workspace). */
export class IndexCache {
  constructor(readonly filePath: string) {}

  load(): FileIndex[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as CacheFile;
      if (data.version !== CACHE_VERSION || !Array.isArray(data.entries)) {
        return [];
      }
      return data.entries;
    } catch {
      return [];
    }
  }

  save(entries: FileIndex[]): void {
    const data: CacheFile = { version: CACHE_VERSION, entries };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf8');
  }
}
