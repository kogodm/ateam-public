import type { GitLogCommitDTO, WorkspaceInfoDTO } from '@ateam/contract';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiffModal } from './DiffModal';
import { GRAPH_PALETTE, type GraphRow, layoutGraph } from './gitGraph';
import type { Rpc } from './rpc';

/** '2026-07-09T10:30:00+08:00' → '2h', '3d', 'Jun 12' … (JetBrains-ish). */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Classify a %D decoration for chip styling. */
function refChip(ref: string): { label: string; cls: string } {
  if (ref.startsWith('HEAD -> ')) return { label: ref.slice(8), cls: 'head' };
  if (ref === 'HEAD') return { label: 'HEAD', cls: 'head' };
  if (ref.startsWith('tag: ')) return { label: ref.slice(5), cls: 'tag' };
  if (ref.includes('/')) return { label: ref, cls: 'remote' };
  return { label: ref, cls: 'local' };
}

const STATUS_CLS: Record<string, string> = { A: 'add', M: 'mod', D: 'del', R: 'ren', C: 'ren' };

// --- commit-graph rendering (lane layout from gitGraph.ts) ---
const LANE_W = 11; // px per lane column
const ROW_H = 36; // viewBox height; the svg stretches to the real row height
const MAX_LANES = 10; // clip extreme graphs instead of squeezing the subject
const gx = (lane: number): number => lane * LANE_W + LANE_W / 2;

/** One row's slice of the commit graph: colored branch edges + the node dot.
 *  Curves: 'in' edges arrive from the top and flatten into the node's center;
 *  'out' edges leave the center and straighten toward the bottom — same
 *  quadratic style Git Graph uses. preserveAspectRatio=none lets the fixed
 *  viewBox stretch to whatever height the row's text actually takes. */
