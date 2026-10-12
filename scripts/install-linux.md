# Native Ubuntu fleet setup

Target: **Ubuntu 26.04**, a normal sudo-capable user, existing Tailscale connection.
Run once on each native installation, then rerun after reboot to finish GPU setup.
This does not install an OS, reconfigure Tailscale, or change the bootloader.

## Get it onto a fresh machine

The normal installer is self-contained (it clones `~/ludics-lite` itself); no checkout is
required on workers. The optional `--setup-peers` mode uses the sibling
`fleet-peers.py` helper on Mac Studio. From this Mac, copy `scripts/install-linux.sh` to the machine using a USB
stick, or SCP if SSH already works:

```sh
scp ~/ludics-lite/scripts/install-linux.sh USER@NATIVE-ENDPOINT:~/install-linux.sh
ssh -t USER@NATIVE-ENDPOINT 'bash ~/install-linux.sh'
```

For the first setup you can use the local Ubuntu terminal instead. Run
`bash ~/install-linux.sh` as the user who will run agents, **not with sudo**.
If SSH is not yet available, use the local console or install it there with
`sudo apt install openssh-server`. Tailscale connectivity alone does not mean
OpenSSH or Tailscale SSH is enabled. Existing Tailscale SSH policy is left alone.

The script asks for the native endpoint and full roster. Use names from
`tailscale status`, not the WSL names. Use the same complete roster on each
machine and on the coordinator. The default roster, verified with Tailscale status,
is `mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux`. An unlisted current
endpoint is appended automatically. You can edit the roster at the prompt.
These are the native Linux endpoints, distinct from the existing `*-wsl` and
`*-win` names. SSH usernames are prompted separately: Tailscale account ownership
does not tell us the target Unix username.

## What gets installed

- Ubuntu build tools, Git/GitHub CLI, jq, ripgrep, tmux, SSH, Python/venv, Node/npm,
  opam, ShellCheck, OpenBLAS and common native build dependencies; enables Universe.
- jq **1.8.2** from the jqlang/jq release binary, checksum-verified, at `/usr/local/bin/jq`
  (ludics-lite#508): the fleet and CI run jq 1.8, since 1.7.1 parses `A and X as $b | B`
  differently. The pin is the one `.github/actions/setup-jq/action.yml` installs in CI. Ubuntu
  26.04's apt jq is already 1.8.1 and stays installed; this copy makes the patch CI's. A rerun with
  the pinned binary in place downloads nothing. On a box where something prepends `/usr/bin` to
  PATH -- the `hipjit` opam package's setenv does, on minix and tuf -- apt's jq still wins, and the
  step says so. A box bootstrapped before this step existed, or a WSL box (which the full
  installer refuses), takes jq alone, from the Mac: `git -C ~/ludics-lite fetch -q origin && ssh
  -t <box> "bash <(printf %s $(git -C ~/ludics-lite show origin/main:scripts/install-linux.sh |
  base64 | tr -d '\n') | base64 -d) --jq"`. Check: `command -v jq` is `/usr/local/bin/jq`, `jq
  --version` prints `jq-1.8.2`, and `jq -nc '[true and ("x") as $b | ($b == "x")]'` prints
  `[false]`. The macs take Homebrew's: `brew install jq`, which shadows Apple's 1.7.1 wherever
  `/opt/homebrew/bin` comes first; `scripts/preflight.sh jq-version` says which jq a shell finds.
- User-local Codex, Claude Code and Bun using their official installers.
  Existing commands are kept. Installers fetch current releases; this is a
  bootstrap, not a version-locked environment reproduction.
- `~/ludics-lite` and all four fleet skills linked into both agent skill directories.
- `~/.config/fleet/env.sh`, sourced before Ubuntu's `.bashrc` interactive guard and
  from Bash login startup files. This makes the tools and native endpoint identity
  visible to SSH-launched workers. Other login shells need equivalent setup.
- Optional polkit rule `/etc/polkit-1/rules.d/50-fleet-inhibit.rules` letting this user
  hold a sleep block inhibitor from an SSH session, so a fleet run refuses another
  session's suspend (ludics-lite#317). Check: `pkcheck --action-id
  org.freedesktop.login1.inhibit-block-sleep --process $$` exits 0.
- On a laptop, an optional logind drop-in `/etc/systemd/logind.conf.d/50-fleet-lid.conf`
  (`HandleLidSwitchExternalPower=ignore`): logind suspends on lid close even under a held
  inhibitor, so on external power the lid is ignored; on battery it still suspends. Check:
  `busctl get-property org.freedesktop.login1 /org/freedesktop/login1
  org.freedesktop.login1.Manager HandleLidSwitchExternalPower` prints `s "ignore"`.
- On a laptop, an optional daily RTC wake: `/etc/systemd/system/fleet-sweep-wake.timer`
  (`WakeSystem=true`, `OnCalendar=` the local time you enter) and its do-nothing service. A
  Wi-Fi laptop cannot be woken over the network, so this is what wakes it for the OCANNL
  cross-machine sweep (ahrefs/ocannl#1035). The default, 06:55, is ten minutes before the sweep
  routine fires (the Mac scheduler's `5 7 * * *`, plus up to 699 s of jitter); change both
  together. A box bootstrapped before this step existed can install the timer alone, from the Mac:
  `git -C ~/ludics-lite fetch -q origin && ssh -t <box> "bash <(printf %s $(git -C ~/ludics-lite
  show origin/main:scripts/install-linux.sh | base64 | tr -d '\n') | base64 -d) --wake-timer"`
  (append a `HH:MM` after `--wake-timer` for another time). The sweep's lane on the box ends with
  `wake-lab.sh sleep`, so the box does not stay up all day. It wakes from suspend or hibernate,
  not from power-off. Check: `systemctl show -p WakeSystem -p TimersCalendar
  fleet-sweep-wake.timer` shows `WakeSystem=yes` and the time, and `systemctl list-timers
  fleet-sweep-wake.timer` its next firing.
