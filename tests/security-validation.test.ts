/**
 * Security Regression Tests: Input Validation
 *
 * Tests for handle, email, password, and domain validation functions.
 * These are pure unit tests with no database or network dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidHandle,
  isValidEmail,
  isStrongPassword,
  isValidDomain,
  normalizeEmail,
  normalizeHandle,
  generateInviteCode,
  createLocalDid,
} from '../src/auth/utils.js';

describe('Handle validation', () => {
  it('accepts valid handles', () => {
    assert.ok(isValidHandle('alice'));
    assert.ok(isValidHandle('bob123'));
    assert.ok(isValidHandle('my-handle'));
    assert.ok(isValidHandle('abc'));  // minimum 3 chars
    assert.ok(isValidHandle('a'.repeat(30)));  // maximum 30 chars
  });

  it('rejects handles shorter than 3 characters', () => {
    assert.ok(!isValidHandle('ab'));
    assert.ok(!isValidHandle('a'));
    assert.ok(!isValidHandle(''));
  });

  it('rejects handles longer than 30 characters', () => {
    assert.ok(!isValidHandle('a'.repeat(31)));
    assert.ok(!isValidHandle('a'.repeat(100)));
  });

  it('rejects handles with leading hyphens', () => {
    assert.ok(!isValidHandle('-alice'));
  });

  it('rejects handles with trailing hyphens', () => {
    assert.ok(!isValidHandle('alice-'));
  });

  it('rejects handles with consecutive hyphens', () => {
    assert.ok(!isValidHandle('al--ice'));
  });

  it('rejects handles with uppercase characters', () => {
    assert.ok(!isValidHandle('Alice'));
    assert.ok(!isValidHandle('ALICE'));
  });

  it('rejects handles with special characters', () => {
    assert.ok(!isValidHandle('alice@bob'));
    assert.ok(!isValidHandle('alice.bob'));
    assert.ok(!isValidHandle('alice bob'));
    assert.ok(!isValidHandle('alice/bob'));
    assert.ok(!isValidHandle("alice'bob"));
  });

  it('rejects reserved handles', () => {
    assert.ok(!isValidHandle('admin'));
    assert.ok(!isValidHandle('root'));
    assert.ok(!isValidHandle('system'));
    assert.ok(!isValidHandle('moderator'));
    assert.ok(!isValidHandle('api'));
    assert.ok(!isValidHandle('xrpc'));
    assert.ok(!isValidHandle('health'));
    assert.ok(!isValidHandle('null'));
    assert.ok(!isValidHandle('undefined'));
  });
});

describe('Email validation', () => {
  it('accepts valid emails', () => {
    assert.ok(isValidEmail('user@example.com'));
    assert.ok(isValidEmail('user.name@example.com'));
    assert.ok(isValidEmail('user+tag@example.com'));
    assert.ok(isValidEmail('user@subdomain.example.com'));
  });

  it('rejects emails without @', () => {
    assert.ok(!isValidEmail('userexample.com'));
    assert.ok(!isValidEmail('user'));
  });

  it('rejects emails without domain', () => {
    assert.ok(!isValidEmail('user@'));
    assert.ok(!isValidEmail('@example.com'));
  });

  it('rejects empty emails', () => {
    assert.ok(!isValidEmail(''));
  });
});

describe('Password strength validation', () => {
  it('accepts passwords meeting 3-of-4 categories with 10+ chars', () => {
    assert.ok(isStrongPassword('Password1!')); // all 4 categories
    assert.ok(isStrongPassword('Password12')); // lower + upper + digit
    assert.ok(isStrongPassword('password1!')); // lower + digit + special
    assert.ok(isStrongPassword('PASSWORD1!')); // upper + digit + special
    assert.ok(isStrongPassword('Pas sword1')); // lower + upper + digit (space is special)
  });

  it('rejects passwords shorter than 10 characters', () => {
    assert.ok(!isStrongPassword('Pass1!')); // 6 chars, meets categories but too short
    assert.ok(!isStrongPassword('Passw0rd!')); // 9 chars
  });

  it('rejects passwords longer than 128 characters', () => {
    assert.ok(!isStrongPassword('A1!' + 'a'.repeat(126))); // 129 chars
  });

  it('rejects passwords with only 2 categories', () => {
    assert.ok(!isStrongPassword('abcdefghij')); // only lowercase
    assert.ok(!isStrongPassword('ABCDEFGHIJ')); // only uppercase
    assert.ok(!isStrongPassword('1234567890')); // only digits
    assert.ok(!isStrongPassword('abcdefgh12')); // only lower + digit
  });

  it('accepts passwords at exactly 10 characters', () => {
    assert.ok(isStrongPassword('Abcdefgh1!')); // exactly 10
  });

  it('accepts passwords at exactly 128 characters', () => {
    assert.ok(isStrongPassword('A1!' + 'a'.repeat(125))); // exactly 128
  });
});

describe('Domain validation', () => {
  it('accepts valid domains', () => {
    assert.ok(isValidDomain('example.com'));
    assert.ok(isValidDomain('sub.example.com'));
    assert.ok(isValidDomain('my-site.example.co.uk'));
  });

  it('rejects domains without a dot', () => {
    assert.ok(!isValidDomain('localhost'));
    assert.ok(!isValidDomain('example'));
  });

  it('rejects domains with protocols', () => {
    assert.ok(!isValidDomain('https://example.com'));
    assert.ok(!isValidDomain('http://example.com'));
  });

  it('rejects domains with paths', () => {
    assert.ok(!isValidDomain('example.com/path'));
  });

  it('rejects domains with ports', () => {
    assert.ok(!isValidDomain('example.com:8080'));
  });

  it('rejects domains with spaces or special chars', () => {
    assert.ok(!isValidDomain('example .com'));
    assert.ok(!isValidDomain('example?.com'));
    assert.ok(!isValidDomain('example#.com'));
  });

  it('rejects domains shorter than 4 characters', () => {
    assert.ok(!isValidDomain('a.b'));
  });

  it('rejects domains longer than 253 characters', () => {
    assert.ok(!isValidDomain('a'.repeat(250) + '.com'));
  });
});

describe('Normalization', () => {
  it('normalizes email to lowercase and trims', () => {
    assert.equal(normalizeEmail('  User@Example.COM  '), 'user@example.com');
  });

  it('normalizes handle to lowercase and trims', () => {
    assert.equal(normalizeHandle('  MyHandle  '), 'myhandle');
  });
});

describe('Invite code generation', () => {
  it('generates base64url-encoded codes', () => {
    const code = generateInviteCode();
    assert.ok(code.length > 0);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(code), 'Should be base64url encoded');
  });

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateInviteCode()));
    assert.equal(codes.size, 100, 'All codes should be unique');
  });
});

describe('Local DID generation', () => {
  it('generates valid did:plc format', () => {
    const did = createLocalDid();
    assert.ok(did.startsWith('did:plc:'));
    assert.equal(did.length, 'did:plc:'.length + 24);
  });

  it('generates unique DIDs', () => {
    const dids = new Set(Array.from({ length: 100 }, () => createLocalDid()));
    assert.equal(dids.size, 100, 'All DIDs should be unique');
  });
});
