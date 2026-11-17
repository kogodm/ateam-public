import type {
  HumanDTO,
  HumanMarketItem,
  MarketSource,
  SkillMarketItem,
} from '@ateam/contract';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FoxWait } from './FoxWait';
import { avatarSrc } from './avatars';
import { ICONS } from './railIcons';
import type { Rpc } from './rpc';

type MarketTab = 'humans' | 'skills';

/** Top-N shown per remote source before searching (marketplace.json carries no
 *  install counts, so this is catalog order — search retrieves the full set). */
const REMOTE_TOPN = 40;

export function canConfirmSkillInstall(
  humanId: string,
  humanIds: readonly string[],
  busy: boolean,
): boolean {
  return !busy && humanId.length > 0 && humanIds.includes(humanId);
}

export function sourceRemovalNeedsConfirmation(sourceId: string, confirmedId: string): boolean {
  return sourceId !== confirmedId;
}

export function filterEnabledMarketSources(
  sources: readonly MarketSource[],
  sourceId: string,
): MarketSource[] {
  const enabled = sources.filter((source) => source.enabled);
  if (sourceId === 'all' || !enabled.some((source) => source.id === sourceId)) return enabled;
  return enabled.filter((source) => source.id === sourceId);
}

export function skillCardTags(category: string | undefined, tags: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const label = value.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    result.push(label);
  };

  if (category) add(category);
  let addedTags = 0;
  for (const tag of tags) {
    const before = result.length;
    add(tag);
    if (result.length > before) addedTags++;
    if (addedTags >= 2) break;
  }
  return result;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The Market — a full-screen store with two tabs:
 *   人力市场 (Human Market): prefab teammates grouped by industry → role.
 *   技能市场 (Skill Market): multi-source skill catalog. The builtin bundle is
 *     offline; marketplace sources (Claude 官方插件, Anthropic Skills, 社区…) are
 *     fetched dynamically when opened. Sources can be toggled (merge/switch,
 *     default merged), added by owner/repo, or discovered by the 7-day LLM
 *     sweep. Pick a teammate, then Install adds a skill to them.
 */
