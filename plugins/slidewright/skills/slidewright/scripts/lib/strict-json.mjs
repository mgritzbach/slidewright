const MAX_JSON_BYTES = 1_000_000;
const MAX_JSON_DEPTH = 64;

export function parseStrictJson(bytes, { maxBytes = MAX_JSON_BYTES, maxDepth = MAX_JSON_DEPTH } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Strict JSON input must be bytes.");
  if (bytes.byteLength > maxBytes) throw new Error(`JSON input exceeds ${maxBytes} bytes.`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) {
    throw new Error("JSON input is not valid UTF-8.", { cause: error });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let index = 0;

  function fail(message) {
    throw new Error(`${message} at character ${index}.`);
  }

  function whitespace() {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  }

  function string() {
    if (text[index] !== '"') fail("Expected string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (code < 0x20) fail("Unescaped control character in string");
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/u.test(text[index])) fail("Invalid string escape");
        if (text[index] === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-f]{4}$/iu.test(hex)) fail("Invalid Unicode escape");
          index += 4;
        }
      }
      index += 1;
    }
    fail("Unterminated string");
  }

  function number() {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) fail("Invalid number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("Non-finite number");
    return value;
  }

  function value(depth) {
    if (depth > maxDepth) fail(`JSON nesting exceeds ${maxDepth}`);
    whitespace();
    const token = text[index];
    if (token === '"') return string();
    if (token === "{") return object(depth + 1);
    if (token === "[") return array(depth + 1);
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    if (token === "-" || /\d/u.test(token ?? "")) return number();
    fail("Unexpected JSON token");
  }

  function object(depth) {
    const result = {};
    const keys = new Set();
    index += 1;
    whitespace();
    if (text[index] === "}") { index += 1; return result; }
    while (index < text.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) fail(`Duplicate object key '${key}'`);
      keys.add(key);
      whitespace();
      if (text[index] !== ":") fail("Expected colon");
      index += 1;
      result[key] = value(depth);
      whitespace();
      if (text[index] === "}") { index += 1; return result; }
      if (text[index] !== ",") fail("Expected comma or object end");
      index += 1;
    }
    fail("Unterminated object");
  }

  function array(depth) {
    const result = [];
    index += 1;
    whitespace();
    if (text[index] === "]") { index += 1; return result; }
    while (index < text.length) {
      result.push(value(depth));
      whitespace();
      if (text[index] === "]") { index += 1; return result; }
      if (text[index] !== ",") fail("Expected comma or array end");
      index += 1;
    }
    fail("Unterminated array");
  }

  const result = value(0);
  whitespace();
  if (index !== text.length) fail("Trailing content after JSON value");
  return result;
}

export { MAX_JSON_BYTES, MAX_JSON_DEPTH };
