export type Range = [number, number, number, number]; // [startRow, startCol, endRow, endCol] (1-based)

export type Node<T> = {
  range: Range;
  value: T;
};

export type Ast = {
  comments: Node<string>[];
  moduleDefinition: Node<Module>;
  imports: Node<Import>[];
  declarations: Node<Declaration>[];
};

export type Module =
  | { type: "normal"; normal: ModuleData }
  | { type: "port"; port: ModuleData }
  | { type: "effect"; effect: ModuleData };

export type ModuleData = {
  moduleName: Node<string[]>;
  exposingList: Node<Exposing>;
};

export type Import = {
  moduleName: Node<string[]>;
  moduleAlias: Node<string[]> | null;
  exposingList: Node<Exposing> | null;
};

export type Exposing =
  | { type: "explicit"; explicit: Node<TopLevelExpose>[] }
  | { type: "all"; range: Range };

export type TopLevelExpose =
  | { type: "function"; function: { name: string } }
  | { type: "typeOrAlias"; typeOrAlias: { name: string } }
  | { type: "typeexpose"; typeexpose: { name: string; open: Range } }
  | { type: "infix"; infix: { name: string } };

export type Declaration =
  | { type: "function"; function: Function_ }
  | { type: "typeAlias"; typeAlias: TypeAlias }
  | { type: "typedecl"; typedecl: TypeDecl }
  | { type: "port"; port: Signature }
  | { type: "destructuring"; destructuring: Destructuring }
  | { type: "infix"; infix: Infix };

export type Function_ = {
  documentation: Node<string> | null;
  signature: Node<Signature> | null;
  declaration: Node<FunctionDeclaration>;
};

export type FunctionDeclaration = {
  name: Node<string>;
  arguments: Node<Pattern>[];
  expression: Node<Expression>;
};

export type TypeAlias = {
  documentation: Node<string> | null;
  name: Node<string>;
  generics: Node<string>[];
  typeAnnotation: Node<TypeAnnotation>;
};

export type TypeDecl = {
  documentation: Node<string> | null;
  name: Node<string>;
  generics: Node<string>[];
  constructors: Node<TypeConstructor>[];
};

export type TypeConstructor = {
  name: Node<string>;
  arguments: Node<TypeAnnotation>[];
};

export type Signature = {
  name: Node<string>;
  typeAnnotation: Node<TypeAnnotation>;
};

export type Destructuring = {
  pattern: Node<Pattern>;
  expression: Node<Expression>;
};

export type Infix = {
  direction: Node<string>;
  precedence: Node<number>;
  operator: Node<string>;
  function: Node<string>;
};

export type TypeAnnotation =
  | { type: "generic"; generic: { value: string } }
  | { type: "typed"; typed: { moduleNameAndName: Node<{ moduleName: string[]; name: string }>; args: Node<TypeAnnotation>[] } }
  | { type: "unit"; unit: {} }
  | { type: "tupled"; tupled: Node<TypeAnnotation>[] }
  | { type: "function"; function: { left: Node<TypeAnnotation>; right: Node<TypeAnnotation> } }
  | { type: "record"; record: Node<RecordField>[] }
  | { type: "genericRecord"; genericRecord: { name: Node<string>; values: Node<Node<RecordField>[]> } };

export type RecordField = { name: Node<string>; typeAnnotation: Node<TypeAnnotation> };

export function typeAnnotationToString(ta: Node<TypeAnnotation>): string {
  const t = ta.value;
  switch (t.type) {
    case "generic": return t.generic.value;
    case "unit": return "()";
    case "typed": {
      const mn = t.typed.moduleNameAndName.value;
      const name = mn.moduleName.length > 0 ? mn.moduleName.join(".") + "." + mn.name : mn.name;
      if (t.typed.args.length === 0) return name;
      const args = t.typed.args.map(typeAnnotationToString).join(" ");
      return `${name} ${args}`;
    }
    case "function": {
      const left = typeAnnotationToString(t.function.left);
      const right = typeAnnotationToString(t.function.right);
      const leftStr = t.function.left.value.type === "function" ? `(${left})` : left;
      return `${leftStr} -> ${right}`;
    }
    case "tupled":
      return "( " + t.tupled.map(typeAnnotationToString).join(", ") + " )";
    case "record": {
      const fields = ((t.record as any).value ?? t.record).map((f: any) =>
        `${f.value.name.value} : ${typeAnnotationToString(f.value.typeAnnotation)}`
      );
      return fields.length === 0 ? "{}" : "{ " + fields.join(", ") + " }";
    }
    case "genericRecord": {
      const name = t.genericRecord.name.value;
      const fields = ((t.genericRecord.values as any).value ?? []).map((f: any) =>
        `${f.value.name.value} : ${typeAnnotationToString(f.value.typeAnnotation)}`
      );
      return `{ ${name} | ${fields.join(", ")} }`;
    }
  }
}

