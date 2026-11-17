const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/'
};

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Decode literal escape sequences that providers hand back inside an
 *  already-parsed string (e.g. "line1\\nline2"). */
export function decodeEscapedText(input: unknown): string {
  let s = input == null ? '' : String(input);
  for (let pass = 0; pass < 2 && s.includes('\\'); pass += 1) {
    const next = s.replace(
      /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrtbfv0"'\\/])/g,
      (match, seq: string) => {
        if (seq.startsWith('u{') && seq.endsWith('}')) {
          const cp = parseInt(seq.slice(2, -1), 16);
          return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
        }
        if (seq[0] === 'u' && seq.length === 5) {
          return String.fromCharCode(parseInt(seq.slice(1), 16));
        }
        if (seq[0] === 'x' && seq.length === 3) {
          return String.fromCharCode(parseInt(seq.slice(1), 16));
        }
        return SIMPLE_ESCAPES[seq] ?? match;
      }
    );
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Multi-line safe text: real newlines kept, control/zero-width junk removed. */
export function sanitizeMultiline(input: unknown): string {
  return decodeEscapedText(input)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** One-line safe text for titles: every break/control character becomes a
 *  single space so raw "\n", tabs and invisible marks never reach a title. */
export function sanitizeSingleLine(input: unknown): string {
  return sanitizeMultiline(input).replace(/\s+/g, ' ').trim();
}
