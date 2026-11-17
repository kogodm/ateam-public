import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HumanDTO } from '@ateam/contract';
import { avatarSrc } from './avatars';
import { Drawer } from './Drawer';

/**
 * Teammate picker. Trigger shows the chosen human (avatar + name + role)
 * or a "new teammate" state when value is ''. Activating it opens the
 * shared right-side drawer with redesigned human cards (avatar, name,
 * role badge, project count, experience summary) plus a "new teammate"
 * card. Value contract matches the old <select>: '' = create a new human,
 * otherwise the selected human's id.
 */

interface HumanPickerProps {
  value: string;
  humans: HumanDTO[];
  onChange: (humanId: string) => void;
}

const fallbackAvatar = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.src = '/avatars/default.svg';
};

export function HumanPicker({ value, humans, onChange }: HumanPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = value ? humans.find((h) => h.id === value) : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return humans;
    return humans.filter(
      (h) => h.name.toLowerCase().includes(q) || h.role.toLowerCase().includes(q),
    );
  }, [humans, query]);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (id: string) => {
    onChange(id);
    close();
  };

  return (
    <div className="hpick">
      <button type="button" className="hpick-trigger" onClick={() => setOpen(true)}>
        {selected ? (
          <>
            <img className="hpick-avatar" src={avatarSrc(selected.avatarId)} alt="" onError={fallbackAvatar} />
            <span className="hpick-id">
              <span className="hpick-name">{selected.name}</span>
              <span className="hpick-role">{selected.role}</span>
            </span>
          </>
        ) : (
          <>
            <span className="hpick-avatar hpick-avatar-new" aria-hidden>
              ＋
            </span>
            <span className="hpick-id">
              <span className="hpick-name">New teammate</span>
              <span className="hpick-role hpick-role-muted">name &amp; role below</span>
            </span>
          </>
        )}
        <span className="dirpick-caret" aria-hidden>
          ⌄
        </span>
      </button>

      <Drawer
        open={open}
        title="Choose a teammate"
        subtitle="Reuse an existing teammate or start a new one."
        onClose={close}
        search={
          humans.length > 4
            ? {
                value: query,
                placeholder: 'Filter teammates…',
                onChange: setQuery,
                inputRef,
              }
            : undefined
        }
      >
        <button
          type="button"
          className={'hcard hcard-new' + (!value ? ' is-sel' : '')}
          onClick={() => pick('')}
        >
          <span className="hcard-avatar hcard-avatar-new" aria-hidden>
            ＋
          </span>
          <span className="hcard-body">
            <span className="hcard-top">
              <span className="hcard-name">New teammate</span>
            </span>
            <span className="hcard-summary">Create a new human — set a name and role below.</span>
          </span>
          {!value && (
            <span className="drawer-check" aria-hidden>
              ✓
            </span>
          )}
        </button>

        {filtered.length === 0 && <div className="drawer-empty">No matching teammates</div>}

        {filtered.map((h) => {
          const projects = h.projects?.length ?? 0;
          return (
            <button
              key={h.id}
              type="button"
              className={'hcard' + (value === h.id ? ' is-sel' : '')}
              onClick={() => pick(h.id)}
              title={h.name}
            >
              <img className="hcard-avatar" src={avatarSrc(h.avatarId)} alt="" onError={fallbackAvatar} />
              <span className="hcard-body">
                <span className="hcard-top">
                  <span className="hcard-name">{h.name}</span>
                  <span className="hcard-role">{h.role}</span>
                </span>
                <span className="hcard-meta">
                  {projects} {projects === 1 ? 'project' : 'projects'}
                  {h.provider ? <span className="hcard-dot"> · {h.provider}</span> : null}
                </span>
                {h.experienceSummary?.text && (
                  <span className="hcard-summary">{h.experienceSummary.text}</span>
                )}
              </span>
              {value === h.id && (
                <span className="drawer-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </Drawer>
    </div>
  );
}
