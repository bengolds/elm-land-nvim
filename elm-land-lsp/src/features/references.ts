import * as fs from "fs";
import { Glob } from "bun";
import { documentStore } from "../state/document-store";
import { findElmJsonFor, uriToPath, pathToUri, type ElmJsonFile } from "../project/elm-json";
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
  toModuleName,
} from "../elm-ast/types";
import type { Location, Position, Range } from "../protocol/messages";

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

// The "identity" of a symbol: which module defines it + its name
type SymbolIdentity = {
  defModule: string; // e.g., "Helpers"
  name: string;      // e.g., "add"
  kind: "value" | "type" | "constructor";
};

// Resolve what symbol the cursor is on, returning its canonical identity
async function resolveSymbolAtPosition(
  uri: string,
  position: Position,
  ast: Ast,
  elmJson: ElmJsonFile
): Promise<SymbolIdentity | null> {
  const currentModule = toModuleName(ast);

  // Check imports — cursor on exposed value
  for (const imp of ast.imports) {
    if (imp.value.exposingList?.value.type === "explicit") {
      for (const exposed of imp.value.exposingList.value.explicit) {
        if (positionInRange(position, exposed.range)) {
          const moduleName = imp.value.moduleName.value.join(".");
          const e = exposed.value;
          let name: string;
          let kind: SymbolIdentity["kind"] = "value";
          switch (e.type) {
            case "function": name = e.function.name; break;
            case "typeOrAlias": name = e.typeOrAlias.name; kind = "type"; break;
            case "typeexpose": name = e.typeexpose.name; kind = "type"; break;
            case "infix": name = e.infix.name; break;
          }
          return { defModule: moduleName, name: name!, kind };
        }
      }
    }
  }

  // Check declarations — walk to find functionOrValue under cursor
  const tracker = createImportTracker(ast);

  for (const decl of ast.declarations) {
    if (!positionInRange(position, decl.range)) continue;

    // Check if cursor is on the declaration name itself
    const declName = getDeclNameNode(decl.value);
    if (declName && positionInRange(position, declName.range)) {
      const kind = decl.value.type === "typedecl" || decl.value.type === "typeAlias" ? "type" : "value";
      return { defModule: currentModule, name: declName.value, kind };
    }

    // Check constructors
    if (decl.value.type === "typedecl") {
      for (const ctor of decl.value.typedecl.constructors) {
        if (positionInRange(position, ctor.value.name.range)) {
          return { defModule: currentModule, name: ctor.value.name.value, kind: "constructor" };
        }
      }
    }

    // Walk expression tree
    if (decl.value.type === "function") {
      const result = await findIdentityInExpr(
        decl.value.function.declaration.value.expression,
        position, ast, elmJson, tracker, currentModule
      );
      if (result) return result;
    }
  }

  return null;
}

function getDeclNameNode(decl: Declaration): Node<string> | null {
  switch (decl.type) {
    case "function": return decl.function.declaration.value.name;
    case "typeAlias": return decl.typeAlias.name;
    case "typedecl": return decl.typedecl.name;
    case "port": return decl.port.name;
    default: return null;
  }
}

