// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_TEXT, backendEnabled, explain, getClient } from '../src/backend.js';

describe('optional backend client', () => {
  it('stays off without configuration and never loads supabase-js', async () => {
    expect(backendEnabled()).toBe(false);
    await expect(getClient()).rejects.toThrow(/not configured/);
  });

  it('explains every error code that place_bet can raise', () => {
    const sql = readFileSync(new URL('../supabase/migrations/0001_core.sql', import.meta.url), 'utf8');
    const start = sql.indexOf('create function public.place_bet'), end = sql.indexOf('-- Only signed-in players');
    const codes = [...sql.slice(start, end).matchAll(/raise exception '([a-z_]+)'/g)].map(m => m[1] as string);
    expect(codes.length).toBeGreaterThanOrEqual(12);
    for (const c of new Set(codes)) expect(ERROR_TEXT[c], `no player message for ${c}`).toBeTruthy();
  });

  it('turns a database error into plain language and passes unknown errors through', () => {
    expect(explain({ message: 'insufficient_funds' })).toBe('Not enough coins.');
    expect(explain({ message: 'P0001: tier_cap_exceeded' })).toMatch(/verification/);
    expect(explain({ message: 'connection reset' })).toBe('connection reset');
    expect(explain(null)).toBe('Something went wrong.');
  });
});
