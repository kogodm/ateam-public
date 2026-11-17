export type LanDialogMode = 'enable' | 'configure';

export interface LanSettingsDraft {
  mode: LanDialogMode;
  password: string;
  port: string;
}

export function isValidLanPort(port: string): boolean {
  const value = Number(port.trim());
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function isValidLanPassword(password: string): boolean {
  return password.trim().length >= 4;
}

export function canSaveLanSettings(draft: LanSettingsDraft, busy: boolean): boolean {
  const password = draft.password.trim();
  return (
    isValidLanPort(draft.port) &&
    (draft.mode === 'enable'
      ? isValidLanPassword(password)
      : !password || isValidLanPassword(password)) &&
    !busy
  );
}

export function lanSettingsPatch(draft: LanSettingsDraft): {
  enabled?: boolean;
  port: number;
  password?: string;
} {
  const password = draft.password.trim();
  const port = Number(draft.port.trim());
  return draft.mode === 'enable'
    ? { enabled: true, port, password }
    : { port, ...(password ? { password } : {}) };
}
