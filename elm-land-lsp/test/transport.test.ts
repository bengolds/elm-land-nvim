import { describe, test, expect } from "bun:test";
import { encode, tryParse } from "../src/protocol/transport";

describe("transport", () => {
  test("encode produces valid Content-Length header", () => {
    const buf = encode({ jsonrpc: "2.0", id: 1, method: "test" });
    const str = buf.toString();
    expect(str).toStartWith("Content-Length: ");
    expect(str).toContain("\r\n\r\n");
    const [header, body] = str.split("\r\n\r\n");
    const declaredLength = parseInt(header!.replace("Content-Length: ", ""));
    expect(declaredLength).toBe(Buffer.byteLength(body!));
  });

  test("tryParse decodes a complete message", () => {
    const original = { jsonrpc: "2.0", id: 42, method: "hello" };
    const buf = encode(original);
    const result = tryParse(buf);
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.value).toEqual(original);
      expect(result.rest.length).toBe(0);
    }
  });

  test("tryParse returns need-more for partial header", () => {
    const result = tryParse(Buffer.from("Content-Len"));
    expect(result.kind).toBe("need-more");
  });

  test("tryParse returns need-more for partial body", () => {
    const result = tryParse(Buffer.from('Content-Length: 100\r\n\r\n{"short'));
    expect(result.kind).toBe("need-more");
  });

  test("tryParse handles multiple messages in buffer", () => {
    const msg1 = encode({ id: 1 });
    const msg2 = encode({ id: 2 });
    const combined = Buffer.concat([msg1, msg2]);

    const r1 = tryParse(combined);
    expect(r1.kind).toBe("message");
    if (r1.kind === "message") {
      expect((r1.value as any).id).toBe(1);
      const r2 = tryParse(r1.rest);
      expect(r2.kind).toBe("message");
      if (r2.kind === "message") {
        expect((r2.value as any).id).toBe(2);
      }
    }
  });

  test("encode handles unicode correctly", () => {
    const original = { text: "こんにちは世界 🌍" };
    const buf = encode(original);
    const result = tryParse(buf);
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.value).toEqual(original);
    }
  });
});