export function Market({
  rpc,
  onClose,
}: {
  rpc: Rpc;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<MarketTab>('skills');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [humansMarket, setHumansMarket] = useState<HumanMarketItem[]>([]);
  const [builtinSkills, setBuiltinSkills] = useState<SkillMarketItem[]>([]);
  const [team, setTeam] = useState<HumanDTO[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [target, setTarget] = useState('');
  const [rememberedTarget, setRememberedTarget] = useState('');
  const [installItem, setInstallItem] = useState<SkillMarketItem | null>(null);
  const [installError, setInstallError] = useState('');
  const [manageSourcesOpen, setManageSourcesOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState('');
  const [busy, setBusy] = useState('loading…');
  const [status, setStatus] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [newRepo, setNewRepo] = useState('');

  const loadSources = useCallback(async () => {
    const s = await rpc.request('skill.market.sources', {});
    setSources(s.sources);
  }, [rpc]);

  const load = useCallback(async () => {
    setBusy('Loading Skill Market…');
    setStatus('');
    setLoadFailed(false);
    try {
      const [hm, sm, t] = await Promise.all([
        rpc.request('human.market.list', {}),
        rpc.request('skill.market.list', {}), // no sourceId → builtin catalog
        rpc.request('human.list', {}),
      ]);
      setHumansMarket(hm.items);
      setBuiltinSkills(sm.items);
      setTeam(t.humans);
      setRememberedTarget((cur) => (t.humans.some((h) => h.id === cur) ? cur : ''));
      await loadSources();
    } catch (e) {
      setLoadFailed(true);
      setStatus(`Market load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }, [rpc, loadSources]);

  useEffect(() => {
    void load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const debouncedQ = useDebouncedValue(q, 250);

  // --- Human Market: filter then group by industry ---
  const humanGroups = useMemo(() => {
    const filtered = humansMarket.filter(
      (h) =>
        !q ||
        [h.name, h.title, h.role, h.description, ...h.tags].some((p) =>
          p?.toLowerCase().includes(q),
        ),
    );
    const map = new Map<string, HumanMarketItem[]>();
    for (const h of filtered) {
      const arr = map.get(h.industry) ?? [];
      arr.push(h);
      map.set(h.industry, arr);
    }
    return [...map.entries()];
  }, [humansMarket, q]);

  const hire = useCallback(
    async (item: HumanMarketItem) => {
      setBusy(`Adding ${item.title}…`);
      setStatus('');
      try {
        const r = await rpc.request('human.market.hire', { itemId: item.id });
        const t = await rpc.request('human.list', {});
        setTeam(t.humans);
        setStatus(`${r.human.name} joined · ${r.installedSkills} built-in skills installed`);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc],
  );

  const openInstallDialog = useCallback(
    (item: SkillMarketItem) => {
      setInstallItem(item);
      setTarget(team.some((h) => h.id === rememberedTarget) ? rememberedTarget : '');
      setInstallError('');
      setStatus('');
    },
    [team, rememberedTarget],
  );

  const closeInstallDialog = useCallback(() => {
    if (busy) return;
    setInstallItem(null);
    setTarget('');
    setInstallError('');
  }, [busy]);

  const closeSourcesDialog = useCallback(() => {
    if (busy) return;
    setManageSourcesOpen(false);
    setConfirmRemoveId('');
  }, [busy]);

  useEffect(() => {
    if (!installItem && !manageSourcesOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      if (manageSourcesOpen) closeSourcesDialog();
      else closeInstallDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [installItem, manageSourcesOpen, busy, closeInstallDialog, closeSourcesDialog]);

  const install = useCallback(async () => {
    if (!installItem || !canConfirmSkillInstall(target, team.map((h) => h.id), !!busy)) return;
    const item = installItem;
    const humanId = target;
    setBusy(`Installing ${item.name}…`);
    setStatus('');
    setInstallError('');
    try {
      const r = await rpc.request('skill.market.install', {
        humanId,
        itemId: item.id,
        sourceId: item.sourceId ?? 'builtin',
      });
      const who = team.find((h) => h.id === humanId)?.name ?? 'the teammate';
      setRememberedTarget(humanId);
      setStatus(
        r.imported > 0
          ? `Installed ${item.name} for ${who} (${r.imported} units)`
          : `${item.name} has nothing installable or is already there`,
      );
      setInstallItem(null);
      setTarget('');
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [rpc, installItem, target, team, busy]);

  const toggleSource = useCallback(
    async (s: MarketSource) => {
      if (s.id === 'builtin' || busy) return;
      setBusy(`Updating ${s.name}…`);
      setStatus('');
      try {
        await rpc.request('skill.market.setSourceEnabled', { id: s.id, enabled: !s.enabled });
        await loadSources();
        setStatus(`${s.name} ${s.enabled ? 'disabled' : 'enabled'}`);
      } catch (e) {
        setStatus(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy('');
      }
    },
    [rpc, loadSources, busy],
  );

  const removeSource = useCallback(
    async (s: MarketSource) => {
      if (busy || s.id === 'builtin') return;
      setBusy(`Removing ${s.name}…`);
      setStatus('');
      try {
        await rpc.request('skill.market.removeSource', { id: s.id });
        await loadSources();
        setConfirmRemoveId('');
        setStatus(`Source ${s.name} removed`);
      } catch (e) {
        setStatus(`Remove failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy('');
      }
    },
    [rpc, loadSources, busy],
  );

  const addSource = useCallback(async () => {
    const repo = newRepo.trim();
    if (!repo || busy) return;
    setBusy(`Checking ${repo}…`);
    setStatus('');
    try {
      await rpc.request('skill.market.addSource', { repo });
      setNewRepo('');
      await loadSources();
      setStatus(`Source ${repo} added`);
    } catch (e) {
      setStatus(`Add failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }, [rpc, newRepo, loadSources, busy]);

  const discover = useCallback(async () => {
    if (busy) return;
    setBusy('Discovering new marketplaces online… (this can take a moment)');
    setStatus('');
    try {
      const r = await rpc.request('skill.market.discover', {});
      await loadSources();
      setStatus(
        r.added.length
          ? `Found ${r.added.length} new marketplace(s) — added, off by default; enable them in Manage sources`
          : 'No new marketplaces found',
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [rpc, loadSources, busy]);

  const enabledSources = sources.filter((s) => s.enabled);
  const visibleSources = filterEnabledMarketSources(sources, sourceFilter);

  useEffect(() => {
    if (sourceFilter !== 'all' && !sources.some((source) => source.id === sourceFilter && source.enabled)) {
      setSourceFilter('all');
    }
  }, [sources, sourceFilter]);

  return (
    <div className="settings market">
      <aside className="settings-rail">
        <button type="button" className="rail-back" onClick={onClose}>
          ← Back
        </button>
        <nav className="rail-nav">
          <button
            type="button"
            className={tab === 'humans' ? 'on' : ''}
            onClick={() => setTab('humans')}
          >
            <span className="icon">{ICONS.team}</span>
            <span>Human Market</span>
          </button>
          <button
            type="button"
            className={tab === 'skills' ? 'on' : ''}
            onClick={() => setTab('skills')}
          >
            <span className="icon">{ICONS.puzzle}</span>
            <span>Skill Market</span>
          </button>
        </nav>
      </aside>

      <main className="settings-body market-body">
        <div className="market-head">
          <h1 className="page-title">{tab === 'humans' ? 'Human Market' : 'Skill Market'}</h1>
          <p className="section-sub">
            {tab === 'humans'
              ? 'Prefab teammates by industry and role — each ships with baseline skills; add one to your team in a click.'
              : 'Built-in skills work offline; remote marketplaces are fetched when opened. Review a skill and choose a teammate before installing.'}
          </p>
          <div className="market-tools">
            <input
              className="market-search"
              placeholder={tab === 'humans' ? 'Search roles / skills / industries…' : 'Search skills / tags…'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {tab === 'skills' && query && (
              <button type="button" className="market-search-clear" onClick={() => setQuery('')}>
                Clear
              </button>
            )}
            {tab === 'skills' && (
              <label className="market-source-filter">
                <span>Source</span>
                <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                  <option value="all">All sources</option>
                  {enabledSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.id === 'builtin' ? 'Built-in' : source.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Source management stays separate from browsing and installing skills. */}
          {tab === 'skills' && (
            <div className="market-source-toolbar">
              <button
                type="button"
                className="market-manage-sources"
                disabled={!!busy}
                onClick={() => {
                  setConfirmRemoveId('');
                  if (!loadFailed) setStatus('');
                  setManageSourcesOpen(true);
                }}
              >
                Manage sources <span>{enabledSources.length} active</span>
              </button>
            </div>
          )}

          {(status || busy) && (
            <div className="market-status">
              {busy && !status ? (
                <span className="wait-row">
                  <FoxWait size={16} /> {busy}
                </span>
              ) : (
                status || busy
              )}
              {loadFailed && !busy && (
                <button type="button" onClick={() => void load()}>
                  Retry
                </button>
              )}
            </div>
          )}
        </div>

        <div className="market-results">
          {/* ---------------- Human Market ---------------- */}
          {tab === 'humans' && (
            <div className="market-groups">
              {humanGroups.map(([industry, items]) => (
                <section key={industry} className="market-group">
                  <h3 className="market-group-title">
                    {industry} <span className="muted small">· {items.length}</span>
                  </h3>
                  <div className="market-grid">
                    {items.map((h) => (
                      <div key={h.id} className="market-card">
                        <div className="market-card-head">
                          <img className="person-avatar" src={avatarSrc(h.avatarId)} alt="" />
                          <div className="market-card-id">
                            <b>{h.title}</b>
                            <span className="role-tag">{h.role}</span>
                          </div>
                        </div>
                        <p className="market-card-desc">{h.description}</p>
                        <div className="market-chips">
                          {h.skillIds.map((s) => (
                            <span key={s} className="market-chip" title="Built-in skill">
                              {builtinSkills.find((x) => x.id === s)?.name ?? s}
                            </span>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="primary market-go"
                          disabled={!!busy}
                          onClick={() => void hire(h)}
                        >
                          ＋ Add to team
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {humanGroups.length === 0 && (
                <div className="muted center pad">{busy || 'No matching roles'}</div>
              )}
            </div>
          )}

          {/* ---------------- Skill Market (multi-source) ---------------- */}
          {tab === 'skills' && (
            <div className="market-groups">
              {visibleSources.map((s) => (
                <SourceSkills
                  key={s.id}
                  rpc={rpc}
                  source={s}
                  query={debouncedQ}
                  disabled={!!busy}
                  onInstall={openInstallDialog}
                />
              ))}
              {enabledSources.length === 0 && (
                <div className="muted center pad">No sources enabled — manage sources to enable one, or add a source</div>
              )}
            </div>
          )}
        </div>
      </main>
      {manageSourcesOpen && (
        <div
          className="modal-bg market-sources-modal-bg"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeSourcesDialog();
          }}
        >
          <section
            className="modal market-sources-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="market-sources-title"
          >
            <header className="market-sources-head">
              <h3 id="market-sources-title">Manage skill sources</h3>
              <button
                type="button"
                className="market-install-close"
                title="Close"
                aria-label="Close source manager"
                disabled={!!busy}
                onClick={closeSourcesDialog}
              >
                ×
              </button>
            </header>
            <div className="market-source-list">
              {sources.map((source) => (
                <div className="market-source-row" key={source.id}>
                  <div className="market-source-info">
                    <strong>{source.id === 'builtin' ? 'Built-in' : source.name}</strong>
                    <span>
                      {source.id === 'builtin' ? 'Offline catalog' : source.repo ?? 'Marketplace'}
                      {source.discovered && <em className="market-src-new">New</em>}
                    </span>
                  </div>
                  <label className="market-source-enabled">
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      disabled={source.id === 'builtin' || !!busy}
                      onChange={() => void toggleSource(source)}
                    />
                    <span>{source.enabled ? 'Enabled' : 'Disabled'}</span>
                  </label>
                  {source.id !== 'builtin' && (
                    <div className="market-source-remove-actions">
                      <button
                        type="button"
                        className="market-source-remove"
                        disabled={!!busy}
                        onClick={() => {
                          if (sourceRemovalNeedsConfirmation(source.id, confirmRemoveId)) {
                            setConfirmRemoveId(source.id);
                          } else {
                            void removeSource(source);
                          }
                        }}
                      >
                        {confirmRemoveId === source.id ? 'Confirm remove' : 'Remove'}
                      </button>
                      {confirmRemoveId === source.id && (
                        <button
                          type="button"
                          className="market-source-cancel-remove"
                          disabled={!!busy}
                          onClick={() => setConfirmRemoveId('')}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <form
              className="market-source-actions"
              onSubmit={(event) => {
                event.preventDefault();
                void addSource();
              }}
            >
              <label htmlFor="market-source-repo">Add a marketplace</label>
              <div className="market-source-add-row">
                <input
                  id="market-source-repo"
                  placeholder="owner/repo"
                  value={newRepo}
                  onChange={(event) => setNewRepo(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!!busy}
                />
                <button type="submit" disabled={!newRepo.trim() || !!busy}>
                  Add source
                </button>
              </div>
              <button
                type="button"
                className="market-discover"
                onClick={() => void discover()}
                disabled={!!busy}
                title="Discover new skill marketplaces online (also runs automatically every 7 days)"
              >
                Discover marketplaces
              </button>
            </form>
            {status && (
              <div className="market-source-status" role="status" aria-live="polite">
                {status}
                {loadFailed && !busy && (
                  <button type="button" onClick={() => void load()}>
                    Retry loading
                  </button>
                )}
              </div>
            )}
            {busy && (
              <div className="market-source-busy" role="status" aria-live="polite">
                {busy}
              </div>
            )}
            <footer className="market-source-footer">
              <button type="button" disabled={!!busy} onClick={closeSourcesDialog}>
                Close
              </button>
            </footer>
          </section>
        </div>
      )}
      {installItem && (
        <div
          className="modal-bg market-install-modal-bg"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeInstallDialog();
          }}
        >
          <section
            className="modal market-install-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="market-install-title"
          >
            <header className="market-install-head">
              <h3 id="market-install-title">Install skill</h3>
              <button
                type="button"
                className="market-install-close"
                title="Close"
                aria-label="Close install dialog"
                disabled={!!busy}
                onClick={closeInstallDialog}
              >
                ×
              </button>
            </header>
            <div className="market-install-details">
              <strong>{installItem.name}</strong>
              <p className="market-card-desc">{installItem.description}</p>
              <dl>
                <div>
                  <dt>Source</dt>
                  <dd>
                    {installItem.sourceId === 'builtin'
                      ? 'Built-in'
                      : sources.find((s) => s.id === (installItem.sourceId ?? 'builtin'))?.name ??
                        installItem.sourceId ??
                        'Built-in'}
                  </dd>
                </div>
                <div>
                  <dt>Author</dt>
                  <dd>{installItem.author || 'Not listed'}</dd>
                </div>
              </dl>
            </div>
            <form
              className="market-install-form"
              onSubmit={(event) => {
                event.preventDefault();
                void install();
              }}
            >
              {team.length > 0 ? (
                <>
                  <label htmlFor="market-install-human">Install to</label>
                  <select
                    id="market-install-human"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    disabled={!!busy}
                    required
                  >
                    <option value="">Choose a teammate</option>
                    {team.map((human) => (
                      <option key={human.id} value={human.id}>
                        {human.name} · {human.role}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <div className="market-install-empty">
                  <p>No teammates yet. Add a Human before installing a skill.</p>
                  <button
                    type="button"
                    onClick={() => {
                      closeInstallDialog();
                      setTab('humans');
                    }}
                  >
                    Browse Human Market
                  </button>
                </div>
              )}
              {installError && (
                <em className="field-flag" role="alert">
                  {installError}
                </em>
              )}
              <footer className="market-install-actions">
                <button type="button" disabled={!!busy} onClick={closeInstallDialog}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={!canConfirmSkillInstall(target, team.map((h) => h.id), !!busy)}
                >
                  {busy ? 'Installing…' : 'Install to teammate'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

/** One source's skill list — fetched lazily (dynamic) whenever it becomes
 *  visible or the query changes. Remote sources show Top-N until searched. */
function SourceSkills({
  rpc,
  source,
  query,
  disabled,
  onInstall,
}: {
  rpc: Rpc;
  source: MarketSource;
  query: string;
  disabled: boolean;
  onInstall: (item: SkillMarketItem) => void;
}): JSX.Element {
  const [items, setItems] = useState<SkillMarketItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setErr('');
    const params = query
      ? { sourceId: source.id, query }
      : source.kind === 'builtin'
        ? { sourceId: source.id }
        : { sourceId: source.id, limit: REMOTE_TOPN };
    void rpc
      .request('skill.market.list', params)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setTotal(r.total);
        setState('idle');
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [rpc, source.id, source.kind, query]);

  const capped = !query && source.kind === 'marketplace' && total > items.length;

  return (
    <section className="market-group">
      <h3 className="market-group-title market-skills-group-title">
        {source.name}{' '}
        <span className="muted small">
          {state === 'loading'
            ? '· fetching…'
            : state === 'error'
              ? '· fetch failed'
              : capped
                ? `· first ${items.length} of ${total}`
                : `· ${total}`}
        </span>
      </h3>
      {state === 'error' && <div className="muted small">{err}</div>}
      {state !== 'error' && (
        <div className="market-grid market-skills-grid">
          {items.map((it) => (
            <div key={it.id} className="market-card market-skill-card">
              <div className="market-skill-head">
                <div>
                  <h4>{it.name}</h4>
                  {it.author && <span className="market-skill-author">by {it.author}</span>}
                </div>
                <span className="market-skill-source">
                  {source.kind === 'builtin' ? 'Built-in' : source.name}
                </span>
              </div>
              <p className="market-skill-desc" title={it.description}>
                {it.description}
              </p>
              <footer className="market-skill-footer">
                <div className="market-skill-tags">
                  {skillCardTags(it.category, it.tags).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <button
                  type="button"
                  className="market-skill-install"
                  disabled={disabled}
                  onClick={() => onInstall(it)}
                >
                  Install
                </button>
              </footer>
            </div>
          ))}
          {state === 'idle' && items.length === 0 && (
            <div className="muted small">No matching skills</div>
          )}
        </div>
      )}
      {capped && <div className="muted small market-cap-note">Search to see all {total}</div>}
    </section>
  );
}
