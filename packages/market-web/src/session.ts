import type { MarketState } from '@silver-tongue/core/market';

export interface ExperimentSave { state: Readonly<MarketState>; support: boolean; pronunciation: boolean; sound?: boolean }
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void }
const KEY = 'silver-tongue-lab-merchant:v1';

export function createExperimentStore(storage: StoragePort) {
  let memory: ExperimentSave | null = null;
  return {
    load(): { save: ExperimentSave | null; recovered: boolean } {
      try {
        const raw = storage.getItem(KEY);
        if (!raw) return { save: memory, recovered: false };
        try {
          const value: unknown = JSON.parse(raw);
          if (!value || typeof value !== 'object' || !('state' in value) || typeof (value as ExperimentSave).support !== 'boolean' || typeof (value as ExperimentSave).pronunciation !== 'boolean') throw new Error('Invalid experiment save');
          return { save: value as ExperimentSave, recovered: false };
        } catch {
          storage.setItem(`${KEY}:backup`, raw);
          return { save: memory, recovered: true };
        }
      } catch { return { save: memory, recovered: false }; }
    },
    backup() {
      try { const raw = storage.getItem(KEY); if (raw) storage.setItem(`${KEY}:backup`, raw); } catch { /* The current memory state stays playable. */ }
    },
    save(value: ExperimentSave): boolean {
      memory = value;
      try { storage.setItem(KEY, JSON.stringify(value)); return true; }
      catch { return false; }
    },
  };
}

export const shouldSend = (event: { key: string; isComposing: boolean; keyCode: number; shiftKey: boolean }) =>
  event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.shiftKey;
