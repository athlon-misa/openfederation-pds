# Install on Hetzner

Hetzner Cloud's small shared-CPU servers (4 GB of memory, for example the CX23 in our [hosting comparison](../HOSTING-COMPARISON.md)) fit OpenFederation well. Prices and availability are in the comparison; the plan was sometimes shown as unavailable, so check the console.

Follow the [general guide](vps.md); the Hetzner-specific parts:

1. **Create the server**: in the [Hetzner Cloud Console](https://console.hetzner.cloud/), open a project, **Add Server**. Choose a location, the image **Debian 12** or **Ubuntu 24.04**, a shared-vCPU type with 4 GB (x86 or Arm64 both work), keep **Public IPv4** switched on (it costs a little extra, and is needed so everyone can reach you), and add your **SSH key**.
2. **Firewall**: Hetzner's cloud firewall blocks nothing until you create one. Under **Firewalls**, create one allowing inbound TCP 22, 80, 443 and UDP 443, and apply it to the server. (Or use `ufw` on the server, as in the general guide.)
3. **DNS**: add A records (and AAAA, with the server's IPv6 address) as in [step 2](vps.md#2-point-your-addresses-at-the-server). If your domain is in Hetzner DNS, that is in the **DNS** console.
4. **Connect** with `ssh root@YOUR-IPv4-ADDRESS` and run the installer ([step 4](vps.md#4-run-the-installer)).
5. **Backups**: Hetzner's server backups (an extra option) and snapshots are convenient, but keep the nightly backup from the [general guide](vps.md#backups) somewhere else too. Hetzner's documentation notes that attached volumes are not part of server backups.
