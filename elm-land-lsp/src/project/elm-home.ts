import * as path from "path";
import * as os from "os";

export function getElmHome(): string {
  if (process.env.ELM_HOME) return process.env.ELM_HOME;
  if (process.env.HOME) return path.join(process.env.HOME, ".elm");
  return path.join(os.homedir(), "AppData", "Roaming", "elm");
}
