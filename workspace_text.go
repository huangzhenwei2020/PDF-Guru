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
	// backend 是本次会话选定的引擎（PaddleOCR 或系统自带）。由 App 在调用前设好。
	backend *ocrBackend
}

var wsOCR wsOCRProcess

func (p *wsOCRProcess) stop() {
	if p.cmd != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
	}
	p.cmd = nil
}

// ocrPythonPath 解析 PaddleOCR 运行时解释器，按优先级：
//
//  1. 用户在界面上选定的（记住在 ui_state.json）
//  2. 环境变量 PDFGURU_OCR_PYTHON（给自动化/特殊部署留的口子）
//  3. 默认位置：程序同级的 ocr-runtime\python.exe
//
// 找不到时返回空串（不是错误）：那时会退回系统自带的 OCR 引擎。
func (a *App) ocrPythonPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	def := filepath.Join(filepath.Dir(exe), "ocr-runtime", "python.exe")
	for _, c := range []string{savedOcrPython(), os.Getenv("PDFGURU_OCR_PYTHON"), def} {
		if c == "" {
			continue
		}
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}

// resolveOCRBackend 挑一个能用的 OCR 引擎。
//
// 优先级是**精度优先**：只要 PaddleOCR 运行时在，就用它；否则退回系统自带。
// 之所以不是"速度优先"，是因为两者的差距在质量上（图纸/复杂排版），
// 而速度差可以靠常驻进程摊掉——选错了则是识别结果不可用。
func (a *App) resolveOCRBackend() (*ocrBackend, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(exe)

	if python := a.ocrPythonPath(); python != "" {
		worker := filepath.Join(dir, "ocr_worker.py")
		if _, err := os.Stat(worker); err == nil {
			return &ocrBackend{
				label: "PaddleOCR",
				exe:   python,
				args:  []string{"-u", worker},
				env:   []string{"PYTHONUTF8=1"},
			}, nil
		}
	}

	// 系统自带：走 Windows PowerShell 5.1 + WinRT。
	// 必须用 powershell.exe（5.1）而不是 pwsh：PS7 不再内置 WinRT 互操作，
	// [Windows.Media.Ocr.OcrEngine] 在那里面根本解析不出来。
	script := filepath.Join(dir, "ocr_worker_win.ps1")
	if _, err := os.Stat(script); err != nil {
		return nil, fmt.Errorf(
			"没找到 OCR 组件（ocr_worker_win.ps1 应与程序在同一目录），请重新安装程序")
	}
	return &ocrBackend{
		label: "Windows 自带 OCR",
		exe:   "powershell.exe",
		args: []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-File", script},
	}, nil
}

// WorkspaceOcrStatus 供界面显示 OCR 当前状态：
// 返回引擎名、解释器/脚本路径，以及一句面向用户的说明（能用时为空）。
func (a *App) WorkspaceOcrStatus() (string, string, string) {
	b, err := a.resolveOCRBackend()
	if err != nil {
		return "", "", err.Error()
	}
	note := ""
	if b.label == "Windows 自带 OCR" {
		note = "正在使用 Windows 自带的 OCR（零下载，速度快）。" +
			"装了 PaddleOCR 运行时会更准，尤其图纸和复杂排版。"
	} else {
		note = "正在使用 PaddleOCR（精度更好）。"
	}
	path := ""
	if len(b.args) > 0 {
		path = b.args[len(b.args)-1]
	}
	return b.name(), path, note
}

// WorkspaceSetOcrRuntime 记住用户选定的 OCR 运行时解释器（传空串=清除，回到默认/系统引擎）。
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
	wsOCR.Lock()
	wsOCR.stop() // 换引擎要重启子进程，否则还在用旧的
	wsOCR.backend = nil
	wsOCR.Unlock()
	return a.ocrPythonPath(), nil
}

// ocrBackend 描述"这一次用哪个引擎、怎么启动它"。
//
// 两个引擎说的是**同一套协议**（stdin 一行 JSON / stdout 一行 JSON），
// 所以切换后端只是换一条命令行，其余逻辑（缓存、旋转、归一化）完全共用。
//
//   - PaddleOCR：用户装了运行时才用得上。精度更好（尤其图纸、复杂排版），
//     但要多下约 1GB，而且**实测 warm 一次要 40 秒**（见 docs 里的记录），
//     在查清那个 50 倍差距之前不建议推给用户。
//   - Windows OCR：系统自带（中文模型 2.3MB，随语言包已在系统里），零下载，
//     实测一次 0.15 秒。精度一般，但"立刻能用"比"先下 1GB"重要得多。
type ocrBackend struct {
	label string   // 给用户看的名字
	exe   string   // 要启动的程序
	args  []string // 参数
	env   []string // 追加的环境变量
}

func (b ocrBackend) name() string { return b.label }

func (p *wsOCRProcess) request(ctx context.Context, request any) (json.RawMessage, error) {
	p.Lock()
	defer p.Unlock()
	if p.cmd == nil {
		if p.backend == nil {
			return nil, fmt.Errorf("OCR 引擎未就绪")
		}
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		dir := filepath.Dir(exe)
		// 两个 worker 都可能被用到，缺哪个在选后端时就该报出来
		if p.backend.exe == "" {
			return nil, fmt.Errorf("OCR 引擎未就绪")
		}
		_ = dir
		cmd := exec.CommandContext(ctx, p.backend.exe, p.backend.args...)
		hideOCRWindow(cmd)
		cmd.Env = append(os.Environ(), p.backend.env...)
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
	// 每次调用前重新挑一次引擎：用户可能刚在界面上指定了运行时，
	// 而进程是常驻的，缓存住旧选择会变成"我刚设置好却还是老样子"。
	backend, err := a.resolveOCRBackend()
	if err != nil {
		return "", err
	}
	wsOCR.Lock()
	if wsOCR.backend != nil && wsOCR.backend.exe != backend.exe {
		wsOCR.stop() // 换了引擎就把旧进程收掉，免得继续用旧的
	}
	wsOCR.backend = backend
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
