/**
 * The words the dashboard uses for identity, keys, recovery, devices, pen
 * names and moving (#404). One source of truth: every screen, the glossary
 * page (/glossary) and the inline "What does this mean?" explanations read
 * from here, so the same thing is always called the same name.
 *
 * Accuracy is checked against docs/adr/ADR-003-custody-modes.md and
 * docs/HARDENING.md. When the behaviour changes, change the words here.
 *
 * Rules for the text: plain words in the main text; a technical term only in
 * `technical`, next to its plain explanation. Every choice that changes who
 * controls the identity says what it means, what the person is responsible
 * for, what can go wrong, and how to undo it (or that they can't).
 */

export type CustodyMode = 'custodial' | 'assisted' | 'self';
export type RecoveryOption = 'none' | 'phrase' | 'contacts' | 'newsroom';

/** The four answers every risky choice gives before the person commits. */
export interface ChoiceText {
  /** The name, as on every screen. */
  title: string;
  /** One sentence, for lists and radio buttons. */
  summary: string;
  means: string;
  responsible: string;
  wrong: string;
  undo: string;
}

/** The name of the identity phrase everywhere. */
export const WORDS = 'your 12 words';

export const CUSTODY: Record<CustodyMode, ChoiceText & { short: string; restore: string }> = {
  custodial: {
    title: 'Custodial',
    short: 'This server holds your keys',
    summary: 'This server holds the keys that control your identity. Easiest: nothing to write down, and the server can get you back in.',
    means: 'This server holds the keys that control your identity. You sign in with your password and have nothing to write down.',
    responsible: 'Your password, and keeping your email address working so you can reset it.',
    wrong: 'Whoever runs this server, or anyone who breaks into it, could act as you: change your identity, move it to another server or post in your name. To move to another server you need this server\'s help.',
    undo: 'You can switch to Assisted or Self later, if this server offers them. You will need your password and will write down 12 new words.',
    restore: 'If you lose your password, reset it by email. If you also lose your email, the people who run this server can get you back in after checking who you are.',
  },
  assisted: {
    title: 'Assisted',
    short: 'You hold your keys; this server keeps a backup',
    summary: 'You hold 12 words that control your identity. This server keeps a backup it can only use in the open: you are emailed and can cancel within 72 hours.',
    means: 'You hold 12 words that control your identity. This server keeps a backup key that ranks below your words. If the server ever uses it, you get an email, and for 72 hours your 12 words can cancel what it did.',
    responsible: 'Keeping your 12 words on paper, somewhere safe and private. Keeping your email working, because that is how you hear when the server uses its backup. Acting within 72 hours if it used it and you did not ask for that.',
    wrong: 'If you lose your 12 words, the server can give you new ones after its operator checks who you are. If someone steals your 12 words, they control your identity and can cancel anything the server does; the server cannot help then. If you miss the email, the 72 hours pass and the server\'s change stays.',
    undo: 'With your 12 words and your password you can switch to Self or Custodial at any time.',
    restore: 'If you lose your 12 words, ask this server\'s operator to check who you are; then you can choose new words. Your old words can still cancel that for 72 hours.',
  },
  self: {
    title: 'Self',
    short: 'Only you hold your keys',
    summary: 'Only you hold the keys that control your identity, in 12 words. Nobody, including this server, can get you back in if you lose them and have no recovery set up.',
    means: 'Only you hold the keys that control your identity, in your 12 words. This server holds none of them, so it cannot change or move your identity, and neither can anyone who takes the server over.',
    responsible: 'Keeping your 12 words safe and private. Setting up recovery if you want a way back in case you lose them.',
    wrong: 'If you lose your 12 words and have no recovery set up, nobody can give you back control of your identity, including this server. You could still sign in with your password and post, but you could never again move to another server, change this choice or set up recovery. If someone steals your 12 words, they control your identity.',
    undo: 'While you still have your 12 words, you can switch to Assisted or Custodial (if this server offers them). Without your words, you cannot.',
    restore: 'Only with recovery you set up yourself (a backup phrase or shares). Without it, nobody can.',
  },
};

/** True in every mode, said wherever the modes are compared. */
export const POSTING_KEY_NOTE =
  'In every mode this server keeps the key it signs your posts with; that is how the network works today. So whoever runs it could still post in your name. Assisted and Self stop it from taking or moving your identity. Device signing, coming later, closes this gap.';

