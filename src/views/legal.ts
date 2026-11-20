// Legal and policy pages for the play-money demo: terms, privacy, cookies, refunds, AML, ethics, house rules, disclaimer, about, contact.
// Plain language, original text, and honest about what the demo does and does not do. Company details come from src/company.ts and
// are fictional placeholders. This is not legal advice: have a lawyer review everything before offering any real service.
import { TERMS_VERSION } from '../signup.js';
import { COMPANY, companyLine } from '../company.js';
import { esc } from '../ui.js';

/** A paragraph is a string; an array is a bulleted list. */
type Block = string | string[];
interface Doc { title: string; intro: string; sections: [string, Block[]][]; legal?: boolean }

const C = COMPANY;
const NOT_AFFILIATED = 'Vaultrush is not affiliated with, endorsed by or associated with Valve, Steam, Counter-Strike, Facepunch, Rust or any other game publisher or platform. Weapon, skin and case names in Vaultrush are invented, and all third-party names and trademarks belong to their owners and are used only to describe how sign-in works.';

export const DOCS: Record<string, Doc> = {
  terms: {
    title: 'Terms of Service', legal: true,
    intro: 'These terms govern your use of Vaultrush, a play-money demonstration of a skin-game website. By using it you agree to them.',
    sections: [
      ['1. Who we are and what this is', [
        `Vaultrush is operated by ${companyLine()}. The company and all contact details on this site are fictional placeholders (see the Disclaimer).`,
        'Vaultrush uses virtual coins and invented items. Coins have no cash value. They cannot be bought, sold, transferred to another person or withdrawn, and nothing you win can be exchanged for money, skins or any other real item.',
        'It is a software demonstration. It is not a gambling service and holds no gambling licence.',
      ]],
      ['2. Eligibility', [
        'You must be 18 or older, or the legal age for online entertainment where you live if that is higher. You confirm your age with a tickbox when you register. Our database refuses to create a profile without that confirmation.',
        'Do not use Vaultrush if online gambling-style content is restricted where you live. You are responsible for checking the rules that apply to you.',
        'You may not use Vaultrush if you are self-excluded here or elsewhere, or if you have been told to stay away from gambling content.',
      ]],
      ['3. Your account', [
        'You can browse without an account. To bet, claim rewards, use chat or join live games you need an account: a browser-only account, or a cloud account using an email address and password, Google, or Steam.',
        'Give accurate information, keep your login private and tell us if you think someone else has used your account. You are responsible for what happens under it.',
        'One account per person. Creating several accounts to collect free coins, rewards or race prizes is not allowed.',
      ]],
      ['4. Virtual coins and rewards', [
        'New accounts start with a small balance of coins. Further coins come from free claims, rewards, daily cases, rakeback and the games themselves.',
        'We may change, reset or remove coins, items, levels and rewards at any time, for example to fix a bug or end abuse. They are never property you own.',
      ]],
      ['5. Games, fair play and live play', [
        'Results come from a random seed that is committed before play (its hash is shown) and revealed afterwards, so results can be re-checked on the Fairness page. In a browser-only account the seed lives in your browser, so it demonstrates the method and is not an independent referee.',
        'In live battles and coinflips against other players, the database draws the shared result from a secret seed that nobody can see before the game is full. Your browser takes its own stake and pays itself its winnings. Because coins are play money held in your browser, this is a demonstration and not a secure financial system.',
        'Bots may fill empty seats in a battle. Bots play for the house: if a bot wins, the pot is gone.',
        'Simulated players, chat lines, live bets and drops appear when live play is off. They are demo content and are labelled as such.',
      ]],
      ['6. Responsible play', [
        'You can set limits, take a break or self-exclude under Account > Responsible Play. Tightening a limit applies at once, loosening it waits 24 hours, and a self-exclusion or cool-off cannot be shortened.',
        'If playing stops being fun, stop and talk to someone. Free support is listed on the Responsible play page.',
      ]],
      ['7. Identity checks (sandbox)', [
        'The verification steps in Account > Verification and the payout checks are simulations. They show how such controls work. No identity documents are collected and nothing is sent to a verification provider.',
      ]],
      ['8. What you may not do', [
        ['Use bots, scripts or macros to claim free coins, rain or rewards, or to play for you.',
          'Exploit bugs or try to manipulate or predict results, or interfere with the random number generator.',
          'Collude with other players, or transfer value between your own accounts.',
          'Harass others, post hateful, sexual, illegal or misleading content, share other people\'s personal data, or advertise in chat.',
          'Try to break, overload or gain unauthorised access to the service, or reverse engineer it beyond what the law allows.',
          'Impersonate staff or other players.'],
        'We may warn, mute, reset or close accounts that break these rules, and we may remove chat messages.',
      ]],
      ['9. Chat and other content you post', [
        'You are responsible for what you write. By posting in chat you allow us to display it to other players. Messages are visible to every signed-in player in live chat and are deleted if you delete your account.',
      ]],
      ['10. Intellectual property and third-party names', [
        'The Vaultrush software, design and artwork belong to their authors. You may use the site for personal, non-commercial entertainment.',
        NOT_AFFILIATED,
      ]],
      ['11. No warranty and limits of liability', [
        'Vaultrush is provided "as is" and "as available". It may change, pause or stop at any time and may contain mistakes. We do not promise it will be uninterrupted or error-free.',
        'As coins have no real value, you cannot lose money here. To the extent the law allows, we are not liable for any loss or damage arising from using the demo.',
      ]],
      ['12. Ending your use', [
        'You can stop at any time. Cloud accounts can be deleted under Account > Cloud Account. We may suspend or close accounts that break these terms.',
      ]],
      ['13. Changes to these terms', [
        `We may update these terms and will change the version number and date when we do. The version you accepted is stored with your account. The current version is ${TERMS_VERSION}.`,
      ]],
      ['14. Governing law and contact', [
        `These terms follow ${C.governingLaw}. If something goes wrong, contact us first at ${C.email} and we will try to sort it out informally.`,
      ]],
    ],
  },

  privacy: {
    title: 'Privacy Policy', legal: true,
    intro: 'What the Vaultrush demo stores about you, why, where, who can see it and how you can control it.',
    sections: [
      ['1. Who is responsible', [
        `The controller of personal data on this site is ${companyLine()}. Privacy questions go to ${C.privacyEmail}. These are fictional placeholders for a demo.`,
      ]],
      ['2. Two ways to use Vaultrush', [
        'Browser-only mode (when the site is not connected to a cloud project): your accounts, balance, items, bet history, limits and settings are stored only in your browser (localStorage). A browser account keeps a salted hash of its password. Nothing is sent to a server. Clearing site data erases it, so download a backup first (Account > Security).',
        'Cloud mode (when you sign in with a cloud account): the data in section 3 is stored in a database hosted by Supabase, in a region chosen by the operator.',
      ]],
      ['3. What we collect', [
        ['Sign-in details: your email address (or the Google or Steam ID you sign in with) and a hashed password handled by the authentication service.',
          'Profile: your username (with Steam sign-in, your Steam profile name), a profile picture address from Steam or Google, the time you confirmed you are an adult, and the terms version you accepted.',
          'Server records: the wallet and bets of the server-side Crash game, the ledger, your fairness seeds, and your limits, cool-off and self-exclusion settings.',
          'Chat and live play: chat messages, the battles and coinflips you take part in (with the name you had at the time), and whether you are online.',
          'In your browser (not on our server): your coins, items, level, history and settings for the other games, stored per account.'],
        'We do not collect a date of birth at sign-up. If you start the optional sandbox verification, the date you enter is kept with your progress in your browser and is not shown to others. We do not collect identity documents, payment details or precise location.',
      ]],
      ['4. Technical data', [
        'Like any website, the hosting provider (Vercel) and the database provider (Supabase) process request data such as your IP address, browser type and time of request, to deliver the service and keep it secure. We do not use advertising or analytics tools.',
        'If a country is switched off for the service, the database compares the country your connection appears to come from (a header added by the network provider) with that list at the moment you make a request, so it can refuse the request. We do not save that country or your IP address ourselves.',
      ]],
      ['5. How we use it', [
        ['To run your account, show your balance and history, and let you play, chat and join live games.',
          'To keep the service fair and safe: stop abuse, multiple accounts and bots, and enforce the rules.',
          'To apply the limits and exclusions you set.',
          'To answer your questions and requests.'],
        'We do not sell personal data and do not use it for advertising or profiling.',
      ]],
      ['6. Legal basis (for people in the EEA and UK)', [
        'We use your data to provide the service you asked for (contract), to keep it secure and fair (legitimate interests), to follow the law (legal obligation) and, where we ask, with your consent. In this demo these grounds are listed for illustration.',
      ]],
      ['7. Who can see your data', [
        ['Other players see your username, profile picture, chat messages, your name in live battles and coinflips, and your bets and drops in the shared feed. Turn on Anonymous mode (Account > Options) to hide your name in the feed; it cannot hide it in live chat.',
          'Service providers act for us: hosting (Vercel), database and authentication (Supabase), sign-in (Google, Steam) and fonts (Google Fonts). Each applies its own policy.',
          'We may share data if the law requires it or to protect people from harm.']
      ]],
      ['8. How long we keep it', [
        'Browser data stays until you clear it. Cloud data stays until you delete your account; this demo has no automatic expiry. When you delete your account, your profile is anonymised, your chat messages are removed, your name in live games is replaced, the login is closed and your balance is zeroed. Bets and ledger entries are kept without your name as financial records.',
      ]],
      ['9. Your rights', [
        'You can ask to see, correct, export or delete your data, to restrict or object to its use, and to withdraw consent. Account > Cloud Account lets you download a copy and delete your account yourself. For anything else, write to us and we will answer within one month.',
        'If you are unhappy with our answer you can complain to your local data protection authority.',
      ]],
      ['10. Security', [
        'Passwords are stored only as hashes. Database access is limited by row-level security so that you can read only your own records and the browser cannot write money. No system is perfectly secure, so use a strong, unique password and turn on two-factor authentication.',
      ]],
      ['11. Children', [
        'Vaultrush is for adults only. We do not knowingly collect data from anyone under 18. If you believe a child has an account, tell us and we will remove it.',
      ]],
      ['12. International transfers', [
        'Providers may process data outside your country. Where the law requires it, they rely on safeguards such as standard contractual clauses.',
      ]],
      ['13. Changes and contact', [
        `We will update this page and its date when practices change. Questions: ${C.privacyEmail}. Version ${TERMS_VERSION}.`,
      ]],
    ],
  },

  cookies: {
    title: 'Cookie and Storage Policy', legal: true,
    intro: 'Vaultrush does not use tracking or advertising cookies. This page lists exactly what it keeps in your browser.',
    sections: [
      ['1. Cookies and similar storage', [
        'A cookie is a small text file a website sets in your browser. Websites can also keep data in your browser\'s local storage. Vaultrush uses local storage, not its own cookies.',
      ]],
      ['2. What we store', [
        ['Your game state: balance, items, level, history, settings and limits (keys that start with "vaultrush.").',
          'Browser accounts: the account list with salted password hashes, and which account is active.',
          'Cloud sign-in: the session token that keeps you signed in (stored by the authentication library).',
          'Small conveniences: whether this browser has had an account (so first-time visitors land on Register), and one-time messages shown after a reload.'],
        'These are strictly necessary for the site to work, so they do not need a consent banner.',
      ]],
      ['3. What we do not use', [
        'No advertising cookies, no analytics or tracking scripts, no social media pixels and no fingerprinting.',
      ]],
      ['4. Third parties', [
        'Fonts load from Google Fonts. When you choose to sign in with Google or Steam, those services set their own cookies on their own pages under their own policies. Our hosting and database providers may set technical cookies or headers needed to deliver the site.',
      ]],
      ['5. Controlling it', [
        'You can clear Vaultrush data in your browser settings (site data). That signs you out and erases browser-only accounts, so download a backup first from Account > Security. Blocking local storage entirely stops the site from remembering you.',
      ]],
      ['6. Do Not Track', [
        'We do not track you across sites, so there is nothing to switch off. We respect your choice either way.',
      ]],
      ['7. Changes', [`We will update this page if what we store changes. Last updated ${C.updated}.`]],
    ],
  },

  refunds: {
    title: 'Refund Policy', legal: true,
    intro: 'Nothing on Vaultrush costs money, so there is nothing to refund.',
    sections: [
      ['1. No purchases', [
        'Coins cannot be bought. Vaultrush takes no payments, stores no card or bank details and sells nothing. There are no deposits, subscriptions or paid features.',
      ]],
      ['2. No withdrawals', [
        'Coins and items cannot be cashed out, sent to another person or converted into money, skins or crypto-assets. The payout simulator in the sandbox compliance tools does not move anything.',
      ]],
      ['3. Lost or reset coins', [
        'Coins and items are play money and can be reset if we fix a bug or end abuse. Stakes taken for a live battle or coinflip that is cancelled or never starts are returned automatically, once, to the browser that placed them.',
      ]],
      ['4. If someone asks you to pay', [
        'If anyone offers to sell you Vaultrush coins or items, or asks for money in the name of Vaultrush, it is a scam. Do not pay and tell us at ' + C.email + '.',
      ]],
    ],
  },

  aml: {
    title: 'AML and Compliance Policy (sandbox)', legal: true,
    intro: 'How anti-money-laundering and know-your-customer controls work in this demo. They are simulations, because no real money is involved.',
    sections: [
      ['1. Why this page exists', [
        'Real gambling operators must prevent money laundering. Vaultrush is a demonstration of how such controls look and behave. It has no real funds, so there is nothing to launder, and it is not a regulated business.',
      ]],
      ['2. Verification levels (simulated)', [
        ['Level 0: new account. Bets are capped at 1,000 coins and payouts cannot be requested.',
          'Level 1: confirm your email and enter your date of birth (adults only). Bets are capped at 2,500 coins.',
          'Level 2: a simulated document step plus mock sanctions and politically-exposed-person screening. Bets are capped at 5,000 coins.'],
        'No documents or photos are collected or uploaded. A match against the mock screening list places the account on a simulated compliance hold.',
      ]],
      ['3. Transaction monitoring (simulated)', [
        'The payout simulator runs rules that mirror what real monitoring looks for, and explains each finding: payouts need an adequate level, a compliance hold freezes payouts, bonus coins must be wagered first, too many requests in 24 hours (velocity), repeated amounts just under a threshold (structuring), statistically improbable winnings, and large cumulative payouts that would need a source-of-funds declaration.',
        'Because coins cannot be withdrawn, the simulator evaluates a request and changes nothing.',
      ]],
      ['4. Our commitments', [
        ['No real-money flows will be added to Vaultrush under this policy.',
          'Anything simulated is labelled as simulated.',
          'If Vaultrush ever handled real value, it would first need a licence, a named compliance officer, real verification providers, staff training and audits.'],
      ]],
      ['5. Reporting a concern', [`If you think someone is misusing Vaultrush, write to ${C.complianceEmail}. In this demo that address is a placeholder.`]],
    ],
  },

  ethics: {
    title: 'Code of Ethics', legal: true,
    intro: 'The principles we try to keep and ask players to keep too.',
    sections: [
      ['Honesty first', ['We say what is simulated, what is real and what is only a demonstration. We do not imply a licence, endorsement or certification we do not have.']],
      ['Fair play', ['Results are drawn from committed random seeds and can be re-checked. Cheating, exploiting bugs, collusion or manipulating results is not allowed.']],
      ['Responsible play', ['We build in limits, breaks, reality checks and self-exclusion, we make loosening a limit slow and tightening it instant, and we link to free support. We do not use pressure tactics.']],
      ['Respect for everyone', ['Be kind in chat. Harassment, hate and discrimination are not tolerated.']],
      ['Privacy', ['We collect as little as possible, sell nothing and use no advertising or tracking. Respect other people\'s privacy: do not share or ask for personal information.']],
      ['No real-money pressure', ['Coins are free and cannot be bought. Nobody should ask you for money for coins, and we never will.']],
      ['Following the law', ['You are responsible for using Vaultrush lawfully where you live. We follow the rules that apply to a play-money demo and will remove content that breaks the law.']],
      ['Speaking up', [`If you see conduct that breaks this code, tell us at ${C.email}. We read reports and act on them.`]],
    ],
  },

  rules: {
    title: 'House Rules', legal: true,
    intro: 'Practical rules for chat, free coins and live games, in plain language.',
    sections: [
      ['Accounts and free coins', [
        ['One account per person.', 'No bots, scripts or macros to claim free coins, rain or rewards.', 'Do not trade, sell or give away accounts, coins or items. They have no value and are not yours to sell.']]],
      ['Chat', [
        ['Be respectful. No harassment, hate, spam, advertising or begging.', 'Do not share personal information, yours or anyone else\'s.', 'Do not impersonate staff. We will never ask for your password.', 'Click a name to ignore a player; manage the list under Account > Options.']]],
      ['Live battles and coinflip', [
        ['A stake is taken when you create or join a game and is returned if the game is cancelled before it starts.', 'The creator leaving a waiting battle cancels it for everyone and each player is refunded.', 'Once a battle is full it starts and cannot be left. The result comes from a seed the database kept secret until then.', 'A game that sits unjoined for 30 minutes expires.', 'Do not create games only to chase other players away, and do not collude with an opponent.']]],
      ['Bots', [
        'Bots fill empty seats if the creator calls them. They play for the house: if a bot wins, the pot is gone.',
      ]],
      ['Breaking the rules', [
        'We may warn, mute, reset or close an account, and remove content. If you think we got it wrong, write to us and we will look again.',
      ]],
    ],
  },

  disclaimer: {
    title: 'Disclaimer', legal: true,
    intro: 'What Vaultrush is, what it is not, and what is made up.',
    sections: [
      ['Play money only', ['Everything on Vaultrush uses virtual coins with no cash value. No real money, skins or crypto-assets can be deposited, won or withdrawn.']],
      ['Not a gambling service', ['Vaultrush is a software demonstration. It holds no gambling licence and is not regulated by any gambling authority. Nothing here is an offer to gamble.']],
      ['Not affiliated', [NOT_AFFILIATED]],
      ['Fictional company', [`The company name, registration number, address, e-mail addresses and phone number on this site (${C.name}, ${C.regNo}) are fictional placeholders for a demonstration. The e-mail addresses use the reserved ".example" domain and cannot receive mail.`]],
      ['Simulated content', ['Simulated players, chat lines, live bets and drops, the sandbox identity checks and the sandbox AML tools are demonstrations. They are labelled as such where they appear.']],
      ['Fairness', ['The fairness tools show how results can be committed and verified. In a browser-only account the seed lives in your browser, so it is a demonstration of the method and not an independent audit. The RNG lab is not a certification from an accredited test laboratory.']],
      ['No advice', ['Nothing on this site is financial, legal or gambling advice. These policies are plain-language demonstration text, not legal advice.']],
    ],
  },

  about: {
    title: 'About Vaultrush',
    intro: 'A play-money demo of a modern skin-game site, built to show how the parts fit together responsibly.',
    sections: [
      ['What it is', ['Vaultrush is an original demonstration of cases, case battles, crash, double, plinko, mines, coinflip and upgrading, with levels, rewards and a daily race. It uses invented items and free coins.']],
      ['What makes it different', [
        ['Honest about being play money: coins cannot be bought or withdrawn.', 'Provably fair results you can re-check, and an RNG lab that tests the random source.', 'Responsible-play tools built in: limits, breaks, reality checks and self-exclusion.', 'Sandbox identity and AML controls that show how a regulated site behaves.', 'Real shared lobbies: battles, coinflip and chat between signed-in players.']]],
      ['Who runs it', [`${companyLine()}. This is a fictional company used so the demo looks like a real site; see the Disclaimer.`]],
      ['Open questions and feedback', [`Tell us what is confusing or broken at ${C.email}. Nobody monitors that placeholder address in this demo, but it is where a real operator would listen.`]],
    ],
  },

  contact: {
    title: 'Contact',
    intro: 'Where a real operator would be reachable. In this demo these are placeholders.',
    sections: [
      ['General and support', [`${C.email} (placeholder).`]],
      ['Privacy and data requests', [`${C.privacyEmail}. Signed-in players can download or delete their data themselves under Account > Cloud Account.`]],
      ['Compliance concerns', [`${C.complianceEmail}.`]],
      ['Postal address', [C.address.join(', ') + ` (${C.name}, fictional).`]],
      ['Phone', [`${C.phone} (placeholder, not in service).`]],
      ['Need help with gambling?', ['If gambling, even in a game, is causing you worry, free and confidential help is available. See the Responsible play page, or contact BeGambleAware (begambleaware.org).']],
    ],
  },
};