export type Pattern =
  | { type: "all" }
  | { type: "unit" }
  | { type: "char"; char: string }
  | { type: "string"; string: string }
  | { type: "hex"; hex: number }
  | { type: "int"; int: number }
  | { type: "float"; float: number }
  | { type: "tuple"; tuple: Node<Pattern>[] }
  | { type: "record"; record: Node<string>[] }
  | { type: "uncons"; uncons: { hd: Node<Pattern>; tl: Node<Pattern> } }
  | { type: "list"; list: Node<Pattern>[] }
  | { type: "var"; var: { value: string } }
  | { type: "named"; named: { qualified: { moduleName: string[]; name: string }; patterns: Node<Pattern>[] } }
  | { type: "as"; as: { pattern: Node<Pattern>; name: Node<string> } }
  | { type: "parentisized"; parentisized: Node<Pattern> };

export type Expression =
  | { type: "unitExpr" }
  | { type: "application"; application: Node<Expression>[] }
  | { type: "operatorapplication"; operatorapplication: { operator: string; left: Node<Expression>; right: Node<Expression> } }
  | { type: "functionOrValue"; functionOrValue: { moduleName: string[]; name: string } }
  | { type: "ifBlock"; ifBlock: { clause: Node<Expression>; then: Node<Expression>; else: Node<Expression> } }
  | { type: "prefixoperator"; prefixoperator: string }
  | { type: "operator"; operator: string }
  | { type: "hex"; hex: number }
  | { type: "integer"; integer: number }
  | { type: "float"; float: number }
  | { type: "negation"; negation: Node<Expression> }
  | { type: "literal"; literal: string }
  | { type: "charLiteral"; charLiteral: string }
  | { type: "tupled"; tupled: Node<Expression>[] }
  | { type: "list"; list: Node<Expression>[] }
  | { type: "parenthesized"; parenthesized: Node<Expression> }
  | { type: "let"; let: { declarations: Node<LetDeclaration>[]; expression: Node<Expression> } }
  | { type: "case"; case: { expression: Node<Expression>; cases: CaseBranch[] } }
  | { type: "lambda"; lambda: { patterns: Node<Pattern>[]; expression: Node<Expression> } }
  | { type: "recordAccess"; recordAccess: { expression: Node<Expression>; name: Node<string> } }
  | { type: "recordAccessFunction"; recordAccessFunction: string }
  | { type: "record"; record: Node<RecordSetter>[] }
  | { type: "recordUpdate"; recordUpdate: { name: Node<string>; updates: Node<RecordSetter>[] } }
  | { type: "glsl"; glsl: string };

export type RecordSetter = [Node<string>, Node<Expression>];

export type CaseBranch = { pattern: Node<Pattern>; expression: Node<Expression> };

export type LetDeclaration =
  | { type: "function"; function: Function_ }
  | { type: "destructuring"; destructuring: Destructuring };

// --- Helper functions ---

export function toModuleData(ast: Ast): ModuleData {
  const mod = ast.moduleDefinition.value;
  switch (mod.type) {
    case "normal": return mod.normal;
    case "port": return mod.port;
    case "effect": return mod.effect;
  }
}

export function toModuleName(ast: Ast): string {
  return toModuleData(ast).moduleName.value.join(".");
}

export function toDeclarationName(decl: Declaration): string | undefined {
  switch (decl.type) {
    case "function": return decl.function.declaration.value.name.value;
    case "typeAlias": return decl.typeAlias.name.value;
    case "typedecl": return decl.typedecl.name.value;
    case "port": return decl.port.name.value;
    case "infix": return decl.infix.operator.value;
    case "destructuring": return undefined;
  }
}

export function findDeclarationWithName(ast: Ast, name: string): Node<Declaration> | undefined {
  return ast.declarations.find((d) => toDeclarationName(d.value) === name);
}

