// Terms of Service and Privacy Policy for the play-money demo. Plain language, and honest about what the demo does and does not do.
import { TERMS_VERSION } from '../signup.js';
import { esc } from '../ui.js';

type Doc = { title: string; intro: string; sections: [string, string[]][] };

const TERMS: Doc = {
  title: 'Terms of Service',
  intro: 'Vaultrush is a play-money demonstration of a skin-game website. By using it you agree to these terms.',
  sections: [
    ['What this is', ['Vaultrush uses virtual coins and invented items. Coins have no cash value, cannot be bought, sold, transferred or withdrawn, and nothing you win can be exchanged for money, skins or any other real item.', 'It is a software demonstration. It is not a gambling service and holds no gambling licence.']],
    ['Who can use it', ['You must be 18 or older. You confirm this with a tickbox when you register, and the database refuses to create a profile without it. Bets above the unverified limit need the age and identity checks in Account > Verification.', 'Do not use it if online gambling content is restricted where you live.']],
    ['Your account', ['Keep your login details private. You are responsible for what happens under your account.', 'One account per person. We may close accounts used to abuse the service.']],
    ['Fair play', ['Results come from a committed random seed and can be re-checked on the Fairness page. In local mode the seed lives in your browser, so it demonstrates the method and is not a trusted third party.', 'Do not use bots or scripts to claim rewards, rain or free coins, and do not exploit bugs. Rewards and coins may be reset at any time.']],
    ['Responsible play', ['Limits, breaks and self-exclusion are in Account > Responsible Play. A self-exclusion cannot be lifted early. If gambling stops being fun, stop and seek free support (see the Responsible play page).']],
    ['No guarantees', ['The service is provided as is, may change or stop at any time, and may contain mistakes. Simulated players, chat, live bets and drops are demo content and are labelled as such.']],
    ['Changes', [`We may update these terms. The version you accepted is recorded (current version ${TERMS_VERSION}).`]],
  ],
};
const PRIVACY: Doc = {
  title: 'Privacy Policy',
  intro: 'This explains what the demo stores about you and where.',
  sections: [
    ['Local mode (default)', ['Your accounts, profile, balance, bet history, limits and settings are stored in your browser (localStorage). A local account keeps only a salted hash of its password. Nothing is sent to a server. Clearing site data erases them; use Account > Security to download a backup first.']],
    ['Cloud accounts (optional)', ['If the site is connected to a Supabase project and you sign in, we store your email (or the Google or Steam ID you sign in with), username, the date you confirmed you are an adult and accepted the terms, your wallet, bets, ledger, seeds, limits and chat messages. Passwords are stored only as hashes by the authentication service.', 'Other players can see your username, your chat messages and your daily wagered total. A date of birth is only collected if you start verification, and is never shown to other players.']],
    ['Verification (sandbox)', ['The identity checks in this demo are simulated. No documents or photos are collected or uploaded.']],
    ['Your rights', ['In Account > Cloud Account you can download a copy of your data and delete your account. Deleting anonymises your profile, removes your chat messages, closes the login and zeroes your balance. Bets and ledger entries are kept without your name as financial records.']],
    ['Third parties', ['Sign-in providers (Google and Steam) tell us your ID and, depending on the provider, your email. Fonts are loaded from Google Fonts. There is no advertising and no analytics.']],
    ['Cookies and storage', ['Only what the site needs to work: your session and your settings. There are no tracking cookies.']],
  ],
};

export function render(el: HTMLElement, kind: 'terms' | 'privacy' = 'terms'): void {
  const d = kind === 'terms' ? TERMS : PRIVACY;
  el.innerHTML = `<div class="page-head"><h1>${esc(d.title)}</h1><p class="muted">${esc(d.intro)} <span class="muted small">Version ${TERMS_VERSION}.</span></p></div>
    <div class="panel legal">${d.sections.map(([h, ps]) => `<h2>${esc(h)}</h2>${ps.map(p => `<p>${esc(p)}</p>`).join('')}`).join('')}
    <p class="muted small">This is a plain-language demo policy, not legal advice. Have a lawyer review it before offering any real service.</p></div>
    <p><a href="#/${kind === 'terms' ? 'privacy' : 'terms'}">${kind === 'terms' ? 'Privacy Policy' : 'Terms of Service'}</a> · <a href="#/responsible">Responsible play</a></p>`;
}
export const renderTerms = (el: HTMLElement): void => render(el, 'terms');
export const renderPrivacy = (el: HTMLElement): void => render(el, 'privacy');
