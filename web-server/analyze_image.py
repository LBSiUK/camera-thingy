import argparse
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types
load_dotenv()

"""
USAGE:
python analyze_image.py img/IMG_4389.jpeg

"""


CONFIG_PATH = Path(__file__).parent / "config.json"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


_config = load_config()

DEFAULT_SYSTEM_PROMPT = _config.get("system_prompt", "You are a helpful assistant. Describe what you see in the image in detail.")
DEFAULT_USER_PROMPT = _config.get("user_prompt", "What is in this photo?")
DEFAULT_MODEL = _config.get("model", "gemini-2.5-flash")


def analyze_image(
    image_path: str,
    api_key: str,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    user_prompt: str = DEFAULT_USER_PROMPT,
    model_name: str = DEFAULT_MODEL,
) -> str:
    client = genai.Client(api_key=api_key)

    image_file = Path(image_path)
    if not image_file.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    suffix = image_file.suffix.lower()
    mime_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    mime_type = mime_types.get(suffix, "image/jpeg")

    image_bytes = image_file.read_bytes()

    response = client.models.generate_content(
        model=model_name,
        contents=[
            types.Part.from_text(text=user_prompt),
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
        ],
        config=types.GenerateContentConfig(system_instruction=system_prompt),
    )
    return response.text


def main():
    parser = argparse.ArgumentParser(description="Analyze an image using Gemini")
    parser.add_argument("image", help="Path to the image file")
    parser.add_argument("--api-key", default=os.getenv("GEMINI_API_KEY"), help="Gemini API key (or set GEMINI_API_KEY in .env)")
    parser.add_argument("--system-prompt", default=DEFAULT_SYSTEM_PROMPT, help="System prompt for the model")
    parser.add_argument("--user-prompt", default=DEFAULT_USER_PROMPT, help="User prompt to send with the image")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model to use (default: {DEFAULT_MODEL})")
    args = parser.parse_args()

    if not args.api_key:
        parser.error("No API key found. Set GEMINI_API_KEY in .env or pass --api-key.")

    result = analyze_image(
        image_path=args.image,
        api_key=args.api_key,
        system_prompt=args.system_prompt,
        user_prompt=args.user_prompt,
        model_name=args.model,
    )
    print(result)


if __name__ == "__main__":
    main()
