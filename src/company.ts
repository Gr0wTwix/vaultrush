// The "who runs this" details shown in the footer and on every legal page. EVERYTHING HERE IS A FICTIONAL PLACEHOLDER:
// Vaultrush is a play-money demo and no real company, licence or contact point stands behind it. The addresses use the
// reserved ".example" domain, which can never receive mail. If this ever becomes a real service, replace these values with the
// real operator's details (and have a lawyer review the policies). The repository is public, so do not put private personal
// data in this file.
export const COMPANY = {
  demo: true,
  name: 'Vaultrush Demo Ltd',
  description: 'a fictional private limited company',
  regNo: 'DEMO000000',
  address: ['1 Demo Street, Office 0', '00000 Example City', 'Demoland'],
  email: 'support@vaultrush.example',
  privacyEmail: 'privacy@vaultrush.example',
  complianceEmail: 'compliance@vaultrush.example',
  phone: '+00 000 000 0000',
  governingLaw: 'the laws of Demoland (a placeholder)',
  since: 2026,
  updated: '2026-11-21',
} as const;

export const companyLine = (): string => `${COMPANY.name}, ${COMPANY.description}, registration number ${COMPANY.regNo}, registered address ${COMPANY.address.join(', ')}`;
