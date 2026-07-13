/**
 * Adversarial containment probe (Task 2.3 `sandbox.containment.test`). Runs INSIDE
 * the jail via `spawnSandboxed` and attempts one breach named by `action`, reporting
 * the outcome as JSON on fd 3 (the control pipe). A well-contained host reports every
 * attempt `blocked:*`; a `LEAK` means the jail failed.
 *
 * Plain CommonJS (`.cjs`) so `node` runs it directly with no TS loader inside the
 * sandbox (the jail's read-allowlist is intentionally minimal). Its config
 * (`action` + params) is the JSON CONTENT of the read-only INPUT handle
 * (`req.inputPath`) — the one path guaranteed readable inside the jail on BOTH hosts
 * (on Linux the worker-private temp is a fresh tmpfs the host cannot pre-seed, so the
 * input handle, not the temp, carries the config).
 */
"use strict";
const fs = require("node:fs");

const CONTROL_FD = 3;

function report(obj) {
  fs.writeSync(CONTROL_FD, JSON.stringify(obj));
}

async function tryNetwork() {
  const net = require("node:net");
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let s;
    try {
      s = net.connect({ host: "93.184.216.34", port: 443 });
    } catch (e) {
      finish("blocked:" + (e.code || e.message));
      return;
    }
    s.setTimeout(2500);
    s.on("connect", () => {
      try {
        s.destroy();
      } catch {}
      finish("LEAK-connected");
    });
    s.on("timeout", () => {
      try {
        s.destroy();
      } catch {}
      finish("blocked:timeout");
    });
    s.on("error", (e) => finish("blocked:" + e.code));
  });
}

(async () => {
  let req;
  let cfg;
  try {
    req = JSON.parse(process.argv[2]);
    cfg = JSON.parse(fs.readFileSync(req.inputPath, "utf8"));
  } catch (e) {
    report({ action: "?", error: "probe bootstrap failed: " + (e && e.message) });
    return;
  }

  const out = { action: cfg.action };
  try {
    switch (cfg.action) {
      case "network":
        out.result = await tryNetwork();
        break;
      case "env":
        // The launcher spawns with an empty env; only OS-injected vars may remain.
        out.env = Object.keys(process.env);
        break;
      case "read-oos":
        try {
          fs.readFileSync(cfg.target, "utf8");
          out.result = "LEAK-read";
        } catch (e) {
          out.result = "blocked:" + e.code;
        }
        break;
      case "read-keychain":
        try {
          fs.readFileSync(cfg.target, "utf8");
          out.result = "LEAK-read";
        } catch (e) {
          out.result = "blocked:" + e.code;
        }
        break;
      case "read-input":
        // Positive control: the ONE allowed input handle must be readable.
        try {
          out.bytes = fs.readFileSync(req.inputPath).length;
          out.result = "read";
        } catch (e) {
          out.result = "blocked:" + e.code;
        }
        break;
      case "inherited-fd": {
        // No parent fd beyond stdio+control+seccomp is inherited; reading one → EBADF.
        const buf = Buffer.alloc(32);
        const results = [];
        for (const fd of cfg.fds || [4, 5, 6]) {
          try {
            fs.readSync(fd, buf, 0, 32, 0);
            results.push(fd + ":LEAK-read");
          } catch (e) {
            results.push(fd + ":blocked:" + e.code);
          }
        }
        out.result = results;
        break;
      }
      case "subprocess": {
        // Try to spawn BOTH an arbitrary binary (/bin/echo) AND node ITSELF
        // (process.execPath) — the latter is the real adversary move (the profile
        // permits exec of the node literal for the bootstrap, so no-subprocess must
        // rest on the fork/process-creation denial, not on the exec allowlist).
        const cp = require("node:child_process");
        const targets = [
          ["echo", "/bin/echo", ["breach"]],
          ["node", process.execPath, ["-e", "0"]],
        ];
        const results = [];
        for (const [label, bin, argv] of targets) {
          try {
            cp.execFileSync(bin, argv, { stdio: "ignore" });
            results.push(label + ":LEAK-spawned");
          } catch (e) {
            results.push(label + ":blocked:" + (e.code || e.errno || e.message));
          }
        }
        out.results = results;
        // Aggregate: blocked only if NEITHER spawn succeeded.
        out.result = results.some((r) => r.includes("LEAK")) ? "LEAK-spawned" : "blocked:all";
        break;
      }
      case "fsize":
        // RLIMIT_FSIZE: writing past the file-size cap to the worker temp must fail
        // (EFBIG / SIGXFSZ surfaced as an error), never silently succeed.
        try {
          fs.writeFileSync(req.workTmp + "/big", Buffer.alloc(cfg.bytes || 4 * 1024 * 1024, 65));
          out.result = "LEAK-wrote:" + fs.statSync(req.workTmp + "/big").size;
        } catch (e) {
          out.result = "blocked:" + (e.code || e.message);
        }
        break;
      case "fd": {
        // RLIMIT_NOFILE: opening past the fd cap must fail with EMFILE.
        const held = [];
        let n = 0;
        try {
          for (; n < (cfg.count || 5000); n++) held.push(fs.openSync(req.inputPath, "r"));
          out.result = "LEAK-opened:" + n;
        } catch (e) {
          out.result = "blocked:" + (e.code || e.message) + ":at:" + n;
        }
        break;
      }
      case "write-oos":
        try {
          fs.writeFileSync(cfg.target + "/atlas-breach", "x");
          out.result = "LEAK-wrote";
        } catch (e) {
          out.result = "blocked:" + e.code;
        }
        break;
      case "write-tmp":
        // Positive control: the worker-private temp must be writable.
        try {
          fs.writeFileSync(req.workTmp + "/scratch", "ok");
          out.result = "wrote";
        } catch (e) {
          out.result = "blocked:" + e.code;
        }
        break;
      case "forbidden-syscall": {
        // Linux seccomp: creating an INET socket invokes the denied `socket` syscall,
        // which returns EPERM. Node surfaces that failure ASYNCHRONOUSLY as an 'error'
        // event (the handle is created lazily), so we must AWAIT the outcome rather
        // than reporting synchronously — a synchronous "attempted" would race ahead of
        // the seccomp EPERM and read as a leak. A successful connect is a real leak.
        // (On macOS this is the Seatbelt network denial; the test gates the seccomp
        // assertion to Linux.)
        const net = require("node:net");
        out.result = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => {
            if (done) return;
            done = true;
            resolve(v);
          };
          let s;
          try {
            s = net.connect({ host: "127.0.0.1", port: 9 });
          } catch (e) {
            finish("blocked:" + (e.code || e.message));
            return;
          }
          s.setTimeout(2500);
          s.on("connect", () => {
            try {
              s.destroy();
            } catch {}
            finish("LEAK-connected");
          });
          s.on("timeout", () => {
            try {
              s.destroy();
            } catch {}
            finish("blocked:timeout");
          });
          s.on("error", (e) => finish("blocked:" + (e.code || e.message)));
        });
        break;
      }
      default:
        out.result = "unknown-action";
    }
  } catch (e) {
    out.result = "threw:" + (e && e.message);
  }
  report(out);
})();
