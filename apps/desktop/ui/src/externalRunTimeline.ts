import type { ExternalRunDTO } from '@ateam/contract';

export type ExternalTimelineEntry<T> = T | { kind: 'external_run'; run: ExternalRunDTO };

export function lastConversationItemIndex(entries: readonly { kind: string }[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.kind !== 'external_run') return index;
  }
  return -1;
}

export function insertExternalRuns<T>(
  items: readonly T[],
  runs: readonly ExternalRunDTO[],
  itemAt: (item: T) => string,
): ExternalTimelineEntry<T>[] {
  const uniqueRuns = new Map<string, ExternalRunDTO>();
  for (const run of runs) uniqueRuns.set(run.executionId, run);

  const orderedRuns = [...uniqueRuns.values()].sort((a, b) => {
    const aTime = Date.parse(a.startedAt);
    const bTime = Date.parse(b.startedAt);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid && aTime !== bTime) return aTime - bTime;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return a.executionId.localeCompare(b.executionId);
  });

  const beforeItem = new Map<number, ExternalRunDTO[]>();
  const append: ExternalRunDTO[] = [];
  const invalidTimes: ExternalRunDTO[] = [];
  for (const run of orderedRuns) {
    const runTime = Date.parse(run.startedAt);
    if (!Number.isFinite(runTime)) {
      invalidTimes.push(run);
      continue;
    }
    const targetIndex = items.findIndex((item) => {
      const itemTime = Date.parse(itemAt(item));
      return Number.isFinite(itemTime) && itemTime >= runTime;
    });
    if (targetIndex < 0) append.push(run);
    else {
      const bucket = beforeItem.get(targetIndex) ?? [];
      bucket.push(run);
      beforeItem.set(targetIndex, bucket);
    }
  }

  const result: ExternalTimelineEntry<T>[] = [];
  items.forEach((item, index) => {
    for (const run of beforeItem.get(index) ?? []) result.push({ kind: 'external_run', run });
    result.push(item);
  });
  for (const run of append) result.push({ kind: 'external_run', run });
  for (const run of invalidTimes) result.push({ kind: 'external_run', run });
  return result;
}
