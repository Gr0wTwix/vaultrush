// Game settings from the admin site (admin step E part 3, migration 0025): the Crash and Double betting windows, lobby expiry and caps, house
// bots, simulated activity and the stake limits per game. Loaded at start-up; without a backend (or before 0025) the built-in defaults stay,
// which are the same values. The database enforces the limits; the page only follows them so it shows the right timers and buttons.
import { backendEnabled, call } from './backend.js';
import { BOTS } from './data.js';

export const GS = {
  crashBetMs: 7000, doubleBetMs: 12000, lobbyMinutes: 30, battleLobbiesMax: 3, flipLobbiesMax: 5,
  botsBattles: true, botsCoinflip: true, simulated: true,
  limits: {} as Record<string, { min: number; max: number }>,
};

interface Public { crash_bet_seconds: number; double_bet_seconds: number; lobby_minutes: number; battle_lobbies_max: number; flip_lobbies_max: number;
  bots_battles: boolean; bots_coinflip: boolean; simulated_activity: boolean; bot_names: string[]; limits: Record<string, { min: number; max: number }> }

/** Use the settings (exported for tests). Bot names replace the built-in list in place, so every page picks bots the database accepts. */
export function applyGameSettings(s: Public): void {
  GS.crashBetMs = Number(s.crash_bet_seconds) * 1000; GS.doubleBetMs = Number(s.double_bet_seconds) * 1000; GS.lobbyMinutes = Number(s.lobby_minutes);
  GS.battleLobbiesMax = Number(s.battle_lobbies_max); GS.flipLobbiesMax = Number(s.flip_lobbies_max);
  GS.botsBattles = !!s.bots_battles; GS.botsCoinflip = !!s.bots_coinflip; GS.simulated = !!s.simulated_activity;
  GS.limits = Object.fromEntries(Object.entries(s.limits ?? {}).map(([g, l]) => [g, { min: Number(l.min), max: Number(l.max) }]));
  if (Array.isArray(s.bot_names) && s.bot_names.length >= 3) BOTS.splice(0, BOTS.length, ...s.bot_names);
}

/** Loads and applies the settings. Resolves true when they were applied. Never throws. */
export async function syncGameSettings(): Promise<boolean> {
  if (!backendEnabled()) return false;
  try {
    const s = await call<Public>('game_settings_public');
    if (!s || !(Number(s.crash_bet_seconds) > 0) || !(Number(s.double_bet_seconds) > 0)) return false;
    applyGameSettings(s);
    return true;
  } catch { return false; }
}
