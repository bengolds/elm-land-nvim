import * as fs from "fs";
import { sendNotification } from "../server";
import { findElmJsonFor, uriToPath } from "../project/elm-json";
import type { Diagnostic, Range } from "../protocol/messages";
import { DiagnosticSeverity } from "../protocol/messages";

type ElmCompilerProblem = {
  title: string;
  region: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  message: (string | { string: string })[];
};

type CompileErrorsReport = {
  type: "compile-errors";
  errors: {
    path: string;
    name: string;
    problems: ElmCompilerProblem[];
  }[];
};

type GeneralErrorReport = {
  type: "error";
  path: string | null;
  title: string;
  message: (string | { string: string })[];
};

type ElmReport = CompileErrorsReport | GeneralErrorReport;

function formatMessage(
  title: string,
  parts: (string | { string: string })[]
): string {
  const body = parts
    .map((p) => (typeof p === "string" ? p : p.string))
    .join("");
  return `-- ${title} --\n\n${body}`;
}

function elmRegionToRange(region: ElmCompilerProblem["region"]): Range {
  return {
    start: { line: region.start.line - 1, character: region.start.column - 1 },
    end: { line: region.end.line - 1, character: region.end.column - 1 },
  };
}

function npxEnv(projectFolder: string): Record<string, string | undefined> {
  const parts = projectFolder.split("/").filter(Boolean);
  const binPaths: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    binPaths.push("/" + parts.slice(0, i).join("/") + "/node_modules/.bin");
  }
  return {
    ...process.env,
    PATH: [...binPaths, process.env.PATH].join(":"),
  };
}

let debounceTimers = new Map<string, Timer>();

export function runDiagnostics(uri: string): void {
  const existing = debounceTimers.get(uri);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    uri,
    setTimeout(() => {
      debounceTimers.delete(uri);
      runDiagnosticsNow(uri);
    }, 300)
  );
}

async function runDiagnosticsNow(uri: string): Promise<void> {
  let filePath = uriToPath(uri);
  try { filePath = fs.realpathSync(filePath); } catch {}
  const elmJson = await findElmJsonFor(filePath);
  if (!elmJson) return;

  try {
    const proc = Bun.spawn(
      ["elm", "make", filePath, "--output=/dev/null", "--report=json"],
      {
        cwd: elmJson.projectFolder,
        env: npxEnv(elmJson.projectFolder),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const allDiagnostics = new Map<string, Diagnostic[]>();

    if (stderr.trim()) {
      try {
        const report: ElmReport = JSON.parse(stderr);
        if (report.type === "compile-errors") {
          for (const error of report.errors) {
            let errorPath = error.path.startsWith("/")
              ? error.path
              : `${elmJson.projectFolder}/${error.path}`;
            try { errorPath = fs.realpathSync(errorPath); } catch {}
            const errorUri = `file://${errorPath}`;
            const diags: Diagnostic[] = error.problems.map((problem) => ({
              range: elmRegionToRange(problem.region),
              severity: DiagnosticSeverity.Error,
              source: "elm",
              message: formatMessage(problem.title, problem.message),
            }));
            allDiagnostics.set(errorUri, diags);
          }
        } else if (report.type === "error") {
          const diag: Diagnostic = {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: DiagnosticSeverity.Error,
            source: "elm",
            message: formatMessage(report.title, report.message),
          };
          allDiagnostics.set(uri, [diag]);
        }
      } catch {
        // Non-JSON stderr output, ignore
      }
    }

    // Publish diagnostics for the file that was saved
    // If no errors, publish empty diagnostics to clear previous ones
    if (!allDiagnostics.has(uri)) {
      allDiagnostics.set(uri, []);
    }

    for (const [diagUri, diags] of allDiagnostics) {
      sendNotification("textDocument/publishDiagnostics", {
        uri: diagUri,
        diagnostics: diags,
      });
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      sendNotification("window/showMessage", {
        type: 1, // Error
        message: 'elm binary not found. Install it with "npm install -g elm" or ensure it is on your PATH.',
      });
    }
  }
}
