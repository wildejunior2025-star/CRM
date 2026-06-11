import sys
from pathlib import Path
from faster_whisper import WhisperModel

PASTA = Path(r"C:\Users\wilde junior\Downloads\CRM audios")

model = WhisperModel("medium", device="cpu", compute_type="int8")

with open("transcricoes.txt", "w", encoding="utf-8") as f:
    for audio in sorted(PASTA.glob("*.ogg")):
        f.write(f"\n===== {audio.name} =====\n")
        segments, info = model.transcribe(str(audio), language="pt")
        texto = " ".join(seg.text.strip() for seg in segments)
        f.write(texto + "\n")
