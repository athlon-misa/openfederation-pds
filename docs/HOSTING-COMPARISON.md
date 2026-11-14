# OpenFederation PDS: low-cost hosting comparison

Research date: **14 November 2026**. Prices are a snapshot, not a quote. This compares **this repository's OpenFederation PDS**, not the upstream Bluesky PDS installer. No deployments or performance benchmarks were run for this research.

## Recommendation

- **Lowest paid VPS cost among the verified, suitably sized plans here:** netcup VPS nano, approximately **€3.10/month before VAT** (€3.69 with German VAT), with 2 GB RAM and a six-month commitment. Allow approximately **€4–6/month before VAT** including a small off-site backup budget. Build elsewhere and monitor memory.
- **More comfortable budget choice:** a **4 GB VPS** from netcup Lite or OVHcloud; Hetzner CX23 is also competitive when available, but its public page showed it unavailable during research. Expect roughly **€6–10/month or $6–10/month**, depending on provider/currency, backup choice, tax, and region. These are separate currency budgets, not exchange-rate equivalents.
- **Lowest incremental cost if hardware is already running:** spare capacity on a NAS, Linux server, or Proxmox host. Approximately **€1–4/month** for incremental power and small backups, provided no paid connectivity upgrade is needed.
- **Easiest existing deployment route:** Railway's template. Plan approximately **$10–25/month** for a lightly used PDS, database, and dashboard, subject to measurement and plan storage limits. The $5 Hobby minimum is not a promise that the stack costs $5.
- **Zero compute bill, with availability tradeoffs:** Oracle Always Free ARM, if capacity is available. Suitable for experimentation; avoid depending on a reclaimable instance as the only copy of an identity service.
- **Shared hosting:** investigate only when already paying for it. Node.js support alone is insufficient. Database versions, process recycling, background jobs, and proxy behavior make a small VPS a clearer default.

The prices and constraints supporting these choices are linked in the matrices below. Recommendations are engineering judgments for a small, lightly used installation.

## What must actually run

The cheapest topology is one persistent Linux machine running the **PDS API + PostgreSQL + an HTTPS reverse proxy**, with durable blob storage and an existing compatible PLC directory. Containers can share that machine; there is no need to buy one VPS per container.

| Component | Required? | Repository evidence and cost implication |
|---|---|---|
| PDS API | Yes | [Dockerfile](../Dockerfile) uses Node 24 Alpine, serves port 8080, and sets a 1,024 MB V8 heap ceiling. This is a ceiling, not measured RAM consumption; native allocations and other processes need additional RAM. |
| PostgreSQL | Yes | [docker-compose.yml](../docker-compose.yml) uses PostgreSQL 15. This implementation does not offer SQLite/MySQL as a drop-in alternative. Repositories, indexes, accounts, and audit data consume database space. |
| Blob storage | Yes, for uploads | Compose persists `/data/blobs`; [configuration](../.env.example) also supports S3-compatible storage. An ephemeral container filesystem loses local uploads on replacement. |
| Secrets/configuration | Yes | Preserve environment-managed secrets or the setup wizard's persistent configuration file. [Railway template](RAILWAY-TEMPLATE.md) mounts `/data` for both settings and blobs. |
| Public HTTPS + DNS | Yes, for a public PDS | Use a stable hostname and public HTTPS on 443; reverse-proxy the API's internal port. TLS is normally free through the host or ACME. |
| Dashboard | Optional for API operation | Separate Next.js service in the Railway template; adds build and runtime resources. Keep it if browser administration is desired. |
| Own PLC directory | Optional | Template defaults to an existing directory; own-PLC variant adds a service and database. Directory choice must match the DIDs/ecosystem being used. An arbitrary independent directory is not interchangeable with another directory's identities. |
| Redis / multiple replicas | Not needed for the cheapest single-process deployment | Template uses one PDS replica. Do not assume adding replicas is safe without the shared state/configuration described in the template. |

Do not replace AT Protocol repository/signing/identity behavior to fit a cheaper host. This is a hosting comparison, not an audit of complete AT Protocol interoperability.

