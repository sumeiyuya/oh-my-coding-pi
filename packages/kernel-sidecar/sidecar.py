"""Minimal Jupyter kernel sidecar with a line-delimited JSON protocol.

Requests (stdin, one JSON object per line):
  {"op":"start","lang":"python","interpreter":"C:/.../python.exe"}
  {"op":"execute","id":"e1","code":"...","timeoutMs":120000}
  {"op":"interrupt"}
  {"op":"restart"}
  {"op":"shutdown"}
  {"op":"ping"}

Events (stdout, one JSON object per line):
  {"ev":"ready","kernel":"python3","pid":123}
  {"ev":"stream","id":"e1","name":"stdout","text":"..."}
  {"ev":"display","id":"e1","mime":"image/png","data":"<base64>"}
  {"ev":"display","id":"e1","mime":"text/plain","text":"..."}
  {"ev":"error","id":"e1","ename":"...","evalue":"...","traceback":[...]}
  {"ev":"result","id":"e1","status":"ok"}
  {"ev":"variables","names":[...]}
  {"ev":"interrupted"}
  {"ev":"shutdown","alive":false}

启动协议（2026-11-16 重写）：不再用 jupyter_client 的 wait_for_ready。
它的实现（jupyter_client 8.10 `client.py:161`）每次重问后只给 iopub 0.2 s 窗口、
节奏约 1.2 s；在 Windows + pyzmq 27 上实测会 20 s 超时（自测报告 §7.3 L2）。
这里照 DAWN-Science 的 src/kernel/channel.ts 改：

  1) 先订阅 iopub，再发 kernel_info；
  2) iopub 的“第一声”接受 iopub_welcome 或 parent 属于握手集合的 status；
  3) 沉默时每 250 ms 换一个新 msg_id 重问——慢加入靠重问，不靠 sleep；
  4) shell reply 与 iopub 第一声都到才算 ready；
  5) 失败时把内核自己的 stderr 尾巴一起带出去。

执行收口（2026-11-16）：只认 parent == 本轮 execute 的 status:idle；
shell 已回 execute_reply 而 2 s 内没有 idle 时降级收口并显式告警，
不再拖到上层 120 s 超时。
"""

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from queue import Empty
from uuid import uuid4

try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_write_lock = threading.Lock()

# DAWN 的两个常数：重问节奏 250 ms，握手预算 20 s
REPROBE_S = float(os.environ.get("OMCP_KERNEL_REPROBE_MS", "250")) / 1000.0
HANDSHAKE_S = float(os.environ.get("OMCP_KERNEL_HANDSHAKE_S", "20"))
# 等内核把端口 bind 完再建通道；见 _wait_ports_ready 的注释
PORT_WAIT_S = float(os.environ.get("OMCP_KERNEL_PORT_WAIT_S", "10"))
PORT_SETTLE_S = 0.1
# 内核自己的 stderr/stdout：诊断全靠它（DAWN 的 STDERR_TAIL = 4000 字符）
TAIL_LINES = 200

R_PRELOAD = (
    "suppressPackageStartupMessages({"
    "library(stats);library(graphics);library(grDevices);"
    "library(datasets);library(utils);library(methods)})"
)


def emit(obj):
    with _write_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


class StartFailure(Exception):
    """启动失败：带上内核自己的原话，别再让上层猜。"""

    def __init__(self, message, tail=""):
        super().__init__(message)
        self.tail = tail


