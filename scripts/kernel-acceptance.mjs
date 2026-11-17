#!/usr/bin/env node
/**
 * 内核验收（自测报告 F1–F10 的可执行版）。
 *
 *   node scripts/kernel-acceptance.mjs \
 *     --driver "C:/Program Files/Python314/python.exe" \
 *     --python "C:/Program Files/Python314/python.exe" \
 *     --r      "C:/Program Files/R/R-4.6.2/bin/Rscript.exe" \
 *     --workspace ./sandbox/acceptance
 *
 * 为什么要有它：报告第二轮「手工直连 7/7」，而产品仍然不可用。手工能跑通不算数，
 * 同一套用例必须能被一条命令重跑，失败以非零码退出，才能进 CI。
 *
 * 退出码：0 全过；1 有失败；2 参数/启动问题。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "..");
const sidecar = join(repo, "packages", "kernel-sidecar", "sidecar.py");

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DRIVER = arg("driver", process.env.OMCP_PY || "python");
const PYTHON = arg("python", "");
const RSCRIPT = arg("r", "");
const WORKSPACE = resolve(arg("workspace", join(repo, "sandbox", "acceptance")));
const PER_CELL_MS = Number(arg("cell-timeout", "60000"));
const COLDSTARTS = Number(arg("coldstarts", "0"));
const QUIET = process.argv.includes("--quiet");

mkdirSync(join(WORKSPACE, "figures"), { recursive: true });
mkdirSync(join(WORKSPACE, "data"), { recursive: true });
const specDir = join(mkdtempSync(join(tmpdir(), "omcp-accept-")), "kernels");

const results = [];
function record(id, name, pass, detail = "") {
  results.push({ id, name, pass, detail });
  if (!QUIET) console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? " — " + detail : ""}`);
}

class Kernel {
  constructor(lang, interpreter) {
    this.lang = lang;
    this.interpreter = interpreter;
    this.seq = 0;
    this.waiters = new Map();
    this.varWaiters = [];
    this.buffer = [];
    this.raw = spawn(DRIVER, [sidecar], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        OMCP_KERNEL_SPEC_DIR: specDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.raw.stderr.setEncoding("utf8");
    this.raw.stderr.on("data", (d) => {
      if (!QUIET) process.stderr.write("[sidecar] " + d);
    });
    createInterface({ input: this.raw.stdout }).on("line", (line) => this.onLine(line));
  }

  onLine(line) {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.ev === "ready") {
      this.pid = ev.pid ?? null;
      this.lastReady = ev;
      this.startMs = Date.now() - this.startedAt;
      this.readyResolve?.(ev);
      this.readyResolve = null;
    }
    if (ev.ev === "variables") {
      const w = this.varWaiters.shift();
      if (w) w(ev);
      return;
    }
    if (ev.id && this.waiters.has(ev.id)) {
      const w = this.waiters.get(ev.id);
      w.events.push(ev);
      if (ev.ev === "result") {
        this.waiters.delete(ev.id);
        w.resolve(w.events);
      }
    }
    if (ev.ev === "error" && !ev.id) {
      this.startError = ev;
      this.readyReject?.(Object.assign(new Error(ev.evalue || "启动失败"), { detail: ev }));
      this.readyReject = null;
    }
  }

  start(timeoutMs = 60000) {
    this.startedAt = Date.now();
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => rejectP(new Error(`启动超时 ${timeoutMs}ms`)), timeoutMs);
      this.readyResolve = (ev) => {
        clearTimeout(timer);
        resolveP(ev);
      };
      this.readyReject = (err) => {
        clearTimeout(timer);
        rejectP(err);
      };
      this.send({ op: "start", lang: this.lang, interpreter: this.interpreter });
    });
  }

  send(obj) {
    this.raw.stdin.write(JSON.stringify(obj) + "\n");
  }

  async execute(code, timeoutMs = PER_CELL_MS) {
    const id = `a${++this.seq}`;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        rejectP(new Error(`cell 超时 ${timeoutMs}ms`));
      }, timeoutMs + 5000);
      this.waiters.set(id, {
        events: [],
        resolve: (events) => {
          clearTimeout(timer);
          resolveP(events);
        },
      });
      this.send({ op: "execute", id, code, timeoutMs });
    });
  }

  variables(timeoutMs = 10000) {
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => rejectP(new Error("variables 超时")), timeoutMs);
      this.varWaiters.push((ev) => {
        clearTimeout(timer);
        resolveP(ev.names || []);
      });
      this.send({ op: "variables" });
    });
  }

  restart(timeoutMs = 60000) {
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => rejectP(new Error("重启超时")), timeoutMs);
      this.readyResolve = (ev) => {
        clearTimeout(timer);
        resolveP(ev);
      };
      this.readyReject = (err) => {
        clearTimeout(timer);
        rejectP(err);
      };
      this.send({ op: "restart" });
    });
  }

  async shutdown() {
    try {
      this.send({ op: "shutdown" });
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try {
      this.raw.kill();
    } catch {}
  }
}

const text = (events) =>
  events.filter((e) => e.ev === "stream").map((e) => e.text).join("");
const displays = (events) => events.filter((e) => e.ev === "display");
const errors = (events) => events.filter((e) => e.ev === "error");
const status = (events) => {
  const r = events.filter((e) => e.ev === "result").pop();
  return r ? r.status : "missing";
};

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pythonSuite() {
  if (!PYTHON) {
    record("F1", "Python 基线", false, "没有给 --python");
    return;
  }
  const k = new Kernel("python", PYTHON);
  try {
    await k.start();
  } catch (err) {
    record("F1", "Python 内核启动", false, `${err.message}${err.detail?.stderr_tail ? " | " + err.detail.stderr_tail : ""}`);
    return;
  }
  record("F0", "Python 内核启动", k.startMs < 20000, `${(k.startMs / 1000).toFixed(1)}s，pid=${k.pid}`);

  try {
    let ev = await k.execute("x = 41\nprint(x)");
    record("F1", "Python 基线", status(ev) === "ok" && text(ev).includes("41"), text(ev).trim().slice(0, 60));

    ev = await k.execute("print(x + 1)");
    record("F2", "跨 cell 持久化", status(ev) === "ok" && text(ev).includes("42"), text(ev).trim().slice(0, 60));

    ev = await k.execute("1 / 0");
    const e = errors(ev)[0];
    record(
      "F3",
      "异常语义",
      status(ev) === "error" && /ZeroDivisionError/.test(`${e?.ename} ${e?.evalue}`),
      `${e?.ename}: ${e?.evalue}`,
    );

    const fig = join(WORKSPACE, "figures", "_accept.png");
    ev = await k.execute(
      'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\n' +
        `plt.plot([1, 2, 3])\nplt.savefig(${JSON.stringify(fig)}, dpi=100)\nprint("saved")`,
    );
    const okFig = status(ev) === "ok" && existsSync(fig) && statSync(fig).size > 1000;
    record("F4", "内核内出图", okFig, existsSync(fig) ? `${statSync(fig).size} B` : "文件不存在");

    // 连跑 10 次：内核不许换 PID（换了说明中途重启/泄漏）
    const pid0 = k.pid;
    let allOk = true;
    for (let i = 0; i < 10; i++) {
      const r = await k.execute(`_n = ${i}\nprint(_n)`);
      if (status(r) !== "ok") allOk = false;
    }
    const samePid = k.pid === pid0 && pidAlive(pid0);
    record("F8", "连跑 10 次不换内核", allOk && samePid, `pid ${pid0} → ${k.pid}`);

    // 变量面板：不执行用户可见代码、不增加执行计数（这才是“不污染历史”）
    const n1 = Number((text(await k.execute("print(get_ipython().execution_count)")).match(/\d+/) || [0])[0]);
    const vars = await k.variables();
    const n2 = Number((text(await k.execute("print(get_ipython().execution_count)")).match(/\d+/) || [0])[0]);
    record(
      "F11",
      "变量面板不污染历史",
      n2 === n1 + 1 && vars.includes("x"),
      `execution_count ${n1}→${n2}，变量 ${vars.length} 个`,
    );

    // 重启也要走同一条握手（旧路径这里同样调 wait_for_ready）
    const pidBeforeRestart = k.pid;
    await k.restart();
    const afterRestart = await k.execute("print('x' in globals())");
    record(
      "F12",
      "重启后重新握手",
      k.pid !== pidBeforeRestart && text(afterRestart).includes("False"),
      `pid ${pidBeforeRestart} → ${k.pid}`,
    );

    const pid = k.pid;
    await k.shutdown();
    await new Promise((r) => setTimeout(r, 1500));
    record("F8b", "退出后进程消失", !pidAlive(pid), `pid ${pid}`);
  } catch (err) {
    record("F1", "Python 套件异常", false, err.message);
  } finally {
    await k.shutdown();
  }
}

async function rSuite() {
  if (!RSCRIPT) {
    record("F5", "R 基线", false, "没有给 --r");
    return;
  }
  const k = new Kernel("r", RSCRIPT);
  try {
    await k.start();
  } catch (err) {
    record("F5", "R 内核启动", false, `${err.message}${err.detail?.stderr_tail ? " | " + err.detail.stderr_tail : ""}`);
    return;
  }
  record("F0r", "R 内核启动", k.startMs < 25000, `${(k.startMs / 1000).toFixed(1)}s，pid=${k.pid}`);

  try {
    let ev = await k.execute('cat(R.version.string, "\\n")\nmean(c(1, 2, 3))');
    record("F5", "R 基线", status(ev) === "ok" && /R version/.test(text(ev)), text(ev).replace(/\n/g, " | ").slice(0, 80));

    ev = await k.execute("sd(c(1,2,3)); png(tempfile()); plot(1); dev.off(); head(mtcars, 1); cat('preload-ok\\n')");
    record(
      "F6",
      "R 预载（sd/png/mtcars）",
      status(ev) === "ok" && text(ev).includes("preload-ok") && errors(ev).length === 0,
      errors(ev)[0]?.evalue ?? "",
    );

    const csv = join(WORKSPACE, "data", "_accept_r.csv");
    writeFileSync(csv, "group,value\nctrl,1\ntreat,2\n", "utf8");
    ev = await k.execute(`d <- read.csv(${JSON.stringify(csv)}); cat(nrow(d), "x", ncol(d), "\\n")`);
    record("F7", "R 读外部队表", status(ev) === "ok" && /2 x 2/.test(text(ev)), text(ev).trim());

    const pid = k.pid;
    await k.shutdown();
    await new Promise((r) => setTimeout(r, 1500));
    record("F8r", "R 退出后进程消失", !pidAlive(pid), `pid ${pid}`);
  } catch (err) {
    record("F5", "R 套件异常", false, err.message);
  } finally {
    await k.shutdown();
  }
}


/**
 * 冷启动 ×N（修改 5 / S4）：这次故障是概率性的，单次成功说明不了问题。
 * 每次都是独立进程 + 独立侧车，失败时把 evalue 与 stderr_tail 一起记下来。
 */
