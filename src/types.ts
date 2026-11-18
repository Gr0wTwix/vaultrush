// Shared domain types. The core modules (fair, state, data, verify, race, feed) are checked with `strict: true`.

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type Speed = 'normal' | 'fast' | 'turbo';
export type Risk = 'low' | 'normal' | 'high';
export type DoubleLane = 'purple' | 'gray' | 'green' | 'bait';
export type DoubleColor = 'purple' | 'gray' | 'green';

export interface Item {
  id: string; weapon: string; skin: string; type: string; rarity: Rarity; value: number;
  img?: string; wear: string; st: boolean;
}

/** One row of a case's drop table. `from`/`to` are the inclusive ticket range out of 100,000. */
export interface CaseEntry { item: Item; weight: number; chance: number; from: number; to: number }

export interface CaseDef {
  id: string; name: string; hue: number; tag?: string; reward?: boolean;
  items?: string[]; odds?: Record<string, number>;
}
export interface Case extends CaseDef { img?: string; entries: CaseEntry[]; ev: number; price: number }

// ---- provably fair ----
export interface BetParams {
  case?: string; grid?: number; mines?: number; rows?: number; risk?: Risk;
  chance?: number; over?: boolean; players?: number; cases?: string[];
}
export interface BetEntry {
  id: string; game: string; nonce: number; clientSeed: string; serverHash: string; at: number; count: number;
  params?: BetParams; result?: string; key?: string;
}
export interface SeedPair { serverSeed: string; serverHash: string }
export interface RevealedSeed { serverSeed: string; serverHash: string; clientSeed: string; nonces: number; at: number }
export interface FairState extends SeedPair {
  clientSeed: string; nonce: number; next: SeedPair; revealed: RevealedSeed[]; history: BetEntry[];
}

// ---- player state ----
export interface HistoryBet { id?: number; game: string; amount: number; multi: number; payout: number; at: number }
/** Lifetime totals for one game, kept apart from the capped bet history so they stay accurate. */
export interface GameStat { bets: number; wagered: number; paid: number; bestPayout: number; bestMulti: number }
export interface TxEntry { id: number; type: string; amount: number; note: string; at: number }
export interface InvEntry { uid: string; id: string; at: number }
export interface GameState {
  name: string; balance: number; inv: InvEntry[]; lastClaim: number; muted: boolean; speed: Speed;
  stats: { wagered: number; won: number; bets: number };
  xp: number; keysUsed: number[];
  rakeback: { instant: number; daily: number; weekly: number; lastDaily: number; lastWeekly: number };
  lastDailyCase: number; welcomeLeft: number; promos: string[]; favs: string[];
  calendar: { streak: number; last: string };
  race: { date: string; wagered: number }; racePaid: string;
  history: HistoryBet[]; excludedUntil: number;
  ui: { chat: boolean; levelPopup: boolean; streamer: boolean; anonymous: boolean; fx: boolean; notify: boolean };
  legal: { termsAt: number; termsVersion: string };
  gameStats: Record<string, GameStat>;
  bestDrop: { id: string; source: string; value: number } | null;
  blocked: string[]; tx: TxEntry[]; betSeq: number;
  rg: RgState; kyc: KycState; aml: AmlState;
}

// ---- responsible gambling ----
/** Player-set limits in coins (or minutes). `null` means "no limit". */
export interface RgLimits {
  lossDaily: number | null; lossWeekly: number | null; lossMonthly: number | null;
  wagerDaily: number | null; maxBet: number | null; timeDailyMin: number | null;
  realityMin: number;                         // reality-check interval in minutes, 0 = off
}
export type RgLimitKey = keyof RgLimits;
/** A limit change that is waiting out its 24h cooling-off (raising or removing a limit is never instant). */
export interface RgPending { key: RgLimitKey; value: number | null; effectiveAt: number }
/** Per-UTC-day money buckets. `staked` is counted when the bet is placed; `wagered`/`paid` when it settles. */
export interface RgDay { staked: number; wagered: number; paid: number }
export interface RgState {
  ageConfirmedAt: number; limits: RgLimits; pending: RgPending[]; coolOffUntil: number;
  days: Record<string, RgDay>; timeMs: Record<string, number>; lastRealityAt: number; sessionStart: number;
  assessments: { at: number; score: number; band: string }[]; log: { at: number; text: string }[];
}

// ---- KYC / AML (sandbox) ----
export type KycTier = 0 | 1 | 2;
export type KycDocStatus = 'none' | 'approved' | 'rejected' | 'review' | 'hold';
export interface KycState {
  tier: KycTier; fullName: string; email: string; emailVerifiedAt: number; dob: string;
  docStatus: KycDocStatus; docReason: string; sandbox: string; submittedAt: number;
  sofDeclared: boolean; sofText: string; pendingCode: string; codeAt: number;
  log: { at: number; text: string }[];
}
export type AlertSeverity = 'low' | 'medium' | 'high';
export interface AmlAlert { id: number; rule: string; severity: AlertSeverity; text: string; at: number; status: 'open' | 'cleared' }
export interface Payout { id: number; amount: number; at: number; decision: 'approved' | 'review' | 'rejected'; reasons: string[]; score: number }
export interface AmlState { alerts: AmlAlert[]; payouts: Payout[]; seq: number }

// ---- live feed ----
export interface Drop { user: string; item: Item; source: string; at: number }
export interface LiveBet { user: string; game: string; amount: number; multi: number; payout: number; mine?: boolean; at: number }
