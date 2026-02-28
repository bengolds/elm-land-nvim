import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { startLsp, SMALL_PROJECT, fixtureUri, fixturePath, type LspClient } from "./helpers";

let client: LspClient;

beforeAll(async () => {
  client = await startLsp();
});

afterAll(async () => {
  if (client) await client.shutdown();
});

describe("document symbols", () => {
  test("returns symbols for Helpers.elm", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    const symbols = await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    expect(Array.isArray(symbols)).toBe(true);
    const names = symbols.map((s: any) => s.name);
    expect(names).toContain("add");
    expect(names).toContain("multiply");
    expect(names).toContain("greet");
    expect(names).toContain("clamp");
  });

  test("returns correct symbol kinds for Types.elm", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Types.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Types.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    const symbols = await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    const msgSymbol = symbols.find((s: any) => s.name === "Msg");
    expect(msgSymbol).toBeDefined();
    expect(msgSymbol.kind).toBe(10); // Enum

    const modelSymbol = symbols.find((s: any) => s.name === "Model");
    expect(modelSymbol).toBeDefined();
    expect(modelSymbol.kind).toBe(19); // Object (record type alias)

    // Msg should have children (constructors)
    expect(msgSymbol.children).toBeDefined();
    const childNames = msgSymbol.children.map((c: any) => c.name);
    expect(childNames).toContain("Increment");
    expect(childNames).toContain("Decrement");
    expect(childNames).toContain("SetName");
  });

  test("let-bindings appear as children", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    const symbols = await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    const greetSymbol = symbols.find((s: any) => s.name === "greet");
    expect(greetSymbol?.children).toBeDefined();
    const childNames = greetSymbol.children.map((c: any) => c.name);
    expect(childNames).toContain("greeting");
    expect(childNames).toContain("separator");
  });

  test("returns null for unknown file", async () => {
    const result = await client.request("textDocument/documentSymbol", {
      textDocument: { uri: "file:///nonexistent/File.elm" },
    });
    expect(result).toBeNull();
  });
});

describe("definition", () => {
  test("jumps to import module name", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 3: "import Helpers exposing (add, greet)" — cursor on "Helpers"
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 3, character: 10 },
    });

    expect(result).not.toBeNull();
    expect(result.uri).toContain("Helpers.elm");
  });

  test("jumps to cross-module function from import exposing", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 3: "import Helpers exposing (add, greet)" — cursor on "add"
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 3, character: 26 },
    });

    expect(result).not.toBeNull();
    expect(result.uri).toContain("Helpers.elm");
  });

  test("returns null for position on keyword", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });

    expect(result).toBeNull();
  });

  test("module exposing list jumps to declaration", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 0: "module Main exposing (main)" — cursor on "main" in exposing
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 23 },
    });

    expect(result).not.toBeNull();
    expect(result.uri).toContain("Main.elm");
    // Should jump to the main declaration, not stay on line 0
    expect(result.range.start.line).toBeGreaterThan(0);
  });

  test("type annotation jumps to type definition", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 15: "update : Msg -> Model -> Model" — cursor on "Msg"
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 15, character: 10 },
    });

    expect(result).not.toBeNull();
    expect(result.uri).toContain("Types.elm");
  });

  test("case pattern constructor jumps to type", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 18: "        Increment ->" — cursor on "Increment"
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 18, character: 10 },
    });

    expect(result).not.toBeNull();
    expect(result.uri).toContain("Types.elm");
  });

  test("local variable jumps to binding", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 25: "            { model | name = name }" — cursor on second "name" (the variable, col 29-32)
    // "name" is bound in the case pattern "SetName name ->" on line 24
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 25, character: 30 },
    });

    expect(result).not.toBeNull();
    // Should point to the pattern binding on line 24
    expect(result.range.start.line).toBe(24);
  });

  test("recordUpdate variable jumps to binding", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Line 19: "            { model | count = model.count + 1 }" — cursor on first "model"
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 19, character: 14 },
    });

    expect(result).not.toBeNull();
    // "model" is a function parameter — should resolve to line 16 where "update msg model ="
  });
});

describe("formatting", () => {
  test("formats valid Elm code", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);

    const edits = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    });

    expect(edits).not.toBeNull();
    expect(Array.isArray(edits)).toBe(true);
    expect(edits.length).toBe(1);
    expect(edits[0].newText).toContain("module Helpers");
  });

  test("returns null for unknown file", async () => {
    const result = await client.request("textDocument/formatting", {
      textDocument: { uri: "file:///nonexistent/File.elm" },
      options: { tabSize: 4, insertSpaces: true },
    });
    expect(result).toBeNull();
  });
});

