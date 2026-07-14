#!/usr/bin/env python3
"""Versioned newline-delimited worker protocol shared by model workers."""
from __future__ import annotations
import base64, json, os, signal, struct, sys, threading, traceback
from typing import Any, Callable, Iterable

PROTOCOL_VERSION = 1
PROTOCOL_OUT = sys.stdout

def send(message: dict[str, Any]) -> None:
    message["v"] = PROTOCOL_VERSION
    PROTOCOL_OUT.write(json.dumps(message, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()

def wav_stream_header(sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits) + b"data" + struct.pack("<I", 0xFFFFFFFF)

class Worker:
    def __init__(self, load: Callable[[dict[str, Any]], Any], run: Callable[[Any, dict[str, Any], threading.Event], Iterable[bytes] | dict[str, Any]]):
        self.load, self.run = load, run
        self.model: Any = None
        self.active: dict[str, threading.Event] = {}
        self.lock = threading.Lock()

    def execute(self, request: dict[str, Any]) -> None:
        request_id = request["id"]
        cancelled = threading.Event()
        with self.lock: self.active[request_id] = cancelled
        try:
            result = self.run(self.model, request, cancelled)
            if isinstance(result, dict):
                if not cancelled.is_set(): send({"id": request_id, "type": "result", **result})
            else:
                for chunk in result:
                    if cancelled.is_set(): break
                    send({"id": request_id, "type": "chunk", "data": base64.b64encode(chunk).decode("ascii")})
            send({"id": request_id, "type": "cancelled" if cancelled.is_set() else "done"})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send({"id": request_id, "type": "error", "message": str(error)})
        finally:
            with self.lock: self.active.pop(request_id, None)

    def loop(self) -> None:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if message.get("v") != PROTOCOL_VERSION: raise ValueError("unsupported protocol version")
                kind = message.get("type")
                if kind == "init":
                    self.model = self.load(message)
                    send({"type": "ready"})
                elif kind == "request": threading.Thread(target=self.execute, args=(message,), daemon=False).start()
                elif kind == "cancel":
                    event = self.active.get(message.get("id"))
                    if event: event.set()
                elif kind == "shutdown":
                    for event in self.active.values(): event.set()
                    return
                else: raise ValueError(f"unknown message type: {kind}")
            except Exception as error:
                traceback.print_exc(file=sys.stderr)
                send({"type": "error", "message": str(error)})

def main(load: Callable[[dict[str, Any]], Any], run: Callable[[Any, dict[str, Any], threading.Event], Iterable[bytes] | dict[str, Any]]) -> None:
    global PROTOCOL_OUT
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    # Keep a private duplicate for the protocol, then redirect fd 1 itself so
    # native libraries cannot contaminate the NDJSON stream.
    PROTOCOL_OUT = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    Worker(load, run).loop()
