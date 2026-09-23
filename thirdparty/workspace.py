"""工作区（PPT 式页面编辑器）所需的底层原语。

与 pdf.py 里"一个命令办一件事、立刻写文件"的风格不同，这里只提供工作区需要的
两个原语：

    ws-info    读取文档结构（页数 / 每页尺寸 / 旋转角），供前端建立页面模型
    ws-render  批量渲染页面为 PNG 缩略图，并输出一份清单

两个设计约束，都是被性能逼出来的：

1. **必须批量**。每次调用都要冷启动一个 PyInstaller 冻结进程（数百毫秒），
   逐页调用在几百页的文档上会直接卡死，所以一次渲染一批。
2. **产物路径可预测**。缩略图文件名固定为 ``p{页码}@w{宽度}.png``（页码 1-based），
   Go 侧据此拼出 URL，前端只拿到 /ws/ 开头的相对地址，永远拿不到真实文件路径。
   清单文件则把实际像素尺寸告诉前端，避免图片加载时才撑开布局造成抖动。
"""

import json
import os
import shutil
import tempfile
import traceback
from pathlib import Path

import fitz
import utils
from constants import cmd_output_path
from header_and_footer import create_header_and_footer_mask
from loguru import logger
from watermark import create_text_wartmark

# 缩略图清单文件名模板。Go 侧会读取它来拼 URL。
# 按宽度分文件，避免"缩略图轨道"与"大图预览"并发渲染时互相覆盖清单。
MANIFEST_TEMPLATE = "_manifest_w{width}.json"


def _explain_open_error(path: str, exc: Exception) -> str:
    """把 PyMuPDF 的底层异常翻译成用户看得懂的一句话。

    它的原始信息是英文堆栈（"document closed or encrypted"、"no objects found"），
    直接显示在界面上等于没提示——用户既不知道发生了什么，也不知道该怎么办。
    """
    msg = str(exc).lower()
    if "encrypted" in msg or "password" in msg or "needs_pass" in msg:
        return "这个 PDF 有密码，需要先解密（工具箱 → 保护 → 去除密码）"
    # "failed to open file ... as type pdf"（FileDataError）、"no objects found"（FzErrorFormat）
    # 都表示文件本身不是有效的 PDF，而不是路径或权限问题
    if any(k in msg for k in ("no objects", "cannot open", "failed to open", "format", "corrupt", "damaged")):
        return f"无法打开 {Path(path).name}：文件已损坏，或者它并不是 PDF"
    return f"无法打开 {Path(path).name}"


def _open_document(path: str) -> fitz.Document:
    """打开文档，失败时抛出**用户看得懂**的 ValueError。

    注意：有密码的文档 fitz.open() 本身会成功，要等真正读页时才炸，
    所以这里额外检查 needs_pass，否则错误会晚一步、出现在毫不相干的代码位置上。
    """
    try:
        doc = fitz.open(path)
    except Exception as e:
        raise ValueError(_explain_open_error(path, e)) from e
    if getattr(doc, "needs_pass", False):
        doc.close()
        raise ValueError("这个 PDF 有密码，需要先解密（工具箱 → 保护 → 去除密码）")
    if doc.page_count <= 0:
        doc.close()
        raise ValueError(f"{Path(path).name} 里没有任何页面")
    return doc


def _fail(exc: Exception):
    """把失败写进状态文件。

    已知的用户级错误（ValueError）只回一句话；意料之外的异常记完整堆栈到日志，
    但只把简短信息交给界面——界面需要的是"能转述给人听"的内容。
    """
    if isinstance(exc, ValueError):
        msg = str(exc)
    else:
        logger.error(traceback.format_exc())
        msg = f"{type(exc).__name__}: {exc}"
    utils.dump_json(cmd_output_path, {"status": "error", "message": msg})


def workspace_info(doc_path: str, output_path: str):
    """导出文档结构到 output_path（JSON）。"""
    try:
        doc = _open_document(doc_path)
        pages = []
        for i in range(doc.page_count):
            page = doc[i]
            pages.append({
                "index": i,
                "width": round(page.rect.width, 2),
                "height": round(page.rect.height, 2),
                "rotation": page.rotation,
            })
        utils.dump_json(output_path, {
            "pageCount": doc.page_count,
            "pages": pages,
        })
        doc.close()
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except Exception as e:
        _fail(e)


