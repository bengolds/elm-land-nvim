import * as fs from "fs/promises";
import { parse } from "../elm-ast/bridge";
import { documentStore } from "../state/document-store";
import { getCachedAst, setCachedAst } from "../state/ast-cache";
import { findElmJsonFor, uriToPath, pathToUri, type ElmJsonFile } from "../project/elm-json";
import { resolveModuleToFile } from "../project/module-resolver";
import {
  type Ast,
  type Node,
  type Expression,
  type Pattern,
  type TypeAnnotation,
  type Range as ElmRange,
  type ImportTracker,
  findDeclarationWithName,
  findCustomTypeVariantWithName,
  createImportTracker,
  toModuleData,
  isExposedFromModule,
} from "../elm-ast/types";
import type { Location, Position, Range } from "../protocol/messages";

function elmRangeToLsp(r: ElmRange): Range {
  return {
    start: { line: r[0] - 1, character: r[1] - 1 },
    end: { line: r[2] - 1, character: r[3] - 1 },
  };
}

function posInRange(pos: Position, r: ElmRange): boolean {
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

function getExposedName(expose: any): string {
  switch (expose.type) {
    case "function": return expose.function.name;
    case "typeOrAlias": return expose.typeOrAlias.name;
    case "typeexpose": return expose.typeexpose.name;
    case "infix": return expose.infix.name;
    default: return "";
  }
}

// Track local bindings with their source location for jump-to-local-var
type ScopeBinding = { name: string; range: ElmRange };
type Scope = ScopeBinding[];

function scopeHas(scope: Scope, name: string): ScopeBinding | undefined {
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope[i]!.name === name) return scope[i];
  }
  return undefined;
}

function bindingsFromPattern(pattern: Node<Pattern>): ScopeBinding[] {
  const p = pattern.value;
  switch (p.type) {
    case "var": return [{ name: p.var.value, range: pattern.range }];
    case "as": return [...bindingsFromPattern(p.as.pattern), { name: p.as.name.value, range: p.as.name.range }];
    case "tuple": return ((p.tuple as any).value ?? p.tuple).flatMap(bindingsFromPattern);
    case "uncons": return [...bindingsFromPattern(p.uncons.hd), ...bindingsFromPattern(p.uncons.tl)];
    case "list": return ((p.list as any).value ?? p.list).flatMap(bindingsFromPattern);
    case "named": return (p.named.patterns ?? []).flatMap(bindingsFromPattern);
    case "parentisized": return bindingsFromPattern(p.parentisized);
    case "record": return p.record.map((n) => ({ name: n.value, range: n.range }));
    default: return [];
  }
}

// --- Context for resolution ---
type Ctx = {
  uri: string;
  ast: Ast;
  elmJson: ElmJsonFile;
  tracker: ImportTracker;
};

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

  const tracker = createImportTracker(ast);
  const ctx: Ctx = { uri, ast, elmJson, tracker };

  // 1. Module definition exposing list
  const modData = toModuleData(ast);
  if (modData.exposingList.value.type === "explicit") {
    for (const exposed of modData.exposingList.value.explicit) {
      if (posInRange(position, exposed.range)) {
        const name = getExposedName(exposed.value);
        const decl = findDeclarationWithName(ast, name);
        if (decl) return { uri, range: elmRangeToLsp(decl.range) };
        const variant = findCustomTypeVariantWithName(ast, name);
        if (variant) return { uri, range: elmRangeToLsp(variant.constructor.range) };
        return null;
      }
    }
  }

  // 2. Imports
  for (const imp of ast.imports) {
    if (posInRange(position, imp.value.moduleName.range)) {
      const moduleName = imp.value.moduleName.value.join(".");
      const targetPath = await resolveModuleToFile(moduleName, elmJson);
      if (targetPath) {
        return { uri: pathToUri(targetPath), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
      }
      return null;
    }

    if (imp.value.exposingList?.value.type === "explicit") {
      for (const exposed of imp.value.exposingList.value.explicit) {
        if (posInRange(position, exposed.range)) {
          const moduleName = imp.value.moduleName.value.join(".");
          const name = getExposedName(exposed.value);
          return await findInModule(moduleName, name, elmJson);
        }
      }
    }
  }

  // 3. Declarations
  for (const decl of ast.declarations) {
    if (!posInRange(position, decl.range)) continue;
    const d = decl.value;

    // Type annotations
    if (d.type === "function" && d.function.signature) {
      const result = await findInTypeAnnotation(d.function.signature.value.typeAnnotation, position, ctx);
      if (result) return result;
    }
    if (d.type === "typeAlias") {
      const result = await findInTypeAnnotation(d.typeAlias.typeAnnotation, position, ctx);
      if (result) return result;
    }
    if (d.type === "typedecl") {
      for (const ctor of d.typedecl.constructors) {
        for (const arg of ctor.value.arguments) {
          const result = await findInTypeAnnotation(arg, position, ctx);
          if (result) return result;
        }
      }
    }
    if (d.type === "port") {
      const result = await findInTypeAnnotation(d.port.typeAnnotation, position, ctx);
      if (result) return result;
    }

    // Function body
    if (d.type === "function") {
      const funcDecl = d.function.declaration.value;
      const argBindings = funcDecl.arguments.flatMap(bindingsFromPattern);

      // Check patterns themselves for constructor refs
      for (const argPat of funcDecl.arguments) {
        const result = await findInPattern(argPat, position, ctx);
        if (result) return result;
      }

      return findInExpr(funcDecl.expression, position, ctx, argBindings);
    }

    if (d.type === "destructuring") {
      const result = await findInPattern(d.destructuring.pattern, position, ctx);
      if (result) return result;
      return findInExpr(d.destructuring.expression, position, ctx, []);
    }
  }

  return null;
}

