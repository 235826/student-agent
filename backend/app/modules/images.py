"""Shared image validation for imports, agent uploads and tool reads."""

import io
import warnings

from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP"}
ALLOWED_IMAGE_MEDIA_TYPES = {"image/png", "image/jpeg", "image/webp"}


def validate_image(data: bytes) -> str:
    """Return the media type for a valid single-frame PNG/JPEG/WebP image."""
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片不能超过 8 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as decoded:
                if decoded.format not in ALLOWED_IMAGE_FORMATS:
                    raise ValueError()
                if (
                    decoded.width * decoded.height > MAX_IMAGE_PIXELS
                    or getattr(decoded, "n_frames", 1) != 1
                ):
                    raise ValueError()
                media_type = Image.MIME[decoded.format]
                decoded.verify()
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise ValueError("请上传有效的单帧 PNG/JPEG/WebP 图片，最多 2000 万像素") from exc
    return media_type
