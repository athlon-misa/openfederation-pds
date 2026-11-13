# Railway template (maintainers)

How to create and publish the one-click **Deploy on Railway** template that [docs/INSTALL-RAILWAY.md](INSTALL-RAILWAY.md) and the README link to (#405).

A Railway template cannot be created from files in this repository: Railway composes templates in its web UI (or generates one from an existing project). Everything the template needs on the code side is already here: the PDS starts in setup mode when it has no secrets, prints a setup code, serves `/setup`, and saves its settings on the volume. This page lists the exact services and variables to enter.

**Never build the template from the production project** (`pds.openfederation.net`): "Generate Template from Project" copies the project's variables. Use the template composer from scratch, as below, or a throwaway project in a separate workspace.

## What the template creates

| Service | Source | Purpose |
|---|---|---|
| `openfederation-pds` | GitHub `athlon-misa/openfederation-pds`, branch `main`, root `/` | The PDS (Dockerfile build), with a volume at `/data` |
| `Postgres` | Railway's PostgreSQL database | The PDS database |
| `openfederation-dashboard` | GitHub `athlon-misa/openfederation-pds`, branch `main`, root `/web-interface` | The dashboard (Nixpacks, `web-interface/nixpacks.toml`) |

Optional variant "with its own PLC directory" (most installs use `https://plc.openfederation.net`, the default):

| Service | Source | Purpose |
|---|---|---|
| `openfederation-plc` | same repo, root `/plc-server` | PLC directory |
| `Postgres-PLC` | Railway's PostgreSQL database | The PLC database |

No secret is set in the template. The setup wizard generates `AUTH_JWT_SECRET`, `KEY_ENCRYPTION_SECRET`, `OAUTH_SIGNING_KEY` and `OAUTH_DPOP_SECRET` and writes them to `/data/openfederation.env`. That is deliberate: a template's `${{secret()}}` would cover the first two but not the OAuth key, and keeping every secret in one place (the settings file the person downloads at the end) gives them a single thing to back up. It is also what the Docker install will do.

## Click by click

1. Open Railway, switch to the **workspace** that should own the template (not the production project's workspace if you can avoid it), open **Workspace Settings**, **Templates**, click **New Template**.
2. **Add the database.** **Add New** (top right), **Database**, **PostgreSQL**. Leave its name `Postgres`.
3. **Add the PDS.** **Add New**, **GitHub Repo**, `athlon-misa/openfederation-pds`. Rename the service to `openfederation-pds`. In its settings:
   - **Source**: branch `main`, root directory `/`.
   - **Build**: builder **Dockerfile**, Dockerfile path `Dockerfile`.
   - **Deploy**: healthcheck path `/health`, healthcheck timeout `300`, restart policy **On Failure**, replicas `1` (the setup code and the OAuth replay cache live in one process; more replicas need `REDIS_URL` and a finished setup).
   - **Networking**: **Generate Domain** (public HTTP, port from `PORT`).
   - **Volume**: right-click the service, **Attach Volume**, mount path `/data`.
   - **Variables**: open the **Raw Editor** and paste:

     ```
     NODE_ENV=production
     DB_HOST=${{Postgres.PGHOST}}
     DB_PORT=${{Postgres.PGPORT}}
     DB_NAME=${{Postgres.PGDATABASE}}
     DB_USER=${{Postgres.PGUSER}}
     DB_PASSWORD=${{Postgres.PGPASSWORD}}
     OPENFEDERATION_CONFIG_FILE=/data/openfederation.env
     BLOB_STORAGE_PATH=/data/blobs
     RAILWAY_RUN_UID=0
     SETUP_DASHBOARD_URL=https://${{openfederation-dashboard.RAILWAY_PUBLIC_DOMAIN}}
     SETUP_DASHBOARD_HOST=${{openfederation-dashboard.RAILWAY_PUBLIC_DOMAIN}}
     ```

     Why each one:
     - `DB_*`: the PDS reads these names, not Railway's `PG*`.
     - `OPENFEDERATION_CONFIG_FILE`, `BLOB_STORAGE_PATH`: the settings file and uploaded images go on the volume, so they survive redeploys.
     - `RAILWAY_RUN_UID=0`: Railway mounts volumes owned by root, and the image runs as the unprivileged `node` user, which could not write to `/data` otherwise ([Railway docs, Volumes](https://docs.railway.com/reference/volumes)).
     - `SETUP_DASHBOARD_URL`, `SETUP_DASHBOARD_HOST`: only pre-fill the wizard's dashboard field and DNS records. They are not configuration.
     - Do **not** set `PORT` (Railway sets it), `AUTH_JWT_SECRET`, `KEY_ENCRYPTION_SECRET`, `PDS_SERVICE_URL`, `HANDLE_SUFFIX`, `SMTP_*` or anything else the wizard writes: a variable always wins over the wizard, and a secret in the environment stops setup mode from starting at all.
4. **Add the dashboard.** **Add New**, **GitHub Repo**, the same repository. Rename it to `openfederation-dashboard`. Settings:
   - **Source**: branch `main`, root directory `/web-interface`.
   - **Build**: builder **Nixpacks** (it reads `web-interface/nixpacks.toml`).
   - **Networking**: **Generate Domain**.
   - **Variables** (Raw Editor):

     ```
     NEXT_PUBLIC_PDS_URL=https://${{openfederation-pds.RAILWAY_PUBLIC_DOMAIN}}
     ```

     `NEXT_PUBLIC_PDS_URL` is read when the dashboard is **built**, so the PDS domain must exist before the first dashboard build. Railway generates the template's domains before building, so this works on deploy. If someone later gives the PDS a custom domain, they change this variable and redeploy the dashboard (the install guide says so).
5. *(Optional, own-PLC variant only)* **Add New**, **Database**, **PostgreSQL**, rename it `Postgres-PLC`. **Add New**, **GitHub Repo**, same repository, rename to `openfederation-plc`, root directory `/plc-server`, builder **Nixpacks**, **Generate Domain**, variables:

   ```
   DATABASE_URL=${{Postgres-PLC.DATABASE_URL}}
   ```

   and add to `openfederation-pds`:

   ```
   SETUP_PLC_URL=https://${{openfederation-plc.RAILWAY_PUBLIC_DOMAIN}}
   ```

   (pre-fills the wizard's "Identity directory" with this PLC).
6. **Template details** (the template's settings page): name `OpenFederation PDS`, short description "Your own OpenFederation server: accounts, communities and a dashboard, set up in your browser.", category **Other** (or **Starters**), and paste the overview below.
7. Click **Create Template**. On the **Templates** page, open the template, **Publish** it if it should be public, and copy its URL (`https://railway.com/deploy/<code>`).
8. **In this repository**, replace the placeholder `https://railway.com/deploy/openfederation-pds` in `README.md` and `docs/INSTALL-RAILWAY.md` with that URL, and commit.

### Overview text for the template page

> Deploys an OpenFederation PDS (accounts and communities on the AT Protocol), its database, and the admin dashboard.
>
> When the deploy finishes: open the **openfederation-pds** service's **Deployments**, **View logs**, copy the **Setup code**, then open the service's address. You land on the setup page, which asks for the code and walks you through addresses, email and your admin account. Every secret is generated for you.
>
> Step-by-step guide: https://github.com/athlon-misa/openfederation-pds/blob/main/docs/INSTALL-RAILWAY.md

## Test the template before publishing

1. Deploy it into a **new, empty project** in a test workspace (never the production project).
2. Check the PDS log shows `Starting in setup mode` and a `Setup code:` line, and that `/health` answers `{"status":"setup",...}` (so the healthcheck passes before setup).
3. Open the PDS address: it redirects to `/setup`. Walk the wizard with "No email for now".
4. After **Finish setup**, the log shows `Setup finished: starting the server with the new settings.`, `✓ Admin account from the setup wizard created`, and `/health` answers `"status":"ok"`.
5. **Redeploy** the PDS service: it must start normally (log: `Loaded N setting(s) from /data/openfederation.env`), proving the volume keeps the settings.
6. Sign in on the dashboard with the admin account.
7. Delete the test project.
