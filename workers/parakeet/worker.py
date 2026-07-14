#!/usr/bin/env python3
from __future__ import annotations
import os, sys, threading
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from common import main

def load(init):
    import torch
    import nemo.collections.asr as nemo_asr
    model = nemo_asr.models.ASRModel.from_pretrained(model_name=init.get("checkpoint") or "nvidia/parakeet-tdt_ctc-110m")
    configured_device = init["device"]
    device = "cuda" if configured_device == "auto" and torch.cuda.is_available() else configured_device
    if device != "auto": model = model.to(device)
    model.eval()
    return model

def run(model, request, cancelled: threading.Event):
    if cancelled.is_set(): return {"text": ""}
    result = model.transcribe([request["path"]], batch_size=1)
    first = result[0]
    text = first.text if hasattr(first, "text") else str(first)
    return {"text": text}

if __name__ == "__main__": main(load, run)
