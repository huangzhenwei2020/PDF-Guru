"""PDF text runs and non-destructive replacement, shared by preview and export."""
import json
import math
from pathlib import Path

import fitz

TEXT_FONT = fitz.Font("china-s")
LINE_HEIGHT = 1.31


def fit_text_edit(page, edit):
    """Fit replacement geometry using the same embedded font as the editor."""
    text = str(edit.get("text", "")).replace("\r\n", "\n").replace("\r", "\n").expandtabs(1)
    size = float(edit.get("fontSize", 12))
    if not math.isfinite(size) or not 4 <= size <= 144:
        raise ValueError("字号应在 4 至 144 之间")
    angle = int(edit.get("angle", 0)) % 360
    if angle not in (0, 90, 180, 270):
        raise ValueError("暂不支持修改倾斜文字，请新增一个文字框")
    font = fitz.Font("helv") if edit.get("font") == "helv" else TEXT_FONT
    name = "helv" if edit.get("font") == "helv" else "pdfguru-cjk"
    if name == "helv" and any(ord(c) > 255 for c in text):
        raise ValueError("Helvetica 仅支持西文，请选择中英文通用字体")
    if name != "helv":
        page.insert_font(fontname=name, fontbuffer=TEXT_FONT.buffer)
    rect = _rect(edit["rect"], page)
    if not text:
        return rect, text, name, size, angle
    vertical = angle % 180 != 0
    limit = page.cropbox.height if vertical else page.cropbox.width
    cross_limit = page.cropbox.width if vertical else page.cropbox.height
    start = rect.y0 if vertical else rect.x0
    cross_start = rect.x0 if vertical else rect.y0
    measure = lambda value: font.text_length(value, fontsize=size)
    longest_char = max(measure(c) for c in text if c != "\n") if text.strip("\n") else size
    if longest_char + .5 > limit:
        raise ValueError("文字无法容纳在页面内，请减小字号")
    start = min(start, limit - longest_char - .5)
    width = min(limit - start, max(size, max(measure(line) for line in text.split("\n"))) + .5)
    lines = []
    for paragraph in text.split("\n"):
        line = ""
        for char in paragraph:
            if line and measure(line + char) > width - .25:
                lines.append(line)
                line = ""
            line += char
        lines.append(line)
    wrapped = "\n".join(lines)
    probe = fitz.Rect(0, 0, width, cross_limit)
    spare = page.new_shape().insert_textbox(probe, wrapped, fontsize=size,
                                            fontname=name, lineheight=LINE_HEIGHT)
    height = cross_limit - spare + .25
    if height > cross_limit:
        raise ValueError("文字超出页面可用区域，请减少内容或减小字号")
    cross_start = min(cross_start, cross_limit - height)
    rect = (fitz.Rect(cross_start, start, cross_start + height, start + width) if vertical
            else fitz.Rect(start, cross_start, start + width, cross_start + height))
    edit["rect"] = norm_rect(rect, page.cropbox.width, page.cropbox.height)
    return rect, wrapped, name, size, angle


def norm_rect(box, width, height):
    r = fitz.Rect(box)
    return dict(x=r.x0 / width, y=r.y0 / height,
                w=r.width / width, h=r.height / height)


def page_text_runs(page):
    # get_text coordinates use the unrotated, visible CropBox origin.
    w, h = page.cropbox.width, page.cropbox.height
    runs = []
    for block in page.get_text("dict", sort=True)["blocks"]:
        for line in block.get("lines", []):
            direction = line.get("dir", (1, 0))
            angle = round(math.degrees(math.atan2(-direction[1], direction[0]))) % 360
            for span in line.get("spans", []):
                if not span.get("text", "").strip():
                    continue
                runs.append(dict(id=f"native-{len(runs)}", text=span["text"],
                                 rect=norm_rect(span["bbox"], w, h),
                                 fontSize=span["size"], font=span["font"],
                                 color=f'#{span["color"]:06x}', angle=angle,
                                 source="native", confidence=1))
    return dict(width=w, height=h, runs=runs)


def _rect(value, page):
    vals = [float(value[k]) for k in ("x", "y", "w", "h")]
    x, y, w, h = vals
    if not all(math.isfinite(v) for v in vals) or w <= 0 or h <= 0:
        raise ValueError("文字区域无效")
    box = fitz.Rect(x * page.cropbox.width, y * page.cropbox.height,
                    (x + w) * page.cropbox.width, (y + h) * page.cropbox.height)
    bounds = fitz.Rect(0, 0, page.cropbox.width, page.cropbox.height)
    if not bounds.contains(box):
        raise ValueError("文字区域超出页面，请调整范围")
    return box


def _rgb(value):
    value = value.lstrip("#")
    if len(value) != 6:
        raise ValueError("文字颜色无效")
    return tuple(int(value[i:i+2], 16) / 255 for i in (0, 2, 4))


def apply_text_edits(page, edits):
    """Remove original native text; scanned replacements paint only their box.

    Replacement is explicit, no automatic OCR layer over all recognised text.
    Images/vectors are preserved for native PDF edits. OCR whiteouts are visible
    overlays, not security redactions, and do not erase the underlying scan.
    """
    # Validate/layout every replacement before touching original page contents.
    layouts = [fit_text_edit(page, edit) for edit in edits]
    native = [e for e in edits if e.get("source") == "native" and e.get("originalRect")]
    for edit in native:
        rect = _rect(edit["originalRect"], page)
        # Restrict to the middle of the glyphs so adjacent lines survive.
        rect.y0 += min(1, rect.height * .1)
        rect.y1 -= min(1, rect.height * .1)
        page.add_redact_annot(rect, fill=False, cross_out=False)
    if native:
        page.apply_redactions(images=0, graphics=0, text=0)
    for edit, (rect, text, font, size, angle) in zip(edits, layouts):
        if edit.get("source") == "ocr":
            cover = _rect(edit.get("originalRect") or edit["rect"], page)
            page.draw_rect(cover, color=None, fill=_rgb(edit.get("background", "#ffffff")))
        if not text:
            continue
        # Redaction may remove fonts that were only used by the layout probe.
        if font == "pdfguru-cjk":
            page.insert_font(fontname=font, fontbuffer=TEXT_FONT.buffer)
        result = page.insert_textbox(rect, text, fontsize=size, fontname=font,
                                     color=_rgb(edit.get("color", "#000000")), rotate=angle, lineheight=LINE_HEIGHT)
        if result < -0.01:
            raise ValueError("文字超出页面可用区域，请减少内容或减小字号")


def text_command(path, page_index, output, edits_path=None, width=1200):
    from constants import cmd_output_path
    import utils
    from workspace import _fail, _open_document
    try:
        with _open_document(path) as doc:
            page = doc[page_index]
            Path(output).parent.mkdir(parents=True, exist_ok=True)
            if edits_path:
                edits = json.loads(Path(edits_path).read_text(encoding="utf-8"))
                apply_text_edits(page, edits)
                pix = page.get_pixmap(matrix=fitz.Matrix(width / page.rect.width,
                                                        width / page.rect.width), alpha=False)
                pix.save(output)
                utils.dump_json(str(output) + ".layout.json", edits)
            else:
                utils.dump_json(output, page_text_runs(page))
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except Exception as exc:
        _fail(exc)
