/**
 * Linux backend (`sandbox-contract.md §1`, linux column): userns + mountns + netns +
 * seccomp-bpf + rlimits. NB: these paths are exercised by CI's `ubuntu-latest` runner;
 * they are NOT runtime-reachable on a macOS dev host (the containment test's
 * Linux-specific cases skip when `process.platform !== "linux"`).
 *
 * Confinement is composed from stock tools so no native addon is needed:
 *
 *   - **isolated-fs + no-credentials** — `bwrap` builds a fresh mount namespace with a
 *     MINIMAL read-only bind set (wing round-2 finding: the old `--ro-bind / /` exposed
 *     the entire host, incl. same-UID Atlas keys). We bind only the runtime closure the
 *     Node process needs (`/usr`, `/lib*`, `/bin`, ld.so cache, the node binary + its
 *     install tree, the compiled `codeRoots`), the ONE input at a fixed path, and a
 *     private `tmpfs`. `/home`, `/etc/atlas`, the vault, and every other path are simply
 *     NOT mounted, so they are absent from the child's view.
 *   - **no-network** — `bwrap --unshare-net` gives an empty network namespace, and the
 *     seccomp allowlist omits `socket`/`connect`/… (→ EPERM) as the syscall belt.
 *   - **empty-environment** — `bwrap --clearenv` (plus the launcher spawns with `{}`).
 *   - **no-subprocess** — the seccomp allowlist DENIES process creation (`fork`, `vfork`,
 *     `execveat`, and `clone` unless `CLONE_THREAD` is set; `clone3` → ENOSYS so glibc
 *     falls back to the flag-checked `clone`). `execve` itself is ALLOWED because the
 *     bwrap→node bootstrap is a single `execve` under the installed filter and classic
 *     BPF cannot count execs — but with process creation denied, no NEW process can ever
 *     be created to exec into, so allowing `execve` cannot yield a subprocess (a direct
 *     re-exec only replaces the confined worker, still under the same filter + namespaces).
 *   - **syscall-restriction** — a per-arch seccomp-bpf ALLOWLIST with default action
 *     `EPERM` (wing round-2 finding: the old filter was a short denylist with default
 *     ALLOW). Only the parse-necessary syscalls are permitted; everything else — incl.
 *     `ptrace`, `mount`, `bpf`, `keyctl`, `socket`, `process_vm_*` — returns EPERM.
 *   - **resource-caps** — `prlimit` sets RLIMIT_CPU / RLIMIT_AS / RLIMIT_FSIZE /
 *     RLIMIT_NOFILE / RLIMIT_NPROC on the child, AND (wing round-3 finding 1, per the
 *     contract's linux row) a per-worker cgroup v2 the worker CANNOT leave caps
 *     memory / pids / cpu authoritatively. The worker is moved into a fresh leaf cgroup
 *     BEFORE exec (`echo $$ > <leaf>/cgroup.procs`); membership is inherited by every
 *     descendant, and the leaf is removed after the worker exits. It is non-escapable
 *     because `bwrap`'s mount namespace never binds `cgroupfs`, so the worker cannot see
 *     or write `cgroup.procs`. The launcher watchdog + output ceiling bound wall-clock +
 *     output. If cgroup v2 is unusable the probe reports resource-caps unavailable ⇒
 *     `runInSandbox` fails closed (never a weaker jail).
 *
 * FAIL CLOSED: if `bwrap`/`prlimit` are absent (so seccomp + mountns + rlimits are
 * unavailable) the probe marks the affected guarantees unavailable ⇒ `supported: false`
 * ⇒ `runInSandbox` refuses to launch. We never silently downgrade to a weaker jail.
 */
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SandboxCapabilityCheck, SandboxLimits } from "../types.js";
import type { ExtraChildFd, SandboxBackend, SandboxSpawnInputs, SandboxSpawnPlan } from "./backend.js";
import { detectHost } from "./backend.js";

/** Candidate absolute locations for the confinement tools (PATH is not trusted). */
const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];
const PRLIMIT_CANDIDATES = ["/usr/bin/prlimit", "/bin/prlimit"];
/** POSIX shell — the one-line shim that moves the process into its cgroup before exec. */
const SH_CANDIDATES = ["/bin/sh", "/usr/bin/sh"];

