import { useEffect, useState } from 'react';

/** Role picker that matches the TUI: a preset dropdown plus a "Custom…"
 *  option that swaps to a free-text input — so a human's role can be
 *  anything, not just one of the four built-ins. */
export const ROLE_PRESETS = ['coder', 'reviewer', 'tester', 'tech-lead', 'game-designer'];
const CUSTOM = 'custom…';

export function RoleSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'preset' | 'custom'>(
    ROLE_PRESETS.includes(value) || value === '' ? 'preset' : 'custom',
  );

  // keep mode in sync if the parent resets value to a preset / empty
  useEffect(() => {
    if (ROLE_PRESETS.includes(value)) setMode('preset');
    else if (value !== '') setMode('custom');
  }, [value]);

  if (mode === 'custom') {
    return (
      <div className="role-row">
        <input
          // biome-ignore lint/a11y/noAutofocus: it's a deliberate field swap
          autoFocus
          value={value}
          placeholder="type a role"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="role-back"
          title="Pick from presets instead"
          onClick={() => {
            setMode('preset');
            onChange('coder');
          }}
        >
          ↺
        </button>
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === CUSTOM) {
          setMode('custom');
          onChange('');
        } else {
          onChange(v);
        }
      }}
    >
      {ROLE_PRESETS.map((x) => (
        <option key={x}>{x}</option>
      ))}
      <option value={CUSTOM}>Custom…</option>
    </select>
  );
}
