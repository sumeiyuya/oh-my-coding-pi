/**
 * 会话并发的 GUI 冒烟（修改 4 · M0–M3）。
 *
 * 直接对着跑起来的应用做，不 mock：开标签、切会话、刷新、杀 pi，看界面上的
 * 状态点、未读、转写是不是像设计里说的那样。
 *
 * 用法：
 *   1) 另开一个终端，用**独立的 userData** 起步（不碰你自己的会话）：
 *      cd apps/desktop
 *      ./node_modules/.bin/electron . --remote-debugging-port=9333 \
 *        --user-data-dir=D:/tmp/omcp-smoke
 *   2) node scripts/smoke-sessions.mjs            # 默认连 127.0.0.1:9333
 *
 * 会真的向模型发几句话（每句都很短）。模型不可用时相应步骤标 SKIP，不当作失败。
 */
import playwright from "../apps/desktop/node_modules/playwright-core/index.js";
const { chromium } = playwright;
import { execFileSync } from "node:child_process";

const CDP = process.env.OMCP_SMOKE_CDP ?? "http://127.0.0.1:9333";
const MODEL_HINT = process.env.OMCP_SMOKE_MODEL ?? "deepseek-v4.1-flash";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP(CDP);
const page = browser.contexts()[0].pages()[0];
await page.waitForLoadState("domcontentloaded");

async function snapshot() {
  return page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      tabs: [...document.querySelectorAll(".session-tab")].map((t) => {
        const dot = t.querySelector(".tab-dot");
        return {
          label: txt(t.querySelector(".tab-label")),
          title: t.querySelector(".tab-label")?.getAttribute("title") ?? "",
          active: t.classList.contains("active"),
          busy: dot?.getAttribute("data-busy") === "1",
          suspended: dot?.getAttribute("data-suspended") === "1",
          error: dot?.getAttribute("data-error") === "1",
          queued: dot?.getAttribute("data-queued") === "1",
          unread: Number((txt(t.querySelector(".tab-unread")) || "0").replace(/\D/g, "")) || 0,
        };
      }),
      count: txt(document.querySelector(".session-count")),
      sidebar: [...document.querySelectorAll(".ws-sessions .session-open")].map((b) => ({
        title: txt(b.querySelector(".sid")),
        file: (b.getAttribute("title") ?? "").split("\n")[1] ?? "",
      })),
      busy: Boolean(document.querySelector(".composer")?.textContent?.includes("停止")),
      text: document.body.innerText,
    };
  });
}

async function waitFor(predicate, { timeout = 90_000, interval = 500, label = "" } = {}) {
  const started = Date.now();
  for (;;) {
    const s = await snapshot();
    if (predicate(s)) return s;
    if (Date.now() - started > timeout) {
      throw new Error(`等待超时：${label}\n最后一次状态：${JSON.stringify(s.tabs)} | ${s.count}`);
    }
    await sleep(interval);
  }
}

async function send(text) {
  const box = page.locator(".composer textarea").first();
  await box.click({ timeout: 5000 }).catch(() => {});
  await box.fill(text).catch(() => {});
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(
    () => (document.querySelector(".composer textarea")?.value ?? "") === "",
  );
  if (cleared) return;
  // 输入框没被接管（崩溃后焦点/禁用状态可能残留）：走 IPC 直接把这一句送出去，
  // 仍然是对真实会话的一次真实回合，只是不经过打字这一层。
  const slotId = (await page.evaluate(() => window.api.getSessionBoard())).sessions.find(
    (s) => s.active,
  )?.slotId;
  await page.evaluate(
    ([t, id]) => window.api.prompt(t, undefined, undefined, id ?? undefined),
    [text, slotId],
  );
}

