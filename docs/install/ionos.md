# Install on IONOS

IONOS's small VPS plans (2 GB of memory in our [hosting comparison](../HOSTING-COMPARISON.md)) run OpenFederation; note that the low introductory price is temporary, as the comparison explains.

Follow the [general guide](vps.md); the IONOS-specific parts:

1. **Order** a VPS and, when asked for the system, choose **Debian 12** or **Ubuntu 24.04** without Plesk or another control panel.
2. **Login**: in the IONOS control panel, **Servers & Cloud**, open the server to find its IP address and the initial root password. Connect with `ssh root@YOUR-IPv4-ADDRESS`.
3. **Firewall**: IONOS puts a firewall policy in front of every server, and by default it lets in only a few ports. In the server's **Network**, **Firewall Policies**, make sure **TCP 80** and **TCP 443** (and UDP 443) are allowed, alongside 22. Without this, certificates are never issued.
4. **DNS**: add A records (and AAAA if you enable IPv6 on the server) as in [step 2](vps.md#2-point-your-addresses-at-the-server). If the domain is at IONOS, that is under **Domains & SSL**, **DNS**.
5. With 2 GB of memory, read [Small servers](vps.md#small-servers-2-gb-of-memory). Then run the installer ([step 4](vps.md#4-run-the-installer)).
