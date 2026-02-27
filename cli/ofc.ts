#!/usr/bin/env node
/**
 * ofc — OpenFederation CLI
 *
 * Command-line interface following clig.dev best practices.
 * Subcommand structure: ofc <noun> <verb>
 *
 * stdout  → machine-parseable data only
 * stderr  → human messages, errors, hints
 * --json  → raw JSON output
 */

import { Command, Option } from 'commander';
import { readFileSync } from 'fs';
import { OFCClient, loadSession, promptPassword, readPasswordStdin } from './ofc-client.js';
import {
  info, success, error, warn, hint,
  table, keyValue, json,
  setJsonMode, isJsonMode,
} from './ofc-output.js';

const VERSION = '1.0.0';

// ── Root program ────────────────────────────────────────────────────

const program = new Command();

program
  .name('ofc')
  .description('OpenFederation CLI — manage your PDS from the command line')
  .version(VERSION, '-V, --version')
  .option('-s, --server <url>', 'PDS server URL', process.env.PDS_SERVICE_URL || 'http://localhost:8080')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .addOption(new Option('--json', 'Output raw JSON to stdout').default(false))
  .addOption(new Option('--no-color', 'Disable ANSI colors'))
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    setJsonMode(opts.json === true);
  });

/** Create a client from root options. */
function client(): OFCClient {
  const opts = program.opts();
  return new OFCClient(opts.server, Number(opts.timeout));
}

/** Wrap an async action with error handling. */
function run(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  };
}

// ── ofc auth ────────────────────────────────────────────────────────

const auth = program.command('auth').description('Authentication');

auth
  .command('login')
  .description('Log in to a PDS server')
  .requiredOption('-u, --user <handle>', 'Handle or email')
  .option('--password-stdin', 'Read password from stdin')
  .action(run(async () => {
    const opts = auth.commands.find(c => c.name() === 'login')!.opts();
    const c = client();

    let password: string;
    if (opts.passwordStdin) {
      password = await readPasswordStdin();
    } else {
      password = await promptPassword();
    }

    const session = await c.login(opts.user, password);
    if (isJsonMode()) {
      json({ did: session.did, handle: session.handle });
    } else {
      success(`Logged in as ${session.handle} (${session.did})`);
      hint('Session stored in ~/.config/ofc/session.json');
    }
  }));

auth
  .command('logout')
  .description('Log out and clear stored session')
  .action(run(async () => {
    const c = client();
    await c.logout();
    if (isJsonMode()) {
      json({ ok: true });
    } else {
      success('Logged out');
    }
  }));

auth
  .command('whoami')
  .description('Show current logged-in user')
  .action(run(async () => {
    const c = client();
    const result = await c.authGet('com.atproto.server.getSession');
    if (isJsonMode()) {
      json(result);
    } else {
      keyValue([
        ['Handle', result.handle],
        ['DID', result.did],
        ['Email', result.email || '—'],
        ['Roles', (result.roles || []).join(', ') || 'user'],
      ]);
    }
  }));

// ── ofc server ──────────────────────────────────────────────────────

const server = program.command('server').description('Server status');

server
  .command('health')
  .description('Check server health')
  .action(run(async () => {
    const c = client();
    const result = await c.healthCheck();
    if (isJsonMode()) {
      json(result);
    } else {
      if (result.status === 'ok') {
        success('Server is healthy');
      } else {
        warn(`Server status: ${result.status}`);
      }
      keyValue([
        ['Status', result.status],
        ['Database', result.database],
        ['Timestamp', result.timestamp],
      ]);
    }
  }));

server
  .command('info')
  .description('Get server configuration and stats (admin)')
  .action(run(async () => {
    const c = client();
    const result = await c.authGet('net.openfederation.server.getConfig');
    if (isJsonMode()) {
      json(result);
    } else {
      keyValue([
        ['Version', result.version || '—'],
        ['Users', String(result.totalUsers ?? '—')],
        ['Communities', String(result.totalCommunities ?? '—')],
        ['Invites', String(result.totalInvites ?? '—')],
      ]);
    }
  }));

// ── ofc account ─────────────────────────────────────────────────────

const account = program.command('account').description('Account management');

