import { describe, test, expect } from "bun:test";
import { parse } from "../src/elm-ast/bridge";
import {
  toModuleName,
  toDeclarationName,
  findDeclarationWithName,
  findCustomTypeVariantWithName,
  isExposedFromModule,
  patternDefinitionNames,
  createImportTracker,
} from "../src/elm-ast/types";

describe("AST parser", () => {
  test("parses a simple module", async () => {
    const ast = await parse("module Foo exposing (bar)\n\nbar = 42\n");
    expect(ast).not.toBeUndefined();
    expect(toModuleName(ast!)).toBe("Foo");
    expect(ast!.declarations.length).toBe(1);
  });

  test("returns undefined for invalid Elm", async () => {
    const ast = await parse("this is not elm at all {{{{");
    expect(ast).toBeUndefined();
  });

  test("parses module with imports", async () => {
    const ast = await parse(
      "module App exposing (main)\n\nimport Html exposing (div, text)\nimport Json.Decode as D\n\nmain = div [] []\n"
    );
    expect(ast).not.toBeUndefined();
    expect(ast!.imports.length).toBe(2);
    expect(ast!.imports[0]!.value.moduleName.value).toEqual(["Html"]);
    expect(ast!.imports[1]!.value.moduleName.value).toEqual(["Json", "Decode"]);
    expect(ast!.imports[1]!.value.moduleAlias!.value).toEqual(["D"]);
  });

  test("parses type declarations", async () => {
    const ast = await parse(
      "module T exposing (..)\n\ntype Msg = Click | Hover String\n\ntype alias Model = { count : Int }\n"
    );
    expect(ast).not.toBeUndefined();
    expect(ast!.declarations.length).toBe(2);

    const typeDecl = ast!.declarations[0]!.value;
    expect(typeDecl.type).toBe("typedecl");
    if (typeDecl.type === "typedecl") {
      expect(typeDecl.typedecl.name.value).toBe("Msg");
      expect(typeDecl.typedecl.constructors.length).toBe(2);
      expect(typeDecl.typedecl.constructors[0]!.value.name.value).toBe("Click");
      expect(typeDecl.typedecl.constructors[1]!.value.name.value).toBe("Hover");
    }

    const aliasDecl = ast!.declarations[1]!.value;
    expect(aliasDecl.type).toBe("typeAlias");
    if (aliasDecl.type === "typeAlias") {
      expect(aliasDecl.typeAlias.name.value).toBe("Model");
    }
  });

  test("parses port declarations", async () => {
    const ast = await parse(
      "port module P exposing (log)\n\nport log : String -> Cmd msg\n"
    );
    expect(ast).not.toBeUndefined();
    const decl = ast!.declarations[0]!.value;
    expect(decl.type).toBe("port");
    if (decl.type === "port") {
      expect(decl.port.name.value).toBe("log");
    }
  });

  test("parses function with let expression", async () => {
    const ast = await parse(
      "module F exposing (f)\n\nf x =\n    let\n        y = x + 1\n    in\n    y * 2\n"
    );
    expect(ast).not.toBeUndefined();
    const decl = ast!.declarations[0]!.value;
    expect(decl.type).toBe("function");
    if (decl.type === "function") {
      const expr = decl.function.declaration.value.expression.value;
      expect(expr.type).toBe("let");
    }
  });

  test("sequential parses work (queue)", async () => {
    const results = await Promise.all([
      parse("module A exposing (a)\n\na = 1\n"),
      parse("module B exposing (b)\n\nb = 2\n"),
      parse("module C exposing (c)\n\nc = 3\n"),
    ]);
    // At least the last one should succeed (queue drops intermediates)
    const successful = results.filter((r) => r !== undefined);
    expect(successful.length).toBeGreaterThanOrEqual(1);
    // Last one always completes
    expect(results[2]).not.toBeUndefined();
  });
});

describe("AST helpers", () => {
  test("toDeclarationName extracts names", async () => {
    const ast = await parse(
      "module M exposing (..)\n\nfoo = 1\n\ntype Bar = Baz\n\ntype alias Qux = Int\n"
    );
    expect(ast).not.toBeUndefined();
    const names = ast!.declarations.map((d) => toDeclarationName(d.value));
    expect(names).toEqual(["foo", "Bar", "Qux"]);
  });

  test("findDeclarationWithName finds existing", async () => {
    const ast = await parse("module M exposing (..)\n\nfoo = 1\n\nbar = 2\n");
    expect(findDeclarationWithName(ast!, "bar")).not.toBeUndefined();
    expect(findDeclarationWithName(ast!, "baz")).toBeUndefined();
  });

  test("findCustomTypeVariantWithName finds constructors", async () => {
    const ast = await parse("module M exposing (..)\n\ntype Color = Red | Green | Blue\n");
    const result = findCustomTypeVariantWithName(ast!, "Green");
    expect(result).not.toBeUndefined();
    expect(result!.constructor.value.name.value).toBe("Green");
    expect(findCustomTypeVariantWithName(ast!, "Yellow")).toBeUndefined();
  });

  test("isExposedFromModule checks exposing list", async () => {
    const ast = await parse("module M exposing (foo, Bar)\n\nfoo = 1\n\ntype Bar = B\n\nbaz = 2\n");
    expect(isExposedFromModule(ast!, "foo")).toBe(true);
    expect(isExposedFromModule(ast!, "Bar")).toBe(true);
    expect(isExposedFromModule(ast!, "baz")).toBe(false);
  });

  test("isExposedFromModule handles exposing all", async () => {
    const ast = await parse("module M exposing (..)\n\nfoo = 1\n");
    expect(isExposedFromModule(ast!, "anything")).toBe(true);
  });

  test("createImportTracker builds maps", async () => {
    const ast = await parse(
      "module M exposing (..)\n\nimport Html exposing (div, text)\nimport Json.Decode as D\nimport List exposing (..)\n\nx = 1\n"
    );
    expect(ast).not.toBeUndefined();
    const tracker = createImportTracker(ast!);

    expect(tracker.explicitExposing.get("div")).toContain("Html");
    expect(tracker.explicitExposing.get("text")).toContain("Html");
    expect(tracker.aliasMapping.get("D")).toContain("Json.Decode");
    expect(tracker.unknownImports).toContain("List");
    // Prelude
    expect(tracker.unknownImports).toContain("Basics");
    expect(tracker.explicitExposing.get("Just")).toContain("Maybe");
  });
});
