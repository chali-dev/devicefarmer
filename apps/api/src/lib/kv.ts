/** Parses `key=value` lines (shell script output); the first `=` splits, keys and values are trimmed. */
export function parseKv(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const l of out.split(/\r?\n/)) {
    const i = l.indexOf('=');
    if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return kv;
}
