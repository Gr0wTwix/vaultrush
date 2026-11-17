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
  ui: { chat: boolean; levelPopup: boolean; streamer: boolean };
  blocked: string[]; tx: TxEntry[]; betSeq: number;
}

// ---- live feed ----
export interface Drop { user: string; item: Item; source: string; at: number }
export interface LiveBet { user: string; game: string; amount: number; multi: number; payout: number; mine?: boolean; at: number }
