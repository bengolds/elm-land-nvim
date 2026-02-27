import * as path from "path";
import { encode } from "../src/protocol/transport";

export const FIXTURES = path.resolve(import.meta.dir, "fixtures");
export const SMALL_PROJECT = path.join(FIXTURES, "small-project");
export const NOREDINK_UI = path.join(FIXTURES, "noredink-ui");
export const NOREDINK_CATALOG = path.join(NOREDINK_UI, "component-catalog");

export function fileUri(fsPath: string): string {
  return "file://" + fsPath;
}

export function fixtureUri(project: string, ...parts: string[]): string {
  return fileUri(path.join(project, ...parts));
}

export function fixturePath(project: string, ...parts: string[]): string {
  return path.join(project, ...parts);
}

// --- LSP Client Harness ---

export type LspClient = {
  request(method: string, params: object): Promise<any>;
  notify(method: string, params: object): void;
  openFile(uri: string, text: string, version?: number): void;
  shutdown(): Promise<void>;
};

export async function startLsp(): Promise<LspClient> {
  const proc = Bun.spawn(
    ["bun", "run", path.resolve(import.meta.dir, "../bin/elm-land-lsp.ts")],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );

  let idCounter = 0;
  let readBuf = "";

  function write(msg: object) {
    proc.stdin.write(encode(msg));
  }

  // Read a single complete LSP message from stdout
  async function readMessage(): Promise<any> {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Process exited unexpectedly");
        readBuf += new TextDecoder().decode(value);

        while (true) {
          const match = readBuf.match(/Content-Length: (\d+)\r\n\r\n/);
          if (!match) break;
          const headerEnd = readBuf.indexOf("\r\n\r\n") + 4;
          const contentLength = parseInt(match[1]!);
          if (readBuf.length < headerEnd + contentLength) break;
          const body = readBuf.slice(headerEnd, headerEnd + contentLength);
          readBuf = readBuf.slice(headerEnd + contentLength);
          reader.releaseLock();
          return JSON.parse(body);
        }
      }
    } catch (e) {
      reader.releaseLock();
      throw e;
    }
  }

  // Read messages until we get a response with the given ID,
  // discarding any notifications along the way
  async function waitForResponse(id: number): Promise<any> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const msg = await Promise.race([
        readMessage(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out waiting for response id=${id}`)), deadline - Date.now())
        ),
      ]);
      if ("id" in msg && msg.id === id) {
        if (msg.error) return msg.error;
        return msg.result;
      }
      // Otherwise it's a notification (e.g., diagnostics) or wrong ID — discard it
    }
    throw new Error(`Timed out waiting for response id=${id}`);
  }

  const client: LspClient = {
    async request(method, params) {
      const id = ++idCounter;
      write({ jsonrpc: "2.0", id, method, params });
      return waitForResponse(id);
    },

    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },

    openFile(uri, text, version = 1) {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "elm", version, text },
      });
    },

    async shutdown() {
      try {
        await client.request("shutdown", {});
        client.notify("exit", {});
        await proc.exited;
      } catch {}
    },
  };

  // Initialize
  await client.request("initialize", {
    processId: null,
    capabilities: {},
    rootUri: fileUri(SMALL_PROJECT),
  });
  client.notify("initialized", {});

  return client;
}