// --- Type annotation walking ---

async function findInTypeAnnotation(
  ta: Node<TypeAnnotation>,
  position: Position,
  ctx: Ctx
): Promise<Location | null> {
  if (!posInRange(position, ta.range)) return null;
  const t = ta.value;

  if (t.type === "typed") {
    const mn = t.typed.moduleNameAndName.value;
    if (posInRange(position, t.typed.moduleNameAndName.range)) {
      const name = mn.name;
      const moduleParts = mn.moduleName;

      if (moduleParts.length > 0) {
        const mod = moduleParts.join(".");
        const resolved = ctx.tracker.aliasMapping.get(mod) ?? [mod];
        for (const m of resolved) {
          const r = await findInModule(m, name, ctx.elmJson);
          if (r) return r;
        }
      } else {
        // Same-file type
        const decl = findDeclarationWithName(ctx.ast, name);
        if (decl) return { uri: ctx.uri, range: elmRangeToLsp(decl.range) };

        // Imported type
        const fromExplicit = ctx.tracker.explicitExposing.get(name);
        if (fromExplicit) {
          for (const m of fromExplicit) {
            const r = await findInModule(m, name, ctx.elmJson);
            if (r) return r;
          }
        }
        for (const m of ctx.tracker.unknownImports) {
          const r = await findInModule(m, name, ctx.elmJson);
          if (r) return r;
        }
      }
      return null;
    }

    // Recurse into type args
    for (const arg of t.typed.args) {
      const r = await findInTypeAnnotation(arg, position, ctx);
      if (r) return r;
    }
  }

  if (t.type === "function") {
    return (await findInTypeAnnotation(t.function.left, position, ctx)) ??
           (await findInTypeAnnotation(t.function.right, position, ctx));
  }

  if (t.type === "tupled") {
    for (const item of t.tupled) {
      const r = await findInTypeAnnotation(item, position, ctx);
      if (r) return r;
    }
  }

  if (t.type === "record") {
    for (const field of (t.record as any).value ?? t.record) {
      const r = await findInTypeAnnotation(field.value.typeAnnotation, position, ctx);
      if (r) return r;
    }
  }

  if (t.type === "genericRecord") {
    for (const field of ((t.genericRecord.values as any).value ?? [])) {
      const r = await findInTypeAnnotation(field.value.typeAnnotation, position, ctx);
      if (r) return r;
    }
  }

  return null;
}

// --- Pattern walking (for constructor references) ---