/** What changes with each switch, on top of the target mode's own text. */
export function switchNote(from: CustodyMode, to: CustodyMode): string {
  if (from === 'custodial') return 'You will write down 12 new words. This server then signs the change that puts your words in charge of your identity.';
  if (to === 'custodial') return 'Your 12 words sign the change that hands control to this server. Afterwards your words no longer do anything, any recovery you set up (backup phrase or shares) stops working, and the passkey on this device is forgotten.';
  if (to === 'self') return 'Your 12 words sign the change that removes this server\'s backup key. After that, this server deletes its backup and can no longer get you back in.';
  return 'Your 12 words sign the change that adds a new backup key for this server, ranked below your words. Any recovery you set up keeps working.';
}

/** The specific thing the person confirms before a switch. */
export function switchAck(to: CustodyMode): string {
  switch (to) {
    case 'self': return 'I understand that if I lose my 12 words and have no recovery set up, nobody, including this server, can give me back control of my identity.';
    case 'assisted': return 'I understand that my 12 words control my identity, that I must keep them safe and private, and that if this server uses its backup I have 72 hours to cancel it with them.';
    case 'custodial': return 'I understand that this server will control my identity and could act as me, and that my 12 words and any recovery I set up will stop working.';
  }
}

export const RECOVERY: Record<RecoveryOption, ChoiceText & { who: string; protects: string }> = {
  none: {
    title: 'No recovery',
    summary: 'Your 12 words are the only way to control your identity.',
    means: 'There is no second way in. Your 12 words are the only thing that controls your identity.',
    responsible: 'Not losing your 12 words.',
    wrong: 'In Self, losing your 12 words means losing control of your identity for good. In Assisted, this server\'s operator can still give you new words after checking who you are.',
    undo: 'Set up recovery at any time, as long as you have your 12 words.',
    who: 'Nobody else.',
    protects: 'Nothing extra. Nobody can take over your identity without your 12 words.',
  },
  phrase: {
    title: 'Backup phrase',
    summary: 'A second set of 12 words, kept whole on paper or in a safe, away from your 12 words.',
    means: 'A second set of 12 words, kept whole: on paper or in a safe, in a different place from your 12 words. With it you can recover your identity and choose new 12 words.',
    responsible: 'Keeping it in a different place from your 12 words, where nobody else can read it.',
    wrong: 'Anyone who finds or copies it can start a recovery on their own. Your 12 words can cancel that within 72 hours, but this server will not email you about it (it never sees the backup phrase), so you need to check for changes yourself. Kept next to your 12 words, one fire or one search takes both.',
    undo: 'Remove it at any time with your 12 words. After that the backup phrase does nothing.',
    who: 'Nobody but you.',
    protects: 'Losing your 12 words.',
  },
  contacts: {
    title: 'Split among people you trust',
    summary: 'Your backup is cut into shares for people you choose. Enough of them together can recover your identity; fewer learn nothing.',
    means: 'Your backup is cut into shares, one for each person you choose (an editor, a colleague, a lawyer). You decide how many must come together to recover your identity. Fewer than that learn nothing from their shares.',
    responsible: 'Choosing people who will not act together against you, handing each their share in person or on paper, and remembering who holds them. This server never knows.',
    wrong: 'If enough holders act together, or someone gets enough shares from them, they can start a recovery. Your 12 words can cancel it within 72 hours, but nobody emails you about it. If too many holders lose their shares, recovery is no longer possible.',
    undo: 'Remove recovery at any time with your 12 words. After that the shares do nothing.',
    who: 'Enough of the people you chose, together (you pick how many).',
    protects: 'Losing your 12 words, without trusting any one person with your identity.',
  },
  newsroom: {
    title: 'With your newsroom',
    summary: 'Split into shares where your newsroom holds exactly one. It can never recover your identity on its own, even if it runs this server.',
    means: 'The same split, but your newsroom holds exactly one share; you and people you trust hold the others. Your newsroom can never recover your identity on its own, even if it runs this server.',
    responsible: 'Making sure your newsroom keeps its share off this server and never holds more than one. Choosing how many shares are needed: if you keep one yourself, your share and the newsroom\'s together may be enough.',
    wrong: 'A court order or a raid on the newsroom gets one share, which alone is useless. But if you keep a share yourself and both you and the newsroom are pressed, that can be enough when only 2 are needed. Your 12 words can cancel a recovery within 72 hours, but nobody emails you about it.',
    undo: 'Remove recovery at any time with your 12 words. After that the shares do nothing.',
    who: 'Your newsroom plus enough others, or enough others without the newsroom. Never the newsroom alone.',
    protects: 'Losing your 12 words, with your newsroom as one of the helpers.',
  },
};

