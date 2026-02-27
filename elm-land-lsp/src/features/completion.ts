import * as fs from "fs/promises";
import { documentStore } from "../state/document-store";
import { findElmJsonFor, uriToPath, loadDocs, type ModuleDoc } from "../project/elm-json";
import { resolveModuleToFile } from "../project/module-resolver";
import { parse } from "../elm-ast/bridge";
import {
  toDeclarationName,
  isExposedFromModule,
  type Declaration,
} from "../elm-ast/types";

const enum CompletionItemKind {
  Function = 3,
  Constructor = 4,
  Field = 5,
  Module = 9,
  Struct = 22, // type alias
  TypeParameter = 25, // type variable
  EnumMember = 20,
}

type CompletionItem = {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
};

// Extract the "Module.Name." prefix before the cursor
function getModulePrefix(
  text: string,
  line: number,
  character: number
): string | null {
  const lines = text.split("\n");
  if (line >= lines.length) return null;
  const lineText = lines[line]!.slice(0, character);

  // Match qualified module access ending with "."
  const match = lineText.match(/((?:\p{Lu}[\w]*\.)+)$/u);
  if (!match) return null;

  // Return module name without trailing dot
  return match[1]!.slice(0, -1);
}

// Resolve import aliases from the source text (regex, no AST needed)
function resolveAlias(
  text: string,
  prefix: string
): string[] {
  const candidates = [prefix];

  // Check for "import Foo.Bar as Alias" patterns
  const aliasRegex = /^import\s+([\w.]+)\s+as\s+(\w+)/gm;
  let match;
  while ((match = aliasRegex.exec(text)) !== null) {
    if (match[2] === prefix) {
      candidates.push(match[1]!);
    }
  }

  return candidates;
}

// Get completions from a local Elm file's AST
async function completionsFromLocalModule(
  filePath: string,
  moduleName: string
): Promise<CompletionItem[]> {
  try {
    const source = await fs.readFile(filePath, "utf-8");
    const ast = await parse(source);
    if (!ast) return [];

    const items: CompletionItem[] = [];
    for (const decl of ast.declarations) {
      const name = toDeclarationName(decl.value);
      if (!name) continue;
      if (!isExposedFromModule(ast, name)) continue;

      items.push({
        label: name,
        kind: declToCompletionKind(decl.value),
        detail: getTypeSignature(decl.value),
        documentation: moduleName,
      });

      // Add constructors for exposed custom types
      if (decl.value.type === "typedecl") {
        for (const ctor of decl.value.typedecl.constructors) {
          items.push({
            label: ctor.value.name.value,
            kind: CompletionItemKind.EnumMember,
            detail: `${ctor.value.name.value} constructor`,
            documentation: moduleName,
          });
        }
      }
    }

    return items;
  } catch {
    return [];
  }
}

// Get completions from package docs.json
function completionsFromDocs(
  docs: ModuleDoc[],
  moduleName: string
): CompletionItem[] {
  const mod = docs.find((d) => d.name === moduleName);
  if (!mod) return [];

  const items: CompletionItem[] = [];

  for (const v of mod.values) {
    items.push({
      label: v.name,
      kind: CompletionItemKind.Function,
      detail: v.type,
      documentation: v.comment.split("\n")[0] || undefined,
    });
  }

  for (const u of mod.unions) {
    items.push({
      label: u.name,
      kind: CompletionItemKind.Struct,
      detail: `type ${u.name}`,
      documentation: u.comment.split("\n")[0] || undefined,
    });
    for (const [ctorName] of u.cases) {
      items.push({
        label: ctorName,
        kind: CompletionItemKind.EnumMember,
        detail: `${u.name} constructor`,
      });
    }
  }

  for (const a of mod.aliases) {
    items.push({
      label: a.name,
      kind: CompletionItemKind.Struct,
      detail: `type alias ${a.name} = ${a.type}`,
      documentation: a.comment.split("\n")[0] || undefined,
    });
  }

  return items;
}

// Get sub-module name completions (e.g., typing "Json." suggests "Decode", "Encode")
function subModuleCompletions(
  allModuleNames: string[],
  prefix: string
): CompletionItem[] {
  const withDot = prefix + ".";
  const seen = new Set<string>();
  const items: CompletionItem[] = [];

  for (const modName of allModuleNames) {
    if (modName.startsWith(withDot)) {
      const rest = modName.slice(withDot.length);
      const nextPart = rest.split(".")[0]!;
      if (!seen.has(nextPart)) {
        seen.add(nextPart);
        items.push({
          label: nextPart,
          kind: CompletionItemKind.Module,
          detail: `${withDot}${nextPart}`,
        });
      }
    }
  }

  return items;
}

function declToCompletionKind(decl: Declaration): number {
  switch (decl.type) {
    case "function": return CompletionItemKind.Function;
    case "typeAlias": return CompletionItemKind.Struct;
    case "typedecl": return CompletionItemKind.Struct;
    case "port": return CompletionItemKind.Function;
    default: return CompletionItemKind.Function;
  }
}

function getTypeSignature(decl: Declaration): string | undefined {
  if (decl.type === "function" && decl.function.signature) {
    return `${decl.function.declaration.value.name.value} : ...`;
  }
  if (decl.type === "typeAlias") return `type alias ${decl.typeAlias.name.value}`;
  if (decl.type === "typedecl") return `type ${decl.typedecl.name.value}`;
  if (decl.type === "port") return `port ${decl.port.name.value}`;
  return undefined;
}

export async function getCompletions(
  uri: string,
  position: { line: number; character: number }
): Promise<CompletionItem[] | null> {
  const doc = documentStore.get(uri);
  if (!doc) return null;

  const prefix = getModulePrefix(doc.text, position.line, position.character);
  if (!prefix) return null;

  const filePath = uriToPath(uri);
  const elmJson = await findElmJsonFor(filePath);
  if (!elmJson) return null;

  const resolvedNames = resolveAlias(doc.text, prefix);
  const items: CompletionItem[] = [];

  // Collect all known module names for sub-module completions
  const allModuleNames: string[] = [];

  // Check local project files
  for (const modName of resolvedNames) {
    const localPath = await resolveModuleToFile(modName, elmJson);
    if (localPath) {
      items.push(...await completionsFromLocalModule(localPath, modName));
    }
  }

  // Check package dependencies
  for (const dep of elmJson.dependencies) {
    const docs = await loadDocs(dep);
    for (const modDoc of docs) {
      allModuleNames.push(modDoc.name);
    }
    for (const modName of resolvedNames) {
      items.push(...completionsFromDocs(docs, modName));
    }
  }

  // Add sub-module name completions
  items.push(...subModuleCompletions(allModuleNames, prefix));

  return items.length > 0 ? items : null;
}
