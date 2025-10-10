// src/utils/toBuffer.ts

export function toBuffer(input: any): Buffer {
  if (!input) return Buffer.alloc(0);

  // Bereits ein Buffer?
  if (Buffer.isBuffer(input)) return input;

  // Uint8Array / ArrayBuffer
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));

  // n8n Binary-Objekt (üblich: { data: <base64>, ... })
  if (typeof input === 'object' && typeof input.data === 'string') {
    return Buffer.from(input.data, 'base64');
  }

  // Falls verpackt als { buffer | binary | content }
  if (typeof input === 'object') {
    const nested = (input as any).buffer ?? (input as any).binary ?? (input as any).content;
    if (nested) return toBuffer(nested);
  }

  // String: versuche base64, sonst raw
  if (typeof input === 'string') {
    try {
      return Buffer.from(input, 'base64');
    } catch {
      return Buffer.from(input);
    }
  }

  throw new Error('Unsupported input for toBuffer()');
}
