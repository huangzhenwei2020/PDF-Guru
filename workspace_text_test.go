package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// Optional integration check against the packaged backend and real OCR models.
// PDFGURU_OCR_FIXTURE points to the benchmark_ocr.py output folder.
func TestWorkspaceTextLive(t *testing.T) {
	fixture := os.Getenv("PDFGURU_OCR_FIXTURE")
	if fixture == "" {
		t.Skip("set PDFGURU_OCR_FIXTURE to run real-model integration")
	}
	repo, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	log = logrus.New()
	logger = log.WithField("test", "text-ocr")
	logdir = filepath.Join(os.Getenv("USERPROFILE"), ".pdf_guru")
	if err := app.SaveConfig(filepath.Join(repo, "build", "bin", "pdf.exe"), "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	worker, err := os.ReadFile(filepath.Join(repo, "thirdparty", "ocr_worker.py"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(exe), "ocr_worker.py"), worker, 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PDFGURU_OCR_PYTHON", filepath.Join(repo, "build", "bin", "ocr-runtime", "python.exe"))
	defer func() { wsOCR.Lock(); wsOCR.stop(); wsOCR.Unlock() }()
	native, err := app.registerDoc(filepath.Join(fixture, "native.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	runs, err := app.WorkspaceTextRuns(native.DocID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(runs, "中文文字识别测试") {
		t.Fatal("native extraction lost Chinese text")
	}
	var extracted struct {
		Runs []map[string]any `json:"runs"`
	}
	if err := json.Unmarshal([]byte(runs), &extracted); err != nil {
		t.Fatal(err)
	}
	edit := extracted.Runs[0]
	edit["originalRect"] = edit["rect"]
	edit["rect"] = map[string]float64{"x": .08, "y": .08, "w": .8, "h": .1}
	edit["text"], edit["font"] = "已经修改 PDF 文字", "auto"
	edits, _ := json.Marshal([]any{edit})
	preview, err := app.WorkspaceTextPreview(native.DocID, 0, string(edits), 1200)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Width != 1200 || !strings.HasPrefix(preview.URL, wsURLPrefix) {
		t.Fatal(preview)
	}
	var fitted []map[string]any
	if err := json.Unmarshal([]byte(preview.EditsJSON), &fitted); err != nil || len(fitted) != 1 {
		t.Fatalf("preview did not return fitted geometry: %s (%v)", preview.EditsJSON, err)
	}
	box := fitted[0]["rect"].(map[string]any)
	if box["w"].(float64) >= .8 || box["w"].(float64) <= 0 {
		t.Fatal("text rectangle was not fitted to the replacement", box)
	}
	edit = fitted[0]
	payload, _ := json.Marshal(map[string]any{"items": []any{map[string]any{"kind": "page", "docId": native.DocID, "pageIndex": 0, "ops": map[string]any{"textEdits": []any{edit}}}}})
	output := filepath.Join(t.TempDir(), "edited.pdf")
	if _, err := app.WorkspaceExport(string(payload), output, "pdf", 150, false, false); err != nil {
		t.Fatal(err)
	}
	scan, err := app.registerDoc(filepath.Join(fixture, "scan.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := app.WorkspaceOCR(scan.DocID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "中文") || !strings.Contains(result, "Invoice") {
		t.Fatal(result)
	}
	start := time.Now()
	cached, err := app.WorkspaceOCR(scan.DocID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if cached != result {
		t.Fatal("OCR page cache changed")
	}
	t.Logf("cached OCR: %v", time.Since(start))
}
