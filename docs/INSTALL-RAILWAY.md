# Install OpenFederation on Railway

This guide is for anyone who wants their own OpenFederation server: a club, a newsroom, a community. You do not need to be technical. It takes about 20 minutes, plus waiting for your domain settings to spread.

**What you get:** your own server for accounts and communities, with your own domain, its own email, and an admin account for you. The secret keys are created for you.

**What you need:**

- A [Railway](https://railway.com) account. Railway runs the server for you; it costs roughly 5 to 20 US dollars a month for a small community.
- A domain you own (for example `example.org`), and access to its DNS settings at the company where you bought it. You can start without one and add it later.
- An account with an email sending service (for example Resend, Postmark, Mailgun or Amazon SES) or the outgoing mail (SMTP) settings of your email provider. You can also start without email.

> Experts who prefer to set every environment variable by hand: see [RAILWAY.md](../RAILWAY.md). The setup page and the variables work together; a variable you set always wins.

## 1. Start the install

1. Click **Deploy on Railway**: [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/openfederation-pds)
2. Sign in to Railway if it asks.
3. Railway shows what it is about to create:
   - **openfederation-pds**: the server itself, with a small permanent disk (a *volume*) where its settings are kept,
   - **Postgres**: the database,
   - **openfederation-dashboard**: the website you and your members use.
4. Click **Deploy**. Railway builds everything. This takes 5 to 10 minutes; each box turns green when it is ready.

## 2. Find your setup code

The server will only let the person who started it finish the setup. To prove it is you, it writes a one-time **setup code** in its log.

1. In your Railway project, click the **openfederation-pds** box.
2. Open the **Deployments** tab and click **View logs** on the newest deployment.
3. Look for a block like this:

   ```
   This server is not set up yet.
   Open https://openfederation-pds-production-1234.up.railway.app/setup
   and enter this setup code when asked:

        Setup code: 7KQ2M-X9D4P-HT3VA-0WZ8N
   ```

4. Copy the code. It changes every time the server restarts; always use the newest one.

## 3. Open the setup page

Open the address from the log (it ends in `/setup`). You can also find it on the **openfederation-pds** box under **Settings, Networking**.

Paste the setup code and click **Continue**. The setup page walks you through six short steps.

### Step 1: What kind of server is this?

- **A community or club server**: for groups, clubs, teams and fan communities. The server looks after people's keys so nobody gets locked out. Anonymous accounts are off.
- **A newsroom or privacy-first server**: for journalists, their sources, and anyone who needs to protect who they are. People are encouraged to keep their own keys; anonymous accounts are on.

This only sets the starting choices for step 5.

### Step 2: Addresses

- **Server address**: filled in for you with the Railway address. If you want your own domain (for example `https://pds.example.org`), enter it here.
- **Name domain**: everyone on the server gets a name ending in this domain, like `alice.example.org`. Choose carefully: changing it later changes everyone's name.
- **Dashboard address**: filled in for you with the dashboard's Railway address.
- **Identity directory**: leave it alone unless you run your own.

Click **Show the records and check them**. The page lists the DNS records to add at your domain provider, each with **Copy** buttons, and checks which ones already work. You can finish setup before they do; DNS changes can take up to an hour.

If you use your own domain for the server, also add it in Railway: click **openfederation-pds**, then **Settings, Networking, Custom Domain**. Railway shows the exact record to add, and sometimes a second one that proves the domain is yours.

### Step 3: Email

Choose **Send email through my provider** and copy the values from your provider's SMTP settings page: mail server, port, username, password, and the address emails come from. Click **Send test email** to make sure it works.

Or choose **No email for now**. The page explains what that turns off: password resets, account recovery by email, sign-in warnings and email confirmation. You can add email later (see "Changing settings later" below).

### Step 4: Your admin account

Choose a name, your email and a strong password. This is the account you use to run the server. The password is stored only in scrambled form, never in a settings file.

### Step 5: Options

- **Invite-only sign-up**: new people need an invite from you. Recommended at first.
- **Allow pseudonyms**: anonymous accounts that are not linked to anyone, not even on your server.
- **Who looks after people's keys**: which ways you allow, and which one is offered first.
- **Device signing**: coming soon.

### Step 6: Review and finish

Check everything and click **Finish setup**. Then:

1. Click **Download settings file** and keep the file somewhere private, such as a password manager. It holds your server's secret keys. If Railway's disk were ever lost, this file is the only way to unlock the data in your database. Never share it.
2. Wait a few seconds: the page tells you when the server is running with your settings.
3. Click **open the dashboard** and sign in with your admin name and password.

The setup page is now locked for good. Visiting `/setup` again only says that the server is set up.

## 4. What is left to do

The last screen shows a checklist. In short:

- **Add the DNS records** if you have not yet.
- **Turn on backups**: in Railway, click **Postgres**, then **Backups**, and turn on scheduled backups. Do the same for the **openfederation-pds** volume.
- **Protect your email from forgery**: add the SPF, DKIM and DMARC records your email provider shows you.
- **Say where security problems should be reported**: add a variable `SECURITY_CONTACT` (see below) with an email address or web page.
- **Watch the server**: the `/health` page shows whether the database and email work. A free uptime monitor can check it for you.

## Changing settings later

The setup page saves your choices in a settings file on the server's disk. To change one later, add a **variable** with the same name in Railway; a variable always wins over the settings file.

1. Click **openfederation-pds**, then **Variables**, then **New Variable**.
2. Enter the name and the value, for example `SMTP_HOST` and `smtp.example.com`.
3. Railway restarts the server with the new value.

The names are listed in the expert guide ([RAILWAY.md](../RAILWAY.md) and the table in `CLAUDE.md`). The most common ones:

| You want to change | Variable |
|---|---|
| The server's address | `PDS_SERVICE_URL` and `PDS_HOSTNAME` |
| The dashboard's address | `WEB_UI_URL` and `CORS_ORIGINS` |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (and remove `ALLOW_NO_EMAIL`) |
| Invite-only sign-up | `INVITE_REQUIRED` (`true` or `false`) |
| Pseudonyms | `PSEUDONYMS_ENABLED` (`true` or `false`) |
| Security contact | `SECURITY_CONTACT` |

### Changing the dashboard address

The dashboard reads the server's address from its `NEXT_PUBLIC_PDS_URL` variable. If you give the **server** a new address, also change `NEXT_PUBLIC_PDS_URL` on the **openfederation-dashboard** service and click **Deploy** (or **Redeploy**) there.

## If something goes wrong

- **The setup page says the code is not right**: copy the newest code from the log; it changes at every restart. After five wrong tries, wait 15 minutes.
- **"The server cannot save its settings"**: the server has no permanent disk. Click **openfederation-pds**, right-click, **Attach Volume**, mount path `/data`, and make sure the variable `RAILWAY_RUN_UID` is `0`. Then redeploy.
- **"This server was already set up" but you never downloaded anything**: the settings file was lost. Do not start over: the data in the database can only be unlocked with the old keys. Put back the settings file (or its values as variables) and restart. Ask for help in the OpenFederation project if you have no copy.
- **The dashboard says "Network Error"**: see "Changing the dashboard address" above.
