// Procedural item art: detailed multi-part weapon silhouettes with a per-skin paint pattern.
// Every item is original (no real game assets). If an item has `img` (e.g. an AI-generated PNG
// dropped into assets/items/), that image is used instead.

let uid = 0;
const nid = () => `a${(++uid).toString(36)}`;

// ---- skins: pattern style + palette -------------------------------------------------------------
export const SKINS = {
  'Static':        { style: 'stripes', c: ['#7d8799', '#4b5366', '#a9b2c3'] },
  'Grid Rot':      { style: 'circuit', c: ['#4a5a3a', '#2c3524', '#9bd36b'] },
  'Sandblast':     { style: 'camo',    c: ['#c8a46e', '#8f6d43', '#e8d3a3'] },
  'Field Kit':     { style: 'camo',    c: ['#5e6b45', '#36402a', '#8b9566'] },
  'Night Tide':    { style: 'fade',    c: ['#0f2a5c', '#2f6fd6', '#7fd1ff'] },
  'Ember':         { style: 'flame',   c: ['#2a1410', '#ff5a1f', '#ffc53d'] },
  'Mossback':      { style: 'camo',    c: ['#3f5e3a', '#24361f', '#7fa86a'] },
  'Ice Vein':      { style: 'marble',  c: ['#cfefff', '#5fb4ff', '#ffffff'] },
  'Neon Fang':     { style: 'tiger',   c: ['#14102a', '#c44dff', '#ff7af0'] },
  'Acid Bloom':    { style: 'marble',  c: ['#16260c', '#9dff3a', '#e8ff7a'] },
  'Circuit':       { style: 'circuit', c: ['#0c2a2c', '#11b5a8', '#7dfff1'] },
  'Redline':       { style: 'stripes', c: ['#141418', '#e0263a', '#ff6b78'] },
  'Tidebreaker':   { style: 'fade',    c: ['#08353f', '#17a6a6', '#c6fff5'] },
  'Crystal Skull': { style: 'galaxy',  c: ['#1a0f33', '#ff4fc8', '#ffffff'] },
  'Prism':         { style: 'prism',   c: ['#ff4fc8', '#33d6ff', '#c6ff3d'] },
  'Solar Flare':   { style: 'flame',   c: ['#3a0d06', '#ff3d1f', '#ffe066'] },
  'Thunderhead':   { style: 'tiger',   c: ['#1b2233', '#4f9dff', '#e6f3ff'] },
  'Voidwalker':    { style: 'galaxy',  c: ['#06040f', '#6a3dff', '#b9a4ff'] },
  'Rust Edge':     { style: 'marble',  c: ['#5a2a14', '#b5541e', '#e39a5a'] },
  'Dragon Coil':   { style: 'tiger',   c: ['#2b0a0a', '#ff5a1f', '#ffc53d'] },
  'Night Bloom':   { style: 'galaxy',  c: ['#0c0a22', '#ff4fc8', '#7fd1ff'] },
  'Aurora':        { style: 'prism',   c: ['#3dffa0', '#33d6ff', '#a66bff'] },
  'Molten Gold':   { style: 'fade',    c: ['#7a4a00', '#ffc53d', '#fff4c2'] },
  'Galaxy Fade':   { style: 'galaxy',  c: ['#120a3a', '#ff4fc8', '#ffd36b'] },
  'Starforged':    { style: 'prism',   c: ['#ffc53d', '#ff4fc8', '#33d6ff'] },
};
const DEFAULT_SKIN = { style: 'fade', c: ['#3a4560', '#7d8aa8', '#c9d3ea'] };