async function coldStartSuite(n) {
  if (!PYTHON || n <= 0) return;
  const readyMs = [];
  const portMs = [];
  const failures = [];
  for (let i = 0; i < n; i++) {
    const k = new Kernel("python", PYTHON);
    try {
      await k.start(60000);
      readyMs.push(k.startMs);
      if (typeof k.lastReady?.port_wait_ms === "number") portMs.push(k.lastReady.port_wait_ms);
      const ev = await k.execute("print('cold-ok')");
      if (status(ev) !== "ok" || !text(ev).includes("cold-ok")) {
        failures.push({ i, why: `execute status=${status(ev)}` });
      }
    } catch (err) {
      failures.push({
        i,
        why: err.message,
        tail: String(err.detail?.stderr_tail ?? "").slice(-300),
      });
    } finally {
      await k.shutdown();
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const median = readyMs.length
    ? readyMs.slice().sort((a, b) => a - b)[Math.floor(readyMs.length / 2)]
    : 0;
  const medianPort = portMs.length
    ? portMs.slice().sort((a, b) => a - b)[Math.floor(portMs.length / 2)]
    : 0;
  record(
    "F37",
    `冷启动 ×${n}`,
    failures.length === 0 && readyMs.length === n && median <= 5000,
    `成功 ${readyMs.length}/${n}，ready 中位数 ${(median / 1000).toFixed(2)} s，` +
      `等端口中位数 ${medianPort} ms` +
      (failures.length ? `；失败：${JSON.stringify(failures).slice(0, 400)}` : ""),
  );
}

console.log(`驱动：${DRIVER}\nPython：${PYTHON || "（跳过）"}\nR：${RSCRIPT || "（跳过）"}\n工作区：${WORKSPACE}\n`);
await pythonSuite();
await coldStartSuite(COLDSTARTS);
await rSuite();

const failed = results.filter((r) => !r.pass);
const summary = {
  at: new Date().toISOString(),
  driver: DRIVER,
  python: PYTHON,
  r: RSCRIPT,
  workspace: WORKSPACE,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
writeFileSync(join(WORKSPACE, "acceptance.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\n${summary.passed}/${summary.total} 通过 → ${join(WORKSPACE, "acceptance.json")}`);
process.exit(failed.length ? 1 : 0);
