#!/usr/bin/env bash
# Interactive native-Linux worker bootstrap. Run as the intended user, never sudo bash.
# shellcheck disable=SC2016 # Generated shell snippets intentionally retain $HOME and $PATH.
set -Eeuo pipefail

usage() {
  cat <<'HELP'
Usage: bash scripts/install-linux.sh [--help]
       bash scripts/install-linux.sh --setup-peers [--apply] [--peer USER@HOST ...]
       bash scripts/install-linux.sh --wake-timer [HH:MM]
       bash scripts/install-linux.sh --jq
--setup-peers runs on Mac Studio, without installing packages or contacting MacBook Air.
--wake-timer installs only the laptop's daily RTC wake for the OCANNL sweep (default 06:55
local), for a box bootstrapped before that step existed.
--jq installs only the fleet's pinned jq into /usr/local/bin, on native Linux or WSL.
Interactive setup for native Ubuntu 26.04, with Tailscale already connected.
Installs development tools, Codex, Claude Code, Bun and ludics-lite skills;
optionally configures SSH, logins and an OCANNL OCaml 5.5.1 switch.
Prompts before installation. Rerun to finish skipped or interrupted stages.
See scripts/install-linux.md for fleet registration and GPU prerequisites.
HELP
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
ask() {
  local reply
  read -r -p "$1 [y/N] " reply || fail 'Input closed; rerun from a terminal.'
  [[ $reply == [yY] || $reply == [yY][eE][sS] ]]
}
prompt() {
  local reply
  read -r -p "$1 [$2]: " reply || fail 'Input closed; rerun from a terminal.'
  REPLY=${reply:-$2}
}
# Prepend the source before Ubuntu's noninteractive .bashrc early return.
# A file's lines minus one exact line; a read error (grep's 2) fails rather than reading as empty.
without_line() { grep -Fxv -- "$1" "$2" || [[ $? -eq 1 ]]; }

source_at_start() {
  local target=$1 line=$2 tmp
  # Already first is done, through a symlink too; present anywhere else (say below an early
  # `return`) is moved up.
  if [[ -f $target && $(head -n1 "$target") == "$line" ]]; then return; fi
  [[ ! -L $target ]] || fail "Refusing to rewrite symlink $target; add this manually: $line"
  [[ ! -e $target || -f $target ]] || fail "Not a regular file: $target"
  tmp=$(mktemp "${target}.XXXXXX")
  if [[ -f $target ]]; then
    cp -p "$target" "$target.fleet-backup.$(date +%s).$$"
    cp -p "$target" "$tmp"
  else
    chmod 644 "$tmp"
  fi
  printf '%s\n' "$line" > "$tmp"
  if [[ -f $target ]] && ! without_line "$line" "$target" >> "$tmp"; then rm -f -- "$tmp"; fail "Cannot read $target"; fi
  mv "$tmp" "$target"
}
# Idempotently make a line a file's LAST line, so nothing after it can override what it sets;
# an earlier copy is moved down. Never creates the file, and never follows a symlink.
append_line() {
  local target=$1 line=$2 tmp
  if [[ -f $target && $(tail -n1 "$target") == "$line" ]]; then return; fi
  [[ ! -L $target ]] || { printf 'Not rewriting symlink %s; add this line yourself: %s\n' "$target" "$line"; return; }
  [[ -f $target ]] || fail "Missing $target"
  tmp=$(mktemp "${target}.XXXXXX")
  without_line "$line" "$target" > "$tmp" || { rm -f -- "$tmp"; fail "Cannot read $target"; }
  printf '%s\n' "$line" >> "$tmp"
  cat "$tmp" > "$target"  # Rewrite in place: keeps the file's mode and owner.
  rm -f -- "$tmp"
}

# Idempotently remove an exact line; a file without it, or none, is left untouched. Rewrites in
# place as append_line does (mode and owner kept), and never follows a symlink.
drop_line() {
  local target=$1 line=$2 tmp rc=0
  [[ -e $target || -L $target ]] || return 0
  [[ ! -L $target ]] || { printf 'Not rewriting symlink %s; remove this line yourself: %s\n' "$target" "$line"; return; }
  grep -Fxq -- "$line" "$target" || rc=$?
  [[ $rc -ne 1 ]] || return 0
  [[ $rc -eq 0 ]] || fail "Cannot read $target"
  tmp=$(mktemp "${target}.XXXXXX")
  without_line "$line" "$target" > "$tmp" || { rm -f -- "$tmp"; fail "Cannot read $target"; }
  cat "$tmp" > "$target"
  rm -f -- "$tmp"
}

