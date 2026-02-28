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
  type Pattern,
  type TypeAnnotation,
  type Range as ElmRange,
  findDeclarationWithName,
  findCustomTypeVariantWithName,
  createImportTracker,
  toModuleName,
  toModuleData,
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

type SymbolIdentity = {
  defModule: string;
  name: string;
  kind: "value" | "type" | "constructor";
};

// --- Symbol resolution at cursor ---

async function resolveSymbolAtPosition(
  uri: string,
  position: Position,
  ast: Ast,
  elmJson: ElmJsonFile
): Promise<SymbolIdentity | null> {
  const currentModule = toModuleName(ast);

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

  const tracker = createImportTracker(ast);

  for (const decl of ast.declarations) {
    if (!positionInRange(position, decl.range)) continue;

    const declName = getDeclNameNode(decl.value);
    if (declName && positionInRange(position, declName.range)) {
      const kind = decl.value.type === "typedecl" || decl.value.type === "typeAlias" ? "type" : "value";
      return { defModule: currentModule, name: declName.value, kind };
    }

    if (decl.value.type === "typedecl") {
      for (const ctor of decl.value.typedecl.constructors) {
        if (positionInRange(position, ctor.value.name.range)) {
          return { defModule: currentModule, name: ctor.value.name.value, kind: "constructor" };
        }
      }
    }

    if (decl.value.type === "function") {
      // Check signature name
      if (decl.value.function.signature) {
        const sigName = decl.value.function.signature.value.name;
        if (positionInRange(position, sigName.range)) {
          return { defModule: currentModule, name: sigName.value, kind: "value" };
        }
      }

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

    if (findDeclarationWithName(ast, name)) {
      return { defModule: currentModule, name, kind: "value" };
    }
    if (findCustomTypeVariantWithName(ast, name)) {
      return { defModule: currentModule, name, kind: "constructor" };
    }

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
        const r = await recurse(branch.expression); if (r) return r;
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
      for (const setter of e.record as any[]) { const r = await recurse(setter.value.expression); if (r) return r; }
      return null;
    case "recordUpdate":
      for (const setter of e.recordUpdate.updates as any[]) { const r = await recurse(setter.value.expression); if (r) return r; }
      return null;
    default: return null;
  }
}

// --- Reference collection ---

// Calculate the range for just the name part of a qualified expression.
// For "Module.name" at range [r, c, r, c+len], the name starts after the last dot.
function nameRangeOfQualifiedExpr(exprRange: ElmRange, moduleParts: string[], name: string): ElmRange {
  const prefix = moduleParts.join(".") + ".";
  const nameStart = exprRange[1] + prefix.length;
  return [exprRange[0], nameStart, exprRange[2], nameStart + name.length - 1];
}

// For exposing list items like `Foo(..)`, we want just the name range, not including `(..)`.
function nameRangeOfExposed(exposedRange: ElmRange, name: string): ElmRange {
  return [exposedRange[0], exposedRange[1], exposedRange[0], exposedRange[1] + name.length - 1];
}

function collectRefsInFile(
  ast: Ast,
  fileUri: string,
  target: SymbolIdentity,
  fileModuleName: string
): Location[] {
  const locations: Location[] = [];
  const tracker = createImportTracker(ast);

  if (!canFileReference(ast, target, fileModuleName)) return locations;

  // Module exposing list (Bug 5 fix: use name-only range)
  if (fileModuleName === target.defModule) {
    const modData = toModuleData(ast);
    if (modData.exposingList.value.type === "explicit") {
      for (const exposed of modData.exposingList.value.explicit) {
        if (getExposedNameStr(exposed.value) === target.name) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(nameRangeOfExposed(exposed.range, target.name)) });
        }
      }
    }
  }

  // Import exposing lists (Bug 5 fix: use name-only range)
  for (const imp of ast.imports) {
    if (imp.value.moduleName.value.join(".") !== target.defModule) continue;
    if (imp.value.exposingList?.value.type === "explicit") {
      for (const exposed of imp.value.exposingList.value.explicit) {
        const name = getExposedNameStr(exposed.value);
        if (name === target.name) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(nameRangeOfExposed(exposed.range, target.name)) });
        }
      }
    }
  }

  // Walk declarations
  for (const decl of ast.declarations) {
    // Definition name
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

    // Type annotation signature name
    if (decl.value.type === "function" && decl.value.function.signature) {
      const sigName = decl.value.function.signature.value.name;
      if (sigName.value === target.name && fileModuleName === target.defModule) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(sigName.range) });
      }

      // Bug 3 fix: Walk type annotation for type references
      if (target.kind === "type") {
        collectRefsInTypeAnnotation(decl.value.function.signature.value.typeAnnotation, locations, fileUri, target, tracker, fileModuleName);
      }
    }

    // Type alias body
    if (decl.value.type === "typeAlias" && target.kind === "type") {
      collectRefsInTypeAnnotation(decl.value.typeAlias.typeAnnotation, locations, fileUri, target, tracker, fileModuleName);
    }

    // Custom type constructor arguments
    if (decl.value.type === "typedecl" && target.kind === "type") {
      for (const ctor of decl.value.typedecl.constructors) {
        for (const arg of ctor.value.arguments) {
          collectRefsInTypeAnnotation(arg, locations, fileUri, target, tracker, fileModuleName);
        }
      }
    }

    // Port type annotation
    if (decl.value.type === "port" && target.kind === "type") {
      collectRefsInTypeAnnotation(decl.value.port.typeAnnotation, locations, fileUri, target, tracker, fileModuleName);
    }

    // Walk expression for references
    if (decl.value.type === "function") {
      collectRefsInExpr(decl.value.function.declaration.value.expression, locations, fileUri, target, tracker, fileModuleName);
      // Bug 2 fix: walk function argument patterns for constructor refs
      if (target.kind === "constructor") {
        for (const arg of decl.value.function.declaration.value.arguments) {
          collectRefsInPattern(arg, locations, fileUri, target, tracker, fileModuleName);
        }
      }
    }
  }

  return locations;
}

