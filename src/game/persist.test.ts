import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game, SAVE_VERSION } from './game';
import { BACKUP_LIMIT, backupGame, defaultSaveName, type SaveEntry, type SaveStore, staleBackups } from './persist';

/** Сохранения со своими именами в памяти — вместо IndexedDB. */
function memoryStore() {
  const entries = new Map<string, SaveEntry>();
  let clock = 0;
  let next = 0;
  const written: Game[] = [];
  const store: SaveStore = {
    list: async () => [...entries.values()].sort((a, b) => b.savedAt - a.savedAt),
    write: async (game, name, _camera, id, backup) => {
      game.toSave();
      written.push(game);
      const entry: SaveEntry = { id: id ?? `s${++next}`, name, savedAt: ++clock, summary: game.dateLabel, version: SAVE_VERSION, ...(backup ? { backup: true } : {}) };
      entries.set(entry.id, entry);
      return entry;
    },
    remove: async (id) => {
      entries.delete(id);
    },
  };
  return { store, entries, written };
}

const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });

describe('Резервное сохранение перед новой игрой', () => {
  it('партия не из сохранения — новой резервной копией с понятным именем; свои сохранения не трогает', async () => {
    const { store, entries, written } = memoryStore();
    const own = await store.write(game, 'Моя сеть');
    const kept = await backupGame(game, null, undefined, store);
    expect(kept.backup).toBe(true);
    expect(kept.name).toBe(`Резервная копия · ${defaultSaveName(game)}`);
    expect(kept.id).not.toBe(own.id);
    expect(entries.get(own.id)?.name).toBe('Моя сеть');
    expect(entries.size).toBe(2);
    expect(written.at(-1)).toBe(game);
  });

  it('партия из сохранения — поверх него, новой копии нет', async () => {
    const { store, entries } = memoryStore();
    const own = await store.write(game, 'Моя сеть');
    const kept = await backupGame(game, own.id, undefined, store);
    expect(kept.id).toBe(own.id);
    expect(kept.name).toBe('Моя сеть');
    expect(kept.backup).toBeUndefined();
    expect(entries.size).toBe(1);
    expect(entries.get(own.id)!.savedAt).toBeGreaterThan(own.savedAt);
  });

  it('открытая резервная копия при следующей новой игре остаётся резервной копией', async () => {
    const { store, entries } = memoryStore();
    const first = await backupGame(game, null, undefined, store);
    const again = await backupGame(game, first.id, undefined, store);
    expect(again.id).toBe(first.id);
    expect(again.backup).toBe(true);
    expect(entries.size).toBe(1);
  });

  it(`копий — не больше ${BACKUP_LIMIT}: старые удаляются, свои сохранения остаются`, async () => {
    const { store, entries } = memoryStore();
    const own = await store.write(game, 'Моя сеть');
    const copies: SaveEntry[] = [];
    for (let i = 0; i < BACKUP_LIMIT + 2; i++) copies.push(await backupGame(game, null, undefined, store));
    const left = [...entries.values()];
    expect(left.filter((e) => e.backup).map((e) => e.id)).toEqual(copies.slice(-BACKUP_LIMIT).map((e) => e.id));
    expect(entries.has(own.id)).toBe(true);
  });

  it('лишние копии — самые старые, обычные сохранения не в счёт', () => {
    const e = (id: string, savedAt: number, backup?: boolean): SaveEntry => ({ id, name: id, savedAt, summary: '', version: SAVE_VERSION, ...(backup ? { backup } : {}) });
    const list = [e('a', 1, true), e('b', 5, true), e('own', 0), e('c', 3, true), e('d', 4, true)];
    expect(staleBackups(list, 3)).toEqual(['a']);
    expect(staleBackups(list, 2)).toEqual(['c', 'a']);
    expect(staleBackups([e('own', 1), e('own2', 2)], 0)).toEqual([]);
  });
});