/** Common to every recovery option. */
export const RECOVERY_FACTS = [
  'Recovering gives you new 12 words. Your old 12 words can cancel a recovery for 72 hours, so one that someone else starts fails while you still have yours.',
  'Recovery helps when you lose your 12 words, not when someone steals them: whoever has your words can remove recovery or cancel it.',
  'This server never sees your backup phrase or shares, and does not know which option you chose or who holds what. The only public trace is that your identity has a recovery key.',
] as const;

export function recoveryAck(option: Exclude<RecoveryOption, 'none'>, k: number): string {
  if (option === 'phrase') return 'I understand that anyone who gets this backup phrase can try to take over my identity, and that I must keep it apart from my 12 words.';
  return `I understand that any ${k} share holders together can try to take over my identity, and that I can stop them only by cancelling with my 12 words within 72 hours.`;
}

export function removeRecoveryAck(mode: 'assisted' | 'self'): string {
  return mode === 'self'
    ? 'I understand that the backup phrase or shares will stop working, and that if I then lose my 12 words, nobody can give me back control of my identity.'
    : 'I understand that the backup phrase or shares will stop working, and that if I then lose my 12 words, only this server\'s operator can help.';
}

export const PASSKEY: ChoiceText = {
  title: 'Passkey on this device',
  summary: 'Unlock your 12 words with Face ID, Touch ID, Windows Hello or a security key instead of typing them.',
  means: 'This browser keeps your 12 words on this device, locked with a passkey (Face ID, Touch ID, Windows Hello or a security key), so you do not type them each time. They are never stored unlocked, and this server never sees them or the passkey.',
  responsible: 'Keeping your paper copy. The passkey is a convenience, not a backup.',
  wrong: 'If you lose this device or clear this browser\'s data, the saved copy is gone; your paper copy still works. Anyone who can unlock this device\'s passkey can use your 12 words in this browser.',
  undo: 'Forget it on this device at any time. Your 12 words keep working.',
};

/**
 * Device signing (#240) is being built separately. Described here so the
 * words are settled; the dashboard shows it as "coming later" and has no
 * controls for it yet.
 */
export const DEVICE_SIGNING: ChoiceText & { status: 'coming'; availability: string } = {
  status: 'coming',
  title: 'Device signing',
  summary: 'Your device holds the key that signs your posts, so this server cannot post as you.',
  means: 'Your device holds the key that signs your posts, instead of this server. The server can then no longer post in your name.',
  responsible: 'Keeping the device that holds the key with you and online when you want to post.',
  wrong: 'While your device is offline, you cannot post.',
  undo: 'Only you can turn it off, with your 12 words.',
  availability: 'Only for Self accounts, and for Assisted with one caveat: in Assisted this server could switch it back off with its backup key, but you would be emailed and could cancel that within 72 hours.',
};

export const MOVING: ChoiceText = {
  title: 'Move to another server',
  summary: 'Take your account, posts and files to another server. Your identity stays the same.',
  means: 'Everything in your account is copied to the new server and checked. Only then is your identity pointed at the new server, and the copy here is switched off. Your identity stays the same, so people and apps that know you keep finding you; your handle becomes one of the new server\'s.',
  responsible: 'Choosing a server you trust: from then on it holds your account. Signing in there afterwards.',
  wrong: 'If anything fails before your identity is pointed at the new server, nothing changes here. If it fails after that, you finish at the new server.',
  undo: 'Not from here once your identity points at the new server. You can move again, from the new server, to any server that accepts you (including this one).',
};

export const MOVE_ACK = 'I understand that once my identity points at the new server, I cannot undo the move from here, and that I will sign in at the new server from then on.';

export const CANCEL_CHANGE: ChoiceText = {
  title: 'Cancel an identity change',
  summary: 'Put your identity back to how it was before a change made with a backup key.',
  means: 'Your 12 words sign an update that puts your identity back to how it was just before this change. Any change made after it is undone too.',
  responsible: 'Using the 12 words you had before the change.',
  wrong: 'If the change was yours (for example a recovery you started), cancelling undoes it, and you are back to the words you had before.',
  undo: 'A cancellation is final. If you cancel by mistake, make the change again.',
};

