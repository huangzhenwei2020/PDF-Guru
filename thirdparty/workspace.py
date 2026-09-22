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
import traceback
from pathlib import Path

import fitz
import utils
from constants import cmd_output_path
from loguru import logger

# 缩略图清单文件名模板。Go 侧会读取它来拼 URL。
# 按宽度分文件，避免"缩略图轨道"与"大图预览"并发渲染时互相覆盖清单。
MANIFEST_TEMPLATE = "_manifest_w{width}.json"


def workspace_info(doc_path: str, output_path: str):
    """导出文档结构到 output_path（JSON）。"""
    try:
        doc: fitz.Document = fitz.open(doc_path)
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
    except:
        logger.error(traceback.format_exc())
        utils.dump_json(cmd_output_path, {"status": "error", "message": traceback.format_exc()})


def workspace_render(doc_path: str, pages: str, width: int, output_dir: str, manifest_path: str = None):
    """把指定页渲染成 PNG 缩略图，并写出清单。

    manifest_path 由调用方指定时写到那里。**每个请求必须用独立清单**：
    如果并发请求共用一个清单文件，后写的会覆盖先写的，调用方就会读到别的请求
    的页码与文件名，表现为"请求第 2 页却显示第 3 页"（实测踩到过）。
    """
    try:
        doc: fitz.Document = fitz.open(doc_path)
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
    except:
        logger.error(traceback.format_exc())
        utils.dump_json(cmd_output_path, {"status": "error", "message": traceback.format_exc()})


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
                rot = int(item.get("rotation", 0)) % 360
                if rot:
                    writer[-1].set_rotation(rot)

            if writer.page_count == 0:
                raise ValueError("清单里没有任何页面，已取消导出")

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
    except:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        logger.error(traceback.format_exc())
        utils.dump_json(cmd_output_path, {"status": "error", "message": traceback.format_exc()})
