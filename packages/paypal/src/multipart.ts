/**
 * Minimal multipart/form-data encoder (RFC 7578). We build the body ourselves instead of using
 * FormData so the exact bytes are deterministic and testable, and so it runs anywhere fetch does.
 *
 * PayPal's Disputes API takes a JSON part named "input" (Content-Type: application/json) plus
 * file parts; see docs/PAYPAL_NOTES.md.
 */

export type MultipartPart = {
  name: string;
  data: Uint8Array | string;
  filename?: string;
  contentType?: string;
};

export type EncodedMultipart = {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  boundary: string;
};

/** WHATWG form-data escaping for names and filenames in Content-Disposition. */
function escapeQuoted(value: string): string {
  return value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

export function randomBoundary(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `----GoodFaithBoundary${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function encodeMultipart(parts: MultipartPart[], boundary: string = randomBoundary()): EncodedMultipart {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(part.name)}"`;
    if (part.filename !== undefined) head += `; filename="${escapeQuoted(part.filename)}"`;
    head += "\r\n";
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    head += "\r\n";
    chunks.push(encoder.encode(head));
    chunks.push(typeof part.data === "string" ? encoder.encode(part.data) : part.data);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}
