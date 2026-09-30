"""不依赖本机 Office 的转换：docx / pptx / xlsx -> PDF。

**定位是兜底。** 装了 Office 时优先走 COM（版式最接近原稿）；这里保证
"一台没装任何办公软件的机器也能把 Word/PPT/Excel 拖进来用"。

目标是**内容可读、结构不乱**，不追求像素级还原——这一点在界面上会如实说明。
要实现像素级还原只能靠真正的排版引擎（Office / LibreOffice），
而 LibreOffice 便携版要 400MB 上下，不适合随包分发。

几种格式的做法：
- **pptx**：每张幻灯片一页，按 z 序把形状画上去（填充/图片/文字框/表格/连接线）。
  幻灯片是绝对定位的，不需要重排，效果最接近原稿。
- **docx / xlsx**：转成 HTML 交给 PyMuPDF 的 Story 排版，**自动分页**。
  正文重排、跨页、表格都由它处理，比自己算行高可靠得多。

已知不还原的东西（都会在返回信息里报出来）：
图表、SmartArt、艺术字、动画、批注、修订标记、页眉页脚、公式。
"""

import base64
import html as _html
import logging
import os
import re
import tempfile
import time
import traceback
from pathlib import Path

import pymupdf
from loguru import logger

# 中文优先的字体族。PyMuPDF 内置的字体对中文有覆盖，
# 但显式指定 sans-serif 能让拉丁字母走更合适的字形。
_BASE_CSS = """
* { font-family: sans-serif; }
body { margin: 0; padding: 0; }
p { margin: 0 0 4pt 0; }
table { border-collapse: collapse; }
td, th { border: 0.5pt solid #999; padding: 2pt 4pt; vertical-align: top; }
h1 { font-size: 20pt; margin: 0 0 8pt 0; }
h2 { font-size: 16pt; margin: 8pt 0 6pt 0; }
h3 { font-size: 13pt; margin: 6pt 0 4pt 0; }
"""

EMU_PER_PT = 12700.0


def _finish(rendered: str, out: str) -> None:
    """把渲染结果**子集化**后写到最终路径。

    两件事都踩过坑：

    1. **不能就地替换渲染器写出的文件。** `DocumentWriter` / `doc.save`
       关掉之后，Windows 上文件句柄不一定立刻释放，`os.replace` 到它上面会直接报
       `[WinError 5] 拒绝访问`（PPT 走 doc.save 没事，Word/Excel 走 DocumentWriter 就会中招）。
       所以做法是：读它、另存到第三个文件、再把那个搬过去，全程不改渲染器的输出。

    2. **必须显式调 `doc.subset_fonts()`。** 不然整个中文字体
       （Droid Sans Fallback，约 3MB）会被整套嵌进去，一页纯文字的 Word 就是 3.6MB；
       子集化后 38KB（小 90 多倍）。`save(subset_fonts=True)` 参数在这里不生效。
       它依赖可选依赖 **fontTools**，缺了会静默失效，所以失败必须记日志。
    """
    tmp = out + ".sub"
    try:
        doc = pymupdf.open(rendered)
        try:
            doc.subset_fonts()
        except Exception as e:
            # loguru 用 {} 占位而不是 %s——写成 %s 会把真实原因吞掉
            logger.warning("字体子集化失败（产物会偏大）: {}", e)
        doc.save(tmp, garbage=4, deflate=True, clean=True)
        doc.close()
        os.replace(tmp, out)
    except Exception as e:
        logger.warning("子集化/重存失败，退回原始产物: {} / {}", type(e).__name__, e)
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        shutil.copyfile(rendered, out)
    finally:
        # 渲染器的输出文件句柄在 Windows 上要过一会儿才松开，
        # 立刻删会失败（和上面 os.replace 报 WinError 5 是同一个原因），所以重试几次。
        if os.path.abspath(rendered) != os.path.abspath(out):
            for _ in range(5):
                try:
                    if os.path.exists(rendered):
                        os.remove(rendered)
                    break
                except Exception:
                    time.sleep(0.2)


def _esc(s) -> str:
    return _html.escape(str(s if s is not None else ""), quote=False)