account
  .command('list')
  .description('List all accounts (admin/mod)')
  .option('--status <status>', 'Filter by status (pending, approved, rejected, disabled)')
  .option('--search <query>', 'Search by handle or email')
  .option('--role <role>', 'Filter by role')
  .option('--limit <n>', 'Max results')
  .option('--offset <n>', 'Offset for pagination')
  .action(run(async () => {
    const cmd = account.commands.find(c => c.name() === 'list')!;
    const opts = cmd.opts();
    const params: Record<string, string> = {};
    if (opts.status) params.status = opts.status;
    if (opts.search) params.search = opts.search;
    if (opts.role) params.role = opts.role;
    if (opts.limit) params.limit = opts.limit;
    if (opts.offset) params.offset = opts.offset;

    const c = client();
    const result = await c.authGet('net.openfederation.account.list', params);
    if (isJsonMode()) {
      json(result);
    } else {
      const users = result.users || [];
      if (users.length === 0) {
        info('No accounts found');
        return;
      }
      table(
        ['Handle', 'Email', 'Status', 'Roles', 'Created'],
        users.map((u: any) => [
          u.handle,
          u.email || '—',
          u.status,
          (u.roles || []).join(', ') || 'user',
          u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—',
        ]),
      );
    }
  }));

account
  .command('list-pending')
  .description('List pending registrations (admin/mod)')
  .action(run(async () => {
    const c = client();
    const result = await c.authGet('net.openfederation.account.listPending');
    if (isJsonMode()) {
      json(result);
    } else {
      const users = result.users || [];
      if (users.length === 0) {
        info('No pending users');
        return;
      }
      success(`${users.length} pending user(s)`);
      table(
        ['Handle', 'Email', 'Registered'],
        users.map((u: any) => [
          u.handle,
          u.email || '—',
          u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—',
        ]),
      );
    }
  }));

account
  .command('approve')
  .description('Approve a pending user (admin/mod)')
  .argument('<handle>', 'Handle of the user to approve')
  .action(run(async () => {
    const cmd = account.commands.find(c => c.name() === 'approve')!;
    const handle = cmd.args[0];
    const c = client();
    await c.authPost('net.openfederation.account.approve', { handle });
    if (isJsonMode()) {
      json({ ok: true, handle });
    } else {
      success(`User "${handle}" approved`);
    }
  }));

account
  .command('reject')
  .description('Reject a pending user (admin/mod)')
  .argument('<handle>', 'Handle of the user to reject')
  .action(run(async () => {
    const cmd = account.commands.find(c => c.name() === 'reject')!;
    const handle = cmd.args[0];
    const c = client();
    await c.authPost('net.openfederation.account.reject', { handle });
    if (isJsonMode()) {
      json({ ok: true, handle });
    } else {
      success(`User "${handle}" rejected`);
    }
  }));

// ── ofc invite ──────────────────────────────────────────────────────

const invite = program.command('invite').description('Invite code management');

invite
  .command('create')
  .description('Create an invite code (admin/mod)')
  .option('--max-uses <n>', 'Maximum uses', '1')
  .option('--expires <date>', 'Expiration date (ISO 8601)')
  .action(run(async () => {
    const cmd = invite.commands.find(c => c.name() === 'create')!;
    const opts = cmd.opts();
    const body: Record<string, any> = { maxUses: parseInt(opts.maxUses, 10) };
    if (opts.expires) body.expiresAt = opts.expires;

    const c = client();
    const result = await c.authPost('net.openfederation.invite.create', body);
    if (isJsonMode()) {
      json(result);
    } else {
      success('Invite code created');
      keyValue([
        ['Code', result.code],
        ['Max uses', String(result.maxUses)],
        ...(result.expiresAt ? [['Expires', result.expiresAt] as [string, string]] : []),
      ]);
    }
  }));

invite
  .command('list')
  .description('List invite codes (admin/mod)')
  .option('--status <status>', 'Filter: used, unused, expired')
  .action(run(async () => {
    const cmd = invite.commands.find(c => c.name() === 'list')!;
    const opts = cmd.opts();
    const params: Record<string, string> = {};
    if (opts.status) params.status = opts.status;

    const c = client();
    const result = await c.authGet('net.openfederation.invite.list', params);
    if (isJsonMode()) {
      json(result);
    } else {
      const invites = result.invites || [];
      if (invites.length === 0) {
        info('No invite codes found');
        return;
      }
      table(
        ['Code', 'Max Uses', 'Used', 'Created By', 'Expires'],
        invites.map((inv: any) => [
          inv.code,
          String(inv.maxUses ?? '—'),
          String(inv.useCount ?? '—'),
          inv.createdBy || '—',
          inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : 'never',
        ]),
      );
    }
  }));

