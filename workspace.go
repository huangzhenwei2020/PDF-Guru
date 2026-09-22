package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pkg/errors"
)

// ---------------------------------------------------------------------------
// 工作区：把本地文件喂给 webview
//
// 前端拿不到真实文件路径，只拿到不透明的 docID。所有图片都从会话缓存目录经
// /ws/ 路由读取 —— Wails 的 AssetServer 在 Assets(内嵌前端) 未命中时会带着
// 原始 URL 回落到这里，因此不影响原有静态资源。
//
// 之所以不走 Go↔JS 的 JSON 桥传图片字节：一张 150dpi 的页面预览就有几百 KB，
// base64 后还要再涨三分之一，大文档会直接把桥压垮。这里只传路径。
// ---------------------------------------------------------------------------

const wsURLPrefix = "/ws/"

var (
	wsCacheRoot string
	wsInitOnce  sync.Once

	wsMu   sync.Mutex
	wsDocs = map[string]WSDocInfo{}
	wsSeq  int
)

// wsInit 建立本次会话的缓存目录。用 pid 做区分，保证每次启动互不干扰。
func wsInit() {
	wsInitOnce.Do(func() {
		wsCacheRoot = filepath.Join(logdir, "ws", fmt.Sprintf("s%d", os.Getpid()))
		if err := os.MkdirAll(wsCacheRoot, 0755); err != nil {
			logger.Errorln("创建工作区缓存目录失败:", err)
		}
		logger.Println("工作区缓存目录:", wsCacheRoot)
	})
}

// serveWorkspaceFile 是挂给 Wails AssetServer 的 Handler，只服务 /ws/ 前缀。
func serveWorkspaceFile(rw http.ResponseWriter, req *http.Request) {
	wsInit()

	urlPath := req.URL.Path
	if !strings.HasPrefix(urlPath, wsURLPrefix) {
		http.NotFound(rw, req)
		return
	}

	rel := strings.TrimPrefix(urlPath, wsURLPrefix)
	// 路径穿越防护：先 Clean 掉 .. ，再确认最终路径确实落在缓存根目录内。
	clean := filepath.Clean("/" + filepath.FromSlash(rel))
	full := filepath.Join(wsCacheRoot, clean)
	root := filepath.Clean(wsCacheRoot)
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		logger.Errorln("工作区拒绝了越界请求:", urlPath)
		http.Error(rw, "forbidden", http.StatusForbidden)
		return
	}

	// 缩略图按页码+宽度命名，内容稳定，可以放心长缓存
	rw.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(rw, req, full)
}

