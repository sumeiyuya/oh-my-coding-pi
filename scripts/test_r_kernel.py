import json
import time
from queue import Empty

from jupyter_client import KernelManager

km = KernelManager(kernel_name="ir")
km.start_kernel()
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=90)
print("ready")
msg_id = kc.execute("x <- 41\nprint(x + 1)\nplot(1:10)")
deadline = time.time() + 45
seen = []
images = 0
while time.time() < deadline:
    try:
        msg = kc.get_iopub_msg(timeout=1)
    except Empty:
        continue
    mt = msg["header"]["msg_type"]
    c = msg["content"]
    if mt == "status" and c.get("execution_state") == "idle":
        break
    if mt == "stream":
        print("stream", repr(c.get("text")))
    if mt in ("display_data", "execute_result"):
        data = c.get("data") or {}
        if "image/png" in data:
            images += 1
            print("image", len(data["image/png"]))
        if "text/plain" in data:
            print("text/plain", repr(str(data["text/plain"])[:80]))
    if mt == "error":
        print("error", c.get("ename"), c.get("evalue"))
print("images", images)
kc.stop_channels()
km.shutdown_kernel(now=True)