export const PEN_NAMES = {
  title: 'Pen names',
  means: 'A pen name is a separate identity you can publish under without your name on it. It has its own 12 words, kept only on your device; this server holds no key to it, and nothing on this server links it to your account.',
  responsible: 'Keeping the pen name\'s 12 words safe. Pen names have no recovery: if you lose them, the pen name cannot be used again.',
  wrong: 'Your writing, habits and the people you talk to can still give you away; the server cannot protect against that.',
  undo: 'Nobody can tell that a pen name is yours unless you choose to prove it. A proof, once shown, cannot be taken back. You can end a pen name for good with its 12 words.',
  where: 'The pen name\'s 12 words never leave this device. This browser keeps a list of the pen names you made or used here (their names and where they live, never their words), so you can find them again; the list is not sent to any server. Anyone who uses this browser can see it, and you can remove a pen name from it at any time. Tor Browser forgets it when you close it or choose New Identity.',
} as const;

/** Creation passes (blind tokens). */
export const PASSES = {
  means: 'Making a pen name costs one pass. Each account gets the same batch of passes once a month. This server signs them without seeing them, so when a pass is used it cannot tell which account it came from.',
  auto: 'The dashboard collects your batch for you, the first time you sign in each month, whether or not you used any. Every account does the same, so collecting says nothing about you.',
  seen: 'The server sees that your account collected this month\'s batch, as every account does. It never learns which pass becomes which pen name, or whether you use any.',
  kept: 'Passes are kept in this browser, and work for the month they were collected and the month after. Then they expire, and this page drops them.',
} as const;

/** Saving passes to a file, said before the file is made. */
export const PASS_FILE: ChoiceText = {
  title: 'Save my passes to a file',
  summary: 'A small file with your passes, to create a pen name from another browser or Tor Browser without signing in.',
  means: 'The file holds your passes for this server, the month each expires, and your account\'s DID, which a new pen name keeps sealed in its public entry so you can prove later that it is yours. The signed-out page for creating a pen name loads it; nothing in it is sent to a server except the one pass a new pen name uses.',
  responsible: 'Keeping the file private, and deleting it once its passes have expired or been used. Anyone who has the file can create pen names on this server with these passes. They cannot link those pen names to you.',
  wrong: 'If someone else gets the file, they can use up your passes, and they can see from it which account collected them. If you use the same pass twice (from this browser and from the file), the second try fails, and the server sees that the two tries came from the same batch.',
  undo: 'You cannot take back a copy you made. Passes in it stop working when they expire.',
};

/** Printing a pass. */
export const PASS_PRINT = {
  means: 'One pass per page, as a QR code and as text with a checksum. The text is long (about 500 characters), so the QR code is the practical paper form; the text is there if a QR code cannot be read.',
  wrong: 'Anyone who finds the paper can create one pen name on this server with it. They cannot link it to you, but the paper shows which account collected it.',
} as const;

export const REMOVE_AFTER_COPY = 'So a pass is not used twice, remove the passes you copied from this browser. Then use them only from the file or the paper.';

/** The signed-out pages say this when this browser also holds the person's own session. */
export const SIGNED_IN_HERE = 'You are signed in to your own account in this browser. For a pen name nobody can link to you, use a different browser or Tor Browser.';

/** The specific thing the person confirms before a pen name is created. */
export const PEN_CREATE_ACK = 'I understand that this pen name has no recovery: if I lose its 12 words, nobody can give it back.';

/** The honest limit, said in plain words before creating. */
export const PEN_LIMIT = {
  server: 'This server cannot link the pen name to you through its data. The request that creates it carries nothing about you, and the pass it uses cannot be traced back to your account.',
  timing: 'What can link them is the same browser, the same network or the same moment. Whoever runs this server, or watches its network, could guess that your account and the pen name belong together if they are used from the same place, or one right after the other.',
  better: 'So create and use the pen name from another browser and network, or Tor Browser, and never in the same session as your own account.',
} as const;

/** How to keep a pen name apart from your account, step by step. */
export const PEN_CHECKLIST = [
  'Your passes are collected automatically. Save them to a file (or print one) here, on your normal network.',
  'Open the signed-out pen-name page in Tor Browser (or another browser, on another network).',
  'Load your passes there and create the pen name.',
  'Use the pen name only there.',
  'Never sign in to your own account in the same Tor session. Use Tor Browser\'s "New Identity" between them.',
] as const;

