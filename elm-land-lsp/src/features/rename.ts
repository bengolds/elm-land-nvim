import { findReferences } from "./references";
import type { Position, Range } from "../protocol/messages";

type WorkspaceEdit = {
  changes: Record<string, { range: Range; newText: string }[]>;
};

export async function prepareRename(
  uri: string,
  position: Position
): Promise<{ range: Range; placeholder: string } | null> {
  // Use find-references to check if this is a renameable symbol
  const refs = await findReferences(uri, position, true);
  if (refs.length === 0) return null;

  // Find the reference at this exact position
  const atCursor = refs.find(
    (r) =>
      r.uri === uri &&
      r.range.start.line === position.line &&
      position.character >= r.range.start.character &&
      position.character <= r.range.end.character
  );

  if (!atCursor) {
    // Use the first reference as a fallback
    return null;
  }

  // Extract the current name from the range
  // We need the document text to get the actual name
  const { documentStore } = await import("../state/document-store");
  const doc = documentStore.get(uri);
  if (!doc) return null;

  const lines = doc.text.split("\n");
  const line = lines[atCursor.range.start.line];
  if (!line) return null;

  const placeholder = line.slice(
    atCursor.range.start.character,
    atCursor.range.end.character
  );

  return { range: atCursor.range, placeholder };
}

export async function doRename(
  uri: string,
  position: Position,
  newName: string
): Promise<WorkspaceEdit | null> {
  const refs = await findReferences(uri, position, true);
  if (refs.length === 0) return null;

  const changes: Record<string, { range: Range; newText: string }[]> = {};

  for (const ref of refs) {
    if (!changes[ref.uri]) {
      changes[ref.uri] = [];
    }
    changes[ref.uri].push({
      range: ref.range,
      newText: newName,
    });
  }

  return { changes };
}
