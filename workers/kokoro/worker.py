#!/usr/bin/env python3
from __future__ import annotations
import os, sys, threading
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from common import main, wav_stream_header

SAMPLE_RATE = 24000

def load(init):
    import torch
    from kokoro import KPipeline
    configured_device = init["device"]
    device = "cuda" if configured_device == "auto" and torch.cuda.is_available() else "cpu" if configured_device == "auto" else configured_device
    return KPipeline(lang_code=init["options"].get("lang_code", "a"), repo_id=init.get("checkpoint"), device=device)

def as_pcm16le(audio) -> bytes:
    import numpy as np
    if hasattr(audio, "detach"):
        data = audio.detach().float().cpu().numpy()
    else:
        data = np.asarray(audio, dtype=np.float32)
    mono = np.squeeze(data).astype(np.float32)
    return (np.clip(mono, -1.0, 1.0) * 32767.0).astype("<i2", copy=False).tobytes()

def run(pipeline, request, cancelled: threading.Event):
    if request.get("format") == "wav": yield wav_stream_header(SAMPLE_RATE)
    for result in pipeline(request["input"], voice=request["voice"], speed=float(request["speed"])):
        if cancelled.is_set(): return
        if result.audio is not None:
            yield as_pcm16le(result.audio)

if __name__ == "__main__": main(load, run)
