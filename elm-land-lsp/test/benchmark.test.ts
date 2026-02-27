import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import { parse } from "../src/elm-ast/bridge";
import { getWorkspaceSymbols } from "../src/features/workspace-symbol";
import { getDocumentSymbols } from "../src/features/document-symbol";
import { getDefinition } from "../src/features/definition";
import { getCompletions } from "../src/features/completion";
import { getHover } from "../src/features/hover";
import { documentStore } from "../src/state/document-store";
import { findElmJsonFor, pathToUri, uriToPath } from "../src/project/elm-json";
import { NOREDINK_UI } from "./helpers";

const SRC_DIR = path.join(NOREDINK_UI, "src");
const CATALOG_DIR = path.join(NOREDINK_UI, "component-catalog");

function getAllElmFiles(dir: string): string[] {
  const results: string[] = [];
  for (const match of new Glob("**/*.elm").scanSync({ cwd: dir, absolute: true })) {
    results.push(match);
  }
  return results;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function stats(times: number[]): { p50: number; p95: number; p99: number; mean: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    max: sorted[sorted.length - 1]!,
  };
}

function printStats(label: string, times: number[]) {
  const s = stats(times);
  console.log(
    `  ${label}: p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  p99=${s.p99.toFixed(1)}ms  mean=${s.mean.toFixed(1)}ms  max=${s.max.toFixed(1)}ms  (n=${times.length})`
  );
}

describe("benchmark: noredink-ui", () => {
  let elmFiles: string[];
  let largestFiles: { path: string; size: number }[];

  test("setup", () => {
    elmFiles = getAllElmFiles(SRC_DIR);
    largestFiles = elmFiles
      .map((f) => ({ path: f, size: fs.statSync(f).size }))
      .sort((a, b) => b.size - a.size);
    console.log(`  ${elmFiles.length} source files, largest: ${(largestFiles[0]!.size / 1024).toFixed(0)}KB`);
    expect(elmFiles.length).toBeGreaterThan(50);
  });

  test("AST parse latency (20 largest files)", async () => {
    const sample = largestFiles.slice(0, 20);
    const times: number[] = [];

    for (const f of sample) {
      const source = fs.readFileSync(f.path, "utf-8");
      const start = performance.now();
      await parse(source);
      times.push(performance.now() - start);
    }

    printStats("parse", times);
    expect(stats(times).p95).toBeLessThan(500);
  }, 30000);

  test("AST parse throughput (all files)", async () => {
    const times: number[] = [];
    let success = 0;

    for (const f of elmFiles) {
      const source = fs.readFileSync(f, "utf-8");
      const start = performance.now();
      const ast = await parse(source);
      times.push(performance.now() - start);
      if (ast) success++;
    }

    const total = times.reduce((a, b) => a + b, 0);
    console.log(`  Throughput: ${(success / total * 1000).toFixed(0)} files/sec  (${success}/${elmFiles.length} succeeded in ${total.toFixed(0)}ms)`);
    printStats("per-file", times);
    expect(success).toBeGreaterThan(elmFiles.length * 0.8);
  }, 60000);

  test("document symbols latency (10 files)", async () => {
    const sample = largestFiles.slice(0, 10);
    const times: number[] = [];

    for (const f of sample) {
      const source = fs.readFileSync(f.path, "utf-8");
      const uri = pathToUri(f.path);
      documentStore.open(uri, source, 1);

      const start = performance.now();
      await getDocumentSymbols(uri);
      times.push(performance.now() - start);

      documentStore.close(uri);
    }

    printStats("documentSymbol", times);
    expect(stats(times).p95).toBeLessThan(500);
  }, 30000);

  test("workspace symbol search latency", async () => {
    // Open a file so the server knows about the project
    const firstFile = elmFiles[0]!;
    const source = fs.readFileSync(firstFile, "utf-8");
    const uri = pathToUri(firstFile);
    documentStore.open(uri, source, 1);

    const queries = ["", "Button", "view", "Msg", "update", "init", "xyz"];
    const times: number[] = [];

    for (const q of queries) {
      const start = performance.now();
      await getWorkspaceSymbols(q, pathToUri(SRC_DIR));
      times.push(performance.now() - start);
    }

    printStats("workspaceSymbol", times);
    // First call cold, rest should be cached
    expect(stats(times).p50).toBeLessThan(200);

    documentStore.close(uri);
  }, 30000);

  test("completion latency (qualified access)", async () => {
    // Create a source that imports a local module, then triggers completion
    const sample = elmFiles.slice(0, 5);
    const times: number[] = [];

    for (const f of sample) {
      const realSource = fs.readFileSync(f, "utf-8");
      // Find an import and trigger completion after it
      const importMatch = realSource.match(/^import\s+([\w.]+)/m);
      if (!importMatch) continue;

      const modName = importMatch[1]!;
      const testSource = realSource + `\n\n__test__ = ${modName}.\n`;
      const uri = pathToUri(f) + ".completion-test";
      documentStore.open(uri, testSource, 1);

      const lines = testSource.split("\n");
      const lastLine = lines.length - 2;
      const col = `__test__ = ${modName}.`.length;

      const start = performance.now();
      await getCompletions(uri, { line: lastLine, character: col });
      times.push(performance.now() - start);

      documentStore.close(uri);
    }

    if (times.length > 0) {
      printStats("completion", times);
      expect(stats(times).p95).toBeLessThan(2000);
    }
  }, 30000);

  test("hover latency (import references)", async () => {
    const sample = largestFiles.slice(0, 5);
    const times: number[] = [];

    for (const f of sample) {
      const source = fs.readFileSync(f.path, "utf-8");
      const uri = pathToUri(f.path);
      documentStore.open(uri, source, 1);

      // Find an import with exposing list and hover on first exposed name
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i]!.match(/^import\s+[\w.]+\s+exposing\s+\((\w+)/);
        if (match) {
          const col = lines[i]!.indexOf(match[1]!);
          const start = performance.now();
          await getHover(uri, { line: i, character: col });
          times.push(performance.now() - start);
          break;
        }
      }

      documentStore.close(uri);
    }

    if (times.length > 0) {
      printStats("hover", times);
      expect(stats(times).p95).toBeLessThan(2000);
    }
  }, 30000);

  test("definition latency (import resolution)", async () => {
    const sample = largestFiles.slice(0, 5);
    const times: number[] = [];

    for (const f of sample) {
      const source = fs.readFileSync(f.path, "utf-8");
      const uri = pathToUri(f.path);
      documentStore.open(uri, source, 1);

      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i]!.match(/^import\s+([\w.]+)/);
        if (match) {
          const col = lines[i]!.indexOf(match[1]!) + 1;
          const start = performance.now();
          await getDefinition(uri, { line: i, character: col });
          times.push(performance.now() - start);
          break;
        }
      }

      documentStore.close(uri);
    }

    if (times.length > 0) {
      printStats("definition", times);
      expect(stats(times).p95).toBeLessThan(1000);
    }
  }, 30000);
});
