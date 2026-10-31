"""In-memory encoded fixtures exercise the actual HEIF decoder and PNG output."""
from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from PIL import Image, ImageCms
import pillow_heif

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import heif_decode

pillow_heif.register_heif_opener()


def encoded_heif(image, **options):
    output = BytesIO()
    image.save(output, format="HEIF", quality=-1, **options)
    return output.getvalue()


class HeifDecodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not pillow_heif.libheif_info().get("HEIF"):
            raise unittest.SkipTest("HEIF encoder is unavailable")
        cls.profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

    def test_actual_heif_decodes_and_png_is_metadata_free_except_icc(self):
        image = Image.new("RGB", (40, 24), (220, 90, 35))
        exif = Image.Exif()
        exif[0x010E] = "private description"
        exif[0x8825] = {1: "N", 2: (1.0, 2.0, 3.0)}
        data = encoded_heif(image, icc_profile=self.profile, exif=exif.tobytes(), xmp=b"private XMP")
        png, metadata = heif_decode.decode_heif(data)
        self.assertEqual(metadata, {
            "width": 40, "height": 24, "bitDepth": 8,
            "profilePresent": True, "output": "8-bit-preview",
            "outputBitDepth": 8, "color": "icc-preserved-8bit",
        })
        with Image.open(BytesIO(png)) as preview:
            preview.load()
            self.assertEqual(preview.info, {"icc_profile": self.profile})
            self.assertFalse(preview.getexif())
            self.assertEqual(preview.size, (40, 24))
        self.assertNotIn(b"private", png)

    def test_container_and_exif_orientation_is_applied_once(self):
        image = Image.new("RGB", (40, 24), "black")
        image.paste("red", (0, 0, 20, 24))
        image.paste("blue", (20, 0, 40, 24))
        exif = Image.Exif()
        exif[0x0112] = 6
        png, metadata = heif_decode.decode_heif(encoded_heif(image, exif=exif.tobytes()))
        self.assertEqual((metadata["width"], metadata["height"]), (24, 40))
        with Image.open(BytesIO(png)) as preview:
            top = preview.getpixel((12, 8))
            bottom = preview.getpixel((12, 32))
            self.assertGreater(top[0], top[2] + 100)
            self.assertGreater(bottom[2], bottom[0] + 100)
            self.assertFalse(preview.getexif())

    def test_only_primary_frame_is_returned(self):
        first = Image.new("RGB", (40, 24), "red")
        primary = Image.new("RGB", (24, 40), "blue")
        data = encoded_heif(first, save_all=True, append_images=[primary], primary_index=1)
        png, metadata = heif_decode.decode_heif(data)
        self.assertEqual((metadata["width"], metadata["height"]), (24, 40))
        with Image.open(BytesIO(png)) as preview:
            color = preview.getpixel((12, 20))
            self.assertGreater(color[2], color[0] + 100)

    def test_ten_bit_source_is_reported_as_precision_reduced_preview(self):
        output = BytesIO()
        pillow_heif.encode("RGB;16", (40, 24), b"\xff\xff\x00\x00\x00\x00" * 960,
                           output, quality=-1, icc_profile=self.profile)
        png, metadata = heif_decode.decode_heif(output.getvalue())
        self.assertEqual(metadata["bitDepth"], 10)
        self.assertEqual(metadata["outputBitDepth"], 8)
        self.assertEqual(metadata["output"], "8-bit-preview")
        with Image.open(BytesIO(png)) as preview:
            self.assertEqual(preview.mode, "RGB")
            self.assertEqual(preview.info["icc_profile"], self.profile)

    def test_input_and_predecode_pixel_limits(self):
        data = encoded_heif(Image.new("RGB", (40, 24), "red"))
        with patch.object(heif_decode, "MAX_INPUT_BYTES", len(data) - 1):
            with self.assertRaisesRegex(heif_decode.HeifDecodeError, "^input-too-large$"):
                heif_decode.decode_heif(data)
        with patch.object(heif_decode, "MAX_PIXELS", 959):
            with patch.object(pillow_heif.heif.HeifImage, "to_pillow") as decode:
                with self.assertRaisesRegex(heif_decode.HeifDecodeError, "^image-too-large$"):
                    heif_decode.decode_heif(data)
                decode.assert_not_called()

    def test_invalid_data_and_other_formats_are_rejected_safely(self):
        png = BytesIO()
        Image.new("RGB", (40, 24)).save(png, format="PNG")
        data = encoded_heif(Image.new("RGB", (40, 24)))
        for invalid in (b"", b"private/path/corrupt", png.getvalue(), data[:32], data[:-100]):
            with self.subTest(length=len(invalid)):
                with self.assertRaises(heif_decode.HeifDecodeError) as caught:
                    heif_decode.decode_heif(invalid)
                self.assertIn(str(caught.exception), ("invalid-image", "unsupported-image"))

    def test_invalid_icc_is_not_silently_discarded(self):
        data = encoded_heif(Image.new("RGB", (40, 24)), icc_profile=b"invalid ICC")
        with self.assertRaisesRegex(heif_decode.HeifDecodeError, "^unsupported-color-profile$"):
            heif_decode.decode_heif(data)


if __name__ == "__main__":
    unittest.main()