# The fleet's one GitHub PAT goes into gh's own store, never the session's environment
# (ludics-lite#567): a token env.sh exports reaches every process a session starts, and dune
# recorded it in its build trace (ahrefs/ocannl#1280). --insecure-storage keeps it in gh's 0600
# hosts.yml, which ssh and tmux sessions read as they read the file (a keyring they may not). The
# token goes on stdin, with both variables removed: gh refuses to log in while either is set.
store_gh_token() {
  # shellcheck disable=SC1090 # the fleet's token file, copied by hand
  (unset GH_TOKEN; . "$1" >/dev/null 2>&1; printenv GH_TOKEN) |
    env -u GH_TOKEN -u GITHUB_TOKEN gh auth login -h github.com --with-token --insecure-storage
}

# ssh-keygen -l on a private key reads the .pub beside it, so fingerprint a lone copy under
# $scratch; OpenSSH keys carry their public half unencrypted, so no passphrase is asked.
private_fingerprint() {
  local copy=$scratch/lone-key fp
  (umask 077; cp -- "$1" "$copy")
  fp=$(ssh-keygen -l -f "$copy" < /dev/null | awk '{print $2}') || fp=""
  rm -f -- "$copy"
  printf '%s' "$fp"
}

# OpenSSH ignores a private key with any group or other permission; private_fingerprint's 0600
# copy cannot see the original's mode, so it is read here (`ls -ln`, GNU and BSD alike).
private_key_mode_ok() { case "$(ls -ln "$1" 2>/dev/null)" in "-rw------- "*|"-r-------- "*) ;; *) return 1 ;; esac; }

# Both halves fingerprint, and to the same key: two failed reads are two empty strings, which
# would otherwise compare equal.
key_pair_matches() {
  local priv pub
  priv=$(private_fingerprint "$1")
  pub=$(ssh-keygen -l -f "$2" 2>/dev/null | awk '{print $2}')
  [[ -n $priv && $priv == "$pub" ]]
}

clone_if_missing() {
  local repo=$1 dest=$2
  if [[ -e $dest || -L $dest ]]; then
    [[ -d $dest/.git || -f $dest/.git ]] || fail "$dest exists but is not a checkout. Move it aside yourself."
    local origin
    origin=$(git -C "$dest" remote get-url origin)
    case "$origin" in
      "https://github.com/$repo"|"https://github.com/$repo.git"|"git@github.com:$repo.git") ;;
      *) fail "Unexpected origin at $dest: $origin" ;;
    esac
    printf 'Keeping existing checkout: %s (no reset/pull)\n' "$dest"
  else
    git clone "https://github.com/$repo.git" "$dest"
  fi
}
link_skill() {
  local src=$1 dest=$2
  if [[ -L $dest && $(readlink "$dest") == "$src" ]]; then return; fi
  [[ ! -e $dest && ! -L $dest ]] || fail "Skill conflict: $dest. Compare/move it yourself, then rerun."
  ln -s "$src" "$dest"
}
installer() {
  local name=$1 url=$2 interpreter=$3
  if command -v "$name" >/dev/null; then "$name" --version; return; fi
  printf 'Installing %s from %s\n' "$name" "$url"
  curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 "$url" -o "$scratch/$name-install"
  CODEX_NON_INTERACTIVE=1 "$interpreter" "$scratch/$name-install"
  hash -r
  command -v "$name" >/dev/null || fail "$name installer finished but command is not on PATH. Check its output."
  "$name" --version
}

# Accept a bare public key only; keep existing authorized_keys restrictions intact.
authorize_console_key() {
  local key=$1 sshdir=$2 keyfile type blob rest probe
  [[ $key != *$'\n'* && $key != *$'\r'* ]] || fail 'Paste one public-key line.'
  read -r type blob rest <<< "$key"
  case $type in
    ssh-ed25519|ssh-rsa|ecdsa-sha2-*|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-*) ;;
    *) fail 'Expected a bare SSH public key, not a private key or authorized_keys options.' ;;
  esac
  [[ ! -L $sshdir ]] || fail "Refusing symlinked SSH directory: $sshdir"
  mkdir -p "$sshdir"; chmod 700 "$sshdir"
  keyfile=$sshdir/authorized_keys
  [[ ! -L $keyfile && ( ! -e $keyfile || -f $keyfile ) ]] || fail "Refusing nonregular $keyfile"
  probe=$(mktemp "$sshdir/key-check.XXXXXX")
  printf '%s\n' "$key" > "$probe"
  if ! ssh-keygen -lf "$probe"; then
    rm -f "$probe"
    fail 'Invalid public key; authorized_keys was not changed.'
  fi
  rm -f "$probe"
  # Also detect keys already present with restrictions; never add an unrestricted copy.
  if [[ -f $keyfile ]] && awk -v type="$type" -v blob="$blob" '
    /^[[:space:]]*#/ { next }
    { for (i=1; i<NF; i++) if ($i == type && $(i+1) == blob) found=1 }
    END { exit !found }
  ' "$keyfile"; then
    printf 'Public key already present; preserving its existing options.\n'
  else
    # Separate from a last existing line even when it has no terminating newline.
    if [[ -s $keyfile ]]; then printf '\n' >> "$keyfile"; fi
    printf '%s\n' "$key" >> "$keyfile"
  fi
  chmod 600 "$keyfile"
}

