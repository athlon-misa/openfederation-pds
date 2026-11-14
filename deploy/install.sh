#!/usr/bin/env bash
# OpenFederation PDS installer for a Linux server (#405).
#
# What it does, in order (nothing else):
#   1. checks the server: Linux, 64-bit (x86-64 or ARM64), memory, disk, and
#      that ports 80 and 443 are free;
#   2. installs Docker Engine and the Compose plugin from Docker's official
#      repository, if they are missing (Debian and Ubuntu; elsewhere it stops
#      and says what to install);
#   3. asks for your addresses (or takes them from the options below) and
#      checks that they point at this server in DNS;
#   4. writes the stack to /opt/openfederation (compose.yaml, Caddyfile, .env
#      with a generated database password) and creates the data folder;
#   5. on servers with less than 3 GB of memory and no swap, adds a 2 GB swap
#      file (skip with --no-swap); opens 80/443 in ufw if ufw is active;
#   6. starts it, waits until the PDS answers, and prints the setup code.
#
# Recommended: download, read, then run.
#   curl -fsSLO https://raw.githubusercontent.com/athlon-misa/openfederation-pds/main/deploy/install.sh
#   less install.sh
#   sudo bash install.sh
#
# Running it again is safe: it keeps the existing database password and data,
# refreshes compose.yaml and the Caddyfile (keeping a copy of any you edited),
# and starts or updates the stack.
#
# Options:
#   --pds-domain NAME        the PDS address, e.g. pds.example.org
#   --dashboard-domain NAME  the dashboard address, e.g. dashboard.example.org
#   --handle-domain NAME     the domain people's names go under, e.g. example.org
#                            (optional; "none" for no suggestion)
#   --dir PATH               install folder (default /opt/openfederation)
#   --version TAG            image version (default latest)
#   --yes                    do not ask; use the options and defaults
#   --skip-dns-check         do not check that the addresses point here
#   --no-swap                never add a swap file
#   --dry-run                check and write the files, but install, change
#                            and start nothing (no root needed if --dir is
#                            writable)
#   -h, --help               this text

set -euo pipefail

INSTALL_DIR=/opt/openfederation
VERSION=latest
PDS_DOMAIN=""
DASHBOARD_DOMAIN=""
HANDLE_DOMAIN=""
HANDLE_DOMAIN_SET=0
ASSUME_YES=0
SKIP_DNS=0
NO_SWAP=0
DRY_RUN=0
MIN_RAM_MB=1800
SWAP_BELOW_MB=3000
MIN_DISK_GB=10
WARN_DISK_GB=25

# ---------------------------------------------------------------- output ----
if [ -t 1 ]; then BOLD=$'\e[1m'; RED=$'\e[31m'; YEL=$'\e[33m'; GRN=$'\e[32m'; RST=$'\e[0m'; else BOLD=""; RED=""; YEL=""; GRN=""; RST=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RST"; }
ok()   { printf '  %sok%s    %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %swarn%s  %s\n' "$YEL" "$RST" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then say "  (dry run) would run: $*"; else "$@"; fi; }

usage() { sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# --------------------------------------------------------------- options ----
while [ $# -gt 0 ]; do
  case "$1" in
    --pds-domain) PDS_DOMAIN="${2:-}"; shift 2 ;;
    --dashboard-domain) DASHBOARD_DOMAIN="${2:-}"; shift 2 ;;
    --handle-domain) HANDLE_DOMAIN="${2:-}"; HANDLE_DOMAIN_SET=1; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    --no-swap) NO_SWAP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ -n "$INSTALL_DIR" ] || die "--dir needs a folder."
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || die "--version must look like 1.6.0 or latest."

