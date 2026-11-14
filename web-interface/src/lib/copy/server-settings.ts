/**
 * The words of Admin, Server settings (#410). Each group answers, before an
 * admin changes anything: what it means, what changes for people already on
 * this server, and how to undo it. Terms (custody modes, pen names, device
 * signing, moving) come from the glossary, so they read the same everywhere.
 *
 * Accuracy is checked against src/settings/runtime-settings.ts and the code
 * that reads each setting. When the behaviour changes, change the words here.
 */
import { CUSTODY, DEVICE_SIGNING, PEN_NAMES, type CustodyMode } from './glossary';
import type { ServerSetting, SettingId, SettingSource, SettingValue } from '@/lib/api/server-settings';

export interface GroupText {
  title: string;
  summary: string;
  means: string;
  alreadyHere: string;
  undo: string;
  /** Glossary terms worth an inline "What does … mean?". */
  terms: string[];
  settings: SettingId[];
}

export type GroupId = 'signup' | 'custody' | 'penNames' | 'moving' | 'federation' | 'appearance';

export const GROUPS: Record<GroupId, GroupText> = {
  signup: {
    title: 'Who can sign up',
    summary: 'Whether new people need an invite, whether an admin approves each new account, and what happens until they confirm their email.',
    means: 'Invite-only sign-up asks new people for an invite code from an admin. Approving new accounts decides whether a new account waits until an admin approves it, or gets in straight away. Email verification decides what someone who has not yet confirmed their email address can do.',
    alreadyHere: 'Invite-only sign-up and approving new accounts only affect new sign-ups: turning on automatic approval does not approve the people already waiting; approve them on Admin, Users. Email verification applies at once to everyone: a stricter choice holds back anyone who has not confirmed their email until they do.',
    undo: 'Change it back at any time. Accounts created or approved meanwhile stay as they are, and people who were held back can act again straight away.',
    terms: [],
    settings: ['inviteRequired', 'accountApproval', 'emailVerificationPolicy'],
  },
  custody: {
    title: 'How accounts are looked after',
    summary: 'Who may hold the keys that control people\'s identities, and which way apps suggest first.',
    means: 'People choose one of the ways you offer when they create an account, and can switch later to another way you offer. The way offered first is what apps suggest; people can still pick any other you offer.',
    alreadyHere: 'Nothing changes for accounts that already exist. People using a way you stop offering keep it and everything keeps working; nobody new can choose it, and nobody can switch to it.',
    undo: 'Offer it again at any time.',
    terms: ['custodial', 'assisted', 'self', 'device-signing'],
    settings: ['custodyAllowed', 'custodyDefault', 'deviceSigningAllowed'],
  },
  penNames: {
    title: PEN_NAMES.title,
    summary: 'Whether people here can start pen names, and the limits that slow down throw-away ones.',
    means: `A pen name is a separate identity people can publish under without their name on it. Its 12 words stay on the person's device; this server holds no key to it, and nothing on this server links it to their account. Each new pen name needs a creation pass; an account collects a set number of passes a month, and the passes cannot be traced back to it. A new pen name starts on probation: a few days in which it can post only a limited number of times a day.`,
    alreadyHere: 'Turning pen names off stops new ones: nobody can collect passes, start a pen name or move one here. Pen names that already exist keep working; they still sign in and post. A new limit applies from the next time someone collects passes or posts.',
    undo: 'Turn pen names back on at any time; nothing is lost while they are off.',
    terms: ['pen-name'],
    settings: ['pseudonymsEnabled', 'pseudonymTokensPerEpoch', 'pseudonymProbationDays', 'pseudonymProbationDailyWrites'],
  },
  moving: {
    title: 'Moving here',
    summary: 'Whether accounts, pen names and communities on another server may move to this one.',
    means: `People can move their account, posts and files from one server to another and keep the same identity. These settings decide who may move to this server: anyone, only with an invite code (for pen names, a creation pass instead, because an invite code could say who handed it out), or nobody.`,
    alreadyHere: 'Applies to new moves only. Accounts, pen names and communities that already moved here stay, and people here can still move away.',
    undo: 'Change it back at any time.',
    terms: ['moving'],
    settings: ['migrationAccounts', 'migrationPseudonyms', 'migrationCommunities'],
  },
  federation: {
    title: 'Federation peers',
    summary: 'Other OpenFederation servers this one asks for public communities and activity.',
    means: 'This server asks each server on the list for its public communities and public activity, so people here can discover them. It sends nothing about the people on this server.',
    alreadyHere: 'Only what people can discover changes, within a few minutes. Nothing is added to or removed from anyone\'s account or communities.',
    undo: 'Add the address again.',
    terms: [],
    settings: ['federationPeers'],
  },
  appearance: {
    title: 'Appearance',
    summary: 'How the dashboard looks to someone who has not chosen a look of their own.',
    means: 'The look people see when they open this server\'s dashboard. Anyone can still pick another look for themselves under Appearance in the top bar; their own choice always wins.',
    alreadyHere: 'People who chose a look keep it. Everyone else sees the new look the next time they open the dashboard. Nothing about their account changes.',
    undo: 'Choose another look at any time.',
    terms: [],
    settings: ['defaultAppearance'],
  },
};