export function findCustomTypeVariantWithName(
  ast: Ast,
  name: string
): { declaration: Node<Declaration>; constructor: Node<TypeConstructor> } | undefined {
  for (const decl of ast.declarations) {
    if (decl.value.type === "typedecl") {
      for (const ctor of decl.value.typedecl.constructors) {
        if (ctor.value.name.value === name) {
          return { declaration: decl, constructor: ctor };
        }
      }
    }
  }
  return undefined;
}

export function isExposedFromModule(ast: Ast, name: string): boolean {
  const exposing = toModuleData(ast).exposingList.value;
  if (exposing.type === "all") return true;
  for (const e of exposing.explicit) {
    switch (e.value.type) {
      case "function": if (e.value.function.name === name) return true; break;
      case "typeOrAlias": if (e.value.typeOrAlias.name === name) return true; break;
      case "typeexpose":
        if (e.value.typeexpose.name === name) return true;
        // When a type is exposed with (..), all its constructors are exposed
        const variant = findCustomTypeVariantWithName(ast, name);
        if (variant) {
          const typeName = toDeclarationName(variant.declaration.value);
          if (typeName === e.value.typeexpose.name) return true;
        }
        break;
      case "infix": if (e.value.infix.name === name) return true; break;
    }
  }
  return false;
}

export function patternDefinitionNames(pattern: Pattern): string[] {
  switch (pattern.type) {
    case "var": return [pattern.var.value];
    case "as": return [...patternDefinitionNames(pattern.as.pattern.value), pattern.as.name.value];
    case "tuple": return pattern.tuple.flatMap((p) => patternDefinitionNames(p.value));
    case "uncons": return [...patternDefinitionNames(pattern.uncons.hd.value), ...patternDefinitionNames(pattern.uncons.tl.value)];
    case "list": return pattern.list.flatMap((p) => patternDefinitionNames(p.value));
    case "named": return (pattern.named.patterns ?? []).flatMap((p) => patternDefinitionNames(p.value));
    case "parentisized": return patternDefinitionNames(pattern.parentisized.value);
    case "record": return pattern.record.map((n) => n.value);
    default: return [];
  }
}

export type ImportTracker = {
  explicitExposing: Map<string, string[]>;
  unknownImports: string[];
  aliasMapping: Map<string, string[]>;
};

const PRELUDE_EXPOSING: Record<string, string[]> = {
  List: ["List"], "(::)": ["List"],
  Maybe: ["Maybe"], Just: ["Maybe"], Nothing: ["Maybe"],
  Result: ["Result"], Ok: ["Result"], Err: ["Result"],
  String: ["String"], Char: ["Char"],
  Program: ["Platform"], Cmd: ["Platform.Cmd"], Sub: ["Platform.Sub"],
};

const PRELUDE_UNKNOWN = ["Basics"];
const PRELUDE_ALIASES: Record<string, string[]> = {
  Cmd: ["Platform.Cmd"], Sub: ["Platform.Sub"],
};

export function createImportTracker(ast: Ast): ImportTracker {
  const explicitExposing = new Map<string, string[]>(Object.entries(PRELUDE_EXPOSING));
  const unknownImports = [...PRELUDE_UNKNOWN];
  const aliasMapping = new Map<string, string[]>(Object.entries(PRELUDE_ALIASES));

  for (const imp of ast.imports) {
    const moduleName = imp.value.moduleName.value.join(".");

    if (imp.value.moduleAlias) {
      const alias = imp.value.moduleAlias.value.join(".");
      const existing = aliasMapping.get(alias) ?? [];
      aliasMapping.set(alias, [...existing, moduleName]);
    }

    if (!imp.value.exposingList) continue;
    const exposing = imp.value.exposingList.value;

    if (exposing.type === "all") {
      unknownImports.push(moduleName);
      continue;
    }

    for (const exposed of exposing.explicit) {
      let name: string;
      switch (exposed.value.type) {
        case "function": name = exposed.value.function.name; break;
        case "typeOrAlias": name = exposed.value.typeOrAlias.name; break;
        case "typeexpose":
          name = exposed.value.typeexpose.name;
          unknownImports.push(moduleName);
          break;
        case "infix": name = exposed.value.infix.name; break;
      }
      const existing = explicitExposing.get(name!) ?? [];
      explicitExposing.set(name!, [...existing, moduleName]);
    }
  }

  return { explicitExposing, unknownImports, aliasMapping };
}