async function findInPattern(
  pat: Node<Pattern>,
  position: Position,
  ctx: Ctx
): Promise<Location | null> {
  if (!posInRange(position, pat.range)) return null;
  const p = pat.value;

  if (p.type === "named") {
    const q = p.named.qualified;
    // Check if cursor is on the constructor name (approximate: if in the pattern range but before the sub-patterns)
    if (posInRange(position, pat.range)) {
      const name = q.name;
      const moduleParts = q.moduleName;

      if (moduleParts.length > 0) {
        const mod = moduleParts.join(".");
        const resolved = ctx.tracker.aliasMapping.get(mod) ?? [mod];
        for (const m of resolved) {
          const r = await findInModule(m, name, ctx.elmJson);
          if (r) return r;
        }
      } else {
        // Same-file variant
        const variant = findCustomTypeVariantWithName(ctx.ast, name);
        if (variant) return { uri: ctx.uri, range: elmRangeToLsp(variant.constructor.range) };

        // Imported variant
        const fromExplicit = ctx.tracker.explicitExposing.get(name);
        if (fromExplicit) {
          for (const m of fromExplicit) {
            const r = await findInModule(m, name, ctx.elmJson);
            if (r) return r;
          }
        }
        for (const m of ctx.tracker.unknownImports) {
          const r = await findInModule(m, name, ctx.elmJson);
          if (r) return r;
        }
      }
    }

    // Recurse into sub-patterns
    for (const subPat of p.named.patterns ?? []) {
      const r = await findInPattern(subPat, position, ctx);
      if (r) return r;
    }
    return null;
  }

  if (p.type === "tuple") {
    for (const sub of ((p.tuple as any).value ?? p.tuple)) { const r = await findInPattern(sub, position, ctx); if (r) return r; }
  }
  if (p.type === "uncons") {
    return (await findInPattern(p.uncons.hd, position, ctx)) ?? (await findInPattern(p.uncons.tl, position, ctx));
  }
  if (p.type === "list") {
    for (const sub of p.list) { const r = await findInPattern(sub, position, ctx); if (r) return r; }
  }
  if (p.type === "as") {
    return findInPattern(p.as.pattern, position, ctx);
  }
  if (p.type === "parentisized") {
    return findInPattern(p.parentisized, position, ctx);
  }

  return null;
}

// --- Expression walking ---

