import { describe, expect, it } from 'vitest';
import { getHumanMarketItem, listHumanMarketItems } from './human-market';
import { getMarketItem } from './skill-market';

describe('human-market', () => {
  it('ships a non-empty prefab roster', () => {
    const items = listHumanMarketItems();
    expect(items.length).toBeGreaterThan(0);
  });

  it('every prefab has a stable, unique id and required fields', () => {
    const items = listHumanMarketItems();
    const ids = new Set<string>();
    for (const h of items) {
      expect(h.id).toBeTruthy();
      expect(ids.has(h.id)).toBe(false);
      ids.add(h.id);
      expect(h.name).toBeTruthy();
      expect(h.role).toBeTruthy();
      expect(h.industry).toBeTruthy();
      expect(h.title).toBeTruthy();
      expect(Array.isArray(h.skillIds)).toBe(true);
    }
  });

  it('every referenced skillId resolves to a real Skill Market item', () => {
    for (const h of listHumanMarketItems()) {
      for (const sid of h.skillIds) {
        expect(getMarketItem(sid), `${h.id} → ${sid}`).toBeDefined();
      }
    }
  });

  it('getHumanMarketItem finds by id and misses cleanly', () => {
    const first = listHumanMarketItems()[0];
    expect(first).toBeDefined();
    if (first) expect(getHumanMarketItem(first.id)?.id).toBe(first.id);
    expect(getHumanMarketItem('no-such-prefab')).toBeUndefined();
  });
});