// Bug 3 fix: Walk type annotations for type name references
function collectRefsInTypeAnnotation(
  ta: Node<TypeAnnotation>,
  locations: Location[],
  fileUri: string,
  target: SymbolIdentity,
  tracker: ReturnType<typeof createImportTracker>,
  fileModuleName: string
): void {
  if (!ta?.value) return;
  const t = ta.value;

  if (t.type === "typed") {
    const mn = t.typed.moduleNameAndName.value;
    const name = mn.name;
    if (name === target.name) {
      if (mn.moduleName.length > 0) {
        const mod = mn.moduleName.join(".");
        const resolved = tracker.aliasMapping.get(mod) ?? [mod];
        if (resolved.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(t.typed.moduleNameAndName.range) });
        }
      } else if (fileModuleName === target.defModule) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(t.typed.moduleNameAndName.range) });
      } else {
        const fromExplicit = tracker.explicitExposing.get(name);
        if (fromExplicit?.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(t.typed.moduleNameAndName.range) });
        } else if (tracker.unknownImports.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(t.typed.moduleNameAndName.range) });
        }
      }
    }
    for (const arg of t.typed.args) {
      collectRefsInTypeAnnotation(arg, locations, fileUri, target, tracker, fileModuleName);
    }
  } else if (t.type === "function") {
    collectRefsInTypeAnnotation(t.function.left, locations, fileUri, target, tracker, fileModuleName);
    collectRefsInTypeAnnotation(t.function.right, locations, fileUri, target, tracker, fileModuleName);
  } else if (t.type === "tupled") {
    for (const item of t.tupled) {
      collectRefsInTypeAnnotation(item, locations, fileUri, target, tracker, fileModuleName);
    }
  } else if (t.type === "record") {
    for (const field of ((t.record as any).value ?? t.record)) {
      collectRefsInTypeAnnotation(field.value.typeAnnotation, locations, fileUri, target, tracker, fileModuleName);
    }
  } else if (t.type === "genericRecord") {
    for (const field of ((t.genericRecord.values as any).value ?? [])) {
      collectRefsInTypeAnnotation(field.value.typeAnnotation, locations, fileUri, target, tracker, fileModuleName);
    }
  }
}