- No GitHub token in `env.sh` (ludics-lite#567): a rerun removes the line that used to source
  `~/.config/fleet/gh-token.sh`, since a token in the environment reaches every process a session
  starts (dune recorded it in its build trace, ahrefs/ocannl#1280). That file (`export
  GH_TOKEN=ghp_...`, mode 0600) holds the fleet's one GitHub PAT, copied from the anchor by hand,
  never written by the installer. Per-box `gh auth login` OAuth tokens revoked each other (GitHub
  keeps 10 per user and app). Copy it with `ssh <box> 'mkdir -p ~/.config/fleet; f=~/.config/fleet/gh-token.sh; umask 077; cat > "$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f"'
  < ~/.config/fleet/gh-token.sh`; the login step then stores it in gh (`gh auth login
  --with-token --insecure-storage`, fed on stdin with `GH_TOKEN`/`GITHUB_TOKEN` unset) and runs
  `gh auth setup-git`. Rotating the PAT repeats both: copy the file, then rerun the login step or
  the store command the preflight prints.
- Optional interactive Codex/Claude login, git routed through the PAT, and SSH key provisioning.
  If Codex login cannot open a callback over SSH, use `codex login --device-auth`.
- Optional `~/ocannl-staging`, upstream `ahrefs/ocannl`, a named OCaml **5.5.1**
  switch, test/dev dependencies from the project opam files, and a build.
  The switch becomes the opam default; existing switches are retained.
  The stage also installs `gcc-aarch64-linux-gnu`: the cross compiler behind the aarch64 columns
  of OCANNL's `cc_march_census`, the only check of gcc's aarch64 fp16 builtin typing
  (ahrefs/ocannl#621). Without it those columns skip on every box. Check with
  `aarch64-linux-gnu-gcc --version`. rog and minix got a rootless copy instead:
  `apt-get download` + `dpkg-deb -x` into `~/.local/opt/aarch64-linux-gnu-gcc-15`, reached by a
  wrapper at `~/.local/bin/aarch64-linux-gnu-gcc` that puts the extracted binutils' private
  libraries on `LD_LIBRARY_PATH`, since they carry no RPATH.
- Optional NVIDIA or AMD GPU setup below, and `cudajit` / `hipjit` bindings.

Existing repositories are checked for the expected origin and left untouched.
Skill conflicts stop with instructions rather than replacing local work. Existing
fleet configuration is retained: edit it if changing the roster. Shell startup
files get a backup before editing, and symlinked startup files require a manual
source line. A failed stage exits; fix its error and rerun. Prompts default to No,
so answer Yes to the stages you want, including the shared setup on each rerun.
No credentials are copied from the Mac or committed by this script.

## GPU setup and reboot

Choose `nvidia` on ROG. The script installs Ubuntu's recommended driver through
`ubuntu-drivers`, registers NVIDIA's **ubuntu2604** repository, and installs
`cuda-toolkit`. It adds `/usr/local/cuda/bin` to the worker PATH. Follow any Secure
Boot/MOK password prompt; enroll the key at the next boot if requested. Reboot
manually, then check `nvidia-smi` and `nvcc --version` before installing `cudajit`.
OCANNL requires CUDA >=12.8. A successful toolkit install does not prove the loaded
driver supports it; GPU execution below is the final check.

Choose `amd` on MINIX or TUF. Native HIP and HIPRTC kernel smoke tests passed on
MINIX (Radeon 8060S, gfx1151) and TUF (RX 7700S, gfx1102) with these Ubuntu packages. The script uses Ubuntu 26.04's `hipcc`, `libamdhip64-dev`
and `rocminfo` with Ubuntu's in-kernel amdgpu driver, adds the user to `render`
and `video`, and sets `HIP_PATH=/usr` in `gpu.sh`. Leave `ROCM_PATH` unset:
forcing it to `/usr` breaks Ubuntu Clang's device-library discovery. Fully log
out and back in, or reboot, before checking `rocminfo`: it must list a GPU agent
(`gfx1151` on the recorded MINIX), not just the CPU. Confirm `/dev/kfd` and the
render node under `/dev/dri` are accessible by your user.

A second AMD prompt installs rocWMMA (`rocm-7.1.0`, header-only) into
`/usr/include/rocwmma`. OCANNL's HIP backend advertises tensor cores only when it
finds `$HIP_PATH/include/rocwmma`; without it every HIP matmul silently takes the
scalar fallback (ahrefs/ocannl#1032). Ubuntu's `librocwmma-dev` 7.1.0-0ubuntu1
omits `rocwmma/internal/`, which would break every tensorized kernel in hiprtc, so
the upstream tree is copied instead and the package is pinned out by
`/etc/apt/preferences.d/no-librocwmma-dev`. Keep the tag in step with Ubuntu's HIP.
Check: `ls /usr/include/rocwmma/internal/types.hpp`.

If enumeration or HIP runtime compilation fails on a new AMD box, capture `uname -r`, `lspci -nnk`, `rocminfo`,
`hipcc --version`, and `apt-cache policy hipcc libamdhip64-dev`. Check AMD's current
Ryzen support matrix before moving to its vendor stack. Do not install Ubuntu
24.04 (`noble`) vendor packages or its OEM kernel onto 26.04, mix vendor and Ubuntu
ROCm packages, or mask hardware problems with `HSA_OVERRIDE_GFX_VERSION`.
The script refuses an obvious existing vendor install; it is not a migration tool.
Do not enlarge shared GPU memory until basic device/runtime tests pass.

After reboot, rerun the installer, choose `none` for already-installed GPU tools,
and Yes to OCANNL plus the relevant binding. From a new terminal:

```sh
cd ~/ocannl-staging
eval "$(opam env --switch=fleet-5.5.1 --set-switch)"
dune build
OCANNL_BACKEND=cc dune runtest
# Run the applicable GPU suite separately, through tools/test-run.sh so its
# per-box width cap applies (a full-width hip suite exhausts MINIX's SDMA queues):
OCANNL_BACKEND=cuda tools/test-run.sh run build @runtest   # ROG
OCANNL_BACKEND=hip tools/test-run.sh run build @runtest    # MINIX, TUF
```

These are acceptance checks to run on the real hardware, not tests already run
by the authoring session. Do not run a fleet wave until the applicable backend
works. Python ML packages such as PyTorch are deliberately left for a project
venv and a GPU-specific wheel choice; system Python is not modified with pip.

## Exchange peer keys once, from Mac Studio

After each Linux machine accepts Mac Studio's default public key and SSH works
from the hub, run the peer mode on **Mac Studio**. It bypasses all package, GPU,
login, and development setup prompts:

```sh
# Read-only discovery and plan:
bash ~/ludics-lite/scripts/install-linux.sh --setup-peers
# Generate missing worker keys, exchange public metadata, and verify every pair:
bash ~/ludics-lite/scripts/install-linux.sh --setup-peers --apply
```

When traveling, SSH from MacBook Air to Mac Studio and run those same commands
there. The Air is your communication window. It is not contacted, configured,
or granted incoming fleet access by this mode. It is explicitly refused as a mesh
member. The mesh is `mac-studio`, `rog-nv-linux`, `minix-amd-linux`, `tuf-amd-linux`;
Mac Studio participates in both directions, so workers can call back to it.

The coordinator must already authenticate to each member with trusted host keys.
If necessary, make one ordinary `ssh USER@HOST` connection from Mac Studio first.
The command never disables host-key checking or guesses initial trust. Python 3
and OpenSSH are required on every member. For differing initial login usernames,
replace the default roster with repeated `--peer` arguments, including Mac Studio:

```sh
bash ~/ludics-lite/scripts/install-linux.sh --setup-peers --apply \
  --peer mac-studio --peer alice@rog-nv-linux \
  --peer bob@minix-amd-linux --peer carol@tuf-amd-linux
```

The authenticated login supplies each actual username. Mac Studio keeps its
existing `~/.ssh/id_ed25519`; the workers generate `~/.ssh/id_ed25519_fleet` if
missing. These dedicated worker keys have no passphrase for unattended use; an
existing protected fleet key causes a refusal rather than removing its passphrase.
No private key leaves its machine. Mac Studio collects only public keys and each
member's `/etc/ssh/ssh_host_ed25519_key.pub` over its established SSH connection.
It then configures:

- `authorized_keys`: add the other three members, retaining existing console keys
  and existing restrictions. No removals, even if a later roster drops a member.
- `fleet_known_hosts`: verified peer host keys for first-contact trust. A conflicting
  existing Ed25519 key or host-key marker requires manual inspection.
- `fleet.conf`: peer usernames, identities, and strict host-key checking.
- `config`: prepend one Include for `fleet.conf`, keeping all other configuration.
  The mesh's explicit settings take precedence for those host names.

Files changed by the helper receive timestamped backups. Repeating the command
reuses keys and avoids duplicate entries. Concurrent writes to one machine's `~/.ssh`
refuse on its `.ssh/.fleet-peers.lock`; the lock is per machine, not per run, so run
one `--setup-peers --apply` at a time (it is a by-hand step on the coordinator). After
an interrupted process, inspect that lock before removing it. This is a rerunnable bootstrap, not an atomic distributed transaction:
if a member drops offline during application, earlier members retain their updates;
fix connectivity and rerun. It does not rotate/revoke keys or enroll a machine
that the coordinator cannot already access.

The final check makes every member SSH to every other member in BatchMode and
verifies the remote username: **12 directed connections**. Failure is reported
with its direction and causes a nonzero exit. Full live validation passed on the
four-machine fleet; this proves SSH reachability, not the agent/provider preflight.
The separate per-worker `ssh-copy-id` prompts remain available as a manual alternative.

## SSH and fleet registration

The installer offers incoming public-key authorization for **mac-studio** and
**macbook-air** (the mobile console). Paste each console's public key when prompted.
The Air does not need to be online during installation if you already have its
public key. It stays outside `FLEET_BOXES`: sleeping mobile consoles should not
be required by worker cross-peer preflight.

On the Air, inspect `~/.ssh/*.pub` and use the key you normally use for SSH. If
there is no key, generate one with `ssh-keygen -t ed25519` (keep a passphrase for
a mobile console), then copy `cat ~/.ssh/id_ed25519.pub`. Transfer only the `.pub`
file or its one-line contents. The installer validates it, appends it without
replacing existing keys, and preserves restrictions if that key is already present.
Standard OpenSSH permits that key to log in as the user running the installer;
existing sshd and Tailscale access policy still apply.

Alternatively, skip those prompts and, when each console is online, authorize its
key on each native worker from that console:

```sh
ssh-copy-id -i ~/.ssh/id_ed25519.pub USER@NATIVE-ENDPOINT
ssh -o BatchMode=yes USER@NATIVE-ENDPOINT 'command -v codex claude bun opam; echo "$FLEET_LOCAL_BOX"'
```

From the Air, repeat for `rog-nv-linux`, `minix-amd-linux` and `tuf-amd-linux`,
using each target's Linux username. With the Air's passphrase key loaded in its
agent, verify `ssh -o BatchMode=yes USER@ENDPOINT true`. Authorizing the Air's key
on a worker does not require the worker to have access back to the Air. Tailscale
must be connected on both machines, and its policy must permit Air-to-worker SSH.
If Tailscale SSH is enabled instead of OpenSSH on that endpoint, configure its
SSH policy too: OpenSSH `authorized_keys` does not grant Tailscale SSH access.

The installer can also run `ssh-copy-id` in the reverse direction and between
workers. For differing usernames, add `Host NATIVE-ENDPOINT` / `User USER` entries
in each caller's `~/.ssh/config`. Keep host-key checking enabled. A passphrase key
needs an unlocked ssh-agent accessible to the worker launch session; a successful
interactive copy alone does not prove unattended access. Test `ssh -o BatchMode=yes
ENDPOINT true` in both directions. If a firewall blocks SSH, inspect the existing
policy and allow the required access on `tailscale0`; the script does not reset it.
Installing openssh-server can start the service under Ubuntu package defaults.

On mac-studio, add a `linux` endpoint alongside `wsl` and `win` in the appropriate
machine in `~/flotilla/flotilla.config.json`:

```json
{"id": "linux", "kind": "unix", "host": "NATIVE-ENDPOINT"}
```

The existing machine grouping and Wake-on-LAN data stay the same. Flotilla pipes
its collector over SSH: no Bun server or monitoring daemon is needed on workers.
Update the coordinator's `FLEET_BOXES` to match the new roster. Its own
`FLEET_LOCAL_BOX` remains `mac-studio`; never copy a worker's env.sh onto the hub.
The old hostname mapping otherwise identifies native ROG/MINIX as their WSL
endpoints, which is why each new worker has an explicit identity.
Update the sequencing plan's placement names when choosing native Linux for work.

From the coordinator, validate each target (these probes can use provider quota):

```sh
~/.claude/skills/issue-wave/scripts/fleet-worker.sh preflight NATIVE-ENDPOINT --codex
~/.claude/skills/issue-wave/scripts/fleet-worker.sh preflight NATIVE-ENDPOINT
```

## Sources and local validation

Installation sources checked while writing the script:
[Codex](https://developers.openai.com/codex/cli),
[Claude Code](https://code.claude.com/docs/en/setup),
[Bun](https://bun.com/docs/installation),
[Ubuntu NVIDIA drivers](https://ubuntu.com/desktop/docs/en/latest/how-to/graphics/install-nvidia-drivers/),
[NVIDIA CUDA](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/),
[Ubuntu 26.04 HIP packages](https://packages.ubuntu.com/en/resolute/devel/hipcc),
[AMD ROCm documentation](https://rocm.docs.amd.com/en/latest/).
Local fleet conventions come from ludics-lite's README and fleet-worker.sh,
Flotilla's README/configuration, and OCANNL's AGENTS.md and opam files.

```sh
bash -n scripts/install-linux.sh
shellcheck scripts/install-linux.sh
python3 scripts/test-install-linux.py
python3 scripts/test-fleet-peers.py
```
