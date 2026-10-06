import json
import sys
import tempfile
import unittest
from pathlib import Path

import fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "thirdparty"))
from workspace_text import page_text_runs, apply_text_edits
from workspace import _build_pdf


class TextEditing(unittest.TestCase):
    def fixture(self, rotation=0, cropped=False):
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        page.insert_text((70, 80), "Original text", fontsize=14)
        page.insert_text((70, 115), "Keep this line", fontsize=14)
        page.draw_line((40, 160), (300, 160), color=(1, 0, 0))
        if cropped:
            page.set_cropbox(fitz.Rect(30, 20, 350, 270))
        page.set_rotation(rotation)
        return doc

    def edit(self, page, text="Edited text"):
        run = page_text_runs(page)["runs"][0]
        return dict(run, originalRect=run["rect"].copy(),
                    rect=dict(run["rect"], w=.65, h=.16), font="auto", text=text)

    def test_native_replacement_preserves_neighbor_and_vectors(self):
        for rotation in (0, 90, 180, 270):
            for cropped in (False, True):
                with self.subTest(rotation=rotation, cropped=cropped), self.fixture(rotation, cropped) as doc:
                    page = doc[0]
                    apply_text_edits(page, [self.edit(page)])
                    text = page.get_text()
                    self.assertNotIn("Original text", text)
                    self.assertIn("Edited text", text)
                    self.assertIn("Keep this line", text)
                    self.assertTrue(page.get_drawings())
                    self.assertEqual(rotation, page.rotation)

    def test_overflow_rejects_export_atomically(self):
        with tempfile.TemporaryDirectory() as tmp, self.fixture() as doc:
            root = Path(tmp)
            source = root / "source.pdf"; doc.save(source)
            edit = self.edit(doc[0], "Too long " * 200)
            edit["rect"] = dict(edit["rect"], w=.1, h=.03)
            plan = root / "plan.json"
            plan.write_text(json.dumps({"pages":[{"path":str(source),"index":0,"ops":{"textEdits":[edit]}}]}))
            output = root / "output.pdf"; output.write_bytes(b"existing")
            with self.assertRaisesRegex(ValueError, "超出页面"):
                _build_pdf(str(plan), str(output))
            self.assertEqual(output.read_bytes(), b"existing")

    def test_box_grows_shrinks_and_wraps_at_page_edge(self):
        for angle in (0, 90, 180, 270):
            with self.subTest(angle=angle), self.fixture() as doc:
                edit = dict(id="new",source="new",text="中文自动适配文字区域测试",font="auto",color="#000000",fontSize=18,angle=angle,
                            rect=dict(x=.8,y=.8,w=.02,h=.02))
                original = edit["rect"].copy()
                apply_text_edits(doc[0],[edit])
                r = edit["rect"]
                self.assertGreater(r["w"]*r["h"], original["w"]*original["h"])
                self.assertLessEqual(r["x"]+r["w"],1.000001)
                self.assertLessEqual(r["y"]+r["h"],1.000001)
                self.assertIn("中文", doc[0].get_text().replace("\n", ""))
                longer_area = r["w"]*r["h"]
                edit["text"] = "短"
                apply_text_edits(doc[0],[edit])
                self.assertLess(edit["rect"]["w"]*edit["rect"]["h"], longer_area)

    def test_chinese_added_and_deleted_text(self):
        with self.fixture() as doc:
            edit = self.edit(doc[0], "")
            add = dict(id="new", source="new", text="中文测试", font="auto", color="#1677ff", fontSize=14,
                       rect=dict(x=.1,y=.65,w=.7,h=.2))
            apply_text_edits(doc[0], [edit, add])
            self.assertNotIn("Original text", doc[0].get_text())
            self.assertIn("中文测试", doc[0].get_text())

    def test_scanned_replacement_keeps_image_and_adds_selectable_text(self):
        with self.fixture() as original:
            pix = original[0].get_pixmap()
            scan = fitz.open(); page = scan.new_page(width=400, height=300)
            page.insert_image(page.rect, pixmap=pix)
            edit = self.edit(original[0], "扫描修改")
            edit.update(source="ocr", background="#ffffff")
            apply_text_edits(page, [edit])
            self.assertTrue(page.get_images())
            self.assertIn("扫描修改", page.get_text())
            scan.close()

    def test_western_font_cannot_silently_drop_chinese(self):
        with self.fixture() as doc:
            edit = self.edit(doc[0], "中文")
            edit["font"] = "helv"
            with self.assertRaisesRegex(ValueError, "通用字体"):
                apply_text_edits(doc[0], [edit])


if __name__ == "__main__":
    unittest.main()
