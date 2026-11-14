# Install on a rented server (any provider)

This guide puts an OpenFederation server on a small rented Linux server (a "VPS") from any provider. You need about 30 minutes, a domain name you can add DNS records to, and a computer with a terminal (Terminal on a Mac, PowerShell on Windows).

There are shorter notes for particular providers: [netcup](netcup.md) (the cheapest we found), [Hetzner](hetzner.md), [OVHcloud](ovhcloud.md), [IONOS](ionos.md), [Contabo](contabo.md), [DigitalOcean](digitalocean.md). Prices are compared in [HOSTING-COMPARISON.md](../HOSTING-COMPARISON.md).

## What you get

One server running four programs, each in its own container:

- **the PDS**: your OpenFederation server (accounts, communities, the setup page);
- **the database** (PostgreSQL 15);
- **the dashboard**: the web page where you and your members manage things;
- **Caddy**: puts everything on HTTPS and renews the certificates by itself.

Everything that must be kept (database, uploaded pictures, the server's settings and keys, certificates) lives in one folder: `/opt/openfederation/data`.

## 1. Choose and order a server

Pick a plan with:

- **2 GB of memory or more** (4 GB is more comfortable);
- **30 GB of disk or more**, SSD or NVMe;
- **64-bit**: x86-64 (Intel/AMD) or ARM64 both work;
- **Debian 12** or **Ubuntu 24.04 / 22.04** as the system (the installer sets up the rest on these; other Linux systems need Docker installed first);
- a **public IPv4 address** (most plans include one).

When the provider asks how you want to log in, add your **SSH key** if you have one (safer than a password); otherwise note the root password it gives you.

## 2. Point your addresses at the server

Your server needs two names, for example:

| Name | What it is |
|---|---|
| `pds.example.org` | the PDS (and its setup page) |
| `dashboard.example.org` | the dashboard |

Where you manage your domain (your registrar or DNS provider), add these records, using the IP address from your provider's control panel:

| Type | Name | Value |
|---|---|---|
| A | `pds` | your server's IPv4 address |
| A | `dashboard` | your server's IPv4 address |
| A | `*` | your server's IPv4 address (optional, see below) |

If your server also has an IPv6 address, add the same three as **AAAA** records with that address.

The `*` record makes people's names work as addresses (`alice.example.org`), which other AT Protocol apps use to check that a name really belongs to someone here. You can add it later.

If you use Cloudflare, set these records to **DNS only** (grey cloud), at least until the server is set up.

DNS changes can take from a minute to a few hours to reach everyone.

## 3. Connect to the server

Open a terminal and type (with your server's address):

```
ssh root@203.0.113.10
```

Answer `yes` the first time. If your provider gave you a user other than root (Ubuntu images often use `ubuntu`), log in as that user and put `sudo` in front of the commands below.

It is a good moment to update the system:

```
apt update && apt upgrade -y
```

## 4. Run the installer

Download the installer, read it if you like, then run it:

```
curl -fsSLO https://raw.githubusercontent.com/athlon-misa/openfederation-pds/main/deploy/install.sh
less install.sh          # optional: read what it does (q to quit)
bash install.sh
```

We recommend downloading, reading and then running, rather than piping a download straight into a shell: you see exactly what will run on your server.

The installer:

1. checks the server (system, processor, memory, disk, that ports 80 and 443 are free);
2. installs Docker from Docker's official repository if it is missing;
3. asks for your two addresses (and the domain for people's names) and checks they point at this server;
4. writes everything to `/opt/openfederation` with a generated database password;
5. on a server with less than 3 GB of memory and no swap, adds a 2 GB swap file; if the `ufw` firewall is on, opens ports 80 and 443;
6. starts everything and prints a **setup code**.

You can give the answers up front instead: `bash install.sh --pds-domain pds.example.org --dashboard-domain dashboard.example.org --handle-domain example.org`. `bash install.sh --help` lists every option; `--dry-run` checks and writes the files without installing or starting anything.

Running it again is safe: it keeps your database password and data, and updates the files.

## 5. Set up your server in the browser

1. Open `https://pds.example.org/setup` (your PDS address). If the browser warns about the certificate, wait a minute: Caddy fetches it the first time the address is opened, once DNS points here.
2. Enter the **setup code** the installer printed. It changes every time the PDS restarts; to see the current one:
   ```
   cd /opt/openfederation && docker compose logs pds | grep 'Setup code'
   ```
3. Follow the steps: the kind of server, its addresses (already filled in), email, your admin account and the options.
4. At the end, **download the settings file** and keep it somewhere safe, such as a password manager. It holds the keys that unlock your server's data; without it a backup cannot be restored.

Then sign in on `https://dashboard.example.org` with the admin account you just created.

## Firewall

The server needs ports **80** and **443** open to everyone, and **22** (SSH) for you. Nothing else: the database and the containers' own ports are not published.

- If your provider has a firewall in its control panel, allow TCP 22, 80 and 443 (and UDP 443 for HTTP/3).
- On the server, the installer opens 80 and 443 in `ufw` when `ufw` is active. To turn `ufw` on yourself: `ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw enable`.

## Small servers (2 GB of memory)

The defaults are sized for 2 GB: the PDS may use up to about 0.6 GB, the database about 0.3 GB, the dashboard about 0.2 GB and Caddy very little, which leaves room for the system. The installer adds a 2 GB swap file when there is none, so a busy moment slows things down instead of stopping a program.

- Never build the images on the server: the installer downloads prebuilt ones.
- To see memory use: `docker stats --no-stream`.
- On 4 GB or more, the installer gives the PDS and the database more memory. To change it later, edit `PDS_NODE_HEAP_MB` and `POSTGRES_SHARED_BUFFERS` in `/opt/openfederation/.env` and run `docker compose up -d` in that folder.

## Backups

Back up three things, and keep a copy somewhere other than the server:

1. **the settings files**: `/opt/openfederation/.env` and `/opt/openfederation/data/pds/openfederation.env` (the second also lives in your password manager if you downloaded it at the end of setup);
2. **the database**, as a dump;
3. **uploaded files**: `/opt/openfederation/data/pds/blobs`.

A nightly backup to a folder, as root:

```
mkdir -p /root/openfederation-backups
cat > /etc/cron.daily/openfederation-backup <<'EOF'
#!/bin/sh
set -e
cd /opt/openfederation
day=$(date +%F)
docker compose exec -T postgres pg_dump -U openfederation openfederation | gzip > /root/openfederation-backups/db-$day.sql.gz
tar -czf /root/openfederation-backups/files-$day.tar.gz .env data/pds
find /root/openfederation-backups -type f -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/openfederation-backup
```

Then copy `/root/openfederation-backups` off the server regularly, for example with your provider's backup storage, `rsync` to a computer at home, or `restic`/`rclone` to object storage. A provider's server snapshot is a convenience, not a backup: it disappears with the account.

To restore on a new server: run the installer with the same addresses, stop it (`docker compose down`), put back `.env` and `data/pds`, start only the database (`docker compose up -d postgres`), load the dump (`gunzip -c db-DAY.sql.gz | docker compose exec -T postgres psql -U openfederation openfederation`), then `docker compose up -d`.

## Updating

```
cd /opt/openfederation
docker compose pull
docker compose up -d
```

`OPENFEDERATION_VERSION` in `.env` picks the version: `latest` follows every release; a number such as `1.6.0` stays put until you change it. Running the installer again also refreshes `compose.yaml` and the `Caddyfile`; a file you had edited is kept next to the new one as `*.bak`.

## Useful commands

All from `/opt/openfederation`:

| What | Command |
|---|---|
| Is everything running? | `docker compose ps` |
| The PDS's log | `docker compose logs -f pds` |
| Restart the PDS | `docker compose restart pds` |
| Stop everything | `docker compose down` |
| Start everything | `docker compose up -d` |

## Without the installer

The installer only writes the files in [`deploy/appliance/`](../../deploy/appliance/) and runs Docker Compose. To do it by hand on any Linux server with Docker and the Compose plugin: copy `compose.yaml` and `Caddyfile` to a folder, copy `.env.example` to `.env` and fill it in (generate the database password with `openssl rand -hex 24`), then `docker compose up -d` and `docker compose logs pds` for the setup code.

## Trying it on your own computer

To see the whole stack without a server or a domain, on a computer with Docker:

```
cd deploy/appliance
cp .env.local.example .env
docker compose -f compose.yaml -f compose.local.yaml up -d
docker compose logs pds | grep 'Setup code'
```

This uses `*.localhost` names, which Caddy serves with its own local certificate (no public certificate is requested), on ports 39080/39443. Open `http://127.0.0.1:39380/setup` (the PDS directly, without Caddy) for the setup page; `https://pds.localhost:39443` goes through Caddy but browsers warn about the local certificate (`curl -k` works). The dashboard is on `http://127.0.0.1:39301`. `.env.local.example` uses images tagged `local`; build them first from the repository root:

```
docker build -t ghcr.io/athlon-misa/openfederation-pds:local .
docker build -t ghcr.io/athlon-misa/openfederation-dashboard:local web-interface
```

Remove it all with `docker compose -f compose.yaml -f compose.local.yaml down` and delete `deploy/appliance/data`.

## Something went wrong

- **The installer says port 80 or 443 is in use**: another web server is running (often Apache or nginx from the provider's image). Stop it (`systemctl disable --now apache2 nginx`) and run the installer again.
- **The browser shows a certificate warning for a long time**: check the DNS records point at this server (`getent hosts pds.example.org` on the server), that ports 80 and 443 are open in the provider's firewall, then `docker compose logs caddy`.
- **"Setup code" is not accepted**: the code changes on every restart; copy the newest one from the log.
- **The dashboard says it cannot reach the server**: it uses `https://` plus your PDS address; check `PDS_DOMAIN` in `.env`, then `docker compose up -d`.
