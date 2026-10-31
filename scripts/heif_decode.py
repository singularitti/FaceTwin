"""Bounded, memory-only HEIF primary-image previews with no photo metadata."""
from io import BytesIO

from PIL import ImageCms
import pillow_heif

# Only the primary still image is needed; keep libheif's security limits enabled.
pillow_heif.options.THUMBNAILS = False
pillow_heif.options.DEPTH_IMAGES = False
pillow_heif.options.AUX_IMAGES = False
pillow_heif.options.DECODE_THREADS = 2

MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 32_000_000
MAX_PROFILE_BYTES = 1024 * 1024


class HeifDecodeError(ValueError):
    """A public error code, never a decoder exception or supplied metadata."""


def _check_size(size):
    width, height = size
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise HeifDecodeError("image-too-large")


def decode_heif(data):
    """Return lossless PNG bytes and a small, privacy-safe preview description.

    The compressed primary image is decoded to eight bits. This reduces pixel
    precision; it is not HDR tone mapping or a gain-map preserving conversion.
    HDR appearance is not guaranteed. libheif applies the
    container's orientation; to_pillow resets EXIF orientation so it cannot be
    applied a second time. No auxiliary images or subsequent frames are decoded.
    """
    if not isinstance(data, bytes) or not data:
        raise HeifDecodeError("invalid-image")
    if len(data) > MAX_INPUT_BYTES:
        raise HeifDecodeError("input-too-large")
    try:
        mime = pillow_heif.get_file_mimetype(data)
        if mime not in ("image/heif", "image/heic"):
            raise HeifDecodeError("unsupported-image")
        container = pillow_heif.open_heif(BytesIO(data), convert_hdr_to_8bit=True)
        primary = container[container.primary_index]
        _check_size(primary.size)  # Check before requesting decompressed pixels.
        profile = primary.info.get("icc_profile")
        if profile:
            if not isinstance(profile, bytes) or len(profile) > MAX_PROFILE_BYTES:
                raise HeifDecodeError("unsupported-color-profile")
            try:
                color_space = ImageCms.ImageCmsProfile(BytesIO(profile)).profile.xcolor_space.strip()
                if color_space != "RGB":
                    raise HeifDecodeError("unsupported-color-profile")
            except (OSError, ValueError, TypeError):
                raise HeifDecodeError("unsupported-color-profile") from None
        bit_depth = primary.info.get("bit_depth")
        if bit_depth not in (8, 10, 12, 16):
            raise HeifDecodeError("unsupported-image")
        with primary.to_pillow() as image:
            _check_size(image.size)
            # Unsupported HDR/monochrome modes are rejected rather than silently
            # attaching an RGB profile to a grayscale or 16-bit pixel buffer.
            if image.mode not in ("RGB", "RGBA"):
                raise HeifDecodeError("unsupported-image")
            image.info.clear()  # Drops EXIF, GPS, XMP, comments and thumbnails.
            output = BytesIO()
            image.save(output, format="PNG", icc_profile=profile or None)
            metadata = {
                "width": image.width,
                "height": image.height,
                "bitDepth": bit_depth,
                "profilePresent": bool(profile),
                "output": "8-bit-preview",
                "outputBitDepth": 8,
                "color": "icc-preserved-8bit" if profile else "unprofiled-8bit",
            }
            return output.getvalue(), metadata
    except HeifDecodeError:
        raise
    except Exception:
        # Native decoder errors may include metadata. Never return their text.
        raise HeifDecodeError("invalid-image") from None
