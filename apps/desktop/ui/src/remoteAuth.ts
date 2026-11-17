export type RemoteAuthMode = 'signin' | 'register';

export interface RemoteAuthInput {
  mode: RemoteAuthMode;
  email: string;
  password: string;
  invite: string;
  busy: boolean;
}

export function canSubmitRemoteAuth({ mode, email, password, invite, busy }: RemoteAuthInput): boolean {
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    password.length >= 8 &&
    (mode !== 'register' || invite.trim().length > 0) &&
    !busy
  );
}

export function remoteSignInParams({ mode, email, password, invite }: Pick<
  RemoteAuthInput,
  'mode' | 'email' | 'password' | 'invite'
>): {
  email: string;
  password: string;
  invite?: string;
} {
  return {
    email: email.trim(),
    password,
    ...(mode === 'register' ? { invite: invite.trim() } : {}),
  };
}