def _rgb(color) -> str:
    """把 python-docx / python-pptx / openpyxl 的颜色对象转成 CSS 颜色；拿不到就返回空串。

    这里必须**校验取到的值**而不是只 try/except：openpyxl 的 `Color.rgb` 是校验型描述符，
    值非法时它**不抛异常，而是返回一句错误文本**（"Values must be of type <class 'str'>"），
    直接用就会把这句话当成颜色写进 CSS，MuPDF 于是报 css syntax error。
    """
    if color is None:
        return ""
    try:
        rgb = getattr(color, "rgb", None)
    except Exception:
        return ""
    if isinstance(rgb, str) and re.fullmatch(r"[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?", rgb):
        # openpyxl 常给 8 位 ARGB（FF000000），取后 6 位
        return "#" + rgb[-6:]
    return ""


def _pt(v) -> float:
    """EMU -> pt。"""
    try:
        return float(v) / EMU_PER_PT
    except Exception:
        return 0.0


def _len_pt(v) -> float:
    """docx 的 Length(EMU) -> pt。"""
    try:
        return float(v.pt)
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# PowerPoint
# ---------------------------------------------------------------------------

def _pptx_inherited(shape, slide):
    """沿 形状 -> 版式 -> 母版 找这个占位符的默认字号、对齐与颜色。

    为什么必须做：占位符（标题、正文）的 `run.font.size` / `color` 常常是 **None**，
    真正的值写在版式甚至母版里。不做继承解析，渲染出来就是默认小字加纯黑，
    跟原稿差得很远——第一版标题只有指甲盖大，副标题也不该是黑的。

    返回 (字号列表, 可选对齐值, 可选颜色)。
    """
    sizes = []
    align = None
    color = ""
    try:
        idx = shape.placeholder_format.idx
    except Exception:
        return sizes, align, color
    holders = []
    try:
        holders.append(slide.slide_layout)
    except Exception:
        pass
    try:
        holders.append(slide.slide_layout.slide_master)
    except Exception:
        pass
    for holder in holders:
        if holder is None:
            continue
        try:
            placeholders = list(holder.placeholders)
        except Exception:
            continue
        for ph in placeholders:
            try:
                if ph.placeholder_format.idx != idx:
                    continue
            except Exception:
                continue
            try:
                for p in ph.text_frame.paragraphs:
                    if align is None and p.alignment is not None:
                        align = p.alignment
                    for r in p.runs:
                        if r.font.size:
                            sizes.append(_pt(r.font.size))
                        if not color:
                            c = _rgb(getattr(r.font, "color", None))
                            if c:
                                color = c
            except Exception:
                continue
    return sizes, align, color


def _pptx_runs_html(para, default_size: float, default_color: str = "") -> str:
    """一个段落 -> HTML 片段（保留粗体/斜体/下划线/字号/颜色）。"""
    pieces = []
    for run in para.runs:
        text = _esc(run.text)
        if not text:
            continue
        styles = []
        f = run.font
        try:
            if f.bold:
                styles.append("font-weight:bold")
        except Exception:
            pass
        try:
            if f.italic:
                styles.append("font-style:italic")
        except Exception:
            pass
        try:
            if f.underline:
                styles.append("text-decoration:underline")
        except Exception:
            pass
        size = None
        try:
            if f.size:
                size = _pt(f.size)
        except Exception:
            pass
        if size is None:
            try:
                if para.font.size:
                    size = _pt(para.font.size)
            except Exception:
                pass
        if size is None:
            size = default_size
        if size:
            styles.append("font-size:%.1fpt" % size)
        col = _rgb(getattr(f, "color", None)) or default_color
        if col:
            styles.append("color:%s" % col)
        if styles:
            pieces.append('<span style="%s">%s</span>' % (";".join(styles), text))
        else:
            pieces.append(text)
    return "".join(pieces)


def _pptx_text_html(tf, default_size: float, default_align=None, default_color: str = "") -> str:
    align_map = {1: "center", 2: "right", 3: "justify", 4: "justify"}
    parts = []
    for para in tf.paragraphs:
        body = _pptx_runs_html(para, default_size, default_color)
        if not body.strip():
            parts.append("<p>&nbsp;</p>")
            continue
        al = None
        try:
            if para.alignment is not None:
                al = align_map.get(int(para.alignment))
        except Exception:
            pass
        if al is None and default_align is not None:
            al = align_map.get(int(default_align))
        lvl = getattr(para, "level", 0) or 0
        decls = []
        if al:
            decls.append("text-align:%s" % al)
        if lvl:
            decls.append("margin-left:%dpt" % (lvl * 18))
        style = ' style="%s"' % ";".join(decls) if decls else ""
        parts.append("<p%s>%s</p>" % (style, body))
    return "".join(parts)


