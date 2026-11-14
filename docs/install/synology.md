# Install on a Synology NAS

If you already have a Synology NAS running all day, it can host your OpenFederation server at almost no extra cost. This guide uses DSM's **Container Manager** and DSM's own **reverse proxy** and **Let's Encrypt** certificates, all from the DSM web interface. You need about an hour, a domain name you can add DNS records to, and access to your internet router's settings.

Menu names are from DSM 7.2 and may differ slightly between versions.

## What you need

- **DSM 7.2 or newer**, on a model that can run **Container Manager**: a 64-bit **x86-64** or **ARM64** (armv8) model. 32-bit ARM models cannot run it. Synology lists the models on the [Container Manager page](https://www.synology.com/en-global/dsm/packages/ContainerManager); check yours there ("Plus" in the name is not a guarantee).
- **2 GB of memory free** while the NAS does its usual work (check **Resource Monitor**, **Memory**). A NAS with 2 GB installed is not enough; 4 GB or more installed is the practical minimum.
- **An SSD** for the database is strongly recommended: a volume on SSDs, or at least not a volume of disks that go to sleep. The database writes a little all the time.
- **A public IP address** at home that your router can forward ports from (see [Reaching your NAS from the internet](#reaching-your-nas-from-the-internet)).
- **A domain** with two names pointing at your home address, for example `pds.example.org` and `dashboard.example.org`.

## Never expose these

- **DSM's own login** (ports 5000 and 5001, and QuickConnect). Do not forward them on your router; manage the NAS from home or over a VPN.
- **PostgreSQL** (port 5432). The project below never publishes it.
- **The containers' ports** 18080 and 13000. The project binds them to the NAS itself (`127.0.0.1`), so only DSM's reverse proxy reaches them.

Forward only **80** and **443**, and only to DSM's reverse proxy.

## 1. Install Container Manager

**Package Center**, search **Container Manager**, **Install**.

## 2. Create the folders

Container Manager does not create the folders a project uses, so create them first:

1. Open **File Station**. Container Manager created a shared folder **docker** when it was installed.
2. In **docker**, create a folder **openfederation**, and in it two folders: **postgres** and **pds**.

You should now have `docker/openfederation/postgres` and `docker/openfederation/pds`. If the **docker** shared folder is not on `volume1`, note its volume (`volume2`, …) and change `/volume1` in the project file to match.

## 3. Create the project

1. Open [`deploy/synology/compose.yaml`](../../deploy/synology/compose.yaml) and copy its whole text.
2. **Container Manager**, **Project**, **Create**.
3. **Project name**: `openfederation`. **Path**: click **Set Path** and choose `docker/openfederation`. **Source**: **Create docker-compose.yml**, then paste the text.
4. Change every line marked **CHANGE ME** (five lines):
   - `POSTGRES_PASSWORD` and `DB_PASSWORD`: the same long random password in both (a password manager can make one; letters and digits only is simplest);
   - `SETUP_PUBLIC_URL` and `PDS_URL`: your PDS address, for example `https://pds.example.org`;
   - `SETUP_DASHBOARD_URL`: your dashboard address, for example `https://dashboard.example.org`.
5. **Next**. Skip the **Web portal** settings (leave them off): DSM's reverse proxy is set up by hand below. **Next**, then **Done**. Tick **Start the project once it is created**.

Container Manager downloads the images (a few hundred MB) and starts four containers. `openfederation-pds-permissions` runs once and stops; that is expected.

## 4. Get the certificate

1. **Control Panel**, **Security**, **Certificate**, **Add**.
2. **Add a new certificate**, **Next**, then **Get a certificate from Let's Encrypt**, **Next**.
3. **Domain name**: `pds.example.org`. **Email**: yours. **Subject Alternative Name**: `dashboard.example.org`. **Done**.

Let's Encrypt checks the names over port 80, so do [Reaching your NAS](#reaching-your-nas-from-the-internet) and the DNS records first if this fails.

## 5. Set up the reverse proxy

**Control Panel**, **Login Portal**, **Advanced**, **Reverse Proxy**, **Create**. Make two rules:

| | Rule 1: the PDS | Rule 2: the dashboard |
|---|---|---|
| Description | `OpenFederation PDS` | `OpenFederation dashboard` |
| Source protocol | HTTPS | HTTPS |
| Source hostname | `pds.example.org` | `dashboard.example.org` |
| Source port | 443 | 443 |
| Enable HSTS | ticked | ticked |
| Destination protocol | HTTP | HTTP |
| Destination hostname | `localhost` | `localhost` |
| Destination port | `18080` | `13000` |

On each rule, open **Custom Header**, **Create**, **WebSocket** (this adds the two upgrade headers), then **Create** again for each of these:

| Header name | Value |
|---|---|
| `X-Forwarded-For` | `$proxy_add_x_forwarded_for` |
| `X-Forwarded-Proto` | `$scheme` |

The PDS uses them to see each visitor's real address (for its sign-in protection) and that the connection is HTTPS.

Then assign the certificate: **Control Panel**, **Security**, **Certificate**, **Settings**, and for both reverse-proxy entries choose the certificate from step 4.

## 6. Set up your server in the browser

1. **Container Manager**, **Container**, **openfederation-pds**, **Log**. Find the line **Setup code:** and copy the code. It changes every time the container restarts.
2. Open `https://pds.example.org/setup`, enter the code, and follow the steps. Your addresses are filled in already.
3. At the end, **download the settings file** and keep it in a password manager: it holds the keys that unlock your server's data.

Then sign in on `https://dashboard.example.org`.

## Reaching your NAS from the internet

Other servers and apps must be able to reach your PDS at any time, without logging in to anything.

**Public IP and port forwarding.** In your router, forward **TCP 80** and **TCP 443** to the NAS's local address (make that address fixed in the router's DHCP settings). Then point DNS at your home's public address: **A** records for `pds` and `dashboard` (and AAAA if your connection has IPv6 and the NAS has a public IPv6 address). If your home address changes from time to time, use dynamic DNS: DSM has it under **Control Panel**, **External Access**, **DDNS**; a CNAME from `pds.example.org` to that DDNS name keeps working when the address changes.

**CGNAT: when port forwarding cannot work.** Many fibre, cable and mobile connections share one public address between many customers (carrier-grade NAT). Signs: the WAN address shown in your router starts with `100.64`–`100.127`, `10.` or `192.168.`, or differs from what a "what is my IP" site shows. Then forwarding ports does nothing. Options:

- ask your provider for a **public IPv4 address** (sometimes free on request, sometimes a paid option);
- an **outbound tunnel** with a public hostname (for example Cloudflare Tunnel): the tunnel must forward `pds.example.org` straight to the PDS **without** any login or access gate in front of it, and set `EXPRESS_TRUST_PROXY` to match the extra proxy;
- a small **rented server as a front door** that forwards to your NAS over a private tunnel (for example WireGuard).

QuickConnect, Synology's relay and private VPNs (Tailscale and similar) are **not** public access: other servers cannot reach your PDS through them.

**Never** put the PDS behind DSM's login, a VPN or an access portal: AT Protocol apps and servers must reach it directly.

## People's names (alice.example.org)

Other AT Protocol apps check a name like `alice.example.org` by opening `https://alice.example.org/.well-known/atproto-did`. Serving that for every name needs a **wildcard** certificate (`*.example.org`), and DSM's Let's Encrypt can only issue wildcard certificates for Synology's own DDNS names (`*.yourname.synology.me`). So, for now:

- the simplest is to use a `synology.me` DDNS name as the handle domain: in **Control Panel**, **Security**, **Certificate**, DSM can get `*.yourname.synology.me`; add a reverse-proxy rule for source hostname `*.yourname.synology.me` to `localhost:18080`, and enter `yourname.synology.me` as the domain for people's names in the setup page;
- or import a wildcard certificate for your own domain obtained elsewhere (with a DNS-01 challenge) under **Certificate**, **Add**, **Import certificate**, and add the same wildcard reverse-proxy rule;
- or leave it for later: accounts work without it; only that kind of name check by other apps does not.

## Updating

**Container Manager**, **Project**, **openfederation**, **Action**, **Stop**; then **Image**, select the two `ghcr.io/athlon-misa/…` images, **Update** (or **Project**, **Action**, **Build** to pull again); then start the project. Your data in `docker/openfederation` is kept.

## Backups

Back up the `docker/openfederation` folder with **Hyper Backup** to another device or a cloud destination, and keep the settings file in your password manager. For a consistent database copy, stop the project before the backup runs, or add a scheduled task (**Control Panel**, **Task Scheduler**, **Create**, **Scheduled Task**, **User-defined script**, user `root`) that dumps it first:

```
docker exec openfederation-postgres pg_dump -U openfederation openfederation | gzip > /volume1/docker/openfederation/db-backup.sql.gz
```

Snapshots on the same NAS (Snapshot Replication) help against mistakes, not against losing the NAS.

## Something went wrong

- **The project does not start, "bind mount failed" or "no such file"**: a folder from step 2 is missing, or the shared folder is on another volume than `/volume1`.
- **openfederation-pds keeps restarting**: open its **Log**. "password authentication failed" means the two passwords in the project differ: fix them, then delete the contents of `docker/openfederation/postgres` (only on a fresh install!) and build again.
- **The certificate cannot be issued**: port 80 must reach the NAS from the internet, and the DNS records must point at your public address. Check for CGNAT above.
- **"Bad gateway" on the address**: the reverse proxy destination must be `localhost` with ports 18080 and 13000, protocol HTTP.