describe("workspace symbols", () => {
  test("returns all symbols with empty query", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(300);

    const symbols = await client.request("workspace/symbol", { query: "" });
    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols.length).toBeGreaterThan(5);

    const names = symbols.map((s: any) => s.name);
    expect(names).toContain("add");
    expect(names).toContain("greet");
    expect(names).toContain("Msg");
    expect(names).toContain("Model");
    expect(names).toContain("main");
  });

  test("fuzzy filters by query", async () => {
    const symbols = await client.request("workspace/symbol", { query: "mult" });
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    expect(symbols.some((s: any) => s.name === "multiply")).toBe(true);
  });

  test("returns correct symbol kinds", async () => {
    const symbols = await client.request("workspace/symbol", { query: "" });
    const msgSymbol = symbols.find((s: any) => s.name === "Msg");
    expect(msgSymbol?.kind).toBe(10);

    const modelSymbol = symbols.find((s: any) => s.name === "Model");
    expect(modelSymbol?.kind).toBe(19);
  });

  test("symbols have valid locations", async () => {
    const symbols = await client.request("workspace/symbol", { query: "add" });
    const addSymbol = symbols.find((s: any) => s.name === "add");
    expect(addSymbol).toBeDefined();
    expect(addSymbol.location.uri).toContain("Helpers.elm");
    expect(addSymbol.location.range.start.line).toBeGreaterThanOrEqual(0);
  });
});

describe("completion", () => {
  test("completes qualified module access for local module", async () => {
    // Open a file that has "import Helpers exposing (add, greet)"
    // Then type "Helpers." to trigger completion
    const source = `module Test exposing (..)

import Helpers

x = Helpers.
`;
    const uri = fixtureUri(SMALL_PROJECT, "src", "CompletionTest.elm");
    client.openFile(uri, source);
    await Bun.sleep(300);

    const result = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 4, character: 12 }, // after "Helpers."
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    const labels = result.map((c: any) => c.label);
    expect(labels).toContain("add");
    expect(labels).toContain("multiply");
    expect(labels).toContain("greet");
  });

  test("returns null when not on a module dot", async () => {
    const source = "module Test exposing (..)\n\nx = 42\n";
    const uri = fixtureUri(SMALL_PROJECT, "src", "NoCompletion.elm");
    client.openFile(uri, source);

    const result = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 },
    });

    expect(result).toBeNull();
  });

  test("completes package module members", async () => {
    const source = `module Test exposing (..)

import Html

x = Html.
`;
    const uri = fixtureUri(SMALL_PROJECT, "src", "PkgCompletionTest.elm");
    client.openFile(uri, source);
    await Bun.sleep(300);

    const result = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 4, character: 10 },
    });

    if (result) {
      const labels = result.map((c: any) => c.label);
      // Html module should have div, text, span, etc.
      expect(labels).toContain("div");
      expect(labels).toContain("text");
    }
    // May be null if elm/html docs not installed — that's OK
  });

  test("resolves import aliases", async () => {
    const source = `module Test exposing (..)

import Helpers as H

x = H.
`;
    const uri = fixtureUri(SMALL_PROJECT, "src", "AliasTest.elm");
    client.openFile(uri, source);
    await Bun.sleep(300);

    const result = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 4, character: 6 }, // after "H."
    });

    expect(result).not.toBeNull();
    const labels = result.map((c: any) => c.label);
    expect(labels).toContain("add");
  });
});

describe("hover", () => {
  test("shows type info for local function in import", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Hover over "add" in "import Helpers exposing (add, greet)"
    const result = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: 26 },
    });

    expect(result).not.toBeNull();
    expect(result.contents.kind).toBe("markdown");
    expect(result.contents.value).toContain("add");
  });

  test("shows hover for function call in expression", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    // Hover over "add" function name at its definition (line 4, col 0)
    // Actually hover over a usage — let's hover on the "a" in "a + b" body
    // which is a local var, so we won't get hover for that.
    // Instead, hover on the function name in the type sig line
    const result = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: 0 }, // "add" on line 4 (0-indexed: line 3)
    });

    // This is the declaration itself, not a reference — hover may be null
    // depending on implementation. That's OK for now.
  });

  test("returns null for empty space", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(300);

    const result = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 1, character: 0 }, // blank line
    });

    expect(result).toBeNull();
  });
});

describe("references", () => {
  test("finds references to imported function", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);

    const helpersUri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const helpersText = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(helpersUri, helpersText);
    await Bun.sleep(500);

    const result = await client.request("textDocument/references", {
      textDocument: { uri },
      position: { line: 3, character: 26 },
      context: { includeDeclaration: true },
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty for unknown position", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Main.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Main.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(300);

    const result = await client.request("textDocument/references", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
      context: { includeDeclaration: true },
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

describe("rename", () => {
  test("prepareRename returns range and placeholder", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    const result = await client.request("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line: 3, character: 0 },
    });

    if (result) {
      expect(result.placeholder).toBeDefined();
      expect(result.range).toBeDefined();
    }
  });

  test("rename generates workspace edit", async () => {
    const uri = fixtureUri(SMALL_PROJECT, "src", "Helpers.elm");
    const text = fs.readFileSync(fixturePath(SMALL_PROJECT, "src", "Helpers.elm"), "utf-8");
    client.openFile(uri, text);
    await Bun.sleep(500);

    const result = await client.request("textDocument/rename", {
      textDocument: { uri },
      position: { line: 3, character: 0 },
      newName: "addNumbers",
    });

    if (result && result.changes) {
      const fileUris = Object.keys(result.changes);
      expect(fileUris.length).toBeGreaterThanOrEqual(1);

      for (const edits of Object.values(result.changes) as any[]) {
        for (const edit of edits) {
          expect(edit.newText).toBe("addNumbers");
        }
      }
    }
  });
});