def workspace_render(doc_path: str, pages: str, width: int, output_dir: str, manifest_path: str = None):
    """把指定页渲染成 PNG 缩略图，并写出清单。

    manifest_path 由调用方指定时写到那里。**每个请求必须用独立清单**：
    如果并发请求共用一个清单文件，后写的会覆盖先写的，调用方就会读到别的请求
    的页码与文件名，表现为"请求第 2 页却显示第 3 页"（实测踩到过）。
    """
    try:
        doc = _open_document(doc_path)
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        indices = utils.parse_range(pages, doc.page_count)

        manifest = []
        for i in indices:
            page = doc[i]
            # 按宽度等比缩放；宽度为 0 的异常页跳过
            if page.rect.width <= 0:
                continue
            zoom = float(width) / page.rect.width
            stem = f"p{i+1}@w{width}"
            name = f"{stem}.png"
            target = out / name
            pw = max(1, int(page.rect.width * zoom + 0.5))
            ph = max(1, int(page.rect.height * zoom + 0.5))

            # 已经渲染过就直接复用。两个原因：
            #   1. 同一页同一宽度内容恒定，重渲染纯属浪费；
            #   2. 关键 —— Windows 上 webview 正读取该 png 时会持有文件句柄，
            #      PyMuPDF 的 save() 会先删除旧文件，于是报 "Permission denied"。
            #      实测并发聚焦同一页时必然踩到，这里从根上避免覆盖。
            if not target.exists():
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
                # 先写进程唯一的临时文件再原子改名：既不会留下半张图，
                # 也让并发的两次渲染各写各的，不会互相踩。
                # 注意临时名必须以 .png 结尾 —— PyMuPDF 是按扩展名推断图片格式的。
                tmp = out / f"{stem}.{os.getpid()}.part.png"
                pix.save(str(tmp))
                pw, ph = pix.width, pix.height
                pix = None
                try:
                    os.replace(str(tmp), str(target))
                except OSError:
                    # 目标是在这一步之前刚被别的进程写好的，沿用即可
                    if not target.exists():
                        raise
                    try:
                        os.remove(str(tmp))
                    except OSError:
                        pass

            manifest.append({
                "index": i,
                "file": name,
                "width": pw,
                "height": ph,
            })

        mpath = Path(manifest_path) if manifest_path else (out / MANIFEST_TEMPLATE.format(width=width))
        mpath.parent.mkdir(parents=True, exist_ok=True)
        utils.dump_json(str(mpath), {"width": width, "pages": manifest})
        doc.close()
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except Exception as e:
        _fail(e)


def workspace_convert(input_path: str, output_path: str):
    """把任意 PyMuPDF 能打开的文件转成 PDF —— 拖入非 PDF 文件时走这里。

    支持的输入：XPS / EPUB / MOBI / FB2 / CBZ / SVG，以及常见图片
    （PNG / JPEG / BMP / GIF / TIFF / WebP …）。
    **docx / xlsx / pptx 这类 Office 格式 PyMuPDF 打不开**，这里会如实报错，
    而不是产出一个坏文件——上层据此给出明确提示。
    """
    try:
        doc = _open_document(input_path)
        pdf = fitz.open("pdf", doc.convert_to_pdf())
        # 尽量保留目录，阅读体验会好很多
        try:
            toc = doc.get_toc()
            if toc:
                pdf.set_toc(toc)
        except Exception:
            pass
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        pdf.save(output_path, garbage=4, deflate=True)
        pdf.close()
        doc.close()
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except Exception as e:
        _fail(e)


def workspace_merge_images(input_paths: list, output_path: str):
    """把若干图片合并成一个多页 PDF（每张一页，按给定顺序）。

    与 workspace_convert 的区别：这个是"多图合成一份文档"。
    图片顺序按调用方给的顺序，不重排——用户拖进来的次序就是他要的次序。
    """
    try:
        writer: fitz.Document = fitz.open()
        for p in input_paths:
            img = _open_document(p)
            pdf = fitz.open("pdf", img.convert_to_pdf())
            writer.insert_pdf(pdf)
            pdf.close()
            img.close()
        if writer.page_count == 0:
            raise ValueError("没有可用的图片")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        writer.save(output_path, garbage=4, deflate=True)
        writer.close()
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except Exception as e:
        _fail(e)


def _overlay_via_mask(width, height, content_list, tmpdir, tag,
                      font_family=None, font_size=10, font_color="#000000",
                      opacity=1, unit="cm", margin_bbox=None):
    """生成一页透明的覆盖层 PDF，返回其路径。

    页眉页脚与页码都这么做：先用 reportlab 画一张单页 PDF，再 show_pdf_page 叠上去。
    比逐字算坐标省事得多，也与上游既有实现保持一致。
    """
    path = os.path.join(tmpdir, f"ov-{tag}.pdf")
    create_header_and_footer_mask(
        width=width, height=height, content_list=content_list,
        margin_bbox=margin_bbox, font_family=font_family, font_size=font_size,
        font_color=font_color, opacity=opacity, unit=unit, output_path=path)
    return path