export const PEN_PASSKEY: ChoiceText = {
  title: 'Passkey for a pen name',
  summary: 'Unlock the pen name\'s 12 words with Face ID, Touch ID, Windows Hello or a security key instead of typing them.',
  means: 'This browser keeps the pen name\'s 12 words on this device, locked with a passkey, so you do not type them each time. They are never stored unlocked, and no server sees them or the passkey.',
  responsible: 'Keeping the paper copy. The passkey is a convenience, not a backup: a pen name has no recovery.',
  wrong: 'If you lose this device or clear this browser\'s data, the saved copy is gone; the paper copy still works. Anyone who can unlock this device\'s passkey can sign in as the pen name in this browser. A pen name that is saved on this device is also easier to find on it.',
  undo: 'Forget it on this device at any time. The 12 words keep working.',
};

export const PEN_PASSKEY_NOTE = 'Password managers that sync passkeys keep the passkey\'s name in your account with them, so it is named just "Pen name", never the pen name itself.';

export const PEN_PROOF: ChoiceText = {
  title: 'Prove a pen name is yours',
  summary: 'A proof signed by the pen name and by you, that anyone can check against the public directory.',
  means: 'The pen name\'s 12 words and your own account both sign the same sentence: this pen name belongs to this account. When the pen name was made, a sealed note naming your account was locked into its public entry; the proof opens it. Anyone can check the proof on their own device.',
  responsible: 'Deciding who sees the proof. Whoever has the link or file can show it to anyone else.',
  wrong: 'Once someone has seen the proof, they know, and they can pass it on. If this server holds your keys (Custodial), the proof shows that your server signed for your account, not that you did in person.',
  undo: 'You cannot take a proof back once it is shown. A proof you made but never showed does nothing; just delete it.',
};

export const PEN_PUBLIC_PROOF_ACK = 'I understand that this puts the link between this pen name and my account in public, in both accounts\' files, and that it cannot be taken back.';

export const PEN_SHOW_PROOF_ACK = 'I understand that whoever I give this link or file to can see that this pen name is mine and pass it on, and that once shown it cannot be taken back.';

export const PEN_MOVE: ChoiceText = {
  title: 'Move a pen name',
  summary: 'Take the pen name and its files to another server. Its 12 words do it; no server has to agree.',
  means: 'The pen name\'s files are copied to the new server and checked. Only then do its 12 words point it at the new server, and the copy here is switched off. Its identity stays the same; its handle becomes one of the new server\'s.',
  responsible: 'Choosing a server you trust with the pen name. Signing in there afterwards.',
  wrong: 'If anything fails before the pen name is pointed at the new server, nothing changes. Moving from this browser connects the two servers\' records of the move with your network address, as any use of the pen name does.',
  undo: 'Move it again, with its 12 words, to any server that accepts pen names, including this one.',
};

export const PEN_MOVE_ACK = 'I understand that once the pen name points at the new server, it lives there, and I sign in as it there from then on.';

export const PEN_END: ChoiceText = {
  title: 'End a pen name',
  summary: 'Delete the pen name\'s account and files and retire it in the public directory, for good.',
  means: 'Its account and files are deleted on its server (and on servers it moved away from), and its 12 words sign a final entry in the public directory that retires it. After that nobody, including you, can sign in as it, move it or prove it is yours.',
  responsible: 'Keeping a backup first if you want its files. Telling the people who need to know.',
  wrong: 'Copies other people or services already made of its posts can stay. A proof you showed before remains valid for what it said then.',
  undo: 'You cannot. An ended pen name is gone for good.',
};

export function penEndAck(handle: string): string {
  return `I understand that ${handle} ends for good: its account and files are deleted, and nobody, including me, can use it again.`;
}

/** One term of the glossary page. */
export interface GlossaryTerm {
  id: string;
  term: string;
  /** Plain explanation. */
  text: string;
  /** The technical name, explained in `text`. */
  technical?: string;
  /** Not built yet. */
  coming?: string;
}