def _pptx_own_fill_line(shape):
    """形状**自己**是否显式定义了填充 / 线条（不看继承）。

    占位符的外观来自版式，直接读 shape.fill / shape.line 会拿到默认值，
    照它画就给无边框的文本框套上黑框。这里只认 spPr 里真实存在的节点。
    """
    ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    try:
        spPr = shape._element.spPr
    except Exception:
        return False, False
    if spPr is None:
        return False, False
    fill = spPr.find(ns + "solidFill") is not None or spPr.find(ns + "gradFill") is not None \
        or spPr.find(ns + "pattFill") is not None
    line = spPr.find(ns + "ln") is not None
    return fill, line


def _pptx_shape(page, shape, skipped: dict, slide=None, slide_h: float = 540.0):
    """把一个形状画到页面上。"""
    st = None
    try:
        st = shape.shape_type
    except Exception:
        pass

    # 图片
    try:
        if shape.shape_type == 13 or (hasattr(shape, "image") and shape.image is not None):
            img = shape.image
            rect = pymupdf.Rect(_pt(shape.left), _pt(shape.top),
                                _pt(shape.left) + _pt(shape.width),
                                _pt(shape.top) + _pt(shape.height))
            tmp = os.path.join(tempfile.gettempdir(), "pptx-img-%d.%s" % (abs(hash(img.blob)) % 10**9, img.ext))
            with open(tmp, "wb") as f:
                f.write(img.blob)
            rot = 0
            try:
                rot = float(getattr(shape, "rotation", 0) or 0)
            except Exception:
                pass
            page.insert_image(rect, filename=tmp, rotate=rot if rot else 0, keep_proportion=False)
            return
    except Exception:
        pass

    # 表格
    if getattr(shape, "has_table", False):
        try:
            rows_html = []
            for row in shape.table.rows:
                cells = []
                for cell in row.cells:
                    cells.append("<td>%s</td>" % _pptx_text_html(cell.text_frame, 0.028 * slide_h))
                rows_html.append("<tr>%s</tr>" % "".join(cells))
            rect = pymupdf.Rect(_pt(shape.left), _pt(shape.top),
                                _pt(shape.left) + _pt(shape.width),
                                _pt(shape.top) + _pt(shape.height))
            page.insert_htmlbox(rect, "<table>%s</table>" % "".join(rows_html),
                                css=_BASE_CSS, scale_low=0.4)
        except Exception:
            skipped["table"] = skipped.get("table", 0) + 1
        return

    # 组合：递归（坐标是绝对 EMU，直接沿用）
    if getattr(shape, "shapes", None) is not None and st != 13:
        try:
            for sub in shape.shapes:
                _pptx_shape(page, sub, skipped, slide, slide_h)
            return
        except Exception:
            pass

    # 文本框 / 占位符 / 自选图形
    #
    # 字号是**继承**来的：run.font.size 对标题/正文占位符常是 None，
    # 真正的值写在版式甚至母版里。这里先沿继承链找，找不到再按幻灯片高度给经验缺省
    # （标题约 8.5% 高、占位符正文约 4.8%、普通文本框约 3.5%）。
    # 不做这一步，渲染出来就是清一色的小字，和原稿差得很远。
    is_title = False
    try:
        from pptx.enum.shapes import PP_PLACEHOLDER
        ptype = shape.placeholder_format.type
        if ptype in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE) or shape.placeholder_format.idx == 0:
            is_title = True
    except Exception:
        pass

    sizes: list = []
    inh_align = None
    inh_color = ""
    if slide is not None:
        sizes, inh_align, inh_color = _pptx_inherited(shape, slide)
    if sizes:
        default_size = max(sizes)
    elif is_title:
        default_size = 0.085 * slide_h
    elif getattr(shape, "is_placeholder", False):
        default_size = 0.048 * slide_h
    else:
        default_size = 0.035 * slide_h

    if is_title and inh_align is None:
        # 标题默认居中——PowerPoint 的母版就是这样，只有在版式里也取不到时才兜底
        try:
            from pptx.enum.text import PP_ALIGN
            inh_align = PP_ALIGN.CENTER
        except Exception:
            inh_align = None

    txt = ""
    try:
        if shape.has_text_frame:
            txt = _pptx_text_html(shape.text_frame, default_size, inh_align, inh_color)
    except Exception:
        txt = ""

    rect = pymupdf.Rect(_pt(shape.left), _pt(shape.top),
                        _pt(shape.left) + _pt(shape.width),
                        _pt(shape.top) + _pt(shape.height))

    # 先画形状自身的填充与边框。
    #
    # **只看形状自己的 XML**：占位符的外观是从版式继承的，python-pptx 的
    # shape.line.width / shape.fill.fore_color 在没有显式设置时也会返回默认值，
    # 照着画就会给无边框的文本框套上一圈黑框——第一版就是这样，看起来像画错了。
    own_fill, own_line = _pptx_own_fill_line(shape)
    fill_col = _rgb(shape.fill.fore_color) if own_fill else ""
    line_col = _rgb(shape.line.color) if own_line else ""
    if fill_col or line_col or (st == 1 and (own_fill or own_line)):
        try:
            page.draw_rect(
                rect,
                color=pymupdf.utils.getColor(line_col) if line_col else None,
                fill=pymupdf.utils.getColor(fill_col) if fill_col else None,
                width=1,
            )
        except Exception:
            pass

    if txt.strip():
        # 垂直锚点：PowerPoint 的居中/靠下，靠"先量内容高度再摆位置"来近似
        anchor = None
        try:
            anchor = shape.text_frame.vertical_anchor
        except Exception:
            pass
        if anchor is None and is_title:
            anchor = 3  # 标题垂直居中（版式里没有显式设置时的兜底）
        box = rect
        if anchor in (3, 4):  # MIDDLE / BOTTOM（MSO_ANCHOR）
            try:
                story = pymupdf.Story(html=txt, user_css=_BASE_CSS)
                h = story.fit_height(rect.width)
                if h and h < rect.height:
                    if anchor == 3:
                        top = rect.y0 + (rect.height - h) / 2
                    else:
                        top = rect.y1 - h
                    box = pymupdf.Rect(rect.x0, top, rect.x1, top + h + 1)
            except Exception:
                pass
        try:
            page.insert_htmlbox(box, txt, css=_BASE_CSS, scale_low=0.4)
        except Exception:
            skipped["text"] = skipped.get("text", 0) + 1


