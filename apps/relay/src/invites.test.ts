import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { InviteStore } from './invites';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const store = () => {
  const d = mkdtempSync(join(tmpdir(), 'ateam-invites-'));
  dirs.push(d);
  return { path: join(d, 'invites.json'), s: new InviteStore(join(d, 'invites.json')) };
};

it('creates readable single-use codes and stores only their hash', () => {
  const { path, s } = store();
  const { code } = s.create('me@example.com');
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(readFileSync(path, 'utf8')).not.toContain(code.replace(/-/g, ''));
  expect(s.valid(code.toLowerCase().replace(/-/g, ' '))).toBe(true); // retyped loosely
  expect(s.consume(code, 'friend@example.com')).toBe(true);
  expect(s.valid(code)).toBe(false);
  expect(s.consume(code, 'other@example.com')).toBe(false);
});

it('honours use counts, expiry and survives a restart', () => {
  vi.useFakeTimers();
  const { path, s } = store();
  const { code } = s.create('cli', 2, 1);
  expect(s.consume(code, 'a@x')).toBe(true);
  expect(new InviteStore(path).valid(code)).toBe(true); // reloaded from disk
  vi.advanceTimersByTime(2 * 86_400_000);
  expect(s.valid(code)).toBe(false);
  expect(s.valid(undefined)).toBe(false);
  expect(s.valid('WRONG-CODE-HERE')).toBe(false);
});
