// The free-reward numbers as the database pays them (admin step E, migration 0023): faucet amount and timer, rakeback shares, the login calendar
// and the daily race prizes. Loaded at start-up; without a backend, or before 0023, the page keeps its built-in numbers (the same defaults).
import { backendEnabled, call } from './backend.js';
import { applyRewardSettings } from './state.js';
import { PRIZES } from './race.js';

interface RewardSettings { faucet_amount: number; faucet_minutes: number; rakeback: { instant: number; daily: number; weekly: number }; calendar: number[]; race_prizes: number[] }
const ok = (s: any): s is RewardSettings => !!s && Number(s.faucet_amount) > 0 && Number(s.faucet_minutes) > 0 && Array.isArray(s.calendar) && s.calendar.length === 7
  && Array.isArray(s.race_prizes) && s.race_prizes.length > 0 && !!s.rakeback;

/** Loads and applies the reward settings. Resolves true when they were applied. Never throws. */
export async function syncRewards(): Promise<boolean> {
  if (!backendEnabled()) return false;
  try {
    const s = await call<RewardSettings>('reward_settings_public');
    if (!ok(s)) return false;
    applyRewardSettings(s);
    PRIZES.splice(0, PRIZES.length, ...s.race_prizes.map(Number));
    return true;
  } catch { return false; }
}
