import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pty from "node-pty";
import { Server, type ServerChannel } from "ssh2";

const PORT = Number(process.env.PORT) || 2222;
const HOST = process.env.HOST || "0.0.0.0";
const TUI_DIR =
  process.env.TUI_DIR || path.resolve(__dirname, "..", "..", "tui-rezi");
const TUI_CMD = process.env.TUI_CMD || process.execPath;
const TUI_ARGS = (process.env.TUI_ARGS || "src/main/App.tsx").split(" ");
const HOST_KEY_PATH =
  process.env.SSH_HOST_KEY || path.resolve(__dirname, "..", "host.key");

const MAX_PER_IP = 3;
const MAX_TOTAL = 100;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 1 << 20; // 1 MiB

const perIp = new Map<string, number>();
let total = 0;

function loadOrGenerateHostKey(): Buffer {
  if (fs.existsSync(HOST_KEY_PATH)) {
    return fs.readFileSync(HOST_KEY_PATH);
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
  console.error(`[ssh] TUI_DIR does not exist: ${TUI_DIR}`);
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

// Bun's net.Socket({ fd }) doesn't work for ConPTY named pipe FDs on Windows.
// The socket is created in "pending" state and writes silently go nowhere.
// Workaround: write directly to the raw FD via fs.writeSync.
// Requires patched node_modules/node-pty/lib/windowsPtyAgent.js that stores
// the FD as this._inSocketFD (one-line addition).
function rawPtyWrite(proc: pty.IPty | undefined, data: string): void {
  if (!proc) return;
  const fd = (proc as any)._agent?._inSocketFD;
  if (fd != null && fd >= 0) {
    try {
      fs.writeSync(fd, data);
    } catch {}
  }
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
      try { client.end(); } catch {}
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
      try { client.end(); } catch {}
    }, HANDSHAKE_TIMEOUT_MS);

    client.on("authentication", (ctx) => {
      if (ctx.method !== "none") {
        return ctx.reject(["none"], false);
      }
      ctx.accept();
    });

    client.on("ready", () => {
      clearTimeout(handshakeTimer);
      console.log(`[ssh:${cid}] ready ${ip}`);

      client.on("session", (acceptSession) => {
        const session = acceptSession();

        let term = "xterm-256color";
        let cols = 80;
        let rows = 24;
        let proc: pty.IPty | undefined;
        let dead = false;
        let idleTimer: NodeJS.Timeout | undefined;
        let currentStream: ServerChannel | undefined;

        const cleanup = () => {
          if (dead) return;
          dead = true;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
          if (proc) {
            try { proc.kill(); } catch {}
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
              try { s.exit(0); s.end(); } catch {}
            }
          }, IDLE_TIMEOUT_MS);
        };

        session.on("pty", (accept, _reject, info) => {
          term = (info as { term?: string }).term || term;
          cols = info.cols || cols;
          rows = info.rows || rows;
          accept && accept();
        });

        session.on("window-change", (accept, _reject, info) => {
          cols = info.cols;
          rows = info.rows;
          if (proc && !dead) {
            try { proc.resize(cols, rows); } catch {}
          }
          bumpIdle();
          accept && accept();
        });

        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          currentStream = stream;
          console.log(
            `[ssh:${cid}] shell ${TUI_CMD} ${TUI_ARGS.join(" ")} @ ${cols}x${rows}`,
          );

          stream.on("error", (err: Error) => {
            console.log(`[ssh:${cid}] stream error: ${err.message}`);
            cleanup();
          });

          stream.on("close", () => {
            console.log(`[ssh:${cid}] stream close`);
            cleanup();
          });

          proc = pty.spawn(TUI_CMD, TUI_ARGS, {
            name: term,
            cols,
            rows,
            cwd: TUI_DIR,
            env: {
              ...process.env,
              TERM: term,
              FORCE_COLOR: "1",
              SSH_SESSION: cid,
            } as { [k: string]: string },
          });

          const agent = (proc as any)._agent;
          if (agent?.inSocket) {
            agent.inSocket.on("error", () => {});
          }
          if (agent?.outSocket) {
            agent.outSocket.on("error", () => {});
          }
          (proc as any).on?.("error", () => {});

          let buffered = 0;
          const pending: string[] = [];
          let draining = false;

          const flush = () => {
            while (pending.length) {
              const chunk = pending.shift()!;
              buffered -= Buffer.byteLength(chunk, "utf8");
              if (!safeWrite(stream, chunk)) {
                draining = true;
                stream.once("drain", () => { draining = false; flush(); });
                return;
              }
            }
          };

          stream.on("drain", () => { draining = false; flush(); });

          proc.onData((d) => {
            if (dead) return;
            bumpIdle();
            if (!draining && pending.length === 0) {
              if (safeWrite(stream, d)) return;
              draining = true;
              stream.once("drain", () => { draining = false; flush(); });
            }
            const sz = Buffer.byteLength(d, "utf8");
            if (buffered + sz > MAX_BUFFER) {
              console.log(`[ssh:${cid}] backpressure overflow (>${MAX_BUFFER}B), killing`);
              cleanup();
              try { stream.end(); } catch {}
              return;
            }
            pending.push(d);
            buffered += sz;
          });

          stream.on("data", (d: Buffer) => {
            if (dead) return;
            bumpIdle();
            const buf = Buffer.from(d);
            // Ctrl+C (0x03) disconnects the session
            if (buf.includes(0x03)) {
              console.log(`[ssh:${cid}] ctrl+c disconnect`);
              cleanup();
              try {
                stream.exit(0);
                stream.end();
              } catch {}
              return;
            }
            rawPtyWrite(proc, d.toString("utf8"));
          });

          bumpIdle();

          proc.onExit(({ exitCode }) => {
            console.log(`[ssh:${cid}] pty exit ${exitCode}`);
            cleanup();
            try {
              stream.exit(exitCode);
              stream.end();
            } catch {}
          });
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
  console.log(`[ssh] try: ssh -p ${PORT} localhost`);
});

const shutdown = () => {
  console.log("[ssh] shutting down");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
