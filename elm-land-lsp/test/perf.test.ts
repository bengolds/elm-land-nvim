import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import { parse } from "../src/elm-ast/bridge";
import { NOREDINK_UI } from "./helpers";

const SRC_DIR = path.join(NOREDINK_UI, "src");

function getAllElmFiles(dir: string): string[] {
  const results: string[] = [];
  const glob = new Glob("**/*.elm");
  for (const match of glob.scanSync({ cwd: dir, absolute: true })) {
    results.push(match);
  }
  return results;
}

describe("performance: noredink-ui (230 files, 88K LOC)", () => {
  let elmFiles: string[];

  test("finds all Elm files", () => {
    elmFiles = getAllElmFiles(SRC_DIR);
    console.log(`  Found ${elmFiles.length} .elm files`);
    expect(elmFiles.length).toBeGreaterThan(50);
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
    let failCount = 0;

    for (const f of largest) {
      const source = fs.readFileSync(f.path, "utf-8");
      const ast = await parse(source);
      if (ast) {
        successCount++;
      } else {
        failCount++;
        console.log(`    FAILED to parse: ${path.basename(f.path)}`);
      }
    }

    const elapsed = performance.now() - start;
    console.log(`  Parsed ${successCount}/${largest.length} files in ${elapsed.toFixed(0)}ms`);
    console.log(`  Average: ${(elapsed / largest.length).toFixed(0)}ms per file`);

    expect(successCount).toBeGreaterThan(0);
    // P95 single file parse should be under 2s
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

    expect(successCount).toBeGreaterThanOrEqual(sample.length * 0.8); // 80% success rate minimum
  }, 60000);

  test("AST sizes are reasonable", async () => {
    // Parse a complex file and check the AST isn't pathologically large
    const complexFile = elmFiles.find((f) => f.includes("Button")) ?? elmFiles[0]!;
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
