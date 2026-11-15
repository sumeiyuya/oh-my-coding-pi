import time
from queue import Empty

from jupyter_client import BlockingKernelClient

kc = BlockingKernelClient()
kc.load_connection_file("rconn.json")
kc.start_channels()
print("channels", flush=True)
try:
    kc.wait_for_ready(timeout=15)
    print("ready", flush=True)
except Exception as exc:
    print("not ready", type(exc).__name__, exc, flush=True)

msg_id = kc.execute("1 + 1")
deadline = time.time() + 20
while time.time() < deadline:
    try:
        msg = kc.get_iopub_msg(timeout=1)
    except Empty:
        continue
    mt = msg["header"]["msg_type"]
    c = msg["content"]
    if mt == "stream":
        print("stream", repr(c.get("text")))
    if mt in ("display_data", "execute_result"):
        print("result", repr(str((c.get("data") or {}).get("text/plain"))[:80]))
    if mt == "status" and c.get("execution_state") == "idle":
        break
print("done", flush=True)
kc.stop_channels()