// WSPageInfo 描述源文档里的一页。
type WSPageInfo struct {
	Index    int     `json:"index"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	Rotation int     `json:"rotation"`
}

// WSDocInfo 是 WorkspaceOpen 的返回值。
// Path 只用于展示与后续导出，前端不应基于它拼任何文件 URL。
type WSDocInfo struct {
	DocID     string       `json:"docId"`
	Path      string       `json:"path"`
	PageCount int          `json:"pageCount"`
	Pages     []WSPageInfo `json:"pages"`
}

// WSThumb 是缩略图清单里的一项，已换算成前端可直接使用的 URL。
type WSThumb struct {
	PageIndex int    `json:"pageIndex"`
	URL       string `json:"url"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

// registerDoc 登记一个 PDF 并读取其结构。WorkspaceOpen 与 WorkspaceAddImageSource
// 都走这里，保证两条来源拿到完全一样的元数据。
func (a *App) registerDoc(path string) (WSDocInfo, error) {
	var info WSDocInfo
	wsInit()

	if err := a.CheckFileExists(path); err != nil {
		return info, err
	}

	wsMu.Lock()
	wsSeq++
	docID := fmt.Sprintf("d%d", wsSeq)
	wsMu.Unlock()

	metaPath := filepath.Join(wsCacheRoot, "meta", docID+".json")
	if err := os.MkdirAll(filepath.Dir(metaPath), 0755); err != nil {
		return info, errors.Wrap(err, "创建元数据目录失败")
	}
	_ = os.Remove(metaPath)

	if err := a.cmdRunner([]string{"ws-info", "--output", metaPath, path}, "pdf"); err != nil {
		return info, err
	}

	data, err := os.ReadFile(metaPath)
	if err != nil {
		return info, errors.Wrap(err, "读取文档结构失败")
	}
	var meta struct {
		PageCount int          `json:"pageCount"`
		Pages     []WSPageInfo `json:"pages"`
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		return info, errors.Wrap(err, "解析文档结构失败")
	}

	info = WSDocInfo{
		DocID:     docID,
		Path:      path,
		PageCount: meta.PageCount,
		Pages:     meta.Pages,
	}
	wsMu.Lock()
	wsDocs[docID] = info
	wsMu.Unlock()

	logger.Printf("工作区登记文档: docID=%s pages=%d path=%s\n", docID, info.PageCount, path)
	return info, nil
}

// WorkspaceOpen 登记一个文档并读取其结构。
// 工作区可以同时持有多个来源文档（插入别的 PDF、追加、图片转 PDF），
// 因此这个接口同时也是"添加来源"。
func (a *App) WorkspaceOpen(path string) (WSDocInfo, error) {
	return a.registerDoc(path)
}

// WorkspaceAddImageSource 把若干图片合成一个 PDF 并登记为来源，供"插入图片"使用。
// 复用已有的 convert 命令（png -> pdf，合并），因此不需要新增 Python 命令。
func (a *App) WorkspaceAddImageSource(images []string) (WSDocInfo, error) {
	var info WSDocInfo
	wsInit()

	if len(images) == 0 {
		return info, errors.New("没有选择图片")
	}
	for _, p := range images {
		if err := a.CheckFileExists(p); err != nil {
			return info, errors.Wrap(err, p)
		}
	}

	wsMu.Lock()
	wsSeq++
	seq := wsSeq
	wsMu.Unlock()

	srcDir := filepath.Join(wsCacheRoot, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		return info, errors.Wrap(err, "创建来源目录失败")
	}
	outPDF := filepath.Join(srcDir, fmt.Sprintf("images-%d.pdf", seq))

	// name_digit 让 img2 排在 img10 前面，比纯字典序符合直觉
	if err := a.PDFConversion(images, outPDF, 0, true, "name_digit", "asc", "png", "pdf", "", "", ""); err != nil {
		return info, errors.Wrap(err, "图片转 PDF 失败")
	}

	return a.registerDoc(outPDF)
}

// WorkspaceThumbs 渲染指定页范围的缩略图，返回可直接用于 <img> 的 URL 列表。
// pages 支持 "all"、"1-20"、"1,3,5-8" 等与其它命令一致的页码范围语法。
func (a *App) WorkspaceThumbs(docID string, pages string, width int) ([]WSThumb, error) {
	wsInit()

	wsMu.Lock()
	info, ok := wsDocs[docID]
	wsMu.Unlock()
	if !ok {
		return nil, errors.New("文档未打开或已失效，请重新打开")
	}

	if width <= 0 {
		width = 160
	}
	if width > 2000 {
		width = 2000
	}
	if strings.TrimSpace(pages) == "" {
		pages = "all"
	}

	dir := filepath.Join(wsCacheRoot, "thumb", docID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, errors.Wrap(err, "创建缩略图目录失败")
	}

	// 每个请求用一份独立清单。若并发请求共用一个清单文件，后写的会覆盖先写的，
	// 调用方就会读到别的请求的页码与文件名——实测表现为"请求第 2 页却显示第 3 页"。
	wsMu.Lock()
	wsSeq++
	reqID := wsSeq
	wsMu.Unlock()
	manifestPath := filepath.Join(dir, fmt.Sprintf("_manifest_w%d_r%d.json", width, reqID))

	args := []string{"ws-render", "--pages", pages, "--width", fmt.Sprintf("%d", width),
		"--output", dir, "--manifest", manifestPath, info.Path}
	if err := a.cmdRunner(args, "pdf"); err != nil {
		return nil, err
	}

	// 清单里带着实际像素尺寸，前端可据此预留位置，避免图片加载时布局抖动。
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, errors.Wrap(err, "读取缩略图清单失败")
	}
	var manifest struct {
		Pages []struct {
			Index  int    `json:"index"`
			File   string `json:"file"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"pages"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, errors.Wrap(err, "解析缩略图清单失败")
	}

	urlBase := wsURLPrefix + "thumb/" + docID + "/"
	thumbs := make([]WSThumb, 0, len(manifest.Pages))
	for _, p := range manifest.Pages {
		if _, err := os.Stat(filepath.Join(dir, p.File)); err != nil {
			logger.Errorln("缩略图缺失，已跳过:", p.File)
			continue
		}
		thumbs = append(thumbs, WSThumb{
			PageIndex: p.Index,
			URL:       urlBase + p.File,
			Width:     p.Width,
			Height:    p.Height,
		})
	}

	logger.Printf("工作区渲染缩略图: docID=%s pages=%s width=%d -> %d 张\n", docID, pages, width, len(thumbs))
	return thumbs, nil
}

// WorkspaceCacheRoot 仅用于诊断（把缓存目录显示在界面上，便于排查）。
func (a *App) WorkspaceCacheRoot() string {
	wsInit()
	return wsCacheRoot
}

// WorkspaceAutoOpenPath 是无人值守验证用的测试钩子：
// 设置环境变量 PDFGURU_WS_AUTOOPEN 后，工作区启动时会自动打开该文档，
// 便于用截图验证界面（见 _smoke 下的脚本），无需人工点文件对话框。
//
// 只暴露这一个专用变量，不把整个进程环境暴露给前端。
func (a *App) WorkspaceAutoOpenPath() string {
	return strings.TrimSpace(os.Getenv("PDFGURU_WS_AUTOOPEN"))
}

// WorkspaceAutoOps 是配套的测试钩子：从 PDFGURU_WS_AUTOPS 读取一段操作脚本，
// 交给前端执行（拖拽重排 / 删除 / 旋转 / 撤销…）。
// 目的：这些交互没法用截图脚本手工触发，但把同样的 store 动作跑一遍之后，
// 界面状态就能被截图核对了。语法见 frontend/src/components/Workspace/devops.ts。
func (a *App) WorkspaceAutoOps() string {
	return strings.TrimSpace(os.Getenv("PDFGURU_WS_AUTOPS"))
}
