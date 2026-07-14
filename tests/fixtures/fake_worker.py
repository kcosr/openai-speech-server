#!/usr/bin/env python3
from __future__ import annotations
import os, sys, threading, time
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../workers")))
from common import main, wav_stream_header

def load(init):
    print("provider initialization output")
    os.write(1, b"native provider initialization output\n")
    time.sleep(float(init.get("options", {}).get("warmup_delay", 0)))
    return init
def run(model, request, cancelled: threading.Event):
    if request["task"] == "transcription":
        if request.get("language") == "slow":
            for _ in range(20):
                if cancelled.is_set(): break
                time.sleep(0.01)
        prefix = request.get("extensions", {}).get("transcript", {}).get("prefix", model.get("options", {}).get("prefix", ""))
        return {"text": f"{prefix}test transcript", "language": request.get("language", "en")}
    def chunks():
        os.write(1, b"native provider request output\n")
        if request.get("input") == "uncancellable": time.sleep(0.5)
        if request.get("input") == "stall":
            time.sleep(0.25)
            if cancelled.is_set(): return
        if request.get("format") == "wav": yield wav_stream_header(24000)
        count = request.get("extensions", {}).get("synthesis", {}).get("chunks", 200 if request.get("input") == "large" else 3)
        for index in range(count):
            if cancelled.is_set(): return
            yield b"\x00\x01" * (32768 if count > 3 else 128)
            if request.get("input") == "crash" and index == 0: os._exit(1)
            if request.get("input") == "fail" and index == 0: raise RuntimeError("synthetic stream failure")
            time.sleep(0.005)
    return chunks()
if __name__ == "__main__": main(load, run)
