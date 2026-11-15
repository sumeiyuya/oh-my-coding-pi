import time
from pathlib import Path

from jupyter_client import KernelManager

err_path = Path("rkernel.err")
err = err_path.open("wb")
km = KernelManager(kernel_name="ir")
print("before start", flush=True)
try:
    km.start_kernel(stderr=err)
except Exception as exc:
    print("start failed", type(exc).__name__, exc, flush=True)
    raise

print("started", flush=True)
time.sleep(5)
err.flush()
print("--- kernel stderr ---", flush=True)
print(err_path.read_text(encoding="utf-8", errors="replace")[:3000], flush=True)
print("alive", km.is_alive(), flush=True)

kc = km.client()
kc.start_channels()
try:
    kc.wait_for_ready(timeout=15)
    print("ready", flush=True)
except Exception as exc:
    print("not ready", type(exc).__name__, exc, flush=True)

kc.stop_channels()
km.shutdown_kernel(now=True)
