export type RequestMessage = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type NotificationMessage = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type ResponseMessage = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: ResponseError;
};

export type ResponseError = {
  code: number;
  message: string;
  data?: unknown;
};

export function isRequest(msg: unknown): msg is RequestMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    "method" in msg
  );
}

export function isNotification(msg: unknown): msg is NotificationMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    !("id" in msg) &&
    "method" in msg
  );
}

export type Position = { line: number; character: number };

export type Range = { start: Position; end: Position };

export type Location = { uri: string; range: Range };

export const enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export type Diagnostic = {
  range: Range;
  severity?: DiagnosticSeverity;
  source?: string;
  message: string;
};

export type TextEdit = {
  range: Range;
  newText: string;
};

export const enum SymbolKind {
  Function = 12,
  Variable = 13,
  Object = 19,
  Enum = 10,
  EnumMember = 22,
  Operator = 25,
}

export type DocumentSymbol = {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
};

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
} as const;
