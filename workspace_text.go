package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// JSON is returned directly: the frontend model includes confidence and geometry.
func (a *App) WorkspaceTextRuns(docID string, pageIndex int) (string, error) {
	info, err := a.wsSourceFor(docID, pageIndex)
	if err != nil {
		return "", err
	}
	out := filepath.Join(wsCacheRoot, "text-runs", fmt.Sprintf("%s-%d.json", docID, pageIndex))
	if data, err := os.ReadFile(out); err == nil {
		return string(data), nil
	}
	if err := a.cmdRunner([]string{"ws-text-runs", info.Path, "--page-index", fmt.Sprint(pageIndex), "--output", out}, "pdf"); err != nil {
		return "", err
	}
	data, err := os.ReadFile(out)
	return string(data), err
}

type WSTextPreview struct {
	WSThumb
	EditsJSON string `json:"editsJSON"`
}

func (a *App) WorkspaceTextPreview(docID string, pageIndex int, editsJSON string, width int) (WSTextPreview, error) {
	info, err := a.wsSourceFor(docID, pageIndex)
	if err != nil {
		return WSTextPreview{}, err
	}
	var edits []json.RawMessage
	if err := json.Unmarshal([]byte(editsJSON), &edits); err != nil {
		return WSTextPreview{}, fmt.Errorf("文字修改数据无效: %w", err)
	}
	if width < 150 {
		width = 150
	}
	if width > 4096 {
		width = 4096
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("autofit-v1:"+editsJSON)))
	dir := filepath.Join(wsCacheRoot, "text-preview", docID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return WSTextPreview{}, err
	}
	stem := fmt.Sprintf("p%d-%s-w%d", pageIndex, hash, width)
	out := filepath.Join(dir, stem+".png")
	_, imageErr := os.Stat(out)
	_, layoutErr := os.Stat(out + ".layout.json")
	if os.IsNotExist(imageErr) || os.IsNotExist(layoutErr) {
		plan := filepath.Join(dir, stem+".json")
		if err := os.WriteFile(plan, []byte(editsJSON), 0644); err != nil {
			return WSTextPreview{}, err
		}
		if err := a.cmdRunner([]string{"ws-text-runs", info.Path, "--page-index", fmt.Sprint(pageIndex), "--edits", plan, "--width", fmt.Sprint(width), "--output", out}, "pdf"); err != nil {
			return WSTextPreview{}, err
		}
	}
	if _, err := os.Stat(out); err != nil {
		return WSTextPreview{}, fmt.Errorf("文字预览生成失败，请重试: %w", err)
	}
	layout, err := os.ReadFile(out + ".layout.json")
	if err != nil {
		return WSTextPreview{}, err
	}
	p := info.Pages[pageIndex]
	return WSTextPreview{WSThumb: WSThumb{PageIndex: pageIndex, URL: wsURLPrefix + "text-preview/" + docID + "/" + stem + ".png", Width: width, Height: int(float64(width)*p.Height/p.Width + .5)}, EditsJSON: string(layout)}, nil
}

type wsOCRProcess struct {
	sync.Mutex
	cmd    *exec.Cmd
	input  io.WriteCloser
	output *bufio.Reader
}

var wsOCR wsOCRProcess

func (p *wsOCRProcess) stop() {
	if p.cmd != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
	}
	p.cmd = nil
}

func (p *wsOCRProcess) request(ctx context.Context, request any) (json.RawMessage, error) {
	p.Lock()
	defer p.Unlock()
	if p.cmd == nil {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		dir := filepath.Dir(exe)
		python := os.Getenv("PDFGURU_OCR_PYTHON")
		if python == "" {
			python = filepath.Join(dir, "ocr-runtime", "python.exe")
		}
		worker := filepath.Join(dir, "ocr_worker.py")
		if _, err := os.Stat(python); err != nil {
			return nil, fmt.Errorf("OCR 组件未安装，请运行 scripts/setup-ocr.ps1 后再试")
		}
		if _, err := os.Stat(worker); err != nil {
			return nil, fmt.Errorf("缺少 ocr_worker.py，请重新构建或安装 OCR 组件")
		}
		cmd := exec.CommandContext(ctx, python, "-u", worker)
		hideOCRWindow(cmd)
		cmd.Env = append(os.Environ(), "PYTHONUTF8=1")
		input, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		output, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		p.cmd, p.input, p.output = cmd, input, bufio.NewReader(output)
		go func() {
			scanner := bufio.NewScanner(stderr)
			scanner.Buffer(make([]byte, 4096), 1024*1024)
			for scanner.Scan() {
				logger.Println("OCR:", scanner.Text())
			}
		}()
	}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err := p.input.Write(append(data, '\n')); err != nil {
		p.stop()
		return nil, err
	}
	type reply struct {
		line []byte
		err  error
	}
	ready := make(chan reply, 1)
	reader := p.output
	go func() { line, err := reader.ReadBytes('\n'); ready <- reply{line, err} }()
	select {
	case response := <-ready:
		if response.err != nil {
			p.stop()
			return nil, fmt.Errorf("OCR 进程退出，请查看日志或重新安装 OCR 组件: %w", response.err)
		}
		var result struct {
			OK    bool            `json:"ok"`
			Data  json.RawMessage `json:"data"`
			Error string          `json:"error"`
		}
		if err := json.Unmarshal(response.line, &result); err != nil {
			p.stop()
			return nil, fmt.Errorf("OCR 返回格式无效: %w", err)
		}
		if !result.OK {
			return nil, fmt.Errorf("OCR 识别失败: %s", result.Error)
		}
		return result.Data, nil
	case <-time.After(5 * time.Minute):
		p.stop()
		return nil, fmt.Errorf("OCR 超时，请检查模型下载网络后重试")
	case <-ctx.Done():
		p.stop()
		return nil, ctx.Err()
	}
}

func (a *App) WorkspaceOCR(docID string, pageIndex int, rotation int) (string, error) {
	info, err := a.wsSourceFor(docID, pageIndex)
	if err != nil {
		return "", err
	}
	rotation = (rotation%360 + 360) % 360
	if rotation%90 != 0 {
		return "", fmt.Errorf("页面旋转角度无效")
	}
	out := filepath.Join(wsCacheRoot, "ocr", fmt.Sprintf("%s-%d-r%d.json", docID, pageIndex, rotation))
	if data, err := os.ReadFile(out); err == nil {
		return string(data), nil
	}
	p := info.Pages[pageIndex]
	// 200 DPI, capped to a 2200px long edge; no unbounded full-page raster.
	width := int(p.Width * 200 / 72)
	if width > 2200 {
		width = 2200
	}
	if h := float64(width) * p.Height / p.Width; h > 2200 {
		width = int(float64(width) * 2200 / h)
	}
	thumbs, err := a.WorkspaceThumbs(docID, fmt.Sprint(pageIndex+1), width)
	if err != nil {
		return "", err
	}
	if len(thumbs) == 0 {
		return "", fmt.Errorf("无法渲染待识别页面")
	}
	image := filepath.Join(wsCacheRoot, filepath.FromSlash(thumbs[0].URL[len(wsURLPrefix):]))
	w, h := p.Width, p.Height
	if p.Rotation%180 != 0 {
		w, h = h, w
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	data, err := wsOCR.request(ctx, map[string]any{"image": image, "rotation": (p.Rotation + rotation) % 360, "extraRotation": rotation, "width": w, "height": h})
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(out), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(out, data, 0644); err != nil {
		return "", err
	}
	return string(data), nil
}
