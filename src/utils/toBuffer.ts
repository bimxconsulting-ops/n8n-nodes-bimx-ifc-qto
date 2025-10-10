// src/utils/toBuffer.ts
export function toBuffer(
  data: string | ArrayBuffer | Uint8Array | Buffer | { data?: any }
): Buffer {
  if (Buffer.isBuffer(data)) return data;

  // n8n BinaryData-Objekte haben oft { data: 'base64...' }
  if (data && typeof data === 'object' && 'data' in data && (data as any).data) {
    const inner = (data as any).data;
    return toBuffer(inner);
  }

  if (typeof data === 'string') {
    // data:URI?
    const m = data.match(/^data:.*?;base64,(.*)$/i);
    if (m) return Buffer.from(m[1], 'base64');

    // wahrscheinlich Base64 (rudimentäre Heuristik)
    const base64ish = /^[A-Za-z0-9+/=\s]+$/;
    if (data.length % 4 === 0 && base64ish.test(data)) {
      try { return Buffer.from(data, 'base64'); } catch {}
    }
    // sonst als UTF-8
    return Buffer.from(data, 'utf8');
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  // Fallback – kann i.d.R. entfallen, schadet aber nicht
  return Buffer.from(data as any);
}