/** Pages shown in the side index, in order. */
export const LEGAL_ORDER = ['terms', 'privacy', 'cookies', 'refunds', 'aml', 'rules', 'ethics', 'disclaimer', 'about', 'contact'] as const;

const block = (b: Block): string => (Array.isArray(b) ? `<ul>${b.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(b)}</p>`);

export function render(el: HTMLElement, kind: string = 'terms'): void {
  const d = DOCS[kind] ?? DOCS['terms']!;
  const slug = DOCS[kind] ? kind : 'terms';
  el.innerHTML = `<div class="page-head"><h1>${esc(d.title)}</h1><p class="muted">${esc(d.intro)}</p>
      ${d.legal ? `<p class="muted small">Version ${TERMS_VERSION} · last updated ${esc(C.updated)} · ${esc(C.name)} (fictional)</p>` : ''}</div>
    <div class="legal-wrap">
      <nav class="legal-nav panel" aria-label="Legal and information pages">${LEGAL_ORDER.map(k => `<a href="#/${k}" ${k === slug ? 'aria-current="page" class="on"' : ''}>${esc(DOCS[k]!.title.replace(/ \(sandbox\)/, ''))}</a>`).join('')}<a href="#/responsible">Responsible play</a><a href="#/fair">Provably fair</a></nav>
      <div class="panel legal">${d.sections.map(([h, bs]) => `<h2>${esc(h)}</h2>${bs.map(block).join('')}`).join('')}
        <p class="muted small">${C.demo ? 'The company details above are fictional placeholders. ' : ''}This is a plain-language demonstration text, not legal advice. Have a lawyer review it before offering any real service.</p></div>
    </div>`;
}
export const renderDoc = (el: HTMLElement, kind?: string): void => render(el, kind);
export const renderTerms = (el: HTMLElement): void => render(el, 'terms');
export const renderPrivacy = (el: HTMLElement): void => render(el, 'privacy');
