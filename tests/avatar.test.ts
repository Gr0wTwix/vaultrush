import { afterEach, describe, expect, it } from 'vitest';
import { state } from '../src/state.js';
import { avatar } from '../src/ui.js';

const PIC = 'https://avatars.fastly.steamstatic.com/abc123_full.jpg';

describe('avatar', () => {
  afterEach(() => { state.avatar = ''; });

  it('shows the initial when the player has no picture', () => {
    const html = avatar(state.name, 32);
    expect(html).not.toContain('<img');
    expect(html).toContain(state.name[0]!.toUpperCase());
  });

  it("shows the player's own picture, but only on their own avatar", () => {
    state.avatar = PIC;
    expect(avatar(state.name, 32)).toContain(`src="${PIC}"`);
    expect(avatar('mirage', 32)).not.toContain('<img');
  });

  it('ignores anything that is not an https image address', () => {
    for (const bad of ['javascript:alert(1)', 'http://example.com/a.png', 'data:image/png;base64,AAAA', '']) {
      state.avatar = bad;
      expect(avatar(state.name, 32)).not.toContain('<img');
    }
  });

  it('escapes the address so it cannot break out of the attribute', () => {
    state.avatar = 'https://example.com/a.png" onerror="alert(1)';
    expect(avatar(state.name, 32)).not.toContain('" onerror="alert(1)');
  });
});
