# tui-ssh

Anonymous SSH gateway that drops every connection straight into a TUI
(no shell, no auth, no accounts). Inspired by `ssh terminal.shop`.

A connecting client gets a PTY running `TUI_CMD` (defaults to the `tui-rezi`
app) and nothing else: `exec` requests are rejected and there is no fallback
shell. They cannot `ls`, `cd`, or run commands on the host.

---

## How it works

- Listens on `:2222` (configurable via `PORT`).
- Accepts SSH `none` auth only — explicitly rejects `password` and `publickey`
  so clients aren't misled into thinking their credentials worked.
- On `shell` request, spawns `TUI_CMD` (default: `bun src/main/App.tsx` in
  `../tui-rezi`) inside a PTY and pipes it bidirectionally to the SSH channel.
- Enforces caps: **3 concurrent connections per IP**, **100 global**,
  **10s handshake timeout**, **10min idle timeout**, **1 MiB outbound buffer**
  (kills the session on overflow rather than growing unbounded).

---

## Local dev (any OS with Bun)

```sh
bun install
bun run dev          # auto-restart on changes
# or
bun run start
```

Then from another terminal:

```sh
ssh -p 2222 anything@localhost
```

(The username is ignored.)

---

## Ubuntu server deployment

Tested on Ubuntu 22.04 / 24.04. Assumes you have sudo on a fresh box.

### 1. Install build dependencies

`node-pty` compiles native bindings on install, so you need a toolchain:

```sh
sudo apt update
sudo apt install -y build-essential python3 git curl unzip
```

### 2. Install Bun system-wide

```sh
curl -fsSL https://bun.sh/install | sudo bash -s -- --install-dir /usr/local
sudo ln -sf /usr/local/bun /usr/local/bin/bun
bun --version    # sanity check
```

### 3. Create an unprivileged service user

**Do not run tui-ssh as root.** The TUI process inherits this user's
permissions, so this is your blast radius if anything ever escapes.

```sh
sudo useradd --system --create-home --home-dir /var/lib/tuissh --shell /usr/sbin/nologin tuissh
```

### 4. Deploy the code

```sh
sudo -u tuissh -H bash <<'EOF'
cd /var/lib/tuissh
git clone <your-tui-ssh-repo-url> tui-ssh
git clone <your-tui-rezi-repo-url> tui-rezi   # or whatever TUI you serve
cd tui-ssh
bun install
EOF
```

If you serve a different TUI, set `TUI_DIR`, `TUI_CMD`, `TUI_ARGS` in the
systemd unit below instead of cloning `tui-rezi`.

### 5. Generate the host key out-of-band (optional but cleaner)

The server auto-generates `host.key` next to the binary on first run. For a
predictable location and clear ownership:

```sh
sudo -u tuissh ssh-keygen -t ed25519 -N '' -f /var/lib/tuissh/host.key
sudo chmod 600 /var/lib/tuissh/host.key
```

(The server currently generates RSA-2048 if it makes its own — Ed25519 via
`ssh-keygen` is preferred. This is finding #11 from the security review,
still open in code.)

### 6. systemd unit with hardening

```sh
sudo tee /etc/systemd/system/tuissh.service >/dev/null <<'EOF'
[Unit]
Description=tui-ssh anonymous SSH gateway
After=network.target

[Service]
Type=simple
User=tuissh
Group=tuissh
WorkingDirectory=/var/lib/tuissh/tui-ssh
ExecStart=/usr/local/bin/bun src/index.ts
Restart=always
RestartSec=2

# --- env ---
Environment=PORT=2222
Environment=HOST=0.0.0.0
Environment=SSH_HOST_KEY=/var/lib/tuissh/host.key
Environment=TUI_DIR=/var/lib/tuissh/tui-rezi
Environment=TUI_CMD=/usr/local/bin/bun
Environment=TUI_ARGS=src/main/App.tsx

# --- hardening ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false   # node-pty / bun JIT need this off
ReadWritePaths=/var/lib/tuissh
MemoryMax=512M
TasksMax=400

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now tuissh
sudo systemctl status tuissh
```

### 7. Firewall

Open `2222` inbound. Keep your real `sshd` on `22` locked down separately
(key-only auth, fail2ban, admin IPs).

```sh
sudo ufw allow 2222/tcp
sudo ufw status
```

### 8. Verify

From your laptop:

```sh
ssh -p 2222 anyone@<server-ip>
```

You should land inside the TUI. `Ctrl+C` disconnects (the server intercepts it).
Try also:

```sh
ssh -p 2222 -o PreferredAuthentications=password user@<server-ip>
# expected: Permission denied (none).

ssh -p 2222 user@<server-ip> whoami
# expected: connection ends with no output — exec is rejected.
```

Watch logs:

```sh
sudo journalctl -u tuissh -f
```

You should see `[ssh:xxxxxx] ready <ip>` on connect and `[ssh:xxxxxx] close (total=N)` on disconnect.

---

## Operations

| Action          | Command                                  |
| --------------- | ---------------------------------------- |
| Restart         | `sudo systemctl restart tuissh`          |
| Stop            | `sudo systemctl stop tuissh`             |
| Tail logs       | `sudo journalctl -u tuissh -f`           |
| Recent errors   | `sudo journalctl -u tuissh -p err -n 50` |
| Update code     | `sudo -u tuissh git -C /var/lib/tuissh/tui-ssh pull && sudo systemctl restart tuissh` |
| Connection count| Grep `total=` in the logs.               |

---

## Configuration

All via environment variables:

| Var             | Default                       | Notes                                  |
| --------------- | ----------------------------- | -------------------------------------- |
| `PORT`          | `2222`                        |                                        |
| `HOST`          | `0.0.0.0`                     | Bind interface.                        |
| `SSH_HOST_KEY`  | `<repo>/host.key`             | Auto-generated if missing.             |
| `TUI_DIR`       | `../tui-rezi`                 | `cwd` for the spawned TUI.             |
| `TUI_CMD`       | `process.execPath` (bun/node) | Absolute path recommended.             |
| `TUI_ARGS`      | `src/main/App.tsx`            | Space-separated.                       |

The concurrency caps and timeouts are constants in `src/index.ts` — edit
there if you need different values (`MAX_PER_IP`, `MAX_TOTAL`,
`HANDSHAKE_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`, `MAX_BUFFER`).

---

## Security posture

**Mitigated** (in current code):

- Per-IP and global connection caps.
- Handshake and idle timeouts.
- Bounded outbound buffer (kills sessions instead of OOM).
- Auth method check (only `none` accepted).
- `exec` requests rejected (no remote command execution).

**Still open** (see security review):

- `#5` SSH algorithms use ssh2 defaults — pin modern KEX/cipher/MAC.
- `#6/7` `cols`/`rows`/`term` from client are not clamped/validated.
- `#8` Full `process.env` is forwarded to the TUI — use an allowlist if
  the service environment contains secrets unrelated to the TUI.
- `#10` Only `exec` is explicitly rejected; `subsystem`, `signal`, `env`,
  agent-forwarding, and global TCP-forward requests rely on ssh2 defaults.
- `#11` Host key auto-gen is RSA-2048 — prefer Ed25519 (see step 5).
- `#12` Host key file mode is irrelevant on Windows but fine on Linux as
  long as it lives under `/var/lib/tuissh/` owned `0600` by `tuissh`.

Before exposing to the public internet, at minimum address `#5` and `#8`.
