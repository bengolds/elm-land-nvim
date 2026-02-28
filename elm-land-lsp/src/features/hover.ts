import * as fs from "fs/promises";
import { documentStore } from "../state/document-store";
import { findElmJsonFor, uriToPath, loadDocs, type ModuleDoc } from "../project/elm-json";
import { resolveModuleToFile } from "../project/module-resolver";
import { parse } from "../elm-ast/bridge";
import { getCachedAst, setCachedAst } from "../state/ast-cache";
import {
  type Ast,
  type Node,
  type Declaration,
  type Expression,
  type Range as ElmRange,
  findDeclarationWithName,
  findCustomTypeVariantWithName,
  createImportTracker,
  isExposedFromModule,
  typeAnnotationToString,
} from "../elm-ast/types";
import type { Position, Range } from "../protocol/messages";

type HoverResult = {
  contents: { kind: "markdown"; value: string };
  range?: Range;
} | null;

function elmRangeToLsp(r: ElmRange): Range {
  return {
    start: { line: r[0] - 1, character: r[1] - 1 },
    end: { line: r[2] - 1, character: r[3] - 1 },
  };
}

function positionInRange(pos: Position, r: ElmRange): boolean {
  const line = pos.line + 1;
  const col = pos.character + 1;
  if (line < r[0] || line > r[2]) return false;
  if (line === r[0] && col < r[1]) return false;
  if (line === r[2] && col > r[3]) return false;
  return true;
}

function declHoverContent(decl: Declaration, moduleName?: string): string {
  const parts: string[] = [];

  if (decl.type === "function") {
    const name = decl.function.declaration.value.name.value;
    if (decl.function.signature) {
      const typeSig = typeAnnotationToString(decl.function.signature.value.typeAnnotation);
      parts.push("```elm\n" + name + " : " + typeSig + "\n```");
    } else {
      parts.push("```elm\n" + name + "\n```");
    }
    if (decl.function.documentation) {
      parts.push(decl.function.documentation.value);
    }
  } else if (decl.type === "typeAlias") {
    const typeSig = typeAnnotationToString(decl.typeAlias.typeAnnotation);
    parts.push("```elm\ntype alias " + decl.typeAlias.name.value + " =\n    " + typeSig + "\n```");
    if (decl.typeAlias.documentation) {
      parts.push(decl.typeAlias.documentation.value);
    }
  } else if (decl.type === "typedecl") {
    const ctors = decl.typedecl.constructors
      .map((c) => c.value.name.value + (c.value.arguments.length > 0 ? " " + c.value.arguments.map(typeAnnotationToString).join(" ") : ""))
      .join("\n    | ");
    parts.push("```elm\ntype " + decl.typedecl.name.value + "\n    = " + ctors + "\n```");
    if (decl.typedecl.documentation) {
      parts.push(decl.typedecl.documentation.value);
    }
  } else if (decl.type === "port") {
    const typeSig = typeAnnotationToString(decl.port.typeAnnotation);
    parts.push("```elm\nport " + decl.port.name.value + " : " + typeSig + "\n```");
  }

  if (moduleName) {
    parts.push("*" + moduleName + "*");
  }

  return parts.join("\n\n");
}

function docsHoverContent(
  name: string,
  docs: ModuleDoc[],
  moduleName: string
): string | null {
  const mod = docs.find((d) => d.name === moduleName);
  if (!mod) return null;

  const value = mod.values.find((v) => v.name === name);
  if (value) {
    const parts = ["```elm\n" + value.name + " : " + value.type + "\n```"];
    if (value.comment) parts.push(value.comment);
    parts.push("*" + moduleName + "*");
    return parts.join("\n\n");
  }

  const union = mod.unions.find((u) => u.name === name);
  if (union) {
    const parts = ["```elm\ntype " + union.name + "\n```"];
    if (union.comment) parts.push(union.comment);
    parts.push("*" + moduleName + "*");
    return parts.join("\n\n");
  }

  // Check constructors
  for (const u of mod.unions) {
    const ctor = u.cases.find(([cName]) => cName === name);
    if (ctor) {
      const args = ctor[1].length > 0 ? " " + ctor[1].join(" ") : "";
      const parts = ["```elm\n" + ctor[0] + args + "\n```"];
      parts.push("Constructor of `" + u.name + "`");
      parts.push("*" + moduleName + "*");
      return parts.join("\n\n");
    }
  }

  const alias = mod.aliases.find((a) => a.name === name);
  if (alias) {
    const parts = ["```elm\ntype alias " + alias.name + " = " + alias.type + "\n```"];
    if (alias.comment) parts.push(alias.comment);
    parts.push("*" + moduleName + "*");
    return parts.join("\n\n");
  }

  return null;
}