interactive() { [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; }

ask() { # ask VAR "question" "default"
  local __var=$1 __q=$2 __def=${3:-} __ans
  if interactive; then
    if [ -n "$__def" ]; then read -r -p "  $__q [$__def]: " __ans; else read -r -p "  $__q: " __ans; fi
    __ans=${__ans:-$__def}
  else
    __ans=$__def
  fi
  printf -v "$__var" '%s' "$__ans"
}

confirm() { # confirm "question" -> 0 for yes; --yes answers yes
  local ans
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  read -r -p "  $1 [y/N]: " ans
  [[ "$ans" =~ ^[Yy] ]]
}

valid_domain() {
  local d=$1
  [ ${#d} -le 253 ] || return 1
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------- checks ----
OS_ID=""; OS_LIKE=""; OS_CODENAME=""; OS_NAME="unknown"
os_release() { # os_release KEY -> its value from /etc/os-release, or nothing
  # shellcheck disable=SC1091
  (. /etc/os-release && eval "printf '%s' \"\${$1:-}\"")
}
check_system() {
  step "Checking this server"
  [ "$(uname -s)" = Linux ] || die "This installer is for Linux servers. On a NAS, see docs/install/synology.md."

  if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
    die "Run it as root: sudo bash $0"
  fi

  if [ -r /etc/os-release ]; then
    # Read in a subshell: os-release defines VERSION, ID and friends, which
    # must not overwrite this script's own variables.
    OS_ID=$(os_release ID); OS_LIKE=$(os_release ID_LIKE); OS_NAME=$(os_release PRETTY_NAME)
    OS_CODENAME=$(os_release UBUNTU_CODENAME); [ -n "$OS_CODENAME" ] || OS_CODENAME=$(os_release VERSION_CODENAME)
    [ -n "$OS_NAME" ] || OS_NAME=${OS_ID:-unknown}
  fi
  ok "System: $OS_NAME"

  case "$(uname -m)" in
    x86_64|amd64) ok "Processor: x86-64" ;;
    aarch64|arm64) ok "Processor: ARM64" ;;
    *) die "Processor $(uname -m) is not supported. The images are built for x86-64 and ARM64 only (no 32-bit)." ;;
  esac

  local mem_kb mem_mb swap_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
  mem_mb=$((mem_kb / 1024))
  RAM_MB=$mem_mb; SWAP_MB=$((swap_kb / 1024))
  if [ "$mem_mb" -lt "$MIN_RAM_MB" ]; then
    die "This server has ${mem_mb} MB of memory; at least 2 GB is needed."
  elif [ "$mem_mb" -lt "$SWAP_BELOW_MB" ]; then
    warn "Memory: ${mem_mb} MB. Enough, but tight: the defaults are sized for 2 GB. 4 GB is more comfortable."
  else
    ok "Memory: ${mem_mb} MB"
  fi

  local probe=$INSTALL_DIR free_gb
  while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
  free_gb=$(df -Pk "$probe" | awk 'NR==2 {print int($4 / 1048576)}')
  if [ "$free_gb" -lt "$MIN_DISK_GB" ]; then
    die "Only ${free_gb} GB free on the disk holding $INSTALL_DIR; at least ${MIN_DISK_GB} GB is needed."
  elif [ "$free_gb" -lt "$WARN_DISK_GB" ]; then
    warn "Disk: ${free_gb} GB free. Enough to start; plan for 30 GB or more as data grows."
  else
    ok "Disk: ${free_gb} GB free"
  fi

  check_ports
}

port_in_use() { # port_in_use 80 -> prints what listens, returns 0 when in use
  local p=$1 out=""
  if command -v ss >/dev/null 2>&1; then
    out=$(ss -Htlnp "sport = :$p" 2>/dev/null || true)
  elif command -v netstat >/dev/null 2>&1; then
    out=$(netstat -tlnp 2>/dev/null | awk -v p=":$p" '$4 ~ p"$"' || true)
  fi
  [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  return 1
}

check_ports() {
  local p who
  if ! command -v ss >/dev/null 2>&1 && ! command -v netstat >/dev/null 2>&1; then
    warn "Cannot check ports 80 and 443 (neither ss nor netstat is installed); continuing."
    return
  fi
  for p in 80 443; do
    if who=$(port_in_use "$p"); then
      if printf '%s' "$who" | grep -q 'docker-proxy' && stack_running; then
        ok "Port $p: used by this stack (already running)"
      else
        warn "Port $p is already in use:"
        printf '        %s\n' "$who"
        [ "$DRY_RUN" = 1 ] || die "Ports 80 and 443 must be free for HTTPS. Stop the web server using them (for example: systemctl disable --now nginx apache2), then run this again."
      fi
    else
      ok "Port $p: free"
    fi
  done
}

stack_running() {
  command -v docker >/dev/null 2>&1 && [ -f "$INSTALL_DIR/compose.yaml" ] &&
    [ -n "$(docker compose --project-directory "$INSTALL_DIR" ps -q caddy 2>/dev/null || true)" ]
}

# ---------------------------------------------------------------- docker ----
debian_family() {
  case "$OS_ID" in debian|ubuntu) return 0 ;; esac
  case " $OS_LIKE " in *" ubuntu "*|*" debian "*) return 0 ;; esac
  return 1
}