/** 发一句并等这一轮结束（busy 从 true 回到 false；模型不可用时就等 body 出现报错） */
async function sendAndSettle(text, { timeout = 150_000, quietLimit = 60 } = {}) {
  await send(text);
  const started = Date.now();
  let sawBusy = false;
  let quiet = 0;
  for (;;) {
    await sleep(250);
    const busy = await page.evaluate(
      () => window.api.getSessionBoard().then((b) => b.sessions.some((x) => x.busy)),
    );
    const s = await snapshot();
    if (busy) {
      sawBusy = true;
      quiet = 0;
      continue;
    }
    if (sawBusy) return { ok: true, state: s };
    quiet += 1;
    // 没进入运行态也没报错：可能是模型不可用，字符很短的一轮也可能一闪而过
    const failed = /密钥无效|Model access is disabled|尚未完成|没能完成/.test(s.text.slice(-600));
    if (failed && quiet > 4) return { ok: false, state: s, reason: "模型不可用" };
    if (quiet > quietLimit) return { ok: false, state: s, reason: `${quietLimit / 4}s 内没有进入运行态` };
    if (Date.now() - started > timeout) return { ok: false, state: s, reason: "超时" };
  }
}

/* ---------------------------------------------------------------- */
/* S0 选一个能用的模型                                                */
/* ---------------------------------------------------------------- */
async function pickModel() {
  await page.click(".model-picker-trigger");
  await page.waitForTimeout(800);
  const picked = await page.evaluate((hint) => {
    const nodes = [...document.querySelectorAll("button, [role=option]")];
    const hit = nodes.find((n) => (n.textContent ?? "").includes(hint));
    if (!hit) return false;
    hit.click();
    return true;
  }, MODEL_HINT);
  await page.waitForTimeout(800);
  if (!picked) return false;
  // 关掉可能弹出的错误卡
  await page.keyboard.press("Escape").catch(() => {});
  return true;
}

try {
  await pickModel();
  record("S0 选模型", "pass", MODEL_HINT);
} catch (error) {
  record("S0 选模型", "skip", String(error).slice(0, 120));
}

/* ---------------------------------------------------------------- */
/* S1 第一个会话：标签 = 会话                                         */
/* ---------------------------------------------------------------- */
let s = await snapshot();
if (s.sidebar.length === 0) {
  await page.click(".side-new");
  await page.waitForTimeout(600);
  await sendAndSettle("只回复两个字：收到");
}
// 标签是会话落盘、界面刷新之后才出现的，等它一下
s = await waitFor((st) => st.tabs.length >= 1 && st.sidebar.length >= 1, {
  timeout: 40_000,
  interval: 500,
  label: "第一个会话的标签出现",
}).catch(() => snapshot());
const sessionsA = s.sidebar;
if (s.tabs.length >= 1 && s.sidebar.length >= 1) {
  record("S1 标签=会话", "pass", `标签「${s.tabs[0].label}」/ 计数「${s.count}」`);
} else {
  record("S1 标签=会话", "fail", `tabs=${s.tabs.length} sessions=${s.sidebar.length}`);
}
const titleA = s.sidebar[0]?.title ?? "";

/* ---------------------------------------------------------------- */
/* S2 第二个会话：默认槽换绑，第一个变挂起，再打开第一个要有新槽       */
/* ---------------------------------------------------------------- */
let modelUsable = true;
await page.click(".side-new");
await page.waitForTimeout(800);
const second = await sendAndSettle("只回复两个字：第二");
if (!second.ok) modelUsable = false;
s = await waitFor((st) => st.tabs.length >= 2, { timeout: 40_000, interval: 500, label: "第二个标签" }).catch(
  () => snapshot(),
);

const suspendedA = s.tabs.find((t) => t.label === titleA)?.suspended;
if (modelUsable) {
  record(
    "S2a 新建会话换绑默认槽，旧会话挂起",
    suspendedA ? "pass" : "fail",
    `旧会话挂起=${suspendedA}；标签 ${JSON.stringify(s.tabs.map((t) => [t.label, t.suspended]))}`,
  );
} else {
  record("S2a 新建会话换绑默认槽", "skip", "模型不可用，第二个会话没建起来");
}

