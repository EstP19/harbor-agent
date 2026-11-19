type RequestBodySource = AsyncIterable<Uint8Array | string> & { body?: unknown };

// Vercel can consume the incoming stream before invoking a function. Apply the
// same byte limit to its parsed body and to raw Node HTTP requests.
export async function readBoundedRequestBody(source: RequestBodySource, maxBytes: number): Promise<
  { ok: true; bodyText: string } | { ok: false; reason: 'too_large' | 'body_error' }
> {
  try {
    if (source.body !== undefined) {
      const bodyText = typeof source.body === 'string' ? source.body
        : Buffer.isBuffer(source.body) ? source.body.toString('utf8')
          : JSON.stringify(source.body);
      if (typeof bodyText !== 'string') return { ok: false, reason: 'body_error' };
      return Buffer.byteLength(bodyText, 'utf8') > maxBytes
        ? { ok: false, reason: 'too_large' } : { ok: true, bodyText };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) return { ok: false, reason: 'too_large' };
      chunks.push(bytes);
    }
    return { ok: true, bodyText: Buffer.concat(chunks).toString('utf8') };
  } catch {
    return { ok: false, reason: 'body_error' };
  }
}
