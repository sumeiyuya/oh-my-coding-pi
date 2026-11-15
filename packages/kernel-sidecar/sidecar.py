"""Minimal Jupyter kernel sidecar with a line-delimited JSON protocol.

Requests (stdin, one JSON object per line):
  {"op":"start"}
  {"op":"execute","id":"e1","code":"..."}
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
  {"ev":"interrupted"}
  {"ev":"shutdown","alive":false}
"""

import base64
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from queue import Empty

try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_write_lock = threading.Lock()


def emit(obj):
    with _write_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


class Kernel:
    def __init__(self):
        self.km = None
        self.kc = None
        self.exec_lock = threading.Lock()
        self.alive = False
        self.lang = "python"
        self.kernel_name = os.environ.get("S5_KERNEL", "python3")
        self.spec_source = "fallback"

    def _drain_iopub(self):
        while True:
            try:
                self.kc.get_iopub_msg(timeout=0.01)
            except Empty:
                return
            except Exception:
                return

    def _write_spec(self, lang, interpreter, spec_dir):
        """由解释器路径生成一份最小 kernelspec。

        与 DAWN 的 argvForInterpreter 同形：python 走 -m ipykernel_launcher，
        R 走 --slave + IRkernel::main()。写到应用私有目录，不碰用户注册表。
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
            argv = [exe, "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"]
            display, language = "oh my coding pi R", "R"
        else:
            argv = [interpreter, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
            display, language = "oh my coding pi Python", "python"
        payload = {"argv": argv, "display_name": display, "language": language}
        path = os.path.join(d, "kernel.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        return name

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
        if lang == "python":
            os.environ["MPLBACKEND"] = os.environ.get(
                "S5_MPLBACKEND", "module://matplotlib_inline.backend_inline"
            )
        self.km = KernelManager(kernel_name=self.kernel_name)
        self.km.start_kernel(cwd=os.getcwd())
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self.alive = True
        pid = None
        try:
            process = getattr(getattr(self.km, "provisioner", None), "process", None)
            pid = getattr(process, "pid", None)
        except Exception:
            pass
        emit({
            "ev": "ready",
            "kernel": self.kernel_name,
            "spec": self.spec_source,
            "interpreter": interpreter or None,
            "pid": pid,
        })

    def _setup_inline(self):
        try:
            self._execute_internal("%matplotlib inline", timeout=20)
        except Exception as exc:
            log("inline setup failed: %s" % exc)

    def _execute_internal(self, code, timeout=30):
        self.kc.execute(code)
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = self.kc.get_iopub_msg(timeout=0.5)
            except Empty:
                continue
            if msg["header"]["msg_type"] == "status" and msg["content"].get("execution_state") == "idle":
                break
        try:
            self.kc.get_shell_msg(timeout=5)
        except Empty:
            pass

    def execute(self, req_id, code):
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
            self.kc.execute(code)
            idle = False
            while not idle:
                try:
                    msg = self.kc.get_iopub_msg(timeout=0.5)
                except Empty:
                    continue
                msg_type = msg["header"]["msg_type"]
                content = msg["content"]
                if msg_type == "status":
                    if content.get("execution_state") == "idle":
                        idle = True
                elif msg_type == "stream":
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
            status = "ok"
            try:
                reply = self.kc.get_shell_msg(timeout=5)
                status = reply["content"].get("status", "ok")
            except Empty:
                status = "unknown"
            emit({"ev": "result", "id": req_id, "status": status})
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

    def variables(self):
        if not self.alive:
            emit({"ev": "variables", "names": [], "error": "kernel not running"})
            return
        if not self.exec_lock.acquire(timeout=0.05):
            emit({"ev": "variables", "names": [], "busy": True})
            return
        try:
            self._drain_iopub()
            if self.lang == "r":
                self.kc.execute("cat(paste(ls(globalenv()), collapse='\\n'))")
            else:
                self.kc.execute(
                    "import json as _sci_json\n"
                    "print(_sci_json.dumps([k for k in globals() if not k.startswith('_')]))"
                )
            chunks = []
            idle = False
            while not idle:
                try:
                    msg = self.kc.get_iopub_msg(timeout=0.5)
                except Empty:
                    continue
                msg_type = msg["header"]["msg_type"]
                content = msg["content"]
                if msg_type == "status" and content.get("execution_state") == "idle":
                    idle = True
                elif msg_type == "stream":
                    chunks.append(content.get("text", ""))
            try:
                self.kc.get_shell_msg(timeout=5)
            except Empty:
                pass
            joined = "".join(chunks).strip()
            if self.lang == "r":
                names = [n for n in joined.splitlines() if n.strip()]
            else:
                lines = joined.splitlines()
                names = json.loads(lines[-1]) if lines else []
            emit({"ev": "variables", "names": names})
        except Exception as exc:
            emit({"ev": "variables", "names": [], "error": str(exc)})
        finally:
            self.exec_lock.release()

    def interrupt(self):
        try:
            self.km.interrupt_kernel()
            emit({"ev": "interrupted"})
        except Exception as exc:
            emit({"ev": "error", "ename": type(exc).__name__, "evalue": str(exc)})

    def restart(self):
        try:
            try:
                self.kc.stop_channels()
            except Exception:
                pass
            self.km.restart_kernel(now=True, newports=True)
            self.kc = self.km.client()
            self.kc.start_channels()
            self.kc.wait_for_ready(timeout=60)
            self.alive = True
            pid = None
            try:
                process = getattr(getattr(self.km, "provisioner", None), "process", None)
                pid = getattr(process, "pid", None)
            except Exception:
                pass
            emit({"ev": "ready", "kernel": self.kernel_name, "restarted": True, "pid": pid})
        except Exception as exc:
            self.alive = False
            emit({"ev": "error", "ename": type(exc).__name__, "evalue": str(exc)})

    def shutdown(self):
        log("shutdown: begin kernel=%s" % self.kernel_name)
        # 必须在关内核之前拿 pid：shutdown_kernel 之后 provisioner.process 会被清掉
        try:
            process = getattr(getattr(self.km, "provisioner", None), "process", None)
            pid = getattr(process, "pid", None) if process is not None else None
        except Exception:
            process, pid = None, None
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
                emit({"ev": "error", "ename": type(exc).__name__, "evalue": str(exc)})
        elif op == "execute":
            threading.Thread(
                target=kernel.execute,
                args=(req.get("id"), req.get("code", "")),
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