async function findIdentityInExpr(
  expr: Node<Expression>,
  position: Position,
  ast: Ast,
  elmJson: ElmJsonFile,
  tracker: ReturnType<typeof createImportTracker>,
  currentModule: string
): Promise<SymbolIdentity | null> {
  if (!expr?.value || !positionInRange(position, expr.range)) return null;
  const e = expr.value;

  if (e.type === "functionOrValue") {
    const name = e.functionOrValue.name;
    const moduleParts = e.functionOrValue.moduleName;

    if (moduleParts.length > 0) {
      const qualifiedModule = moduleParts.join(".");
      const resolved = tracker.aliasMapping.get(qualifiedModule) ?? [qualifiedModule];
      return { defModule: resolved[0]!, name, kind: "value" };
    }

    // Check same-file
    if (findDeclarationWithName(ast, name)) {
      return { defModule: currentModule, name, kind: "value" };
    }
    if (findCustomTypeVariantWithName(ast, name)) {
      return { defModule: currentModule, name, kind: "constructor" };
    }

    // Check imports
    const fromExplicit = tracker.explicitExposing.get(name);
    if (fromExplicit?.length) {
      return { defModule: fromExplicit[0]!, name, kind: "value" };
    }

    for (const modName of tracker.unknownImports) {
      const filePath = await resolveModuleToFile(modName, elmJson);
      if (filePath) {
        const source = fs.readFileSync(filePath, "utf-8");
        const targetAst = await parse(source);
        if (targetAst && (findDeclarationWithName(targetAst, name) || findCustomTypeVariantWithName(targetAst, name))) {
          return { defModule: modName, name, kind: "value" };
        }
      }
    }

    return null;
  }

  // Recurse into sub-expressions
  const recurse = (child: Node<Expression>) =>
    findIdentityInExpr(child, position, ast, elmJson, tracker, currentModule);

  switch (e.type) {
    case "application":
      for (const arg of e.application) { const r = await recurse(arg); if (r) return r; }
      return null;
    case "operatorapplication":
      return (await recurse(e.operatorapplication.left)) ?? (await recurse(e.operatorapplication.right));
    case "ifBlock":
      return (await recurse(e.ifBlock.clause)) ?? (await recurse(e.ifBlock.then)) ?? (await recurse(e.ifBlock.else));
    case "let":
      for (const d of e.let.declarations) {
        if (d.value.type === "function" && positionInRange(position, d.range)) {
          return recurse(d.value.function.declaration.value.expression);
        }
      }
      return recurse(e.let.expression);
    case "case":
      { const r = await recurse(e.case.expression); if (r) return r; }
      for (const branch of e.case.cases as any[]) {
        const r = await recurse(branch[1]); if (r) return r;
      }
      return null;
    case "lambda": return recurse(e.lambda.expression);
    case "parenthesized": return recurse(e.parenthesized);
    case "negation": return recurse(e.negation);
    case "tupled":
      for (const item of e.tupled) { const r = await recurse(item); if (r) return r; }
      return null;
    case "list":
      for (const item of e.list) { const r = await recurse(item); if (r) return r; }
      return null;
    case "recordAccess": return recurse(e.recordAccess.expression);
    case "record":
      for (const setter of e.record as any[]) { const r = await recurse(setter.value[1]); if (r) return r; }
      return null;
    case "recordUpdate":
      for (const setter of e.recordUpdate.updates as any[]) { const r = await recurse(setter.value[1]); if (r) return r; }
      return null;
    default: return null;
  }
}

// Scan a single file's AST for all references to a given symbol identity
function collectRefsInFile(
  ast: Ast,
  fileUri: string,
  target: SymbolIdentity,
  fileModuleName: string
): Location[] {
  const locations: Location[] = [];
  const tracker = createImportTracker(ast);

  // Check if this file imports the target module
  const canReference = canFileReference(ast, target, fileModuleName);
  if (!canReference) return locations;

  // Check import exposing list
  for (const imp of ast.imports) {
    if (imp.value.moduleName.value.join(".") !== target.defModule) continue;
    if (imp.value.exposingList?.value.type === "explicit") {
      for (const exposed of imp.value.exposingList.value.explicit) {
        const name = getExposedNameStr(exposed.value);
        if (name === target.name) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(exposed.range) });
        }
      }
    }
  }

  // Walk declarations
  for (const decl of ast.declarations) {
    // Check if this IS the definition
    if (fileModuleName === target.defModule) {
      const nameNode = getDeclNameNode(decl.value);
      if (nameNode && nameNode.value === target.name) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(nameNode.range) });
      }
      if (decl.value.type === "typedecl" && target.kind === "constructor") {
        for (const ctor of decl.value.typedecl.constructors) {
          if (ctor.value.name.value === target.name) {
            locations.push({ uri: fileUri, range: elmRangeToLsp(ctor.value.name.range) });
          }
        }
      }
    }

    // Walk expression for references
    if (decl.value.type === "function") {
      collectRefsInExpr(decl.value.function.declaration.value.expression, locations, fileUri, target, tracker, fileModuleName);
    }
  }

  return locations;
}