# Polkit refuses a sleep block inhibitor to an SSH session by default; fleet runs take one
# (ludics-lite#317) so another session's suspend is refused while they work.
inhibit_rule() {
  [[ $1 =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "Invalid user for the inhibit rule: $1"
  printf '%s\n' '// Generated by ludics-lite/scripts/install-linux.sh (ludics-lite#317).' \
    'polkit.addRule(function(action, subject) {' \
    "    if (subject.user == \"$1\" && action.id == \"org.freedesktop.login1.inhibit-block-sleep\") {" \
    '        return polkit.Result.YES;' '    }' '});'
}

install_inhibit_grant() {
  local rule=/etc/polkit-1/rules.d/50-fleet-inhibit.rules
  inhibit_rule "$(id -un)" > "$scratch/inhibit.rules"
  if ! sudo cmp -s "$scratch/inhibit.rules" "$rule"; then
    sudo install -m 644 "$scratch/inhibit.rules" "$rule"
  fi
}

# logind suspends on lid close even while a run holds a sleep inhibitor, so a fleet laptop on
# external power ignores the lid; on battery it still suspends.
lid_dropin() { printf '%s\n' '# Generated by ludics-lite/scripts/install-linux.sh.' '[Login]' 'HandleLidSwitchExternalPower=ignore'; }

has_lid() { compgen -G "${FLEET_LID_GLOB:-/proc/acpi/button/lid/*}" >/dev/null; }

install_lid_dropin() {
  local conf=/etc/systemd/logind.conf.d/50-fleet-lid.conf
  lid_dropin > "$scratch/lid.conf"
  if ! sudo cmp -s "$scratch/lid.conf" "$conf"; then
    sudo install -D -m 644 "$scratch/lid.conf" "$conf"
  fi
  # Every run, not only on a change: a run interrupted between the install and the reload must
  # still converge on rerun, and the reload is idempotent.
  sudo systemctl reload systemd-logind
}

# A laptop cannot be woken over Wi-Fi, so a fleet laptop that sleeps overnight is woken for the
# OCANNL cross-machine sweep by its own RTC: a system timer with WakeSystem=true re-arms the RTC
# alarm on every suspend (ahrefs/ocannl#1035). The sweep's lane on the box ends by sleeping it
# again (wake-lab.sh sleep). Wakes from suspend or hibernate, not from power-off. The time is
# box-local and belongs a few minutes before the sweep routine fires. That schedule lives in the
# Mac's scheduler registry, not here: `5 7 * * *` local with up to 699 s of jitter (07:05-07:17
# Europe/Zurich), so the default wakes at 06:55. Change both together.
DEFAULT_WAKE_TIME=06:55

# An endpoint is a hostname, never `local` (fleet-worker.sh reads that as the box it runs on) and
# never the macbook-air console, which stays outside FLEET_BOXES as it does outside the ssh mesh.
valid_endpoint() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $1 != local && $1 != macbook-air ]]; }

