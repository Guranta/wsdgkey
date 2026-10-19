const BEARER_RE = /Bearer\s+[^\s,;"']+/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{6,}\b/g;
const QUERY_SECRET_RE = /(access_token|api_key|apikey)=([^&\s]+)/gi;

function applySecrets(input: string, secrets: string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Remove tokens from text that might be logged or returned to the browser. */
export function scrubSecrets(input: string, secrets: string[], mode: "strict" | "body" = "body"): string {
  let out = applySecrets(input, secrets);
  out = out.replace(BEARER_RE, "Bearer [redacted]");
  out = out.replace(SK_RE, "sk-[redacted]");
  if (mode === "body") {
    out = out.replace(QUERY_SECRET_RE, "$1=[redacted]");
  }
  return out;
}

export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Log line that is safe to print. Query strings are dropped before scrubbing. */
export function safeLogLine(status: number | string, host: string, path: string): string {
  const clean = (value: string) => scrubSecrets(value.split("?")[0] ?? "", []).replace(/[\r\n]/g, "");
  return `[proxy] ${status} ${clean(host)} ${clean(path)}`;
}

export function scrubStream(stream: ReadableStream<Uint8Array>, secrets: string[]): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (lines.length === 0) return;
        controller.enqueue(encoder.encode(`${scrubSecrets(lines.join("\n"), secrets, "strict")}\n`));
      },
      flush(controller) {
        pending += decoder.decode();
        if (!pending) return;
        controller.enqueue(encoder.encode(scrubSecrets(pending, secrets, "strict")));
      },
    }),
  );
}
