import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import { parse } from "../src/elm-ast/bridge";
import { ELM_PKG_UNIVERSE } from "./helpers";

const SRC_DIR = path.join(ELM_PKG_UNIVERSE, "src");

function getAllElmFiles(dir: string): string[] {
  const results: string[] = [];
  for (const match of new Glob("**/*.elm").scanSync({ cwd: dir, absolute: true })) {
    results.push(match);
  }
  return results;
}

describe("performance: elm-package-universe", () => {
  let elmFiles: string[];

  test("finds Elm files in src/", () => {
    elmFiles = getAllElmFiles(SRC_DIR);
    console.log(`  Found ${elmFiles.length} .elm files in src/`);
    expect(elmFiles.length).toBeGreaterThan(10);
  });

  test("parses the 10 largest files sequentially", async () => {
    const withSizes = elmFiles.map((f) => ({
      path: f,
      size: fs.statSync(f).size,
    }));
    withSizes.sort((a, b) => b.size - a.size);
    const largest = withSizes.slice(0, 10);

    console.log("  Largest files:");
    for (const f of largest) {
      console.log(`    ${path.basename(f.path)}: ${(f.size / 1024).toFixed(1)}KB`);
    }

    const start = performance.now();
    let successCount = 0;

    for (const f of largest) {
      const source = fs.readFileSync(f.path, "utf-8");
      const ast = await parse(source);
      if (ast) {
        successCount++;
      } else {
        console.log(`    FAILED to parse: ${path.basename(f.path)}`);
      }
    }

    const elapsed = performance.now() - start;
    console.log(`  Parsed ${successCount}/${largest.length} files in ${elapsed.toFixed(0)}ms`);
    console.log(`  Average: ${(elapsed / largest.length).toFixed(0)}ms per file`);

    expect(successCount).toBeGreaterThan(0);
    expect(elapsed / largest.length).toBeLessThan(2000);
  }, 30000);

  test("batch parses 50 files for throughput measurement", async () => {
    const sample = elmFiles.slice(0, 50);
    const start = performance.now();
    let successCount = 0;

    for (const f of sample) {
      const source = fs.readFileSync(f, "utf-8");
      const ast = await parse(source);
      if (ast) successCount++;
    }

    const elapsed = performance.now() - start;
    const rate = (successCount / elapsed) * 1000;
    console.log(`  Parsed ${successCount}/${sample.length} files in ${elapsed.toFixed(0)}ms`);
    console.log(`  Throughput: ${rate.toFixed(1)} files/sec`);

    expect(successCount).toBeGreaterThanOrEqual(sample.length * 0.5);
  }, 60000);

  test("AST sizes are reasonable", async () => {
    const complexFile = elmFiles.find((f) => path.basename(f).length > 5) ?? elmFiles[0]!;
    const source = fs.readFileSync(complexFile, "utf-8");
    const ast = await parse(source);

    expect(ast).not.toBeUndefined();
    if (ast) {
      console.log(`  ${path.basename(complexFile)}:`);
      console.log(`    Declarations: ${ast.declarations.length}`);
      console.log(`    Imports: ${ast.imports.length}`);
      console.log(`    Comments: ${ast.comments.length}`);
      expect(ast.declarations.length).toBeGreaterThan(0);
    }
  });
});