// ── ofc community ───────────────────────────────────────────────────

const community = program.command('community').description('Community management');

community
  .command('create')
  .description('Create a new community')
  .requiredOption('-n, --handle <handle>', 'Community handle')
  .requiredOption('-d, --display-name <name>', 'Display name')
  .option('-m, --did-method <method>', 'DID method: plc or web', 'plc')
  .option('--domain <domain>', 'Domain name (required for did:web)')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'create')!;
    const opts = cmd.opts();

    if (!['plc', 'web'].includes(opts.didMethod)) {
      throw new Error('Invalid DID method. Must be "plc" or "web"');
    }
    if (opts.didMethod === 'web' && !opts.domain) {
      throw new Error('--domain is required when using did:web method');
    }

    const body: Record<string, any> = {
      handle: opts.handle,
      displayName: opts.displayName,
      didMethod: opts.didMethod,
    };
    if (opts.domain) body.domain = opts.domain;

    const c = client();
    const result = await c.authPost('net.openfederation.community.create', body);
    if (isJsonMode()) {
      json(result);
    } else {
      success('Community created');
      keyValue([
        ['DID', result.did],
        ['Handle', result.handle],
      ]);
      if (result.primaryRotationKey) {
        warn('Save your primary rotation key! This is the only time you will see it.');
        process.stdout.write(`\nPrimary Rotation Key:\n${result.primaryRotationKey}\n`);
      }
      if (result.instructions) {
        hint(result.instructions);
      }
    }
  }));

community
  .command('get')
  .description('Get community details')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'get')!;
    const did = cmd.args[0];
    const c = client();
    // Try authenticated first (for membership info), fall back to unauthenticated
    let result: any;
    try {
      result = await c.authGet('net.openfederation.community.get', { did });
    } catch {
      result = await c.get('net.openfederation.community.get', { did });
    }
    if (isJsonMode()) {
      json(result);
    } else {
      keyValue([
        ['DID', result.did || did],
        ['Handle', result.handle || '—'],
        ['Display Name', result.displayName || '—'],
        ['Description', result.description || '—'],
        ['Join Policy', result.joinPolicy || '—'],
        ['Members', String(result.memberCount ?? '—')],
        ['Status', result.status || '—'],
        ...(result.isMember !== undefined ? [['Member', result.isMember ? 'yes' : 'no'] as [string, string]] : []),
      ]);
    }
  }));

community
  .command('list')
  .description('List public communities')
  .option('--mode <mode>', 'Listing mode (all = include hidden, admin only)')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'list')!;
    const opts = cmd.opts();
    const params: Record<string, string> = {};
    if (opts.mode) params.mode = opts.mode;

    const c = client();
    const result = await c.authGet('net.openfederation.community.listAll', params);
    if (isJsonMode()) {
      json(result);
    } else {
      const communities = result.communities || [];
      if (communities.length === 0) {
        info('No communities found');
        return;
      }
      table(
        ['Handle', 'Display Name', 'DID', 'Members', 'Join Policy'],
        communities.map((cm: any) => [
          cm.handle,
          cm.displayName || '—',
          cm.did,
          String(cm.memberCount ?? '—'),
          cm.joinPolicy || '—',
        ]),
      );
    }
  }));

community
  .command('list-mine')
  .description('List communities you belong to')
  .action(run(async () => {
    const c = client();
    const result = await c.authGet('net.openfederation.community.listMine');
    if (isJsonMode()) {
      json(result);
    } else {
      const communities = result.communities || [];
      if (communities.length === 0) {
        info('You are not a member of any communities');
        return;
      }
      table(
        ['Handle', 'Display Name', 'DID', 'Role'],
        communities.map((cm: any) => [
          cm.handle,
          cm.displayName || '—',
          cm.did,
          cm.role || '—',
        ]),
      );
    }
  }));

community
  .command('update')
  .description('Update community settings (owner)')
  .argument('<did>', 'Community DID')
  .option('--display-name <name>', 'New display name')
  .option('--description <text>', 'New description')
  .option('--join-policy <policy>', 'New join policy (open, approval, invite, closed)')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'update')!;
    const did = cmd.args[0];
    const opts = cmd.opts();

    const body: Record<string, any> = { did };
    if (opts.displayName !== undefined) body.displayName = opts.displayName;
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.joinPolicy !== undefined) body.joinPolicy = opts.joinPolicy;

    const c = client();
    await c.authPost('net.openfederation.community.update', body);
    if (isJsonMode()) {
      json({ ok: true, did });
    } else {
      success('Community updated');
    }
  }));