function collectRefsInExpr(
  expr: Node<Expression>,
  locations: Location[],
  fileUri: string,
  target: SymbolIdentity,
  tracker: ReturnType<typeof createImportTracker>,
  fileModuleName: string
): void {
  if (!expr?.value) return;
  const e = expr.value;

  if (e.type === "functionOrValue") {
    const name = e.functionOrValue.name;
    const moduleParts = e.functionOrValue.moduleName;

    if (name !== target.name) return;

    if (moduleParts.length > 0) {
      const qualifiedModule = moduleParts.join(".");
      const resolved = tracker.aliasMapping.get(qualifiedModule) ?? [qualifiedModule];
      if (resolved.includes(target.defModule)) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(expr.range) });
      }
    } else {
      // Unqualified — could be same-module or imported
      if (fileModuleName === target.defModule) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(expr.range) });
      } else {
        const fromExplicit = tracker.explicitExposing.get(name);
        if (fromExplicit?.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(expr.range) });
        }
        if (tracker.unknownImports.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(expr.range) });
        }
      }
    }
    return;
  }

  const recurse = (child: Node<Expression>) =>
    collectRefsInExpr(child, locations, fileUri, target, tracker, fileModuleName);

  switch (e.type) {
    case "application": e.application.forEach(recurse); break;
    case "operatorapplication": recurse(e.operatorapplication.left); recurse(e.operatorapplication.right); break;
    case "ifBlock": recurse(e.ifBlock.clause); recurse(e.ifBlock.then); recurse(e.ifBlock.else); break;
    case "let":
      for (const d of e.let.declarations) {
        if (d.value.type === "function") recurse(d.value.function.declaration.value.expression);
        else if (d.value.type === "destructuring") recurse(d.value.destructuring.expression);
      }
      recurse(e.let.expression);
      break;
    case "case":
      recurse(e.case.expression);
      for (const branch of e.case.cases as any[]) recurse(branch[1]);
      break;
    case "lambda": recurse(e.lambda.expression); break;
    case "parenthesized": recurse(e.parenthesized); break;
    case "negation": recurse(e.negation); break;
    case "tupled": e.tupled.forEach(recurse); break;
    case "list": e.list.forEach(recurse); break;
    case "recordAccess": recurse(e.recordAccess.expression); break;
    case "record": (e.record as any[]).forEach((s: any) => recurse(s.value[1])); break;
    case "recordUpdate": (e.recordUpdate.updates as any[]).forEach((s: any) => recurse(s.value[1])); break;
  }
}

function canFileReference(ast: Ast, target: SymbolIdentity, fileModuleName: string): boolean {
  if (fileModuleName === target.defModule) return true;
  for (const imp of ast.imports) {
    if (imp.value.moduleName.value.join(".") === target.defModule) return true;
    // Check aliases
    if (imp.value.moduleAlias) {
      const alias = imp.value.moduleAlias.value.join(".");
      if (alias === target.defModule) return true;
    }
  }
  // Prelude modules are always accessible
  const preludeModules = ["Basics", "List", "Maybe", "Result", "String", "Char", "Tuple", "Debug", "Platform", "Platform.Cmd", "Platform.Sub"];
  return preludeModules.includes(target.defModule);
}

function getExposedNameStr(expose: any): string {
  switch (expose.type) {
    case "function": return expose.function.name;
    case "typeOrAlias": return expose.typeOrAlias.name;
    case "typeexpose": return expose.typeexpose.name;
    case "infix": return expose.infix.name;
    default: return "";
  }
}

export async function findReferences(
  uri: string,
  position: Position,
  includeDeclaration: boolean
): Promise<Location[]> {
  const doc = documentStore.get(uri);
  if (!doc) return [];

  const cached = getCachedAst(uri, doc.version);
  const ast = cached ?? (await parse(doc.text));
  if (!ast) return [];
  if (!cached) setCachedAst(uri, doc.version, ast);

  const filePath = uriToPath(uri);
  const elmJson = await findElmJsonFor(filePath);
  if (!elmJson) return [];

  const identity = await resolveSymbolAtPosition(uri, position, ast, elmJson);
  if (!identity) return [];

  // Scan all files in source directories
  const allLocations: Location[] = [];
  const glob = new Glob("**/*.elm");

  for (const sourceDir of elmJson.sourceDirectories) {
    try {
      for (const match of glob.scanSync({ cwd: sourceDir, absolute: true })) {
        const source = fs.readFileSync(match, "utf-8");
        const fileAst = await parse(source);
        if (!fileAst) continue;

        const fileModule = toModuleName(fileAst);
        const fileUri = pathToUri(match);
        const refs = collectRefsInFile(fileAst, fileUri, identity, fileModule);

        if (!includeDeclaration && fileModule === identity.defModule) {
          // Filter out the definition itself
          const declNode = getDeclNameNode(
            (findDeclarationWithName(fileAst, identity.name) ?? { value: {} as any }).value
          );
          const declRange = declNode ? elmRangeToLsp(declNode.range) : null;
          for (const ref of refs) {
            if (declRange &&
                ref.range.start.line === declRange.start.line &&
                ref.range.start.character === declRange.start.character) {
              continue;
            }
            allLocations.push(ref);
          }
        } else {
          allLocations.push(...refs);
        }
      }
    } catch {}
  }

  return allLocations;
}