def _apply_decor(writer, options, tmpdir):
    """应用装饰类选项：水印、页码、页眉页脚。

    这些**必须**放在导出阶段，而不是编辑时：页码要写"第 X 页 / 共 N 页"，
    而 N 只有把清单全部拼完之后才存在。
    scope 是导出文档里的 0-based 位置，由前端根据当前选区算好传进来，
    这里不做任何选区判断，保持职责单一。
    """
    total = writer.page_count
    if total == 0:
        return

    def targets(scope):
        # 区分两种情况：没给 scope = 全部页；给了空数组 = 哪一页都不加。
        # 若把空数组也当成"全部"，用户在没选中任何页时会被静默地给整份文档加上水印。
        if scope is None:
            return list(range(total))
        return [i for i in scope if 0 <= i < total]

    # --- 水印（各页相同，按纸张尺寸缓存覆盖层）---
    wm = options.get("watermark")
    if wm and (wm.get("text") or "").strip():
        rgb = tuple(v / 255.0 for v in utils.hex_to_rgb(wm.get("color") or "#000000"))
        cache = {}
        for i in targets(wm.get("scope")):
            page = writer[i]
            w, h = page.rect.width, page.rect.height
            key = (round(w, 1), round(h, 1))
            if key not in cache:
                path = os.path.join(tmpdir, f"wm-{key[0]}x{key[1]}.pdf")
                create_text_wartmark(
                    wm_text=wm.get("text"), width=w, height=h, output_path=path,
                    font=wm.get("font") or "msyh.ttc",
                    fontsize=float(wm.get("fontSize", 40)),
                    angle=float(wm.get("angle", 30)),
                    text_stroke_color_rgb=(0, 0, 0),
                    text_fill_color_rgb=rgb,
                    text_fill_alpha=float(wm.get("opacity", 0.3)),
                    num_lines=int(wm.get("numLines", 1)),
                    line_spacing=float(wm.get("lineSpacing", 1)),
                    word_spacing=float(wm.get("wordSpacing", 1)),
                    x_offset=float(wm.get("xOffset", 0)),
                    y_offset=float(wm.get("yOffset", 0)),
                    multiple_mode=bool(wm.get("multiple", True)),
                )
                cache[key] = path
            ov = fitz.open(cache[key])
            page.show_pdf_page(page.rect, ov, 0, overlay=True)
            page.clean_contents()
            ov.close()

    # --- 页眉页脚（各页内容相同，按纸张尺寸缓存）---
    hf = options.get("headerFooter")
    if hf:
        content = [
            hf.get("headerLeft") or "", hf.get("headerCenter") or "", hf.get("headerRight") or "",
            hf.get("footerLeft") or "", hf.get("footerCenter") or "", hf.get("footerRight") or "",
        ]
        if any(c.strip() for c in content):
            cache = {}
            for i in targets(hf.get("scope")):
                page = writer[i]
                w, h = page.rect.width, page.rect.height
                key = (round(w, 1), round(h, 1))
                if key not in cache:
                    cache[key] = _overlay_via_mask(
                        w, h, content, tmpdir, f"hf-{key[0]}x{key[1]}",
                        font_family=hf.get("fontFamily"), font_size=float(hf.get("fontSize", 10)),
                        font_color=hf.get("fontColor") or "#000000",
                        opacity=float(hf.get("opacity", 1)))
                ov = fitz.open(cache[key])
                page.show_pdf_page(page.rect, ov, 0, overlay=True)
                page.clean_contents()
                ov.close()

    # --- 页码（每页内容都不同，只能逐页生成）---
    pn = options.get("pageNumber")
    if pn:
        fmt = pn.get("format") or "第%p页"
        pos = pn.get("pos") or "footer"
        align = pn.get("align") or "right"
        start = int(pn.get("start", 0))
        slot = ({"left": 0, "center": 1, "right": 2} if pos == "header"
                else {"left": 3, "center": 4, "right": 5})
        targets_list = targets(pn.get("scope"))
        for i in targets_list:
            page = writer[i]
            # 页码标识的是"这一页在文档中的位置"，而不是"被编号的第几个"：
            # 只给第 2..5 页加页码时，它们应该读作 2,3,4,5 而不是 1,2,3,4。
            # start 用来整体偏移（例如封面不编号时把正文从 1 开始）。
            pno = start + i + 1
            text = fmt.replace("%p", str(pno)).replace("%P", str(total))
            content = [""] * 6
            content[slot.get(align, 5)] = text
            path = _overlay_via_mask(
                page.rect.width, page.rect.height, content, tmpdir, f"pn-{i}",
                font_family=pn.get("fontFamily"), font_size=float(pn.get("fontSize", 10)),
                font_color=pn.get("fontColor") or "#000000",
                opacity=float(pn.get("opacity", 1)))
            ov = fitz.open(path)
            page.show_pdf_page(page.rect, ov, 0, overlay=True)
            page.clean_contents()
            ov.close()


