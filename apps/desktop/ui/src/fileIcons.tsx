/**
 * Minimal per-type file icons (JetBrains-flavored): one small stroke-based
 * glyph per file family, tinted by language/type. Used by the Panel Files
 * tree and the FileView directory listing so both read the same visual
 * language.
 */

type Kind =
  | 'folder'
  | 'code'
  | 'braces'
  | 'markdown'
  | 'image'
  | 'gear'
  | 'lock'
  | 'shell'
  | 'doc';

const LANG_COLOR: [RegExp, string][] = [
  [/\.(ts|tsx|mts|cts)$/i, '#4f9cd6'],
  [/\.(js|jsx|mjs|cjs)$/i, '#d9c15c'],
  [/\.(py|pyi)$/i, '#6aa5c9'],
  [/\.go$/i, '#56b8c8'],
  [/\.(rs|toml)$/i, '#c98d6b'],
  [/\.(java|kt|kts|gradle)$/i, '#c97f7f'],
  [/\.(c|h|cpp|hpp|cc|hh|m|mm|swift)$/i, '#8fa5c9'],
  [/\.(rb|erb)$/i, '#c96a6a'],
  [/\.(php)$/i, '#9a8fd0'],
  [/\.(css|scss|sass|less)$/i, '#7a86d6'],
  [/\.(html?|vue|svelte|astro)$/i, '#d8875a'],
  [/\.(lua|vim)$/i, '#7f9fd0'],
];

function kindFor(name: string, dir: boolean): { kind: Kind; color: string } {
  if (dir) return { kind: 'folder', color: '#7a9bd4' };
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|heic)$/.test(n))
    return { kind: 'image', color: '#b085c9' };
  if (/\.(md|markdown|mdx)$/.test(n)) return { kind: 'markdown', color: '#8aa8c9' };
  if (/(^|\.)(lock|lockb)$|^pnpm-lock\.yaml$|^package-lock\.json$|^cargo\.lock$/.test(n))
    return { kind: 'lock', color: '#9aa0a6' };
  if (/\.(json|jsonc|json5)$/.test(n)) return { kind: 'braces', color: '#d9c15c' };
  if (/\.(ya?ml|toml|ini|conf|cfg|properties|env)$|^\.env(\..+)?$|^dockerfile$|\.plist$/.test(n))
    return { kind: 'gear', color: '#9fae7f' };
  if (/\.(sh|zsh|bash|fish|bat|ps1|cmd)$/.test(n)) return { kind: 'shell', color: '#8fbf6f' };
  for (const [re, color] of LANG_COLOR) if (re.test(n)) return { kind: 'code', color };
  return { kind: 'doc', color: '#8a93a3' };
}

const PATHS: Record<Kind, JSX.Element> = {
  folder: (
    <path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3l1.6 1.8H13a1.5 1.5 0 0 1 1.5 1.5v6.2a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5V4.5Z" />
  ),
  code: <path d="M6 5 3 8l3 3M10 5l3 3-3 3" fill="none" />,
  braces: (
    <path
      d="M6 2.8c-1.4 0-1.8.7-1.8 1.7v1.3c0 .9-.5 1.5-1.4 1.7v1c.9.2 1.4.8 1.4 1.7v1.3c0 1 .4 1.7 1.8 1.7M10 2.8c1.4 0 1.8.7 1.8 1.7v1.3c0 .9.5 1.5 1.4 1.7v1c-.9.2-1.4.8-1.4 1.7v1.3c0 1-.4 1.7-1.8 1.7"
      fill="none"
    />
  ),
  markdown: (
    <path d="M2.2 11V5.2h1.6L5.6 8l1.8-2.8H9V11M11.6 5.2V9m0 0-1.5-1.6M11.6 9l1.5-1.6" fill="none" />
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.4" fill="none" />
      <circle cx="5.4" cy="6.4" r="1.1" />
      <path d="m3.4 11.6 3.2-3.4 2.4 2.4 1.8-1.8 2.4 2.6" fill="none" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" fill="none" />
      <path
        d="M8 2.6v1.8M8 11.6v1.8M2.6 8h1.8M11.6 8h1.8M4.2 4.2l1.3 1.3M10.5 10.5l1.3 1.3M11.8 4.2l-1.3 1.3M5.5 10.5l-1.3 1.3"
        fill="none"
      />
    </>
  ),
  lock: (
    <>
      <rect x="3.6" y="7" width="8.8" height="6.2" rx="1.2" fill="none" />
      <path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7" fill="none" />
    </>
  ),
  shell: (
    <>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.4" fill="none" />
      <path d="m4.4 6.4 2 1.8-2 1.8M8.4 10.4h3" fill="none" />
    </>
  ),
  doc: (
    <>
      <path d="M4 2.4h5.4L12 5v8.2a.9.9 0 0 1-.9.9H4.9a.9.9 0 0 1-.9-.9V3.3a.9.9 0 0 1 .9-.9Z" fill="none" />
      <path d="M9.2 2.6V5.2H11.8" fill="none" />
    </>
  ),
};

export function FileIcon({ name, dir }: { name: string; dir: boolean }): JSX.Element {
  const { kind, color } = kindFor(name, dir);
  const filled = kind === 'folder';
  return (
    <svg
      className="file-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color }}
      fill={filled ? 'currentColor' : 'currentColor'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={filled ? 0 : 1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[kind]}
    </svg>
  );
}
