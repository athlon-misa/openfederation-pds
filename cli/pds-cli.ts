#!/usr/bin/env node
/**
 * OpenFederation PDS CLI Tool
 * Command-line interface for interacting with the OpenFederation Personal Data Server
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as dotenv from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const program = new Command();

// Default server URL (can be overridden with --server flag)
const DEFAULT_SERVER = process.env.PDS_SERVICE_URL || 'http://localhost:3000';

// Default request timeout (30 seconds)
const DEFAULT_TIMEOUT_MS = 30_000;

// Token storage path (in project root .pds-cli directory)
const __filename_cli = fileURLToPath(import.meta.url);
const __dirname_cli = dirname(__filename_cli);
const TOKEN_DIR = join(__dirname_cli, '..', '.pds-cli');
const TOKEN_FILE = join(TOKEN_DIR, 'session.json');

interface StoredSession {
  serverUrl: string;
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

// Token storage helpers
function loadSession(serverUrl: string): StoredSession | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
    if (data.serverUrl === serverUrl) return data as StoredSession;
    return null;
  } catch {
    return null;
  }
}

function saveSession(session: StoredSession): void {
  if (!existsSync(TOKEN_DIR)) {
    mkdirSync(TOKEN_DIR, { recursive: true });
  }
  writeFileSync(TOKEN_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

function clearSession(): void {
  try {
    if (existsSync(TOKEN_FILE)) {
      writeFileSync(TOKEN_FILE, '', { mode: 0o600 });
    }
  } catch {
    // ignore
  }
}

// Helper function to make XRPC requests with timeout and auth
async function xrpcRequest(
  nsid: string,
  params: Record<string, any> = {},
  method: 'GET' | 'POST' = 'POST',
  serverUrl: string = DEFAULT_SERVER,
  options?: { auth?: boolean; timeoutMs?: number }
): Promise<any> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const useAuth = options?.auth ?? false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`/xrpc/${nsid}`, serverUrl);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (useAuth) {
      const session = loadSession(serverUrl);
      if (!session) {
        throw new Error('Not logged in. Run "login" first.');
      }
      headers['Authorization'] = `Bearer ${session.accessJwt}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (method === 'GET') {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    } else {
      fetchOptions.body = JSON.stringify(params);
    }

    const response = await fetch(url.toString(), fetchOptions);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    if (error instanceof Error) {
      throw new Error(`XRPC request failed: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Helper function to format JSON output
function printJson(data: any) {
  console.log(JSON.stringify(data, null, 2));
}

// Helper function to print success messages
function printSuccess(message: string) {
  console.log(chalk.green('OK'), message);
}

// Helper function to print error messages
function printError(message: string) {
  console.error(chalk.red('ERROR'), message);
}

// Helper function to print info messages
function printInfo(message: string) {
  console.log(chalk.blue('INFO'), message);
}

// Configure the CLI
program
  .name('pds-cli')
  .description('OpenFederation PDS Command Line Interface')
  .version('1.0.0')
  .option('-s, --server <url>', 'PDS server URL', DEFAULT_SERVER)
  .option('--timeout <ms>', 'Request timeout in milliseconds', String(DEFAULT_TIMEOUT_MS));

// Command: health
program
  .command('health')
  .description('Check server health status')
  .action(async () => {
    const serverUrl = program.opts().server;
    const timeoutMs = Number(program.opts().timeout);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      printInfo(`Checking health of ${serverUrl}...`);
      const response = await fetch(`${serverUrl}/health`, { signal: controller.signal });
      const data = await response.json();

      if (response.ok && data.status === 'ok') {
        printSuccess('Server is healthy');
        printJson(data);
      } else {
        printError('Server health check failed');
        printJson(data);
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        printError(`Request timed out after ${timeoutMs / 1000}s`);
      } else {
        printError(`Failed to connect to server: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      process.exit(1);
    } finally {
      clearTimeout(timeout);
    }
  });

// Command: login
program
  .command('login')
  .description('Log in and store session credentials')
  .requiredOption('-u, --identifier <handle-or-email>', 'Handle or email')
  .requiredOption('-p, --password <password>', 'Password')
  .action(async (options) => {
    const serverUrl = program.opts().server;

    try {
      printInfo(`Logging in to ${serverUrl}...`);

      const result = await xrpcRequest(
        'com.atproto.server.createSession',
        { identifier: options.identifier, password: options.password },
        'POST',
        serverUrl,
        { auth: false, timeoutMs: Number(program.opts().timeout) }
      );

      saveSession({
        serverUrl,
        accessJwt: result.accessJwt,
        refreshJwt: result.refreshJwt,
        did: result.did,
        handle: result.handle,
      });

      printSuccess(`Logged in as ${result.handle} (${result.did})`);
    } catch (error) {
      printError(`Login failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Command: logout
program
  .command('logout')
  .description('Log out and clear stored session')
  .action(async () => {
    const serverUrl = program.opts().server;
    const session = loadSession(serverUrl);

    if (session) {
      try {
        await xrpcRequest(
          'com.atproto.server.deleteSession',
          { refreshJwt: session.refreshJwt },
          'POST',
          serverUrl,
          { auth: true, timeoutMs: Number(program.opts().timeout) }
        );
      } catch {
        // Ignore server-side errors during logout; clear local session regardless
      }
    }

    clearSession();
    printSuccess('Logged out');
  });

// Command: whoami
program
  .command('whoami')
  .description('Show current logged-in user')
  .action(async () => {
    const serverUrl = program.opts().server;
    const session = loadSession(serverUrl);

    if (!session) {
      printInfo('Not logged in');
      return;
    }

    try {
      const result = await xrpcRequest(
        'com.atproto.server.getSession',
        {},
        'GET',
        serverUrl,
        { auth: true, timeoutMs: Number(program.opts().timeout) }
      );

      printSuccess(`Logged in as ${result.handle}`);
      console.log(chalk.cyan('DID:'), result.did);
      console.log(chalk.cyan('Email:'), result.email);
      console.log(chalk.cyan('Roles:'), (result.roles || []).join(', ') || 'user');
    } catch (error) {
      printError(`Session may be expired. Try logging in again.`);
      clearSession();
      process.exit(1);
    }
  });

// Command: create-community
program
  .command('create-community')
  .description('Create a new community (requires login)')
  .requiredOption('-n, --handle <handle>', 'Community handle (e.g., my-community)')
  .requiredOption('-d, --display-name <name>', 'Display name for the community')
  .option('-m, --did-method <method>', 'DID method: plc or web', 'plc')
  .option('--domain <domain>', 'Domain name (required for did:web method)')
  .action(async (options) => {
    const serverUrl = program.opts().server;

    try {
      // Validate did-method
      if (!['plc', 'web'].includes(options.didMethod)) {
        printError('Invalid DID method. Must be "plc" or "web"');
        process.exit(1);
      }

      // Validate domain for did:web
      if (options.didMethod === 'web' && !options.domain) {
        printError('--domain is required when using did:web method');
        process.exit(1);
      }

      printInfo(`Creating community "${options.displayName}" with handle "${options.handle}"...`);

      const params: any = {
        handle: options.handle,
        displayName: options.displayName,
        didMethod: options.didMethod,
      };

      if (options.domain) {
        params.domain = options.domain;
      }

      const result = await xrpcRequest(
        'net.openfederation.community.create',
        params,
        'POST',
        serverUrl,
        { auth: true, timeoutMs: Number(program.opts().timeout) }
      );

      printSuccess('Community created successfully!');
      console.log('');
      console.log(chalk.bold('Community Details:'));
      console.log(chalk.cyan('DID:'), result.did);
      console.log(chalk.cyan('Handle:'), result.handle);

      if (result.primaryRotationKey) {
        console.log('');
        console.log(chalk.yellow.bold('WARNING: Save your primary rotation key!'));
        console.log(chalk.yellow('This is the only time you will see it.'));
        console.log('');
        console.log(chalk.cyan('Primary Rotation Key:'));
        console.log(result.primaryRotationKey);
      }

      if (result.didDocument) {
        console.log('');
        console.log(chalk.cyan('DID Document:'));
        printJson(result.didDocument);
      }

      if (result.instructions) {
        console.log('');
        console.log(chalk.yellow('Setup Instructions:'));
        console.log(result.instructions);
      }
    } catch (error) {
      printError(`Failed to create community: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Command: get-record
program
  .command('get-record')
  .description('Fetch a record from a repository')
  .requiredOption('-r, --repo <did>', 'Repository DID')
  .requiredOption('-c, --collection <nsid>', 'Collection NSID (e.g., net.openfederation.community.profile)')
  .requiredOption('-k, --rkey <rkey>', 'Record key (e.g., self)')
  .action(async (options) => {
    const serverUrl = program.opts().server;

    try {
      printInfo(`Fetching record from ${options.repo}...`);

      const result = await xrpcRequest(
        'com.atproto.repo.getRecord',
        {
          repo: options.repo,
          collection: options.collection,
          rkey: options.rkey,
        },
        'GET',
        serverUrl,
        { auth: false, timeoutMs: Number(program.opts().timeout) }
      );

      printSuccess('Record retrieved successfully!');
      console.log('');
      printJson(result);
    } catch (error) {
      printError(`Failed to fetch record: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Command: info
program
  .command('info')
  .description('Get server information')
  .action(async () => {
    const serverUrl = program.opts().server;
    const timeoutMs = Number(program.opts().timeout);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      printInfo(`Fetching server info from ${serverUrl}...`);
      const response = await fetch(serverUrl, { signal: controller.signal });
      const data = await response.json();

      printSuccess('Server information:');
      console.log('');
      printJson(data);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        printError(`Request timed out after ${timeoutMs / 1000}s`);
      } else {
        printError(`Failed to fetch server info: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      process.exit(1);
    } finally {
      clearTimeout(timeout);
    }
  });

// Command: create-invite
program
  .command('create-invite')
  .description('Create an invite code (admin/moderator only)')
  .option('--max-uses <number>', 'Maximum number of uses', '1')
  .option('--expires <date>', 'Expiration date (ISO 8601)')
  .action(async (options) => {
    const serverUrl = program.opts().server;

    try {
      const params: Record<string, any> = {
        maxUses: parseInt(options.maxUses, 10),
      };

      if (options.expires) {
        params.expiresAt = options.expires;
      }

      printInfo('Creating invite code...');

      const result = await xrpcRequest(
        'net.openfederation.invite.create',
        params,
        'POST',
        serverUrl,
        { auth: true, timeoutMs: Number(program.opts().timeout) }
      );

      printSuccess('Invite code created');
      console.log(chalk.cyan('Code:'), result.code);
      console.log(chalk.cyan('Max uses:'), result.maxUses);
      if (result.expiresAt) {
        console.log(chalk.cyan('Expires:'), result.expiresAt);
      }
    } catch (error) {
      printError(`Failed to create invite: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Command: list-pending
program
  .command('list-pending')
  .description('List pending user registrations (admin/moderator only)')
  .action(async () => {
    const serverUrl = program.opts().server;

    try {
      printInfo('Fetching pending users...');

      const result = await xrpcRequest(
        'net.openfederation.account.listPending',
        {},
        'GET',
        serverUrl,
        { auth: true, timeoutMs: Number(program.opts().timeout) }
      );

      if (!result.users || result.users.length === 0) {
        printInfo('No pending users');
        return;
      }

      printSuccess(`${result.users.length} pending user(s)`);
      for (const user of result.users) {
        console.log(`  ${chalk.cyan(user.handle)} (${user.email}) - registered ${user.createdAt || 'unknown'}`);
      }
    } catch (error) {
      printError(`Failed to list pending users: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Command: approve-user
program
  .command('approve-user')
  .description('Approve a pending user (admin/moderator only)')
  .requiredOption('-h, --handle <handle>', 'Handle of the user to approve')
  .action(async (options) => {
    const serverUrl = program.opts().server;

    try {
      printInfo(`Approving user "${options.handle}"...`);

      await xrpcRequest(
        'net.openfederation.account.approve',
        { handle: options.handle },
        'POST',
        serverUrl,
        { auth: true, timeoutMs: Number(program.opts().timeout) }
      );

      printSuccess(`User "${options.handle}" approved`);
    } catch (error) {
      printError(`Failed to approve user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Command: reject-user
program
  .command('reject-user')
  .description('Reject a pending user (admin/moderator only)')
  .requiredOption('-h, --handle <handle>', 'Handle of the user to reject')
  .action(async (options) => {
    const serverUrl = program.opts().server;

    try {
      printInfo(`Rejecting user "${options.handle}"...`);

      await xrpcRequest(
        'net.openfederation.account.reject',
        { handle: options.handle },
        'POST',
        serverUrl,
        { auth: true, timeoutMs: Number(program.opts().timeout) }
      );

      printSuccess(`User "${options.handle}" rejected`);
    } catch (error) {
      printError(`Failed to reject user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Parse arguments and execute
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