async function hoverFromModule(
  name: string,
  moduleName: string,
  elmJson: import("../project/elm-json").ElmJsonFile
): Promise<string | null> {
  // Check local files first
  const filePath = await resolveModuleToFile(moduleName, elmJson);
  if (filePath) {
    try {
      const source = await fs.readFile(filePath, "utf-8");
      const ast = await parse(source);
      if (ast) {
        if (isExposedFromModule(ast, name)) {
          const decl = findDeclarationWithName(ast, name);
          if (decl) return declHoverContent(decl.value, moduleName);

          const variant = findCustomTypeVariantWithName(ast, name);
          if (variant) return declHoverContent(variant.declaration.value, moduleName);
        }
      }
    } catch {}
  }

  // Check package docs
  for (const dep of elmJson.dependencies) {
    const docs = await loadDocs(dep);
    const content = docsHoverContent(name, docs, moduleName);
    if (content) return content;
  }

  return null;
}

export async function getHover(
  uri: string,
  position: Position
): Promise<HoverResult> {
  const doc = documentStore.get(uri);
  if (!doc) return null;

  const cached = getCachedAst(uri, doc.version);
  const ast = cached ?? (await parse(doc.text));
  if (!ast) return null;
  if (!cached) setCachedAst(uri, doc.version, ast);

  const filePath = uriToPath(uri);
  const elmJson = await findElmJsonFor(filePath);
  if (!elmJson) return null;

  // Check imports
  for (const imp of ast.imports) {
    if (imp.value.exposingList?.value.type === "explicit") {
      for (const exposed of imp.value.exposingList.value.explicit) {
        if (positionInRange(position, exposed.range)) {
          const moduleName = imp.value.moduleName.value.join(".");
          let name: string;
          const e = exposed.value;
          switch (e.type) {
            case "function": name = e.function.name; break;
            case "typeOrAlias": name = e.typeOrAlias.name; break;
            case "typeexpose": name = e.typeexpose.name; break;
            case "infix": name = e.infix.name; break;
          }
          const content = await hoverFromModule(name!, moduleName, elmJson);
          if (content) {
            return { contents: { kind: "markdown", value: content }, range: elmRangeToLsp(exposed.range) };
          }
        }
      }
    }
  }

  // Check declarations for functionOrValue under cursor
  const tracker = createImportTracker(ast);

  for (const decl of ast.declarations) {
    if (!positionInRange(position, decl.range)) continue;
    const result = await findHoverInExpression(
      uri, decl, position, ast, elmJson, tracker
    );
    if (result) return result;
  }

  return null;
}

async function findHoverInExpression(
  currentUri: string,
  decl: Node<Declaration>,
  position: Position,
  ast: Ast,
  elmJson: import("../project/elm-json").ElmJsonFile,
  tracker: import("../elm-ast/types").ImportTracker,
): Promise<HoverResult> {
  const d = decl.value;
  if (d.type !== "function") return null;

  const funcDecl = d.function.declaration.value;
  const expr = funcDecl.expression;
  return walkExprForHover(expr, position, ast, elmJson, tracker, currentUri);
}