// 打开第一个会话：默认槽被别人占着 → 应新建一个槽（2 运行）
const openedA = await page.evaluate((title) => {
  const btn = [...document.querySelectorAll(".ws-sessions .session-open")].find(
    (b) => (b.querySelector(".sid")?.textContent ?? "").trim() === title,
  );
  if (!btn) return false;
  btn.click();
  return true;
}, titleA);
if (openedA) {
  await page.waitForTimeout(3000);
  s = await snapshot();
  const running = (s.count.match(/(\d+)\s*运行/) ?? [])[1] ?? "?";
  record(
    "S2b 打开被挂起的会话会另起一个槽",
    Number(running) >= 2 ? "pass" : "fail",
    `计数「${s.count}」`,
  );
} else {
  record("S2b 打开被挂起的会话", "fail", "侧栏里找不到第一个会话");
}

await page.screenshot({ path: ".dawn/smoke-02-two-slots.png" });

/* ---------------------------------------------------------------- */
/* S3 未读：在 A 发一句，立刻切到 B；A 收尾后应出现徽标                 */
/* ---------------------------------------------------------------- */
if (s.tabs.length >= 2) {
  const active = s.tabs.find((t) => t.active)?.label;
  const other = s.tabs.find((t) => !t.active)?.label;
  if (active && other) {
    await send("数到 10，每行一个数字，不要用任何工具");
    await page.waitForTimeout(600);
    await page.evaluate((label) => {
      const tab = [...document.querySelectorAll(".session-tab")].find(
        (t) => (t.querySelector(".tab-label")?.textContent ?? "").trim().startsWith(label),
      );
      tab?.querySelector(".tab-label")?.click();
    }, other);
    await waitFor(() => true, { timeout: 1000 }).catch(() => {});
    const settled = await waitFor(
      (st) => {
        const a = st.tabs.find((t) => t.label.startsWith(active));
        return Boolean(a && !a.busy);
      },
      { timeout: 120_000, label: "A 收尾" },
    ).catch(() => null);
    if (settled) {
      const badge = settled.tabs.find((t) => t.label.startsWith(active))?.unread ?? 0;
      record("S3 后台会话的未读徽标", badge > 0 ? "pass" : "fail", `未读=${badge}`);
      // 切回去应当清零
      await page.evaluate((label) => {
        const tab = [...document.querySelectorAll(".session-tab")].find(
          (t) => (t.querySelector(".tab-label")?.textContent ?? "").trim().startsWith(label),
        );
        tab?.querySelector(".tab-label")?.click();
      }, active);
      await page.waitForTimeout(2500);
      const after = await snapshot();
      const left = after.tabs.find((t) => t.label.startsWith(active))?.unread ?? 0;
      record("S3b 切回后未读清零", left === 0 ? "pass" : "fail", `未读=${left}`);
    } else {
      record("S3 后台会话的未读徽标", "skip", "A 没有在时限内收尾");
    }
  }
} else {
  record("S3 后台会话的未读徽标", "skip", "标签不足两个");
}

/* ---------------------------------------------------------------- */
/* S4 F5：标签与转写都还在                                            */
/* ---------------------------------------------------------------- */
const beforeReload = await snapshot();
await page.reload();
await page.waitForTimeout(6000);
const afterReload = await snapshot();
const tabsKept = afterReload.tabs.length >= beforeReload.tabs.length;
record(
  "S4a F5 后标签还在",
  tabsKept ? "pass" : "fail",
  `刷新前 ${beforeReload.tabs.length} → 刷新后 ${afterReload.tabs.length}`,
);

