# Install on OVHcloud

OVHcloud's entry VPS (4 GB of memory in the range in our [hosting comparison](../HOSTING-COMPARISON.md)) fits OpenFederation. The advertised price depends on region and term; check the checkout. The comparison has the details.

Follow the [general guide](vps.md); the OVHcloud-specific parts:

1. **Order**: on ovhcloud.com, **Bare Metal & VPS**, **VPS**. In the order, pick the location, and the image **Debian 12** or **Ubuntu 24.04** (a plain distribution, not one with an application preinstalled). Add your **SSH key** if offered.
2. **Login**: OVHcloud emails the login. On Debian and Ubuntu images the user is often `debian` or `ubuntu` rather than `root`: log in as that user and run the installer with `sudo bash install.sh`.
3. **Firewall**: the VPS is open by default. Use `ufw` on the server as in the [general guide](vps.md#firewall). If you enable OVHcloud's **Network firewall** on the IP in the control panel, allow TCP 22, 80, 443 and UDP 443.
4. **DNS**: add A records (and AAAA with the IPv6 address shown in the control panel) as in [step 2](vps.md#2-point-your-addresses-at-the-server).
5. **Backups**: the automatic backup included with some plans is a convenience; keep the nightly backup from the [general guide](vps.md#backups) somewhere else as well.