def _pptx_to_pdf(src: str, out: str) -> dict:
    from pptx import Presentation

    prs = Presentation(src)
    W = _pt(prs.slide_width) or 960.0
    H = _pt(prs.slide_height) or 540.0

    doc = pymupdf.open()
    skipped: dict = {}
    n_slides = 0
    for slide in prs.slides:
        n_slides += 1
        page = doc.new_page(width=W, height=H)
        # 背景
        try:
            bg = slide.background.fill
            col = _rgb(bg.fore_color)
            if col:
                page.draw_rect(page.rect, color=None, fill=pymupdf.utils.getColor(col))
        except Exception:
            pass
        for shape in slide.shapes:
            try:
                _pptx_shape(page, shape, skipped, slide, H)
            except Exception:
                skipped["shape"] = skipped.get("shape", 0) + 1

    raw = out + ".raw"
    doc.save(raw, garbage=3, deflate=True)
    doc.close()
    _finish(raw, out)

    note = []
    if skipped:
        note.append("未能完整还原: " + "、".join(f"{k}×{v}" for k, v in skipped.items()))
    return {"pages": n_slides, "warnings": note}


# ---------------------------------------------------------------------------
# Word
# ---------------------------------------------------------------------------

def _docx_run_html(run) -> str:
    text = _esc(run.text)
    if not text:
        return ""
    styles = []
    if run.bold:
        styles.append("font-weight:bold")
    if run.italic:
        styles.append("font-style:italic")
    if run.underline:
        styles.append("text-decoration:underline")
    try:
        if run.font.size:
            styles.append("font-size:%.1fpt" % _len_pt(run.font.size))
    except Exception:
        pass
    try:
        col = _rgb(run.font.color)
        if col:
            styles.append("color:%s" % col)
    except Exception:
        pass
    if styles:
        return '<span style="%s">%s</span>' % (";".join(styles), text)
    return text