export const GLOSSARY_SECTIONS: { title: string; terms: GlossaryTerm[] }[] = [
  {
    title: 'Your identity',
    terms: [
      { id: 'identity', term: 'Identity', technical: 'DID (decentralized identifier), written like did:plc:…', text: 'Your permanent ID on the network. It stays the same when you change your handle or move to another server, so people and apps keep finding you.' },
      { id: 'handle', term: 'Handle', text: 'Your name on the network, like @alice.example.com. It can change; your identity stays the same.' },
      { id: 'server', term: 'Server', technical: 'PDS (Personal Data Server)', text: 'The computer that hosts your account, posts and files. You can move to another one.' },
      { id: 'directory', term: 'Public directory', technical: 'PLC directory', text: 'The public list that says, for each identity, which keys control it and which server hosts it. Anyone can read it, which is how changes to your identity can be checked.' },
      { id: 'identity-change', term: 'Identity change', technical: 'PLC operation', text: 'An update to your entry in the public directory: who controls your identity, its keys, its server or its handle. Every change is public and dated.' },
      { id: 'cancel-window', term: 'The 72 hours', text: 'A change made with a backup key (this server\'s backup in Assisted, or your recovery) can be cancelled with your 12 words for 72 hours. After that it stays.' },
    ],
  },
  {
    title: 'Who controls your identity',
    terms: [
      { id: 'custodial', term: CUSTODY.custodial.title, text: CUSTODY.custodial.summary },
      { id: 'assisted', term: CUSTODY.assisted.title, text: CUSTODY.assisted.summary },
      { id: 'self', term: CUSTODY.self.title, text: CUSTODY.self.summary },
      { id: 'twelve-words', term: 'Your 12 words', technical: 'identity phrase, recovery phrase in some apps', text: 'Twelve ordinary words, made on your device, that hold the keys to your identity in Assisted and Self. Whoever has them controls your identity. This server never sees them.' },
      { id: 'posting-key', term: 'The key that signs your posts', technical: 'repo signing key', text: POSTING_KEY_NOTE },
      { id: 'device-signing', term: DEVICE_SIGNING.title, coming: 'Coming later (#240)', text: `${DEVICE_SIGNING.means} ${DEVICE_SIGNING.wrong} ${DEVICE_SIGNING.availability} ${DEVICE_SIGNING.undo}` },
    ],
  },
  {
    title: 'Recovery',
    terms: [
      { id: 'recovery', term: 'Recovery', technical: 'recovery key', text: 'An optional second way back in for Assisted and Self, in case you lose your 12 words. Recovering gives you new 12 words; your old ones can cancel it for 72 hours.' },
      { id: 'backup-phrase', term: RECOVERY.phrase.title, text: RECOVERY.phrase.summary },
      { id: 'shares', term: 'Shares', technical: 'Shamir secret sharing', text: 'Pieces of your backup, each written as 20 words or a QR code. A set number of them together recover your identity; fewer learn nothing.' },
      { id: 'split-contacts', term: RECOVERY.contacts.title, text: RECOVERY.contacts.summary },
      { id: 'with-newsroom', term: RECOVERY.newsroom.title, text: RECOVERY.newsroom.summary },
      { id: 'password-reset', term: 'Password reset', text: 'A link by email that gives you back your login, in every mode. It never restores your 12 words or control of your identity.' },
    ],
  },
  {
    title: 'Devices, pen names and moving',
    terms: [
      { id: 'passkey', term: PASSKEY.title, technical: 'WebAuthn passkey with the PRF extension', text: PASSKEY.means },
      { id: 'signed-in-device', term: 'Signed-in device', technical: 'session', text: 'A browser or app where you are signed in with your password. Signing one out does not change your identity.' },
      { id: 'pen-name', term: PEN_NAMES.title, technical: 'pseudonym', text: PEN_NAMES.means },
      { id: 'pen-name-words', term: 'A pen name\'s 12 words', technical: 'pseudonym phrase; its owner key is the only rotation key of its DID', text: 'Twelve ordinary words, made on your device, that are the pen name: whoever has them can sign in as it, move it, prove it, or end it. There is no recovery and no reset. They are different from your own 12 words.' },
      { id: 'pass', term: 'Pass', technical: 'blind creation token (RSA blind signatures, RFC 9474)', text: `${PASSES.means} ${PASSES.auto} ${PASSES.kept}` },
      { id: 'pass-file', term: 'Pass file', text: `${PASS_FILE.means} ${PASS_FILE.responsible}` },
      { id: 'pen-proof', term: 'Proof that a pen name is yours', technical: 'reveal bundle; pseudonym commitment', text: PEN_PROOF.means },
      { id: 'in-person-proof', term: 'In-person proof', technical: 'presence proof', text: 'Someone says a word; the pen name\'s 12 words sign it on your device, and they check the signature on their own phone. It shows you hold the pen name\'s words, without naming your account.' },
      { id: 'end-pen-name', term: PEN_END.title, technical: 'account deletion and PLC tombstone', text: PEN_END.means },
      { id: 'moving', term: MOVING.title, technical: 'account migration', text: MOVING.summary },
    ],
  },
];

const BY_ID = new Map(GLOSSARY_SECTIONS.flatMap((s) => s.terms).map((t) => [t.id, t]));

export function glossaryTerm(id: string): GlossaryTerm {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`No glossary term ${id}`);
  return t;
}
