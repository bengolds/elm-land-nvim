import type { Ast } from "../elm-ast/types";

type CacheEntry = {
  uri: string;
  version: number;
  ast: Ast;
};

const MAX_SIZE = 50;
const entries: CacheEntry[] = [];

export function getCachedAst(uri: string, version: number): Ast | undefined {
  const entry = entries.find((e) => e.uri === uri && e.version === version);
  if (entry) {
    // Move to end (most recently used)
    const idx = entries.indexOf(entry);
    entries.splice(idx, 1);
    entries.push(entry);
    return entry.ast;
  }
  return undefined;
}

export function setCachedAst(uri: string, version: number, ast: Ast): void {
  // Remove existing entry for this uri if present
  const idx = entries.findIndex((e) => e.uri === uri);
  if (idx !== -1) entries.splice(idx, 1);

  entries.push({ uri, version, ast });

  if (entries.length > MAX_SIZE) {
    entries.shift();
  }
}