valid_wake_time() { [[ $1 =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; }

wake_timer() {
  valid_wake_time "$1" || fail "Invalid wake time (want HH:MM, 24-hour): $1"
  printf '%s\n' '# Generated by ludics-lite/scripts/install-linux.sh (ahrefs/ocannl#1035).' \
    '[Unit]' 'Description=Wake this laptop for the OCANNL cross-machine sweep' '' \
    '[Timer]' "OnCalendar=*-*-* $1:00" 'WakeSystem=true' 'AccuracySec=1s' 'Persistent=false' '' \
    '[Install]' 'WantedBy=timers.target'
}

# The timer's unit: the wake is the timer's whole effect, so the service does nothing.
wake_service() {
  printf '%s\n' '# Generated by ludics-lite/scripts/install-linux.sh (ahrefs/ocannl#1035).' \
    '[Unit]' 'Description=Wake this laptop for the OCANNL cross-machine sweep (the RTC wake is the point)' '' \
    '[Service]' 'Type=oneshot' 'ExecStart=/bin/true'
}

install_wake_timer() {
  local dir=/etc/systemd/system unit
  wake_timer "$1" > "$scratch/fleet-sweep-wake.timer"
  wake_service > "$scratch/fleet-sweep-wake.service"
  for unit in fleet-sweep-wake.service fleet-sweep-wake.timer; do
    if ! sudo cmp -s "$scratch/$unit" "$dir/$unit"; then
      sudo install -D -m 644 "$scratch/$unit" "$dir/$unit"
    fi
  done
  sudo systemctl daemon-reload  # every run, as the lid drop-in's reload: a rerun converges
  sudo systemctl enable --now fleet-sweep-wake.timer
}

# rocWMMA is header-only, and OCANNL's HIP backend advertises tensor cores only when it finds
# $HIP_PATH/include/rocwmma (HIP_PATH=/usr here); without it every HIP matmul silently takes the
# scalar fallback (ahrefs/ocannl#1032). Ubuntu's librocwmma-dev 7.1.0-0ubuntu1 omits
# rocwmma/internal/, which turns that clean fallback into a hiprtc failure on every tensorized
# kernel, so the upstream tree for the distro's ROCm release is copied in and the package is
# pinned out. Keep the tag in step with Ubuntu's HIP (hipcc --version).
ROCWMMA_TAG=rocm-7.1.0
ROCWMMA_REPO=https://github.com/ROCm/rocWMMA.git

librocwmma_pin() { printf '%s\n' '# Generated by ludics-lite/scripts/install-linux.sh (ahrefs/ocannl#1032):' \
  "# Ubuntu's package omits rocwmma/internal/; /usr/include/rocwmma comes from upstream." \
  'Package: librocwmma-dev' 'Pin: release *' 'Pin-Priority: -1'; }

install_rocwmma() {
  local src=$scratch/rocWMMA pin=/etc/apt/preferences.d/no-librocwmma-dev
  git clone -q --depth 1 --branch "$ROCWMMA_TAG" "$ROCWMMA_REPO" "$src"
  [[ -f $src/library/include/rocwmma/rocwmma.hpp && -f $src/library/include/rocwmma/internal/types.hpp ]] ||
    fail "rocWMMA $ROCWMMA_TAG has no complete library/include/rocwmma tree."
  librocwmma_pin > "$scratch/no-librocwmma-dev"
  if ! sudo cmp -s "$scratch/no-librocwmma-dev" "$pin"; then
    sudo install -D -m 644 "$scratch/no-librocwmma-dev" "$pin"
  fi
  sudo install -d /usr/include/rocwmma
  sudo cp -r "$src/library/include/rocwmma/." /usr/include/rocwmma/
}

# THE FLEET'S jq IS 1.8 (ludics-lite#508): 1.7.1 and 1.8 parse `A and X as $b | B` differently, and
# CI runs this same release (.github/actions/setup-jq/action.yml, which scripts/test-install-linux.py
# holds this pin to). Ubuntu 26.04's apt jq is already 1.8 (1.8.1); this copy makes the patch CI's,
# and an older WSL distro's apt jq the fleet's minor. apt's jq stays installed, and this copy in
# /usr/local/bin precedes /usr/bin on Ubuntu's default PATH -- not under the hipjit opam package's
# setenv, which prepends /usr/bin, hence the check below. The sums are the release's
# sha256sum.txt. Homebrew is the macs' route.
JQ_VERSION=1.8.2
JQ_SHA256_amd64=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f
JQ_SHA256_arm64=8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309
JQ_DEST=${FLEET_JQ_DEST:-/usr/local/bin/jq}

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

jq_arch() {
  case $1 in
    x86_64|amd64) printf amd64 ;;
    aarch64|arm64) printf arm64 ;;
    *) fail "No jq $JQ_VERSION release pinned for $1." ;;
  esac
}

# Idempotent: a JQ_DEST already holding the pinned binary is left alone, and nothing reaches sudo
# until the download matches its sum.
install_jq() {
  local arch sum
  arch=$(jq_arch "$(uname -m)")
  sum=JQ_SHA256_$arch; sum=${!sum}
  if [[ -f $JQ_DEST && $(sha256_of "$JQ_DEST") == "$sum" ]]; then
    printf 'jq %s already at %s\n' "$JQ_VERSION" "$JQ_DEST"
  else
    curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
      "https://github.com/jqlang/jq/releases/download/jq-$JQ_VERSION/jq-linux-$arch" -o "$scratch/jq"
    [[ $(sha256_of "$scratch/jq") == "$sum" ]] || fail "jq-linux-$arch from jq-$JQ_VERSION does not match its pinned sha256; nothing installed."
    sudo install -m 755 "$scratch/jq" "$JQ_DEST"
  fi
  hash -r
  # A PATH that puts /usr/bin first would keep running apt's jq: say so rather than claim success.
  [[ $(command -v jq) == "$JQ_DEST" ]] ||
    printf 'WARNING: jq on PATH is %s, not %s: put %s before /usr/bin.\n' "$(command -v jq)" "$JQ_DEST" "${JQ_DEST%/*}"
  "$JQ_DEST" --version
}

