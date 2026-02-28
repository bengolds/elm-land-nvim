import * as path from "path";
import { encode } from "../src/protocol/transport";

export const FIXTURES = path.resolve(import.meta.dir, "fixtures");
export const SMALL_PROJECT = path.join(FIXTURES, "small-project");
export const ELM_PKG_UNIVERSE = path.join(FIXTURES, "elm-package-universe");

export function fileUri(fsPath: string): string {
  return "file://" + fsPath;
}

export function fixtureUri(project: string, ...parts: string[]): string {
  return fileUri(path.join(project, ...parts));
}

export function fixturePath(project: string, ...parts: string[]): string {
  return path.join(project, ...parts);
}

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
  const pendingResponses = new Map<number, { resolve: (v: any) => void }>();
  let msgBuffer = "";
  let dead = false;

  // Single persistent read loop — never released
  (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { dead = true; break; }
        msgBuffer += new TextDecoder().decode(value);
        drainMessages();
      }
    } catch {
      dead = true;
    }
  })();

  function drainMessages() {
    while (true) {
      const match = msgBuffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!match) break;
      const headerEnd = msgBuffer.indexOf("\r\n\r\n") + 4;
      const contentLength = parseInt(match[1]!);
      if (msgBuffer.length < headerEnd + contentLength) break;
      const body = msgBuffer.slice(headerEnd, headerEnd + contentLength);
      msgBuffer = msgBuffer.slice(headerEnd + contentLength);

      const msg = JSON.parse(body);
      if ("id" in msg && pendingResponses.has(msg.id)) {
        const { resolve } = pendingResponses.get(msg.id)!;
        pendingResponses.delete(msg.id);
        resolve(msg.error ?? msg.result);
      }
      // Notifications (diagnostics etc.) are silently discarded
    }
  }

  function write(msg: object) {
    proc.stdin.write(encode(msg));
  }

  const client: LspClient = {
    async request(method, params) {
      if (dead) throw new Error("LSP process is dead");
      const id = ++idCounter;
      return new Promise((resolve, reject) => {
        pendingResponses.set(id, { resolve });
        write({ jsonrpc: "2.0", id, method, params });
        setTimeout(() => {
          if (pendingResponses.has(id)) {
            pendingResponses.delete(id);
            reject(new Error(`Request ${method} (id=${id}) timed out`));
          }
        }, 30000);
      });
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

  await client.request("initialize", {
    processId: null,
    capabilities: {},
    rootUri: fileUri(SMALL_PROJECT),
  });
  client.notify("initialized", {});

  return client;
}
