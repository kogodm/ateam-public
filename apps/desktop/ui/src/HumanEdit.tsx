import type { HumanDTO, SkillMarketItem, SkillUnitDTO } from '@ateam/contract';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RoleSelect } from './RoleSelect';
import { Tip } from './Tip';
import { AVATAR_IDS, avatarSrc } from './avatars';
import type { Rpc } from './rpc';
import { type SkillCardGroup, groupPluginUnits, pluginMemberLabel } from './skillGroups';

/**
 * Edit page for a single Human — lives inside Settings (same shell), opened
 * via Team tab's "Edit"/"New human" buttons. Replaces the old standalone
 * Skills tab; all skill assignment lives here per-human.
 *
 * Sections:
 *   1) Identity — name + role + Save (human.update). Renaming flows live
 *      into session tabs because SessionManager.list() re-derives names
 *      from humans.json on every refresh.
 *   2) Skills — currently assigned + remove (skill.unassign); discover &
 *      assign new units from skill.units.
 *   3) Skill Market — curated catalog (builtin + HTTPS); Install button.
 *   4) Reorganize — flywheel.distill scoped to this Human.
 */
export function HumanEdit({
  rpc,
  humanId,
  isNew,
  onBack,
  onSaved,
}: {
  rpc: Rpc;
  /** existing human id, or '' for a new human */
  humanId: string;
  isNew: boolean;
  onBack: () => void;
  onSaved?: (id: string) => void;
}): JSX.Element {
  const [human, setHuman] = useState<HumanDTO | null>(null);
  const [name, setName] = useState('coder-1');
  const [role, setRole] = useState('coder');
  const [duties, setDuties] = useState('');
  const [units, setUnits] = useState<SkillUnitDTO[]>([]);
  const [market, setMarket] = useState<SkillMarketItem[]>([]);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  /* skills browser: which bucket is showing, and the name filter */
  const [skillTab, setSkillTab] = useState<'assigned' | 'available' | 'market'>('assigned');
  const [skillQuery, setSkillQuery] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  // avatar ids already worn by OTHER humans — shown grayed & unpickable
  const [takenAvatars, setTakenAvatars] = useState<Set<string>>(new Set());
  const [distillReport, setDistillReport] = useState<{
    distilled: number;
    byDomain: Record<string, number>;
  } | null>(null);

  const refresh = useCallback(async () => {
    setBusy('loading…');
    try {
      const [u, m, h, all] = await Promise.all([
        rpc.request('skill.units', {}),
        rpc.request('skill.market.list', {}),
        humanId ? rpc.request('human.get', { id: humanId }) : Promise.resolve({ human: null }),
        rpc.request('human.list', {}),
      ]);
      setUnits(u.units);
      setMarket(m.items);
      setTakenAvatars(
        new Set(
          all.humans.filter((x) => x.id !== humanId && x.avatarId).map((x) => x.avatarId as string),
        ),
      );
      if (h.human) {
        setHuman(h.human);
        setName(h.human.name);
        setRole(h.human.role);
        setDuties(h.human.duties ?? '');
      }
    } finally {
      setBusy('');
    }
  }, [rpc, humanId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveIdentity = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus('name required');
      return;
    }
    setBusy('saving…');
    try {
      if (!humanId || isNew) {
        const created = await rpc.request('human.create', { name: trimmed, role });
        if (duties.trim()) {
          const withDuties = await rpc.request('human.update', {
            id: created.human.id,
            patch: { duties },
          });
          setHuman(withDuties.human);
        } else setHuman(created.human);
        setStatus('created');
        onSaved?.(created.human.id);
      } else {
        const updated = await rpc.request('human.update', {
          id: humanId,
          patch: { name: trimmed, role, duties },
        });
        setHuman(updated.human);
        setStatus('saved');
        onSaved?.(updated.human.id);
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [rpc, humanId, isNew, name, role, duties, onSaved]);

  const pickAvatar = useCallback(
    async (avatarId: string) => {
      if (!humanId) {
        setStatus('save the Human first to pick an avatar');
        return;
      }
      setBusy('saving avatar…');
      try {
        const r = await rpc.request('human.update', {
          id: humanId,
          patch: { avatarId },
        });
        setHuman(r.human);
        setStatus('avatar updated');
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc, humanId],
  );

  const assigned = useMemo(
    () => (humanId ? units.filter((u) => u.assignedTo.some((a) => a.humanId === humanId)) : []),
    [units, humanId],
  );
  const unassigned = useMemo(
    () => (humanId ? units.filter((u) => !u.assignedTo.some((a) => a.humanId === humanId)) : units),
    [units, humanId],
  );
  /* what the skills grid renders: the selected bucket, name-filtered */
  const unitsShown = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    const src = skillTab === 'assigned' ? assigned : unassigned;
    return q ? src.filter((u) => u.label.toLowerCase().includes(q)) : src;
  }, [skillTab, skillQuery, assigned, unassigned]);
  /* one card per plugin (all its skills/commands/agents), one per lone unit */
  const cardGroups = useMemo(() => groupPluginUnits(unitsShown), [unitsShown]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }, []);
  /* the inline strip: current pick first, then the next free faces. The
     full set of 81 lives behind "More" — a 14-row grid is not a control. */
  const AVATAR_STRIP = 7;
  const stripAvatars = useMemo(() => {
    const cur = human?.avatarId;
    const free = AVATAR_IDS.filter((id) => id !== cur && !takenAvatars.has(id));
    return (cur ? [cur, ...free] : free).slice(0, AVATAR_STRIP);
  }, [human?.avatarId, takenAvatars]);
  /* one cell, shared by the inline strip and the "More" grid */
  const avatarCell = (id: string): JSX.Element => {
    const mine = human?.avatarId === id;
    const taken = !mine && takenAvatars.has(id);
    return (
      <button
        type="button"
        key={id}
        className={`avatar-cell ${mine ? 'on' : ''}${taken ? ' taken' : ''}`}
        onClick={() => void pickAvatar(id)}
        disabled={!!busy || !humanId || taken}
        title={taken ? 'Already used by another human' : undefined}
      >
        <img src={avatarSrc(id)} alt="" />
      </button>
    );
  };
  const marketShown = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    return q
      ? market.filter(
          (m) =>
            m.name.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q)),
        )
      : market;
  }, [skillQuery, market]);

  const assign = useCallback(
    async (u: SkillUnitDTO) => {
      if (!humanId) {
        setStatus('save the Human first to assign skills');
        return;
      }
      setBusy(`assigning ${u.label}…`);
      try {
        await rpc.request('skill.importUnit', {
          humanId,
          unitPath: u.path,
          kind: u.kind,
          entry: u.entry,
          scope: 'global',
        });
        await refresh();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc, humanId, refresh],
  );

  const unassign = useCallback(
    async (u: SkillUnitDTO) => {
      if (!humanId) return;
      setBusy(`removing ${u.label}…`);
      try {
        await rpc.request('skill.unassign', { humanId, unitPath: u.path });
        await refresh();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc, humanId, refresh],
  );

  /* a plugin card's Assign / Remove fans out over every unit it holds —
     sequential requests, ONE refresh at the end */
  const assignAll = useCallback(
    async (g: SkillCardGroup) => {
      if (!humanId) {
        setStatus('save the Human first to assign skills');
        return;
      }
      setBusy(`assigning ${g.title} (${g.units.length})…`);
      try {
        for (const u of g.units) {
          await rpc.request('skill.importUnit', {
            humanId,
            unitPath: u.path,
            kind: u.kind,
            entry: u.entry,
            scope: 'global',
          });
        }
        await refresh();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc, humanId, refresh],
  );
  const unassignAll = useCallback(
    async (g: SkillCardGroup) => {
      if (!humanId) return;
      setBusy(`removing ${g.title} (${g.units.length})…`);
      try {
        for (const u of g.units) await rpc.request('skill.unassign', { humanId, unitPath: u.path });
        await refresh();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc, humanId, refresh],
  );

  const install = useCallback(
    async (item: SkillMarketItem) => {
      if (!humanId) {
        setStatus('save the Human first to install skills');
        return;
      }
      setBusy(`installing ${item.name}…`);
      try {
        await rpc.request('skill.market.install', { humanId, itemId: item.id });
        await refresh();
        setStatus(`installed ${item.name}`);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy('');
      }
    },
    [rpc, humanId, refresh],
  );

  const reorganize = useCallback(async () => {
    if (!humanId) return;
    setBusy('reorganizing…');
    setDistillReport(null);
    try {
      const r = await rpc.request('flywheel.distill', { humanId });
      setDistillReport(r);
      setStatus(
        r.distilled
          ? `+${r.distilled} skill from experiences`
          : 'nothing new to distill yet — need ≥3 experiences per domain',
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [rpc, humanId]);

  const title = isNew ? 'New human' : human ? `Edit human: ${human.name}` : 'Edit human';

  return (
    <>
      <button type="button" className="role-back" onClick={onBack}>
        ← Back to Team
      </button>
      <h1 className="page-title he-title">{title}</h1>

      {/* 1) Identity */}
      <section className="section">
        <h3 className="section-title">
          Identity
          <Tip>
            The Human is a long-term asset; rename / role-change here flows into session tabs on the
            next refresh.
          </Tip>
        </h3>
        <div className="form-row">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Role
            <RoleSelect value={role} onChange={setRole} />
          </label>
        </div>
        <div className="form-row">
          <label className="he-duties">
            Responsibilities
            <textarea
              rows={3}
              value={duties}
              placeholder="What this teammate owns — and what they should hand back. Read at the start of every session they run."
              onChange={(e) => setDuties(e.target.value)}
            />
          </label>
        </div>
        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => void saveIdentity()}
            disabled={!!busy}
          >
            {isNew ? 'Create' : 'Save'}
          </button>
          <span className="muted">{status || busy}</span>
        </div>
      </section>

      {/* 1b) Avatar */}
      <section className="section">
        <h3 className="section-title">Avatar</h3>
        <p className="section-sub">
          Pick a face for this human — it appears on their card across the app.
        </p>
        <div className="avatar-strip">
          {stripAvatars.map(avatarCell)}
          <button
            type="button"
            className="avatar-more"
            onClick={() => setAvatarPickerOpen(true)}
            disabled={!!busy || !humanId}
          >
            More
            <span className="n">{AVATAR_IDS.length}</span>
          </button>
        </div>
      </section>

      {/* 2) Skills — assigned, discovered and market are the same list
             filtered three ways, so finding one skill costs one glance
             instead of scrolling past three stacked sections. */}
      <section className="section">
        <div className="settings-eyebrow">Capabilities</div>
        <h3 className="section-title">
          Skills
          <Tip>
            What {name} carries into every session they spawn. Assigned bundles load first; the rest
            are units discovered on this machine or offered by the market.
          </Tip>
        </h3>

        <div className="he-toolbar">
          <div className="he-seg">
            {(
              [
                ['assigned', 'Assigned', assigned.length],
                ['available', 'Available', unassigned.length],
                ['market', 'Market', market.length],
              ] as const
            ).map(([id, label, n]) => (
              <button
                type="button"
                key={id}
                className={skillTab === id ? 'on' : ''}
                onClick={() => setSkillTab(id)}
              >
                {label}
                <span className="n">{n}</span>
              </button>
            ))}
          </div>
          <input
            className="he-search"
            type="text"
            placeholder="Filter skills"
            value={skillQuery}
            onChange={(e) => setSkillQuery(e.target.value)}
          />
        </div>

        <div className="he-grid">
          {skillTab === 'market'
            ? marketShown.map((m) => {
                const installed = assigned.some(
                  (u) => u.label.toLowerCase() === m.name.toLowerCase(),
                );
                return (
                  <div key={m.id} className="he-card">
                    <div className="top">
                      <span className="nm" title={m.name}>
                        {m.name}
                      </span>
                      <button
                        type="button"
                        className="act"
                        onClick={() => void install(m)}
                        disabled={!!busy || installed}
                      >
                        {installed ? 'Installed' : 'Install'}
                      </button>
                    </div>
                    <div className="meta">
                      {m.builtin ? 'builtin · ' : ''}
                      {m.tags.join(', ')}
                    </div>
                    <div className="dsc">{m.description}</div>
                  </div>
                );
              })
            : cardGroups.map((g) => {
                const isOn = skillTab === 'assigned';
                const first = g.units[0] as SkillUnitDTO;
                if (!g.plugin) {
                  const u = first;
                  return (
                    <div key={g.key} className={`he-card${isOn ? ' on' : ''}`}>
                      <div className="top">
                        <span className="nm" title={u.path}>
                          {u.label}
                        </span>
                        <button
                          type="button"
                          className="act"
                          title={isOn ? 'Remove from this human' : 'Assign to this human'}
                          onClick={() => void (isOn ? unassign(u) : assign(u))}
                          disabled={!!busy}
                        >
                          {isOn ? 'Remove' : 'Assign'}
                        </button>
                      </div>
                      <div className="meta">
                        {u.docCount} {u.kind} · {u.origin}
                        {!isOn && u.assignedTo.length
                          ? ` · ✓ ${u.assignedTo.map((a) => a.humanName).join(', ')}`
                          : ''}
                      </div>
                    </div>
                  );
                }
                // plugin card: one per plugin, every unit it ships behind a
                // disclosure; the top action fans out over all of them (#14)
                const open = openGroups.has(g.key);
                return (
                  <div
                    key={g.key}
                    className={`he-card he-card-plugin${isOn ? ' on' : ''}${open ? ' open' : ''}`}
                  >
                    <div className="top">
                      <span className="nm" title={`${g.title}${g.subtitle}`}>
                        {g.title}
                        {g.subtitle && <span className="he-card-sub">{g.subtitle}</span>}
                      </span>
                      <button
                        type="button"
                        className="act"
                        title={
                          isOn
                            ? `Remove all ${g.units.length} from this human`
                            : `Assign all ${g.units.length} to this human`
                        }
                        onClick={() => void (isOn ? unassignAll(g) : assignAll(g))}
                        disabled={!!busy}
                      >
                        {isOn ? 'Remove all' : 'Assign all'}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="meta he-card-toggle"
                      onClick={() => toggleGroup(g.key)}
                      title={open ? "Hide the plugin's units" : "Show the plugin's units"}
                    >
                      <span className="he-card-caret" aria-hidden="true">
                        ▸
                      </span>
                      {g.units.length} {g.units.length === 1 ? 'unit' : 'units'} · plugin ·{' '}
                      {first.origin}
                    </button>
                    <div className="he-card-members" aria-hidden={!open}>
                      <div className="he-card-members-in">
                        {g.units.map((u) => (
                          <div key={u.path} className="he-card-member">
                            <span className="nm" title={u.path}>
                              {pluginMemberLabel(u)}
                            </span>
                            <span className="muted small">
                              {u.docCount} {u.kind}
                              {!isOn && u.assignedTo.length ? ` · ✓ ${u.assignedTo.length}` : ''}
                            </span>
                            <button
                              type="button"
                              className="act"
                              onClick={() => void (isOn ? unassign(u) : assign(u))}
                              disabled={!!busy}
                            >
                              {isOn ? 'Remove' : 'Assign'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
          {(skillTab === 'market' ? marketShown.length : cardGroups.length) === 0 && (
            <div className="he-empty">
              {skillQuery ? `nothing matches “${skillQuery}”` : 'nothing here yet'}
            </div>
          )}
        </div>
      </section>

      {/* 4) Reorganize */}
      <section className="section">
        <h3 className="section-title">
          Reorganize
          <Tip>
            Distill ≥3 same-domain experiences into reusable Skills, and run a confidence-decay
            pass. Safe to run anytime; idempotent.
          </Tip>
        </h3>
        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => void reorganize()}
            disabled={!!busy || !humanId}
          >
            Distill experiences → skills
          </button>
        </div>
        {distillReport && (
          <div className="muted small" style={{ marginTop: 8 }}>
            distilled {distillReport.distilled}
            {Object.keys(distillReport.byDomain).length > 0 && (
              <>
                {' '}
                ·{' '}
                {Object.entries(distillReport.byDomain)
                  .map(([d, n]) => `${d}: +${n}`)
                  .join(', ')}
              </>
            )}
          </div>
        )}
      </section>

      {avatarPickerOpen && (
        <div className="modal-bg" onClick={() => setAvatarPickerOpen(false)}>
          <div className="modal avatar-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Pick a face</h3>
            <p className="avatar-modal-sub">
              {AVATAR_IDS.length} faces · dimmed ones already belong to another human.
            </p>
            <div className="avatar-grid">{AVATAR_IDS.map(avatarCell)}</div>
            <div className="avatar-modal-foot">
              <button type="button" onClick={() => setAvatarPickerOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
