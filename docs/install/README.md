# Installing OpenFederation

Every path below ends at the same place: your server starts, prints a setup code in its log, and you finish in the browser at `https://<your PDS address>/setup`, where every secret is generated for you.

| Where | Guide | You need |
|---|---|---|
| Railway (no server to look after) | [INSTALL-RAILWAY.md](../INSTALL-RAILWAY.md) | a Railway account |
| Any rented Linux server (VPS) | [vps.md](vps.md) | a server with 2 GB+ memory, a domain |
| netcup (cheapest we found) | [netcup.md](netcup.md) | VPS nano (2 GB) or VPS Lite 1 (4 GB) |
| Hetzner | [hetzner.md](hetzner.md) | a 4 GB cloud server |
| OVHcloud | [ovhcloud.md](ovhcloud.md) | an entry VPS |
| IONOS | [ionos.md](ionos.md) | a 2 GB+ VPS |
| Contabo | [contabo.md](contabo.md) | a Cloud VPS |
| DigitalOcean | [digitalocean.md](digitalocean.md) | a 2 GB+ Droplet |
| A Synology NAS at home | [synology.md](synology.md) | DSM 7.2+, x86-64 or ARM64, 2 GB free memory |

Costs are compared in [HOSTING-COMPARISON.md](../HOSTING-COMPARISON.md).

## What is behind these guides

- **Prebuilt images** for x86-64 and ARM64, published with every release:
  `ghcr.io/athlon-misa/openfederation-pds` and `ghcr.io/athlon-misa/openfederation-dashboard` (built by `.github/workflows/images.yml`). Nothing is built on your server.
- **The appliance** ([`deploy/appliance/`](../../deploy/appliance/)): one Docker Compose stack with the PDS, PostgreSQL 15, the dashboard and Caddy for automatic HTTPS, keeping everything in one `data` folder.
- **The installer** ([`deploy/install.sh`](../../deploy/install.sh)): sets up Docker and the appliance on Debian or Ubuntu and prints the setup code. Download it, read it, run it.
- **The Synology project** ([`deploy/synology/compose.yaml`](../../deploy/synology/compose.yaml)): the same containers for Container Manager, with DSM's reverse proxy and certificates instead of Caddy.
- **The dashboard reads the PDS address when it starts** (`PDS_URL`), so the same dashboard image serves every install.
