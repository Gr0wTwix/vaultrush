// The site footer: who operates the site, the non-affiliation notice, the 18+ / play-responsibly strip and the link columns.
// Structure follows what operators of comparable sites show (operator and registration details, disclaimers, games, information,
// responsible-play links); the wording is original and the company details are fictional placeholders from company.ts.
import { COMPANY } from './company.js';
import { esc } from './ui.js';

export const FOOTER_COLUMNS: { title: string; links: [string, string][] }[] = [
  { title: 'Games', links: [['#/cases', 'Cases'], ['#/battles', 'Case battles'], ['#/crash', 'Crash'], ['#/double', 'Double'], ['#/plinko', 'Plinko'], ['#/mines', 'Mines'], ['#/coinflip', 'Coinflip'], ['#/upgrade', 'Upgrader']] },
  { title: 'Information', links: [['#/fair', 'Provably fair'], ['#/rng', 'RNG lab'], ['#/about', 'About us'], ['#/contact', 'Contact us'], ['#/rules', 'House rules'], ['#/ethics', 'Code of ethics'], ['#/disclaimer', 'Disclaimer']] },
  { title: 'Legal', links: [['#/terms', 'Terms of Service'], ['#/privacy', 'Privacy Policy'], ['#/cookies', 'Cookie policy'], ['#/refunds', 'Refund policy'], ['#/aml', 'AML policy']] },
  { title: 'Play responsibly', links: [['#/responsible', 'Responsible play'], ['#/responsible', 'Limits and self-exclusion'], ['https://www.begambleaware.org', 'Get help (BeGambleAware)']] },
];

export function footerHtml(): string {
  const c = COMPANY;
  const link = ([href, label]: [string, string]): string => (/^https?:/.test(href)
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    : `<a href="${esc(href)}">${esc(label)}</a>`);
  return `
    <div class="ft-main">
      <div class="ft-about">
        <a class="ft-logo" href="#/" aria-label="Vaultrush home">VAULT<b>RUSH</b></a>
        <p><b>Vaultrush</b> is a play-money demonstration operated by ${esc(c.name)}, ${esc(c.description)} (registration no. ${esc(c.regNo)}), registered address: ${esc(c.address.join(', '))}. All company details on this site are fictional placeholders.</p>
        <p>Vaultrush is not affiliated with, endorsed by or associated with Valve, Steam, Counter-Strike, Facepunch, Rust or any other game publisher or platform. Counter-Strike item names, pictures and prices are shown only to describe the play-money items (names and pictures come from the open CS2 data set and Valve's community image servers, prices from public Skinport listings); they belong to their owners and are not for sale here. All third-party names and brands belong to their owners.</p>
        <p>Coins have no cash value. They cannot be bought, sold or withdrawn, and nothing is won that has real value.</p>
      </div>
      ${FOOTER_COLUMNS.map(col => `<nav class="ft-col" aria-label="${esc(col.title)}"><h2>${esc(col.title)}</h2>${col.links.map(link).join('')}</nav>`).join('')}
    </div>
    <div class="ft-strip">
      <span class="ft-badge ft-18">18+</span>
      <span class="ft-note">By using this site you confirm you are over 18. Have a gaming problem? <a href="#/responsible">Reach out for help</a>. No purchase is possible or necessary: Vaultrush is free to play.</span>
      <span class="ft-chips"><span>Play money</span><span>Provably fair</span><span>Demo</span></span>
    </div>
    <div class="ft-bottom"><button type="button" class="link" id="ftTips">Show the site tips</button><span>© ${new Date().getFullYear() > c.since ? `${c.since}–${new Date().getFullYear()}` : c.since} ${esc(c.name)} (fictional). All rights reserved.</span><span>Contact: ${esc(c.email)} (placeholder)</span></div>`;
}

export function renderFooter(): void {
  const el = document.getElementById('footer');
  if (el) el.innerHTML = footerHtml();
}
