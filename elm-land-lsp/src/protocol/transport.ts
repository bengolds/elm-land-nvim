const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH = "Content-Length: ";

export function encode(message: object): Buffer {
  const body = JSON.stringify(message);
  const header = `${CONTENT_LENGTH}${Buffer.byteLength(body)}${HEADER_SEPARATOR}`;
  return Buffer.concat([Buffer.from(header), Buffer.from(body)]);
}

export type ParseResult =
  | { kind: "message"; value: unknown; rest: Buffer }
  | { kind: "need-more" };

export function tryParse(buffer: Buffer): ParseResult {
  const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
  if (headerEnd === -1) return { kind: "need-more" };

  const header = buffer.subarray(0, headerEnd).toString();
  if (!header.startsWith(CONTENT_LENGTH)) return { kind: "need-more" };

  const contentLength = parseInt(header.slice(CONTENT_LENGTH.length), 10);
  if (isNaN(contentLength)) return { kind: "need-more" };

  const bodyStart = headerEnd + HEADER_SEPARATOR.length;
  const totalNeeded = bodyStart + contentLength;
  if (buffer.length < totalNeeded) return { kind: "need-more" };

  const body = buffer.subarray(bodyStart, totalNeeded).toString();
  const rest = buffer.subarray(totalNeeded);

  return { kind: "message", value: JSON.parse(body), rest };
}
