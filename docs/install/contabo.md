# Install on Contabo

Contabo's Cloud VPS plans offer a lot of memory and disk for the price (see our [hosting comparison](../HOSTING-COMPARISON.md), which also notes a possible setup fee and that the offer should be confirmed in the cart).

Follow the [general guide](vps.md); the Contabo-specific parts:

1. **Order** a Cloud VPS. In the order form choose the region and the image **Debian 12** or **Ubuntu 24.04** (under the plain operating systems, not an "app" image), and set a root password or add your SSH key.
2. **Wait for the email**: provisioning can take from minutes to a few hours. The email has the IP address and login.
3. **Firewall**: the server is open by default. Turn on `ufw` as in the [general guide](vps.md#firewall).
4. **DNS**: add A records (and AAAA with the IPv6 address from the customer control panel) as in [step 2](vps.md#2-point-your-addresses-at-the-server).
5. **Connect** with `ssh root@YOUR-IPv4-ADDRESS` and run the installer ([step 4](vps.md#4-run-the-installer)). With 8 GB of memory the installer gives the PDS and the database more room automatically.
6. **Backups**: Contabo's snapshots are a convenience; keep the nightly backup from the [general guide](vps.md#backups) somewhere else.
