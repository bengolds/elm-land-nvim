import { encode, tryParse } from "./protocol/transport";
import {
  isRequest,
  isNotification,
  ErrorCodes,
  type RequestMessage,
  type NotificationMessage,
  type ResponseMessage,
} from "./protocol/messages";
import { serverCapabilities } from "./protocol/capabilities";
import { documentStore } from "./state/document-store";
import { runDiagnostics } from "./features/diagnostics";
import { formatDocument } from "./features/formatting";
import { getDocumentSymbols } from "./features/document-symbol";
import { getDefinition } from "./features/definition";
import { getWorkspaceSymbols } from "./features/workspace-symbol";
import { getCompletions } from "./features/completion";
import { getHover } from "./features/hover";
import { findReferences } from "./features/references";
import { prepareRename, doRename } from "./features/rename";

let initialized = false;
let shuttingDown = false;
let rootUri = "";

function send(message: ResponseMessage | object): void {
  process.stdout.write(encode(message));
}

function sendResponse(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(
  id: number | string | null,
  code: number,
  message: string
): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

export function sendNotification(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

async function handleRequest(msg: RequestMessage): Promise<void> {
  if (msg.method === "initialize") {
    initialized = true;
    const params = msg.params as { rootUri?: string };
    rootUri = params.rootUri ?? "";
    sendResponse(msg.id, {
      capabilities: serverCapabilities,
      serverInfo: { name: "elm-land-lsp", version: "0.1.0" },
    });
    return;
  }

  if (!initialized) {
    sendError(msg.id, ErrorCodes.ServerNotInitialized, "Server not initialized");
    return;
  }

  switch (msg.method) {
    case "shutdown": {
      shuttingDown = true;
      sendResponse(msg.id, null);
      return;
    }

    case "textDocument/hover": {
      const params = msg.params as {
        textDocument: { uri: string };
        position: { line: number; character: number };
      };
      const result = await getHover(params.textDocument.uri, params.position);
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/completion": {
      const params = msg.params as {
        textDocument: { uri: string };
        position: { line: number; character: number };
      };
      const result = await getCompletions(params.textDocument.uri, params.position);
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/formatting": {
      const params = msg.params as {
        textDocument: { uri: string };
      };
      const result = await formatDocument(params.textDocument.uri);
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/documentSymbol": {
      const params = msg.params as {
        textDocument: { uri: string };
      };
      const result = await getDocumentSymbols(params.textDocument.uri);
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/definition": {
      const params = msg.params as {
        textDocument: { uri: string };
        position: { line: number; character: number };
      };
      const result = await getDefinition(
        params.textDocument.uri,
        params.position
      );
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/prepareRename": {
      const params = msg.params as {
        textDocument: { uri: string };
        position: { line: number; character: number };
      };
      const result = await prepareRename(params.textDocument.uri, params.position);
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/rename": {
      const params = msg.params as {
        textDocument: { uri: string };
        position: { line: number; character: number };
        newName: string;
      };
      const result = await doRename(
        params.textDocument.uri,
        params.position,
        params.newName
      );
      sendResponse(msg.id, result);
      return;
    }

    case "textDocument/references": {
      const params = msg.params as {
        textDocument: { uri: string };
        position: { line: number; character: number };
        context: { includeDeclaration: boolean };
      };
      const result = await findReferences(
        params.textDocument.uri,
        params.position,
        params.context?.includeDeclaration ?? true
      );
      sendResponse(msg.id, result);
      return;
    }

    case "workspace/symbol": {
      const params = msg.params as { query: string };
      const result = await getWorkspaceSymbols(params.query, rootUri);
      sendResponse(msg.id, result);
      return;
    }

    default: {
      sendError(msg.id, ErrorCodes.MethodNotFound, `Unknown method: ${msg.method}`);
    }
  }
}

async function handleNotification(msg: NotificationMessage): Promise<void> {
  if (msg.method === "exit") {
    process.exit(shuttingDown ? 0 : 1);
  }

  if (!initialized) return;

  switch (msg.method) {
    case "initialized":
      return;

    case "textDocument/didOpen": {
      const params = msg.params as {
        textDocument: { uri: string; text: string; version: number };
      };
      documentStore.open(
        params.textDocument.uri,
        params.textDocument.text,
        params.textDocument.version
      );
      runDiagnostics(params.textDocument.uri);
      return;
    }

    case "textDocument/didChange": {
      const params = msg.params as {
        textDocument: { uri: string; version: number };
        contentChanges: { text: string }[];
      };
      const text = params.contentChanges[params.contentChanges.length - 1]?.text;
      if (text !== undefined) {
        documentStore.change(params.textDocument.uri, text, params.textDocument.version);
      }
      return;
    }

    case "textDocument/didClose": {
      const params = msg.params as {
        textDocument: { uri: string };
      };
      documentStore.close(params.textDocument.uri);
      return;
    }

    case "textDocument/didSave": {
      const params = msg.params as {
        textDocument: { uri: string };
      };
      runDiagnostics(params.textDocument.uri);

      // If elm.json was saved, re-run diagnostics for all open files
      if (params.textDocument.uri.endsWith("elm.json")) {
        for (const doc of documentStore.all()) {
          if (doc.uri.endsWith(".elm")) runDiagnostics(doc.uri);
        }
      }
      return;
    }
  }
}

export async function startServer(): Promise<void> {
  let buffer: Uint8Array = new Uint8Array(0);
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      process.exit(0);
    }
    const merged = new Uint8Array(buffer.length + value.length);
    merged.set(buffer);
    merged.set(value, buffer.length);
    buffer = merged;

    let result = tryParse(Buffer.from(buffer));
    while (result.kind === "message") {
      const msg = result.value;
      buffer = new Uint8Array(result.rest);

      try {
        if (isRequest(msg)) {
          await handleRequest(msg);
        } else if (isNotification(msg)) {
          await handleNotification(msg);
        }
      } catch (err) {
        console.error("[server] Unhandled error:", err);
        if (isRequest(msg)) {
          sendError((msg as any).id, ErrorCodes.InternalError, String(err));
        }
      }

      result = tryParse(Buffer.from(buffer));
    }
  }

  reader.releaseLock();
}
