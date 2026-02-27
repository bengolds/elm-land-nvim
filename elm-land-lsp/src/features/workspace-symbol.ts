import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import { findElmJsonFor, pathToUri, type ElmJsonFile } from "../project/elm-json";
import { documentStore } from "../state/document-store";
import type { Range } from "../protocol/messages";
import { SymbolKind } from "../protocol/messages";

type SymbolInformation = {
  name: string;
  kind: SymbolKind;
  location: { uri: string; range: Range };
};

const ELM_KEYWORDS = new Set([
  "module", "import", "exposing", "as", "if", "then", "else",
  "case", "of", "let", "in", "type", "alias", "port", "where",
]);

function extractSymbols(source: string, uri: string): SymbolInformation[] {
  const symbols: SymbolInformation[] = [];
  const lines = source.split("\n");
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Type alias
    let match = line.match(/^type\s+alias\s+(\p{Lu}[\w]*)/u);
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      symbols.push(makeSymbol(match[1]!, SymbolKind.Object, uri, i, line.indexOf(match[1]!), match[1]!.length));
      continue;
    }

    // Custom type
    match = line.match(/^type\s+(\p{Lu}[\w]*)/u);
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      symbols.push(makeSymbol(match[1]!, SymbolKind.Enum, uri, i, line.indexOf(match[1]!), match[1]!.length));
      continue;
    }

    // Port declaration (not "port module")
    match = line.match(/^port\s+(\p{Ll}[\w]*)/u);
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      symbols.push(makeSymbol(match[1]!, SymbolKind.Function, uri, i, line.indexOf(match[1]!), match[1]!.length));
      continue;
    }

    // Top-level function: lowercase at col 0, not a keyword, followed by args or type annotation
    match = line.match(/^(\p{Ll}[\w]*)\s+(?:[:,=]|[^\s])/u);
    if (match && !ELM_KEYWORDS.has(match[1]!) && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      symbols.push(makeSymbol(match[1]!, SymbolKind.Function, uri, i, 0, match[1]!.length));
      continue;
    }
  }

  return symbols;
}

function makeSymbol(
  name: string,
  kind: SymbolKind,
  uri: string,
  line: number,
  col: number,
  nameLen: number
): SymbolInformation {
  return {
    name,
    kind,
    location: {
      uri,
      range: {
        start: { line, character: col },
        end: { line, character: col + nameLen },
      },
    },
  };
}

function fuzzyMatch(query: string, name: string): boolean {
  const lowerQuery = query.toLowerCase();
  const lowerName = name.toLowerCase();
  let qi = 0;
  for (let ni = 0; ni < lowerName.length && qi < lowerQuery.length; ni++) {
    if (lowerName[ni] === lowerQuery[qi]) qi++;
  }
  return qi === lowerQuery.length;
}

let cachedSymbols: SymbolInformation[] | null = null;
let cachedProjectFolder: string | null = null;

async function getAllSymbols(rootUri: string): Promise<SymbolInformation[]> {
  // Find elm.json from any open document or from rootUri
  let elmJson: ElmJsonFile | undefined;
  for (const doc of documentStore.all()) {
    const filePath = decodeURIComponent(doc.uri.replace("file://", ""));
    elmJson = await findElmJsonFor(filePath);
    if (elmJson) break;
  }

  if (!elmJson) {
    const rootPath = decodeURIComponent(rootUri.replace("file://", ""));
    elmJson = await findElmJsonFor(path.join(rootPath, "src", "dummy.elm"));
  }

  if (!elmJson) return [];

  if (cachedProjectFolder === elmJson.projectFolder && cachedSymbols) {
    return cachedSymbols;
  }

  const symbols: SymbolInformation[] = [];
  const glob = new Glob("**/*.elm");

  for (const sourceDir of elmJson.sourceDirectories) {
    try {
      for (const match of glob.scanSync({ cwd: sourceDir, absolute: true })) {
        try {
          const source = fs.readFileSync(match, "utf-8");
          const uri = pathToUri(match);
          symbols.push(...extractSymbols(source, uri));
        } catch {}
      }
    } catch {}
  }

  cachedSymbols = symbols;
  cachedProjectFolder = elmJson.projectFolder;

  // Invalidate cache after 5 seconds (new files, etc.)
  setTimeout(() => {
    cachedSymbols = null;
    cachedProjectFolder = null;
  }, 5000);

  return symbols;
}

export async function getWorkspaceSymbols(
  query: string,
  rootUri: string
): Promise<SymbolInformation[]> {
  const allSymbols = await getAllSymbols(rootUri);
  if (!query) return allSymbols;
  return allSymbols.filter((s) => fuzzyMatch(query, s.name));
}
