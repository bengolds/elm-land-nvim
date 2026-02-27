import { parse } from "../elm-ast/bridge";
import { documentStore } from "../state/document-store";
import { getCachedAst, setCachedAst } from "../state/ast-cache";
import type {
  Node,
  Declaration,
  Expression,
  LetDeclaration,
  Range as ElmRange,
} from "../elm-ast/types";
import type { DocumentSymbol, Range } from "../protocol/messages";
import { SymbolKind } from "../protocol/messages";

const lastGoodSymbols = new Map<string, DocumentSymbol[]>();

export async function getDocumentSymbols(
  uri: string
): Promise<DocumentSymbol[] | null> {
  const doc = documentStore.get(uri);
  if (!doc) return null;

  const cached = getCachedAst(uri, doc.version);
  const ast = cached ?? (await parse(doc.text));

  if (!ast) {
    return lastGoodSymbols.get(uri) ?? null;
  }

  if (!cached) setCachedAst(uri, doc.version, ast);

  const symbols = ast.declarations
    .map((d) => declarationToSymbol(d))
    .filter((s): s is DocumentSymbol => s !== null);

  lastGoodSymbols.set(uri, symbols);
  return symbols;
}

function elmRangeToLsp(r: ElmRange): Range {
  return {
    start: { line: r[0] - 1, character: r[1] - 1 },
    end: { line: r[2] - 1, character: r[3] - 1 },
  };
}

function declarationToSymbol(decl: Node<Declaration>): DocumentSymbol | null {
  const d = decl.value;
  const range = elmRangeToLsp(decl.range);

  switch (d.type) {
    case "function": {
      const name = d.function.declaration.value.name.value;
      const selectionRange = elmRangeToLsp(d.function.declaration.value.name.range);
      const children = expressionSymbols(d.function.declaration.value.expression);
      return { name, kind: SymbolKind.Function, range, selectionRange, children: children.length > 0 ? children : undefined };
    }

    case "typeAlias": {
      const name = d.typeAlias.name.value;
      const selectionRange = elmRangeToLsp(d.typeAlias.name.range);
      const ta = d.typeAlias.typeAnnotation.value;
      const kind = ta.type === "record" || ta.type === "genericRecord" ? SymbolKind.Object : SymbolKind.Variable;
      return { name, kind, range, selectionRange };
    }

    case "typedecl": {
      const name = d.typedecl.name.value;
      const selectionRange = elmRangeToLsp(d.typedecl.name.range);
      const children: DocumentSymbol[] = d.typedecl.constructors.map((c) => ({
        name: c.value.name.value,
        kind: SymbolKind.EnumMember,
        range: elmRangeToLsp(c.range),
        selectionRange: elmRangeToLsp(c.value.name.range),
      }));
      return { name, kind: SymbolKind.Enum, range, selectionRange, children: children.length > 0 ? children : undefined };
    }

    case "port": {
      const name = d.port.name.value;
      const selectionRange = elmRangeToLsp(d.port.name.range);
      return { name, kind: SymbolKind.Function, range, selectionRange };
    }

    case "infix": {
      const name = d.infix.operator.value;
      const selectionRange = elmRangeToLsp(d.infix.operator.range);
      return { name, kind: SymbolKind.Operator, range, selectionRange };
    }

    case "destructuring":
      return null;
  }
}

function expressionSymbols(expr: Node<Expression>): DocumentSymbol[] {
  if (!expr?.value) return [];
  const e = expr.value;
  switch (e.type) {
    case "let":
      return e.let.declarations.flatMap(letDeclSymbols).concat(expressionSymbols(e.let.expression));

    case "case":
      return e.case.cases.flatMap(([_pat, caseExpr]) => expressionSymbols(caseExpr))
        .concat(expressionSymbols(e.case.expression));

    case "ifBlock":
      return [
        ...expressionSymbols(e.ifBlock.clause),
        ...expressionSymbols(e.ifBlock.then),
        ...expressionSymbols(e.ifBlock.else),
      ];

    case "lambda":
      return expressionSymbols(e.lambda.expression);

    case "application":
      return e.application.flatMap(expressionSymbols);

    case "operatorapplication":
      return [...expressionSymbols(e.operatorapplication.left), ...expressionSymbols(e.operatorapplication.right)];

    case "tupled":
      return e.tupled.flatMap(expressionSymbols);

    case "list":
      return e.list.flatMap(expressionSymbols);

    case "parenthesized":
      return expressionSymbols(e.parenthesized);

    case "negation":
      return expressionSymbols(e.negation);

    case "recordAccess":
      return expressionSymbols(e.recordAccess.expression);

    case "record":
      return (e.record as any[]).flatMap((setter: any) => expressionSymbols(setter.value[1]));

    case "recordUpdate":
      return (e.recordUpdate.updates as any[]).flatMap((setter: any) => expressionSymbols(setter.value[1]));

    default:
      return [];
  }
}

function letDeclSymbols(decl: Node<LetDeclaration>): DocumentSymbol[] {
  const d = decl.value;
  const range = elmRangeToLsp(decl.range);

  if (d.type === "function") {
    const name = d.function.declaration.value.name.value;
    const selectionRange = elmRangeToLsp(d.function.declaration.value.name.range);
    const children = expressionSymbols(d.function.declaration.value.expression);
    return [{ name, kind: SymbolKind.Function, range, selectionRange, children: children.length > 0 ? children : undefined }];
  }

  return [];
}
