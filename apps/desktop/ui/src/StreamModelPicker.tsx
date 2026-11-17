import type { ProviderId } from '@ateam/contract';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { modelMenuAnchor } from './modelPickerActions';
import {
  cleanModelLabel,
  readModelMenu,
  type ModelMenu,
  type ModelOption,
  type PendingModel,
} from './modelMenuCache';
import { discoverModelMenu } from './modelSwitch';
import type { Rpc } from './rpc';
import { readScreen } from './termRegistry';

export function StreamModelPicker({
  rpc,
  sessionId,
  providerId,
  label,
  pendingModel,
  onChoose,
  disabled,
  onOpenChange,
  onUserInput,
}: {
  rpc: Rpc;
  sessionId: string;
  providerId: ProviderId;
  label: string;
  pendingModel: PendingModel | null;
  onChoose: (option: ModelOption | null) => void;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onUserInput?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [anchor, setAnchor] = useState({ right: 12, bottom: 60, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDialogElement>(null);
  const [menu, setMenu] = useState<ModelMenu | null>(null);
  const mounted = useRef(true);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const focusStage = menu?.at;
  useEffect(() => {
    if (!open || !focusStage || sending) return;
    const target =
      panel.current?.querySelector<HTMLButtonElement>('.sv-model-option.selected') ??
      panel.current?.querySelector<HTMLButtonElement>('.sv-model-option');
    target?.focus({ preventScroll: true });
  }, [open, focusStage, sending]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onOpenChange(open);
  }, [open, onOpenChange]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setAnchor(modelMenuAnchor(rect, window.innerWidth, window.innerHeight));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const close = () => {
    if (sending) return;
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  });

  const launch = async () => {
    if (open) {
      close();
      return;
    }
    if (disabled || sending) return;
    setError('');
    setOpen(true);
    const cached = readModelMenu(providerId);
    setMenu(cached);
    if (cached) return;
    setSending(true);
    try {
      onUserInput?.(sessionId);
      const discovered = await discoverModelMenu(
        rpc,
        sessionId,
        () => readScreen(sessionId),
        providerId,
        () => mounted.current && !disabledRef.current,
      );
      if (mounted.current) setMenu(discovered);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  const choose = (option: ModelOption) => {
    if (sending || disabled) return;
    onChoose(
      cleanModelLabel(option.label).toLowerCase() ===
        cleanModelLabel(pendingModel?.label ?? label).toLowerCase()
        ? null
        : option,
    );
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`sv-model-chip${open ? ' active' : ''}`}
        disabled={disabled || sending}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => void launch()}
        title={
          disabled
            ? 'Model selection is unavailable during handoff or send'
            : 'Choose model'
        }
      >
        {pendingModel?.label ?? label}
        <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <dialog
            open
            ref={panel}
            className="sv-model-menu"
            aria-label="Choose model"
            style={anchor}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const options = [
                  ...(panel.current?.querySelectorAll<HTMLButtonElement>(
                    '.sv-model-option:not(:disabled)',
                  ) ?? []),
                ];
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? options.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) %
                        options.length;
                options[next]?.focus();
              }
            }}
          >
            <div className="sv-model-menu-head">
              <span>Choose model</span>
              <button
                type="button"
                disabled={sending}
                aria-label="Close model menu"
                onClick={close}
              >
                ×
              </button>
            </div>
            {menu ? (
              menu.options.map((option) => {
                const selected =
                  cleanModelLabel(option.label).toLowerCase() ===
                  cleanModelLabel(pendingModel?.label ?? label).toLowerCase();
                return (
                  <button
                    key={option.n}
                    type="button"
                    className={`sv-model-option${selected ? ' selected' : ''}`}
                    disabled={sending || disabled}
                    onClick={() => choose(option)}
                  >
                    <span className="sv-model-option-body">
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    <span
                      className="sv-model-check"
                      aria-label={selected ? 'Selected model' : undefined}
                    >
                      {selected ? '✓' : option.n}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="sv-model-loading">
                {error ? 'Model menu unavailable' : 'Opening CLI model menu…'}
              </div>
            )}
            {error && (
              <div role="alert" className="sv-model-error">
                {error}
              </div>
            )}
            <div className="sv-model-menu-foot">Switches this session immediately after selection.</div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