community
  .command('join')
  .description('Join a community (or request to join)')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'join')!;
    const did = cmd.args[0];
    const c = client();
    const result = await c.authPost('net.openfederation.community.join', { did });
    if (isJsonMode()) {
      json(result);
    } else {
      if (result.status === 'pending') {
        info('Join request submitted (awaiting approval)');
      } else {
        success('Joined community');
      }
    }
  }));

community
  .command('leave')
  .description('Leave a community')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'leave')!;
    const did = cmd.args[0];
    const c = client();
    await c.authPost('net.openfederation.community.leave', { did });
    if (isJsonMode()) {
      json({ ok: true, did });
    } else {
      success('Left community');
    }
  }));

community
  .command('members')
  .description('List community members')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'members')!;
    const did = cmd.args[0];
    const c = client();
    const result = await c.authGet('net.openfederation.community.listMembers', { did });
    if (isJsonMode()) {
      json(result);
    } else {
      const members = result.members || [];
      if (members.length === 0) {
        info('No members');
        return;
      }
      table(
        ['Handle', 'DID', 'Role', 'Joined'],
        members.map((m: any) => [
          m.handle || '—',
          m.did || '—',
          m.role || 'member',
          m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—',
        ]),
      );
    }
  }));

community
  .command('join-requests')
  .description('List pending join requests (owner/admin)')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'join-requests')!;
    const did = cmd.args[0];
    const c = client();
    const result = await c.authGet('net.openfederation.community.listJoinRequests', { did });
    if (isJsonMode()) {
      json(result);
    } else {
      const requests = result.requests || [];
      if (requests.length === 0) {
        info('No pending join requests');
        return;
      }
      table(
        ['Handle', 'DID', 'Requested'],
        requests.map((r: any) => [
          r.handle || '—',
          r.did || '—',
          r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—',
        ]),
      );
    }
  }));

community
  .command('resolve-request')
  .description('Approve or reject a join request (owner/admin)')
  .argument('<did>', 'Community DID')
  .requiredOption('--user <handle>', 'Handle of the requesting user')
  .requiredOption('--action <action>', 'Action: approve or reject')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'resolve-request')!;
    const did = cmd.args[0];
    const opts = cmd.opts();

    if (!['approve', 'reject'].includes(opts.action)) {
      throw new Error('--action must be "approve" or "reject"');
    }

    const c = client();
    await c.authPost('net.openfederation.community.resolveJoinRequest', {
      did,
      handle: opts.user,
      action: opts.action,
    });
    if (isJsonMode()) {
      json({ ok: true, did, handle: opts.user, action: opts.action });
    } else {
      success(`Join request ${opts.action === 'approve' ? 'approved' : 'rejected'} for "${opts.user}"`);
    }
  }));

community
  .command('remove-member')
  .description('Remove a member from a community (owner/admin)')
  .argument('<did>', 'Community DID')
  .requiredOption('--user <handle>', 'Handle of the member to remove')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'remove-member')!;
    const did = cmd.args[0];
    const opts = cmd.opts();
    const c = client();
    await c.authPost('net.openfederation.community.removeMember', { did, handle: opts.user });
    if (isJsonMode()) {
      json({ ok: true, did, handle: opts.user });
    } else {
      success(`Member "${opts.user}" removed`);
    }
  }));

community
  .command('delete')
  .description('Delete a community and all its data (owner/admin)')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'delete')!;
    const did = cmd.args[0];
    const c = client();
    await c.authPost('net.openfederation.community.delete', { did });
    if (isJsonMode()) {
      json({ ok: true, did });
    } else {
      success('Community deleted');
    }
  }));

community
  .command('export')
  .description('Export community data as JSON archive (owner/admin)')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'export')!;
    const did = cmd.args[0];
    const c = client();
    const result = await c.authGet('net.openfederation.community.export', { did });
    // Export always outputs JSON (it's an archive)
    json(result);
    if (!isJsonMode()) {
      success('Community exported');
    }
  }));

