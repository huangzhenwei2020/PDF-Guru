package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	wails_runtime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 拖拽文件到窗口：运行时给的是绝对路径（WebView2 自身拿不到，故必须由它提供）
	wails_runtime.OnFileDrop(ctx, a.onFileDrop)

	// 无人值守验证用的测试钩子：设置 PDFGURU_WS_AUTODROP 为若干路径（用 | 分隔），
	// 延时触发一次"拖入"。它走的是与真实拖放**完全相同**的链路
	// （Go 过滤 -> EventsEmit -> 前端 EventsOn -> 打开/合并），
	// 只有"鼠标拖过来"这个手势本身没被覆盖。
	if auto := strings.TrimSpace(os.Getenv("PDFGURU_WS_AUTODROP")); auto != "" {
		go func() {
			// 等前端挂上事件监听
			time.Sleep(6 * time.Second)
			a.onFileDrop(0, 0, strings.Split(auto, "|"))
		}()
	}
}

// onFileDrop 处理"把文件拖进窗口"。过滤出 PDF 后发给前端；
// 前端负责决定是打开还是追加，Go 这边不掺和业务判断。
func (a *App) onFileDrop(_ int, _ int, paths []string) {
	pdfs := make([]string, 0, len(paths))
	for _, p := range paths {
		if strings.EqualFold(filepath.Ext(p), ".pdf") {
			pdfs = append(pdfs, p)
		}
	}
	if len(pdfs) == 0 {
		logger.Println("拖入的文件里没有 PDF，已忽略")
		return
	}
	logger.Printf("拖入 %d 个 PDF\n", len(pdfs))
	wails_runtime.EventsEmit(a.ctx, "workspace:open", pdfs)
}
