import type { HumanDTO, SkillUnitDTO } from '@ateam/contract';
import { useCallback, useEffect, useState } from 'react';
import type { Rpc } from './rpc';

const ROLES = ['coder', 'reviewer', 'tester', 'tech-lead'] as const;

/**
 * Setup / skill-assignment wizard (TUI parity): create-or-pick a Human,
 * multi-select discovered skill units, adopt them (skill.importUnit — the
 * vault symlinks the originals), optionally sweep the human's worked dirs,
 * then config.finish. Re-openable anytime, not just first run.
 */
export function Setup({
  rpc,
  firstRun,
  onDone,
}: {
  rpc: Rpc;
  firstRun: boolean;
  onDone: () => void;
}): JSX.Element {
  const [humans, setHumans] = useState<HumanDTO[]>([]);
  const [humanId, setHumanId] = useState('');
  const [name, setName] = useState('coder-1');
  const [role, setRole] = useState('coder');
  const [units, setUnits] = useState<SkillUnitDTO[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adoptDirs, setAdoptDirs] = useState(true);
  const [busy, setBusy] = useState('scanning skills…');

  useEffect(() => {
    void (async () => {
      const [hs, u] = await Promise.all([
        rpc.request('human.list', {}),
        rpc.request('skill.units', {}),
      ]);
      setHumans(hs.humans);
      setUnits(u.units);
      // default-check units nobody has yet
      setPicked(new Set(u.units.filter((x) => x.assignedTo.length === 0).map((x) => x.path)));
      setBusy('');
    })();
  }, [rpc]);

  const toggle = (p: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const finish = useCallback(async () => {
    setBusy('creating human…');
    let hid = humanId;
    try {
      if (!hid) {
        const created = await rpc.request('human.create', { name, role });
        hid = created.human.id;
      }
      const chosen = units.filter((u) => picked.has(u.path));
      for (let i = 0; i < chosen.length; i++) {
        const u = chosen[i];
        if (!u) continue;
        setBusy(`assigning skills ${i + 1}/${chosen.length}…`);
        await rpc
          .request('skill.importUnit', {
            humanId: hid,
            unitPath: u.path,
            kind: u.kind,
            entry: u.entry,
            scope: 'global',
          })
          .catch(() => {});
      }
      if (adoptDirs) {
        setBusy('adopting skills from worked dirs…');
        await rpc.request('skill.adoptHumanDirs', { humanId: hid }).catch(() => {});
      }
      await rpc.request('config.finish', {}).catch(() => {});
      onDone();
    } catch (e) {
      setBusy(e instanceof Error ? e.message : String(e));
    }
  }, [humanId, name, role, units, picked, adoptDirs, rpc, onDone]);

  const selected = humans.find((h) => h.id === humanId);
  const displayName = selected ? selected.name : name.trim() || 'new-teammate';
  const displayRole = selected ? selected.role : role;
  const sigil = (displayName.replace(/[^a-z0-9]/gi, '')[0] || '·').toUpperCase();

  return (
    <div className="fatal setup-screen">
      <div className="setup-console">
        <header className="setup-head">
          <span className="setup-brand">
            <span className="setup-brand-mark">◇</span> ATEAM
          </span>
          <span className="setup-eyebrow">{firstRun ? 'new teammate' : 'skills & setup'}</span>
        </header>
        <h2 className="setup-title">
          {firstRun ? 'Commission your first teammate' : 'Tune teammates & skills'}
        </h2>
        <p className="setup-lede">
          {firstRun
            ? 'Name an agent, give it a role, and choose the skills it starts with. It gets sharper every session you run it.'
            : 'Pick a teammate, then choose which skills they carry into new sessions.'}
        </p>

        <div className="setup-body">
          <section className="setup-pane setup-identity">
            {humans.length > 0 && (
              <div className="setup-field">
                <label className="setup-label" htmlFor="setup-human">
                  teammate
                </label>
                <div className="setup-select">
                  <select
                    id="setup-human"
                    value={humanId}
                    onChange={(e) => setHumanId(e.target.value)}
                  >
                    <option value="">✚ new teammate</option>
                    {humans.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} · {h.role} · {h.projects.length} proj
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {!humanId && (
              <>
                <div className="setup-field">
                  <label className="setup-label" htmlFor="setup-name">
                    name
                  </label>
                  <div className="setup-prompt">
                    <span className="setup-caret" aria-hidden>
                      ❯
                    </span>
                    <input
                      id="setup-name"
                      className="setup-prompt-input"
                      value={name}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                </div>

                <div className="setup-field">
                  <span className="setup-label">role</span>
                  <div className="setup-roles" role="radiogroup" aria-label="role">
                    {ROLES.map((r) => (
                      <button
                        type="button"
                        key={r}
                        role="radio"
                        aria-checked={role === r}
                        className={`setup-role${role === r ? ' is-on' : ''}`}
                        onClick={() => setRole(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="setup-badge">
              <div className="setup-badge-top">
                <span className="setup-sigil">{sigil}</span>
                <span className="setup-badge-id">
                  <span className="setup-badge-name">{displayName}</span>
                  <span className="setup-badge-role">{displayRole}</span>
                </span>
              </div>
              <div className="setup-badge-status">
                <i className="setup-dot" aria-hidden /> ready to initialize
              </div>
            </div>
          </section>

          <section className="setup-pane setup-skills">
            <div className="setup-skills-head">
              <span className="setup-label">starting skills</span>
              <span className="setup-count">
                {picked.size}
                <span className="setup-count-sep">/</span>
                {units.length}
              </span>
            </div>
            <div className="setup-skill-list">
              {units.map((u) => {
                const on = picked.has(u.path);
                return (
                  <button
                    type="button"
                    key={u.path}
                    className={`setup-skill${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggle(u.path)}
                  >
                    <span className="setup-check" aria-hidden />
                    <span className="setup-skill-body">
                      <span className="setup-skill-name">{u.label}</span>
                      <span className="setup-skill-meta">
                        {u.docCount} {u.kind} · {u.origin}
                        {u.assignedTo.length
                          ? ` · ✓ ${u.assignedTo.map((a) => a.humanName).join(', ')}`
                          : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
              {units.length === 0 && !busy && (
                <div className="setup-empty">
                  No skill sources found yet — you can add them later from the Skill Market.
                </div>
              )}
              {units.length === 0 && busy && <div className="setup-empty">{busy}</div>}
            </div>

            <button
              type="button"
              className={`setup-switch${adoptDirs ? ' is-on' : ''}`}
              aria-pressed={adoptDirs}
              onClick={() => setAdoptDirs((v) => !v)}
            >
              <span className="setup-switch-track">
                <span className="setup-switch-thumb" />
              </span>
              <span className="setup-switch-label">
                Also adopt skills from this teammate's project folders
              </span>
            </button>
          </section>
        </div>

        <footer className="setup-foot">
          <button
            type="button"
            className="setup-go"
            onClick={() => void finish()}
            disabled={!!busy}
          >
            {firstRun ? 'Bring online' : 'Apply'}
            <span className="setup-go-arrow" aria-hidden>
              →
            </span>
          </button>
          <span className="setup-status">{busy}</span>
          {!firstRun && (
            <button type="button" className="setup-cancel" onClick={onDone}>
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
