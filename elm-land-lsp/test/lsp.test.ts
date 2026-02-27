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
      position: { line: 0, character: 0 }, // "module" keyword
    });

    expect(result).toBeNull();
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
