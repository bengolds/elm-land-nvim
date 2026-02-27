/// <reference lib="webworker" />
declare var self: Worker;

const workerPath = new URL("./worker.min.js", import.meta.url).pathname;
const workerSource = await Bun.file(workerPath).text();

// The compiled Elm app is an IIFE: (function(scope){ ... _Platform_export({...}) })(this)
// _Platform_export sets scope['Elm']. We provide a scope object for it to write to.
const scope: any = {};
const fn = new Function("scope", `(function(){ ${workerSource} }).call(scope);`);
fn(scope);

const Elm = scope.Elm;
const app = Elm.Worker.init();

app.ports.onSuccess.subscribe((ast: unknown) => {
  postMessage({ kind: "success", ast });
});

app.ports.onFailure.subscribe((error: string) => {
  postMessage({ kind: "failure", error });
});

self.onmessage = (event: MessageEvent<string>) => {
  app.ports.input.send(event.data);
};