// Bug 2 fix: Walk patterns for constructor references
function collectRefsInPattern(
  pat: Node<Pattern>,
  locations: Location[],
  fileUri: string,
  target: SymbolIdentity,
  tracker: ReturnType<typeof createImportTracker>,
  fileModuleName: string
): void {
  if (!pat?.value) return;
  const p = pat.value;

  if (p.type === "named") {
    const q = p.named.qualified;
    if (q.name === target.name) {
      if (q.moduleName.length > 0) {
        const mod = q.moduleName.join(".");
        const resolved = tracker.aliasMapping.get(mod) ?? [mod];
        if (resolved.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(pat.range) });
        }
      } else if (fileModuleName === target.defModule) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(pat.range) });
      } else {
        const fromExplicit = tracker.explicitExposing.get(q.name);
        if (fromExplicit?.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(pat.range) });
        } else if (tracker.unknownImports.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(pat.range) });
        }
      }
    }
    for (const sub of (p.named.patterns ?? [])) {
      collectRefsInPattern(sub, locations, fileUri, target, tracker, fileModuleName);
    }
  } else if (p.type === "tuple") {
    for (const sub of ((p.tuple as any).value ?? p.tuple)) {
      collectRefsInPattern(sub, locations, fileUri, target, tracker, fileModuleName);
    }
  } else if (p.type === "uncons") {
    collectRefsInPattern(p.uncons.hd, locations, fileUri, target, tracker, fileModuleName);
    collectRefsInPattern(p.uncons.tl, locations, fileUri, target, tracker, fileModuleName);
  } else if (p.type === "list") {
    for (const sub of ((p.list as any).value ?? p.list)) {
      collectRefsInPattern(sub, locations, fileUri, target, tracker, fileModuleName);
    }
  } else if (p.type === "as") {
    collectRefsInPattern(p.as.pattern, locations, fileUri, target, tracker, fileModuleName);
  } else if (p.type === "parentisized") {
    collectRefsInPattern(p.parentisized, locations, fileUri, target, tracker, fileModuleName);
  }
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
        // Bug 4 fix: only record the name range, not the full qualified range
        const nameRange = nameRangeOfQualifiedExpr(expr.range, moduleParts, name);
        locations.push({ uri: fileUri, range: elmRangeToLsp(nameRange) });
      }
    } else {
      // Unqualified
      if (fileModuleName === target.defModule) {
        locations.push({ uri: fileUri, range: elmRangeToLsp(expr.range) });
      } else {
        // Bug 1 fix: check explicitExposing first, only fall through to unknownImports if not found
        const fromExplicit = tracker.explicitExposing.get(name);
        if (fromExplicit?.includes(target.defModule)) {
          locations.push({ uri: fileUri, range: elmRangeToLsp(expr.range) });
        } else if (tracker.unknownImports.includes(target.defModule)) {
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
        if (d.value.type === "function") {
          recurse(d.value.function.declaration.value.expression);
          // Walk let-function arg patterns for constructor refs
          if (target.kind === "constructor") {
            for (const arg of d.value.function.declaration.value.arguments) {
              collectRefsInPattern(arg, locations, fileUri, target, tracker, fileModuleName);
            }
          }
        } else if (d.value.type === "destructuring") {
          recurse(d.value.destructuring.expression);
          if (target.kind === "constructor") {
            collectRefsInPattern(d.value.destructuring.pattern, locations, fileUri, target, tracker, fileModuleName);
          }
        }
      }
      recurse(e.let.expression);
      break;
    case "case":
      recurse(e.case.expression);
      for (const branch of e.case.cases as any[]) {
        // Bug 2 fix: walk case patterns for constructor refs
        if (target.kind === "constructor") {
          collectRefsInPattern(branch.pattern, locations, fileUri, target, tracker, fileModuleName);
        }
        recurse(branch.expression);
      }
      break;
    case "lambda":
      // Walk lambda patterns for constructor refs
      if (target.kind === "constructor") {
        for (const pat of e.lambda.patterns) {
          collectRefsInPattern(pat, locations, fileUri, target, tracker, fileModuleName);
        }
      }
      recurse(e.lambda.expression);
      break;
    case "parenthesized": recurse(e.parenthesized); break;
    case "negation": recurse(e.negation); break;
    case "tupled": e.tupled.forEach(recurse); break;
    case "list": e.list.forEach(recurse); break;
    case "recordAccess": recurse(e.recordAccess.expression); break;
    case "record": (e.record as any[]).forEach((s: any) => recurse(s.value.expression)); break;
    case "recordUpdate": (e.recordUpdate.updates as any[]).forEach((s: any) => recurse(s.value.expression)); break;
  }
}

function canFileReference(ast: Ast, target: SymbolIdentity, fileModuleName: string): boolean {
  if (fileModuleName === target.defModule) return true;
  for (const imp of ast.imports) {
    if (imp.value.moduleName.value.join(".") === target.defModule) return true;
    if (imp.value.moduleAlias) {
      const alias = imp.value.moduleAlias.value.join(".");
      if (alias === target.defModule) return true;
    }
  }
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

  // Deduplicate by uri+range
  const seen = new Set<string>();
  return allLocations.filter((loc) => {
    const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
