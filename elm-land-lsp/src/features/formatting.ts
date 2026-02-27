import { documentStore } from "../state/document-store";
import { findElmJsonFor, uriToPath } from "../project/elm-json";
import type { TextEdit } from "../protocol/messages";

export async function formatDocument(uri: string): Promise<TextEdit[] | null> {
  const doc = documentStore.get(uri);
  if (!doc) return null;

  const filePath = uriToPath(uri);
  const elmJson = await findElmJsonFor(filePath);
  const cwd = elmJson?.projectFolder;

  try {
    const proc = Bun.spawn(["elm-format", "--stdin", "--yes"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(doc.text);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return null;

    const lines = doc.text.split("\n");
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length, character: 0 },
        },
        newText: stdout,
      },
    ];
  } catch {
    return null;
  }
}
