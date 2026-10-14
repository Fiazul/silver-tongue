import { describe, expect, it } from 'vitest';
import { createExperimentStore, shouldSend, type ExperimentSave } from '../src/session';

function storage() {
  const values = new Map<string, string>([['silver-tongue:settings', 'original'], ['silver-tongue-lab-door:game', 'door']]);
  return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
}
const saved = { state: { phase: 'merchant', draft: '오늘 5000 원에 할 수 있어요.' }, support: true, pronunciation: false } as unknown as ExperimentSave;

describe('separate experiment sessions', () => {
  it('round trips a composing draft without reading or writing the original namespaces', () => {
    const kv = storage();
    const store = createExperimentStore(kv);
    expect(store.load().save).toBeNull();
    expect(store.save(saved)).toBe(true);
    expect(store.load().save).toEqual(saved);
    expect([...kv.values.keys()]).toEqual(['silver-tongue:settings', 'silver-tongue-lab-door:game', 'silver-tongue-lab-merchant:v1']);
    expect(kv.values.get('silver-tongue:settings')).toBe('original');
    expect(kv.values.get('silver-tongue-lab-door:game')).toBe('door');
  });
  it('preserves an unreadable save as a backup and starts recoverably', () => {
    const kv = storage();
    kv.values.set('silver-tongue-lab-merchant:v1', '{broken');
    const result = createExperimentStore(kv).load();
    expect(result).toEqual({ save: null, recovered: true });
    expect(kv.values.get('silver-tongue-lab-merchant:v1:backup')).toBe('{broken');
  });
  it('keeps a playable in-memory session when storage is unavailable', () => {
    const store = createExperimentStore({ getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('quota'); } });
    expect(store.save(saved)).toBe(false);
    expect(store.load().save).toEqual(saved);
  });
  it('never sends while Enter is completing an input-method composition', () => {
    expect(shouldSend({ key: 'Enter', isComposing: true, keyCode: 13, shiftKey: false })).toBe(false);
    expect(shouldSend({ key: 'Enter', isComposing: false, keyCode: 229, shiftKey: false })).toBe(false);
    expect(shouldSend({ key: 'Enter', isComposing: false, keyCode: 13, shiftKey: true })).toBe(false);
    expect(shouldSend({ key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false })).toBe(true);
  });
});