/** First existing path from `candidates`, or `null`. */
function firstExisting(candidates: readonly string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Fixed in-sandbox mount point for the read-only input handle. */
const IN_SANDBOX_INPUT = "/atlas/input";
/** Fixed in-sandbox writable temp (a private tmpfs). */
const IN_SANDBOX_TMP = "/atlas/tmp";
/** The child fd bwrap reads the seccomp blob from. */
const SECCOMP_FD = 10;

/** `clone(2)` flag that marks a THREAD (vs a new process). Threads are allowed. */
const CLONE_THREAD = 0x00010000;

/**
 * Per-arch seccomp table. `auditArch` guards against nr aliasing on a mismatched
 * personality. `execve` is allowed (bootstrap); `execveat`/`fork`/`vfork` are denied by
 * OMISSION (default EPERM); `clone` is flag-checked (allow only `CLONE_THREAD`); `clone3`
 * is forced to ENOSYS so glibc/libuv fall back to the flag-checked `clone`. `allow` is the
 * generous parse-necessary syscall set — everything a modern Node/glibc/libuv/V8 needs to
 * boot and parse a file, MINUS the dangerous families (socket*, ptrace, mount*, bpf,
 * keyctl, process_vm_*, module/kexec/reboot, clock_settime, …) which are left out ⇒ EPERM.
 *
 * Numbers are the stable Linux syscall-table entries (x86_64 `unistd_64.h`; aarch64
 * asm-generic `unistd.h`). An unknown arch yields `undefined` ⇒ no program ⇒ fail closed.
 */
interface ArchTable {
  readonly auditArch: number;
  readonly nrClone: number;
  readonly nrClone3: number;
  readonly allow: readonly number[];
}

/**
 * x86_64 (`unistd_64.h`). `execve`(59) is ALLOWED (bootstrap). Deliberately EXCLUDED
 * (⇒ default EPERM): socket(41)/connect(42)/accept(43)/…/accept4(288)/socketpair(53)
 * (net belt), fork(57), vfork(58), execveat(322), ptrace(101), mount(165)/umount2(166)/
 * pivot_root(155)/chroot(161), unshare(272→NO, 272 is not unshare on x64; unshare=272?
 * — unshare is 272 on x86_64: EXCLUDED), setns(308), keyctl(250)/add_key(248)/
 * request_key(249), bpf(321), perf_event_open(298), process_vm_readv(310)/writev(311),
 * kexec_load(246), init_module(175→NO)/finit_module(313)/delete_module(176→NO), reboot(169),
 * clock_settime(227)/settimeofday(164)/adjtimex(159). None of those numbers appear below.
 */
const X64: ArchTable = {
  auditArch: 0xc000003e, // AUDIT_ARCH_X86_64
  nrClone: 56,
  nrClone3: 435,
  allow: [
    0 /*read*/, 1 /*write*/, 2 /*open*/, 3 /*close*/, 4 /*stat*/, 5 /*fstat*/, 6 /*lstat*/, 7 /*poll*/,
    8 /*lseek*/, 9 /*mmap*/, 10 /*mprotect*/, 11 /*munmap*/, 12 /*brk*/, 13 /*rt_sigaction*/, 14 /*rt_sigprocmask*/,
    15 /*rt_sigreturn*/, 16 /*ioctl*/, 17 /*pread64*/, 18 /*pwrite64*/, 19 /*readv*/, 20 /*writev*/, 21 /*access*/,
    22 /*pipe*/, 23 /*select*/, 24 /*sched_yield*/, 25 /*mremap*/, 26 /*msync*/, 27 /*mincore*/, 28 /*madvise*/,
    32 /*dup*/, 33 /*dup2*/, 35 /*nanosleep*/, 39 /*getpid*/, 40 /*sendfile*/, 59 /*execve*/, 60 /*exit*/,
    61 /*wait4*/, 63 /*uname*/, 72 /*fcntl*/, 73 /*flock*/, 74 /*fsync*/, 75 /*fdatasync*/, 76 /*truncate*/,
    77 /*ftruncate*/, 78 /*getdents*/, 79 /*getcwd*/, 80 /*chdir*/, 81 /*fchdir*/, 82 /*rename*/, 83 /*mkdir*/,
    84 /*rmdir*/, 85 /*creat*/, 86 /*link*/, 87 /*unlink*/, 88 /*symlink*/, 89 /*readlink*/, 90 /*chmod*/,
    91 /*fchmod*/, 92 /*chown*/, 95 /*umask*/, 96 /*gettimeofday*/, 97 /*getrlimit*/, 98 /*getrusage*/,
    99 /*sysinfo*/, 100 /*times*/, 102 /*getuid*/, 104 /*getgid*/, 107 /*geteuid*/, 108 /*getegid*/,
    110 /*getppid*/, 111 /*getpgrp*/, 115 /*getgroups*/, 127 /*rt_sigpending*/, 128 /*rt_sigtimedwait*/,
    131 /*sigaltstack*/, 137 /*statfs*/, 138 /*fstatfs*/, 157 /*prctl*/, 158 /*arch_prctl*/, 160 /*setrlimit*/,
    186 /*gettid*/, 202 /*futex*/, 204 /*sched_getaffinity*/, 213 /*epoll_create*/, 217 /*getdents64*/,
    218 /*set_tid_address*/, 219 /*restart_syscall*/, 324 /*membarrier*/,
    228 /*clock_gettime*/, 229 /*clock_getres*/, 230 /*clock_nanosleep*/, 231 /*exit_group*/, 232 /*epoll_wait*/,
    233 /*epoll_ctl*/, 234 /*tgkill*/, 257 /*openat*/, 258 /*mkdirat*/, 260 /*fchownat*/, 262 /*newfstatat*/,
    263 /*unlinkat*/, 264 /*renameat*/, 265 /*linkat*/, 266 /*symlinkat*/, 267 /*readlinkat*/, 268 /*fchmodat*/,
    269 /*faccessat*/, 270 /*pselect6*/, 271 /*ppoll*/, 273 /*set_robust_list*/, 274 /*get_robust_list*/,
    280 /*utimensat*/, 281 /*epoll_pwait*/, 284 /*eventfd*/, 285 /*fallocate*/, 290 /*eventfd2*/,
    291 /*epoll_create1*/, 292 /*dup3*/, 293 /*pipe2*/, 302 /*prlimit64*/, 316 /*renameat2*/, 318 /*getrandom*/,
    319 /*memfd_create*/, 332 /*statx*/, 334 /*rseq*/, 436 /*close_range*/, 439 /*faccessat2*/, 441 /*epoll_pwait2*/,
  ],
};

/**
 * aarch64 (asm-generic `unistd.h`). `execve`(221) is ALLOWED (bootstrap). Deliberately
 * EXCLUDED (⇒ default EPERM): socket(198)/connect(203)/…, execveat(281), ptrace(117),
 * mount(40)/umount2(39)/pivot_root(41)/chroot(51), unshare(97), setns(268), keyctl(219)/
 * add_key(217)/request_key(218), bpf(280), process_vm_readv(270)/writev(271),
 * kexec_load(104)/kexec_file_load(294), init_module(105)/delete_module(106)/finit_module(273),
 * reboot(142), settimeofday(170)/adjtimex(171), mknodat(33), quotactl(60), acct(89). None
 * of those numbers appear below.
 */
const ARM64: ArchTable = {
  auditArch: 0xc00000b7, // AUDIT_ARCH_AARCH64
  nrClone: 220,
  nrClone3: 435,
  allow: [
    17 /*getcwd*/, 19 /*eventfd2*/, 20 /*epoll_create1*/, 21 /*epoll_ctl*/, 22 /*epoll_pwait*/, 23 /*dup*/,
    24 /*dup3*/, 25 /*fcntl*/, 29 /*ioctl*/, 32 /*flock*/, 34 /*mkdirat*/, 35 /*unlinkat*/, 36 /*symlinkat*/,
    37 /*linkat*/, 38 /*renameat*/, 43 /*statfs*/, 44 /*fstatfs*/, 45 /*truncate*/, 46 /*ftruncate*/,
    47 /*fallocate*/, 48 /*faccessat*/, 49 /*chdir*/, 50 /*fchdir*/, 52 /*fchmod*/, 53 /*fchmodat*/,
    54 /*fchownat*/, 55 /*fchown*/, 56 /*openat*/, 57 /*close*/, 59 /*pipe2*/, 61 /*getdents64*/, 62 /*lseek*/,
    63 /*read*/, 64 /*write*/, 65 /*readv*/, 66 /*writev*/, 67 /*pread64*/, 68 /*pwrite64*/, 69 /*preadv*/,
    70 /*pwritev*/, 71 /*sendfile*/, 72 /*pselect6*/, 73 /*ppoll*/, 74 /*signalfd4*/, 78 /*readlinkat*/,
    79 /*newfstatat*/, 80 /*fstat*/, 81 /*sync*/, 82 /*fsync*/, 83 /*fdatasync*/, 84 /*sync_file_range*/,
    85 /*timerfd_create*/, 86 /*timerfd_settime*/, 87 /*timerfd_gettime*/, 88 /*utimensat*/, 92 /*personality*/,
    93 /*exit*/, 94 /*exit_group*/, 95 /*waitid*/, 96 /*set_tid_address*/, 98 /*futex*/, 99 /*set_robust_list*/,
    100 /*get_robust_list*/, 101 /*nanosleep*/, 113 /*clock_gettime*/, 114 /*clock_getres*/,
    115 /*clock_nanosleep*/, 122 /*sched_setaffinity*/, 123 /*sched_getaffinity*/, 124 /*sched_yield*/,
    128 /*restart_syscall*/, 129 /*kill*/, 130 /*tkill*/, 131 /*tgkill*/, 132 /*sigaltstack*/, 134 /*rt_sigaction*/,
    135 /*rt_sigprocmask*/, 136 /*rt_sigpending*/, 139 /*rt_sigreturn*/, 153 /*times*/, 154 /*setpgid*/,
    155 /*getpgid*/, 156 /*getsid*/, 158 /*getgroups*/, 160 /*uname*/, 163 /*getrlimit*/, 164 /*setrlimit*/,
    165 /*getrusage*/, 166 /*umask*/, 167 /*prctl*/, 168 /*getcpu*/, 169 /*gettimeofday*/, 172 /*getpid*/,
    173 /*getppid*/, 174 /*getuid*/, 175 /*geteuid*/, 176 /*getgid*/, 177 /*getegid*/, 178 /*gettid*/,
    179 /*sysinfo*/, 214 /*brk*/, 215 /*munmap*/, 216 /*mremap*/, 221 /*execve*/, 222 /*mmap*/, 223 /*fadvise64*/,
    226 /*mprotect*/, 227 /*msync*/, 232 /*mincore*/, 233 /*madvise*/, 260 /*wait4*/, 261 /*prlimit64*/,
    267 /*syncfs*/, 278 /*getrandom*/, 279 /*memfd_create*/, 283 /*membarrier*/, 285 /*copy_file_range*/,
    286 /*preadv2*/, 287 /*pwritev2*/, 291 /*statx*/, 293 /*rseq*/, 436 /*close_range*/, 439 /*faccessat2*/,
    441 /*epoll_pwait2*/,
  ],
};

/** The arch tokens with a seccomp table, and their `AUDIT_ARCH_*` values (test-visible). */
export const AUDIT_ARCH: Record<"x64" | "arm64", number> = { x64: X64.auditArch, arm64: ARM64.auditArch };

/**
 * Build the classic-BPF seccomp program (an array of `struct sock_filter{u16 code; u8
 * jt; u8 jf; u32 k}`, 8 bytes each) that `bwrap --seccomp` reads verbatim. Default action
 * is `EPERM` (allowlist); the allowed syscalls (+ the flag-checked `clone`) return ALLOW;
 * `clone3` returns ENOSYS. `execve` is ALLOWED on BOTH arches (the bwrap→node bootstrap
 * is a single `execve` issued UNDER the freshly-installed filter — classic BPF is
 * stateless and cannot count execs or dereference the path pointer, so the bootstrap exec
 * cannot be told apart from a later one). `execveat` and ALL process-creation
 * (fork/vfork/clone-new-proc/clone3) are DENIED, so a direct re-exec can only REPLACE the
 * already-confined worker in place — it can never spawn a NEW process, and the replacement
 * keeps the identical seccomp filter + namespaces (finding 2: re-exec stays contained).
 *
 * `targetArch` defaults to the host arch; passing it explicitly lets the ARM64 program be
 * asserted on an x64/darwin CI host and vice-versa. Returns `null` for an unrecognized
 * arch (⇒ fail closed).
 */
export function buildSeccompProgram(targetArch: "x64" | "arm64" = arch() as "x64" | "arm64"): Buffer | null {
  const table = targetArch === "x64" ? X64 : targetArch === "arm64" ? ARM64 : undefined;
  if (table === undefined) return null;
  const allow = [...new Set<number>(table.allow)].sort((a, b) => a - b);

  const BPF_LD = 0x00,
    BPF_W = 0x00,
    BPF_ABS = 0x20,
    BPF_JMP = 0x05,
    BPF_JEQ = 0x10,
    BPF_JSET = 0x40,
    BPF_K = 0x00,
    BPF_RET = 0x06;
  const OFF_NR = 0;
  const OFF_ARCH = 4;
  const OFF_ARG0_LO = 16; // seccomp_data.args[0], low 32 bits
  const RET_ALLOW = 0x7fff0000; // SECCOMP_RET_ALLOW
  const RET_KILL = 0x00000000; // SECCOMP_RET_KILL_THREAD
  const RET_EPERM = 0x00050000 | 1; // SECCOMP_RET_ERRNO | EPERM
  const RET_ENOSYS = 0x00050000 | 38; // SECCOMP_RET_ERRNO | ENOSYS

  type Insn = { code: number; jt: number; jf: number; k: number };
  const prog: Insn[] = [];
  const ins = (code: number, jt: number, jf: number, k: number): void => {
    prog.push({ code, jt, jf, k });
  };

  // 1) verify arch.
  ins(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFF_ARCH);
  ins(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, table.auditArch); // match → skip the kill
  ins(BPF_RET | BPF_K, 0, 0, RET_KILL);
  // 2) load syscall nr.
  ins(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFF_NR);
  // 3) clone3 → ENOSYS (force glibc/libuv fallback to the flag-checked clone).
  ins(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, table.nrClone3); // eq → next; ne → skip
  ins(BPF_RET | BPF_K, 0, 0, RET_ENOSYS);
  // 4) clone → allow only when CLONE_THREAD is set (a thread), else EPERM (a new proc).
  //    (nr is still in A here.) If nr==clone, load args[0] lo, test CLONE_THREAD.
  ins(BPF_JMP | BPF_JEQ | BPF_K, 0, 4, table.nrClone); // ne → skip the 4 clone insns
  ins(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFF_ARG0_LO); // A = flags lo
  ins(BPF_JMP | BPF_JSET | BPF_K, 1, 0, CLONE_THREAD); // (A & CLONE_THREAD) → skip EPERM
  ins(BPF_RET | BPF_K, 0, 0, RET_EPERM); // no CLONE_THREAD ⇒ deny (a fork-like clone)
  ins(BPF_RET | BPF_K, 0, 0, RET_ALLOW); // CLONE_THREAD ⇒ a thread, allow
  // 5) reload nr (A was clobbered by the arg load only on the clone path; reload to be safe).
  ins(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFF_NR);
  // 6) allowlist: each allowed nr → ALLOW.
  for (const nr of allow) {
    ins(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr); // eq → next (the ALLOW ret); ne → skip it
    ins(BPF_RET | BPF_K, 0, 0, RET_ALLOW);
  }
  // 7) default: EPERM (the allowlist default action).
  ins(BPF_RET | BPF_K, 0, 0, RET_EPERM);

  const buf = Buffer.alloc(prog.length * 8);
  prog.forEach((i, idx) => {
    buf.writeUInt16LE(i.code & 0xffff, idx * 8);
    buf.writeUInt8(i.jt & 0xff, idx * 8 + 2);
    buf.writeUInt8(i.jf & 0xff, idx * 8 + 3);
    buf.writeUInt32LE(i.k >>> 0, idx * 8 + 4);
  });
  return buf;
}

/** The action a seccomp program resolves to for one syscall (the subset our filter emits). */
export type SeccompAction = "allow" | "eperm" | "enosys" | "kill";

/**
 * A minimal classic-BPF interpreter over the exact instruction subset
 * {@link buildSeccompProgram} emits (LD|W|ABS, JEQ|K, JSET|K, RET|K) — enough to ASSERT,
 * on ANY host, what the kernel would do for a given `(arch, nr, arg0)` without executing
 * a syscall (wing round-3 finding 2: an ARM64 BPF assertion + a positive control). The
 * `seccomp_data` layout mirrors the kernel: `nr`@0, `arch`@4, `args[0]` low 32 bits @16
 * (the offsets the builder loads). Throws on an instruction outside the emitted subset.
 */
export function evalSeccomp(program: Buffer, ctx: { arch: number; nr: number; arg0?: number }): SeccompAction {
  const load = (off: number): number => {
    if (off === 0) return ctx.nr >>> 0;
    if (off === 4) return ctx.arch >>> 0;
    if (off === 16) return (ctx.arg0 ?? 0) >>> 0;
    return 0;
  };
  const RET_ALLOW = 0x7fff0000;
  const RET_EPERM = 0x00050000 | 1;
  const RET_ENOSYS = 0x00050000 | 38;
  const decode = (k: number): SeccompAction => {
    if (k === RET_ALLOW) return "allow";
    if (k === RET_ENOSYS) return "enosys";
    if (k === RET_EPERM) return "eperm";
    return "kill"; // RET_KILL_THREAD (0) or anything else
  };
  const n = Math.floor(program.length / 8);
  let a = 0;
  let pc = 0;
  for (let steps = 0; steps < 100000 && pc < n; steps++) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === (0x00 | 0x00 | 0x20)) {
      // BPF_LD | BPF_W | BPF_ABS
      a = load(k);
      pc += 1;
    } else if (code === (0x05 | 0x10 | 0x00)) {
      // BPF_JMP | BPF_JEQ | BPF_K
      pc += 1 + (a === k >>> 0 ? jt : jf);
    } else if (code === (0x05 | 0x40 | 0x00)) {
      // BPF_JMP | BPF_JSET | BPF_K
      pc += 1 + ((a & k) !== 0 ? jt : jf);
    } else if (code === (0x06 | 0x00)) {
      // BPF_RET | BPF_K
      return decode(k >>> 0);
    } else {
      throw new Error(`evalSeccomp: unsupported BPF opcode 0x${code.toString(16)} at insn ${pc}`);
    }
  }
  throw new Error("evalSeccomp: program did not return (ran off the end)");
}

