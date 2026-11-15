from pathlib import Path

from jupyter_client import KernelManager

log = Path("rkm.log")


def w(msg):
    with log.open("a", encoding="utf-8") as f:
        f.write(msg + "\n")


if log.exists():
    log.unlink()
w("begin")
km = KernelManager(kernel_name="ir")
w("manager")
km.start_kernel(cwd=r"D:\desktop\coding\oh-my-coding-pi\sandbox")
w("started " + km.connection_file)
kc = km.client()
kc.start_channels()
w("channels")
try:
    kc.wait_for_ready(timeout=20)
    w("ready")
except Exception as exc:
    w("fail " + type(exc).__name__ + " " + str(exc))
kc.stop_channels()
km.shutdown_kernel(now=True)
w("done")
