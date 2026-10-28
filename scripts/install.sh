#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Install or update Zerodot on an Ubuntu or Debian server, with HTTPS from Caddy.
#
#   sudo bash install.sh zerodot.example.com            # asks what it needs to ask
#   sudo bash install.sh --check                     # looks at the server, changes nothing
#   sudo bash install.sh zerodot.example.com --native   # without Docker
#
# Run it again to update. It keeps your .env and your secrets.
# Run `bash install.sh --help` for all options.
set -euo pipefail

ZERODOT_REPO="${ZERODOT_REPO:-https://github.com/zerodot-io/zerodot.git}"
ZERODOT_BRANCH="${ZERODOT_BRANCH:-}"
CADDYFILE="/etc/caddy/Caddyfile"
STATE_FILE=".zerodot-install"

DOMAIN=""
MODE=""            # docker | native
ACTION=""          # update | new
NAME=""
DIR_ARG="${ZERODOT_DIR:-}"
YES=0
CHECK=0
SKIP_PROXY=0
NO_TUI=0

usage() {
  cat <<'EOF'
Usage: install.sh [domain] [options]

  domain          Public address, for example zerodot.example.com. Needed for a new instance.

  --docker        Run with Docker Compose (default).
  --native        Run without Docker: systemd services, host Postgres and Valkey.
  --update        Update an install that exists. Skips the question.
  --new           Set up another instance. Skips the question.
  --name NAME     Name of the instance (default: zerodot). Used for the folder, services and database.
  --dir PATH      Folder for the code (default: /var/www/NAME).
  --no-proxy      Do not touch Caddy. The script prints what to add to your proxy.
  --no-tui        Plain questions instead of dialog screens.
  --check         Look at the server and say what would happen. Changes nothing.
  -y, --yes       Do not ask. Use the default answer.
  -h, --help      This text.

Environment variables:
  ZERODOT_REPO       Git address of the code.
  ZERODOT_BRANCH     Branch to install (default: the default branch of the repository).
  ZERODOT_DIR        Same as --dir.
  DATABASE_URL    Native mode: use this Postgres and do not create a database.
  VALKEY_URL      Native mode: use this Valkey or Redis and do not install one.
EOF
}

while (($#)); do
  case "$1" in
    --docker) MODE=docker ;;
    --native) MODE=native ;;
    --update) ACTION=update ;;
    --new) ACTION=new ;;
    --name) NAME="${2:-}"; shift ;;
    --dir) DIR_ARG="${2:-}"; shift ;;
    --no-proxy) SKIP_PROXY=1 ;;
    --check) CHECK=1 ;;
    --no-tui) NO_TUI=1 ;;
    -y | --yes) YES=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
    *) DOMAIN="$1" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
FAILS=0
WARNS=0
SUGGEST=()

banner() {
  printf '%s' "$B"
  cat <<'ART'

     _____                         _         _
    |__  /  ___   _ __   ___    __| |  ___  | |_
      / /  / _ \ | '__| / _ \  / _` | / _ \ | __|
     / /_ |  __/ | |   | (_) || (_| || (_) || |_
    /____| \___| |_|    \___/  \__,_| \___/  \__|
ART
  printf '%s   Start with a dot.  ·  installer\n\n' "$N"
}

say() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok() { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
note() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; WARNS=$((WARNS + 1)); }
bad() { printf '  %s✘%s %s\n' "$R" "$N" "$*"; FAILS=$((FAILS + 1)); }
tip() { SUGGEST+=("$*"); }
die() { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

have_tty() { [[ -e /dev/tty ]] && (: </dev/tty) 2>/dev/null; }

# ask "prompt" "default"  -> REPLY. Uses the default when --yes or no terminal.
ask() {
  local prompt="$1" default="${2:-}"
  if ((YES)) || ! have_tty; then REPLY="$default"; return; fi
  read -r -p "$prompt" REPLY </dev/tty || REPLY="$default"
  REPLY="${REPLY:-$default}"
}
confirm() { ask "$1 [Y/n] " "Y"; [[ "$REPLY" =~ ^[Yy] ]]; }

# Dialog screens (whiptail). Used on a real terminal unless --no-tui or --yes.
TUI=0
init_tui() {
  if ((NO_TUI == 0 && YES == 0)) && have_tty && [[ -t 1 ]] && [[ "${TERM:-dumb}" != dumb ]] && command -v whiptail >/dev/null 2>&1; then
    TUI=1
  fi
  return 0
}
tui_cancel() { echo; echo "Stopped. Nothing was changed."; exit 0; }
# tui_menu TITLE TEXT TAG ITEM [TAG ITEM ...]  -> REPLY
tui_menu() {
  local title="$1" text="$2"
  shift 2
  REPLY=$(whiptail --title "$title" --menu "$text" 22 78 "$(($# / 2))" "$@" 3>&1 1>&2 2>&3 </dev/tty) || tui_cancel
}
# tui_input TITLE TEXT DEFAULT  -> REPLY
tui_input() { REPLY=$(whiptail --title "$1" --inputbox "$2" 11 78 "$3" 3>&1 1>&2 2>&3 </dev/tty) || tui_cancel; }
# tui_yesno TITLE TEXT  -> status
tui_yesno() { whiptail --title "$1" --yesno "$2" 22 78 </dev/tty; }

ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }
# Do not write `cmd | grep -q`: grep exits early, cmd gets SIGPIPE, and pipefail reports a failure.
port_in_use() { [[ -n "$(ss -ltnH "sport = :$1" 2>/dev/null || true)" ]]; }
unit_exists() { local out; out=$(systemctl list-unit-files "$1" 2>/dev/null || true); [[ "$out" == *"$1"* ]]; }
ufw_active() { command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null || true)" == *"Status: active"* ]]; }
listener() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true; }

RESERVED=""
FREE_PORT=""
# free_port START  -> sets FREE_PORT. Not run in $(...), so RESERVED keeps the ports it picked.
free_port() {
  local p="$1"
  while port_in_use "$p" || [[ " $RESERVED " == *" $p "* ]]; do p=$((p + 1)); done
  RESERVED="$RESERVED $p"
  FREE_PORT="$p"
}

# ---------------------------------------------------------------------------
# Existing installs
# ---------------------------------------------------------------------------
is_zerodot_dir() { [[ -f "$1/docker-compose.yml" && -f "$1/apps/web/package.json" ]] && grep -q '"@zerodot/web"' "$1/apps/web/package.json"; }