def _docx_para_html(para, style_name: str) -> str:
    body = "".join(_docx_run_html(r) for r in para.runs)
    if not body.strip():
        return "<p>&nbsp;</p>"
    tag = "p"
    name = (style_name or "").lower()
    if "heading 1" in name or "标题 1" in name:
        tag = "h1"
    elif "heading 2" in name or "标题 2" in name:
        tag = "h2"
    elif "heading 3" in name or "标题 3" in name:
        tag = "h3"
    al = None
    try:
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        amap = {WD_ALIGN_PARAGRAPH.CENTER: "center",
                WD_ALIGN_PARAGRAPH.RIGHT: "right",
                WD_ALIGN_PARAGRAPH.JUSTIFY: "justify"}
        al = amap.get(para.alignment)
    except Exception:
        al = None
    style = ' style="text-align:%s"' % al if al else ""
    return "<%s%s>%s</%s>" % (tag, style, body, tag)


def _docx_table_html(table) -> str:
    rows = []
    for row in table.rows:
        cells = []
        for cell in row.cells:
            inner = "".join(_docx_para_html(p, p.style.name if p.style is not None else "")
                            for p in cell.paragraphs)
            cells.append("<td>%s</td>" % (inner or "&nbsp;"))
        rows.append("<tr>%s</tr>" % "".join(cells))
    return "<table>%s</table>" % "".join(rows)


def _docx_to_pdf(src: str, out: str) -> dict:
    import docx
    from docx.document import Document as _Doc
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(src)
    tmpdir = tempfile.mkdtemp(prefix="pdfguru-docx-")
    parts = []
    n_img = 0

    # 图片先落盘，用 Archive 让 Story 能引用（比塞 base64 可靠）
    def save_image(rel_or_rId):
        nonlocal n_img
        try:
            part = document.part.related_parts[rel_or_rId]
            ext = os.path.splitext(part.partname)[1] or ".png"
            name = "img%d%s" % (n_img, ext)
            n_img += 1
            with open(os.path.join(tmpdir, name), "wb") as f:
                f.write(part.blob)
            return name
        except Exception:
            return None

    def walk(parent):
        """按文档顺序遍历段落与表格（python-docx 的 body 迭代器）。"""
        if isinstance(parent, _Doc):
            body = parent.element.body
        else:
            body = parent._element
        for child in body.iterchildren():
            if child.tag == qn("w:p"):
                para = Paragraph(child, parent)
                # 段内图片
                blips = child.findall(".//" + qn("a:blip"))
                if blips:
                    for blip in blips:
                        rid = blip.get(qn("r:embed"))
                        name = save_image(rid) if rid else None
                        if name:
                            parts.append('<p><img src="%s" style="max-width:100%%"></p>' % name)
                else:
                    parts.append(_docx_para_html(para, para.style.name if para.style is not None else ""))
            elif child.tag == qn("w:tbl"):
                parts.append(_docx_table_html(Table(child, parent)))

    walk(document)

    # 页面尺寸与页边距取第一节
    W, H = 595.0, 842.0
    ml = mr = mt = mb = 56.0
    try:
        sec = document.sections[0]
        if sec.page_width:
            W = _len_pt(sec.page_width)
        if sec.page_height:
            H = _len_pt(sec.page_height)
        ml = _len_pt(sec.left_margin) if sec.left_margin is not None else ml
        mr = _len_pt(sec.right_margin) if sec.right_margin is not None else mr
        mt = _len_pt(sec.top_margin) if sec.top_margin is not None else mt
        mb = _len_pt(sec.bottom_margin) if sec.bottom_margin is not None else mb
    except Exception:
        pass

    base_pt = 11.0
    try:
        normal = document.styles["Normal"]
        if normal.font.size:
            base_pt = _len_pt(normal.font.size)
    except Exception:
        pass

    css = _BASE_CSS + "\n* { font-size: %.1fpt; }\nbody { line-height: 1.35; }" % base_pt
    story = pymupdf.Story(html="".join(parts), user_css=css, archive=pymupdf.Archive(tmpdir))
    raw = out + ".raw"
    writer = pymupdf.DocumentWriter(raw)
    mediabox = pymupdf.Rect(0, 0, W, H)
    where = pymupdf.Rect(ml, mt, W - mr, H - mb)
    pages = 0
    more = 1
    while more and pages < 500:
        dev = writer.begin_page(mediabox)
        more, _filled = story.place(where)
        story.draw(dev)
        writer.end_page()
        pages += 1
    writer.close()
    _finish(raw, out)

    warnings = []
    if n_img == 0:
        warnings.append("文档内没有可提取的图片")
    return {"pages": pages, "warnings": warnings}