export const GROUP_ORDER: GroupId[] = ['signup', 'custody', 'penNames', 'moving', 'federation', 'appearance'];

export const SETTING_LABEL: Record<SettingId, string> = {
  inviteRequired: 'Invite-only sign-up',
  accountApproval: 'Approving new accounts',
  emailVerificationPolicy: 'Email verification',
  custodyAllowed: 'Ways offered',
  custodyDefault: 'Offered first',
  deviceSigningAllowed: DEVICE_SIGNING.title,
  pseudonymsEnabled: 'Pen names allowed',
  pseudonymTokensPerEpoch: 'Creation passes per month',
  pseudonymProbationDays: 'Probation, in days',
  pseudonymProbationDailyWrites: 'Posts a day on probation',
  migrationAccounts: 'Accounts',
  migrationPseudonyms: 'Pen names',
  migrationCommunities: 'Communities',
  federationPeers: 'Servers to ask',
  defaultAppearance: 'Default look',
};

export const SETTING_HINT: Partial<Record<SettingId, string>> = {
  inviteRequired: 'New people need an invite code from an admin. When off, anyone who can reach this server can sign up.',
  deviceSigningAllowed: `${DEVICE_SIGNING.summary} Only for Self and Assisted accounts; people whose device already signs keep doing so if you turn this off.`,
  pseudonymsEnabled: 'When off, nobody can start a new pen name or move one here. Existing pen names keep working.',
  pseudonymTokensPerEpoch: 'How many pen names one account can start in a month. From 1 to 1000.',
  pseudonymProbationDays: 'How many days a new pen name is on probation. 0 turns probation off.',
  pseudonymProbationDailyWrites: 'How many times a day a pen name on probation can post.',
  custodyDefault: 'The way apps suggest first. It must be one of the ways offered.',
  federationPeers: 'One web address per line, like https://pds.example.org. Up to 50.',
  defaultAppearance: 'What the dashboard looks like until a person chooses their own look.',
};

export const APPROVAL: Record<string, { title: string; text: string }> = {
  manual: { title: 'An admin approves each new account', text: 'New accounts wait on Admin, Users until an admin approves them. Until then they cannot sign in.' },
  automatic: { title: 'Approve new accounts automatically', text: 'Anyone who can sign up gets in straight away, with nobody checking first. Keep invite-only sign-up on to decide who can sign up at all.' },
};

/** Every look the server offers, including any this dashboard does not have yet. */
export const LOOKS: Record<string, { title: string; text: string }> = {
  openfederation: { title: 'OpenFederation', text: 'Paper, ink, and a little teal.' },
  'pds-basic': { title: 'PDS Basic', text: 'The original, plain look.' },
  opennewsrooms: { title: 'Open Newsrooms', text: 'Newsprint, serif type, and a red mark.' },
};

export const EMAIL_POLICY: Record<string, { title: string; text: string; strictness: number }> = {
  off: { title: 'Off', text: 'No verification emails are sent, and nothing waits for them.', strictness: 0 },
  advisory: { title: 'Ask, but do not require', text: 'People are asked to confirm their email, and can do everything without it.', strictness: 1 },
  'require-for-write': { title: 'Required to post', text: 'People who have not confirmed their email can sign in and read, but cannot post or change anything.', strictness: 2 },
  'require-for-login': { title: 'Required to sign in', text: 'People who have not confirmed their email cannot sign in.', strictness: 3 },
};

export const MOVE_POLICY: Record<string, { title: string; strictness: number }> = {
  open: { title: 'Anyone', strictness: 0 },
  invite: { title: 'Only with an invite code', strictness: 1 },
  token: { title: 'Only with a creation pass', strictness: 1 },
  closed: { title: 'Nobody', strictness: 2 },
};

export const CUSTODY_ORDER: CustodyMode[] = ['custodial', 'assisted', 'self'];
export { CUSTODY };

