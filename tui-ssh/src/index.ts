// Bun-only server. Must be launched with `bun`, NOT `node`.
// Fails loudly below if Bun is missing so you don't get a silent no-op on the server.
declare const Bun: any;
if (typeof Bun === "undefined") {
  // This is the #1 "works locally, dead on Ubuntu" cause: the service/Docker/systemd
  // entrypoint runs `node dist/...` instead of `bun src/...`.
  console.error(
    "[ssh] FATAL: this server requires Bun (uses Bun.spawn + pty). " +
      "Launch it with `bun <thisfile>` — not node.",
  );
  process.exit(1);
}

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Server, type ServerChannel } from "ssh2";

const PORT = Number(process.env.PORT) || 2222;
const HOST = process.env.HOST || "0.0.0.0";

// ---- TUI_DIR resolution -------------------------------------------------
// On a server, __dirname after a build/deploy rarely matches dev layout, so the
// old `../../tui-rezi` default silently pointed at a nonexistent path and the
// process exited immediately. Try several candidates and let env override win.
function resolveTuiDir(): string {
  if (process.env.TUI_DIR) return path.resolve(process.env.TUI_DIR);
  const candidates = [
    path.resolve(__dirname, "..", "..", "tui-rezi"),
    path.resolve(__dirname, "..", "tui-rezi"),
    path.resolve(__dirname, "tui-rezi"),
    path.resolve(process.cwd(), "tui-rezi"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]; // fall through; existence is checked below with a clear error
}

const TUI_DIR = resolveTuiDir();
const TUI_CMD = process.env.TUI_CMD || process.execPath;
const TUI_ARGS = (process.env.TUI_ARGS || "src/main/App.tsx")
  .split(" ")
  .filter(Boolean);

const IS_WINDOWS = process.platform === "win32";

// ---- Writable HOME ------------------------------------------------------
// /var/lib/tuissh usually does NOT exist on a fresh Ubuntu box. Ensure a usable,
// writable HOME or fall back to a temp dir so the shell/TUI can write its config.
function ensureWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHome(): string {
  const preferred =
    process.env.HOME ||
    (IS_WINDOWS ? process.env.USERPROFILE || "C:\\" : "/var/lib/tuissh");
  if (ensureWritableDir(preferred)) return preferred;
  const fallback = path.join(os.tmpdir(), "tuissh-home");
  if (ensureWritableDir(fallback)) {
    console.warn(`[ssh] HOME ${preferred} not writable -> using ${fallback}`);
    return fallback;
  }
  return os.tmpdir();
}

const DEFAULT_TERM = process.env.TUI_TERM || "xterm-256color";
const DEFAULT_HOME = resolveHome();
const DEFAULT_PATH =
  process.env.PATH ||
  (IS_WINDOWS
    ? "C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Git\\bin"
    : "/usr/local/bin:/usr/bin:/bin");

// ---- Host key (writable path + dir creation) ----------------------------
const HOST_KEY_PATH = (() => {
  const p =
    process.env.SSH_HOST_KEY || path.resolve(__dirname, "..", "host.key");
  return p;
})();

const MAX_PER_IP = 3;
const MAX_TOTAL = 100;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 1 << 20;

const perIp = new Map<string, number>();
let total = 0;

function loadOrGenerateHostKey(): Buffer {
  if (fs.existsSync(HOST_KEY_PATH)) return fs.readFileSync(HOST_KEY_PATH);
  const dir = path.dirname(HOST_KEY_PATH);
  if (!ensureWritableDir(dir)) {
    console.error(
      `[ssh] FATAL: host key dir not writable: ${dir}. ` +
        `Set SSH_HOST_KEY to a writable absolute path (e.g. /var/lib/tuissh/host.key).`,
    );
    process.exit(1);
  }
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  fs.writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  console.log(`[ssh] generated host key -> ${HOST_KEY_PATH}`);
  return Buffer.from(privateKey);
}

if (!fs.existsSync(TUI_DIR)) {
  console.error(
    `[ssh] FATAL: TUI_DIR does not exist: ${TUI_DIR}. ` +
      `Set TUI_DIR to the absolute path of your tui-rezi directory.`,
  );
  process.exit(1);
}

function safeWrite(stream: ServerChannel, data: string): boolean {
  try {
    if (!stream.writable || stream.destroyed) return false;
    return stream.write(data);
  } catch {
    return false;
  }
}

function clampTerm(term?: string): string {
  const t = (term || DEFAULT_TERM).trim();
  if (!t) return DEFAULT_TERM;
  return /^[A-Za-z0-9+_.-]{1,64}$/.test(t) ? t : DEFAULT_TERM;
}

function clampSize(
  n: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(Number(n))));
}

