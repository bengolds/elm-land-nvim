import * as path from "path";
import * as fs from "fs/promises";
import { getElmHome } from "./elm-home";

export type ElmJsonFile = {
  projectFolder: string;
  elmJsonPath: string;
  elmVersion: string;
  sourceDirectories: string[];
  dependencies: Dependency[];
};

export type Dependency = {
  packageUserAndName: string;
  packageVersion: string;
  docsPath: string;
};

export type ModuleDoc = {
  name: string;
  comment: string;
  unions: { name: string; comment: string; args: string[]; cases: [string, string[]][] }[];
  aliases: { name: string; comment: string; args: string[]; type: string }[];
  values: { name: string; comment: string; type: string }[];
  binops: { name: string; comment: string; type: string }[];
};

const elmJsonCache = new Map<string, ElmJsonFile>();
const docsCache = new Map<string, ModuleDoc[]>();

export function parseElmJson(
  elmJsonPath: string,
  rawContents: string
): ElmJsonFile | undefined {
  try {
    const json = JSON.parse(rawContents);
    const elmVersion = json["elm-version"];
    const sourceDirs: string[] = json["source-directories"];
    const deps: Record<string, string> = json?.dependencies?.direct ?? {};

    if (typeof elmVersion !== "string" || !Array.isArray(sourceDirs)) {
      return undefined;
    }

    const projectFolder = path.dirname(elmJsonPath);
    const elmHome = getElmHome();

    const dependencies: Dependency[] = Object.entries(deps).map(
      ([name, version]) => ({
        packageUserAndName: name,
        packageVersion: version,
        docsPath: path.join(
          elmHome,
          elmVersion,
          "packages",
          ...name.split("/"),
          version,
          "docs.json"
        ),
      })
    );

    return {
      projectFolder,
      elmJsonPath,
      elmVersion,
      sourceDirectories: sourceDirs.map((d) => path.resolve(projectFolder, d)),
      dependencies,
    };
  } catch {
    return undefined;
  }
}

export async function findElmJsonFor(filePath: string): Promise<ElmJsonFile | undefined> {
  let dir = path.dirname(filePath);
  while (true) {
    const cached = elmJsonCache.get(dir);
    if (cached) return cached;

    const candidate = path.join(dir, "elm.json");
    try {
      const contents = await fs.readFile(candidate, "utf-8");
      const parsed = parseElmJson(candidate, contents);
      if (parsed) {
        elmJsonCache.set(dir, parsed);
        return parsed;
      }
    } catch {
      // file doesn't exist, keep searching up
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function loadDocs(dep: Dependency): Promise<ModuleDoc[]> {
  const cached = docsCache.get(dep.docsPath);
  if (cached) return cached;

  try {
    const raw = await fs.readFile(dep.docsPath, "utf-8");
    const docs: ModuleDoc[] = JSON.parse(raw);
    docsCache.set(dep.docsPath, docs);
    return docs;
  } catch {
    return [];
  }
}

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace("file://", ""));
}

export function pathToUri(fsPath: string): string {
  return "file://" + encodeURI(fsPath).replace(/#/g, "%23");
}
