import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * ADR-102 item 2: a second, independent layer inside the same `bwrap`
 * invocation, joining (not replacing) `--unshare-net`'s namespace-level
 * denial. This module hand-assembles a classic-BPF (cBPF) seccomp program in
 * the exact raw form `bwrap --seccomp FD` expects: a concatenation of
 * `struct sock_filter` records (u16 code, u8 jt, u8 jf, u32 k — 8 bytes each,
 * little-endian), as produced by `seccomp_export_bpf`. There is no
 * libseccomp dependency in this repository and adding a native one to a file
 * whose header comment insists on auditable, dependency-free confinement
 * would be the wrong trade — the program below is small enough to hand-audit
 * in place.
 *
 * Honest scope limitation, load-bearing for what this filter can and cannot
 * do: classic seccomp-BPF only ever sees the raw *scalar* register values a
 * syscall was invoked with — `struct seccomp_data.args[]` — never memory a
 * pointer argument refers to. `connect(2)`/`bind(2)` take a `struct
 * sockaddr *`; the address family living inside that struct is therefore
 * NOT inspectable from BPF, and `listen(2)`/`sendto(2)`/`sendmsg(2)` carry no
 * address-family information on the syscall boundary at all. A filter that
 * tried to key off those syscalls could not distinguish "connect to
 * 127.0.0.1" (which this repository's own `network_denied` path depends on
 * for loopback IPC, per `bubblewrapArguments`'s `--unshare-net` + loopback
 * comment) from "connect to the outside world" — so it would have to choose
 * between breaking loopback or filtering nothing.
 *
 * `socket(2)`'s first two arguments (`domain`, `type`) ARE plain scalars on
 * the syscall boundary, so this filter denies socket *creation* for
 * `AF_PACKET` — raw link-layer sockets that bypass the normal socket API
 * entirely (sniff/inject frames on whatever interface exists in the
 * namespace). `AF_NETLINK` was considered and deliberately NOT added to the
 * denylist: `bubblewrapArguments`'s own `network_denied` path runs
 * `ip link set lo up` *inside* this same seccomp-covered process tree (it
 * has to — bwrap's `CAP_NET_ADMIN` grant exists solely so that command can
 * bring the loopback device up before the sandboxed command starts), and
 * that command needs `AF_NETLINK` to talk to the kernel. Denying it would
 * break the sandbox's own loopback bring-up, not just an attacker's. This
 * was caught empirically (every `network_denied: true` case failed with
 * "Cannot open netlink socket: Operation not permitted" until the denylist
 * was narrowed to `AF_PACKET` alone) rather than reasoned out in advance —
 * recorded here so the next person tuning this filter does not reintroduce
 * it. `AF_INET`/`AF_INET6`/`AF_UNIX`/`AF_NETLINK` socket creation is left
 * alone: the empty network namespace already makes any non-loopback
 * destination unreachable at the kernel routing layer, and denying `AF_INET`
 * outright would also deny the loopback IPC this repository's own test
 * suites (`keeps loopback available...` in `sandbox-broker.test.ts`) depend
 * on. This is a narrower claim than "connect/bind/listen/sendto/sendmsg are
 * seccomp-filtered" — name the gap plainly rather than imply pointer-content
 * filtering that classic BPF cannot perform.
 */

const AUDIT_ARCH_X86_64 = 0xc000003e;
const NR_SOCKET_X86_64 = 41;

const AF_PACKET = 17;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;