/**
 * Is UNPRIVILEGED userns actually usable (bwrap needs it)? Two kernel gates can disable
 * it; we detect BOTH so the probe fails loud at startup rather than bwrap failing
 * opaquely mid-parse (the contract's "capability-probe at startup, doctor fails loud"):
 *   - Debian's `unprivileged_userns_clone` toggle (0 = disabled), and
 *   - Ubuntu 24.04+'s AppArmor gate `apparmor_restrict_unprivileged_userns` (1 =
 *     restricted; provisioning relaxes this sysctl on a CI/dev host).
 */
function usernsAvailable(): boolean {
  try {
    if (!existsSync("/proc/self/ns/user")) return false;
    const debianToggle = "/proc/sys/kernel/unprivileged_userns_clone";
    if (existsSync(debianToggle) && !readFileSync(debianToggle, "utf8").trim().startsWith("1")) {
      return false;
    }
    const apparmorGate = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
    if (existsSync(apparmorGate) && readFileSync(apparmorGate, "utf8").trim().startsWith("1")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * ───────────────────────── cgroup v2 (resource-caps, finding 1) ─────────────────────
 * `sandbox-contract.md §1 resource-caps` (linux) requires rlimits PLUS a per-worker
 * cgroup the worker cannot leave, capping memory / PIDs / CPU. rlimits alone are
 * per-process soft belts (RLIMIT_AS can be side-stepped by mmap accounting quirks,
 * RLIMIT_NPROC is per-uid not per-workload); a cgroup is the authoritative, hierarchical,
 * non-escapable cap. We create a FRESH leaf cgroup per launch, set its controller limits,
 * move the launched process tree into it BEFORE `exec` (so every descendant inherits it),
 * and REMOVE the leaf after the worker exits. It is non-escapable because `bwrap`'s fresh
 * mount namespace never binds `cgroupfs`, so the confined worker cannot even see — let
 * alone write — `cgroup.procs` to migrate out.
 */
const CGROUP_CONTROLLERS = ["memory", "pids", "cpu"] as const;

/** Read a cgroup controller list file (`cgroup.controllers` / `.subtree_control`). */
function readCgroupList(file: string): string[] {
  try {
    return readFileSync(file, "utf8").trim().split(/\s+/).filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Is `dir` writable by this process? */
function isWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `base` delegates memory/pids/cpu to its children via `cgroup.subtree_control`
 * (so a child leaf may set `memory.max`/`pids.max`/`cpu.max`). Returns false when the
 * controllers are not available on `base` or cannot be enabled (⇒ cgroup unusable).
 */
function enableCgroupControllers(base: string): boolean {
  const have = readCgroupList(join(base, "cgroup.controllers"));
  if (!CGROUP_CONTROLLERS.every((c) => have.includes(c))) return false;
  const sub = readCgroupList(join(base, "cgroup.subtree_control"));
  const missing = CGROUP_CONTROLLERS.filter((c) => !sub.includes(c));
  if (missing.length === 0) return true;
  try {
    writeFileSync(join(base, "cgroup.subtree_control"), missing.map((c) => `+${c}`).join(" "));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only availability check for the probe (`sandbox-contract.md §2`) — NO writes. The
 * cgroup v2 base is `ATLAS_SANDBOX_CGROUP_ROOT` (a provisioning-delegated subtree) else
 * the unified root `/sys/fs/cgroup` (exempt from the "no internal processes" rule).
 * Reports available only when v2 is mounted, memory/pids/cpu are present, and the base is
 * writable — otherwise resource-caps fails closed (contract-correct).
 */
function cgroupV2Available(): boolean {
  const base = process.env.ATLAS_SANDBOX_CGROUP_ROOT ?? "/sys/fs/cgroup";
  if (!existsSync(join(base, "cgroup.controllers"))) return false;
  const have = readCgroupList(join(base, "cgroup.controllers"));
  if (!CGROUP_CONTROLLERS.every((c) => have.includes(c))) return false;
  return isWritable(base);
}

/** Resolve + prepare the cgroup v2 base for buildSpawn (enables controllers). null ⇒ unusable. */
function prepareCgroupBase(): string | null {
  const base = process.env.ATLAS_SANDBOX_CGROUP_ROOT ?? "/sys/fs/cgroup";
  if (!existsSync(join(base, "cgroup.controllers")) || !isWritable(base)) return null;
  return enableCgroupControllers(base) ? base : null;
}

/** A per-worker cgroup leaf with its limits set + a cleanup that removes it. */
interface WorkerCgroup {
  /** Absolute leaf dir (e.g. `/sys/fs/cgroup/atlas-worker-<rand>`). */
  readonly dir: string;
  /** Remove the leaf (safe once the worker's processes have exited). */
  cleanup(): void;
}

/**
 * Create the per-worker cgroup leaf under `base`, cap memory/pids/cpu from `limits`, and
 * return it + a cleanup. The caller moves the worker into `dir/cgroup.procs` before exec.
 */
function createWorkerCgroup(base: string, name: string, limits: SandboxLimits): WorkerCgroup {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const put = (file: string, value: string): void => {
    try {
      writeFileSync(join(dir, file), value);
    } catch {
      /* controller file may be absent on an odd kernel — the rlimit belt still applies */
    }
  };
  // memory.max = the address-space cap; forbid swap so it cannot be side-stepped.
  put("memory.max", String(limits.maxAddressSpaceBytes));
  put("memory.swap.max", "0");
  // pids.max = the process/thread cap (a fork bomb trips this even without RLIMIT_NPROC).
  put("pids.max", String(limits.maxProcesses));
  // cpu.max = "<quota_us> <period_us>" — bound the worker to a single CPU (quota==period)
  // so it cannot saturate every core; RLIMIT_CPU still bounds TOTAL cpu-seconds.
  put("cpu.max", "100000 100000");
  return {
    dir,
    cleanup: () => {
      // The worker's processes have exited by the time the launcher runs cleanup (it
      // fires on child `close`), so the leaf is empty and rmdir succeeds; retry a few
      // times to tolerate a slow reap, then give up (best-effort, never throws).
      for (let i = 0; i < 20; i++) {
        try {
          rmdirSync(dir);
          return;
        } catch {
          /* still draining — retry */
        }
      }
    },
  };
}

class LinuxBackend implements SandboxBackend {
  readonly hostId: "linux-x86_64" | "linux-arm64";

  constructor(hostId: "linux-x86_64" | "linux-arm64") {
    this.hostId = hostId;
  }

  probe(): SandboxCapabilityCheck[] {
    const bwrap = firstExisting(BWRAP_CANDIDATES);
    const prlimit = firstExisting(PRLIMIT_CANDIDATES);
    const seccomp = buildSeccompProgram() !== null;
    const usernsOk = usernsAvailable();
    const seccompDetail = bwrap === null ? "bwrap not found" : "no seccomp program for this arch";

    const nsBacked = (guarantee: SandboxCapabilityCheck["guarantee"], primitive: string): SandboxCapabilityCheck =>
      bwrap !== null && usernsOk
        ? { guarantee, available: true, primitive }
        : {
            guarantee,
            available: false,
            primitive,
            detail: bwrap === null ? "bwrap not found" : "unprivileged user namespaces unavailable",
          };

    return [
      nsBacked("no-network", "bwrap-unshare-net+seccomp-deny-socket"),
      { guarantee: "empty-environment", available: true, primitive: "bwrap-clearenv+spawn-empty-env" },
      nsBacked("isolated-filesystem", "bwrap-mountns-minimal-binds+tmpfs"),
      nsBacked("no-credential-access", "bwrap-unmapped-credential-dirs"),
      { guarantee: "no-inherited-fds", available: true, primitive: "close-on-exec+explicit-stdio" },
      seccomp && bwrap !== null
        ? { guarantee: "no-subprocess", available: true, primitive: "seccomp-deny-fork/vfork/clone-proc/execveat" }
        : { guarantee: "no-subprocess", available: false, primitive: "seccomp-deny-fork/clone-proc", detail: seccompDetail },
      seccomp && bwrap !== null
        ? { guarantee: "syscall-restriction", available: true, primitive: "seccomp-bpf-allowlist-default-eperm" }
        : { guarantee: "syscall-restriction", available: false, primitive: "seccomp-bpf-allowlist", detail: seccompDetail },
      prlimit !== null && cgroupV2Available()
        ? {
            guarantee: "resource-caps",
            available: true,
            primitive: "prlimit(cpu,as,fsize,nofile,nproc)+cgroup2(memory,pids,cpu)+rss-watchdog+wallclock",
          }
        : {
            guarantee: "resource-caps",
            available: false,
            primitive: "prlimit+cgroup2+watchdog",
            detail:
              prlimit === null
                ? "prlimit not found"
                : "cgroup v2 unavailable (need ATLAS_SANDBOX_CGROUP_ROOT or a writable /sys/fs/cgroup with memory/pids/cpu controllers)",
          },
      { guarantee: "scan-before-persist", available: true, primitive: "in-worker-scan+attested-pipe" },
    ];
  }

  buildSpawn(inputs: SandboxSpawnInputs): SandboxSpawnPlan {
    const bwrap = firstExisting(BWRAP_CANDIDATES);
    const prlimit = firstExisting(PRLIMIT_CANDIDATES);
    const sh = firstExisting(SH_CANDIDATES);
    // Fail closed rather than run unconfined (the launcher already gates on
    // probeSandbox().supported, so this only trips if primitives vanished mid-run).
    if (bwrap === null || prlimit === null || sh === null) {
      throw new Error("linux sandbox primitives unavailable (bwrap/prlimit/sh) — refusing to launch");
    }
    const seccomp = buildSeccompProgram();
    if (seccomp === null) throw new Error(`no seccomp program for arch ${arch()} — refusing to launch`);

    // Per-worker cgroup v2 (finding 1): memory/pids/cpu caps the worker cannot escape.
    // Fail closed if the cgroup base is unusable (the probe already gates on this).
    const cgroupBase = prepareCgroupBase();
    if (cgroupBase === null) {
      throw new Error("linux sandbox cgroup v2 unavailable — refusing to launch");
    }

    const blobDir = mkdtempSync(join(tmpdir(), "atlas-lsbx-"));
    const blobPath = join(blobDir, "seccomp.bpf");
    writeFileSync(blobPath, seccomp, { mode: 0o600 });
    const extraFds: ExtraChildFd[] = [{ childFd: SECCOMP_FD, path: blobPath }];
    // The cgroup leaf name mirrors the (random) scratch dir so the two are correlatable.
    const cgroup = createWorkerCgroup(cgroupBase, basename(blobDir), inputs.limits);

    // MINIMAL read-only bind set (wing round-2 finding: `--ro-bind / /` exposed the
    // whole host incl. same-UID Atlas keys). Bind ONLY the Node runtime closure + the
    // compiled code closure; everything else (/home, /etc/atlas, the vault) is unmapped
    // and therefore absent in the jail. `--ro-bind-try` tolerates a path that does not
    // exist on a given distro.
    const nodeRoot = dirname(dirname(inputs.nodePath)); // e.g. /usr, or a nvm version dir
    const binds: string[] = [];
    const roBind = (src: string, dst = src): void => {
      binds.push("--ro-bind", src, dst);
    };
    const roBindTry = (src: string, dst = src): void => {
      binds.push("--ro-bind-try", src, dst);
    };
    // Core runtime: system libs + loader + node binary + its install tree.
    roBind("/usr");
    roBindTry("/lib");
    roBindTry("/lib64");
    roBindTry("/bin");
    roBindTry("/sbin");
    roBindTry("/etc/ld.so.cache");
    roBindTry("/etc/ld.so.conf");
    roBindTry("/etc/ld.so.conf.d");
    roBindTry("/etc/alternatives"); // distro node symlink farm
    roBindTry("/etc/localtime"); // tz for Date
    roBindTry(inputs.nodePath); // nvm/asdf/custom installs outside /usr
    roBindTry(nodeRoot);
    // The compiled import closure (may live under /home — bound explicitly so the rest
    // of /home stays unmapped).
    for (const c of inputs.codeRoots) roBindTry(c);
    // Kernel interfaces node needs.
    binds.push("--proc", "/proc");
    binds.push("--dev", "/dev");
    // Deny roots that fall UNDER a bound code root: mask with an empty tmpfs AFTER the
    // binds so the mask wins (a deny cannot be overridden by an ancestor bind).
    for (const d of inputs.denyReadRoots) binds.push("--tmpfs", d);
    // The ONE input at a fixed path + the private writable tmpfs.
    binds.push("--ro-bind", inputs.request.inputPath, IN_SANDBOX_INPUT);
    binds.push("--tmpfs", IN_SANDBOX_TMP);

    const prlimitArgv: string[] = [
      prlimit,
      // prlimit applies the rlimits, then execs bwrap under them (inherited by node).
      `--cpu=${inputs.limits.cpuSeconds}`,
      `--as=${inputs.limits.maxAddressSpaceBytes}`,
      `--fsize=${inputs.limits.maxFileSizeBytes}`,
      `--nofile=${inputs.limits.maxOpenFiles}`,
      `--nproc=${inputs.limits.maxProcesses}`,
      "--",
      bwrap,
      "--unshare-all",
      "--unshare-net",
      "--clearenv",
      "--die-with-parent",
      "--new-session",
      ...binds,
      "--seccomp",
      String(SECCOMP_FD),
      "--",
      inputs.nodePath,
      inputs.workerModule,
      // rewrite paths to their in-sandbox mount points.
      JSON.stringify({ ...inputs.request, inputPath: IN_SANDBOX_INPUT, workTmp: IN_SANDBOX_TMP }),
    ];

    // Move the process (and therefore every descendant — prlimit→bwrap→node) INTO the
    // per-worker cgroup BEFORE exec, then exec the prlimit chain. `echo $$ > cgroup.procs`
    // migrates the shell itself; membership is inherited, so the whole tree runs capped.
    // A failed migration fails closed (`exit 92` ⇒ non-zero, no control ⇒ worker error).
    // The cgroup path is a fixed cgroupfs location with no shell-special chars; single-
    // quoted for defence.
    const cgProcs = join(cgroup.dir, "cgroup.procs");
    const shim = `echo $$ > '${cgProcs}' || exit 92; exec "$@"`;

    return {
      command: sh,
      args: ["-c", shim, "atlas-cg", ...prlimitArgv],
      extraFds,
      cleanup: () => {
        rmSync(blobDir, { recursive: true, force: true });
        cgroup.cleanup();
      },
    };
  }
}

/** The Linux backend for the detected arch, or `null` on a non-Linux host. */
export function makeLinuxBackend(): SandboxBackend | null {
  const host = detectHost();
  if (host.id === "linux-x86_64" || host.id === "linux-arm64") return new LinuxBackend(host.id);
  return null;
}