docker_repo_os() { # which of Docker's repositories fits: ubuntu or debian
  if [ "$OS_ID" = ubuntu ] || [[ " $OS_LIKE " == *" ubuntu "* ]]; then echo ubuntu; else echo debian; fi
}

install_docker() {
  step "Docker"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(installed)') with $(docker compose version --short 2>/dev/null | sed 's/^/Compose /')"
    return
  fi
  if ! debian_family; then
    die "Docker Engine with the Compose plugin is needed. This installer sets it up on Debian and Ubuntu only.
       On $OS_NAME, install it by following https://docs.docker.com/engine/install/
       (Fedora, RHEL, CentOS Stream, Rocky/Alma via the RHEL instructions, SLES, Raspberry Pi OS 64-bit),
       then run this installer again."
  fi
  [ -n "$OS_CODENAME" ] || die "Could not tell which $OS_NAME release this is (no VERSION_CODENAME in /etc/os-release)."
  local repo_os; repo_os=$(docker_repo_os)
  if command -v docker >/dev/null 2>&1; then
    say "  Docker is installed but the Compose plugin is not; adding it from Docker's repository."
  else
    say "  Installing Docker Engine and the Compose plugin from Docker's official repository"
    say "  (https://download.docker.com/linux/$repo_os, release $OS_CODENAME)."
  fi
  if [ "$DRY_RUN" = 1 ]; then say "  (dry run) would add Docker's apt repository and install docker-ce, docker-compose-plugin"; return; fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$repo_os/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$repo_os" "$OS_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker was installed but 'docker compose' does not work."
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version) installed"
}

# --------------------------------------------------------------- domains ----
read_existing_env() { # existing .env values become the defaults on a re-run
  local f="$INSTALL_DIR/.env" line key val
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    case "$key" in
      PDS_DOMAIN) [ -n "$PDS_DOMAIN" ] || PDS_DOMAIN=$val ;;
      DASHBOARD_DOMAIN) [ -n "$DASHBOARD_DOMAIN" ] || DASHBOARD_DOMAIN=$val ;;
      HANDLE_DOMAIN) [ "$HANDLE_DOMAIN_SET" = 1 ] || { HANDLE_DOMAIN=$val; HANDLE_DOMAIN_SET=1; } ;;
      POSTGRES_PASSWORD) EXISTING_DB_PASSWORD=$val ;;
    esac
  done < "$f"
}

