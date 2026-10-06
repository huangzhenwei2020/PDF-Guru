"""Opt-in real-model smoke test; does not run during unit-test discovery."""
import argparse
import json
import subprocess
import time
from pathlib import Path

import fitz
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.output); root.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(); page = doc.new_page()
    page.insert_text((50, 100), "PDF Guru OCR performance test", fontsize=20)
    page.insert_text((50, 160), "中文文字识别测试", fontname="china-s", fontsize=24)
    page.insert_text((50, 210), "Invoice number 20261006", fontsize=18)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    image = root / "ocr-fixture.png"; pix.save(image)
    scan = fitz.open(); sp = scan.new_page(width=page.rect.width,height=page.rect.height)
    sp.insert_image(sp.rect,pixmap=pix); scan.save(root / "scan.pdf"); scan.close()
    doc.save(root / "native.pdf"); doc.close()
    request = dict(image=str(image.resolve()), width=595, height=842, rotation=0)
    with (root / "worker.log").open("w", encoding="utf-8") as log:
        proc = subprocess.Popen([args.python, "-u", args.worker], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8")
        results = []
        try:
            sideways = root / "ocr-sideways.png"
            Image.open(image).transpose(Image.Transpose.ROTATE_90).save(sideways)
            rotated = dict(image=str(sideways.resolve()), width=842, height=595, rotation=90, extraRotation=90)
            for label, request in (("cold", request), ("warm", request), ("rotated", rotated)):
                start = time.perf_counter()
                proc.stdin.write(json.dumps(request, ensure_ascii=False)+"\n"); proc.stdin.flush()
                result = json.loads(proc.stdout.readline())
                elapsed = time.perf_counter()-start
                print(label, round(elapsed,3), result, flush=True)
                if not result["ok"]:
                    raise AssertionError(result["error"])
                text = "\n".join(r["text"] for r in result["data"]["runs"])
                assert "中文" in text and "Invoice" in text, text
                results.append(dict(label=label, elapsed=elapsed, result=result["data"]))
        finally:
            proc.terminate(); proc.wait()
    (root / "benchmark.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
