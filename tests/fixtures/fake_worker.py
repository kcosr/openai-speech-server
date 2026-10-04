#!/usr/bin/env python3
from __future__ import annotations
import os, sys, threading, time, json, hashlib, wave, math, struct
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../workers")))
from common import main, wav_stream_header

def load(init):
    print("provider initialization output")
    os.write(1, b"native provider initialization output\n")
    time.sleep(float(init.get("options", {}).get("warmup_delay", 0)))
    return init
def run(model, request, cancelled: threading.Event):
    if model.get("options", {}).get("fixture_directory"):
        return fixture_run(model, request, cancelled)
    if request["task"] == "transcription":
        if request.get("language") == "uncancellable": time.sleep(0.4)
        if request.get("language") == "crash": os._exit(1)
        if request.get("language") == "fail": raise RuntimeError("synthetic transcription failure")
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

def fixture_run(model, request, cancelled):
    directory = model["options"]["fixture_directory"]
    with open(os.path.join(directory, "fixture-config.json")) as handle: config = json.load(handle)
    def observe(event):
        with open(os.path.join(directory, "observations.jsonl"), "a") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
    if request["task"] == "transcription":
        with wave.open(request["path"], "rb") as audio:
            pcm = audio.readframes(audio.getnframes())
            observe({"type": "transcription", "sampleRate": audio.getframerate(), "bytes": len(pcm), "sha256": hashlib.sha256(pcm).hexdigest()})
            if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                raise RuntimeError("Expected normalized mono PCM16 at 16 kHz")
        if cancelled.wait(config.get("asrDelayMs", 0) / 1000):
            observe({"type": "cancelled", "task": "transcription"})
            return {"text": ""}
        generation = config.get("generation", 0)
        if model.get("fixture_generation") != generation:
            model["fixture_generation"], model["fixture_index"] = generation, 0
        index = model.get("fixture_index", 0)
        model["fixture_index"] = index + 1
        transcripts = config.get("transcripts", [])
        return {"text": transcripts[index] if index < len(transcripts) else "test transcript", "language": "en"}
    observe({"type": "speech", "text": request["input"]})
    def chunks():
        if request.get("format") == "wav": yield wav_stream_header(24000)
        count = round(config.get("ttsDurationSeconds", 1) * 24000)
        samples = b"".join(struct.pack("<h", math.floor(4000 * math.sin(2 * math.pi * 440 * i / 24000) + 0.5)) for i in range(count))
        try:
            for offset in range(0, len(samples), 4096):
                if cancelled.is_set(): return
                yield samples[offset:offset + 4096]
                if request["input"] == "hold-tts": cancelled.wait(60); return
                if request["input"] == "fail": raise RuntimeError("synthetic stream failure")
                if cancelled.wait(0.005): return
        finally:
            if cancelled.is_set(): observe({"type": "cancelled", "task": "speech"})
    return chunks()
if __name__ == "__main__": main(load, run)
