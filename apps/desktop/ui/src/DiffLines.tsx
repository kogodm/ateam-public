/** Classifies + renders unified-diff lines (add/del/hunk/file/meta tinting).
 *  Shared by DiffModal (the git panel's popup) and FileView (inline "recent
 *  changes" view) — same `.diff-line` styling either way. */
export function DiffLines({ diff }: { diff: string }): JSX.Element {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <>
      {lines.map((ln, i) => {
        const cls =
          ln.startsWith('+++') || ln.startsWith('---')
            ? 'file'
            : ln.startsWith('@@')
              ? 'hunk'
              : ln.startsWith('+')
                ? 'add'
                : ln.startsWith('-')
                  ? 'del'
                  : ln.startsWith('diff ') ||
                      ln.startsWith('index ') ||
                      ln.startsWith('new file') ||
                      ln.startsWith('deleted file') ||
                      ln.startsWith('rename ') ||
                      ln.startsWith('similarity ')
                    ? 'meta'
                    : '';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
          <div key={i} className={`diff-line ${cls}`}>
            {ln || ' '}
          </div>
        );
      })}
      {!diff.trim() && <div className="muted small">no changes</div>}
    </>
  );
}
