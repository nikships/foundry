/**
 * Small JSON-file store with atomic writes. Everything user-facing in Foundry
 * is a document a user could open, diff, or hand to someone else, so nothing
 * here is opaque state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonStore<T> {
  private cached: T | null = null;

  constructor(
    private readonly path: string,
    private readonly fallback: () => T,
    /** Applied on read, so a file written by an older build still loads. */
    private readonly migrate: (raw: unknown) => T = (raw) => raw as T,
  ) {}

  get filePath(): string {
    return this.path;
  }

  read(): T {
    if (this.cached !== null) return this.cached;
    if (!existsSync(this.path)) {
      return this.write(this.fallback());
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      this.cached = this.migrate(raw);
      return this.cached;
    } catch {
      // A corrupt file must not brick the app: fall back and keep going.
      return this.write(this.fallback());
    }
  }

  write(value: T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, this.path);
    this.cached = value;
    return value;
  }

  update(fn: (current: T) => T): T {
    return this.write(fn(this.read()));
  }

  invalidate(): void {
    this.cached = null;
  }
}
