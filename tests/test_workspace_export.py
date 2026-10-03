"""Run with: python -m unittest discover -s tests -v."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "thirdparty"))

import fitz
from workspace import _build_pdf


class WorkspaceExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pdfguru-export-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source.pdf"
        with fitz.open() as doc:
            page = doc.new_page(width=200, height=300)
            page.insert_text((20, 40), "TOP")
            page.insert_text((20, 260), "BOTTOM")
            doc.save(self.source)

    def build(self, **item):
        plan = self.root / "plan.json"
        out = self.root / "output.pdf"
        plan.write_text(json.dumps({"pages": [{"path": str(self.source), "index": 0, **item}]}),
                        encoding="utf-8")
        _build_pdf(str(plan), str(out))
        return fitz.open(out)

    def test_crop_preserves_top_region(self):
        with self.build(ops={"crop": {"x": 0, "y": 0, "w": 1, "h": 0.4}}) as doc:
            self.assertEqual(doc[0].get_text().strip(), "TOP")
            self.assertEqual(tuple(doc[0].cropbox), (0, 0, 200, 120))

    def test_mask_covers_top_region(self):
        with self.build(ops={"masks": [{"rect": {"x": 0, "y": 0, "w": 1, "h": 0.4},
                                        "color": "#FF0000", "opacity": 1}]}) as doc:
            pix = doc[0].get_pixmap()
            self.assertEqual(pix.pixel(100, 60), (255, 0, 0))
            self.assertEqual(pix.pixel(100, 240), (255, 255, 255))

    def test_rotation_adds_to_original_and_wraps(self):
        for original in (0, 90, 180, 270):
            rotated = self.root / f"rotated-{original}.pdf"
            with fitz.open(self.source) as doc:
                doc[0].set_rotation(original)
                doc.save(rotated)
            previous = self.source
            self.source = rotated
            try:
                for delta in (0, 90, 180, 270):
                    with self.subTest(original=original, delta=delta):
                        with self.build(rotation=delta) as doc:
                            self.assertEqual(doc[0].rotation, (original + delta) % 360)
            finally:
                self.source = previous


if __name__ == "__main__":
    unittest.main()
