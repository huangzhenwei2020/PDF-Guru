package main

import (
	"context"
	"os"
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
	// 拖拽文件到窗口：EnableFileDrop 让 webview 把拖入文件的绝对路径交给运行时。
	//
	// 路由由**前端**决定：它用 wails:file-drop 事件里的客户端坐标 + elementFromPoint
	// 判断落在大纲的哪一行（插到该位置）、还是落在别处（打开/合并）。
	// Go 侧因此只记一条日志，不做业务判断——否则前后端会各处理一次，文件被插两遍。
	wails_runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
		logger.Printf("拖入 %d 个文件 (x=%d y=%d)\n", len(paths), x, y)
	})

	// 无人值守验证用的测试钩子：设置 PDFGURU_WS_AUTODROP 为若干路径（用 | 分隔），
	// 延时触发一次"拖入"。它走的是与真实拖放**完全相同**的链路
	// （Go 过滤 -> EventsEmit -> 前端 EventsOn -> 打开/合并），
	// 只有"鼠标拖过来"这个手势本身没被覆盖。
	if auto := strings.TrimSpace(os.Getenv("PDFGURU_WS_AUTODROP")); auto != "" {
		go func() {
			// 等前端挂上事件监听
			time.Sleep(6 * time.Second)
			wails_runtime.EventsEmit(a.ctx, "workspace:legacy-drop", strings.Split(auto, "|"))
		}()
	}
}
