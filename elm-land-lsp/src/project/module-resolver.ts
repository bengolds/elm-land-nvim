import * as path from "path";
import * as fs from "fs/promises";
import type { ElmJsonFile } from "./elm-json";
import { pathToUri } from "./elm-json";

export async function resolveModuleToFile(
  moduleName: string,
  elmJson: ElmJsonFile
): Promise<string | undefined> {
  const relativePath = moduleName.split(".").join("/") + ".elm";

  for (const sourceDir of elmJson.sourceDirectories) {
    const fullPath = path.join(sourceDir, relativePath);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      continue;
    }
  }

  return undefined;
}

export async function resolveModuleToUri(
  moduleName: string,
  elmJson: ElmJsonFile
): Promise<string | undefined> {
  const fsPath = await resolveModuleToFile(moduleName, elmJson);
  return fsPath ? pathToUri(fsPath) : undefined;
}
