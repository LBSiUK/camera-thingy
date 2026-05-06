import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

from analyze_image import analyze_image

load_dotenv(Path(__file__).parent.parent / ".env")

SERVER_URL = os.getenv("SERVER_URL", "http://localhost:3000")
IMG_PATH = Path(__file__).parent / "img" / "img.jpeg"
IMG_PATH.parent.mkdir(parents=True, exist_ok=True)

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise RuntimeError("GEMINI_API_KEY not set in .env")


def run_once():
    print("Capturing photo from phone...")
    r = requests.post(f"{SERVER_URL}/api/capture", timeout=35)
    r.raise_for_status()

    IMG_PATH.write_bytes(r.content)
    print(f"Saved {len(r.content) // 1024} KB to {IMG_PATH}")

    print("Analyzing with Gemini...")
    result = analyze_image(str(IMG_PATH), api_key)
    print(f"\n{result}\n")
    print("-" * 60)

    requests.post(f"{SERVER_URL}/api/analysis", json={"text": result}, timeout=10)


while True:
    try:
        run_once()
    except KeyboardInterrupt:
        break
    except Exception as e:
        print(f"Error: {e}")
        time.sleep(2)
