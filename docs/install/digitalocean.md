# Install on DigitalOcean

DigitalOcean costs more than the budget providers in our [hosting comparison](../HOSTING-COMPARISON.md), but its pricing and documentation are clear. Use a Droplet with at least 2 GB of memory.

Follow the [general guide](vps.md); the DigitalOcean-specific parts:

1. **Create a Droplet**: in the control panel, **Create**, **Droplets**. Choose a region, the image **Ubuntu 24.04 (LTS)** or **Debian 12**, the **Basic** plan with 2 GB (or 4 GB) of memory, and add your **SSH key**. Optionally tick **IPv6**.
2. **Firewall**: under **Networking**, **Firewalls**, create one with inbound rules for SSH (22), HTTP (80), HTTPS (443, TCP and UDP), and apply it to the Droplet. (Or use `ufw` as in the [general guide](vps.md#firewall).)
3. **DNS**: add A records (and AAAA if you enabled IPv6) as in [step 2](vps.md#2-point-your-addresses-at-the-server). If your domain's DNS is at DigitalOcean, that is under **Networking**, **Domains**.
4. **Connect** with `ssh root@YOUR-DROPLET-IP` and run the installer ([step 4](vps.md#4-run-the-installer)).
5. **Backups**: DigitalOcean's weekly backups (an extra option) are convenient; keep the nightly backup from the [general guide](vps.md#backups) somewhere else as well.

Do not use DigitalOcean's "Docker" Marketplace image: start from plain Ubuntu or Debian and let the installer add Docker.