# ---------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------

def _xlsx_to_pdf(src: str, out: str) -> dict:
    import openpyxl
    from openpyxl.utils import get_column_letter

    wb = openpyxl.load_workbook(src, data_only=True)
    raw = out + ".raw"
    writer = pymupdf.DocumentWriter(raw)
    mediabox = pymupdf.paper_rect("a4-l")  # 表格横向更常见
    where = mediabox + (28, 28, -28, -28)
    total_pages = 0

    for ws in wb.worksheets:
        rows, cols = ws.max_row or 0, ws.max_column or 0
        if rows == 0 or cols == 0:
            continue
        # 列宽（Excel 的"字符数"→ 大致 pt）
        widths = []
        for c in range(1, cols + 1):
            letter = get_column_letter(c)
            dim = ws.column_dimensions.get(letter)
            w = (dim.width if dim is not None and dim.width else 8.43)
            widths.append(max(24.0, min(320.0, w * 5.2)))

        head = "".join('<col style="width:%.0fpt">' % w for w in widths)
        trs = []
        for r in range(1, rows + 1):
            tds = []
            for c in range(1, cols + 1):
                cell = ws.cell(row=r, column=c)
                v = cell.value
                if v is None:
                    v = ""
                text = _esc(v)
                styles = []
                try:
                    if cell.font and cell.font.bold:
                        styles.append("font-weight:bold")
                    col = _rgb(cell.font.color) if cell.font else ""
                    if col:
                        styles.append("color:%s" % col)
                    if cell.font and cell.font.size:
                        styles.append("font-size:%.1fpt" % float(cell.font.size))
                    if cell.alignment:
                        if cell.alignment.horizontal in ("center", "right"):
                            styles.append("text-align:%s" % cell.alignment.horizontal)
                        if cell.alignment.wrap_text:
                            styles.append("white-space:pre-wrap")
                except Exception:
                    pass
                st = ' style="%s"' % ";".join(styles) if styles else ""
                tds.append("<td%s>%s</td>" % (st, text))
            trs.append("<tr>%s</tr>" % "".join(tds))

        html = ('<h2 style="font-size:13pt">%s</h2>'
                '<table style="table-layout:fixed">%s%s</table>'
                % (_esc(ws.title), head, "".join(trs)))
        story = pymupdf.Story(html=html, user_css=_BASE_CSS + "\ntd { font-size:9pt; }")
        more = 1
        while more and total_pages < 500:
            dev = writer.begin_page(mediabox)
            more, _filled = story.place(where)
            story.draw(dev)
            writer.end_page()
            total_pages += 1

    writer.close()
    _finish(raw, out)
    return {"pages": total_pages, "warnings": []}


# ---------------------------------------------------------------------------

_RENDERERS = {
    "word": (_docx_to_pdf, {".docx", ".docm"}),
    "ppt": (_pptx_to_pdf, {".pptx", ".pptm"}),
    "excel": (_xlsx_to_pdf, {".xlsx", ".xlsm"}),
}


def builtin_office_to_pdf(src: str, out: str, kind: str = "") -> dict:
    """用内置渲染器把 Office 文档转成 PDF。

    kind 为空时按扩展名推断。**只支持 OOXML（docx/pptx/xlsx）**：
    老的二进制格式（.doc/.ppt/.xls）是复合文档，没有纯 Python 的解析方案，
    这种情况必须靠本机 Office，会抛出明确的错误。
    """
    ext = os.path.splitext(src)[1].lower()
    if not kind:
        for k, (_fn, exts) in _RENDERERS.items():
            if ext in exts:
                kind = k
                break
    if kind not in _RENDERERS:
        raise ValueError(
            f"{ext or '该格式'} 需要本机安装 Office 才能转换"
            "（内置渲染器只支持 docx / pptx / xlsx 这些新格式）"
        )
    fn, exts = _RENDERERS[kind]
    if ext not in exts:
        raise ValueError(
            f"{ext} 需要本机安装 Office 才能转换（内置渲染器只支持 {'、'.join(sorted(exts))}）"
        )
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    return fn(src, out)