choose_domains() {
  step "Addresses"
  read_existing_env
  if [ -z "$PDS_DOMAIN" ]; then
    interactive || die "Give the PDS address with --pds-domain (e.g. --pds-domain pds.example.org)."
    say "  The PDS needs its own name, for example pds.example.org, with a DNS record pointing here."
    ask PDS_DOMAIN "PDS address" ""
  fi
  PDS_DOMAIN=$(lower "$PDS_DOMAIN")
  valid_domain "$PDS_DOMAIN" || die "'$PDS_DOMAIN' does not look like a domain name (like pds.example.org)."

  local parent=${PDS_DOMAIN#*.}
  [[ "$parent" == *.* ]] || parent=$PDS_DOMAIN
  [ -n "$DASHBOARD_DOMAIN" ] || ask DASHBOARD_DOMAIN "Dashboard address" "dashboard.$parent"
  DASHBOARD_DOMAIN=$(lower "$DASHBOARD_DOMAIN")
  valid_domain "$DASHBOARD_DOMAIN" || die "'$DASHBOARD_DOMAIN' does not look like a domain name."
  [ "$DASHBOARD_DOMAIN" != "$PDS_DOMAIN" ] || die "The dashboard needs a different address from the PDS."

  if [ "$HANDLE_DOMAIN_SET" = 0 ]; then
    ask HANDLE_DOMAIN "Domain for people's names (alice.$parent), or 'none'" "$parent"
  fi
  HANDLE_DOMAIN=$(lower "$HANDLE_DOMAIN")
  [ "$HANDLE_DOMAIN" != none ] || HANDLE_DOMAIN=""
  [ -z "$HANDLE_DOMAIN" ] || valid_domain "$HANDLE_DOMAIN" || die "'$HANDLE_DOMAIN' does not look like a domain name."

  ok "PDS:       https://$PDS_DOMAIN"
  ok "Dashboard: https://$DASHBOARD_DOMAIN"
  if [ -n "$HANDLE_DOMAIN" ]; then ok "Names:     alice.$HANDLE_DOMAIN"; else ok "Names:     (set in the setup wizard)"; fi
}

local_addresses() {
  { if command -v ip >/dev/null 2>&1; then
      ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    else
      hostname -I 2>/dev/null | tr ' ' '\n'
    fi; } | grep -v '^$' || true
}

# getent exits 2 for a name that does not resolve; that is an answer, not an error.
resolve() { { getent ahosts "$1" 2>/dev/null || true; } | awk '{print $1}' | sort -u; }

check_dns() {
  step "DNS"
  if [ "$SKIP_DNS" = 1 ]; then warn "Skipped (--skip-dns-check)."; return; fi
  local mine name ips matched all_ok=1 probe
  mine=$(local_addresses | sort -u)
  for name in "$PDS_DOMAIN" "$DASHBOARD_DOMAIN"; do
    ips=$(resolve "$name")
    if [ -z "$ips" ]; then
      warn "$name does not resolve yet. Add an A record (and AAAA for IPv6) pointing at this server."
      all_ok=0; continue
    fi
    matched=$(comm -12 <(printf '%s\n' "$ips") <(printf '%s\n' "$mine") || true)
    if [ -n "$matched" ]; then
      ok "$name -> $(printf '%s' "$matched" | tr '\n' ' ')(this server)"
    else
      warn "$name -> $(printf '%s' "$ips" | tr '\n' ' ')but this server's addresses are: $(printf '%s' "$mine" | tr '\n' ' ')"
      say  "        Fine if a firewall or NAT forwards that address here; otherwise fix the DNS record."
      all_ok=0
    fi
  done
  if [ -n "$HANDLE_DOMAIN" ]; then
    probe="check-$RANDOM.$HANDLE_DOMAIN"
    if [ -n "$(resolve "$probe")" ]; then ok "*.$HANDLE_DOMAIN resolves (people's names will work)"
    else warn "*.$HANDLE_DOMAIN has no record yet. Optional: add it later so names like alice.$HANDLE_DOMAIN work."; fi
  fi
  if [ "$all_ok" = 0 ]; then
    say "  HTTPS certificates are only issued once the addresses point here (DNS changes can take a while)."
    if ! confirm "Continue anyway? Caddy keeps retrying until DNS is right."; then
      [ "$DRY_RUN" = 1 ] || die "Stopped. Fix the DNS records and run this again (or pass --skip-dns-check)."
    fi
  fi
}

# ----------------------------------------------------------------- files ----
random_password() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  else od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; fi
}

write_if_changed() { # write_if_changed FILE (content on stdin); keeps an edited copy
  local f=$1 tmp
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$f" ] && cmp -s "$tmp" "$f"; then rm -f "$tmp"; ok "$f (unchanged)"; return; fi
  if [ -f "$f" ]; then
    cp -p "$f" "$f.$(date +%Y%m%d%H%M%S).bak"
    warn "$f was different; the old one is kept as $f.*.bak"
  fi
  install -m 0644 "$tmp" "$f"; rm -f "$tmp"
  ok "$f"
}

