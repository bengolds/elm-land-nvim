import * as fs from "fs/promises";
import { parse } from "../elm-ast/bridge";
import { documentStore } from "../state/document-store";
import { getCachedAst, setCachedAst } from "../state/ast-cache";
import { findElmJsonFor, uriToPath, pathToUri } from "../project/elm-json";
import { resolveModuleToFile } from "../project/module-resolver";
import {
  type Ast,
  type Node,
  type Declaration,
  type Expression,
  type LetDeclaration,
  type Range as ElmRange,
  findDeclarationWithName,
  findCustomTypeVariantWithName,
  createImportTracker,
  patternDefinitionNames,
  isExposedFromModule,
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

async function parseFile(filePath: string): Promise<Ast | undefined> {
  try {
    const source = await fs.readFile(filePath, "utf-8");
    return await parse(source);
  } catch {
    return undefined;
  }
}

export async function getDefinition(
  uri: string,
  position: Position
): Promise<Location | null> {
  const doc = documentStore.get(uri);
  if (!doc) return null;

  const cached = getCachedAst(uri, doc.version);
  const ast = cached ?? (await parse(doc.text));
  if (!ast) return null;
  if (!cached) setCachedAst(uri, doc.version, ast);

  const filePath = uriToPath(uri);
  const elmJson = await findElmJsonFor(filePath);
  if (!elmJson) return null;

  // Check if cursor is on an import module name
  for (const imp of ast.imports) {
    if (positionInRange(position, imp.value.moduleName.range)) {
      const moduleName = imp.value.moduleName.value.join(".");
      const targetPath = await resolveModuleToFile(moduleName, elmJson);
      if (targetPath) {
        return {
          uri: pathToUri(targetPath),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };
      }
      return null;
    }

    // Check if cursor is on an explicitly imported value
    if (imp.value.exposingList?.value.type === "explicit") {
      for (const exposed of imp.value.exposingList.value.explicit) {
        if (positionInRange(position, exposed.range)) {
          const moduleName = imp.value.moduleName.value.join(".");
          const name = getExposedName(exposed.value);
          return await findInModule(moduleName, name, elmJson);
        }
      }
    }
  }

  // Walk declarations to find what's under the cursor
  const tracker = createImportTracker(ast);

  for (const decl of ast.declarations) {
    if (!positionInRange(position, decl.range)) continue;
    const result = await findInDeclaration(uri, decl, position, ast, elmJson, tracker, []);
    if (result) return result;
  }

  return null;
}

function getExposedName(expose: import("../elm-ast/types").TopLevelExpose): string {
  switch (expose.type) {
    case "function": return expose.function.name;
    case "typeOrAlias": return expose.typeOrAlias.name;
    case "typeexpose": return expose.typeexpose.name;
    case "infix": return expose.infix.name;
  }
}

type ScopeNames = string[];

async function findInDeclaration(
  currentUri: string,
  decl: Node<Declaration>,
  position: Position,
  ast: Ast,
  elmJson: import("../project/elm-json").ElmJsonFile,
  tracker: import("../elm-ast/types").ImportTracker,
  scope: ScopeNames
): Promise<Location | null> {
  const d = decl.value;

  if (d.type === "function") {
    const funcDecl = d.function.declaration.value;
    const argNames = funcDecl.arguments.flatMap((a) => patternDefinitionNames(a.value));
    return findInExpression(currentUri, funcDecl.expression, position, ast, elmJson, tracker, [...scope, ...argNames]);
  }

  if (d.type === "destructuring") {
    return findInExpression(currentUri, d.destructuring.expression, position, ast, elmJson, tracker, scope);
  }

  return null;
}

async function findInExpression(
  currentUri: string,
  expr: Node<Expression>,
  position: Position,
  ast: Ast,
  elmJson: import("../project/elm-json").ElmJsonFile,
  tracker: import("../elm-ast/types").ImportTracker,
  scope: ScopeNames
): Promise<Location | null> {
  if (!positionInRange(position, expr.range)) return null;

  const e = expr.value;

  switch (e.type) {
    case "functionOrValue": {
      const name = e.functionOrValue.name;
      const moduleParts = e.functionOrValue.moduleName;

      if (moduleParts.length > 0) {
        // Qualified reference: Module.something
        const qualifiedModule = moduleParts.join(".");
        const resolvedModules = tracker.aliasMapping.get(qualifiedModule) ?? [qualifiedModule];
        for (const modName of resolvedModules) {
          const result = await findInModule(modName, name, elmJson);
          if (result) return result;
        }
        return null;
      }

      // Unqualified reference: check local scope first
      if (scope.includes(name)) {
        // It's a local binding — we could resolve to its exact location
        // but finding the exact pattern node is complex. Return null to
        // indicate "defined locally" rather than jumping nowhere useful.
        return null;
      }

      // Check same-file declarations
      const localDecl = findDeclarationWithName(ast, name);
      if (localDecl) {
        return {
          uri: currentUri,
          range: elmRangeToLsp(localDecl.range),
        };
      }

      // Check same-file custom type variants
      const localVariant = findCustomTypeVariantWithName(ast, name);
      if (localVariant) {
        return {
          uri: currentUri,
          range: elmRangeToLsp(localVariant.constructor.range),
        };
      }

      // Check imports
      const fromExplicit = tracker.explicitExposing.get(name);
      if (fromExplicit) {
        for (const modName of fromExplicit) {
          const result = await findInModule(modName, name, elmJson);
          if (result) return result;
        }
      }

      // Check expose-all imports
      for (const modName of tracker.unknownImports) {
        const result = await findInModule(modName, name, elmJson);
        if (result) return result;
      }

      return null;
    }

    case "let": {
      const letNames: string[] = [];
      for (const letDecl of e.let.declarations) {
        if (letDecl.value.type === "function") {
          letNames.push(letDecl.value.function.declaration.value.name.value);
        } else if (letDecl.value.type === "destructuring") {
          letNames.push(...patternDefinitionNames(letDecl.value.destructuring.pattern.value));
        }
      }
      const letScope = [...scope, ...letNames];

      for (const letDecl of e.let.declarations) {
        if (positionInRange(position, letDecl.range)) {
          return findInLetDeclaration(currentUri, letDecl, position, ast, elmJson, tracker, letScope);
        }
      }

      return findInExpression(currentUri, e.let.expression, position, ast, elmJson, tracker, letScope);
    }

    case "case": {
      const caseExprResult = await findInExpression(currentUri, e.case.expression, position, ast, elmJson, tracker, scope);
      if (caseExprResult) return caseExprResult;

      for (const [pattern, caseExpr] of e.case.cases) {
        const patNames = patternDefinitionNames(pattern.value);
        const result = await findInExpression(currentUri, caseExpr, position, ast, elmJson, tracker, [...scope, ...patNames]);
        if (result) return result;
      }
      return null;
    }

    case "lambda": {
      const lambdaNames = e.lambda.patterns.flatMap((p) => patternDefinitionNames(p.value));
      return findInExpression(currentUri, e.lambda.expression, position, ast, elmJson, tracker, [...scope, ...lambdaNames]);
    }

    case "application": {
      for (const arg of e.application) {
        const result = await findInExpression(currentUri, arg, position, ast, elmJson, tracker, scope);
        if (result) return result;
      }
      return null;
    }

    case "operatorapplication": {
      return (
        (await findInExpression(currentUri, e.operatorapplication.left, position, ast, elmJson, tracker, scope)) ??
        (await findInExpression(currentUri, e.operatorapplication.right, position, ast, elmJson, tracker, scope))
      );
    }

    case "ifBlock": {
      return (
        (await findInExpression(currentUri, e.ifBlock.clause, position, ast, elmJson, tracker, scope)) ??
        (await findInExpression(currentUri, e.ifBlock.then, position, ast, elmJson, tracker, scope)) ??
        (await findInExpression(currentUri, e.ifBlock.else, position, ast, elmJson, tracker, scope))
      );
    }

    case "parenthesized":
      return findInExpression(currentUri, e.parenthesized, position, ast, elmJson, tracker, scope);

    case "negation":
      return findInExpression(currentUri, e.negation, position, ast, elmJson, tracker, scope);

    case "tupled": {
      for (const item of e.tupled) {
        const result = await findInExpression(currentUri, item, position, ast, elmJson, tracker, scope);
        if (result) return result;
      }
      return null;
    }

    case "list": {
      for (const item of e.list) {
        const result = await findInExpression(currentUri, item, position, ast, elmJson, tracker, scope);
        if (result) return result;
      }
      return null;
    }

    case "record": {
      for (const setter of e.record as any[]) {
        const result = await findInExpression(currentUri, setter.value[1], position, ast, elmJson, tracker, scope);
        if (result) return result;
      }
      return null;
    }

    case "recordUpdate": {
      for (const setter of (e.recordUpdate.updates as any[])) {
        const result = await findInExpression(currentUri, setter.value[1], position, ast, elmJson, tracker, scope);
        if (result) return result;
      }
      return null;
    }

    case "recordAccess":
      return findInExpression(currentUri, e.recordAccess.expression, position, ast, elmJson, tracker, scope);

    default:
      return null;
  }
}

async function findInLetDeclaration(
  currentUri: string,
  decl: Node<LetDeclaration>,
  position: Position,
  ast: Ast,
  elmJson: import("../project/elm-json").ElmJsonFile,
  tracker: import("../elm-ast/types").ImportTracker,
  scope: ScopeNames
): Promise<Location | null> {
  const d = decl.value;
  if (d.type === "function") {
    const argNames = d.function.declaration.value.arguments.flatMap((a) => patternDefinitionNames(a.value));
    return findInExpression(currentUri, d.function.declaration.value.expression, position, ast, elmJson, tracker, [...scope, ...argNames]);
  }
  if (d.type === "destructuring") {
    return findInExpression(currentUri, d.destructuring.expression, position, ast, elmJson, tracker, scope);
  }
  return null;
}

async function findInModule(
  moduleName: string,
  name: string,
  elmJson: import("../project/elm-json").ElmJsonFile
): Promise<Location | null> {
  const filePath = await resolveModuleToFile(moduleName, elmJson);
  if (!filePath) return null;

  const targetAst = await parseFile(filePath);
  if (!targetAst) return null;

  if (!isExposedFromModule(targetAst, name)) return null;

  const decl = findDeclarationWithName(targetAst, name);
  if (decl) {
    return {
      uri: pathToUri(filePath),
      range: elmRangeToLsp(decl.range),
    };
  }

  const variant = findCustomTypeVariantWithName(targetAst, name);
  if (variant) {
    return {
      uri: pathToUri(filePath),
      range: elmRangeToLsp(variant.constructor.range),
    };
  }

  return null;
}
