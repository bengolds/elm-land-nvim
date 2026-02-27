import type { Ast } from "./types";

type QueueItem = {
  source: string;
  resolve: (ast: Ast | undefined) => void;
};

type WorkerState =
  | { tag: "idle" }
  | { tag: "busy"; resolve: (ast: Ast | undefined) => void; queue: QueueItem[] };

let state: WorkerState = { tag: "idle" };
let worker: Worker;

function initWorker(): void {
  worker = new Worker(new URL("./worker.ts", import.meta.url).href);

  worker.onmessage = (event) => {
    if (state.tag !== "busy") return;

    const { resolve, queue } = state;
    const msg = event.data;

    if (msg.kind === "success") {
      resolve(msg.ast);
    } else {
      resolve(undefined);
    }

    if (queue.length > 0) {
      const next = queue[queue.length - 1]!;
      // Discard intermediate queued items — only process the latest
      for (let i = 0; i < queue.length - 1; i++) {
        queue[i]!.resolve(undefined);
      }
      state = { tag: "busy", resolve: next.resolve, queue: [] };
      worker.postMessage(next.source);
    } else {
      state = { tag: "idle" };
    }
  };

  worker.onerror = () => {
    if (state.tag === "busy") {
      state.resolve(undefined);
      const { queue } = state;
      state = { tag: "idle" };
      for (const item of queue) {
        item.resolve(undefined);
      }
    }
    // Re-init on next parse request
  };
}

initWorker();

export function parse(source: string): Promise<Ast | undefined> {
  return new Promise((resolve) => {
    if (state.tag === "idle") {
      state = { tag: "busy", resolve, queue: [] };
      worker.postMessage(source);
    } else {
      state.queue.push({ source, resolve });
    }
  });
}
