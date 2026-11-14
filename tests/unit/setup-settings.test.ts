/**
 * The wizard's answers, checked and turned into the variables the server
 * reads (#405).
 */
import { describe, it, expect } from 'vitest';
import {
  validateSection, validateAll, resolveSetup, dnsRecords, afterInstallChecklist, defaultOptions, parseOrigin,
  type SetupInput,
} from '../../src/setup/settings.js';
import { resolveIdentityPolicy } from '../../src/identity/custody-policy.js';

function input(over: Partial<SetupInput> = {}): SetupInput {
  return {
    kind: 'community',
    addresses: { publicUrl: 'https://pds.example.org', handleDomain: 'example.org', dashboardUrl: 'https://app.example.org' },
    email: { mode: 'smtp', host: 'smtp.example.com', port: '587', user: 'mailer', password: 'secret', from: 'noreply@example.org' },
    admin: { handle: 'maria', email: 'maria@example.org', password: 'Correct-Horse-9', repeat: 'Correct-Horse-9' },
    options: defaultOptions('community'),
    ...over,
  };
}

describe('validation', () => {
  it('accepts a complete, sensible answer', () => {
    expect(validateAll(input(), false)).toEqual({});
  });

  it('explains each problem in plain words, on the field it belongs to', () => {
    const bad = validateAll({
      kind: 'other' as never,
      addresses: { publicUrl: 'http://pds.example.org', handleDomain: 'not a domain', dashboardUrl: 'https://app.example.org/path' },
      email: { mode: 'smtp', host: '', port: '99999', from: 'nope' },
      admin: { handle: 'A', email: 'x', password: 'short', repeat: 'short' },
      options: { inviteOnly: true, pseudonyms: false, custody: [], custodyDefault: 'self' },
    }, false);
    expect(bad.kind?.kind).toMatch(/Choose/);
    expect(bad.addresses?.publicUrl).toMatch(/https:\/\//);
    expect(bad.addresses?.handleDomain).toMatch(/example\.org/);
    expect(bad.addresses?.dashboardUrl).toMatch(/nothing after the domain/);
    expect(bad.email?.host).toBeTruthy();
    expect(bad.email?.port).toBeTruthy();
    expect(bad.email?.from).toBeTruthy();
    expect(bad.admin?.handle).toBeTruthy();
    expect(bad.admin?.email).toBeTruthy();
    expect(bad.admin?.password).toMatch(/10 characters/);
    expect(bad.options?.custody).toBeTruthy();
  });

  it('allows http only for this machine, and only outside production', () => {
    expect(parseOrigin('http://localhost:8080', true)).toEqual({ origin: 'http://localhost:8080', host: 'localhost:8080' });
    expect('error' in parseOrigin('http://localhost:8080', false)).toBe(true);
    expect('error' in parseOrigin('http://pds.example.org', true)).toBe(true);
    expect(parseOrigin('pds.example.org', false)).toEqual({ origin: 'https://pds.example.org', host: 'pds.example.org' });
  });

  it('mismatched passwords and a default outside the allowed modes are caught', () => {
    expect(validateSection('admin', input({ admin: { handle: 'maria', email: 'm@example.org', password: 'Correct-Horse-9', repeat: 'other' } }), false).repeat).toBeTruthy();
    expect(validateSection('options', input({ options: { inviteOnly: true, pseudonyms: true, custody: ['self'], custodyDefault: 'custodial' } }), false).custodyDefault).toBeTruthy();
  });

  it('the operator may take a reserved name such as "admin" for themselves', () => {
    expect(validateSection('admin', input({ admin: { handle: 'admin', email: 'a@example.org', password: 'Correct-Horse-9' } }), false)).toEqual({});
  });
});

describe('resolveSetup', () => {
  it('maps a community server with email to the existing variables', () => {
    const r = resolveSetup(input(), false);
    expect(r.env).toEqual({
      OPENFEDERATION_PROFILE: 'community',
      PDS_SERVICE_URL: 'https://pds.example.org',
      PDS_HOSTNAME: 'pds.example.org',
      HANDLE_SUFFIX: '.example.org',
      PLC_DIRECTORY_URL: 'https://plc.openfederation.net',
      WEB_UI_URL: 'https://app.example.org',
      CORS_ORIGINS: 'https://app.example.org',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
      SMTP_FROM: 'noreply@example.org',
      INVITE_REQUIRED: 'true',
      PSEUDONYMS_ENABLED: 'false',
      IDENTITY_CUSTODY_ALLOWED: 'custodial,assisted,self',
      IDENTITY_CUSTODY_DEFAULT: 'custodial',
      ACCOUNT_APPROVAL: 'manual',
      DEFAULT_APPEARANCE: 'openfederation',
    });
    expect(r.admin).toEqual({ handle: 'maria', email: 'maria@example.org' });
    expect(resolveIdentityPolicy(r.env)).toMatchObject({ profile: 'community', pseudonymsEnabled: false, custodyDefault: 'custodial' });
  });

  it('a privacy server with no email says so explicitly, and its own directory is used', () => {
    const r = resolveSetup(input({
      kind: 'privacy',
      addresses: { publicUrl: 'pds.news.example', handleDomain: '@news.example', plcUrl: 'https://plc.news.example' },
      email: { mode: 'none' },
      options: { ...defaultOptions('privacy'), custody: ['assisted', 'self'] },
    }), false);
    expect(r.env.ALLOW_NO_EMAIL).toBe('true');
    expect(r.env.SMTP_HOST).toBeUndefined();
    expect(r.env.HANDLE_SUFFIX).toBe('.news.example');
    expect(r.env.PLC_DIRECTORY_URL).toBe('https://plc.news.example');
    expect(r.env.WEB_UI_URL).toBeUndefined();
    expect(r.env.CORS_ORIGINS).toBeUndefined();
    expect(resolveIdentityPolicy(r.env)).toEqual({ profile: 'privacy', custodyAllowed: ['assisted', 'self'], custodyDefault: 'self', pseudonymsEnabled: true, deviceSigningAllowed: true });
  });

  it('approving new accounts automatically and the dashboard\'s look are starting choices too', () => {
    expect(defaultOptions('community')).toMatchObject({ accountApproval: 'manual', appearance: 'openfederation' });
    expect(defaultOptions('privacy')).toMatchObject({ accountApproval: 'manual', appearance: 'openfederation' });
    const r = resolveSetup(input({ options: { ...defaultOptions('community'), accountApproval: 'automatic', appearance: 'opennewsrooms' } }), false);
    expect(r.env).toMatchObject({ ACCOUNT_APPROVAL: 'automatic', DEFAULT_APPEARANCE: 'opennewsrooms' });
    // An answer from an older page, without them: the defaults.
    const { accountApproval: _a, appearance: _b, ...older } = defaultOptions('community');
    expect(resolveSetup(input({ options: older }), false).env).toMatchObject({ ACCOUNT_APPROVAL: 'manual', DEFAULT_APPEARANCE: 'openfederation' });
  });

  it('refuses an approval mode or a look that does not exist', () => {
    const bad = validateSection('options', input({ options: { ...defaultOptions('community'), accountApproval: 'sometimes' as never, appearance: 'neon' as never } }), false);
    expect(bad.accountApproval).toBeTruthy();
    expect(bad.appearance).toBeTruthy();
  });

  it('port 465 means TLS from the first byte', () => {
    const r = resolveSetup(input({ email: { mode: 'smtp', host: 'smtp.example.com', port: 465, from: 'a@example.org' } }), false);
    expect(r.env.SMTP_SECURE).toBe('true');
    expect(r.env.SMTP_USER).toBeUndefined();
  });
});

describe('DNS records and the checklist', () => {
  it('a custom domain needs a record pointing at the platform address; names get a wildcard', () => {
    const r = resolveSetup(input(), false);
    const records = dnsRecords(r, 'openfederation-pds-production.up.railway.app', 'web.up.railway.app');
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'CNAME', name: 'pds.example.org', value: 'openfederation-pds-production.up.railway.app', required: true }),
      expect.objectContaining({ type: 'CNAME', name: '*.example.org', value: 'pds.example.org', required: false }),
      expect.objectContaining({ type: 'CNAME', name: 'app.example.org', value: 'web.up.railway.app', required: true }),
    ]));
  });

  it('a platform address needs no record of its own', () => {
    const r = resolveSetup(input({ addresses: { publicUrl: 'https://x.up.railway.app', handleDomain: 'example.org' } }), false);
    const records = dnsRecords(r, 'x.up.railway.app', null);
    expect(records.map((x) => x.name)).toEqual(['*.example.org']);
  });

  it('the checklist covers the settings file, backups, email safety and the security contact', () => {
    const withMail = afterInstallChecklist(resolveSetup(input(), false)).map((i) => i.title + ' ' + i.detail).join('\n');
    expect(withMail).toMatch(/settings file/);
    expect(withMail).toMatch(/[Bb]ack/);
    expect(withMail).toMatch(/DMARC/);
    expect(withMail).toMatch(/SECURITY_CONTACT/);
    const noMail = afterInstallChecklist(resolveSetup(input({ email: { mode: 'none' } }), false)).map((i) => i.title).join('\n');
    expect(noMail).toMatch(/Set up email/);
  });
});

describe('test email failures', () => {
  it('are explained in plain words, even when the error carries no message', async () => {
    const { explainSmtpError } = await import('../../src/setup/setup-app.js');
    const refused = Object.assign(new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], ''), { code: 'ECONNREFUSED' });
    expect(explainSmtpError(refused)).toMatch(/refused the connection/);
    expect(explainSmtpError(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))).toMatch(/username or password/);
    expect(explainSmtpError(new Error(''))).toMatch(/^Check the mail server/);
  });
});
