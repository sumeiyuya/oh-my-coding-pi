import json
import os
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

lines = []


def reader():
    for line in proc.stdout:
        lines.append(line)
        print("EV", line.strip(), flush=True)


threading.Thread(target=reader, daemon=True).start()


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


send({"op": "start", "lang": "r"})
time.sleep(15)
print("--- after start ---", flush=True)
send({"op": "execute", "id": "t1", "code": "x <- 41\nprint(x + 1)\nplot(1:10)"})
time.sleep(15)
print("--- after execute ---", flush=True)
print("stderr", proc.stderr.read(2000), flush=True)
proc.kill()
