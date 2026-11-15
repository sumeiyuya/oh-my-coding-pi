import time
from jupyter_client import KernelManager

print("before", flush=True)
km = KernelManager(kernel_name="ir")
print("km", flush=True)
km.start_kernel()
print("started", getattr(getattr(km, "provisioner", None), "process", None), flush=True)
kc = km.client()
print("client", flush=True)
kc.start_channels()
print("channels", flush=True)
try:
    kc.wait_for_ready(timeout=30)
    print("ready", flush=True)
except Exception as exc:
    print("ready-failed", type(exc).__name__, exc, flush=True)
kc.stop_channels()
km.shutdown_kernel(now=True)