async function walkExprForHover(
  expr: Node<Expression>,
  position: Position,
  ast: Ast,
  elmJson: import("../project/elm-json").ElmJsonFile,
  tracker: import("../elm-ast/types").ImportTracker,
  currentUri: string,
): Promise<HoverResult> {
  if (!expr?.value) return null;
  if (!positionInRange(position, expr.range)) return null;

  const e = expr.value;

  if (e.type === "functionOrValue") {
    const name = e.functionOrValue.name;
    const moduleParts = e.functionOrValue.moduleName;
    const range = elmRangeToLsp(expr.range);

    if (moduleParts.length > 0) {
      const qualifiedModule = moduleParts.join(".");
      const resolvedModules = tracker.aliasMapping.get(qualifiedModule) ?? [qualifiedModule];
      for (const modName of resolvedModules) {
        const content = await hoverFromModule(name, modName, elmJson);
        if (content) return { contents: { kind: "markdown", value: content }, range };
      }
      return null;
    }

    // Same-file declaration
    const localDecl = findDeclarationWithName(ast, name);
    if (localDecl) {
      return {
        contents: { kind: "markdown", value: declHoverContent(localDecl.value) },
        range,
      };
    }

    const localVariant = findCustomTypeVariantWithName(ast, name);
    if (localVariant) {
      return {
        contents: { kind: "markdown", value: declHoverContent(localVariant.declaration.value) },
        range,
      };
    }

    // Check imports
    const fromExplicit = tracker.explicitExposing.get(name);
    if (fromExplicit) {
      for (const modName of fromExplicit) {
        const content = await hoverFromModule(name, modName, elmJson);
        if (content) return { contents: { kind: "markdown", value: content }, range };
      }
    }

    for (const modName of tracker.unknownImports) {
      const content = await hoverFromModule(name, modName, elmJson);
      if (content) return { contents: { kind: "markdown", value: content }, range };
    }

    return null;
  }

  // Recurse into sub-expressions
  if (e.type === "application") {
    for (const arg of e.application) {
      const r = await walkExprForHover(arg, position, ast, elmJson, tracker, currentUri);
      if (r) return r;
    }
  } else if (e.type === "operatorapplication") {
    return (
      await walkExprForHover(e.operatorapplication.left, position, ast, elmJson, tracker, currentUri) ??
      await walkExprForHover(e.operatorapplication.right, position, ast, elmJson, tracker, currentUri)
    );
  } else if (e.type === "ifBlock") {
    return (
      await walkExprForHover(e.ifBlock.clause, position, ast, elmJson, tracker, currentUri) ??
      await walkExprForHover(e.ifBlock.then, position, ast, elmJson, tracker, currentUri) ??
      await walkExprForHover(e.ifBlock.else, position, ast, elmJson, tracker, currentUri)
    );
  } else if (e.type === "let") {
    for (const letDecl of e.let.declarations) {
      if (positionInRange(position, letDecl.range) && letDecl.value.type === "function") {
        const r = await walkExprForHover(
          letDecl.value.function.declaration.value.expression, position, ast, elmJson, tracker, currentUri
        );
        if (r) return r;
      }
    }
    return walkExprForHover(e.let.expression, position, ast, elmJson, tracker, currentUri);
  } else if (e.type === "case") {
    const r = await walkExprForHover(e.case.expression, position, ast, elmJson, tracker, currentUri);
    if (r) return r;
    for (const branch of e.case.cases as any[]) {
      const r2 = await walkExprForHover(branch.expression, position, ast, elmJson, tracker, currentUri);
      if (r2) return r2;
    }
  } else if (e.type === "lambda") {
    return walkExprForHover(e.lambda.expression, position, ast, elmJson, tracker, currentUri);
  } else if (e.type === "parenthesized") {
    return walkExprForHover(e.parenthesized, position, ast, elmJson, tracker, currentUri);
  } else if (e.type === "negation") {
    return walkExprForHover(e.negation, position, ast, elmJson, tracker, currentUri);
  } else if (e.type === "tupled") {
    for (const item of e.tupled) {
      const r = await walkExprForHover(item, position, ast, elmJson, tracker, currentUri);
      if (r) return r;
    }
  } else if (e.type === "list") {
    for (const item of e.list) {
      const r = await walkExprForHover(item, position, ast, elmJson, tracker, currentUri);
      if (r) return r;
    }
  } else if (e.type === "recordAccess") {
    return walkExprForHover(e.recordAccess.expression, position, ast, elmJson, tracker, currentUri);
  }

  return null;
}