# jq alone, non-interactively apart from sudo, for native Linux and WSL boxes alike:
#   ssh -t <box> "bash <(printf %s <base64 of this script> | base64 -d) --jq"
jq_only() {
  [[ $# -eq 0 ]] || fail 'Usage: --jq'
  [[ $(uname -s) == Linux ]] || fail 'Run this on the target Linux machine (a mac takes brew install jq).'
  [[ $EUID -ne 0 ]] || fail 'Run as your normal user; the script invokes sudo for the install.'
  scratch=$(mktemp -d)
  scratch=$(cd "$scratch" && pwd -P)
  trap 'rm -rf -- "$scratch"' EXIT
  install_jq
}

# The timer alone, non-interactively apart from sudo, for a box bootstrapped before it existed:
#   ssh -t <box> "bash <(printf %s <base64 of this script> | base64 -d) --wake-timer [HH:MM]"
wake_timer_only() {
  local time=${1:-$DEFAULT_WAKE_TIME}
  [[ $# -le 1 ]] || fail 'Usage: --wake-timer [HH:MM]'
  [[ $(uname -s) == Linux ]] || fail 'Run this on the target Linux machine.'
  [[ $EUID -ne 0 ]] || fail 'Run as your normal user; the script invokes sudo for the timer.'
  valid_wake_time "$time" || fail "Invalid wake time (want HH:MM, 24-hour): $time"
  scratch=$(mktemp -d)
  scratch=$(cd "$scratch" && pwd -P)
  trap 'rm -rf -- "$scratch"' EXIT
  install_wake_timer "$time"
  sudo systemctl list-timers --no-pager fleet-sweep-wake.timer
}

setup_gpu() {
  printf '\nDetected display devices:\n'
  lspci | grep -Ei 'VGA|3D|Display' || true
  prompt 'GPU setup: none, nvidia (ROG), or amd (MINIX/TUF)' none
  local gpu=$REPLY
  case $gpu in
    none) return ;;
    nvidia)
      [[ $(dpkg --print-architecture) == amd64 ]] || fail 'CUDA setup here targets amd64.'
      if ask 'Install the Ubuntu recommended NVIDIA driver and NVIDIA CUDA toolkit?'; then
        sudo apt-get install -y ubuntu-drivers-common "linux-headers-$(uname -r)"
        sudo ubuntu-drivers install
        curl -fL --proto '=https' --tlsv1.2 \
          https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2604/x86_64/cuda-keyring_1.1-1_all.deb \
          -o "$scratch/cuda-keyring.deb"
        sudo dpkg -i "$scratch/cuda-keyring.deb"
        sudo apt-get update
        sudo apt-get install -y cuda-toolkit
        export PATH="/usr/local/cuda/bin:$PATH"
        printf 'Driver changes may require reboot and Secure Boot MOK enrollment. No automatic reboot.\n'
        if ! nvidia-smi; then printf 'GPU not ready yet: reboot, then rerun for cudajit.\n'; fi
        nvcc --version
      fi ;;
    amd)
      printf 'Uses Ubuntu 26.04 HIP/ROCm packages and its in-kernel amdgpu driver.\n'
      printf 'MINIX gfx1151 runtime support still needs validation on this machine.\n'
      if ask 'Install Ubuntu HIP compiler/runtime packages and grant render/video group access?'; then
        if [[ -e /opt/rocm || -e /etc/apt/sources.list.d/rocm.list ]]; then
          fail 'Existing vendor ROCm detected; keep one packaging source. See install-linux.md.'
        fi
        sudo apt-get install -y hipcc libamdhip64-dev rocminfo
        sudo usermod -aG render,video "$(id -un)"
        local gpufile=$HOME/.config/fleet/gpu.sh
        if [[ ! -e $gpufile && ! -L $gpufile ]]; then
          printf '# Ubuntu HIP installs under /usr, not /opt/rocm.\nexport HIP_PATH=/usr\n# Leave ROCM_PATH unset so Ubuntu Clang discovers its device libraries.\n' > "$gpufile"
        fi
        # shellcheck disable=SC1090
        . "$gpufile"
        printf 'Log out fully and back in (or reboot) for GPU group access. Then run rocminfo.\n'
      fi
      if ask "Install rocWMMA ($ROCWMMA_TAG) headers system-wide for OCANNL's HIP tensor-core kernels?"; then
        install_rocwmma
      fi ;;
    *) fail 'GPU choice must be none, nvidia, or amd.' ;;
  esac
}