export function formatValue(id: SettingId, value: SettingValue): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) {
    if (id === 'custodyAllowed') return value.map((m) => CUSTODY[m as CustodyMode]?.title ?? m).join(', ');
    return value.length ? value.join(', ') : 'none';
  }
  if (id === 'custodyDefault') return CUSTODY[value as CustodyMode]?.title ?? String(value);
  if (id === 'emailVerificationPolicy') return EMAIL_POLICY[String(value)]?.title ?? String(value);
  if (id === 'accountApproval') return value === 'automatic' ? 'Automatic' : 'By an admin';
  if (id === 'defaultAppearance') return LOOKS[String(value)]?.title ?? String(value);
  if (id.startsWith('migration')) return MOVE_POLICY[String(value)]?.title ?? String(value);
  return String(value);
}

const PROFILE_NAME: Record<string, string> = { community: 'community', privacy: 'privacy' };

export function sourceText(setting: ServerSetting, profile?: string): string {
  return describeSource(setting.source, setting, profile);
}

function describeSource(source: SettingSource, setting: ServerSetting, profile?: string): string {
  switch (source) {
    case 'environment': return `Set by the server's environment (${setting.envVar}). To change it, change that variable where the server is hosted and restart the server.`;
    case 'admin': return setting.changedAt ? `Changed here on ${new Date(setting.changedAt).toLocaleString()}.` : 'Changed here.';
    case 'setup': return 'Chosen during setup.';
    case 'default': return profile ? `The default for a ${PROFILE_NAME[profile] ?? profile} server.` : 'The default.';
  }
}

/** What the "go back" button says for a setting an admin changed. */
export function fallbackText(setting: ServerSetting): string {
  const where = setting.fallbackSource === 'setup' ? 'the choice made during setup' : 'the default';
  return `Go back to ${where} (${formatValue(setting.id, setting.fallback)})`;
}

/**
 * The changes that affect people already here, in plain words, for the
 * confirmation. Empty when nothing needs confirming.
 */
export function effectsOnPeople(before: Partial<Record<SettingId, SettingValue>>, after: Partial<Record<SettingId, SettingValue>>): string[] {
  const notes: string[] = [];
  const changed = (id: SettingId) => id in after && JSON.stringify(before[id]) !== JSON.stringify(after[id]);

  if (changed('pseudonymsEnabled') && after.pseudonymsEnabled === false) {
    notes.push('Nobody will be able to collect creation passes, start a pen name or move one here. Existing pen names keep working.');
  }
  if (changed('custodyAllowed')) {
    const removed = ((before.custodyAllowed as string[]) ?? []).filter((m) => !((after.custodyAllowed as string[]) ?? []).includes(m));
    for (const m of removed) {
      notes.push(`Nobody new can choose ${CUSTODY[m as CustodyMode]?.title ?? m}, and nobody can switch to it. People already using it keep it.`);
    }
  }
  if (changed('deviceSigningAllowed') && after.deviceSigningAllowed === false) {
    notes.push('Nobody else can turn on device signing. People whose device already signs keep doing so.');
  }
  if (changed('inviteRequired') && after.inviteRequired === false) {
    notes.push('Anyone who can reach this server can sign up, without an invite code.');
  }
  if (changed('accountApproval') && after.accountApproval === 'automatic') {
    const open = (after.inviteRequired ?? before.inviteRequired) === false;
    notes.push(open
      ? 'Anyone who can reach this server can sign up and get in straight away: sign-up is open and nobody approves new accounts. Turn invite-only sign-up on to keep control.'
      : 'New accounts get in straight away, without an admin approving them. Invite-only sign-up still decides who can sign up.');
    notes.push('People already waiting for approval are not approved by this. Approve them on Admin, Users.');
  }
  if (changed('emailVerificationPolicy')
    && (EMAIL_POLICY[String(after.emailVerificationPolicy)]?.strictness ?? 0) > (EMAIL_POLICY[String(before.emailVerificationPolicy)]?.strictness ?? 0)) {
    notes.push(`Email verification becomes "${formatValue('emailVerificationPolicy', after.emailVerificationPolicy!)}": ${EMAIL_POLICY[String(after.emailVerificationPolicy)].text} This applies at once to people already here.`);
  }
  for (const id of ['migrationAccounts', 'migrationPseudonyms', 'migrationCommunities'] as const) {
    if (changed(id) && (MOVE_POLICY[String(after[id])]?.strictness ?? 0) > (MOVE_POLICY[String(before[id])]?.strictness ?? 0)) {
      notes.push(`${SETTING_LABEL[id]} moving here: ${formatValue(id, after[id]!).toLowerCase()}. Moves already finished stay.`);
    }
  }
  if (changed('pseudonymTokensPerEpoch') && Number(after.pseudonymTokensPerEpoch) < Number(before.pseudonymTokensPerEpoch)) {
    notes.push(`Each account can start at most ${after.pseudonymTokensPerEpoch} pen names a month.`);
  }
  return notes;
}

export const CONFIRM_ACK = 'I understand what this changes for people on this server.';