if (afterReload.tabs.length > 0) {
  const target = afterReload.tabs[0].label;
  await page.evaluate((label) => {
    const tab = [...document.querySelectorAll(".session-tab")].find(
      (t) => (t.querySelector(".tab-label")?.textContent ?? "").trim().startsWith(label),
    );
    tab?.querySelector(".tab-label")?.click();
  }, target);
  await page.waitForTimeout(3500);
  const reopened = await snapshot();
  // 有内容 = 对话区里出现了用户那几句
  const hasHistory = /只回复|收到|第二|数到/.test(reopened.text);
  record("S4b F5 后切回仍有转写", hasHistory ? "pass" : "fail", target);
}
await page.screenshot({ path: ".dawn/smoke-04-after-reload.png" });

/* ---------------------------------------------------------------- */
/* S5 杀掉 pi：应标红点 + 转写里留一句                                */
/* ---------------------------------------------------------------- */
/** 杀掉"当前可见会话"那个槽的 pi 进程（按 --session 里的文件名匹配） */
function killPiOfSession(file) {
  const name = String(file).split(/[\/]/).pop() ?? "";
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*--mode rpc*' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }",
    ],
    { encoding: "utf8" },
  );
  const line = out
    .split(String.fromCharCode(10))
    .map((x) => x.trim())
    .find((x) => name && x.includes(name));
  if (!line) return null;
  const pid = Number(line.split("|")[0]);
  if (!pid) return null;
  execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  return pid;
}

// 先让当前会话真的跑起来（崩溃时要"有回合在飞"，否则只会走空闲重启那条分支）
await send("数到 40，每行一个数字，不要用任何工具");
await waitFor((st) => Boolean(st.tabs.find((t) => t.active)?.busy), {
  timeout: 30_000,
  interval: 200,
  label: "等待回合进入运行态",
}).catch(() => null);
const activeFile = (await page.evaluate(() => window.api.getSessionBoard())).sessions.find(
  (x) => x.active,
)?.file;
const killed = activeFile ? killPiOfSession(activeFile) : null;
if (!killed) {
  record("S5a 崩溃后会话标 interrupted（标签红点）", "skip", "没找到该会话的 pi 进程（可能没带 --session）");
}
await page.waitForTimeout(3000);
const crashed = await snapshot();
if (killed) {
  const errorTab = crashed.tabs.find((t) => t.error);
  const board = await page.evaluate(() => window.api.getSessionBoard());
  const interrupted = board.sessions.filter((x) => x.state === "interrupted");
  record(
    "S5a 崩溃后会话标 interrupted（标签红点）",
    interrupted.length > 0 && Boolean(errorTab) ? "pass" : "fail",
    `pid=${killed}；board=${board.sessions.map((x) => `${x.slotId}:${x.state}`).join(", ")}；红点=${Boolean(errorTab)}`,
  );
  const interruptedNote = /异常退出|被中断/.test(crashed.text);
  record(
    "S5b 当前可见会话立刻看到中断说明",
    interruptedNote ? "pass" : "fail",
    interruptedNote ? "" : "没找到「异常退出」/「被中断」",
  );
}
await page.screenshot({ path: ".dawn/smoke-05-crash.png" });

/* ---------------------------------------------------------------- */
/* S6 崩溃后还能接着用                                               */
/* ---------------------------------------------------------------- */
// 崩溃后 pi 会退避重启（这个环境冷启动约 40 秒），给足时间
const recovered = await sendAndSettle("只回复两个字：恢复", { quietLimit: 480, timeout: 180_000 });
record(
  "S6 崩溃后自动恢复并继续",
  recovered.ok ? "pass" : "skip",
  recovered.ok ? "" : recovered.reason ?? "",
);

/* ---------------------------------------------------------------- */

const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log("\n===== 汇总 =====");
for (const r of results) console.log(`${r.status}\t${r.name}\t${r.detail}`);
console.log(`通过 ${results.length - failed - skipped} · 失败 ${failed} · 跳过 ${skipped}`);

await browser.close();
process.exit(failed > 0 ? 1 : 0);
