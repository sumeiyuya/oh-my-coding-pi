import json
import os
import queue
import subprocess
import sys
import threading
import time

sidecar = os.path.abspath("packages/kernel-sidecar/sidecar.py")
cwd = os.path.abspath("sandbox")
env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")

proc = subprocess.Popen(
    [sys.executable, sidecar],
    cwd=cwd,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
    env=env,
)
q = queue.Queue()


def reader():
    for line in proc.stdout:
        q.put(line)


threading.Thread(target=reader, daemon=True).start()


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def collect(deadline, tag):
    print("--", tag, flush=True)
    while time.time() < deadline:
        try:
            line = q.get(timeout=1)
        except queue.Empty:
            continue
        print(line.strip(), flush=True)


send({"op": "start", "lang": "r"})
collect(time.time() + 15, "start")
send({"op": "execute", "id": "e1", "code": "x <- 41\nprint(x + 1)"})
collect(time.time() + 15, "execute")
send({"op": "variables", "lang": "r"})
collect(time.time() + 15, "variables")
proc.kill()
