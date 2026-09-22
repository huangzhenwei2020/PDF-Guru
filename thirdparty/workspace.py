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


def workspace_render(doc_path: str, pages: str, width: int, output_dir: str):
    """把指定页渲染成 PNG 缩略图，并在 output_dir 写下清单。"""
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
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            name = f"p{i+1}@w{width}.png"
            pix.save(str(out / name))
            manifest.append({
                "index": i,
                "file": name,
                "width": pix.width,
                "height": pix.height,
            })
            pix = None

        utils.dump_json(str(out / MANIFEST_TEMPLATE.format(width=width)), {"width": width, "pages": manifest})
        doc.close()
        utils.dump_json(cmd_output_path, {"status": "success", "message": ""})
    except:
        logger.error(traceback.format_exc())
        utils.dump_json(cmd_output_path, {"status": "error", "message": traceback.format_exc()})