class Kernel:
    def __init__(self):
        self.km = None
        self.kc = None
        self.exec_lock = threading.Lock()
        self.alive = False
        self.lang = "python"
        self.kernel_name = os.environ.get("S5_KERNEL", "python3")
        self.spec_source = "fallback"
        # 内核进程的 stdout/stderr 环形缓冲；启动失败时把尾巴抛给上层
        self.kernel_tail = deque(maxlen=TAIL_LINES)
        self.argv = []

    # ---------- 小工具 ----------

    def _tail(self, n=20):
        return "\n".join(list(self.kernel_tail)[-n:])

    def _pid(self):
        try:
            process = getattr(getattr(self.km, "provisioner", None), "process", None)
            return getattr(process, "pid", None)
        except Exception:
            return None

    def _drain_iopub(self):
        while True:
            try:
                self.kc.get_iopub_msg(timeout=0.01)
            except Empty:
                return
            except Exception:
                return

    def _drain_shell(self):
        while True:
            try:
                self.kc.get_shell_msg(timeout=0.01)
            except Empty:
                return
            except Exception:
                return

    def _pump_kernel_output(self):
        """把内核进程的 stdout/stderr 读进环形缓冲。

        必须读：不读的话管道写满，内核会卡住；同时这也是失败诊断唯一的证据来源。
        """
        process = getattr(getattr(self.km, "provisioner", None), "process", None)
        if process is None:
            return

        def pump(stream, tag):
            try:
                for raw in iter(stream.readline, b""):
                    line = raw.decode("utf-8", "replace").rstrip()
                    if line:
                        self.kernel_tail.append("[%s] %s" % (tag, line))
            except Exception:
                return

        for stream, tag in ((getattr(process, "stdout", None), "out"),
                            (getattr(process, "stderr", None), "err")):
            if stream is not None:
                threading.Thread(target=pump, args=(stream, tag), daemon=True).start()

    # ---------- kernelspec ----------

    def _write_spec(self, lang, interpreter, spec_dir):
        """由解释器路径生成一份最小 kernelspec。

        R 的 argv 规则随启动器而变（2026-11-16 实测，R 4.5.2）：

            Rterm   --slave -e 'IRkernel::main()' --args <file>   → commandArgs = "<file>"   ✅
            Rterm   --slave -e 'IRkernel::main()' <file>          → commandArgs = character(0) ❌
            Rscript -e 'IRkernel::main()' <file>                  → commandArgs = "<file>"   ✅
            Rscript -e 'IRkernel::main()' --args <file>           → commandArgs = "--args"   ❌

        也就是说：Rterm 必须带 --args，Rscript 必须不带。两种启动器的规则相反，
        所以这里按执行文件名选，而不是一刀切（自测报告 R-1 只测了 Rscript 一侧）。
        """
        name = "omcp-r" if lang == "r" else "omcp-python"
        d = os.path.join(spec_dir, name)
        os.makedirs(d, exist_ok=True)
        if lang == "r":
            # R.exe 在 Windows 上会再拉起 Rterm.exe，真正的内核是孙进程，
            # 按 PID 或进程树都抓不住（退出后 Rterm 会残留）。直接用同目录的 Rterm.exe。
            d0 = os.path.dirname(interpreter)
            # Rterm 在 bin/ 或 bin/x64/（不同安装布局）；找不到才回退 R.exe
            candidates = [os.path.join(d0, "Rterm.exe"), os.path.join(d0, "x64", "Rterm.exe")]
            rterm = next((p for p in candidates if os.path.exists(p)), None)
            exe = rterm or interpreter
            forced = os.environ.get("OMCP_R_LAUNCHER", "").strip().lower()
            if forced == "rscript" and exe.lower().endswith("rterm.exe"):
                exe = os.path.join(d0, "Rscript.exe")
            elif forced == "rterm" and exe.lower().endswith("rscript.exe"):
                alt = os.path.join(d0, "Rterm.exe")
                alt2 = os.path.join(d0, "x64", "Rterm.exe")
                exe = alt if os.path.exists(alt) else (alt2 if os.path.exists(alt2) else exe)
            is_rscript = os.path.basename(exe).lower().startswith("rscript")
            if is_rscript:
                argv = [exe, "-e", "IRkernel::main()", "{connection_file}"]
            else:
                argv = [exe, "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"]
            display, language = "oh my coding pi R", "R"
        else:
            argv = [interpreter, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
            display, language = "oh my coding pi Python", "python"
        self.argv = argv
        payload = {"argv": argv, "display_name": display, "language": language}
        path = os.path.join(d, "kernel.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        return name

    # ---------- 启动与握手 ----------

    def _handshake(self, timeout=None):
        """DAWN 式握手：先订阅、再问、250 ms 重问、两条通道都到才算 ready。"""
        import zmq

        timeout = HANDSHAKE_S if timeout is None else timeout
        shell = self.kc.shell_channel.socket
        iopub = self.kc.iopub_channel.socket
        poller = zmq.Poller()
        poller.register(shell, zmq.POLLIN)
        poller.register(iopub, zmq.POLLIN)

        probe_ids = set()
        shell_ok = False
        iopub_ok = False
        next_probe = 0.0
        end = time.time() + timeout

        while time.time() < end and not (shell_ok and iopub_ok):
            now = time.time()
            if now >= next_probe:
                try:
                    probe_ids.add(self.kc.kernel_info())  # 每次换新 msg_id
                except Exception as exc:
                    raise StartFailure("发不出 kernel_info：%s" % exc, self._tail())
                next_probe = now + REPROBE_S
            try:
                ready = dict(poller.poll(int(REPROBE_S * 1000)))
            except Exception:
                ready = {}

            if shell in ready:
                try:
                    rep = self.kc.shell_channel.get_msg(timeout=0)
                except Empty:
                    rep = None
                except Exception:
                    rep = None
                if rep and rep.get("msg_type") == "kernel_info_reply" \
                        and rep.get("parent_header", {}).get("msg_id") in probe_ids:
                    shell_ok = True

            if iopub in ready:
                try:
                    msg = self.kc.iopub_channel.get_msg(timeout=0)
                except Empty:
                    msg = None
                except Exception:
                    msg = None
                if msg:
                    mt = msg["header"]["msg_type"]
                    parent = msg.get("parent_header", {}).get("msg_id")
                    if mt == "iopub_welcome" or (mt == "status" and parent in probe_ids):
                        iopub_ok = True

        if not (shell_ok and iopub_ok):
            raise StartFailure(
                "握手失败：shell=%s iopub=%s（DAWN 的原话：这时候执行，输出会被 ZMQ 静默丢掉）"
                % (shell_ok, iopub_ok),
                self._tail(),
            )
        self._drain_shell()
        self._drain_iopub()

    def _wait_ports_ready(self, timeout=None):
        """等内核把 shell/iopub 端口 bind 完，再建客户端通道。

        报告实测（2026-11-17，Windows + pyzmq 27.2 / libzmq 4.3.5）：
        connect() 早于 bind() 的 socket 会停在 CONNECT_DELAYED 且不再重试，
        哪条通道哑是随机的。不加这一步成功率 1/13；加了 10/11，ready 从 20 s 降到 ≈2 s。
        """
        wait = PORT_WAIT_S if timeout is None else timeout
        if wait <= 0:
            return 0
        path = getattr(self.km, "connection_file", None)
        if not path or not os.path.exists(path):
            return 0
        try:
            with open(path, encoding="utf-8") as f:
                conn = json.load(f)
            ports = [int(conn["shell_port"]), int(conn["iopub_port"])]
        except Exception:
            return 0
        started = time.time()
        end = started + wait
        process = getattr(getattr(self.km, "provisioner", None), "process", None)
        while time.time() < end:
            if process is not None and process.poll() is not None:
                raise StartFailure("内核进程在端口就绪前退出了", self._tail())
            ok = 0
            for port in ports:
                probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                probe.settimeout(0.15)
                try:
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        ok += 1
                finally:
                    probe.close()
            if ok == len(ports):
                time.sleep(PORT_SETTLE_S)  # 让 ROUTER 完成 peer 注册
                return int((time.time() - started) * 1000)
            time.sleep(0.05)
        raise StartFailure(
            "等内核端口就绪超时（%.0f s）：%s" % (wait, ports), self._tail()
        )

    def _open_channels(self):
        self.kc = self.km.client()
        self.kc.start_channels()

    def _kill_kernel_tree(self):
        """失败即回收：先杀进程，再关通道（顺序反了 Windows 上会从 native 回调抛错）。"""
        pid = self._pid()
        try:
            if self.km is not None:
                self.km.shutdown_kernel(now=True)
        except Exception as exc:
            log("shutdown_kernel: %s" % exc)
        try:
            if pid and os.name == "nt":
                subprocess.run(
                    ["taskkill", "/pid", str(pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                )
            else:
                process = getattr(getattr(self.km, "provisioner", None), "process", None)
                if process is not None and process.poll() is None:
                    process.kill()
        except Exception as exc:
            log("kill: %s" % exc)
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        except Exception:
            pass
        self.alive = False

    def start(self, lang="python", interpreter=""):
        from jupyter_client import KernelManager

        self.lang = lang
        spec_dir = os.environ.get("OMCP_KERNEL_SPEC_DIR", "")
        if interpreter and spec_dir:
            self.kernel_name = self._write_spec(lang, interpreter, spec_dir)
            # JUPYTER_PATH 的每一项是「数据目录」，jupyter 会去 <项>/kernels/<名字> 找；
            # 我们的 spec 写在 <项>/kernels/<名字>，所以项取 spec_dir 的父目录。
            root = os.path.dirname(os.path.normpath(spec_dir))
            prev = os.environ.get("JUPYTER_PATH", "")
            os.environ["JUPYTER_PATH"] = root + (os.pathsep + prev if prev else "")
            self.spec_source = "generated"
        else:
            self.kernel_name = "sci-ir" if lang == "r" else os.environ.get("S5_KERNEL", "python3")
            self.spec_source = "fallback"
            self.argv = []
        if lang == "python":
            os.environ["MPLBACKEND"] = os.environ.get(
                "S5_MPLBACKEND", "module://matplotlib_inline.backend_inline"
            )

        try:
            self.km = KernelManager(kernel_name=self.kernel_name)
            # stdout/stderr 必须接住：不接就永远不知道内核死于什么（报告 P7）
            self.km.start_kernel(cwd=os.getcwd(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self._pump_kernel_output()  # 先接住 stderr：等端口期间内核可能已经死了
            self.port_wait_ms = self._wait_ports_ready()
            self._open_channels()
            try:
                self._handshake()
            except StartFailure:
                # 内核已起来、端口已 bind：重建一条通道不会再早连接（报告 §6.2 的兜底）
                log("handshake failed, rebuilding channels once")
                try:
                    self.kc.stop_channels()
                except Exception:
                    pass
                time.sleep(0.5)
                self._open_channels()
                self._handshake(timeout=8.0)
            if self.lang == "r":
                # Rscript/Rterm 下 search() 只有 utils+base，--default-packages 本机不生效，
                # 所以由我们预载常用包，用户不必每格写 library(stats)。
                self._run_plain(R_PRELOAD, timeout=30.0)
        except StartFailure:
            self._kill_kernel_tree()
            raise
        except Exception as exc:
            tail = self._tail()
            self._kill_kernel_tree()
            raise StartFailure(str(exc) or type(exc).__name__, tail)

        self.alive = True
        emit({
            "ev": "ready",
            "kernel": self.kernel_name,
            "spec": self.spec_source,
            "interpreter": interpreter or None,
            "pid": self._pid(),
            "argv": self.argv,
            "port_wait_ms": getattr(self, "port_wait_ms", 0),
        })

    def _run_plain(self, code, timeout=30.0, silent=True, collect=False):
        """内部执行：不发 stream/display 事件，只等自己的 idle 与 reply。"""
        msg_id = self.kc.execute(code, silent=silent, store_history=False)
        deadline = time.time() + timeout
        idle = False
        chunks = []
        while time.time() < deadline and not idle:
            try:
                msg = self.kc.get_iopub_msg(timeout=0.2)
            except Empty:
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            mt = msg["header"]["msg_type"]
            if mt == "stream" and collect:
                chunks.append(msg["content"].get("text", ""))
            elif mt == "status" and msg["content"].get("execution_state") == "idle":
                idle = True
        try:
            while True:
                rep = self.kc.get_shell_msg(timeout=0.2)
                if rep.get("parent_header", {}).get("msg_id") == msg_id:
                    break
        except Empty:
            pass
        return "".join(chunks)

    def _user_expr(self, expr, timeout=10.0):
        """user_expressions：不产生输出、不进历史（DAWN 的 probe() 思路）。"""
        msg_id = self.kc.execute(
            "", silent=True, store_history=False, user_expressions={"v": expr}
        )
        deadline = time.time() + timeout
        reply = None
        while time.time() < deadline:
            try:
                msg = self.kc.get_shell_msg(timeout=0.5)
            except Empty:
                continue
            if msg.get("parent_header", {}).get("msg_id") == msg_id:
                reply = msg
                break
        self._drain_iopub()
        if not reply:
            raise RuntimeError("user_expressions 没有回复")
        return reply["content"].get("user_expressions", {}).get("v")

    # ---------- 执行 ----------

    def execute(self, req_id, code, timeout_ms=None):
        if not self.alive:
            emit({"ev": "error", "id": req_id, "ename": "KernelNotRunning", "evalue": "kernel is not running", "traceback": []})
            emit({"ev": "result", "id": req_id, "status": "error"})
            return
        if not self.exec_lock.acquire(timeout=0.05):
            emit({"ev": "error", "id": req_id, "ename": "KernelBusy", "evalue": "another execution is running", "traceback": []})
            emit({"ev": "result", "id": req_id, "status": "error"})
            return
        try:
            self._drain_iopub()
            self._drain_shell()
            msg_id = self.kc.execute(code)
            hard_deadline = time.time() + (float(timeout_ms) / 1000.0 if timeout_ms else 3600.0) + 3.0
            idle = False
            reply_status = None
            grace_from = None
            warned = False
            while True:
                try:
                    msg = self.kc.get_iopub_msg(timeout=0.2)
                except Empty:
                    msg = None
                if msg:
                    msg_type = msg["header"]["msg_type"]
                    content = msg["content"]
                    parent = msg.get("parent_header", {}).get("msg_id")
                    if msg_type == "status":
                        # 只认本轮：内部探针/陈旧消息的 idle 不许结束这一轮
                        if content.get("execution_state") == "idle" and parent == msg_id:
                            idle = True
                    elif parent == msg_id:
                        if msg_type == "stream":
                            emit({
                                "ev": "stream",
                                "id": req_id,
                                "name": content.get("name", "stdout"),
                                "text": content.get("text", ""),
                            })
                        elif msg_type in ("display_data", "execute_result"):
                            data = content.get("data") or {}
                            if "image/png" in data:
                                emit({"ev": "display", "id": req_id, "mime": "image/png", "data": data["image/png"]})
                            if "text/plain" in data:
                                emit({"ev": "display", "id": req_id, "mime": "text/plain", "text": data["text/plain"]})
                        elif msg_type == "error":
                            emit({
                                "ev": "error",
                                "id": req_id,
                                "ename": content.get("ename"),
                                "evalue": content.get("evalue"),
                                "traceback": content.get("traceback", []),
                            })
                if reply_status is None:
                    try:
                        reply = self.kc.get_shell_msg(timeout=0.05)
                        if reply.get("parent_header", {}).get("msg_id") == msg_id:
                            reply_status = reply["content"].get("status", "ok")
                    except Empty:
                        pass
                if idle:
                    break
                if reply_status is not None and not idle:
                    # shell 已经答复但 iopub 没有 idle：输出通道静默。
                    # 降级收口，但明确告诉用户——不要假装输出完整。
                    grace_from = grace_from or time.time()
                    if time.time() - grace_from > 2.0:
                        if not warned:
                            warned = True
                            emit({
                                "ev": "stream",
                                "id": req_id,
                                "name": "stdout",
                                "text": "\n[警告] 输出通道(iopub)未响应，本次只拿到 shell 答复；"
                                        "若有输出缺失，请重跑该 cell 或改用脚本。\n",
                            })
                        break
                if time.time() > hard_deadline:
                    emit({
                        "ev": "error",
                        "id": req_id,
                        "ename": "KernelTimeout",
                        "evalue": "执行超过 %.0f s 仍未收口，已中断" % ((time.time() - (hard_deadline - 3.0))),
                        "traceback": [],
                    })
                    try:
                        self.interrupt()
                    except Exception:
                        pass
                    reply_status = "error"
                    break
            if reply_status is None:
                try:
                    reply = self.kc.get_shell_msg(timeout=5)
                    reply_status = reply["content"].get("status", "unknown")
                except Empty:
                    reply_status = "unknown"
            emit({"ev": "result", "id": req_id, "status": reply_status})
        except Exception as exc:
            emit({
                "ev": "error",
                "id": req_id,
                "ename": type(exc).__name__,
                "evalue": str(exc),
                "traceback": traceback.format_exc().splitlines(),
            })
            emit({"ev": "result", "id": req_id, "status": "error"})
        finally:
            self.exec_lock.release()

    # ---------- 变量 ----------

    def variables(self):
        if not self.alive:
            emit({"ev": "variables", "names": [], "error": "kernel not running"})
            return
        if not self.exec_lock.acquire(timeout=0.05):
            emit({"ev": "variables", "names": [], "busy": True})
            return
        try:
            names = None
            if self.lang == "r":
                try:
                    v = self._user_expr("paste(ls(globalenv()), collapse='\\n')", timeout=8.0)
                    if v and v.get("status") == "ok":
                        text = (v.get("data") or {}).get("text/plain", "")
                        names = [n for n in str(text).replace("\\n", "\n").splitlines() if n.strip()]
                except Exception:
                    names = None
                if names is None:
                    text = self._run_plain(
                        "cat(paste(ls(globalenv()), collapse='\\n'))", timeout=15.0, silent=False, collect=True
                    )
                    names = [n for n in text.splitlines() if n.strip()]
            else:
                try:
                    v = self._user_expr(
                        "__import__('json').dumps([k for k in globals() if not k.startswith('_')])",
                        timeout=8.0,
                    )
                    if v and v.get("status") == "ok":
                        names = json.loads((v.get("data") or {}).get("text/plain", "[]"))
                except Exception:
                    names = None
                if names is None:
                    text = self._run_plain(
                        "import json as _omcp_json\n"
                        "print(_omcp_json.dumps([k for k in globals() if not k.startswith('_')]))",
                        timeout=15.0, silent=False, collect=True,
                    )
                    lines = text.splitlines()
                    names = json.loads(lines[-1]) if lines else []
            emit({"ev": "variables", "names": names or []})
        except Exception as exc:
            emit({"ev": "variables", "names": [], "error": str(exc)})
        finally:
            self.exec_lock.release()

    # ---------- 生命周期 ----------

    def interrupt(self):
        try:
            self.km.interrupt_kernel()
            emit({"ev": "interrupted"})
        except Exception as exc:
            emit({"ev": "error", "ename": type(exc).__name__, "evalue": str(exc)})

    def restart(self):
        try:
            try:
                if self.kc is not None:
                    self.kc.stop_channels()
            except Exception:
                pass
            self.km.restart_kernel(now=True, newports=True)
            self._pump_kernel_output()
            self.port_wait_ms = self._wait_ports_ready()
            self._open_channels()
            self._handshake()
            if self.lang == "r":
                self._run_plain(R_PRELOAD, timeout=30.0)
            self.alive = True
            emit({"ev": "ready", "kernel": self.kernel_name, "restarted": True, "pid": self._pid()})
        except Exception as exc:
            tail = self._tail()
            self.alive = False
            self._kill_kernel_tree()
            emit({
                "ev": "error",
                "ename": "KernelStartFailed",
                "evalue": str(exc) or type(exc).__name__,
                "stderr_tail": getattr(exc, "tail", "") or tail,
                "argv": self.argv,
                "cwd": os.getcwd(),
            })

    def shutdown(self):
        log("shutdown: begin kernel=%s" % self.kernel_name)
        # 必须在关内核之前拿 pid：shutdown_kernel 之后 provisioner.process 会被清掉
        process = getattr(getattr(self.km, "provisioner", None), "process", None)
        pid = getattr(process, "pid", None) if process is not None else None
        try:
            if self.km is not None:
                self.km.shutdown_kernel(now=True)
        except Exception as exc:
            log("shutdown: %s" % exc)
        try:
            log("shutdown: provisioner pid=%r" % (pid,))
            if pid and os.name == "nt":
                # Windows 上内核常常是 cmd.exe → Rterm.exe 的树，process.kill() 只杀 cmd，
                # Rterm 会被摘掉留在后台。趁 sidecar 还活着，按树杀。
                subprocess.run(
                    ["taskkill", "/pid", str(pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                )
            elif process is not None and process.poll() is None:
                process.kill()
        except Exception as exc:
            log("kill: %s" % exc)
        self.alive = False
        emit({"ev": "shutdown", "alive": False})


def main():
    kernel = Kernel()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            emit({"ev": "error", "ename": "BadRequest", "evalue": str(exc)})
            continue
        op = req.get("op")
        if op == "start":
            try:
                kernel.start(req.get("lang", "python"), req.get("interpreter", ""))
            except Exception as exc:
                # start() 里已经写过 stderr 尾巴；这里只负责把原因交出去
                emit({
                    "ev": "error",
                    "ename": "KernelStartFailed",
                    "evalue": str(exc) or type(exc).__name__,
                    "stderr_tail": getattr(exc, "tail", ""),
                    "argv": getattr(kernel, "argv", []),
                    "cwd": os.getcwd(),
                })
        elif op == "execute":
            threading.Thread(
                target=kernel.execute,
                args=(req.get("id"), req.get("code", ""), req.get("timeoutMs")),
                daemon=True,
            ).start()
        elif op == "interrupt":
            kernel.interrupt()
        elif op == "variables":
            threading.Thread(target=kernel.variables, daemon=True).start()
        elif op == "restart":
            threading.Thread(target=kernel.restart, daemon=True).start()
        elif op == "shutdown":
            kernel.shutdown()
            break
        elif op == "ping":
            emit({"ev": "pong"})
        else:
            emit({"ev": "error", "ename": "UnknownOp", "evalue": str(op)})

    # 父进程没了（stdin EOF）也要把内核带走，否则 Rterm 会留在后台
    try:
        kernel.shutdown()
    except Exception as exc:
        log("shutdown on EOF: %s" % exc)


if __name__ == "__main__":
    main()