### Minimum technical requirements

These are **proposed operating budgets**, not benchmarked minimums or guarantees of users served. User count is a poor sizing metric without request rate, record growth, authentication activity, and media volume.

| Resource | Experimental floor | Practical starting point: API + local DB | Comfortable small installation |
|---|---|---|---|
| CPU | 1 shared 64-bit vCPU | 1–2 shared vCPU | 2 shared vCPU or more |
| RAM available to this stack | 1 GB with tuning/swap; not a recommended production target | **2 GB**; build away from the live server | **4 GB**; allows more DB cache and dashboard headroom |
| Persistent storage | 20 GB SSD, very little data | **30–40 GB SSD** initially | **60–80 GB SSD** or more |
| Architecture | Prefer x86-64 | x86-64; ARM64 conditional on successful image build and validation | Same; no 32-bit ARM recommendation |
| OS/runtime | Supported Linux + Node within package engines | Docker Engine + Compose; image uses Node 24 | Same; native Node/systemd is possible with manual maintenance |
| Database | Must support the schema/migrations | PostgreSQL **15**, as used by Compose; current security patches | Validate a newer supported major before adopting it |
| Network | Reliable outbound DNS/HTTPS and database access | Public HTTPS endpoint; recommend dual-stack/IPv4 reachability | Same, with monitoring and bandwidth headroom |
| Home uplink | No protocol-specific minimum established | **10 Mbps upload** is a planning target for light use | Higher for uploads/downloads and concurrent clients |
| Builds | Can exceed runtime budget | Build on a separate machine/CI; allow 2–4 GB available RAM as a starting estimate | 4 GB+ build worker; measure peaks |

Use local SSD-backed storage for PostgreSQL. Avoid a microSD card or ordinary SMB share for the live database. Blob files and backups can use other storage independently. On a NAS, the RAM above must be **spare after the NAS OS and other apps**, not merely installed RAM.

PostgreSQL connections must preserve **session-level advisory locks**: [the DB client](../src/db/client.ts) uses them across multiple statements. Use a direct database connection or a verified session-mode pooler; do not substitute a transaction-mode pooler without addressing that behavior. The app also needs permissions to apply startup migrations.

## Cost model and comparison rules

Baseline: one always-on instance, light activity, roughly **5 GB database + 5 GB blobs**, approximately **20 GB/month public egress**, external PLC, no high availability, and builds off the live host. A 40 GB disk also needs room for OS, images, logs, PostgreSQL WAL, temporary files, and growth; 10 GB of data does not imply a 10 GB server disk is sufficient.

**VPS predicted totals** add an assumed **1–3 units/month in the row's currency** for a small encrypted off-site backup allocation. This is a budgeting allowance, not a quoted backup product, and is not unlimited retention. It assumes local PostgreSQL and local blobs fit on the included disk. Provider snapshots, managed DBs, extra disks, and higher traffic are additional unless stated.

**Excluded everywhere unless stated:** domain registration (budget an estimated €/$10–25/year, or use an existing domain), SMTP (existing/free allowance or an estimated €/$0–5/month), tax, operator time, premium support, and HA. Free email tiers are conditional on provider limits. Do not add a new broadband subscription to an existing-home comparison; do add any incremental ISP/static-IP fee.

Keep EUR and USD separate. netcup's observed German consumer prices are converted to ex-VAT by dividing by 1.19, explicitly shown below. Other tax-inclusive quotes are labelled rather than silently treated as ex-VAT. Bulgaria's 20% VAT, where applicable, makes a €5.99 ex-VAT VM approximately €7.19 before backups and other extras.

### VPS matrix

Every VPS below requires the operator to maintain Linux, PostgreSQL, backups, TLS/proxy configuration, and updates. “Suitable” means the advertised resources fit the proposed budget, **not that this PDS has been tested there**. Shared vCPU performance and availability vary.

