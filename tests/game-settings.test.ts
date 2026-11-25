// Admin step E part 3 on the game site (migration 0025): the page follows the game settings (timings, bots, simulated activity).
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({ answer: null as any, down: false }));
vi.mock('../src/backend.js', async orig => ({
  ...(await orig<typeof import('../src/backend.js')>()),
  backendEnabled: () => true,
  call: async (fn: string) => { if (srv.down) throw new Error('offline'); if (fn !== 'game_settings_public') throw new Error(fn); return srv.answer; },
}));

const { GS, syncGameSettings } = await import('../src/game-settings.js');
const { BOTS } = await import('../src/data.js');
const src = (p: string): string => readFileSync(resolve(__dirname, '..', 'src', p), 'utf8');
const ANSWER = { crash_bet_seconds: 15, double_bet_seconds: 20, lobby_minutes: 10, battle_lobbies_max: 2, flip_lobbies_max: 4, bots_battles: false, bots_coinflip: true,
  simulated_activity: false, bot_names: ['alpha_bot', 'beta_bot', 'gamma_bot'], limits: { plinko: { min: 1, max: 20 } } };

beforeEach(() => { srv.down = false; });

describe('game settings on the game site', () => {
  it('keeps the built-in values when the database cannot answer', async () => {
    srv.down = true;
    expect(await syncGameSettings()).toBe(false);
    expect(GS).toMatchObject({ crashBetMs: 7000, doubleBetMs: 12000, botsBattles: true, simulated: true });
    srv.down = false; srv.answer = { ...ANSWER, crash_bet_seconds: 0 };
    expect(await syncGameSettings()).toBe(false);
  });
  it('applies the timings, bots, simulated activity and limits; bot names replace the list in place', async () => {
    const list = BOTS;
    srv.answer = ANSWER;
    expect(await syncGameSettings()).toBe(true);
    expect(GS).toMatchObject({ crashBetMs: 15000, doubleBetMs: 20000, lobbyMinutes: 10, battleLobbiesMax: 2, flipLobbiesMax: 4, botsBattles: false, botsCoinflip: true, simulated: false });
    expect(GS.limits['plinko']).toEqual({ min: 1, max: 20 });
    expect(list).toBe(BOTS); expect(BOTS).toEqual(['alpha_bot', 'beta_bot', 'gamma_bot']);
  });
  it('the pages read the settings instead of their own copies', () => {
    expect(src('views/crash.ts')).not.toMatch(/const WAIT_MS/); expect(src('views/crash.ts')).toMatch(/GS\.crashBetMs/);
    expect(src('views/double.ts')).not.toMatch(/const BET_MS/); expect(src('views/double.ts')).toMatch(/GS\.doubleBetMs/);
    expect(src('feed.ts')).toMatch(/function simDrop\(\): void \{\s*if \(!GS\.simulated\) return;/);
    expect(src('feed.ts')).toMatch(/function simBet\(\): void \{\s*if \(!GS\.simulated\) return;/);
    expect(src('views/battles.ts')).toMatch(/b\.live && !GS\.botsBattles/);
    expect(src('views/coinflip.ts')).toMatch(/g\.mine && \(!g\.live \|\| GS\.botsCoinflip\)/);
  });
});