def workspace_build(plan_path: str, output_path: str, compress: bool = False):
    """按清单合成 PDF —— 工作区所有编辑真正落盘的地方。

    清单由 Go 侧生成，其中：页码已经是 0-based 下标、docId 已经解析成真实文件路径。
    Python 这边因此不需要理解工作区的任何概念，只负责按顺序拼页。

    两个容易出事的地方，这里都特意处理了：
    1. **源文件可能就是要覆盖的目标**。所有源句柄必须在 os.replace 之前关掉，
       否则 Windows 上会因文件占用而失败。因此先写临时文件、关句柄、再原子改名。
    2. 失败时清掉半成品，避免留下一个"看起来能用"的坏 PDF。
    """
    tmp = f"{output_path}.building"
    try:
        with open(plan_path, "r", encoding="utf-8") as f:
            plan = json.load(f)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        writer: fitz.Document = fitz.open()
        handles = {}
        try:
            for item in plan.get("pages", []):
                blank = item.get("blank")
                if blank:
                    paper = blank.get("paper") or "A4"
                    orientation = blank.get("orientation") or "portrait"
                    # 与"插入空白页"功能保持同一套纸张定义
                    try:
                        fmt = (fitz.paper_rect(f"{paper}-l")
                               if orientation == "landscape" else fitz.paper_rect(paper))
                    except Exception:
                        fmt = fitz.paper_rect("A4")
                    writer.new_page(width=fmt.width, height=fmt.height)
                    continue

                path = item.get("path")
                if not path:
                    continue
                if path not in handles:
                    handles[path] = fitz.open(path)
                src = handles[path]
                idx = int(item.get("index", 0))
                if idx < 0 or idx >= src.page_count:
                    continue
                writer.insert_pdf(src, from_page=idx, to_page=idx)
                newpage = writer[-1]

                # 非破坏式的裁剪 / 遮盖在这里才落到 PDF。
                # 坐标是归一化比例，且定义在页面【未旋转】的那一面：
                # 尺寸必须取 mediabox —— page.rect 是旋转后的视图尺寸，
                # 用它换算会让旋转过的页面上裁剪框跑到别处。
                ops = item.get("ops") or {}
                if ops.get("removeAnnots"):
                    # 先物化成列表再逐条删：边遍历生成器边删除并不可靠
                    for an in list(newpage.annots() or []):
                        newpage.delete_annot(an)

                crop = ops.get("crop")
                masks = ops.get("masks") or []
                if crop or masks:
                    mb = newpage.mediabox
                    W, H = mb.width, mb.height

                    def to_rect(r):
                        nx = float(r.get("x", 0.0))
                        ny = float(r.get("y", 0.0))
                        nw = float(r.get("w", 0.0))
                        nh = float(r.get("h", 0.0))
                        x0 = mb.x0 + nx * W
                        x1 = mb.x0 + (nx + nw) * W
                        # 归一化的 y 原点在【上】，PDF 坐标原点在【下】，需要翻转
                        y1 = mb.y1 - ny * H
                        y0 = mb.y1 - (ny + nh) * H
                        return fitz.Rect(x0, y0, x1, y1)

                    for m in masks:
                        rect = m.get("rect") or {}
                        if not rect:
                            continue
                        rgb = tuple(v / 255.0 for v in utils.hex_to_rgb(m.get("color") or "#FFFF00"))
                        opacity = max(0.0, min(1.0, float(m.get("opacity", 0.5))))
                        newpage.draw_rect(to_rect(rect), color=None, fill=rgb,
                                          fill_opacity=opacity, overlay=True)

                    if crop:
                        # 裁剪后"页面"就是这块区域（与 Acrobat 的裁剪一致）
                        newpage.set_cropbox(to_rect(crop))

                rot = int(item.get("rotation", 0)) % 360
                if rot:
                    newpage.set_rotation(rot)

            if writer.page_count == 0:
                raise ValueError("清单里没有任何页面，已取消导出")

            # 装饰类选项只能在这里做：页码要写"共 N 页"，N 到这一刻才确定
            options = plan.get("options") or {}
            if options:
                tmpdir = tempfile.mkdtemp(prefix="pdfguru-ws-")
                try:
                    _apply_decor(writer, options, tmpdir)
                finally:
                    shutil.rmtree(tmpdir, ignore_errors=True)

            writer.save(tmp, garbage=4 if compress else 3, deflate=True, clean=bool(compress))
        finally:
            writer.close()
            for d in handles.values():
                try:
                    d.close()
                except Exception:
                    pass

        os.replace(tmp, output_path)
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        _fail(e)