write_stack() {
  step "Writing the stack to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/data/postgres" "$INSTALL_DIR/data/pds" "$INSTALL_DIR/data/caddy"
  chmod 0750 "$INSTALL_DIR/data"
  compose_yaml | write_if_changed "$INSTALL_DIR/compose.yaml"
  caddyfile | write_if_changed "$INSTALL_DIR/Caddyfile"

  local db_password=${EXISTING_DB_PASSWORD:-} envf="$INSTALL_DIR/.env" tmp
  [ -n "$db_password" ] || db_password=$(random_password)
  tmp=$(mktemp)
  cat > "$tmp" <<EOF
# Written by deploy/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Settings for compose.yaml.
# The PDS's own secrets are not here: the setup wizard writes them to
# data/pds/openfederation.env. Keep a copy of that file and of this one.
PDS_DOMAIN=$PDS_DOMAIN
DASHBOARD_DOMAIN=$DASHBOARD_DOMAIN
HANDLE_DOMAIN=$HANDLE_DOMAIN
POSTGRES_PASSWORD=$db_password
OPENFEDERATION_VERSION=$VERSION
PDS_NODE_HEAP_MB=$PDS_HEAP
DASHBOARD_NODE_HEAP_MB=192
POSTGRES_SHARED_BUFFERS=$PG_BUFFERS
POSTGRES_EFFECTIVE_CACHE_SIZE=$PG_CACHE
DATA_DIR=./data
EOF
  # Keep any setting added by hand that this script does not manage.
  if [ -f "$envf" ]; then
    grep -E '^[A-Z_]+=' "$envf" | grep -vE '^(PDS_DOMAIN|DASHBOARD_DOMAIN|HANDLE_DOMAIN|POSTGRES_PASSWORD|OPENFEDERATION_VERSION|PDS_NODE_HEAP_MB|DASHBOARD_NODE_HEAP_MB|POSTGRES_SHARED_BUFFERS|POSTGRES_EFFECTIVE_CACHE_SIZE|DATA_DIR)=' >> "$tmp" || true
  fi
  install -m 0600 "$tmp" "$envf"; rm -f "$tmp"
  if [ -n "${EXISTING_DB_PASSWORD:-}" ]; then ok "$envf (database password kept)"; else ok "$envf (new database password)"; fi
}

size_memory() { # defaults by installed memory
  if [ "${RAM_MB:-2048}" -ge 3500 ]; then PDS_HEAP=1024; PG_BUFFERS=512MB; PG_CACHE=1536MB
  else PDS_HEAP=512; PG_BUFFERS=128MB; PG_CACHE=512MB; fi
}

# ---------------------------------------------------------- server tweaks ----
add_swap() {
  [ "$NO_SWAP" = 0 ] || return 0
  [ "${RAM_MB:-9999}" -lt "$SWAP_BELOW_MB" ] || return 0
  [ "${SWAP_MB:-0}" -eq 0 ] || { ok "Swap: ${SWAP_MB} MB already set up"; return 0; }
  step "Swap"
  say "  This server has less than 3 GB of memory and no swap. A 2 GB swap file keeps it"
  say "  from stopping a program when memory runs short (skip with --no-swap)."
  if [ "$DRY_RUN" = 1 ]; then say "  (dry run) would create /swapfile (2 GB) and add it to /etc/fstab"; return; fi
  if [ -e /swapfile ]; then warn "/swapfile exists but is not in use; leaving it alone."; return; fi
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2 GB swap file added (/swapfile)"
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    step "Firewall (ufw)"
    run ufw allow 80/tcp >/dev/null
    run ufw allow 443/tcp >/dev/null
    run ufw allow 443/udp >/dev/null
    ok "ufw allows 80 and 443 (SSH is not changed)"
  fi
}

# ----------------------------------------------------------------- start ----
compose() { docker compose --project-directory "$INSTALL_DIR" "$@"; }

