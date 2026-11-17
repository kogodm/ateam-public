import type { Result } from '@ateam/contract';
import { useCallback, useEffect, useState } from 'react';
import { Tip } from './Tip';
import type { Rpc } from './rpc';

type Prompt = Result<'prompts.list'>['prompts'][number];

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Settings → Prompts: every prompt the app sends on the user's behalf, what
 * each one is for, and an editor. Saving writes an override that the core
 * reads on the next use (prompts.ts); reset deletes it. The bundled defaults
 * live inside a read-only app bundle, so this page is the only way an end
 * user can change them.
 */
export function PromptsPane({ rpc }: { rpc: Rpc }): JSX.Element {
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [overrideDir, setOverrideDir] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(async (): Promise<Prompt[] | null> => {
    try {
      const r = await rpc.request('prompts.list', {});
      setPrompts(r.prompts);
      setOverrideDir(r.overrideDir);
      setLoadErr('');
      return r.prompts;
    } catch (e) {
      setLoadErr(`couldn't load prompts: ${message(e)}`);
      return null;
    }
  }, [rpc]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (p: Prompt): void => {
    setNote(null);
    if (open === p.name) {
      setOpen(null);
      return;
    }
    setOpen(p.name);
    setDraft(p.text);
  };

  const save = async (p: Prompt): Promise<void> => {
    try {
      const r = await rpc.request('prompts.set', { name: p.name, text: draft });
      await load();
      const dropped = r.missingPlaceholders.map((v) => `{{${v}}}`).join(', ');
      setNote(
        dropped
          ? {
              text: `Saved. ${dropped} is gone — what the app fills in there now goes nowhere.`,
              warn: true,
            }
          : { text: 'Saved — used the next time this prompt is sent.' },
      );
    } catch (e) {
      setNote({ text: `couldn't save: ${message(e)}`, warn: true });
    }
  };

  const reset = async (p: Prompt): Promise<void> => {
    try {
      await rpc.request('prompts.reset', { name: p.name });
      const fresh = (await load())?.find((x) => x.name === p.name);
      if (fresh) setDraft(fresh.text);
      setNote({ text: 'Back to the built-in text.' });
    } catch (e) {
      setNote({ text: `couldn't reset: ${message(e)}`, warn: true });
    }
  };

  const row = (p: Prompt): JSX.Element => {
    const isOpen = open === p.name;
    const dirty = isOpen && draft !== p.text;
    return (
      <div className="field-row prompt-row" key={p.name}>
        <div className="prompt-head">
          <button
            type="button"
            className="prompt-toggle name"
            aria-expanded={isOpen}
            onClick={() => toggle(p)}
          >
            {p.title}
          </button>
          <Tip>{p.when}</Tip>
          <span className="prompt-spacer" />
          {p.customized && <span className="prompt-state">customized</span>}
          <button
            type="button"
            className="prompt-toggle prompt-chev"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={() => toggle(p)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        </div>
        {isOpen && (
          <div className="prompt-editor">
            <textarea
              value={draft}
              spellCheck={false}
              rows={14}
              onChange={(e) => {
                setDraft(e.target.value);
                setNote(null);
              }}
            />
            {p.placeholders.length > 0 && (
              <div className="prompt-vars">
                <span>Filled in by the app:</span>
                {p.placeholders.map((v) => (
                  <code
                    key={v}
                    className={draft.includes(`{{${v}}}`) ? '' : 'missing'}
                    title={draft.includes(`{{${v}}}`) ? '' : 'removed from this text'}
                  >
                    {'{{'}
                    {v}
                    {'}}'}
                  </code>
                ))}
              </div>
            )}
            {!draft.trim() && <em className="field-flag">An empty prompt sends nothing.</em>}
            <div className="top prompt-actions">
              <span className="name" />
              <span className="control">
                {p.customized && (
                  <button type="button" className="threshold-save" onClick={() => void reset(p)}>
                    Reset to default
                  </button>
                )}
                <button
                  type="button"
                  className="threshold-save"
                  disabled={!dirty}
                  onClick={() => setDraft(p.text)}
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  className="threshold-save"
                  disabled={!dirty}
                  onClick={() => void save(p)}
                >
                  Save
                </button>
              </span>
            </div>
            {note && <em className={`field-flag${note.warn ? '' : ' info'}`}>{note.text}</em>}
          </div>
        )}
      </div>
    );
  };

  const live = prompts?.filter((p) => p.live) ?? [];
  const dormant = prompts?.filter((p) => !p.live) ?? [];
  return (
    <section className="section">
      <div className="settings-eyebrow">Model</div>
      <h3 className="section-title">
        Prompts
        <Tip>
          What the app tells the model on your behalf. An edit is saved as an override
          {overrideDir ? (
            <>
              {' '}
              in <code className="mono">{overrideDir}</code>
            </>
          ) : null}{' '}
          and is used the next time the prompt is sent — no restart. A running session picks up its
          start-up prompts the next time it resumes or is cleared.
        </Tip>
      </h3>
      {loadErr && <em className="field-flag">{loadErr}</em>}
      {live.map(row)}
      {dormant.length > 0 && (
        <>
          <div className="settings-eyebrow prompt-group">
            Dormant — nothing sends these by default
          </div>
          {dormant.map(row)}
        </>
      )}
    </section>
  );
}