# state_get DIR KEY. Reads .zerodot-install, else guesses from .env.
state_get() {
  local dir="$1" key="$2" value=""
  if [[ -f "$dir/$STATE_FILE" ]]; then
    value=$(grep -m1 "^${key}=" "$dir/$STATE_FILE" | cut -d= -f2- || true)
  fi
  if [[ -z "$value" ]]; then
    case "$key" in
      DOMAIN) value=$(grep -m1 '^ZERODOT_BASE_URL=' "$dir/.env" 2>/dev/null | cut -d= -f2- | sed -E 's|^https?://||; s|/.*$||' || true) ;;
      NAME) value=$(basename "$dir") ;;
      MODE)
        if unit_exists "$(basename "$dir")-api.service"; then value=native; else value=docker; fi
        ;;
    esac
  fi
  echo "$value"
}

INSTALLS=()
scan_installs() {
  local d real seen=" "
  local candidates=(/var/www/* /opt/* /srv/* "$HOME"/*)
  if command -v docker >/dev/null 2>&1; then
    while IFS= read -r f; do [[ -n "$f" ]] && candidates+=("$(dirname "$f")"); done < <(
      docker compose ls -a --format json 2>/dev/null | grep -o '"ConfigFiles":"[^",]*' | cut -d'"' -f4 || true
    )
  fi
  for d in "${candidates[@]}"; do
    [[ -d "$d" ]] || continue
    real=$(readlink -f "$d")
    [[ "$seen" == *" $real "* ]] && continue
    seen="$seen$real "
    if is_zerodot_dir "$real"; then
      INSTALLS+=("$real")
      for k in WEB_PORT API_PORT WORKER_PORT SANDBOX_PORT PORT; do
        p=$(state_get "$real" "$k")
        [[ "$p" =~ ^[0-9]+$ ]] && RESERVED="$RESERVED $p"
      done
      if [[ -f "$real/docker-compose.override.yml" ]]; then
        p=$(grep -Eo '127\.0\.0\.1:[0-9]+:3000' "$real/docker-compose.override.yml" | head -1 | cut -d: -f2 || true)
        [[ -n "$p" ]] && RESERVED="$RESERVED $p"
      fi
    fi
  done
  return 0
}

install_status() {
  local dir="$1" mode name
  mode=$(state_get "$dir" MODE)
  name=$(state_get "$dir" NAME)
  if [[ "$mode" == native ]]; then
    systemctl is-active --quiet "${name}-api" 2>/dev/null && echo running || echo stopped
  else
    if command -v docker >/dev/null 2>&1 && [[ -n "$(cd "$dir" && docker compose ps -q 2>/dev/null)" ]]; then echo running; else echo stopped; fi
  fi
}

# ---------------------------------------------------------------------------
# Preflight: look at the server. Changes nothing.
# ---------------------------------------------------------------------------
OS_ID=""; OS_VER=""; MEM_MB=0; SWAP_MB=0; ARCH=""; VIRT="none"
HAS_DOCKER=0; DOCKER_OK=0
PG_STATE=none; PG_VERNUM=0; PG_PORT=5432
RD_STATE=none; RD_CLI=""; RD_VERSION=""; RD_POLICY=""; RD_AUTH=0

check_os() {
  # Read it in a subshell: the file sets NAME, which is also the name of the instance.
  if [[ -r /etc/os-release ]]; then
    OS_ID=$(. /etc/os-release && echo "${ID:-}")
    OS_VER=$(. /etc/os-release && echo "${VERSION_ID:-0}")
  fi
  command -v apt-get >/dev/null || { bad "No apt-get. This script supports Ubuntu and Debian."; return; }
  case "$OS_ID" in
    ubuntu) if ver_ge "$OS_VER" 22.04; then ok "Ubuntu $OS_VER"; else bad "Ubuntu $OS_VER is too old. Use 22.04 or newer."; fi ;;
    debian) if ver_ge "$OS_VER" 12; then ok "Debian $OS_VER"; else bad "Debian $OS_VER is too old. Use 12 or newer."; fi ;;
    *) note "$OS_ID is not tested. Ubuntu 22.04+ and Debian 12+ are." ;;
  esac
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64 | aarch64) ok "CPU type $ARCH" ;;
    *) bad "CPU type $ARCH is not supported (x86_64 or aarch64)." ;;
  esac
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] && ok "systemd" || note "No systemd. Native mode and Caddy need it."
  VIRT=$(systemd-detect-virt 2>/dev/null || true)
  [[ -n "$VIRT" ]] || VIRT=none
  return 0
}

check_resources() {
  MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
  local cpus free_gb
  cpus=$(nproc)
  if ((MEM_MB < 1024)); then
    bad "RAM ${MEM_MB} MB. The build needs 2 GB or more (swap can help)."
  elif ((MEM_MB < 2048)); then
    note "RAM ${MEM_MB} MB. Enough to run, tight to build. The script adds swap."
  else
    ok "RAM ${MEM_MB} MB, ${cpus} CPU"
  fi
  if ((MEM_MB < 3900 && SWAP_MB == 0)); then tip "Add swap before building (the script does this for you)."; fi
  free_gb=$(df -Pk /var 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')
  if ((free_gb < 4)); then bad "Disk: ${free_gb} GB free on /var. Need 8 GB or more."
  elif ((free_gb < 8)); then note "Disk: ${free_gb} GB free on /var. Docker builds use about 6 GB."
  else ok "Disk: ${free_gb} GB free on /var"; fi
  if [[ "$VIRT" == "openvz" || "$VIRT" == "lxc" ]]; then
    note "This server is a container ($VIRT). Docker may not work here."
    tip "Container VPS ($VIRT): use --native."
  fi
}

check_ports() {
  local who p
  for p in 80 443; do
    if port_in_use "$p"; then
      who=$(listener "$p")
      if [[ "$who" == "caddy" ]]; then
        ok "Port $p is used by Caddy (good, the script adds a site to it)"
      else
        note "Port $p is used by ${who:-another program}. Caddy cannot start next to it."
        PROXY_FOREIGN=1
        tip "Port $p is taken by ${who:-another program}: the script will not install Caddy. Add a proxy rule to ${who:-it} by hand (the script prints the upstream)."
      fi
    else
      ok "Port $p is free"
    fi
  done
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    note "Docker is not installed (the script can install it)."
    return
  fi
  HAS_DOCKER=1
  local dv cv
  dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [[ -z "$dv" ]]; then note "Docker is installed but the service does not answer."; return; fi
  cv=$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)
  if [[ -z "$cv" ]]; then
    bad "Docker $dv has no Compose v2. Update Docker."
  elif ver_ge "$cv" 2.24.0; then
    ok "Docker $dv, Compose $cv"
    DOCKER_OK=1
  else
    bad "Docker Compose $cv is too old. Zerodot needs 2.24 or newer."
    tip "Update Docker: curl -fsSL https://get.docker.com | sh"
  fi
}

detect_postgres() {
  PG_STATE=none
  if [[ -n "${DATABASE_URL:-}" ]]; then PG_STATE=external; return; fi
  if port_in_use 5432 || [[ -S /var/run/postgresql/.s.PGSQL.5432 ]]; then
    PG_STATE=running
  elif command -v pg_lsclusters >/dev/null && [[ -n "$(pg_lsclusters -h 2>/dev/null)" ]]; then
    PG_STATE=installed
  elif command -v psql >/dev/null; then
    PG_STATE=client
  fi
  if [[ "$PG_STATE" == running ]] && id postgres >/dev/null 2>&1; then
    PG_VERNUM=$(cd / && runuser -u postgres -- psql -Atqc 'show server_version_num' 2>/dev/null || echo 0)
    PG_PORT=$(cd / && runuser -u postgres -- psql -Atqc 'show port' 2>/dev/null || echo 5432)
  fi
  return 0
}

report_postgres() {
  case "$PG_STATE" in
    external) ok "Postgres: using DATABASE_URL from the environment" ;;
    running)
      if ((PG_VERNUM >= 130000)); then
        ok "Postgres $((PG_VERNUM / 10000)) is running on this server (port $PG_PORT)"
        tip "Native mode can use this Postgres. It makes its own database and user. Other databases are not touched."
      elif ((PG_VERNUM > 0)); then
        bad "Postgres $((PG_VERNUM / 10000)) is too old. Zerodot needs 13 or newer."
        tip "Postgres is too old for native mode. Use Docker mode (it brings Postgres 17)."
      else
        note "Postgres is running but this script cannot log in as the postgres user."
        tip "Native mode needs root access to Postgres. Set DATABASE_URL to use your own database."
      fi
      ;;
    installed) note "Postgres is installed but not running." ;;
    client) note "Only the Postgres client (psql) is installed." ;;
    *) ok "No Postgres on this server (Docker brings one; native mode installs one)" ;;
  esac
}

detect_redis() {
  RD_STATE=none; RD_CLI=""; RD_VERSION=""; RD_POLICY=""; RD_AUTH=0
  if [[ -n "${VALKEY_URL:-}" ]]; then RD_STATE=external; return; fi
  local c
  for c in valkey-cli redis-cli; do command -v "$c" >/dev/null && { RD_CLI="$c"; break; }; done
  if port_in_use 6379; then
    RD_STATE=running
    if [[ -n "$RD_CLI" ]]; then
      if [[ "$("$RD_CLI" -h 127.0.0.1 ping 2>&1 || true)" == *NOAUTH* ]]; then
        RD_AUTH=1
      else
        RD_VERSION=$("$RD_CLI" -h 127.0.0.1 info server 2>/dev/null | tr -d '\r' | grep -E '^(valkey_version|redis_version):' | head -1 | cut -d: -f2 || true)
        RD_POLICY=$("$RD_CLI" -h 127.0.0.1 config get maxmemory-policy 2>/dev/null | sed -n 2p | tr -d '\r' || true)
      fi
    fi
  elif command -v valkey-server >/dev/null || command -v redis-server >/dev/null; then
    RD_STATE=installed
  fi
  return 0
}

report_redis() {
  case "$RD_STATE" in
    external) ok "Valkey/Redis: using VALKEY_URL from the environment" ;;
    running)
      if ((RD_AUTH)); then
        note "Valkey/Redis is running on 6379 and needs a password."
        tip "Set VALKEY_URL=redis://:PASSWORD@127.0.0.1:6379/N to use it in native mode."
      else
        ok "Valkey/Redis ${RD_VERSION:-(version unknown)} is running on port 6379"
        [[ -n "$RD_POLICY" && "$RD_POLICY" != noeviction ]] && {
          note "It uses maxmemory-policy '$RD_POLICY'. The job queue needs 'noeviction' or jobs can vanish under memory pressure."
          tip "Set 'maxmemory-policy noeviction' in your Redis/Valkey config before native mode shares it."
        }
        tip "Native mode can share this Valkey/Redis, in its own database number."
      fi
      ;;
    installed) note "Valkey/Redis is installed but not running." ;;
    *) ok "No Valkey/Redis on this server (Docker brings one; native mode installs one)" ;;
  esac
}

check_other() {
  if command -v caddy >/dev/null; then ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}')"; else ok "No Caddy yet (the script can install it)"; fi
  if ufw_active; then
    ok "Firewall (ufw) is on: the script opens 80 and 443"
  else
    note "No active firewall."
    tip "Turn on a firewall: ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable"
  fi
  if command -v node >/dev/null; then ok "Node $(node -v) found (native mode may use a private Node if it does not fit)"; fi
}

preflight() {
  say "Checking this server"
  check_os
  check_resources
  check_ports
  check_docker
  detect_postgres; report_postgres
  detect_redis; report_redis
  check_other
}

PROXY_FOREIGN=0

# ---------------------------------------------------------------------------
# Main flow: step 1, look around
# ---------------------------------------------------------------------------
if ((CHECK == 0)); then
  [[ $EUID -eq 0 ]] || die "Run as root (use sudo)."
fi
[[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] && die "'$DOMAIN' is not a domain name."

init_tui
banner
preflight
scan_installs

if ((${#INSTALLS[@]} > 0)); then
  say "Zerodot installs on this server"
  i=1
  for d in "${INSTALLS[@]}"; do
    printf '  %d) %s   %s   %s   %s\n' "$i" "$d" "$(state_get "$d" DOMAIN)" "$(state_get "$d" MODE)" "$(install_status "$d")"
    i=$((i + 1))
  done
else
  say "No Zerodot install found on this server"
fi

# What would we recommend?
RECOMMEND=docker
RECOMMEND_WHY="Docker keeps Zerodot, Postgres and Valkey in their own containers. Simplest and the easiest to move."
if [[ "$VIRT" == "openvz" || "$VIRT" == "lxc" ]] && ((HAS_DOCKER == 0)); then
  RECOMMEND=native
  RECOMMEND_WHY="This server is a container ($VIRT); Docker often does not work in one."
elif ((MEM_MB < 2048)); then
  RECOMMEND=native
  RECOMMEND_WHY="RAM is low (${MEM_MB} MB). Without Docker you save about 400 MB."
elif ((PG_VERNUM >= 130000)) && [[ "$RD_STATE" == running ]] && ((RD_AUTH == 0)); then
  RECOMMEND_WHY="$RECOMMEND_WHY (Native would also work: Postgres and Valkey already run here.)"
fi

if ((CHECK)); then
  say "Result"
  printf '  Recommended mode: %s%s%s. %s\n' "$B" "$RECOMMEND" "$N" "$RECOMMEND_WHY"
  if ((${#SUGGEST[@]} > 0)); then
    printf '\n  Tips:\n'
    for t in "${SUGGEST[@]}"; do printf '   - %s\n' "$t"; done
  fi
  printf '\n  %d problem(s), %d warning(s). Nothing was changed.\n\n' "$FAILS" "$WARNS"
  ((FAILS == 0)) || exit 1
  exit 0
fi

((FAILS == 0)) || die "Fix the problems marked ✘ above and run again."

# ---------------------------------------------------------------------------
# Step 2: update an install, or set up a new instance?
# ---------------------------------------------------------------------------
TARGET=""
if ((${#INSTALLS[@]} > 0)); then
  if [[ -n "$DOMAIN" && "$ACTION" != new ]]; then
    for d in "${INSTALLS[@]}"; do
      [[ "$(state_get "$d" DOMAIN)" == "$DOMAIN" ]] && { TARGET="$d"; ACTION=update; }
    done
  fi
  if [[ -z "$ACTION" ]]; then
    if ((YES)) || ! have_tty; then
      if [[ -z "$DOMAIN" && ${#INSTALLS[@]} -eq 1 ]]; then ACTION=update; TARGET="${INSTALLS[0]}"; else ACTION=new; fi
    elif ((TUI)); then
      tui_menu "Zerodot is already installed" "Found ${#INSTALLS[@]} install(s) on this server.\nWhat do you want to do?" \
        u "Update an install that exists" \
        n "Set up another instance on this server"
      case "$REPLY" in u) ACTION=update ;; *) ACTION=new ;; esac
    else
      printf '\nWhat do you want to do?\n  u) Update an install that exists\n  n) Set up another instance on this server\n  q) Quit\n'
      ask "Choose [u/n/q]: " "u"
      case "$REPLY" in
        [Uu]*) ACTION=update ;;
        [Nn]*) ACTION=new ;;
        *) echo "Stopped. Nothing was changed."; exit 0 ;;
      esac
    fi
  fi
  if [[ "$ACTION" == update && -z "$TARGET" ]]; then
    if ((${#INSTALLS[@]} == 1)); then
      TARGET="${INSTALLS[0]}"
    elif ((YES)) || ! have_tty; then
      die "More than one install found. Give the domain of the one to update, for example: install.sh zerodot.example.com"
    else
      if ((TUI)); then
        items=()
        i=1
        for d in "${INSTALLS[@]}"; do
          items+=("$i" "$d  $(state_get "$d" DOMAIN)  $(state_get "$d" MODE)  $(install_status "$d")")
          i=$((i + 1))
        done
        tui_menu "Update which install?" "Pick the install to update." "${items[@]}"
      else
        ask "Which one? [1-${#INSTALLS[@]}]: " "1"
      fi
      [[ "$REPLY" =~ ^[0-9]+$ ]] && ((REPLY >= 1 && REPLY <= ${#INSTALLS[@]})) || die "Not a valid choice."
      TARGET="${INSTALLS[$((REPLY - 1))]}"
    fi
  fi
else
  [[ "$ACTION" == update ]] && die "--update given but no Zerodot install was found."
  ACTION=new
fi

if [[ "$ACTION" == update ]]; then
  DIR="$TARGET"
  NAME=$(state_get "$DIR" NAME)
  MODE=$(state_get "$DIR" MODE)
  STORED_DOMAIN=$(state_get "$DIR" DOMAIN)
  [[ -n "$DOMAIN" && "$DOMAIN" != "$STORED_DOMAIN" ]] && die "This install uses $STORED_DOMAIN. To use $DOMAIN, set up another instance (--new)."
  DOMAIN="$STORED_DOMAIN"
  [[ -n "$DOMAIN" ]] || die "Cannot find the domain of $DIR (no ZERODOT_BASE_URL in its .env)."
  say "Updating $DIR ($DOMAIN, $MODE)"
else
  if [[ -z "$DOMAIN" ]]; then
    if ((TUI)); then
      tui_input "Domain" "Public address of this instance.\nPoint its DNS A record to ${server_ip_hint:-this server} first.\nExample: zerodot.example.com" ""
    else
      ask "Domain for this instance (example: zerodot.example.com): " ""
    fi
    DOMAIN="$REPLY"
    [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "A valid domain is needed (example: zerodot.example.com)."
  fi
  for d in "${INSTALLS[@]}"; do
    [[ "$(state_get "$d" DOMAIN)" == "$DOMAIN" ]] && die "$DOMAIN is already used by $d."
  done
  if [[ -z "$NAME" ]]; then
    if ((${#INSTALLS[@]} == 0)); then NAME=zerodot; else NAME="zerodot-${DOMAIN%%.*}"; fi
    if ((TUI)); then
      tui_input "Instance name" "Used for the folder, the services and the database.\nLower-case letters, digits and '-'." "$NAME"
    else
      ask "Name of this instance [$NAME]: " "$NAME"
    fi
    NAME="$REPLY"
  fi
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die "Name '$NAME' is not valid. Use lower-case letters, digits and '-'."
  DIR="${DIR_ARG:-/var/www/$NAME}"
  if [[ -e "$DIR" ]]; then
    is_zerodot_dir "$DIR" && die "$DIR is already a Zerodot install. Use --update, or pick another --name."
    [[ -z "$(ls -A "$DIR" 2>/dev/null)" ]] || die "$DIR exists and is not empty."
  fi
  if [[ -z "$MODE" ]]; then
    if ((YES)) || ! have_tty; then
      MODE="$RECOMMEND"
    elif ((TUI)); then
      d_label="Docker - own containers for Zerodot, Postgres and Valkey"
      n_label="Native - no Docker; systemd; reuses Postgres and Valkey if found"
      [[ "$RECOMMEND" == docker ]] && d_label="$d_label  (recommended)" || n_label="$n_label  (recommended)"
      tui_menu "How do you want to run Zerodot?" "$RECOMMEND_WHY" docker "$d_label" native "$n_label"
      MODE="$REPLY"
    else
      printf '\nHow do you want to run Zerodot?\n'
      printf '  1) Docker   - own containers for Zerodot, Postgres and Valkey%s\n' "$([[ $RECOMMEND == docker ]] && echo '  (recommended)')"
      printf '  2) Native   - no Docker; systemd services; reuses Postgres and Valkey on this server if found%s\n' "$([[ $RECOMMEND == native ]] && echo '  (recommended)')"
      printf '  Why: %s\n' "$RECOMMEND_WHY"
      ask "Choose [1/2]: " "$([[ $RECOMMEND == docker ]] && echo 1 || echo 2)"
      case "$REPLY" in 2 | [Nn]*) MODE=native ;; *) MODE=docker ;; esac
    fi
  fi
fi
[[ "$MODE" == docker || "$MODE" == native ]] || die "Unknown mode '$MODE'."
if [[ "$MODE" == docker && "$DOCKER_OK" == 0 && "$HAS_DOCKER" == 1 ]]; then
  die "Docker is installed but not usable (see above). Fix it, or use --native."
fi
DBNAME="${NAME//-/_}"

# ---------------------------------------------------------------------------
# Step 3: plan
# ---------------------------------------------------------------------------
plan_text() {
  printf '  Action:   %s\n  Mode:     %s\n  Name:     %s\n  Folder:   %s\n  Address:  https://%s\n' "$ACTION" "$MODE" "$NAME" "$DIR" "$DOMAIN"
  if [[ "$MODE" == native ]]; then
    case "$PG_STATE" in
      external) echo "  Database: your DATABASE_URL" ;;
      running) echo "  Database: share Postgres on this server (new database '$DBNAME' and user)" ;;
      *) echo "  Database: install Postgres from apt" ;;
    esac
    case "$RD_STATE" in
      external) echo "  Queue:    your VALKEY_URL" ;;
      running) echo "  Queue:    share Valkey/Redis on this server (own database number)" ;;
      *) echo "  Queue:    install Valkey (or Redis) from apt" ;;
    esac
  else
    echo "  Database: Postgres 17 container    Queue: Valkey 8 container"
  fi
  if ((SKIP_PROXY || PROXY_FOREIGN)); then echo "  Proxy:    not changed (you add the rule)"; else echo "  Proxy:    Caddy (installed if missing)"; fi
}
PLAN=$(plan_text)
say "Plan"
echo "$PLAN"
if ((TUI)); then
  tui_yesno "Ready to start?" "$PLAN

The first build takes about 10 minutes." || tui_cancel
else
  confirm "Continue?" || { echo "Stopped. Nothing was changed."; exit 0; }
fi

# ---------------------------------------------------------------------------
# Step 4: base packages, swap, firewall
# ---------------------------------------------------------------------------
say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl openssl ca-certificates >/dev/null

if ((MEM_MB < 3900 && SWAP_MB == 0)); then
  say "Adding 3 GB swap (RAM is ${MEM_MB} MB)"
  fallocate -l 3G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ufw_active; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# ---------------------------------------------------------------------------
# Step 5: code
# ---------------------------------------------------------------------------
say "Getting the code in $DIR"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" pull --ff-only
else
  mkdir -p "$(dirname "$DIR")"
    ssh_repo="git@github-zerodot:${ZERODOT_REPO#https://github.com/}"
  if ! GIT_TERMINAL_PROMPT=0 git clone ${ZERODOT_BRANCH:+-b "$ZERODOT_BRANCH"} "$ZERODOT_REPO" "$DIR"; then
    if grep -q '^Host github-zerodot' "$HOME/.ssh/config" 2>/dev/null \
      && git clone ${ZERODOT_BRANCH:+-b "$ZERODOT_BRANCH"} "$ssh_repo" "$DIR"; then
      echo "Cloned with the deploy key."
    else
      # The repository is private. Make a read-only deploy key and wait for the user to add it.
      have_tty || die "Clone failed. If the repository is private, run this script from a terminal."
      key="$HOME/.ssh/zerodot_deploy"
      mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
      [[ -f "$key" ]] || ssh-keygen -t ed25519 -N "" -C zerodot-deploy -f "$key" -q
      grep -q '^Host github-zerodot' "$HOME/.ssh/config" 2>/dev/null || cat >> "$HOME/.ssh/config" <<CONF

Host github-zerodot
  HostName github.com
  User git
  IdentityFile $key
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CONF
      printf '\nThe clone failed. The repository may be private.\n'
      printf 'Add this key in GitHub: repository > Settings > Deploy keys (leave write access off):\n\n'
      cat "$key.pub"
      printf '\nPress Enter when it is added... '
      read -r _ </dev/tty
      git clone ${ZERODOT_BRANCH:+-b "$ZERODOT_BRANCH"} "$ssh_repo" "$DIR" || die "Clone failed again. Check the deploy key."
    fi
  fi
fi
cd "$DIR"

# What the repository needs.
PM_VER=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json | head -1)
NODE_REQ=$(sed -n 's/.*"node": *">=\([0-9]*\).*/\1/p' package.json | head -1)
NODE_REQ="${NODE_REQ:-22}"
[[ -n "$PM_VER" ]] || die "Cannot read the pnpm version from package.json."

# ---------------------------------------------------------------------------
# Step 6: settings (.env). Existing values stay.
# ---------------------------------------------------------------------------
say "Writing .env"
[[ -f .env ]] || cp .env.example .env
chmod 600 .env

set_env() {
  local key="$1" value="$2" escaped
  escaped=$(printf '%s' "$value" | sed 's/[|&\\]/\\&/g')
  if grep -q "^${key}=" .env; then sed -i "s|^${key}=.*|${key}=${escaped}|" .env; else echo "${key}=${value}" >> .env; fi
}
set_env_once() { grep -Eq "^${1}=.+" .env || set_env "$1" "$2"; }
get_env() { grep -m1 "^${1}=" .env | cut -d= -f2- || true; }

# Write the state early, so a run that stops half-way can continue as the same mode.
printf 'MODE=%s\nNAME=%s\nDOMAIN=%s\n' "$MODE" "$NAME" "$DOMAIN" > "$STATE_FILE"

set_env_once ZERODOT_SECRET_KEY "$(openssl rand -base64 32)"
set_env_once BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
set_env ZERODOT_BASE_URL "https://${DOMAIN}"
set_env ZERODOT_TRUST_PROXY "true"

# ===========================================================================
# DOCKER MODE
# ===========================================================================
docker_mode() {
  set_env_once ZERODOT_BLOB_DIR "/blobs"

  if ! command -v docker >/dev/null; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. Update Docker and run again."
  ver_ge "$(docker compose version --short | sed 's/^v//')" 2.24.0 || die "Docker Compose is older than 2.24. Update Docker."

  # The proxy listens on localhost only, so only Caddy can reach it.
  if [[ -n "${ZERODOT_PORT:-}" ]]; then
    PORT="$ZERODOT_PORT"
  elif [[ -f docker-compose.override.yml ]] && grep -Eq '127\.0\.0\.1:[0-9]+:3000' docker-compose.override.yml; then
    PORT=$(grep -Eo '127\.0\.0\.1:[0-9]+:3000' docker-compose.override.yml | head -1 | cut -d: -f2)
  else
    free_port 3000
    PORT="$FREE_PORT"
  fi
  cat > docker-compose.override.yml <<CONF
# Written by scripts/install.sh. Binds the proxy to localhost so only Caddy can reach it.
services:
  proxy:
    ports: !override
      - "127.0.0.1:${PORT}:3000"
CONF

  say "Building and starting (the first build takes about 10 minutes)"
  docker compose up -d --build

  UPSTREAM_PORT="$PORT"
  wait_http "http://127.0.0.1:${PORT}/" || { docker compose ps; die "The app did not start. See: docker compose logs"; }
  CADDY_KIND="single"
  printf 'MODE=docker\nNAME=%s\nDOMAIN=%s\nPORT=%s\n' "$NAME" "$DOMAIN" "$PORT" > "$STATE_FILE"
}

wait_http() {
  local code _
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    [[ "$code" =~ ^(200|307)$ ]] && return 0
    sleep 3
  done
  return 1
}

# ===========================================================================
# NATIVE MODE
# ===========================================================================
NODE_DIR=""
PNPM=""

ensure_node() {
  local cur="" real
  if command -v node >/dev/null && command -v npm >/dev/null; then
    cur=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    real=$(readlink -f "$(command -v node)")
    # A Node in a home folder (nvm) cannot be read by the service user.
    if ((cur >= NODE_REQ)) && [[ "$real" != /root/* && "$real" != /home/* ]]; then
      NODE_DIR=$(dirname "$(dirname "$real")")
      ok "Using Node $(node -v) from $NODE_DIR"
      return
    fi
    note "Node $(node -v) does not fit (need ${NODE_REQ}+ outside a home folder). A private Node goes to /opt/zerodot-node. The system Node stays as it is."
  fi
  local arch idx file sum dest
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die "Unsupported CPU type." ;; esac
  apt-get install -y -qq xz-utils >/dev/null
  idx=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_REQ}.x/SHASUMS256.txt")
  file=$(printf '%s\n' "$idx" | awk -v a="linux-${arch}.tar.xz" '$2 ~ a"$" {print $2}' | head -1)
  sum=$(printf '%s\n' "$idx" | awk -v f="$file" '$2 == f {print $1}')
  [[ -n "$file" && -n "$sum" ]] || die "Cannot find Node ${NODE_REQ} for ${arch} on nodejs.org."
  dest="/opt/zerodot-node/${file%.tar.xz}"
  if [[ ! -x "$dest/bin/node" ]]; then
    say "Installing Node ${file%.tar.xz} to /opt/zerodot-node"
    mkdir -p /opt/zerodot-node
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_REQ}.x/${file}" -o "/tmp/${file}"
    (cd /tmp && printf '%s  %s\n' "$sum" "$file" | sha256sum -c - >/dev/null) || die "Node download failed the checksum."
    tar -xJf "/tmp/${file}" -C /opt/zerodot-node
    rm -f "/tmp/${file}"
  fi
  NODE_DIR="$dest"
  ok "Using private Node $("$NODE_DIR/bin/node" -v)"
}

ensure_pnpm() {
  local have=""
  command -v pnpm >/dev/null && have=$(PATH="$NODE_DIR/bin:$PATH" pnpm --version 2>/dev/null || true)
  if [[ "$have" == "$PM_VER" ]]; then
    PNPM=$(command -v pnpm)
    ok "Using pnpm $have"
    return
  fi
  [[ -n "$have" ]] && note "pnpm $have found; this repository needs exactly $PM_VER (the lockfile depends on it)."
  local prefix="/opt/zerodot-tools/pnpm-${PM_VER}"
  if [[ ! -x "$prefix/bin/pnpm" ]]; then
    say "Installing pnpm $PM_VER to $prefix"
    PATH="$NODE_DIR/bin:$PATH" npm install -g --silent --prefix "$prefix" "pnpm@${PM_VER}"
  fi
  PNPM="$prefix/bin/pnpm"
  ok "Using pnpm $PM_VER"
}

pg_run() { (cd / && runuser -u postgres -- psql -v ON_ERROR_STOP=1 -Atq "$@"); }

setup_postgres() {
  local url
  url=$(get_env DATABASE_URL)
  if [[ -n "${DATABASE_URL:-}" ]]; then set_env DATABASE_URL "$DATABASE_URL"; return; fi
  if [[ -n "$url" && "$url" == *"@127.0.0.1:"* ]]; then ok "Database: keeping DATABASE_URL from .env"; return; fi

  detect_postgres
  if [[ "$PG_STATE" != running ]]; then
    say "Installing Postgres"
    apt-get install -y -qq postgresql >/dev/null
    systemctl enable --now postgresql >/dev/null 2>&1 || true
    sleep 3
    detect_postgres
  fi
  [[ "$PG_STATE" == running ]] || die "Postgres is not running. Start it and run again."
  ((PG_VERNUM >= 130000)) || die "Postgres $((PG_VERNUM / 10000)) is too old (need 13+). Use Docker mode, or set DATABASE_URL."

  local pass
  pass=$(openssl rand -hex 24)
  if [[ "$(pg_run -c "select 1 from pg_roles where rolname='${DBNAME}'")" == 1 ]]; then
    die "A Postgres user '${DBNAME}' already exists but .env has no DATABASE_URL for it. Pick another --name, or set DATABASE_URL."
  fi
  pg_run -c "create role \"${DBNAME}\" login password '${pass}'"
  [[ "$(pg_run -c "select 1 from pg_database where datname='${DBNAME}'")" == 1 ]] || pg_run -c "create database \"${DBNAME}\" owner \"${DBNAME}\""
  set_env DATABASE_URL "postgres://${DBNAME}:${pass}@127.0.0.1:${PG_PORT}/${DBNAME}"
  PGPASSWORD="$pass" psql -h 127.0.0.1 -p "$PG_PORT" -U "$DBNAME" -d "$DBNAME" -Atqc 'select 1' >/dev/null 2>&1 \
    || die "Created the database but cannot log in over TCP. Check pg_hba.conf allows 'host ... scram-sha-256' for 127.0.0.1."
  ok "Database '${DBNAME}' ready on Postgres $((PG_VERNUM / 10000))"
}

redis_unit() {
  local u
  for u in valkey-server valkey redis-server redis; do
    if unit_exists "${u}.service"; then echo "$u"; return 0; fi
  done
  return 0
}

setup_valkey() {
  local url
  url=$(get_env VALKEY_URL)
  if [[ -n "${VALKEY_URL:-}" ]]; then set_env VALKEY_URL "$VALKEY_URL"; return; fi
  if [[ -n "$url" && "$url" == *"127.0.0.1"* ]]; then ok "Queue: keeping VALKEY_URL from .env"; return; fi

  detect_redis
  if [[ "$RD_STATE" != running ]]; then
    say "Installing Valkey (or Redis)"
    local pkg conf
    for pkg in valkey-server valkey redis-server; do
      if apt-cache show "$pkg" >/dev/null 2>&1; then
        apt-get install -y -qq "$pkg" >/dev/null && break
      fi
    done
    for conf in /etc/valkey/valkey.conf /etc/redis/redis.conf; do
      if [[ -f "$conf" ]]; then
        # The last line wins. The queue needs noeviction and a log on disk.
        printf '\n# Added by Zerodot install.sh\nmaxmemory-policy noeviction\nappendonly yes\nbind 127.0.0.1 -::1\n' >> "$conf"
        break
      fi
    done
    local unit
    unit=$(redis_unit || true)
    [[ -n "$unit" ]] || die "Valkey/Redis did not install. Install one by hand or set VALKEY_URL."
    systemctl enable "$unit" >/dev/null 2>&1 || true
    systemctl restart "$unit"
    sleep 2
    detect_redis
  fi
  [[ "$RD_STATE" == running ]] || die "Valkey/Redis is not running. Start it and run again."
  ((RD_AUTH == 0)) || die "Valkey/Redis on 6379 needs a password. Set VALKEY_URL=redis://:PASSWORD@127.0.0.1:6379/N and run again."

  # Own database number, so other apps on a shared server are not touched.
  local n=0 c="${RD_CLI:-redis-cli}"
  if command -v "$c" >/dev/null; then
    for n in $(seq 1 15); do
      [[ "$("$c" -h 127.0.0.1 -n "$n" dbsize 2>/dev/null | tr -d '\r')" == 0 ]] && break
    done
  else
    n=1
  fi
  set_env VALKEY_URL "redis://127.0.0.1:6379/${n}"
  ok "Queue ready (Valkey/Redis database number ${n})"
}

native_mode() {
  say "Checking tools for native mode"
  apt-get install -y -qq python3 make g++ >/dev/null   # isolated-vm (the code sandbox) is a native module
  ensure_node
  ensure_pnpm

  setup_postgres
  setup_valkey

  WEB_PORT=$(state_get "$DIR" WEB_PORT); API_PORT=$(state_get "$DIR" API_PORT)
  WORKER_PORT=$(state_get "$DIR" WORKER_PORT); SANDBOX_PORT=$(state_get "$DIR" SANDBOX_PORT)
  [[ "$WEB_PORT" =~ ^[0-9]+$ ]] && [[ -f "$STATE_FILE" ]] || {
    free_port 3000; WEB_PORT="$FREE_PORT"
    free_port 3003; API_PORT="$FREE_PORT"
    free_port 3001; WORKER_PORT="$FREE_PORT"
    free_port 3002; SANDBOX_PORT="$FREE_PORT"
  }
  set_env SANDBOX_URL "http://127.0.0.1:${SANDBOX_PORT}"
  set_env_once ZERODOT_BLOB_DIR "/var/lib/${NAME}/blobs"

  say "Building (the first build takes about 10 minutes)"
  # Turborepo looks for pnpm on PATH, so the folder of the pinned pnpm goes there too.
  local pnpm_dir
  pnpm_dir=$(dirname "$PNPM")
  export PATH="$NODE_DIR/bin:$pnpm_dir:$PATH"
  export TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
  "$PNPM" install --frozen-lockfile || die "pnpm install failed. Look at the messages above."
  "$PNPM" run build || die "The build failed. Look at the messages above. Low memory is a common cause (check: free -m, dmesg | grep -i oom)."

  id "$NAME" >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$NAME"
  mkdir -p "$(get_env ZERODOT_BLOB_DIR)"
  chown -R "$NAME:$NAME" "$DIR" "$(get_env ZERODOT_BLOB_DIR)"
  chown "root:$NAME" .env && chmod 640 .env

  write_units
  systemctl daemon-reload
  systemctl enable "${NAME}-sandbox" "${NAME}-api" "${NAME}-worker" "${NAME}-web" >/dev/null 2>&1
  systemctl restart "${NAME}-sandbox" "${NAME}-api" "${NAME}-worker" "${NAME}-web"

  say "Waiting for the app on 127.0.0.1:${WEB_PORT}"
  wait_http "http://127.0.0.1:${WEB_PORT}/" || {
    systemctl --no-pager status "${NAME}-web" "${NAME}-api" | tail -20 || true
    die "The app did not start. See: journalctl -u ${NAME}-api -u ${NAME}-web -n 50"
  }
  CADDY_KIND="split"
  UPSTREAM_PORT="$WEB_PORT"
  printf 'MODE=native\nNAME=%s\nDOMAIN=%s\nWEB_PORT=%s\nAPI_PORT=%s\nWORKER_PORT=%s\nSANDBOX_PORT=%s\n' \
    "$NAME" "$DOMAIN" "$WEB_PORT" "$API_PORT" "$WORKER_PORT" "$SANDBOX_PORT" > "$STATE_FILE"
  chown "$NAME:$NAME" "$STATE_FILE"
}

write_units() {
  local after="network.target" vite
  local pg_unit="postgresql.service" rd_unit
  rd_unit="$(redis_unit || true)"
  [[ -n "$rd_unit" ]] && rd_unit="${rd_unit}.service"
  if unit_exists "$pg_unit"; then after="$after $pg_unit"; fi
  [[ -n "$rd_unit" ]] && after="$after $rd_unit"

  # Shared hardening. The API, worker and sandbox listen on localhost only.
  local common="User=${NAME}
Group=${NAME}
WorkingDirectory=${DIR}
Environment=PATH=${NODE_DIR}/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true"

  cat > "/etc/systemd/system/${NAME}-sandbox.service" <<UNIT
[Unit]
Description=Zerodot code sandbox (${NAME})
After=network.target

[Service]
${common}
Environment=PORT=${SANDBOX_PORT}
Environment=ZERODOT_BIND_HOST=127.0.0.1
ExecStart=${NODE_DIR}/bin/node --no-node-snapshot apps/sandbox/dist/index.js

[Install]
WantedBy=multi-user.target
UNIT

  cat > "/etc/systemd/system/${NAME}-api.service" <<UNIT
[Unit]
Description=Zerodot API (${NAME})
After=${after}

[Service]
${common}
EnvironmentFile=${DIR}/.env
Environment=ZERODOT_API_PORT=${API_PORT}
Environment=ZERODOT_BIND_HOST=127.0.0.1
ExecStart=${NODE_DIR}/bin/node apps/api/dist/index.js

[Install]
WantedBy=multi-user.target
UNIT

  cat > "/etc/systemd/system/${NAME}-worker.service" <<UNIT
[Unit]
Description=Zerodot worker (${NAME})
After=${after} ${NAME}-sandbox.service

[Service]
${common}
EnvironmentFile=${DIR}/.env
Environment=PORT=${WORKER_PORT}
Environment=ZERODOT_BIND_HOST=127.0.0.1
ExecStart=${NODE_DIR}/bin/node apps/worker/dist/index.js

[Install]
WantedBy=multi-user.target
UNIT

  vite="node_modules/vite/bin/vite.js"
  [[ -f "apps/web/$vite" ]] || die "Cannot find Vite in apps/web after the build."
  cat > "/etc/systemd/system/${NAME}-web.service" <<UNIT
[Unit]
Description=Zerodot web (${NAME})
After=${after} ${NAME}-api.service

[Service]
${common}
WorkingDirectory=${DIR}/apps/web
EnvironmentFile=${DIR}/.env
ExecStart=${NODE_DIR}/bin/node ${vite} preview --host 127.0.0.1 --port ${WEB_PORT}

[Install]
WantedBy=multi-user.target
UNIT
}

CADDY_KIND="single"
UPSTREAM_PORT=""
if [[ "$MODE" == docker ]]; then docker_mode; else native_mode; fi

# ---------------------------------------------------------------------------
# Step 7: Caddy
# ---------------------------------------------------------------------------
if [[ "$CADDY_KIND" == split ]]; then
  # Same paths as the Caddyfile in the repository: the API takes these, the web app takes the rest.
  api_paths=$(grep -m1 '@api path' Caddyfile | sed 's/^[[:space:]]*@api path //')
  block="${DOMAIN} {
	encode gzip
	@api path ${api_paths}
	handle @api {
		reverse_proxy 127.0.0.1:${API_PORT} {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy 127.0.0.1:${WEB_PORT}
	}
}"
else
  block="${DOMAIN} {
	encode gzip
	reverse_proxy 127.0.0.1:${UPSTREAM_PORT} {
		flush_interval -1
	}
}"
fi

if ((SKIP_PROXY || PROXY_FOREIGN)); then
  say "Proxy: not changed"
  printf 'Add this to your reverse proxy (Caddy syntax shown):\n\n%s\n\n' "$block"
else
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  if [[ -f "$CADDYFILE" ]] && grep -Eq "^${DOMAIN//./\\.}[[:space:]]*(,|\{)" "$CADDYFILE"; then
    say "Caddy already has a block for ${DOMAIN}. Left as is."
  else
    say "Adding ${DOMAIN} to $CADDYFILE"
    mkdir -p /etc/caddy
    [[ -f "$CADDYFILE" ]] && cp "$CADDYFILE" "${CADDYFILE}.bak-zerodot"
    printf '\n%s\n' "$block" >> "$CADDYFILE"
    if caddy validate --config "$CADDYFILE" >/dev/null 2>&1 && systemctl reload caddy; then
      echo "Caddy reloaded."
    else
      # Put the old file back so the other sites keep working.
      if [[ -f "${CADDYFILE}.bak-zerodot" ]]; then cp "${CADDYFILE}.bak-zerodot" "$CADDYFILE"; fi
      systemctl reload caddy 2>/dev/null || true
      die "Caddy rejected the new block. Old Caddyfile restored. Add this block by hand:
$block"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 8: DNS check. Cloudflare hides the IP, so this is only a warning.
# ---------------------------------------------------------------------------
server_ip=$(curl -s4 https://ifconfig.me || true)
dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [[ -z "$dns_ip" ]]; then
  note "${DOMAIN} has no DNS record yet. Add: A ${DOMAIN} ${server_ip:-<this server IP>}"
elif [[ -n "$server_ip" && "$dns_ip" != "$server_ip" ]]; then
  note "${DOMAIN} points to ${dns_ip}, this server is ${server_ip}. Fine if you use the Cloudflare proxy. Otherwise fix the A record."
fi

say "Done"
if [[ "$MODE" == native ]]; then
  manage="systemctl restart ${NAME}-web ${NAME}-api ${NAME}-worker ${NAME}-sandbox    (logs: journalctl -u ${NAME}-api -f)"
else
  manage="cd ${DIR} && docker compose logs -f"
fi
cat <<EOM

  Open:    https://${DOMAIN}
  Sign up first. The first user is the admin.
  Then turn off public signup in System > Access.

  Save this key somewhere safe. If you lose it, saved credentials cannot be opened:
    ZERODOT_SECRET_KEY in ${DIR}/.env

  Update later:  sudo bash ${DIR}/scripts/install.sh ${DOMAIN}
  Manage:        ${manage}

EOM