main() {
  if [[ ${1:-} == --setup-peers ]]; then
    shift
    # As root the helper would configure root's ~/.ssh and authorize root's key on every member.
    [[ $EUID -ne 0 ]] || fail 'Run as your normal user, not with sudo.'
    local helper
    helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fleet-peers.py"
    [[ -f $helper ]] || fail 'Keep fleet-peers.py alongside this script for --setup-peers.'
    python3 "$helper" "$@"
    return
  fi
  if [[ ${1:-} == --wake-timer ]]; then
    shift
    wake_timer_only "$@"
    return
  fi
  if [[ ${1:-} == --jq ]]; then
    shift
    jq_only "$@"
    return
  fi
  case ${1:-} in -h|--help) usage; return ;; '') ;; *) usage >&2; return 2 ;; esac
  [[ $# -eq 0 ]] || fail 'Unexpected arguments.'
  [[ $(uname -s) == Linux ]] || fail 'Run this on the target Linux machine.'
  [[ $EUID -ne 0 ]] || fail 'Run as your normal user; the script invokes sudo for system packages.'
  [[ -t 0 && -t 1 ]] || fail 'Interactive terminal required (SSH: ssh -t HOST). Do not pipe this script into bash.'
  ! grep -qi microsoft /proc/sys/kernel/osrelease || fail 'This installer targets native Linux, not WSL.'
  [[ -f /etc/os-release ]] || fail 'Missing /etc/os-release.'
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 26.04 ]] || fail "This script targets Ubuntu 26.04; found ${ID:-unknown} ${VERSION_ID:-unknown}."
  command -v tailscale >/dev/null || fail 'Tailscale must already be installed and connected.'
  tailscale ip -4 || fail 'Tailscale is not connected.'
  command -v sudo >/dev/null || fail 'Install sudo and grant this user sudo access first.'
  printf 'Native Linux setup: %s, %s, user %s\n' "$PRETTY_NAME" "$(uname -m)" "$(id -un)"
  prompt 'This machine native Tailscale/SSH endpoint (not its WSL endpoint)' "$(hostname -s)"
  local box=$REPLY
  [[ $box =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $box != *wsl* ]] || fail 'Use a native hostname, not a user@host or WSL alias.'
  # Native fleet names verified with tailscale status on mac-studio.
  local default_boxes='mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux'
  if [[ " $default_boxes " != *" $box "* ]]; then default_boxes+=" $box"; fi
  prompt 'Fleet endpoints, space separated (same roster on every coordinator)' "$default_boxes"
  local boxes=$REPLY peer
  for peer in $boxes; do valid_endpoint "$peer" || fail "Invalid endpoint: $peer (a hostname; not 'local', fleet-worker.sh's name for the coordinator's own box, nor the macbook-air console)"; done
  [[ " $boxes " == *" $box "* && " $boxes " == *' mac-studio '* ]] || fail 'Roster must include this endpoint and mac-studio.'
  printf '\nWill install apt packages, user-local CLIs, ~/ludics-lite, skill links, and shell environment.\n'
  ask 'Proceed with the shared setup?' || return 0
  sudo -v
  sudo apt-get update
  sudo apt-get install -y software-properties-common
  sudo add-apt-repository -y universe
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git gh jq ripgrep tmux unzip zip rsync \
    build-essential pkg-config cmake ninja-build clang gdb m4 bubblewrap opam \
    python3 python3-venv python3-pip shellcheck openssh-client openssh-server \
    nodejs npm libgmp-dev libffi-dev libssl-dev zlib1g-dev libopenblas-dev pciutils
  scratch=$(mktemp -d)
  scratch=$(cd "$scratch" && pwd -P)
  trap 'printf "Setup stopped at line %s. Fix the reported error and rerun.\n" "$LINENO" >&2' ERR
  trap 'rm -rf -- "$scratch"' EXIT
  install_jq
  mkdir -p "$HOME/.local/bin" "$HOME/.config/fleet" "$HOME/.claude/skills" "$HOME/.codex/skills"
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
  installer codex https://chatgpt.com/codex/install.sh sh
  installer claude https://claude.ai/install.sh bash
  installer bun https://bun.com/install bash
  clone_if_missing lukstafi/ludics-lite "$HOME/ludics-lite"
  local skill
  for skill in ship-pr wait-and-proceed after-merge issue-wave; do
    [[ -f $HOME/ludics-lite/$skill/SKILL.md ]] || fail "Missing skill: $skill"
    link_skill "$HOME/ludics-lite/$skill" "$HOME/.claude/skills/$skill"
    link_skill "$HOME/ludics-lite/$skill" "$HOME/.codex/skills/$skill"
  done
  local envfile=$HOME/.config/fleet/env.sh
  if [[ -e $envfile || -L $envfile ]]; then
    printf 'Keeping %s; check its roster against the new inputs.\n' "$envfile"
  else
    {
      printf '# Generated by ludics-lite/scripts/install-linux.sh; edit locally.\n'
      printf 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/cuda/bin:/opt/rocm/bin:$PATH"\n'
      printf 'export FLEET_LOCAL_BOX=%q\nexport FLEET_BOXES=%q\n' "$box" "$boxes"
      printf 'export FLEET_ANCHOR=mac-studio\nexport FLEET_FLOTILLA=http://mac-studio:7799\n'
      printf 'export FLEET_SKILLS_REPO=\x27$HOME/ludics-lite\x27\n'
      printf '[ ! -r "$HOME/.config/fleet/gpu.sh" ] || . "$HOME/.config/fleet/gpu.sh"\n'
      printf '[ ! -r "$HOME/.opam/opam-init/init.sh" ] || . "$HOME/.opam/opam-init/init.sh" >/dev/null 2>&1\n'
    } > "$envfile"
  fi
  # Until ludics-lite#567 env.sh sourced the fleet PAT file, exporting the token into every
  # session; gh stores it instead (the login step below), so a rerun drops that line.
  drop_line "$envfile" '[ ! -r "$HOME/.config/fleet/gh-token.sh" ] || . "$HOME/.config/fleet/gh-token.sh"'
  local line='[ ! -r "$HOME/.config/fleet/env.sh" ] || . "$HOME/.config/fleet/env.sh"'
  source_at_start "$HOME/.bashrc" "$line"
  source_at_start "$HOME/.profile" "$line"
  # Bash reads only the first available login file.
  if [[ -f $HOME/.bash_profile ]]; then source_at_start "$HOME/.bash_profile" "$line"
  elif [[ -f $HOME/.bash_login ]]; then source_at_start "$HOME/.bash_login" "$line"; fi
  if [[ ${SHELL:-} != */bash ]]; then
    printf 'Your login shell is %s. Source %s in its SSH startup file too.\n' "${SHELL:-unknown}" "$envfile"
  fi
  if ask 'Enable OpenSSH for fleet access (keeps existing SSH/firewall policy)?'; then
    sudo systemctl enable --now ssh
    printf 'Authorize console public keys below, or use ssh-copy-id from each console later.\n'
  fi
  if ask 'Let fleet runs over SSH hold a sleep inhibitor (polkit rule for this user)?'; then
    install_inhibit_grant
  fi
  if has_lid && ask 'Keep this laptop running with its lid closed on external power?'; then
    install_lid_dropin
  fi
  if has_lid && ask 'Wake this laptop from suspend daily for the OCANNL sweep (RTC timer)?'; then
    prompt 'Local wake time, HH:MM, a few minutes before the sweep routine fires' "$DEFAULT_WAKE_TIME"
    valid_wake_time "$REPLY" || fail "Invalid wake time (want HH:MM, 24-hour): $REPLY"
    install_wake_timer "$REPLY"
  fi
  local console console_key
  for console in mac-studio macbook-air; do
    if ask "Authorize an incoming SSH public key from $console?"; then
      printf 'On %s, copy your SSH .pub file (for example: cat ~/.ssh/id_ed25519.pub).\n' "$console"
      read -r -p 'Paste the public key (one line): ' console_key || fail 'Input closed.'
      authorize_console_key "$console_key" "$HOME/.ssh"
    fi
  done
  if ask 'Configure outbound SSH access to fleet siblings now?'; then
    mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
    if [[ ! -e $HOME/.ssh/id_ed25519 && ! -e $HOME/.ssh/id_ed25519.pub ]]; then
      ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -C "$(id -un)@$box"
    fi
    [[ -f $HOME/.ssh/id_ed25519 && -f $HOME/.ssh/id_ed25519.pub ]] || fail 'Need both halves of ~/.ssh/id_ed25519; configure your existing key manually.'
    private_key_mode_ok "$HOME/.ssh/id_ed25519" ||
      fail 'OpenSSH ignores a private key others can read: chmod 600 ~/.ssh/id_ed25519, then rerun.'
    key_pair_matches "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_ed25519.pub" ||
      fail 'The public key ~/.ssh/id_ed25519.pub does not match its private key; configure your existing key manually.'
    printf 'For a passphrase-protected key, load ssh-agent before running unattended workers.\n'
    for peer in $boxes; do
      [[ $peer != "$box" ]] || continue
      if ask "Install this public key on $peer?"; then
        prompt "SSH user on $peer" "$(id -un)"
        [[ $REPLY =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail 'Invalid SSH user.'
        ssh-copy-id -i "$HOME/.ssh/id_ed25519.pub" "$REPLY@$peer"
        printf 'If that username differs locally, add a Host %s / User %s entry to ~/.ssh/config.\n' "$peer" "$REPLY"
      fi
    done
  fi
  if ask 'Log into GitHub, Codex and Claude now?'; then
    # The fleet's one GitHub PAT (per-box OAuth logins revoked each other). The token file is
    # copied from the anchor by hand; this installer never writes it.
    if [[ -r $HOME/.config/fleet/gh-token.sh ]]; then
      store_gh_token "$HOME/.config/fleet/gh-token.sh"
      gh auth setup-git
    else
      printf 'No ~/.config/fleet/gh-token.sh. From the anchor: ssh %q '\''mkdir -p ~/.config/fleet; f=~/.config/fleet/gh-token.sh; umask 077; cat > "$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f"'\'' < ~/.config/fleet/gh-token.sh\n' "$box"
      printf 'then here: (. ~/.config/fleet/gh-token.sh; printenv GH_TOKEN) | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login -h github.com --with-token --insecure-storage && gh auth setup-git\n'
    fi
    codex login
    claude auth login
  fi
  if ! git config --global user.name >/dev/null; then
    prompt 'Git author name' 'Lukasz Stafiniak'; git config --global user.name "$REPLY"
  fi
  if ! git config --global user.email >/dev/null; then
    prompt 'Git author email' ''; [[ -n $REPLY ]] || fail 'Git email is required.'
    git config --global user.email "$REPLY"
  fi
  setup_gpu
  if ask 'Set up ~/ocannl-staging and its OCaml development dependencies?'; then
    clone_if_missing lukstafi/ocannl-staging "$HOME/ocannl-staging"
    if ! git -C "$HOME/ocannl-staging" remote get-url upstream >/dev/null 2>&1; then
      git -C "$HOME/ocannl-staging" remote add upstream https://github.com/ahrefs/ocannl.git
    fi
    # The aarch64 -march columns of OCANNL's test/operations/cc_march_census compile emitted C with
    # an aarch64 cross gcc found on PATH; without one they skip on every box (ahrefs/ocannl#621).
    sudo apt-get install -y gcc-aarch64-linux-gnu
    opam init --bare --no-setup -y
    if ! opam switch list --short | grep -Fxq fleet-5.5.1; then
      opam switch create fleet-5.5.1 ocaml-base-compiler.5.5.1 -y
    fi
    if [[ $(opam exec --switch=fleet-5.5.1 -- ocamlc -version) != 5.5.1 ]]; then
      fail "Existing fleet-5.5.1 switch has a different compiler; inspect it manually."
    fi
    opam switch set fleet-5.5.1
    eval "$(opam env --switch=fleet-5.5.1 --set-switch)"
    (cd "$HOME/ocannl-staging"; opam install . --deps-only --with-test --with-dev-setup -y)
    if ask 'Install CUDA bindings (requires working NVIDIA driver and CUDA >=12.8 already installed)?'; then
      command -v nvcc >/dev/null || fail 'CUDA toolkit missing; rerun after setup.'
      local cuda_version
      cuda_version=$(nvcc --version | sed -n 's/.*release \([0-9]*\.[0-9]*\),.*/\1/p')
      [[ -n $cuda_version ]] || fail 'Could not read CUDA toolkit version.'
      dpkg --compare-versions "$cuda_version" ge 12.8 || fail 'OCANNL requires CUDA >=12.8.'
      nvidia-smi || fail 'NVIDIA driver not loaded; reboot and rerun.'
      opam install cudajit -y
    fi
    if ask 'Install HIP bindings (requires working ROCm already installed)?'; then
      [[ -r /dev/kfd && -w /dev/kfd ]] || fail 'No access to /dev/kfd. Reboot/log in after GPU setup, then rerun.'
      rocminfo > "$scratch/rocminfo"
      grep -Eq 'Name:.*gfx[0-9]+' "$scratch/rocminfo" || fail 'ROCm reports no GPU agent.'
      opam install hipjit -y
    fi
    if ask 'Build OCANNL now?'; then (cd "$HOME/ocannl-staging"; dune build); fi
  fi
  printf '\nSetup stages finished. Open a new login shell before using the tools.\n'
  printf 'Next: register this endpoint in the hub Flotilla config and coordinator roster.\n'
  printf 'Verify from the hub: ssh %q '\''command -v codex claude bun opam; printf "%%s\\n" "$FLEET_LOCAL_BOX"'\''\n' "$box"
  printf 'Then run fleet-worker.sh preflight %q --codex (and without --codex for Claude).\n' "$box"
}

# Sourceable for isolated helper tests; importing this file never installs anything.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