function GraphCell({ row, cols }: { row: GraphRow; cols: number }): JSX.Element {
  const w = cols * LANE_W;
  const mid = ROW_H / 2;
  const color = (i: number): string => GRAPH_PALETTE[i % GRAPH_PALETTE.length] as string;
  return (
    <span className="glog-graph" style={{ width: w }}>
      <svg
        width={w}
        height="100%"
        viewBox={`0 0 ${w} ${ROW_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {row.segs.map((s, i) => {
          const xf = gx(s.from);
          const xt = gx(s.to);
          let d: string;
          if (s.kind === 'pass') {
            d = `M ${xf} 0 L ${xf} ${ROW_H}`;
          } else if (s.kind === 'in') {
            d = xf === xt ? `M ${xf} 0 L ${xf} ${mid}` : `M ${xf} 0 Q ${xf} ${mid} ${xt} ${mid}`;
          } else {
            d =
              xf === xt
                ? `M ${xf} ${mid} L ${xf} ${ROW_H}`
                : `M ${xf} ${mid} Q ${xt} ${mid} ${xt} ${ROW_H}`;
          }
          return (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are stable per row
              key={i}
              d={d}
              fill="none"
              stroke={color(s.color)}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          );
        })}
        {row.merge ? (
          <circle
            cx={gx(row.lane)}
            cy={mid}
            r={3}
            fill="var(--panel)"
            stroke={color(row.color)}
            strokeWidth={1.8}
          />
        ) : (
          <circle cx={gx(row.lane)} cy={mid} r={3.4} fill={color(row.color)} />
        )}
      </svg>
    </span>
  );
}

/** JetBrains-style git pane: branch + working-tree changes on top, commit
 *  log below (rail + dot, ref chips, subject, author · age · short hash).
 *  Clicking a commit expands the files it touched. */
export function GitPane({
  rpc,
  dir: baseDir,
  onOpenPath,
}: {
  rpc: Rpc;
  dir: string;
  onOpenPath?: (path: string) => void;
}): JSX.Element {
  // The opened dir may not be a git repo itself but hold several (a parent
  // folder of projects). `repos` are the switch targets discovered from
  // baseDir; `dir` is the repo the views below actually operate on — every
  // git call uses it. It defaults to baseDir, or the first sub-repo when
  // baseDir isn't a repo. null repos = not yet discovered.
  const [dir, setDir] = useState(baseDir);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [ws, setWs] = useState<WorkspaceInfoDTO | null>(null);
  const [commits, setCommits] = useState<GitLogCommitDTO[] | null>(null);
  const [remotes, setRemotes] = useState<{ name: string; url: string }[]>([]);
  const [branchInfo, setBranchInfo] = useState<{ current: string; branches: string[] }>({
    current: '',
    branches: [],
  });
  const [worktrees, setWorktrees] = useState<
    { path: string; head: string; branch?: string; bare: boolean; detached: boolean }[]
  >([]);
  const [gitNote, setGitNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<
    Map<string, { status: string; path: string }[]>
  >(new Map());
  const [diff, setDiff] = useState<{
    title: string;
    text: string;
    truncated: boolean;
    image?: { before?: string; after?: string; mime: string };
  } | null>(null);
  // log is collapsed by default — the working tree is the everyday view
  const [logOpen, setLogOpen] = useState(false);

  // clicking a file anywhere in the git pane means "show me the change",
  // not "open the file" — working tree diffs against HEAD, log entries
  // against their own commit.
  const showDiff = useCallback(
    (path: string, hash?: string) => {
      void rpc
        .request('workspace.diff', { dir, path, hash })
        .then((r) =>
          setDiff({
            title: hash ? `${path} @ ${hash.slice(0, 7)}` : path,
            text: r.diff,
            truncated: r.truncated,
            image: r.image,
          }),
        )
        .catch(() => {});
    },
    [rpc, dir],
  );

  // Discover the repos under baseDir and point the pane at the right one.
  useEffect(() => {
    setDir(baseDir);
    void rpc
      .request('workspace.repos', { dir: baseDir })
      .then((r) => {
        setRepos(r.repos);
        const first = r.repos[0];
        // baseDir isn't itself a repo but holds some → show the first.
        if (first && !r.repos.includes(baseDir)) setDir(first);
      })
      .catch(() => setRepos([]));
  }, [rpc, baseDir]);

  useEffect(() => {
    void rpc.request('workspace.info', { dir }).then((r) => setWs(r.info)).catch(() => {});
    void rpc
      .request('workspace.gitLog', { dir, limit: 100 })
      .then((r) => setCommits(r.commits))
      .catch(() => setCommits([]));
  }, [rpc, dir]);

  const loadGitMeta = useCallback(() => {
    void rpc.request('workspace.remotes', { dir }).then((r) => setRemotes(r.remotes)).catch(() => {});
    void rpc.request('workspace.branches', { dir }).then(setBranchInfo).catch(() => {});
    void rpc
      .request('workspace.worktrees', { dir })
      .then((r) => setWorktrees(r.worktrees))
      .catch(() => {});
  }, [rpc, dir]);
  useEffect(() => {
    loadGitMeta();
  }, [loadGitMeta]);

  const checkout = useCallback(
    (branch: string) => {
      if (!branch || branch === branchInfo.current || busy) return;
      setBusy(true);
      setGitNote('');
      void rpc
        .request('workspace.checkout', { dir, branch })
        .then((r) => {
          if (!r.ok) {
            setGitNote(r.err ?? 'Checkout failed');
            return;
          }
          setGitNote(`Switched to ${branch}`);
          void rpc.request('workspace.info', { dir, fresh: true }).then((x) => setWs(x.info));
          void rpc
            .request('workspace.gitLog', { dir, limit: 100 })
            .then((x) => setCommits(x.commits))
            .catch(() => {});
          loadGitMeta();
        })
        .catch((e) => setGitNote(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [rpc, dir, branchInfo.current, busy, loadGitMeta],
  );

  const toggleCommit = useCallback(
    (hash: string) => {
      setOpenHash((cur) => (cur === hash ? null : hash));
      if (!commitFiles.has(hash)) {
        void rpc
          .request('workspace.commitFiles', { dir, hash })
          .then((r) =>
            setCommitFiles((m) => {
              const n = new Map(m);
              n.set(hash, r.files);
              return n;
            }),
          )
          .catch(() => {});
      }
    },
    [rpc, dir, commitFiles],
  );

  // branch-graph lane layout — recomputed only when the log itself changes.
  // Column count is uniform across rows (the widest row wins, capped) so the
  // subject text stays aligned down the whole list.
  const graph = useMemo(() => (commits ? layoutGraph(commits) : []), [commits]);
  const graphCols = useMemo(
    () => Math.min(MAX_LANES, Math.max(1, ...graph.map((r) => r.width))),
    [graph],
  );

  if (
    commits !== null &&
    commits.length === 0 &&
    ws &&
    !ws.git &&
    repos !== null &&
    repos.length === 0
  ) {
    return <div className="muted small">not a git repo</div>;
  }

  // Show the repo switcher when there's a real choice: several sub-repos, or a
  // single one that isn't the opened dir (i.e. we auto-descended into it).
  const showRepoSwitcher =
    !!repos && (repos.length > 1 || (repos.length === 1 && repos[0] !== baseDir));
  const repoLabel = (p: string): string =>
    p === baseDir
      ? baseDir.split('/').pop() || baseDir
      : p.startsWith(`${baseDir}/`)
        ? p.slice(baseDir.length + 1)
        : p.split('/').pop() || p;

  return (
    <div className="git-pane">
      {/* everything above the Log scrolls on its own; the Log toggle stays
          pinned at the panel's bottom edge even when Changes is long (#13) */}
      <div className="git-scroll">
      {showRepoSwitcher && (
        <div className="status-section">
          <div className="ws-branch">
            <span className="git-ico" title="Repository">
              ▤
            </span>
            <select
              className="git-branch-select"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              title="Switch repository"
            >
              {repos?.map((r) => (
                <option key={r} value={r}>
                  {repoLabel(r)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {ws?.git && (
        <div className="status-section">
          <div className="ws-branch">
            <span className="git-ico">⎇</span>
            <select
              className="git-branch-select"
              value={branchInfo.current}
              disabled={busy}
              onChange={(e) => checkout(e.target.value)}
              title="Switch branch"
            >
              {!branchInfo.current && <option value="">(detached HEAD)</option>}
              {branchInfo.current && !branchInfo.branches.includes(branchInfo.current) && (
                <option value={branchInfo.current}>{branchInfo.current}</option>
              )}
              {branchInfo.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <span className="muted ws-aheadbehind">
              ↑{ws.git.ahead} ↓{ws.git.behind}
            </span>
          </div>
          {remotes.length > 0 && (
            <button
              type="button"
              className="git-remote mono"
              title={`Click to copy · ${remotes.map((r) => `${r.name}: ${r.url}`).join('\n')}`}
              onClick={() => {
                void import('@tauri-apps/plugin-clipboard-manager')
                  .then((m) => m.writeText(remotes[0]?.url ?? ''))
                  .then(() => setGitNote('Remote URL copied'))
                  .catch(() => {});
              }}
            >
              <span className="git-remote-name muted">{remotes[0]?.name}</span>
              <span className="git-remote-url">{remotes[0]?.url}</span>
              {remotes.length > 1 && <span className="muted"> +{remotes.length - 1}</span>}
            </button>
          )}
          {gitNote && <div className="git-note muted small">{gitNote}</div>}
          <div className="status-section-title">
            Changes{ws.git.files.length > 0 && ` (${ws.git.files.length})`}
          </div>
          {ws.git.files.slice(0, 40).map((f) => {
            // porcelain XY → one letter: untracked reads as A (new file)
            const st = f.xy === '??' ? 'A' : (f.xy.trim()[0] ?? 'M');
            const cls = st === 'A' ? 'add' : st === 'M' ? 'mod' : st === 'D' ? 'del' : '';
            return (
              <button
                key={f.path}
                type="button"
                className="rec mono path-link chg-row"
                onClick={() => showDiff(f.path)}
                title={`diff vs HEAD · ${f.path}`}
              >
                <span className={`chg-status ${cls}`}>{st}</span> {f.path}
              </button>
            );
          })}
          {ws.git.files.length === 0 && <div className="muted small">working tree clean</div>}
        </div>
      )}
      {worktrees.length > 1 && (
        <div className="status-section">
          <div className="status-section-title">Worktrees ({worktrees.length})</div>
          {worktrees.map((w) => {
            const label = w.branch
              ? w.branch
              : w.detached
                ? `detached ${w.head.slice(0, 7)}`
                : w.bare
                  ? '(bare)'
                  : '—';
            const isCur = w.path === dir.replace(/\/+$/, '');
            return (
              <button
                key={w.path}
                type="button"
                className={`rec mono path-link wt-row${isCur ? ' cur' : ''}`}
                onClick={() => onOpenPath?.(w.path)}
                title={`Open in Files · ${w.path}`}
              >
                <span className="wt-branch">
                  ⎇ {label}
                  {isCur && <span className="wt-cur"> ●</span>}
                </span>
                <span className="wt-path muted">{w.path}</span>
              </button>
            );
          })}
        </div>
      )}
      </div>
      {/* pinned to the panel's bottom edge — expanding truly rises from
          the bottom instead of dangling mid-air under Changes */}
      <div className="status-section glog-section">
        <button
          type="button"
          className="status-section-title glog-toggle"
          onClick={() => setLogOpen((v) => !v)}
          title={logOpen ? 'Collapse log' : 'Expand log'}
        >
          <span className="tree-twirl">{logOpen ? '▾' : '▸'}</span>
          Log
          {commits !== null && <span className="glog-n">{commits.length}</span>}
        </button>
        <div className={`glog-wrap${logOpen ? ' open' : ''}`}>
        <div className="glog">
          {(commits ?? []).map((c, ci) => {
            const open = openHash === c.hash;
            const files = commitFiles.get(c.hash);
            const row = graph[ci];
            return (
              <div key={c.hash} className="glog-item">
                <button
                  type="button"
                  className={`glog-row${open ? ' open' : ''}`}
                  onClick={() => toggleCommit(c.hash)}
                  title={`${c.hash}\n${c.subject}`}
                >
                  {row && <GraphCell row={row} cols={graphCols} />}
                  <span className="glog-main">
                    <span className="glog-subject">
                      {c.refs.map((r) => {
                        const chip = refChip(r);
                        return (
                          <em key={r} className={`glog-chip ${chip.cls}`}>
                            {chip.label}
                          </em>
                        );
                      })}
                      {c.subject}
                    </span>
                    <span className="glog-meta">
                      {c.author} · {relTime(c.at)} ·{' '}
                      <span className="mono">{c.hash.slice(0, 7)}</span>
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="glog-files" style={{ marginLeft: graphCols * LANE_W + 8 }}>
                    {!files && <div className="muted small">loading…</div>}
                    {files?.map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        className="rec mono path-link glog-file"
                        onClick={() => showDiff(f.path, c.hash)}
                        title={`diff @ ${c.hash.slice(0, 7)} · ${f.path}`}
                      >
                        <span className={`glog-status ${STATUS_CLS[f.status] ?? ''}`}>
                          {f.status}
                        </span>{' '}
                        {f.path}
                      </button>
                    ))}
                    {files && files.length === 0 && (
                      <div className="muted small">no files (merge?)</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {commits === null && <div className="muted small">loading…</div>}
          {commits !== null && commits.length === 0 && (
            <div className="muted small">no commits</div>
          )}
        </div>
        </div>
      </div>
      {diff && (
        <DiffModal
          title={diff.title}
          diff={diff.text}
          truncated={diff.truncated}
          image={diff.image}
          onClose={() => setDiff(null)}
        />
      )}
    </div>
  );
}