function paintDefs(id, skin) {
  const [a, b, c] = skin.c;
  const shine = `<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>`;
  const metal = `<linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b94a7"/><stop offset=".5" stop-color="#3b4253"/><stop offset="1" stop-color="#1b1f29"/></linearGradient>`;
  const grip = `<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a2f3b"/><stop offset="1" stop-color="#15181f"/></linearGradient>`;
  let p;
  switch (skin.style) {
    case 'fade':
      p = `<linearGradient id="${id}p" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`; break;
    case 'prism':
      p = `<linearGradient id="${id}p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`; break;
    case 'camo':
      p = `<pattern id="${id}p" width="34" height="22" patternUnits="userSpaceOnUse"><rect width="34" height="22" fill="${a}"/><ellipse cx="8" cy="6" rx="9" ry="5" fill="${b}"/><ellipse cx="26" cy="15" rx="10" ry="6" fill="${b}"/><ellipse cx="22" cy="4" rx="5" ry="3" fill="${c}"/><ellipse cx="6" cy="18" rx="6" ry="3" fill="${c}"/></pattern>`; break;
    case 'tiger':
      p = `<pattern id="${id}p" width="16" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><rect width="16" height="40" fill="${b}"/><path d="M0 0h5l-2 40H0z" fill="${a}"/><path d="M9 0h2l1 40h-4z" fill="${c}" opacity=".7"/></pattern>`; break;
    case 'stripes':
      p = `<pattern id="${id}p" width="200" height="80" patternUnits="userSpaceOnUse"><rect width="200" height="80" fill="${a}"/><rect y="34" width="200" height="5" fill="${b}"/><rect y="40" width="200" height="1.5" fill="${c}"/></pattern>`; break;
    case 'circuit':
      p = `<pattern id="${id}p" width="24" height="16" patternUnits="userSpaceOnUse"><rect width="24" height="16" fill="${a}"/><path d="M0 4h8v6h10V2h6M4 16v-4h6M14 0v4" fill="none" stroke="${b}" stroke-width="1.2"/><circle cx="18" cy="10" r="1.6" fill="${c}"/><circle cx="8" cy="4" r="1.2" fill="${c}"/></pattern>`; break;
    case 'galaxy':
      p = `<pattern id="${id}p" width="200" height="80" patternUnits="userSpaceOnUse"><rect width="200" height="80" fill="${a}"/><ellipse cx="60" cy="34" rx="50" ry="16" fill="${b}" opacity=".55"/><ellipse cx="140" cy="40" rx="45" ry="12" fill="${c}" opacity=".35"/>${Array.from({ length: 26 }, (_, i) => `<circle cx="${(i * 47) % 200}" cy="${(i * 29) % 80}" r="${i % 4 ? 0.7 : 1.3}" fill="#fff" opacity=".85"/>`).join('')}</pattern>`; break;
    case 'flame':
      p = `<pattern id="${id}p" width="200" height="80" patternUnits="userSpaceOnUse"><rect width="200" height="80" fill="${a}"/><path d="M0 48c14-10 18-26 30-30-4 12 8 16 14 8 2 10 10 14 18 4 0 14 12 16 20 6 2 12 16 14 24 2 4 10 14 12 22 0 0 12 14 16 26 6 4 10 16 12 26 4v40H0z" fill="${b}"/><path d="M0 58c12-6 16-16 26-18-2 8 6 10 10 4 2 8 8 8 14 2 0 8 10 10 16 4 2 8 12 8 18 0 4 6 10 8 18 0 0 8 10 10 20 4 4 6 12 8 20 2v32H0z" fill="${c}" opacity=".9"/></pattern>`; break;
    case 'marble':
      p = `<pattern id="${id}p" width="60" height="40" patternUnits="userSpaceOnUse"><rect width="60" height="40" fill="${b}"/><path d="M0 10c14-8 22 8 34 0s20-6 26 2M0 28c10-6 20 6 30 0s20-8 30 0" fill="none" stroke="${c}" stroke-width="2.4" opacity=".8"/><path d="M0 19c12 4 18-6 30-2s18 6 30 0" fill="none" stroke="${a}" stroke-width="3" opacity=".7"/></pattern>`; break;
    default:
      p = `<linearGradient id="${id}p"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;
  }
  return `<defs>${p}${shine}${metal}${grip}</defs>`;
}

// ---- weapon parts (viewBox 0 0 200 80). paint = skin, metal = gunmetal, grip = dark polymer --------
// Drawn back-to-front: metal/grip parts first, painted panels on top, then small details.
const PARTS = {
  rifle: [
    ['metal', 'M162 33h30v3.6h-30z'], ['metal', 'M189.5 31h7.5v7.6h-7.5z'], ['metal', 'M179 27.5h4v5.5h-4z'],
    ['metal', 'M122 25.5l36 1.2v2.6l-36 .2z'],
    ['grip', 'M84 41h14c1.5 12 5 20 11 26.5l-12.4 5C89.5 63 85.5 54 84 41z'],
    ['grip', 'M60 41h11.5l-4 19.4c-.4 1.8-1.7 2.8-3.4 2.6l-7.6-.8z'],
    ['metal', 'M3 31.5h4.5v17H3z'],
    ['paint', 'M7.5 33l42.5-4.5 2.5 12-10 4L8 48.6z'],
    ['paint', 'M50 27h70l2.5 2.5V41H52z'],
    ['metal', 'M55 23.5h61l4 3.5H51.5z'],
    ['paint', 'M122.5 29.3l37.5.7 2.5 3v6.4l-2.5 1-37.5.4z'],
  ],
  smg: [
    ['metal', 'M158 34h12v3.6h-12z'], ['metal', 'M167.5 32.2h6v7.2h-6z'],
    ['metal', 'M14 30h34v4H20v10h28v4H14c-2 0-3.2-1.2-3.2-3V33c0-1.8 1.2-3 3.2-3z'],
    ['grip', 'M100 42h11.5c1.4 12 3.6 20 8 28.5l-11 3.5C103.5 64 101 55 100 42z'],
    ['grip', 'M64 42h11.5l-4 19.6c-.4 1.7-1.6 2.6-3.3 2.5l-8-.7z'],
    ['paint', 'M48 28h80l4 3v11H48z'],
    ['metal', 'M58 24h62v4H58z'],
    ['paint', 'M132 30.4l24 .8 2 2.8v6l-2 1-24 .6z'],
  ],
  pistol: [
    ['metal', 'M150 27h7v5.5h-7z'], ['metal', 'M54.5 21h5v7h-5z'],
    ['grip', 'M65 39.5h28.5l-4.4 31c-.4 2.8-2.6 4.6-5.4 4.6H66.5c-3.4 0-5.8-2.8-5.2-6.2z'],
    ['metal', 'M62 34h82v5H104l-4.5 3.5H62z'],
    ['paint', 'M58 21.5h88c2.6 0 4.5 1.9 4.5 4.5v8.5H58z'],
  ],
  sniper: [
    ['metal', 'M108 34l80-.6v3.6l-80 1z'], ['metal', 'M186.5 31.6h9v7.6h-9z'],
    ['grip', 'M52 43h9.5l-4 17.4c-.4 1.6-1.6 2.4-3.2 2.3l-7-.5z'],
    ['metal', 'M73 43h13l1.5 10H74z'],
    ['paint', 'M3 46.5V36l35-6 8 1v13l-10 4H24c-3-5.5-8.5-6-13-2.5L6 50c-1.8 0-3-1.4-3-3.5z'],
    ['paint', 'M46 30h60l2.5 2.5v9.5L46 43z'],
    ['metal', 'M64 25.5h4v4.5h-4zM90 25.5h4v4.5h-4z'],
    ['scope', 'M58 17.2h44v8.2H58z'], ['scope', 'M49 15.4l9 1.8v8.2l-9 1.8z'], ['scope', 'M102 17.2l11-2.4v13l-11-2.4z'], ['metal', 'M77 13h6v4.2h-6z'],
  ],
  knife: [
    ['grip', 'M12 41c0-4.5 3-7 7.5-7l45 2.4v17L19.5 56c-4.4.2-7.5-2.5-7.5-7z'],
    ['metal', 'M63 31h8.5v27H63z'],
    ['paint', 'M71.5 38L150 24.5c18-3 34-2.5 46 1.5-6 6-16 10.5-30 14.5L71.5 51z'],
  ],
};
const DETAILS = {
  rifle: '<path d="M56 31.5h60M56 36.5h60" stroke="rgba(0,0,0,.22)" stroke-width=".8"/><path d="M128 32.5v5M134 32.5v5M140 32.5v5M146 32.5v5M152 32.5v5" stroke="rgba(0,0,0,.4)" stroke-width="1.6" stroke-linecap="round"/><path d="M71.5 41.5c2.5 8.5 9 8.5 12.5 1" fill="none" stroke="#1b1f29" stroke-width="1.7"/><circle cx="114" cy="34" r="1.5" fill="rgba(0,0,0,.45)"/>',
  smg: '<path d="M54 35h70" stroke="rgba(0,0,0,.22)" stroke-width=".8"/><path d="M75.5 42.5c3 8 10 8 13 1" fill="none" stroke="#1b1f29" stroke-width="1.7"/><path d="M137 33v5M142 33v5M147 33v5M152 33v5" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linecap="round"/><circle cx="124" cy="35" r="1.5" fill="rgba(0,0,0,.45)"/>',
  pistol: '<path d="M122 23.5v9M126 23.5v9M130 23.5v9M134 23.5v9M138 23.5v9" stroke="rgba(0,0,0,.38)" stroke-width="1.3"/><path d="M99.5 42.5c3 10 12 10 16 1" fill="none" stroke="#1b1f29" stroke-width="1.9"/><path d="M68 46l20-1.6M67 53l20-1.6M66 60l20-1.6M65.5 67l19.5-1.6" stroke="rgba(255,255,255,.1)" stroke-width="1.6"/><circle cx="92" cy="30" r="1.6" fill="rgba(0,0,0,.45)"/>',
  sniper: '<path d="M52 36h52" stroke="rgba(0,0,0,.22)" stroke-width=".8"/><circle cx="53" cy="21.3" r="3" fill="#33d6ff" opacity=".55"/><path d="M98 40.5c5 2.5 8 6 8.5 10" fill="none" stroke="#8b94a7" stroke-width="1.8"/><circle cx="106.5" cy="51" r="2" fill="#8b94a7"/><path d="M61.5 43.5c3 8 10 8 13 0" fill="none" stroke="#1b1f29" stroke-width="1.7"/><path d="M126 37.5l-9 19M130 37.5l9 19" stroke="#2b303d" stroke-width="2.2" stroke-linecap="round"/>',
  knife: '<path d="M76 41.5l74-12.5c16-2.6 30-2 40 0" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1.1"/><path d="M80 45.5l62-9.5" stroke="rgba(0,0,0,.28)" stroke-width="2.2"/><path d="M22 38.5l40 1.6M21 45h41.5M22 51.5l40-1.6" stroke="rgba(255,255,255,.09)" stroke-width="2.2"/><circle cx="11.5" cy="45" r="6.5" fill="none" stroke="#8b94a7" stroke-width="2.4"/>',
};

function weaponSvg(item) {
  const id = nid();
  const skin = SKINS[item.skin] || DEFAULT_SKIN;
  const parts = PARTS[item.type] || PARTS.rifle;
  const fill = k => (k === 'paint' ? `url(#${id}p)` : k === 'grip' ? `url(#${id}g)` : k === 'scope' ? '#1d2230' : `url(#${id}m)`);
  const body = parts.map(([k, d]) => `<path d="${d}" fill="${fill(k)}" stroke="rgba(0,0,0,.55)" stroke-width=".9" stroke-linejoin="round"/>${k === 'paint' || k === 'scope' ? `<path d="${d}" fill="url(#${id}s)"/>` : ''}`).join('');
  return `<svg class="item-art" viewBox="0 0 200 80" aria-hidden="true">${paintDefs(id, skin)}<g>${body}${DETAILS[item.type] || ''}</g></svg>`;
}

function charmSvg(item) {
  const id = nid();
  const skin = SKINS[item.skin] || DEFAULT_SKIN;
  const [a, b, c] = skin.c;
  return `<svg class="item-art" viewBox="0 0 200 80" aria-hidden="true"><defs>
    <linearGradient id="${id}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset=".5" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></linearGradient></defs>
    <path d="M100 4v10" stroke="#8b94a7" stroke-width="2"/><circle cx="100" cy="4" r="3.5" fill="none" stroke="#8b94a7" stroke-width="2"/>
    <path d="M100 14l22 14-22 46-22-46z" fill="url(#${id}a)" stroke="rgba(0,0,0,.5)" stroke-width="1"/>
    <path d="M78 28h44M100 14l-8 14 8 46 8-46z" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1"/>
    <path d="M100 14l-22 14h14z" fill="#fff" opacity=".45"/></svg>`;
}

export function itemArtSvg(item) {
  if (item.img) return `<img class="item-art" src="${item.img}" alt="" loading="lazy">`;
  return item.type === 'charm' ? charmSvg(item) : weaponSvg(item);
}
