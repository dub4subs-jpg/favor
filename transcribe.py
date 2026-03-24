#!/usr/bin/env python3
"""Local audio transcription using faster-whisper (CTranslate2).
Usage: python3 transcribe.py <audio_file> [language]
Outputs transcription text to stdout.
"""
import sys
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file> [language]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else None

    # Use 'base' model — good balance of speed and accuracy
    # Runs on CPU, ~150MB RAM
    model = WhisperModel("base", device="cpu", compute_type="int8")

    segments, info = model.transcribe(audio_path, language=language, beam_size=5)
    text = " ".join(segment.text.strip() for segment in segments)
    print(text)

if __name__ == "__main__":
    main()