community
  .command('suspend')
  .description('Suspend a community (PDS admin)')
  .argument('<did>', 'Community DID')
  .option('--reason <text>', 'Reason for suspension')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'suspend')!;
    const did = cmd.args[0];
    const opts = cmd.opts();
    const body: Record<string, any> = { did };
    if (opts.reason) body.reason = opts.reason;

    const c = client();
    await c.authPost('net.openfederation.community.suspend', body);
    if (isJsonMode()) {
      json({ ok: true, did });
    } else {
      success('Community suspended');
    }
  }));

community
  .command('unsuspend')
  .description('Lift a community suspension (PDS admin)')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'unsuspend')!;
    const did = cmd.args[0];
    const c = client();
    await c.authPost('net.openfederation.community.unsuspend', { did });
    if (isJsonMode()) {
      json({ ok: true, did });
    } else {
      success('Community unsuspended');
    }
  }));

community
  .command('takedown')
  .description('Take down a community (PDS admin, requires prior export)')
  .argument('<did>', 'Community DID')
  .option('--reason <text>', 'Reason for takedown')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'takedown')!;
    const did = cmd.args[0];
    const opts = cmd.opts();
    const body: Record<string, any> = { did };
    if (opts.reason) body.reason = opts.reason;

    const c = client();
    await c.authPost('net.openfederation.community.takedown', body);
    if (isJsonMode()) {
      json({ ok: true, did });
    } else {
      success('Community taken down');
    }
  }));

community
  .command('transfer')
  .description('Generate transfer package for migration (owner)')
  .argument('<did>', 'Community DID')
  .action(run(async () => {
    const cmd = community.commands.find(c => c.name() === 'transfer')!;
    const did = cmd.args[0];
    const c = client();
    const result = await c.authPost('net.openfederation.community.transfer', { did });
    // Transfer package is always JSON
    json(result);
    if (!isJsonMode()) {
      success('Transfer package generated');
      hint('Follow the instructions in the output to complete the migration.');
    }
  }));

// ── ofc record ──────────────────────────────────────────────────────

const record = program.command('record').description('Repository records');

record
  .command('get')
  .description('Fetch a record from a repository')
  .requiredOption('-r, --repo <did>', 'Repository DID')
  .requiredOption('-c, --collection <nsid>', 'Collection NSID')
  .requiredOption('-k, --rkey <rkey>', 'Record key')
  .action(run(async () => {
    const cmd = record.commands.find(c => c.name() === 'get')!;
    const opts = cmd.opts();
    const c = client();
    const result = await c.get('com.atproto.repo.getRecord', {
      repo: opts.repo,
      collection: opts.collection,
      rkey: opts.rkey,
    });
    json(result);
  }));

record
  .command('put')
  .description('Write a record (creates or updates)')
  .requiredOption('-r, --repo <did>', 'Repository DID')
  .requiredOption('-c, --collection <nsid>', 'Collection NSID')
  .requiredOption('-k, --rkey <rkey>', 'Record key')
  .requiredOption('--data <json>', 'Record data as JSON string or @filename')
  .action(run(async () => {
    const cmd = record.commands.find(c => c.name() === 'put')!;
    const opts = cmd.opts();

    const recordData = parseDataArg(opts.data);
    const c = client();
    const result = await c.authPost('com.atproto.repo.putRecord', {
      repo: opts.repo,
      collection: opts.collection,
      rkey: opts.rkey,
      record: recordData,
    });
    if (isJsonMode()) {
      json(result);
    } else {
      success('Record written');
      keyValue([['URI', result.uri || '—'], ['CID', result.cid || '—']]);
    }
  }));

record
  .command('create')
  .description('Create a record with auto-generated key')
  .requiredOption('-r, --repo <did>', 'Repository DID')
  .requiredOption('-c, --collection <nsid>', 'Collection NSID')
  .requiredOption('--data <json>', 'Record data as JSON string or @filename')
  .action(run(async () => {
    const cmd = record.commands.find(c => c.name() === 'create')!;
    const opts = cmd.opts();

    const recordData = parseDataArg(opts.data);
    const c = client();
    const result = await c.authPost('com.atproto.repo.createRecord', {
      repo: opts.repo,
      collection: opts.collection,
      record: recordData,
    });
    if (isJsonMode()) {
      json(result);
    } else {
      success('Record created');
      keyValue([['URI', result.uri || '—'], ['CID', result.cid || '—']]);
    }
  }));

