// @vitest-environment node
// The phone styles of 2026-11-21 (checked by eye in the browser pane at 375 px and at desktop width): the wrapper is invisible on wide screens, big battles scroll
// sideways on phones with readable columns, Plinko labels stand on their side, and toasts clear the bottom menu bar.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const games = readFileSync(new URL('../src/css/games.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/css/app.css', import.meta.url), 'utf8');

describe('the phone styles', () => {
  it('the board wrapper makes no box on wide screens, so the battle rows lay out as before', () => {
    expect(games).toMatch(/\.bt-board, \.bt-board-in \{ display: contents; \}/);
    expect(games).toMatch(/\.bt-swipe \{ display: none; \}/);
  });
  it('on phones the board scrolls sideways and keeps every column at least 92 px wide', () => {
    const phone = games.slice(games.indexOf('@media (max-width: 900px) {\n  .bt-board'));
    expect(phone).toMatch(/\.bt-board \{ display: block; overflow-x: auto;/);
    expect(phone).toMatch(/width: max\(100%, calc\(var\(--P\) \* 92px/);
    expect(phone).toMatch(/\.bt-swipe \{ display: block;/);
  });
  it('the Plinko labels turn on their side on phones, with the slot gap left alone so the slots stay under their pegs', () => {
    const plinko = games.slice(games.indexOf('/* Plinko: the multiplier'));
    expect(plinko).toMatch(/writing-mode: vertical-lr/);
    expect(plinko).not.toMatch(/\.buckets \{ gap/);
  });
  it('toasts sit above the bottom menu bar on phones', () => {
    expect(app).toMatch(/@media \(max-width: 900px\) \{ \.toasts \{ bottom: calc\(74px/);
  });
});

describe('the pause between battle rounds', () => {
  it('the battle view waits for roundPauseMs() after every round, not the old 400 ms', () => {
    const src = readFileSync(new URL('../src/views/battles.ts', import.meta.url), 'utf8');
    expect(src).toContain('await sleep(roundPauseMs())');
    expect(src).not.toContain("'turbo' ? 150 : 400");
  });
});