interface SockFilter {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

function stmt(code: number, k: number): SockFilter {
  return { code, jt: 0, jf: 0, k };
}
function jump(code: number, k: number, jt: number, jf: number): SockFilter {
  return { code, jt, jf, k };
}

function encode(program: readonly SockFilter[]): Buffer {
  const buffer = Buffer.alloc(program.length * 8);
  program.forEach((instruction, index) => {
    const offset = index * 8;
    buffer.writeUInt16LE(instruction.code, offset);
    buffer.writeUInt8(instruction.jt, offset + 2);
    buffer.writeUInt8(instruction.jf, offset + 3);
    buffer.writeUInt32LE(instruction.k >>> 0, offset + 4);
  });
  return buffer;
}

/**
 * Builds the raw cBPF program denying `AF_PACKET` socket creation while
 * leaving `AF_INET`/`AF_INET6`/`AF_UNIX`/`AF_NETLINK` untouched (see module
 * comment for why `AF_NETLINK` is not denied). Returns `null` when the
 * running architecture's syscall ABI is not one this hand-assembled program
 * targets — only x86_64 is implemented; every other architecture degrades
 * to bubblewrap-only confinement with an honest diagnostic rather than
 * shipping a filter tuned for the wrong syscall numbers.
 */
export function buildNetworkDenySeccompProgram(arch: NodeJS.Architecture = process.arch): Buffer | null {
  if (arch !== "x64") return null;
  // Label positions in the 9-instruction program below. jt/jf are encoded
  // as "instructions to skip after this one" (BPF's actual jump encoding),
  // computed here as `label - from - 1` so the instruction table stays
  // legible instead of hand-counting offsets inline.
  const ALLOW = 6;
  const DENY = 7;
  const KILL = 8;
  const at = (label: number, from: number): number => label - from - 1;
  // offsetof(struct seccomp_data): .nr = 0, .arch = 4, .args[0] low word = 16.
  const instructions: SockFilter[] = [
    /* 0 */ stmt(BPF_LD_W_ABS, 4),
    /* 1 */ jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 0, at(KILL, 1)), // wrong-ABI syscall entry -> KILL
    /* 2 */ stmt(BPF_LD_W_ABS, 0),
    /* 3 */ jump(BPF_JMP_JEQ_K, NR_SOCKET_X86_64, 0, at(ALLOW, 3)), // only socket(2) is inspected
    /* 4 */ stmt(BPF_LD_W_ABS, 16), // domain (args[0] low word)
    /* 5 */ jump(BPF_JMP_JEQ_K, AF_PACKET, at(DENY, 5), 0),
    /* ALLOW (6) */ stmt(BPF_RET_K, SECCOMP_RET_ALLOW),
    /* DENY  (7) */ stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM),
    /* KILL  (8) */ stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
  ];
  return encode(instructions);
}

/**
 * Writes the compiled program to a private (mode 0600) temp file and opens
 * it read-only, returning the host-side fd the caller must duplicate into
 * the child's stdio and then close via {@link closeSeccompFd}. Kept
 * synchronous and file-backed (rather than a memfd, unavailable from plain
 * `node:fs`) — the file lives only inside the confining process's own
 * `/tmp`, never inside the sandboxed workspace, and is removed immediately
 * after the fd is opened.
 */
export function openSeccompProgramFd(program: Buffer): number {
  const directory = mkdtempSync(join(tmpdir(), "arbor-seccomp-"));
  const path = join(directory, "filter.bpf");
  try {
    writeFileSync(path, program, { mode: 0o600 });
    return openSync(path, "r");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function closeSeccompFd(fd: number): void {
  try { closeSync(fd); } catch { /* already closed by an aborted spawn */ }
}

/**
 * Probes whether the running kernel/bwrap actually installs this program
 * (`--seccomp` requires `CONFIG_SECCOMP_FILTER`, present on effectively
 * every distro kernel but not guaranteed inside minimal containers). Mirrors
 * `probeBubblewrapAvailability`'s shape: returns `null` when usable, a
 * diagnostic string otherwise. Never throws.
 */
export function probeSeccompAvailability(bubblewrapExecutable: string, program: Buffer): string | null {
  if (!isAbsolute(bubblewrapExecutable) || !existsSync(bubblewrapExecutable)) return "Bubblewrap executable is unavailable";
  let fd = -1;
  try {
    fd = openSeccompProgramFd(program);
    const probe = spawnSync(bubblewrapExecutable, [
      "--die-with-parent", "--unshare-user", "--unshare-pid",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev",
      "--seccomp", "3", "--", "/usr/bin/true",
    ], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 3_000, env: { PATH: "/usr/bin" } });
    if (probe.status !== 0 || probe.error !== undefined) return "Bubblewrap seccomp probe failed (kernel or bwrap build lacks seccomp support)";
    return null;
  } catch {
    return "Bubblewrap seccomp probe failed (kernel or bwrap build lacks seccomp support)";
  } finally {
    if (fd >= 0) closeSeccompFd(fd);
  }
}
