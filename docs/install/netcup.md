# Install on netcup

[netcup](https://www.netcup.com/) had the cheapest suitable servers in our [hosting comparison](../HOSTING-COMPARISON.md): the **VPS nano** (2 GB of memory, 60 GB disk) and the **VPS Lite 1** (4 GB, 80 GB). Both run OpenFederation; the Lite 1 is more comfortable, the nano is the smallest that works. Current prices and terms are in the comparison.

netcup sets its servers up after you order, in its **Server Control Panel (SCP)**, so the path is: order, choose the system in the SCP, connect over SSH, run the installer. This page fills in the netcup-specific parts of the [general guide](vps.md); read that too.

Menu names below are as of November 2026 and may change slightly.

## 1. Order

1. On netcup.com, open **Server**, then **VPS**, and choose **VPS nano** or **VPS Lite 1**. Both are billed for a minimum term (six months at the time of the comparison); the nano is limited to one per customer.
2. Complete the order. New customers may be asked to verify their identity; the server is usually ready within a few hours, sometimes longer.
3. netcup sends two emails: the **customer control panel (CCP)** login, for invoices and domains, and the **Server Control Panel (SCP)** login, for the server itself. Keep both.

## 2. Install Debian or Ubuntu in the SCP

1. Log in to the **SCP** (servercontrolpanel.de) and open your server.
2. Open **Media**, then **Images**.
3. Choose **Debian 12** or **Ubuntu 24.04**, the plain (minimal) version without a control panel such as Plesk or Docker preinstalled.
4. Choose the partitioning that uses the **whole disk** as one partition, and add your **SSH key** if the page offers it. Start the installation. It erases the disk, which is fine on a new server.
5. When it finishes, the SCP shows the **root password** (or emails it). Note the server's **IPv4 address** and **IPv6 address** from the SCP's overview or **Network** page.

## 3. Point your addresses at the server

Add the records from [step 2 of the general guide](vps.md#2-point-your-addresses-at-the-server):

- **A** records for `pds`, `dashboard` and (optional) `*`, with the IPv4 address;
- netcup servers have IPv6 too: add the same three as **AAAA** records with the IPv6 address shown in the SCP. If the SCP shows a whole network (ending in `::/64`), use the address it lists for the server, often the network with `1` at the end (`2a03:4000:…::1`); check with `ip -6 addr` on the server.

If your domain is at netcup, the records are in the **CCP**, under **Domains**, then **DNS**.

## 4. Connect and run the installer

From your computer:

```
ssh root@YOUR-IPv4-ADDRESS
apt update && apt upgrade -y
curl -fsSLO https://raw.githubusercontent.com/athlon-misa/openfederation-pds/main/deploy/install.sh
less install.sh
bash install.sh
```

Then continue with [step 5 of the general guide](vps.md#5-set-up-your-server-in-the-browser): open `https://pds.example.org/setup` and enter the setup code.

## Firewall

A fresh netcup server accepts connections on every port; nothing is blocked in front of it unless you set it up. Turn on the firewall on the server, keeping SSH open:

```
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw enable
```

If you later add firewall rules in the SCP, allow TCP 22, 80 and 443 and UDP 443 there as well.

## On the VPS nano (2 GB)

The installer sizes everything for 2 GB and adds a 2 GB swap file (netcup images come without swap). That is enough for a small community. Keep an eye on it for the first weeks:

```
free -h
docker stats --no-stream
```

If the swap line in `free -h` is often well above a few hundred MB, move to the Lite 1: netcup can upgrade a VPS in the CCP, or you can set up a new one and restore a backup.

Never build software on the nano itself; the installer downloads prebuilt images for this reason.

## Backups

netcup's server snapshots (SCP, **Snapshots**) are handy before an upgrade, but they live with the server: they are not a backup. Set up the nightly backup from the [general guide](vps.md#backups) and copy it off the server, for example to a computer at home with `rsync`, or to netcup's or another provider's storage space.

The most important file is the **settings file** you downloaded at the end of setup: keep it in your password manager. Without it, the keys in the database cannot be unlocked.