start_stack() {
  step "Starting"
  if [ "$DRY_RUN" = 1 ]; then
    say "  (dry run) would run: docker compose pull && docker compose up -d  (in $INSTALL_DIR)"
    return
  fi
  if ! compose pull --quiet; then
    warn "Could not download the images; starting with the ones already on this server, if any."
  fi
  compose up -d --remove-orphans
  say "  Waiting for the PDS to answer (up to 3 minutes)..."
  local _ health=""
  for _ in $(seq 1 60); do
    health=$(compose exec -T pds wget -q -O - http://127.0.0.1:8080/health 2>/dev/null || true)
    [ -n "$health" ] && break
    sleep 3
  done
  [ -n "$health" ] || die "The PDS did not answer. See: cd $INSTALL_DIR && docker compose logs pds"
  if printf '%s' "$health" | grep -q '"status":"setup"'; then
    SETUP_MODE=1; ok "The PDS is running and waiting to be set up"
  else
    SETUP_MODE=0; ok "The PDS is running: $health"
  fi
}

print_next_steps() {
  local code=""
  if [ "${SETUP_MODE:-0}" = 1 ]; then
    code=$(compose logs --no-log-prefix pds 2>/dev/null | grep -o 'Setup code: [0-9A-Z-]*' | tail -1 | sed 's/Setup code: //' || true)
  fi
  step "Done"
  if [ "$DRY_RUN" = 1 ]; then
    say "  Dry run: files written to $INSTALL_DIR, nothing installed or started."
    return
  fi
  if [ "${SETUP_MODE:-0}" = 1 ]; then
    say ""
    say "  1. Open ${BOLD}https://$PDS_DOMAIN/setup${RST}"
    say "     (the certificate can take a minute after DNS is right)."
    say "  2. Enter this setup code: ${BOLD}${code:-(not found yet; see below)}${RST}"
    say "     It changes every time the PDS restarts. To see it again:"
    say "       cd $INSTALL_DIR && docker compose logs pds | grep 'Setup code'"
    say "  3. Follow the steps. At the end, download the settings file and keep it"
    say "     somewhere safe (a password manager): it holds the server's keys."
  else
    say "  The PDS is set up. Dashboard: https://$DASHBOARD_DOMAIN"
  fi
  say ""
  say "  Everything is in $INSTALL_DIR: compose.yaml, Caddyfile, .env, and data/"
  say "  (database, uploads, settings, certificates). Back up data/ and .env."
  say "  Update later:  cd $INSTALL_DIR && docker compose pull && docker compose up -d"
  say "  Logs:          cd $INSTALL_DIR && docker compose logs -f pds"
}

# ------------------------------------------------------ the stack itself ----
# Exact copies of deploy/appliance/compose.yaml and deploy/appliance/Caddyfile,
# so this one file is all that needs downloading. tests/unit/install-script
# .test.ts fails if they drift apart.
compose_yaml() {
  cat <<'OPENFEDERATION_COMPOSE_YAML'
# OpenFederation "appliance": everything one server needs, in one folder (#405).
#
#   PostgreSQL 15 + the PDS + the dashboard + Caddy (automatic HTTPS)
#
# Usage (deploy/install.sh does all of this for you):
#   cp .env.example .env      # set PDS_DOMAIN, DASHBOARD_DOMAIN, POSTGRES_PASSWORD
#   docker compose up -d
#   docker compose logs pds   # copy the "Setup code", open https://PDS_DOMAIN/setup
#
# No PDS secret goes in .env. The first start runs the setup wizard, which
# generates the secrets and saves them in ./data/pds/openfederation.env.
# Everything that must survive (database, uploads, settings, certificates)
# lives under ./data: back up that folder (see docs/install/vps.md).
#
# Memory: sized for a 2 GB server. With 4 GB or more, raise PDS_NODE_HEAP_MB
# and POSTGRES_SHARED_BUFFERS in .env (see .env.example).

name: openfederation

x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: openfederation
      POSTGRES_USER: openfederation
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env (install.sh generates one)}
    # Small-server tuning. shared_buffers is the database's own cache; the
    # rest of its memory use grows with connections (the PDS opens at most 30).
    command:
      - postgres
      - -c
      - shared_buffers=${POSTGRES_SHARED_BUFFERS:-128MB}
      - -c
      - effective_cache_size=${POSTGRES_EFFECTIVE_CACHE_SIZE:-512MB}
      - -c
      - work_mem=4MB
      - -c
      - maintenance_work_mem=64MB
      - -c
      - max_connections=50
    volumes:
      - ${DATA_DIR:-./data}/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openfederation -d openfederation"]
      interval: 5s
      timeout: 3s
      retries: 10
    logging: *logging
    # Not published: only the PDS reaches the database.

  # One-off: hand the PDS folder to the image's unprivileged user (uid 1000),
  # since a folder Docker creates for a bind mount belongs to root.
  pds-permissions:
    image: ghcr.io/athlon-misa/openfederation-pds:${OPENFEDERATION_VERSION:-latest}
    user: "0"
    entrypoint: ["sh", "-c", "mkdir -p /data/blobs && chown -R 1000:1000 /data"]
    volumes:
      - ${DATA_DIR:-./data}/pds:/data
    restart: "no"
    logging: *logging

  pds:
    image: ghcr.io/athlon-misa/openfederation-pds:${OPENFEDERATION_VERSION:-latest}
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "8080"
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: openfederation
      DB_USER: openfederation
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      # The wizard's settings file and uploaded files, on the persistent folder.
      OPENFEDERATION_CONFIG_FILE: /data/openfederation.env
      BLOB_STORAGE_PATH: /data/blobs
      # Caddy is the one proxy in front of the PDS.
      EXPRESS_TRUST_PROXY: "1"
      # Only pre-fill the setup wizard; they are not configuration.
      SETUP_PUBLIC_URL: ${PDS_PUBLIC_URL:-https://${PDS_DOMAIN:?Set PDS_DOMAIN in .env}}
      SETUP_DASHBOARD_URL: ${DASHBOARD_PUBLIC_URL:-https://${DASHBOARD_DOMAIN:?Set DASHBOARD_DOMAIN in .env}}
      SETUP_DASHBOARD_HOST: ${DASHBOARD_DOMAIN}
      SETUP_HANDLE_DOMAIN: ${HANDLE_DOMAIN:-}
      # Heap ceiling for the PDS (the image's default is 1024 MB).
      NODE_OPTIONS: --max-old-space-size=${PDS_NODE_HEAP_MB:-512}
    volumes:
      - ${DATA_DIR:-./data}/pds:/data
    depends_on:
      postgres:
        condition: service_healthy
      pds-permissions:
        condition: service_completed_successfully
    # /health answers in setup mode too ({"status":"setup"}).
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 60s
    logging: *logging

  dashboard:
    image: ghcr.io/athlon-misa/openfederation-dashboard:${OPENFEDERATION_VERSION:-latest}
    restart: unless-stopped
    environment:
      # Read when the dashboard starts: the address of the PDS it talks to.
      PDS_URL: ${PDS_PUBLIC_URL:-https://${PDS_DOMAIN}}
      NODE_OPTIONS: --max-old-space-size=${DASHBOARD_NODE_HEAP_MB:-192}
    depends_on:
      - pds
    # The image has its own healthcheck (GET /runtime-config.js).
    logging: *logging

  caddy:
    image: caddy:2.10.2-alpine
    restart: unless-stopped
    ports:
      - "${HTTP_PORT:-80}:80"
      - "${HTTPS_PORT:-443}:443"
      - "${HTTPS_PORT:-443}:443/udp"
    environment:
      PDS_DOMAIN: ${PDS_DOMAIN}
      DASHBOARD_DOMAIN: ${DASHBOARD_DOMAIN}
      # The Caddyfile needs a domain here; .invalid can never be in DNS.
      HANDLE_DOMAIN: ${HANDLE_DOMAIN:-handles.invalid}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ${DATA_DIR:-./data}/caddy/data:/data
      - ${DATA_DIR:-./data}/caddy/config:/config
    depends_on:
      - pds
      - dashboard
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging: *logging
OPENFEDERATION_COMPOSE_YAML
}

caddyfile() {
  cat <<'OPENFEDERATION_CADDYFILE'
# Caddy in front of the OpenFederation appliance (#405).
#
# Caddy gets and renews the HTTPS certificates by itself (Let's Encrypt or
# ZeroSSL), as long as ports 80 and 443 reach this server and the names below
# point at it in DNS. The names come from .env (PDS_DOMAIN, DASHBOARD_DOMAIN,
# HANDLE_DOMAIN) through compose.yaml.

{
	# People's names (alice.example.org) get a certificate each, fetched the
	# first time someone opens that name. Caddy asks the PDS first and only
	# goes ahead for a name that is a handle on this server, so nobody can
	# make it request certificates for made-up names.
	on_demand_tls {
		ask http://pds:8080/tls-check
	}
}

# The PDS: AT Protocol API, OAuth, the setup wizard (/setup).
{$PDS_DOMAIN} {
	encode zstd gzip
	# Only Caddy itself needs this question answered.
	@tlscheck path /tls-check
	respond @tlscheck 404
	reverse_proxy pds:8080
}

# The dashboard.
{$DASHBOARD_DOMAIN} {
	encode zstd gzip
	reverse_proxy dashboard:3000
}

# People's names: https://alice.example.org/.well-known/atproto-did, once the
# DNS record *.example.org points here. The two names above have their own
# certificates and are never asked about. Without HANDLE_DOMAIN this block
# stands for *.handles.invalid, a name no DNS record can point at.
*.{$HANDLE_DOMAIN} {
	tls {
		on_demand
	}
	@atproto path /.well-known/atproto-did
	handle @atproto {
		reverse_proxy pds:8080
	}
	handle {
		respond "Not found" 404
	}
}
OPENFEDERATION_CADDYFILE
}

# ------------------------------------------------------------------ main ----
main() {
  say "${BOLD}OpenFederation PDS installer${RST}"
  [ "$DRY_RUN" = 0 ] || say "(dry run: checks and files only)"
  check_system
  install_docker
  choose_domains
  check_dns
  size_memory
  write_stack
  add_swap
  open_firewall
  start_stack
  print_next_steps
}

main
