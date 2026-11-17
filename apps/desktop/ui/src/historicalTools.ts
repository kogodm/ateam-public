export type HistoricalTurn = {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  kind?: string;
  toolUseId?: string;
  toolName?: string;
  label?: string;
};

export type ProjectedHistoricalTurn<T extends HistoricalTurn> = T & { historical?: boolean };

export function redactHistoricalSecrets(text: string): string {
  const secretKey =
    '[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[A-Za-z0-9_]*|API_KEY|TOKEN|PASSWORD|SECRET';
  return text
    .replace(/(\bAuthorization\s*[:=]\s*["']?Bearer\s+)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(
      new RegExp(
        `((?:["'](?:${secretKey})["']|\\b(?:${secretKey})\\b)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}"']+)`,
        'gi',
      ),
      (match, prefix: string, value: string) => {
        if (/^["']?TOKEN["']?\s*[:=]/i.test(prefix) && /^\d+$/.test(value)) return match;
        if (
          /\b(?:token_?count|(?:input|output|total|cached|prompt|completion)_tokens)\b/i.test(
            prefix,
          )
        )
          return match;
        const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
        return `${prefix}${quote}[REDACTED]${quote}`;
      },
    );
}

type Marker = { start: number; bodyStart: number; type: string; name: string };

function markersOf(text: string): Marker[] {
  const markers: Marker[] = [];
  let fence: { char: string; length: number } | undefined;
  let offset = 0;
  let previousBlank = false;
  for (const [lineIndex, rawLine] of text.split('\n').entries()) {
    const line = rawLine.replace(/\r$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const fenceRun = delimiter?.[1];
    const fenceSuffix = delimiter?.[2] ?? '';
    const fenceChar = fenceRun?.charAt(0);
    if (fence) {
      if (
        fenceRun &&
        fenceChar === fence.char &&
        fenceRun.length >= fence.length &&
        !fenceSuffix.trim()
      )
        fence = undefined;
    } else if (fenceRun && fenceChar && !(fenceChar === '`' && fenceSuffix.includes('`'))) {
      fence = { char: fenceChar, length: fenceRun.length };
    } else if (offset === 0 || (previousBlank && lineIndex > 1)) {
      const marker = /^\[Historical tool (call|result|record): ([^\]\r\n]+)\]$/.exec(line);
      const type = marker?.[1];
      const name = marker?.[2];
      if (type && name)
        markers.push({
          start: offset,
          bodyStart: Math.min(text.length, offset + rawLine.length + 1),
          type,
          name,
        });
    }
    previousBlank = line === '';
    offset += rawLine.length + 1;
  }
  return markers;
}

function decodedInput(body: string): { text: string; label?: string; remainder?: string } {
  let jsonEnd = body.length;
  if (body.startsWith('{') || body.startsWith('[')) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < body.length; index++) {
      const char = body[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) {
          jsonEnd = index + 1;
          break;
        }
      }
    }
  }
  const remainder = body.slice(jsonEnd);
  if (remainder.trim() && !/^\r?\n\r?\n/.test(remainder)) return { text: body };
  try {
    const input: unknown = JSON.parse(body.slice(0, jsonEnd));
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const object = input as Record<string, unknown>;
      const readableKey = ['command', 'cmd', 'file_path', 'path', 'filePath', 'query', 'url'].find(
        (key) => typeof object[key] === 'string' && object[key].length > 0,
      );
      const remaining = Object.fromEntries(
        Object.entries(object).filter(([key]) => key !== readableKey && key !== 'description'),
      );
      const extra = Object.keys(remaining).length ? JSON.stringify(remaining, null, 2) : '';
      return {
        text: readableKey
          ? `${object[readableKey]}${extra ? `\n\n${extra}` : ''}`
          : JSON.stringify(remaining, null, 2),
        label: typeof object.description === 'string' ? object.description : undefined,
        remainder,
      };
    }
    return { text: typeof input === 'string' ? input : JSON.stringify(input, null, 2), remainder };
  } catch {
    return { text: body };
  }
}

export function projectHistoricalTools<T extends HistoricalTurn>(
  turns: readonly T[],
): Array<ProjectedHistoricalTurn<T>> {
  return turns.flatMap((turn): Array<ProjectedHistoricalTurn<T>> => {
    if (turn.kind === 'tool_use' || turn.kind === 'tool_result') return [turn];
    if (!turn.text.includes('[Historical tool ')) return [turn];
    const markers = markersOf(turn.text);
    const firstMarker = markers[0];
    if (!firstMarker) return [turn];
    const parts: Array<ProjectedHistoricalTurn<T>> = [];
    const appendText = (text: string) => {
      if (text.trim()) parts.push({ ...turn, seq: turn.seq + parts.length / 1000, text });
    };
    appendText(turn.text.slice(0, firstMarker.start));
    for (const [index, marker] of markers.entries()) {
      const body = turn.text
        .slice(marker.bodyStart, markers[index + 1]?.start ?? turn.text.length)
        .trim();
      const decoded = marker.type === 'result' ? { text: body } : decodedInput(body);
      parts.push({
        ...turn,
        seq: turn.seq + parts.length / 1000,
        role: marker.type === 'result' ? 'tool' : 'assistant',
        kind: marker.type === 'result' ? 'tool_result' : 'tool_use',
        toolName: marker.type === 'result' ? undefined : redactHistoricalSecrets(marker.name),
        toolUseId: marker.type === 'result' ? redactHistoricalSecrets(marker.name) : undefined,
        label: decoded.label === undefined ? undefined : redactHistoricalSecrets(decoded.label),
        text: redactHistoricalSecrets(decoded.text),
        historical: true,
      });
      if (decoded.remainder) appendText(decoded.remainder);
    }
    return parts;
  });
}
