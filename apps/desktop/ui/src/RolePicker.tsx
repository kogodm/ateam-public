import { useLayoutEffect, useRef, useState } from 'react';
import { ROLE_PRESETS } from './RoleSelect';
import { Drawer } from './Drawer';

/**
 * Role picker — drawer-style sibling of HumanPicker / DirPicker. Shows the
 * preset roles as cards (label + one-line description + monogram) plus a
 * free-text "Custom role" field, so a role can still be anything. Value
 * contract matches the old RoleSelect: `value` is the role string.
 */

interface RolePickerProps {
  value: string;
  onChange: (role: string) => void;
}

const ROLE_META: Record<string, { label: string; desc: string }> = {
  coder: { label: 'Coder', desc: 'Writes and ships the implementation.' },
  reviewer: { label: 'Reviewer', desc: 'Reviews diffs for quality and bugs.' },
  tester: { label: 'Tester', desc: 'Writes tests and hunts regressions.' },
  'tech-lead': { label: 'Tech lead', desc: 'Owns architecture and direction.' },
  'game-designer': { label: 'Game designer', desc: 'Designs systems and mechanics.' },
};

const monogram = (role: string): string => {
  const parts = role.split(/[-\s]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  return role.slice(0, 2).toUpperCase();
};

const labelOf = (role: string): string => ROLE_META[role]?.label ?? role;

export function RolePicker({ value, onChange }: RolePickerProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(ROLE_PRESETS.includes(value) ? '' : value);
  const customRef = useRef<HTMLInputElement | null>(null);

  const isCustom = value !== '' && !ROLE_PRESETS.includes(value);

  useLayoutEffect(() => {
    if (open && isCustom) customRef.current?.focus();
  }, [open, isCustom]);

  const close = () => setOpen(false);
  const pickPreset = (role: string) => {
    onChange(role);
    close();
  };
  const commitCustom = () => {
    const v = custom.trim();
    if (v) {
      onChange(v);
      close();
    }
  };

  return (
    <div className="rpick">
      <button type="button" className="rpick-trigger" onClick={() => setOpen(true)}>
        <span className="rpick-mono" aria-hidden>
          {monogram(value || 'coder')}
        </span>
        <span className="rpick-name">{labelOf(value) || 'Pick a role'}</span>
        <span className="dirpick-caret" aria-hidden>
          ⌄
        </span>
      </button>

      <Drawer open={open} title="Choose a role" subtitle="What is this teammate here to do?" onClose={close}>
        {ROLE_PRESETS.map((role) => {
          const meta = ROLE_META[role] ?? { label: role, desc: '' };
          return (
            <button
              key={role}
              type="button"
              className={'rcard' + (value === role ? ' is-sel' : '')}
              onClick={() => pickPreset(role)}
            >
              <span className="rcard-mono" aria-hidden>
                {monogram(role)}
              </span>
              <span className="rcard-body">
                <span className="rcard-name">{meta.label}</span>
                <span className="rcard-desc">{meta.desc}</span>
              </span>
              {value === role && (
                <span className="drawer-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          );
        })}

        <div className={'rcard rcard-custom' + (isCustom ? ' is-sel' : '')}>
          <span className="rcard-mono" aria-hidden>
            {custom ? monogram(custom) : '＋'}
          </span>
          <span className="rcard-body">
            <span className="rcard-name">Custom role</span>
            <span className="rcard-custom-row">
              <input
                ref={customRef}
                value={custom}
                placeholder="e.g. designer, pm, ops…"
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCustom();
                  }
                }}
              />
              <button
                type="button"
                className="rcard-custom-go"
                disabled={!custom.trim()}
                onClick={commitCustom}
              >
                Use
              </button>
            </span>
          </span>
        </div>
      </Drawer>
    </div>
  );
}