| Provider / plan | CPU / RAM / disk | Advertised recurring price and commitment | Predicted light-use monthly total | Advantages | Disadvantages / verdict |
|---|---|---|---|---|---|
| [netcup nano G11.5s](https://www.netcup.com/en/server/vps/vps-nano-g11.5s-iv-6m-nue) | 2 vCore / 2 GB / 60 GB SSD | €3.69 incl. 19% VAT ≈ **€3.10 ex-VAT**; six-month billing/term; IPv4 included | **€4.10–6.10 ex-VAT** | Lowest verified practical entry in this sample; useful disk allowance | One per customer, Nuremberg location, provisioning delays possible; no local block-storage expansion. Limited RAM headroom. |
| [netcup Lite 1 G12.5s](https://www.netcup.com/en/server/vps/vps-lite-1-g12.5s-iv-6m) | 2 vCore / 4 GB / 80 GB SSD | €5.86 incl. 19% VAT ≈ **€4.92 ex-VAT**; six months; IPv4 included | **€5.92–7.92 ex-VAT** | Comfortable RAM at low cost; larger disk | Commitment and automatically chosen European location; sustained-traffic throttling policy. Good budget default. |
| [OVHcloud VPS-1, 2027 range](https://www.ovhcloud.com/en/vps/) | 2 vCore / 4 GB / 40 GB NVMe | **From $4.54/month**, worldwide page; actual region/term/tax quote must be checked | **From $5.54–7.54**, plus tax/quote differences | 4 GB RAM; daily backup advertised; generous traffic in eligible regions | “From” price is conditional; smaller disk; APAC traffic quotas differ. Keep independent backups despite included backup. Strong candidate after checkout verification. |
| [Hetzner CX23, DE/FI](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) | 2 vCPU / 4 GB / 40 GB NVMe ([plan](https://www.hetzner.com/cloud/cost-optimized/)) | **€5.49 ex-VAT + €0.50 IPv4 = €5.99**; hourly with monthly cap | **€6.99–8.99 ex-VAT** | Flexible billing; 4 GB; straightforward Docker host | Public plan page showed **currently unavailable** during research; check console capacity. IPv4 and provider backups cost extra. Competitive when obtainable. |
| [Contabo Cloud VPS 4](https://contabo.com/en-us/vps/) | 4 vCPU / 8 GB / 100 GB SSD on indexed offer | **€4.40/month first 24 months**, reference price €5.50; page describes effective term rate incl. applicable taxes; setup fee may apply | **€5.40–7.40 intro**, then budget **€6.50–8.50** at reference rate, plus setup/region differences | Large RAM/disk allocation per euro | Live page fetch blocked during research; indexed first-party offers and support page disagree on disk option. Confirm cart, tax, renewal and provisioning; lower confidence than directly readable quotes. |
| [IONOS VPS S+](https://www.ionos.com/servers/vps.html) | 1 vCore / 2 GB / 60 GB NVMe | **$2 for 3 months, then $6**, one-year term; IPv4 included | **$6–8 first-year average**; **$7–9 ongoing**, before tax | Low entry commitment cost; useful disk; no need for managed DB | $2 headline is temporary. First-year VM average is $5/month, not $2. Adequate small-instance candidate. |
| [Hostinger KVM 1](https://www.hostinger.com/vps-hosting) | 1 vCPU / 4 GB / 50 GB NVMe | **$6.49/month**, $155.76 prepaid for 24 months; **renews $11.99/month** for same term | **$7.49–9.49 intro; $12.99–14.99 renewal**, before tax | 4 GB RAM; approachable management tools | Large prepayment, substantial renewal increase; self-managed despite panel. Compare over several years. |
| [DigitalOcean Basic Regular](https://www.digitalocean.com/pricing/droplets) | 1 vCPU / 2 GB / 50 GiB SSD; 2,000 GiB transfer | **$12/month**, usage billing with monthly cap | **$13–15**, before tax | Clear published pricing and documentation; flexible provisioning | Roughly twice the cost of budget alternatives; 2 GB still needs conservative operation. |
| [AWS Lightsail Linux, public IPv4](https://aws.amazon.com/lightsail/pricing/) | 2 vCPU / 2 GB / 60 GB SSD; 3 TB transfer | **$12/month**; excludes temporary trial credits | **$13–15**, before tax | Bundled IPv4/storage/transfer; simple AWS VM route | Burstable CPU; snapshots cost extra; regional transfer terms vary. No RDS needed at this scale. |
| [Vultr Regular](https://www.vultr.com/pricing/) | Provisional comparator: 1 vCPU / 2 GB / 55 GB | **Budget $10/month provisionally** | **$11–13 provisional**, before tax | Many possible deployment regions; regular VM model | Pricing endpoint returned 403; exact current plan/region price not independently confirmed here. Excluded from cheapest verified ranking. |
| [Akamai / Linode Shared](https://www.akamai.com/cloud/pricing) | Provisional comparator: 1 vCPU / 2 GB / 50 GB | **Budget $12/month provisionally** | **$13–15 provisional**, before tax | Established VM platform; shared CPU appropriate for light workloads ([docs](https://techdocs.akamai.com/cloud-computing/docs/shared-cpu-compute-instances)) | Public pricing response did not expose the selected current plan; confirm in Cloud Manager/API. Excluded from cheapest verified ranking. |
| [Oracle Always Free A1](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | ARM allocation up to 2 OCPUs / 12 GB across Always Free tenancy; storage quotas separate | **$0 within eligible quotas**, not trial credit | **$1–3** assumed independent backup allowance | More than enough nominal resources for a small stack without compute charge | Capacity shortages, home-region/quota rules, and idle reclamation; ARM build untested here. Trial/PAYG entitlements differ. Experimental choice. |

Hetzner's official [IPv4 pricing](https://docs.hetzner.com/cloud/servers/primary-ips/overview/) confirms the €0.50 surcharge. Its [backup documentation](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/) states that attached volumes are excluded from server backups. Do not assume a VM snapshot protects separate blob/DB volumes.

The netcup catalog and search snapshots contained older, lower G11s/G12s prices. The table uses the directly opened **G11.5s/G12.5s** offers instead. Oracle likewise now documents **2 OCPUs / 12 GB** for Always Free tenancies; older 4 OCPU / 24 GB articles should not set a new-install budget.

Very cheap 512 MB/1 GB instances, IPv6-only/NAT VPS offers, annual flash sales, and spot/preemptible VMs can cost less. They are not the recommended baseline: RAM headroom, stable public reachability, recovery, or availability is compromised. An IPv6-only price also needs an ingress solution reachable by IPv4 clients.

### Railway and application platforms

| Platform | Price basis | Predicted monthly cost | Pros | Cons / suitability |
|---|---|---|---|---|
| [Railway Hobby](https://railway.com/pricing) | $5 minimum **includes $5 usage**; memory $0.00000386/GB/s, CPU $0.00000772/vCPU/s, volume $0.00000006/GB/s, service egress $0.05/GB | **$7–18 API + DB** on a small footprint; **$10–25 with dashboard**; storage/plan constraints below | Existing template and setup flow; automatic public TLS; no Linux host to administer | Usage varies; database consumes billed resources too. Hobby advertises only up to 5 GB volume storage; the 10 GB local-data baseline cannot be assumed to fit. |
| [Railway Pro](https://railway.com/pricing) | $20 minimum includes $20 usage; larger volume allowance | **$20–35+** at light use | More appropriate storage allowance and team features | Higher floor; still maintain DB recovery and durable secrets. |
| [Render paid services](https://render.com/pricing) | 512 MB app $7; 2 GB app $25; persistent app disks $0.25/GB/month; DB charged separately | **Planning allowance $20–45+**, depending on DB/app tier and traffic | Managed application deployment and paid managed PostgreSQL | No existing repo-specific template assessed; 512 MB app is a constrained experiment. Not a cost winner against one VPS; obtain DB quote. |

Railway example, **30-day month**, API + DB combined averages of **0.5 GB RAM and 0.05 vCPU**, **5 GB total billed volumes**, and **20 GB service egress**:

`0.5 × $10.00512 + 0.05 × $20.01024 + 5 × $0.15552 + 20 × $0.05 = $7.78/month`

Hobby invoice is approximately `max($5, $7.78)`, **not $5 + $7.78**. Add $1–3 assumed independent backups → **$8.78–10.78**. This is a **reduced-storage scenario**, not the 10 GB baseline. At 1 GB average RAM, 0.1 vCPU, and the same storage/egress, resources become approximately $13.78 before backups. Dashboard/PLC/extra DB usage is additive. Verify whether storage limits apply per volume/service in the selected plan and obtain a quote before deployment.

The [current template](RAILWAY-TEMPLATE.md) includes a dashboard; removing it changes the installed experience. A separate own-PLC stack consumes additional CPU, RAM, and DB storage. Sleeping/free services and expiring free databases are poor foundations for an always-reachable identity provider. Serverless functions/edge workers are not a drop-in deployment target for this persistent Node/PostgreSQL application.

## Shared hosting matrix

Shared CPU VPS hosting above is different from cPanel/managed shared **web hosting** below. A “Node.js supported” badge does not prove this application's ESM, workspace build, persistent files, startup migrations, scheduled work, or OAuth routes will work.

| Provider / product | Cost assumption | Technical fit | Pros | Cons / verdict |
|---|---|---|---|---|
| [Namecheap Stellar Plus / Business](https://www.namecheap.com/support/knowledgebase/article.aspx/10112/22/shared-hosting-plans-comparison/) | Plus $85.44/year ≈ **$7.12/month**; Business $128.88/year ≈ **$10.74/month**, before tax; add backup allowance | Node 22/24 available, but [published software list](https://www.namecheap.com/support/knowledgebase/article.aspx/129/22/what-version-of-the-software-is-used-on-your-servers/) lists **PostgreSQL 10.23**. Base Stellar lacks PostgreSQL. | Node and DB in one subscription | PostgreSQL 10 is [out of upstream support](https://www.postgresql.org/support/versioning/). **Do not recommend with listed bundled DB**; require a supported DB and successful runtime/migration tests. |
| [Hostinger Business/Cloud Node hosting](https://www.hostinger.com/support/node-js-hosting-options-at-hostinger/) | **Estimated hosting allowance $5–20/month**, term-dependent; external DB/backup can make total **$10–40+**. Not a verified checkout quote. | [Supports Express and Node 22/24](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/); [local PostgreSQL unavailable](https://www.hostinger.com/support/which-databases-and-data-tools-are-supported-at-hostinger/), [external PostgreSQL supported](https://www.hostinger.com/support/connecting-a-supabase-database-to-a-hostinger-node-js-application/) | Potential reuse of an existing subscription; managed Node deploys | External DB adds cost/latency and a second dependency; verify session-mode connectivity, durable settings/blobs, jobs, and process lifecycle. **Conditional experiment**, not validated deployment. |
| [SiteGround GrowBig](https://www.siteground.com/web-hosting.htm) | **$3.99/month first prepaid year; $29.99 renewal**, plus independent backup allowance | [Current docs](https://www.siteground.com/academy/node-js-api-hosting) say Node starts at GrowBig, PostgreSQL available, **WebSockets unsupported** | Bundled database/TLS/backups; could be cheap in year one | Confirm supported PG version, resource quota, Node build and background jobs. Proxy restrictions constrain future protocol needs; renewal destroys the price advantage. **Conditional**, not a general PDS recommendation. |
| [DreamHost shared web hosting](https://help.dreamhost.com/hc/en-us/articles/217141627-Supported-and-unsupported-technologies) | **No viable shared-plan PDS total**; upgrading changes the product | Shared does not support Node.js or PostgreSQL per provider docs | Suitable for conventional websites | **Unsuitable for this stack**. Managed VPS also does not automatically provide the needed PostgreSQL/root capabilities. |

Before choosing shared hosting, require confirmation of supported PostgreSQL, direct/session-mode DB connections, migration permissions, Node 24 or compatible engines, sufficient process RAM, ESM startup, stable filesystem or S3, automatic restarts, background task execution, logs, outbound HTTPS/SMTP, and proxy limits. Validate public OAuth discovery, authentication, record writes, blob retrieval, and restore behavior. These checks are compatibility work, not optional performance tuning.

## Self-hosted hardware: cost and practicality

All purchase prices, wattages, and power costs in this section are **planning estimates**, not retailer quotes or measured PDS consumption. Hardware budgets include a usable SSD where applicable; exclude UPS and optional networking upgrades. ARM64 is a candidate requiring build validation, not a certified target.

Power model: **30 days × 24 hours**, electricity **€0.25/kWh**. Monthly power cost = `watts × 0.72 × tariff`; at this tariff, each continuous watt costs **€0.18/month**. Substitute the actual marginal electricity tariff and measured wall power.

| Hardware option | Minimum practical configuration | Estimated purchase | Estimated wall power | Monthly power + €1–3 backup allowance | Pros / cons |
|---|---|---|---|---|---|
| Existing always-on NAS/server | 2 GB spare RAM; 4 GB preferred; SSD space; container support | **€0** if suitable | **1–5 W incremental** | **€1.18–3.90 incremental** | Cheapest reuse; shared maintenance/outage domain. Continuous DB activity may prevent disk sleep, increasing actual power. |
| Used thin client / mini PC | x86-64; 4–8 GB RAM; 64–128 GB+ SSD | **€60–150** | **5–12 W total** | **€1.90–5.16** | Often better complete-system value than a new SBC; inspect SSD, PSU, firmware, and spare parts. |
| Raspberry Pi 4/5 or ARM SBC | 64-bit OS; preferably 4 GB RAM; SSD + reliable PSU/cooling | **€150–250** complete planning budget | **4–8 W total** | **€1.72–4.44** | Low power, compact; architecture/build checks and accessories required. Avoid database on microSD. |
| New efficient mini PC | x86-64; 8 GB RAM; 128–256 GB SSD | **€150–300** | **6–15 W total** | **€2.08–5.70** | Comfortable headroom; more upfront cost than renting a small VPS. |
| Existing desktop/laptop kept on solely for PDS | 4 GB+ RAM; SSD; sleep disabled | **€0**, if owned | **20–60 W total** | **€4.60–13.80** | Easy trial; electricity can exceed VPS cost. Laptop power management/reboots complicate uptime. |
| Dedicated new 2-bay NAS | Container-capable model; preferably 8 GB installed RAM; SSD capacity | **€350–700+** with usable storage | **15–35 W total** | **€3.70–9.30** | Useful if NAS storage is also needed; financially weak purchase solely for PDS. |
| Old rack server | Spare RAM and SSD storage | Variable; often cheap used | **60–150 W total** | **€11.80–30.00** | Excellent lab capacity; poor economics for one small identity service. |

Raspberry Pi prices have risen repeatedly; the official [October 2026 announcement](https://www.raspberrypi.com/news/price-increases-for-2gb-raspberry-pi-4-and-raspberry-pi-5/) puts even the 2 GB Pi 5 board at $77.50 before accessories. Do not use launch-era $35–60 board prices as complete-system costs.

### NAS / home-server platform matrix

The deployment paths below are inferred from documented platform capabilities. **None was installation-tested for OpenFederation PDS during this research.** No native PDS catalog packages are established by this document. Budget **2–4 GB spare RAM** and persistent SSD capacity for the stack; host OS requirements are additional. Costs refer to the hardware table above.

| Platform | Deployment path / minimum platform condition | Advantages | Limitations / assessment |
|---|---|---|---|
| [Synology DSM + Container Manager](https://www.synology.com/en-global/dsm/packages/ContainerManager) | Supported model and DSM/package combination; Compose project or equivalent containers; map persistent folders | Familiar UI, snapshots and backup tooling | Check exact applied-model list; “Synology” or “Plus” alone is not a compatibility guarantee. Validate ARM64 where relevant and folder ownership. Strong reuse candidate. |
| [QNAP QTS/QuTS + Container Station](https://www.qnap.com/en/how-to/tutorial/article/container-station-quick-start-guide) | Supported 64-bit x86/ARM model; multi-container application | Docker management and existing storage | Platform's 1 GB Docker minimum is not sufficient sizing for OS + this PDS + DB. Exclude 32-bit configurations; check Compose features and UID permissions. Strong reuse candidate. |
| [ASUSTOR ADM + Docker/Portainer](https://www.asustor.com/online/College_topic?topic=145) | Supported App Central model; Portainer stack or Compose | Container UI and persistent folder mappings | Match image architecture/model; app availability varies. Manual environment and proxy setup. Viable candidate. |
| [TerraMaster TOS Container Manager](https://help.terra-master.com/docs/TOS7/application/container-manager) | Model/TOS version supporting Docker and Compose | Documented multi-container orchestration | TOS 7 documentation does not establish support on every older/entry-level NAS. Verify exact device and resources. Viable candidate. |
| [UGREEN UGOS Pro Docker](https://support.ugnas.com/detail/article/en-US/236) | Supported Docker-capable device; Compose Project | Project UI manages related containers | Model exceptions exist: [provider documentation](https://support.ugnas.com/detail/article/ja-JP/772) excludes DH2300 4 GB from Docker currently. Vendor remote-access shortcuts do not prove public PDS reachability. Viable on supported models. |
| [TrueNAS Linux/SCALE-derived releases](https://apps.truenas.com/managing-apps/installing-custom-apps/) | Docker-based Apps release; Custom App via YAML; budget **12–16 GB host RAM** as an engineering starting point for NAS + stack | ZFS datasets/snapshots; Compose support | Host memory/storage overhead is substantial. Keep app datasets persistent. TrueNAS CORE/FreeBSD is a different target: use a Linux VM or another host, not Linux Docker directly. |
| [Unraid](https://docs.unraid.net/unraid-os/troubleshooting/faq/) | Docker containers, Compose tooling, or a Linux VM; preferably 8 GB+ host RAM | Existing Docker ecosystem; flexible storage | Paid OS. [Licensing FAQ](https://docs.unraid.net/unraid-os/faq/licensing-faq/) lists **$36/year update extensions** for Starter/Unleashed after included update entitlement. Put live DB on an SSD pool and account for mover behavior. |
| [OpenMediaVault + OMV-Extras Compose](https://wiki.omv-extras.org/doku.php?id=omv8%3Aomv8_plugins%3Asummary_omv8_plugins) | Supported Debian hardware; Compose plugin from OMV-Extras | No mandatory OS fee; reuse low-power hardware | Plugin is an extra community layer; manage updates and storage mappings. Good DIY option. |
| Linux + Docker / Proxmox Linux VM | Supported x86-64 host; give VM 2–4 GB RAM and 30–80 GB SSD | Portable deployment, clear isolation and recovery | Operator manages host + guest. A Linux VM is the conservative Proxmox route; nested Docker in LXC introduces extra permissions/storage considerations. |
| CasaOS / Umbrel / similar home dashboards | Only if custom containers/Compose or a Linux guest are supported on the selected version | Potentially convenient on hardware already owned | No verified PDS package/import path researched here. Treat as manual Docker integration, not one-click support. |
| Legacy WD/other closed NAS, router, 32-bit ARM appliance | No supported 64-bit runtime, insufficient RAM, or no durable app storage | Can sometimes store backups | **Unsuitable as the PDS compute host**; use a separate mini PC or VPS. |

### Public connectivity can dominate home-hosting cost

- With a routable public IP, use DNS/DDNS and forward HTTPS to a reverse proxy. Dynamic IP is workable if DNS updates reliably; the public hostname must remain stable.
- With **CGNAT**, ordinary port forwarding will not work. Options are a paid public/static IP from the ISP, an outbound tunnel with a public hostname, or a small VPS reverse proxy over a private tunnel. Budget an estimated **€0–10+/month**, depending on the option; obtain an ISP quote.
- A tunnel must expose a **public, unauthenticated-at-the-proxy PDS endpoint** so protocol clients can reach discovery and auth routes. Do not put the entire API behind an interactive NAS login, private VPN, or access gateway. Keep administrative surfaces private separately.
- Validate upload/time limits, forwarded headers, client IP rate limiting, and any needed streaming support. Configure `EXPRESS_TRUST_PROXY` for the actual trusted proxy chain; preserve authentication/rate-limit protections.
- NAS vendor remote-access services and private mesh VPN access are not automatically public federation ingress. A reverse tunnel also adds a provider/network dependency.
- Expose the PDS proxy, not PostgreSQL or the NAS administration UI. Home power, ISP failures, maintenance, and reboots affect login availability. A UPS helps only while its battery and upstream network last.

## Ownership cost: buying hardware versus renting

Illustrative **36-month**, pre-tax planning comparison; same €1/month backup assumption for each row. Excludes domain, SMTP, labor, UPS, repairs and paid home ingress. No residual hardware value. These use EUR pricing only, avoiding currency-conversion assumptions.

| Option | Calculation | 36-month total |
|---|---|---:|
| netcup nano | (€3.69 / 1.19 + €1) × 36 | **≈ €147.63** |
| netcup Lite 1 | (€5.86 / 1.19 + €1) × 36 | **≈ €213.28** |
| Hetzner CX23 + IPv4 | (€5.49 + €0.50 + €1) × 36 | **€251.64** |
| Existing NAS, +3 W incremental | (3 × €0.18 + €1) × 36 | **€55.44 incremental** |
| Used mini PC, €100, 8 W | €100 + (8 × €0.18 + €1) × 36 | **€187.84** |
| Complete SBC, €180, 6 W | €180 + (6 × €0.18 + €1) × 36 | **€254.88** |
| New NAS, €450, 20 W | €450 + (20 × €0.18 + €1) × 36 | **€615.60** |

A €100 mini PC at 8 W breaks even against a €5.99/month VM in about **22 months**: `100 / (5.99 − 1.44)`, with equal backup costs cancelling out. Against the €3.10/month nano it takes about **60 months**. A €5/month paid ingress fee removes that saving against either VM at these assumptions. Existing always-on hardware has a much stronger case than newly purchased hardware.

## Operational minimum and next validation

The cheapest sensible installation still needs an **independent, restorable backup of PostgreSQL, blobs, and persistent configuration/secrets**. Encrypted signing/recovery keys cannot be recovered from a DB dump without the encryption secret. Preserve OAuth keys across restarts. Never back up a user's primary rotation key on the server contrary to the project's key-custody rules. RAID and same-device snapshots do not cover device loss or an administrator deleting the data.

Start with a single instance. Build off-host, deploy, and measure at least a normal usage period including a restart, migration, backup, restore, and an authentication/write burst. Record API/DB memory peaks, CPU, latency, connection counts, disk/WAL growth, and public egress. Increase capacity before sustained swap pressure or disk exhaustion; keep roughly 20–30% disk headroom as an operating target.

The best first deployment trials are **a 2 GB VPS to establish the practical floor**, **a 4 GB VPS for the recommended experience**, and **one already-owned NAS with spare RAM**. ARM64 builds of both images were verified locally (#405); test on real ARM hardware before promising NAS/SBC compatibility. Prebuilt multi-architecture images (`ghcr.io/athlon-misa/openfederation-pds` and `-dashboard`) are built by `.github/workflows/images.yml` and published with each PDS release, so small devices never build from source.

Repository caveats: the root `docker-compose.yml` is for development (API and database only). For a server, use the appliance stack in `deploy/appliance/` (PDS, PostgreSQL, dashboard and Caddy with automatic HTTPS), installed by `deploy/install.sh`, or `deploy/synology/` on a Synology; see the [install guides](install/README.md). These have been tested in containers but not yet on real VPS or NAS hardware, and none is a NAS app-store package. Also, the cost paragraph in [RAILWAY.md](../RAILWAY.md) contains older billing assumptions: use current provider rates and the model above for this comparison.
