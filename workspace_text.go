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
	"strings"
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
	// python 是这次会话解析出来的解释器路径。
	// 由调用方（App 方法）在启动前设好——进程本身拿不到 App，
	// 而路径解析要读用户设置，属于 App 的职责。
	python string
}

var wsOCR wsOCRProcess

func (p *wsOCRProcess) stop() {
	if p.cmd != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
	}
	p.cmd = nil
}

// ocrPythonPath 解析 OCR 运行时解释器，按优先级：
//
//  1. 用户在界面上选定的（记住在 ui_state.json）
//  2. 环境变量 PDFGURU_OCR_PYTHON（给自动化/特殊部署留的口子）
//  3. 默认位置：程序同级的 ocr-runtime\python.exe
//
// 都找不到时给一句**面向用户**的话：告诉他这是什么、有多大、放哪里、
// 或者在哪里改。早先这里写的是"请运行 scripts/setup-ocr.ps1"——那是给开发者看的，
// 而用户拿到的是发布包，里面根本没有 scripts 目录。
func (a *App) ocrPythonPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	def := filepath.Join(filepath.Dir(exe), "ocr-runtime", "python.exe")
	candidates := []string{savedOcrPython(), os.Getenv("PDFGURU_OCR_PYTHON"), def}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf(
		"还没安装 OCR 组件。\n"+
			"它是可选组件（约 1GB，含中文识别模型），装好扫描件才能识别文字。\n\n"+
			"默认位置：%s\n"+
			"如果你已经把它放在别处，点下面的「选择 OCR 运行时…」指定 python.exe 即可（会被记住）。",
		def)
}

// WorkspaceOcrStatus 供界面显示 OCR 组件当前的状态：找到了就返回路径，否则返回空串与说明。
func (a *App) WorkspaceOcrStatus() (string, string) {
	if p, err := a.ocrPythonPath(); err == nil {
		return p, ""
	} else {
		return "", err.Error()
	}
}

// WorkspaceSetOcrRuntime 记住用户选定的 OCR 运行时解释器（传空串=清除，回到默认位置）。
func (a *App) WorkspaceSetOcrRuntime(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path != "" {
		fi, err := os.Stat(path)
		if err != nil || fi.IsDir() {
			return "", fmt.Errorf("这个路径不是一个可执行文件：%s", path)
		}
		if !strings.EqualFold(filepath.Base(path), "python.exe") {
			// 不硬性拦截，但要说清楚：这里要的是 ocr-runtime 里的 python.exe，
			// 不是随便一个 python。选错了会在后面以看不懂的方式失败。
			logger.Warnf("OCR 运行时选的不是 python.exe：%s\n", path)
		}
	}
	rememberOcrPython(path)
	if p, err := a.ocrPythonPath(); err == nil {
		return p, nil
	}
	return "", nil
}

func (p *wsOCRProcess) request(ctx context.Context, request any) (json.RawMessage, error) {
	p.Lock()
	defer p.Unlock()
	if p.cmd == nil {
		python := p.python
		if python == "" {
			return nil, fmt.Errorf("OCR 运行时未就绪，请先在界面上指定（或放到默认位置）")
		}
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		dir := filepath.Dir(exe)
		worker := filepath.Join(dir, "ocr_worker.py")
		if _, err := os.Stat(worker); err != nil {
			return nil, fmt.Errorf("缺少 ocr_worker.py（它应与程序放在同一目录），请重新安装程序")
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
	// 每次调用前重新解析一次解释器路径：用户可能刚在界面上指定了位置，
	// 而进程是常驻的，缓存住旧值会让"我刚设置好却还是报未安装"。
	python, err := a.ocrPythonPath()
	if err != nil {
		return "", err
	}
	wsOCR.Lock()
	changed := wsOCR.python != "" && wsOCR.python != python
	wsOCR.python = python
	if changed {
		wsOCR.stop() // 换了运行时就把旧进程收掉，免得继续用旧的
	}
	wsOCR.Unlock()
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