function buildCommandAndArgs(cmd: string, args: string[], cwd: string) {
  if (IS_WINDOWS) {
    const shell = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    const command = [cmd, ...args].join(" ");
    return { command: shell, args: ["/d", "/s", "/c", command], cwd };
  }
  // Run the TUI DIRECTLY — no shell wrapper. This is the fix for the server.
  //  1) The systemd service user is created with `--shell /usr/sbin/nologin`, and
  //     systemd exports $SHELL=/usr/sbin/nologin into the unit. A shell wrapper
  //     would launch `/usr/sbin/nologin -lc ...`, which ignores its args, prints
  //     "This account is currently not available", and exits — so every session
  //     died on connect. (It worked in local dev only because your interactive
  //     $SHELL was a real shell.)
  //  2) No login shell also means no /etc/profile / MOTD leaking into the PTY.
  // Bun.spawn sets cwd + env itself, so the shell bought nothing here.
  return { command: cmd, args, cwd };
}

const server = new Server(
  {
    hostKeys: [loadOrGenerateHostKey()],
    banner: "tui-rezi over ssh\r\n",
  },
  (client, info) => {
    const cid = crypto.randomBytes(3).toString("hex");
    const ip = (info as { ip?: string } | undefined)?.ip ?? "unknown";

    const ipCount = perIp.get(ip) ?? 0;
    if (total >= MAX_TOTAL || ipCount >= MAX_PER_IP) {
      console.log(`[ssh:${cid}] reject ${ip} (ip=${ipCount} total=${total})`);
      try {
        client.end();
      } catch {}
      return;
    }
    perIp.set(ip, ipCount + 1);
    total++;

    let decremented = false;
    const decrement = () => {
      if (decremented) return;
      decremented = true;
      total--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };

    const handshakeTimer = setTimeout(() => {
      console.log(`[ssh:${cid}] handshake timeout from ${ip}`);
      try {
        client.end();
      } catch {}
    }, HANDSHAKE_TIMEOUT_MS);

    client.on("authentication", (ctx) => {
      if (ctx.method !== "none") return ctx.reject(["none"], false);
      ctx.accept();
    });

    client.on("ready", () => {
      clearTimeout(handshakeTimer);
      console.log(`[ssh:${cid}] ready ${ip}`);

      client.on("session", (acceptSession) => {
        const session = acceptSession();

        let term = DEFAULT_TERM;
        let cols = 80;
        let rows = 24;
        let proc: any;
        let dead = false;
        let idleTimer: NodeJS.Timeout | undefined;
        let currentStream: ServerChannel | undefined;

        const cleanup = () => {
          if (dead) return;
          dead = true;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
          if (proc) {
            try {
              proc.kill();
            } catch {}
            proc = undefined;
          }
        };

        const bumpIdle = () => {
          if (dead) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            console.log(`[ssh:${cid}] idle timeout`);
            const s = currentStream;
            cleanup();
            if (s) {
              try {
                s.exit(0);
                s.end();
              } catch {}
            }
          }, IDLE_TIMEOUT_MS);
        };

        session.on("pty", (accept, _reject, info) => {
          term = clampTerm((info as { term?: string }).term);
          cols = clampSize(info.cols, cols, 20, 500);
          rows = clampSize(info.rows, rows, 5, 200);
          accept && accept();
        });

        session.on("window-change", (accept, _reject, info) => {
          cols = clampSize(info.cols, cols, 20, 500);
          rows = clampSize(info.rows, rows, 5, 200);
          if (proc) {
            try {
              proc.resize({ cols, rows });
            } catch {}
          }
          bumpIdle();
          accept && accept();
        });

        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          currentStream = stream;

          const spec = buildCommandAndArgs(TUI_CMD, TUI_ARGS, TUI_DIR);
          console.log(
            `[ssh:${cid}] shell ${spec.command} ${spec.args.join(" ")} @ ${cols}x${rows}`,
          );

          stream.on("error", (err: Error) => {
            console.log(`[ssh:${cid}] stream error: ${err.message}`);
            cleanup();
          });

          stream.on("close", () => {
            console.log(`[ssh:${cid}] stream close`);
            cleanup();
          });

          proc = Bun.spawn([spec.command, ...spec.args], {
            cwd: spec.cwd,
            env: {
              ...process.env,
              TERM: term,
              COLORTERM: process.env.COLORTERM || "truecolor",
              FORCE_COLOR: "1",
              HOME: DEFAULT_HOME,
              PATH: DEFAULT_PATH,
              SSH_SESSION: cid,
            },
            pty: {
              cols,
              rows,
              name: term,
            },
            onExit() {
              console.log(`[ssh:${cid}] pty exit`);
              cleanup();
              try {
                stream.exit(0);
                stream.end();
              } catch {}
            },
          });

          // Pipe stdout -> SSH
          let buffered = 0;
          const pending: string[] = [];
          let draining = false;

          const flush = () => {
            while (pending.length) {
              const chunk = pending.shift()!;
              buffered -= Buffer.byteLength(chunk, "utf8");
              if (!safeWrite(stream, chunk)) {
                draining = true;
                stream.once("drain", () => {
                  draining = false;
                  flush();
                });
                return;
              }
            }
          };

          stream.on("drain", () => {
            draining = false;
            flush();
          });

          (async () => {
            for await (const chunk of proc.stdout) {
              if (dead) break;
              const d = chunk.toString();
              bumpIdle();
              if (!draining && pending.length === 0) {
                if (safeWrite(stream, d)) continue;
                draining = true;
                stream.once("drain", () => {
                  draining = false;
                  flush();
                });
              }
              const sz = Buffer.byteLength(d, "utf8");
              if (buffered + sz > MAX_BUFFER) {
                console.log(
                  `[ssh:${cid}] backpressure overflow (>${MAX_BUFFER}B), killing`,
                );
                cleanup();
                try {
                  stream.end();
                } catch {}
                break;
              }
              pending.push(d);
              buffered += sz;
            }
          })().catch((err) => {
            console.log(`[ssh:${cid}] stdout pump error: ${err?.message}`);
            cleanup();
          });

          // Pipe SSH -> stdin
          stream.on("data", (d: Buffer) => {
            if (dead) return;
            bumpIdle();
            const buf = Buffer.from(d);
            if (buf.includes(0x03)) {
              console.log(`[ssh:${cid}] ctrl+c disconnect`);
              cleanup();
              try {
                stream.exit(0);
                stream.end();
              } catch {}
              return;
            }
            try {
              proc.stdin.write(d);
            } catch {}
          });

          bumpIdle();
        });

        session.on("exec", (_acceptExec, rejectExec) => {
          rejectExec();
        });
      });
    });

    client.on("end", () => console.log(`[ssh:${cid}] end`));
    client.on("close", () => {
      clearTimeout(handshakeTimer);
      decrement();
      console.log(`[ssh:${cid}] close (total=${total})`);
    });
    client.on("error", (err) => console.log(`[ssh:${cid}] err ${err.message}`));
  },
);

server.listen(PORT, HOST, () => {
  console.log(`[ssh] listening ${HOST}:${PORT}`);
  console.log(`[ssh] TUI_DIR=${TUI_DIR}`);
  console.log(`[ssh] HOME=${DEFAULT_HOME}`);
  console.log(`[ssh] HOST_KEY=${HOST_KEY_PATH}`);
  console.log(`[ssh] try: ssh -p ${PORT} localhost`);
});

const shutdown = () => {
  console.log("[ssh] shutting down");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
