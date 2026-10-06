"""PaddleOCR 3.x local worker. JSON lines, one CPU model per app session."""
import json
import os
import shutil
import sys
import time
from pathlib import Path

PROTOCOL = sys.stdout
sys.stdin.reconfigure(encoding="utf-8")
PROTOCOL.reconfigure(encoding="utf-8")
sys.stdout = sys.stderr  # Paddle/PaddleX logs must never enter the protocol.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
def model_cache():
    configured = os.environ.get("PADDLE_PDX_CACHE_HOME")
    candidates = [configured] if configured else []
    candidates += [str(Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "PDFGuru" / "ocr-models"),
                   str(Path(os.environ.get("PUBLIC", "C:/Users/Public")) / "PDFGuru" / "ocr-models")]
    # Paddle's C++ Windows loader does not accept Unicode model paths.
    for value in candidates:
        if value.isascii():
            target = Path(value)
            target.mkdir(parents=True, exist_ok=True)
            bundled = Path(__file__).parent / "ocr-models" / "official_models"
            if bundled.exists():
                for folder in bundled.iterdir():
                    dest = target / "official_models" / folder.name
                    if folder.is_dir() and not (dest / "inference.pdiparams").exists():
                        shutil.copytree(folder, dest, dirs_exist_ok=True)
            return str(target)
    raise RuntimeError("请设置 PADDLE_PDX_CACHE_HOME 为不含中文的模型缓存目录")

os.environ["PADDLE_PDX_CACHE_HOME"] = model_cache()
ENGINE = None


def engine():
    global ENGINE
    if ENGINE is None:
        from paddleocr import PaddleOCR
        ENGINE = PaddleOCR(text_detection_model_name="PP-OCRv5_mobile_det",
                           text_recognition_model_name="PP-OCRv5_mobile_rec",
                           use_doc_orientation_classify=False, use_doc_unwarping=False,
                           use_textline_orientation=False, device="cpu",
                           cpu_threads=min(4, os.cpu_count() or 2), enable_mkldnn=True,
                           text_recognition_batch_size=8,
                           text_det_limit_side_len=1280, text_det_limit_type="max")
    return ENGINE


def unrotate(r, angle):
    x, y, w, h = r
    if angle == 90:
        return dict(x=y, y=1-x-w, w=h, h=w)
    if angle == 180:
        return dict(x=1-x-w, y=1-y-h, w=w, h=h)
    if angle == 270:
        return dict(x=1-y-h, y=x, w=h, h=w)
    return dict(x=x, y=y, w=w, h=h)


def recognise(request):
    import numpy as np
    from PIL import Image
    started = time.perf_counter()
    image = np.array(Image.open(request["image"]).convert("RGB"))
    extra = int(request.get("extraRotation", 0)) % 360
    if extra:
        image = np.rot90(image, -extra//90).copy()
    height, width = image.shape[:2]
    # PaddleOCR expects BGR, matching its OpenCV path loader.
    results = engine().predict(image[:, :, ::-1].copy())
    runs = []
    angle = int(request.get("rotation", 0)) % 360
    visible_height = request["width"] if angle % 180 else request["height"]
    for result in results:
        data = result.json
        if isinstance(data, str):
            data = json.loads(data)
        data = data.get("res", data)
        for text, score, box in zip(data["rec_texts"], data["rec_scores"], data["rec_boxes"]):
            if not text.strip():
                continue
            x0, y0, x1, y1 = [float(v) for v in box]
            x0, x1 = max(0, x0), min(width, x1)
            y0, y1 = max(0, y0), min(height, y1)
            rect = unrotate((x0/width, y0/height, (x1-x0)/width, (y1-y0)/height), angle)
            runs.append(dict(id=f"ocr-{len(runs)}", text=text, rect=rect,
                             fontSize=max(4, min(144, (y1-y0) / height * visible_height * .75)),
                             font="auto", color="#000000", angle=angle,
                             source="ocr", confidence=float(score)))
    return dict(width=request["width"], height=request["height"], runs=runs,
                seconds=round(time.perf_counter()-started, 3), model="PP-OCRv5 mobile")


def serve():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = {"ok": True, "data": recognise(request)}
        except Exception as exc:
            import traceback
            traceback.print_exc(file=sys.stderr)
            result = {"ok": False, "error": str(exc)}
        PROTOCOL.write(json.dumps(result, ensure_ascii=False) + "\n")
        PROTOCOL.flush()


if __name__ == "__main__":
    serve()