async function findInExpr(
  expr: Node<Expression>,
  position: Position,
  ctx: Ctx,
  scope: Scope
): Promise<Location | null> {
  if (!expr?.value || !posInRange(position, expr.range)) return null;
  const e = expr.value;

  switch (e.type) {
    case "functionOrValue": {
      const name = e.functionOrValue.name;
      const moduleParts = e.functionOrValue.moduleName;

      if (moduleParts.length > 0) {
        const mod = moduleParts.join(".");
        const resolved = ctx.tracker.aliasMapping.get(mod) ?? [mod];
        for (const m of resolved) {
          const r = await findInModule(m, name, ctx.elmJson);
          if (r) return r;
        }
        return null;
      }

      // Local binding
      const binding = scopeHas(scope, name);
      if (binding) {
        return { uri: ctx.uri, range: elmRangeToLsp(binding.range) };
      }

      // Same-file declaration
      const localDecl = findDeclarationWithName(ctx.ast, name);
      if (localDecl) return { uri: ctx.uri, range: elmRangeToLsp(localDecl.range) };

      // Same-file variant
      const localVariant = findCustomTypeVariantWithName(ctx.ast, name);
      if (localVariant) return { uri: ctx.uri, range: elmRangeToLsp(localVariant.constructor.range) };

      // Imports
      const fromExplicit = ctx.tracker.explicitExposing.get(name);
      if (fromExplicit) {
        for (const m of fromExplicit) {
          const r = await findInModule(m, name, ctx.elmJson);
          if (r) return r;
        }
      }
      for (const m of ctx.tracker.unknownImports) {
        const r = await findInModule(m, name, ctx.elmJson);
        if (r) return r;
      }
      return null;
    }

    case "let": {
      const letBindings: Scope = [];
      for (const d of e.let.declarations) {
        if (d.value.type === "function") {
          const n = d.value.function.declaration.value.name;
          letBindings.push({ name: n.value, range: n.range });
        } else if (d.value.type === "destructuring") {
          letBindings.push(...bindingsFromPattern(d.value.destructuring.pattern));
        }
      }
      const letScope = [...scope, ...letBindings];

      for (const d of e.let.declarations) {
        if (!posInRange(position, d.range)) continue;
        if (d.value.type === "function") {
          const argBindings = d.value.function.declaration.value.arguments.flatMap(bindingsFromPattern);
          for (const argPat of d.value.function.declaration.value.arguments) {
            const r = await findInPattern(argPat, position, ctx);
            if (r) return r;
          }
          return findInExpr(d.value.function.declaration.value.expression, position, ctx, [...letScope, ...argBindings]);
        }
        if (d.value.type === "destructuring") {
          const r = await findInPattern(d.value.destructuring.pattern, position, ctx);
          if (r) return r;
          return findInExpr(d.value.destructuring.expression, position, ctx, letScope);
        }
      }
      return findInExpr(e.let.expression, position, ctx, letScope);
    }

    case "case": {
      const r = await findInExpr(e.case.expression, position, ctx, scope);
      if (r) return r;
      for (const branch of e.case.cases as any[]) {
        const pat = branch.pattern as Node<Pattern>;
        const patResult = await findInPattern(pat, position, ctx);
        if (patResult) return patResult;
        const patBindings = bindingsFromPattern(pat);
        const exprResult = await findInExpr(branch.expression, position, ctx, [...scope, ...patBindings]);
        if (exprResult) return exprResult;
      }
      return null;
    }

    case "lambda": {
      const lambdaBindings = e.lambda.patterns.flatMap(bindingsFromPattern);
      for (const pat of e.lambda.patterns) {
        const r = await findInPattern(pat, position, ctx);
        if (r) return r;
      }
      return findInExpr(e.lambda.expression, position, ctx, [...scope, ...lambdaBindings]);
    }

    case "application": {
      for (const arg of e.application) {
        const r = await findInExpr(arg, position, ctx, scope);
        if (r) return r;
      }
      return null;
    }

    case "operatorapplication":
      return (await findInExpr(e.operatorapplication.left, position, ctx, scope)) ??
             (await findInExpr(e.operatorapplication.right, position, ctx, scope));

    case "ifBlock":
      return (await findInExpr(e.ifBlock.clause, position, ctx, scope)) ??
             (await findInExpr(e.ifBlock.then, position, ctx, scope)) ??
             (await findInExpr(e.ifBlock.else, position, ctx, scope));

    case "parenthesized":
      return findInExpr(e.parenthesized, position, ctx, scope);

    case "negation":
      return findInExpr(e.negation, position, ctx, scope);

    case "tupled": {
      for (const item of e.tupled) { const r = await findInExpr(item, position, ctx, scope); if (r) return r; }
      return null;
    }

    case "list": {
      for (const item of e.list) { const r = await findInExpr(item, position, ctx, scope); if (r) return r; }
      return null;
    }

    case "record": {
      for (const setter of e.record as any[]) {
        const r = await findInExpr(setter.value.expression, position, ctx, scope);
        if (r) return r;
      }
      return null;
    }

    case "recordUpdate": {
      // The name before | in { name | ... } is a variable reference
      if (posInRange(position, e.recordUpdate.name.range)) {
        const name = e.recordUpdate.name.value;
        const binding = scopeHas(scope, name);
        if (binding) return { uri: ctx.uri, range: elmRangeToLsp(binding.range) };
        const localDecl = findDeclarationWithName(ctx.ast, name);
        if (localDecl) return { uri: ctx.uri, range: elmRangeToLsp(localDecl.range) };
      }
      for (const setter of e.recordUpdate.updates as any[]) {
        const r = await findInExpr(setter.value.expression, position, ctx, scope);
        if (r) return r;
      }
      return null;
    }

    case "recordAccess":
      return findInExpr(e.recordAccess.expression, position, ctx, scope);

    default:
      return null;
  }
}

// --- Cross-module resolution ---

async function findInModule(
  moduleName: string,
  name: string,
  elmJson: ElmJsonFile
): Promise<Location | null> {
  const filePath = await resolveModuleToFile(moduleName, elmJson);
  if (!filePath) return null;

  const targetAst = await parseFile(filePath);
  if (!targetAst) return null;

  if (!isExposedFromModule(targetAst, name)) return null;

  const decl = findDeclarationWithName(targetAst, name);
  if (decl) return { uri: pathToUri(filePath), range: elmRangeToLsp(decl.range) };

  const variant = findCustomTypeVariantWithName(targetAst, name);
  if (variant) return { uri: pathToUri(filePath), range: elmRangeToLsp(variant.constructor.range) };

  return null;
}