record
  .command('delete')
  .description('Delete a record')
  .requiredOption('-r, --repo <did>', 'Repository DID')
  .requiredOption('-c, --collection <nsid>', 'Collection NSID')
  .requiredOption('-k, --rkey <rkey>', 'Record key')
  .action(run(async () => {
    const cmd = record.commands.find(c => c.name() === 'delete')!;
    const opts = cmd.opts();
    const c = client();
    await c.authPost('com.atproto.repo.deleteRecord', {
      repo: opts.repo,
      collection: opts.collection,
      rkey: opts.rkey,
    });
    if (isJsonMode()) {
      json({ ok: true });
    } else {
      success('Record deleted');
    }
  }));

record
  .command('list')
  .description('List records in a collection')
  .requiredOption('-r, --repo <did>', 'Repository DID')
  .requiredOption('-c, --collection <nsid>', 'Collection NSID')
  .option('--limit <n>', 'Max results')
  .option('--cursor <cursor>', 'Pagination cursor')
  .action(run(async () => {
    const cmd = record.commands.find(c => c.name() === 'list')!;
    const opts = cmd.opts();
    const params: Record<string, string> = {
      repo: opts.repo,
      collection: opts.collection,
    };
    if (opts.limit) params.limit = opts.limit;
    if (opts.cursor) params.cursor = opts.cursor;

    const c = client();
    const result = await c.get('com.atproto.repo.listRecords', params);
    if (isJsonMode()) {
      json(result);
    } else {
      const records = result.records || [];
      if (records.length === 0) {
        info('No records found');
        return;
      }
      table(
        ['URI', 'CID'],
        records.map((r: any) => [r.uri || '—', r.cid || '—']),
      );
      if (result.cursor) {
        hint(`More results available. Use --cursor ${result.cursor}`);
      }
    }
  }));

// ── ofc repo ────────────────────────────────────────────────────────

const repo = program.command('repo').description('Repository operations');

repo
  .command('describe')
  .description('Get repository metadata and collections')
  .argument('<did>', 'Repository DID')
  .action(run(async () => {
    const cmd = repo.commands.find(c => c.name() === 'describe')!;
    const did = cmd.args[0];
    const c = client();
    const result = await c.get('com.atproto.repo.describeRepo', { repo: did });
    if (isJsonMode()) {
      json(result);
    } else {
      keyValue([
        ['DID', result.did || did],
        ['Handle', result.handle || '—'],
        ['Collections', (result.collections || []).join(', ') || '—'],
      ]);
    }
  }));

// ── ofc audit ───────────────────────────────────────────────────────

const audit = program.command('audit').description('Audit log');

audit
  .command('list')
  .description('List audit log entries (admin)')
  .option('--action <type>', 'Filter by action type')
  .option('--actor <did>', 'Filter by actor DID')
  .option('--target <did>', 'Filter by target DID')
  .option('--limit <n>', 'Max results')
  .option('--offset <n>', 'Offset for pagination')
  .action(run(async () => {
    const cmd = audit.commands.find(c => c.name() === 'list')!;
    const opts = cmd.opts();
    const params: Record<string, string> = {};
    if (opts.action) params.action = opts.action;
    if (opts.actor) params.actor = opts.actor;
    if (opts.target) params.target = opts.target;
    if (opts.limit) params.limit = opts.limit;
    if (opts.offset) params.offset = opts.offset;

    const c = client();
    const result = await c.authGet('net.openfederation.audit.list', params);
    if (isJsonMode()) {
      json(result);
    } else {
      const entries = result.entries || [];
      if (entries.length === 0) {
        info('No audit log entries found');
        return;
      }
      table(
        ['Timestamp', 'Action', 'Actor', 'Target', 'Details'],
        entries.map((e: any) => [
          e.timestamp ? new Date(e.timestamp).toLocaleString() : '—',
          e.action || '—',
          e.actorDid || e.actor || '—',
          e.targetDid || e.target || '—',
          e.details ? JSON.stringify(e.details).slice(0, 60) : '—',
        ]),
      );
    }
  }));

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse --data argument: inline JSON or @filename. */
function parseDataArg(data: string): any {
  if (data.startsWith('@')) {
    const filename = data.slice(1);
    try {
      return JSON.parse(readFileSync(filename, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to read data file "${filename}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('Invalid JSON in --data. Use a JSON string or @filename to read from a file.');
  }
}

// ── Parse & execute ─────────────────────────────────────────────────

program.parse();
