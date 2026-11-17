import type { ProviderId } from '@ateam/contract';
import { type ModelOption, cacheModelMenu, cleanModelLabel, isModelList } from './modelMenuCache';
import { isModelPicker } from './modelPickerActions';
import type { Rpc } from './rpc';
import { type TuiPicker, parsePicker } from './tuiPicker';

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
function controls(
  rpc: Pick<Rpc, 'request'>,
  sessionId: string,
  rows: () => readonly string[],
  active: () => boolean,
) {
  const screen = () => {
    if (!active()) throw new Error('The session changed before the model switch finished');
    const picker = parsePicker(rows());
    if (picker && !isModelPicker(picker)) throw new Error('Finish the current CLI dialog first');
    return picker;
  };
  const write = async (data: string, expected: (picker: TuiPicker | null) => boolean) => {
    if (!expected(screen())) throw new Error('The CLI menu changed before input');
    await rpc.request('session.input', { sessionId, data });
  };
  const wait = async (test: (picker: TuiPicker | null) => boolean, timeout: number) => {
    const until = Date.now() + timeout;
    while (!test(screen())) {
      if (Date.now() >= until) return false;
      await pause();
    }
    return true;
  };
  const open = async (provider: ProviderId, timeout: number) => {
    if (!['claude', 'codex'].includes(provider))
      throw new Error('This session cannot open a model picker');
    const current = screen();
    if (current && !isModelList(provider, current))
      throw new Error('Finish the current CLI dialog first');
    if (!current) {
      await write('/model', (p) => !p);
      if (screen()) throw new Error('The CLI dialog changed before opening the model menu');
      await write('\r', (p) => !p);
    }
    if (!(await wait((p) => isModelList(provider, p), timeout)))
      throw new Error('The model menu did not appear');
  };
  return { screen, write, wait, open };
}
export async function discoverModelMenu(
  rpc: Pick<Rpc, 'request'>,
  sessionId: string,
  rows: () => readonly string[],
  provider: ProviderId,
  active: () => boolean = () => true,
) {
  const c = controls(rpc, sessionId, rows, active);
  await c.open(provider, 10000);
  const menu = cacheModelMenu(provider, c.screen());
  if (!menu) throw new Error('The model menu changed');
  await c.write('\x1b', (p) => isModelList(provider, p));
  if (!(await c.wait((p) => !p, 3000))) throw new Error('The model menu did not close');
  return menu;
}
export async function applyModelSwitch(
  rpc: Pick<Rpc, 'request'>,
  sessionId: string,
  rows: () => readonly string[],
  provider: ProviderId,
  target: ModelOption,
  active: () => boolean = () => true,
): Promise<void> {
  const c = controls(rpc, sessionId, rows, active);
  await c.open(provider, 5000);
  const menu = c.screen();
  if (!isModelList(provider, menu)) throw new Error('The model menu changed');
  const label = cleanModelLabel(target.label);
  const number = menu.options.find((o) => cleanModelLabel(o.label) === label)?.n ?? target.n;
  const selected = menu.options.find((o) => o.selected);
  if (!selected || !Number.isInteger(number) || number < 1 || number > 99)
    throw new Error('Cannot locate the model highlight');
  const delta = number - selected.n;
  if (delta)
    await c.write(
      (delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)),
      (p) => isModelList(provider, p) && p.options.some((o) => o.selected && o.n === selected.n),
    );
  const matches = (p: TuiPicker | null) =>
    isModelList(provider, p) &&
    p.options.some((o) => o.selected && cleanModelLabel(o.label) === label);
  if (!(await c.wait(matches, 2000))) {
    // Esc is safe only while the model list is still up, never on a running turn.
    if (isModelList(provider, c.screen())) await c.write('\x1b', (p) => isModelList(provider, p));
    throw new Error('The model highlight did not reach the requested model');
  }
  const highlighted = c.screen();
  if (!matches(highlighted)) throw new Error('The model highlight changed');
  let confirmationKey = '\r';
  if (provider === 'claude') {
    if (!/^select model$/i.test(highlighted?.title ?? ''))
      throw new Error('The Claude model menu is not trusted');
    if (highlighted?.hint && !/\bs\b.*session/i.test(highlighted.hint))
      throw new Error('Claude model menu does not offer a session-only switch');
    confirmationKey = 's';
  }
  await c.write(confirmationKey, matches);
  if (provider === 'codex') {
    const reasoning = (p: TuiPicker | null) => /select reasoning level/i.test(p?.title ?? '');
    if (!(await c.wait(reasoning, 3000)) || !reasoning(c.screen()))
      throw new Error('The reasoning menu did not appear');
    await c.write('\r', (p) => reasoning(p) && !!p?.options.some((o) => o.selected));
  } else {
    // A blank frame is not completion: Claude's history confirm arrives later
    // and would swallow the message if we returned at the first empty screen.
    const confirmation = (p: TuiPicker | null) => /switch model\?/i.test(p?.title ?? '');
    if (await c.wait(confirmation, 2000)) {
      const p = c.screen();
      if (!confirmation(p) || !p?.options.some((o) => o.selected && /^Yes\b/i.test(o.label))) {
        throw new Error('The model switch confirmation is not on Yes');
      }
      await c.write(
        '\r',
        (p) => confirmation(p) && !!p?.options.some((o) => o.selected && /^Yes\b/i.test(o.label)),
      );
    }
  }
  if (!(await c.wait((p) => !p, 3000))) throw new Error('The model picker did not close');
}
