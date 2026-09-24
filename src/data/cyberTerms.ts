import type { CyberTerm } from '../types/cyberTerm'

/**
 * The prototype cyber term bank — 30 data-driven terms across six categories.
 * This is the single source of cyber content for the prototype. Each term's
 * word, definition, and awareness tip are shown together the moment the host
 * officially calls it — there is no hidden-answer phase (Module 5). Content
 * is kept short so it reads comfortably on a phone, the host dashboard, and a
 * projector. In a later module this content moves to a backend-provided
 * catalogue.
 */
export const cyberTerms: CyberTerm[] = [
  // --- Email Security ---
  {
    id: 'TERM_001',
    term: 'Phishing',
    category: 'Email Security',
    definition:
      'A fraudulent attempt to obtain sensitive information by pretending to be a trusted person or organization.',
    awarenessTip:
      'Verify unexpected links and credential requests before acting.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_002',
    term: 'Spear Phishing',
    category: 'Email Security',
    definition:
      'A targeted phishing scam crafted using your name, role, or team to look convincing.',
    awarenessTip:
      'Treat personalised, urgent requests with extra caution — even if they seem to know you.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_003',
    term: 'Suspicious Attachment',
    category: 'Email Security',
    definition:
      'An unexpected file in an email that may run harmful code when opened.',
    awarenessTip:
      'Do not open attachments you were not expecting; confirm with the sender first.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_004',
    term: 'Malicious Link',
    category: 'Email Security',
    definition:
      'A web address that looks normal but sends you to a fake or harmful site.',
    awarenessTip:
      'Hover to preview a link and check the real destination before clicking.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_005',
    term: 'Impersonation',
    category: 'Email Security',
    definition:
      'When someone pretends to be your boss or a colleague to pressure you into acting.',
    awarenessTip:
      'Verify unusual requests through a second, known channel before responding.',
    difficulty: 'medium',
    active: true,
  },

  // --- Identity & Access ---
  {
    id: 'TERM_006',
    term: 'MFA',
    category: 'Identity & Access',
    definition:
      'Multi-factor authentication: a second step, like a code or approval, that protects your account even if your password is stolen.',
    awarenessTip:
      'Enable multi-factor authentication on every account that offers it.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_007',
    term: 'Strong Passphrase',
    category: 'Identity & Access',
    definition:
      'A long, memorable phrase that is far harder to guess than a short password.',
    awarenessTip:
      'Prefer long passphrases and never reuse them across accounts.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_008',
    term: 'Password Manager',
    category: 'Identity & Access',
    definition:
      'A secure vault that creates and stores unique passwords so you do not have to remember them.',
    awarenessTip:
      'Use an approved password manager to keep every login strong and unique.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_009',
    term: 'OTP',
    category: 'Identity & Access',
    definition:
      'A one-time passcode: a short single-use code that expires quickly and confirms it is really you.',
    awarenessTip:
      'Never share a one-time passcode with anyone, including "support".',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_010',
    term: 'Least Privilege',
    category: 'Identity & Access',
    definition:
      'Giving people only the access they need to do their job, and nothing more.',
    awarenessTip:
      'Request only the access you need and review permissions regularly.',
    difficulty: 'hard',
    active: true,
  },

  // --- Threats ---
  {
    id: 'TERM_011',
    term: 'Ransomware',
    category: 'Threats',
    definition:
      'Malicious software that locks your files and demands payment to unlock them.',
    awarenessTip:
      'Keep offline backups and never pay without contacting IT security.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_012',
    term: 'Malware',
    category: 'Threats',
    definition:
      'Any software designed to damage, disrupt, or gain unauthorized access to a system.',
    awarenessTip: 'Only install software from trusted, approved sources.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_013',
    term: 'Credential Theft',
    category: 'Threats',
    definition:
      'When an attacker steals your username and password to log in as you.',
    awarenessTip:
      'Use MFA and report any account you suspect has been compromised.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_014',
    term: 'QR Scam',
    category: 'Threats',
    definition:
      'A tampered square code that sends you to a fake site when scanned.',
    awarenessTip:
      'Check the destination URL before acting on a scanned code.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_015',
    term: 'Social Engineering',
    category: 'Threats',
    definition:
      'Manipulating people into breaking security rules or giving up information.',
    awarenessTip:
      'Be skeptical of urgent or unusual requests, even from familiar names.',
    difficulty: 'hard',
    active: true,
  },

  // --- Device / Physical Security ---
  {
    id: 'TERM_016',
    term: 'Unknown USB',
    category: 'Device / Physical Security',
    definition:
      'A found or gifted USB drive that may carry malware onto your machine.',
    awarenessTip:
      'Never plug in a USB device you did not obtain from a trusted source.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_017',
    term: 'Screen Lock',
    category: 'Device / Physical Security',
    definition:
      'Securing your device the moment you step away so no one can use it.',
    awarenessTip: 'Lock your screen every time you leave your desk.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_018',
    term: 'Patch Update',
    category: 'Device / Physical Security',
    definition:
      'A fix that closes known security holes in your software and devices.',
    awarenessTip:
      'Install updates promptly to stay protected against known flaws.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_019',
    term: 'Tailgating',
    category: 'Device / Physical Security',
    definition:
      'Following an authorized person through a secure door without badging in.',
    awarenessTip:
      'Do not hold secure doors open for people you cannot verify.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_020',
    term: 'Shoulder Surfing',
    category: 'Device / Physical Security',
    definition:
      'Someone secretly watching your screen or keyboard to steal information.',
    awarenessTip:
      'Shield your screen and keypad when entering sensitive details in public.',
    difficulty: 'easy',
    active: true,
  },

  // --- Data Protection ---
  {
    id: 'TERM_021',
    term: 'Data Leakage',
    category: 'Data Protection',
    definition:
      'Sensitive information leaving the organization through an unintended channel.',
    awarenessTip:
      'Share confidential data only through approved, secure channels.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_022',
    term: 'Encryption',
    category: 'Data Protection',
    definition:
      'Scrambling data so only someone with the right key can read it.',
    awarenessTip:
      'Use encryption for sensitive files and connections wherever possible.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_023',
    term: 'Backup',
    category: 'Data Protection',
    definition:
      'A saved copy of your data you can restore if the original is lost or encrypted.',
    awarenessTip:
      'Keep regular backups and test that they can be restored.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_024',
    term: 'Data Classification',
    category: 'Data Protection',
    definition:
      'Labelling information by how sensitive it is so it can be handled correctly.',
    awarenessTip:
      'Know the classification of your data and handle it per policy.',
    difficulty: 'hard',
    active: true,
  },
  {
    id: 'TERM_025',
    term: 'Secure Sharing',
    category: 'Data Protection',
    definition:
      'Sending files through approved tools with the right access controls.',
    awarenessTip:
      'Share via approved platforms and limit access to those who need it.',
    difficulty: 'medium',
    active: true,
  },

  // --- Network Security ---
  {
    id: 'TERM_026',
    term: 'VPN',
    category: 'Network Security',
    definition:
      'An encrypted tunnel that protects your traffic on untrusted networks.',
    awarenessTip: 'Use the company VPN when working outside the office.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_027',
    term: 'Public Wi-Fi',
    category: 'Network Security',
    definition:
      'An open network in cafes or airports where others may intercept your traffic.',
    awarenessTip:
      'Avoid sensitive work on open networks; use a VPN if you must connect.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_028',
    term: 'Firewall',
    category: 'Network Security',
    definition:
      'A barrier that filters network traffic to block unwanted connections.',
    awarenessTip:
      'Keep firewalls enabled on your devices and the corporate network.',
    difficulty: 'medium',
    active: true,
  },
  {
    id: 'TERM_029',
    term: 'Secure Website',
    category: 'Network Security',
    definition:
      'A site using HTTPS so the connection between you and it is encrypted.',
    awarenessTip:
      'Look for HTTPS before entering credentials or personal details.',
    difficulty: 'easy',
    active: true,
  },
  {
    id: 'TERM_030',
    term: 'Rogue Wi-Fi',
    category: 'Network Security',
    definition:
      'A fake hotspot set up to look real so it can capture your data.',
    awarenessTip:
      'Connect only to known networks and confirm the exact name before joining.',
    difficulty: 'hard',
    active: true,
  },
]

/** Look up a term by id. Returns undefined if not present. */
export function findCyberTerm(termId: string): CyberTerm | undefined {
  return cyberTerms.find((t) => t.id === termId)
}
