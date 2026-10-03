package main

import (
	"strings"

	wails_runtime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// workspace_dialogs.go —— 工作区用的文件对话框。
//
// 为什么不直接用 utils.go 里的 SelectFile / SelectMultipleFiles / SelectDir / SaveFile：
//   1) 那几个是无参的，弹出的对话框没有标题、没有类型过滤，用户得在一堆文件里自己找；
//   2) 它们也不参与"记住上次目录"（ui_state.go）。
// 所以这里包一层带参数的版本，前端 Workspace.vue / store/workspace.ts 调的就是这些。
//
// 命名与第三个参数 kind 的取值由前端决定：'pdf' / 'image' / 'office'。
// 认不出来的 kind 不过滤——宁可让用户自己挑，也不要因为过滤太窄而"文件不见了"。

// wsKindFilters 把前端的 kind 映射成对话框的文件类型过滤器。
// 返回 nil 表示不过滤。
//
// 多个扩展名用分号分隔：Windows 的原生对话框（IFileDialog）认这种写法，
// 而 Wails 把 Pattern 原样透传给系统对话框，所以这里不能写成 "*.png|*.jpg"。
func wsKindFilters(kind string) []wails_runtime.FileFilter {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "pdf":
		return []wails_runtime.FileFilter{
			{DisplayName: "PDF 文档 (*.pdf)", Pattern: "*.pdf"},
		}
	case "image":
		return []wails_runtime.FileFilter{
			{
				DisplayName: "图片 (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.tif;*.tiff;*.webp)",
				Pattern:     "*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.tif;*.tiff;*.webp",
			},
		}
	case "office":
		return []wails_runtime.FileFilter{
			{
				DisplayName: "Word / PowerPoint / Excel (*.docx;*.pptx;*.xlsx 等)",
				Pattern:     "*.docx;*.doc;*.docm;*.rtf;*.odt;*.pptx;*.ppt;*.pptm;*.odp;*.xlsx;*.xls;*.xlsm;*.xlsb;*.ods;*.csv",
			},
		}
	}
	return nil
}

// wsTitle 前端传了标题就用前端的；传空时兜一个，免得对话框顶栏空白。
func wsTitle(title string, fallback string) string {
	if t := strings.TrimSpace(title); t != "" {
		return t
	}
	return fallback
}

// WorkspacePickFile 选**一个**文件。返回空串表示用户取消。
//
// 取消不是错误：前端拿到空串就 return（见 Workspace.vue 的 `if (!p) return`），
// 所以这里不返回 error —— 真抛出去前端反而要额外 try/catch 一次取消。
func (a *App) WorkspacePickFile(title string, kind string) string {
	d, err := wails_runtime.OpenFileDialog(a.ctx, wails_runtime.OpenDialogOptions{
		Title:            wsTitle(title, "选择文件"),
		DefaultDirectory: lastDir(),
		Filters:          wsKindFilters(kind),
	})
	if err != nil {
		logger.Errorln(err)
		return ""
	}
	rememberDir(d)
	return d
}

// WorkspacePickFiles 选**多个**文件，用于批量插入图片 / Office 文档。
// 返回 nil 表示取消或没选。
func (a *App) WorkspacePickFiles(title string, kind string) []string {
	d, err := wails_runtime.OpenMultipleFilesDialog(a.ctx, wails_runtime.OpenDialogOptions{
		Title:            wsTitle(title, "选择文件"),
		DefaultDirectory: lastDir(),
		Filters:          wsKindFilters(kind),
	})
	if err != nil {
		logger.Errorln(err)
		return nil
	}
	if len(d) == 0 {
		return nil
	}
	// 批量选文件时记**最后一个**：用户刚在那儿挑完，下次多半还在附近
	rememberDir(d[len(d)-1])
	return d
}

// WorkspacePickDir 选一个目录（导出 PNG/JPG/SVG 时用，因为那些格式会生成一堆文件）。
func (a *App) WorkspacePickDir(title string) string {
	d, err := wails_runtime.OpenDirectoryDialog(a.ctx, wails_runtime.OpenDialogOptions{
		Title:            wsTitle(title, "选择目录"),
		DefaultDirectory: lastDir(),
	})
	if err != nil {
		logger.Errorln(err)
		return ""
	}
	rememberDir(d)
	return d
}

// WorkspaceSaveDialog 选一个**保存到哪儿**的文件名，用于「另存为」和「导出 PDF」。
//
// 固定加 PDF 过滤器：这两个入口的产物都是 PDF，加上过滤器能省得用户手打个 .pdf，
// 也能避免存成别的扩展名之后程序再也打不开。
// DefaultFilename 由前端按当前文档名推出来（Workspace.vue 的 suggestName）。
func (a *App) WorkspaceSaveDialog(title string, defaultName string) string {
	d, err := wails_runtime.SaveFileDialog(a.ctx, wails_runtime.SaveDialogOptions{
		Title:            wsTitle(title, "保存"),
		DefaultDirectory: lastDir(),
		DefaultFilename:  defaultName,
		Filters:          wsKindFilters("pdf"),
	})
	if err != nil {
		logger.Errorln(err)
		return ""
	}
	rememberDir(d)
	return d
}

// WorkspacePickPdfToOpen 打开按钮专用：只挑 PDF。
//
// 标题与过滤器都写死，前端不用传参；前端仍会再检查一次扩展名
// （Workspace.vue 的 pickFile），因为 Windows 对话框的过滤器是可以被用户绕过的。
func (a *App) WorkspacePickPdfToOpen() string {
	d, err := wails_runtime.OpenFileDialog(a.ctx, wails_runtime.OpenDialogOptions{
		Title:            "打开 PDF",
		DefaultDirectory: lastDir(),
		Filters:          wsKindFilters("pdf"),
	})
	if err != nil {
		logger.Errorln(err)
		return ""
	}
	rememberDir(d)
	return d
}

// WorkspaceRememberDir 记住某个文件/目录所在的位置。
//
// 拖拽进来的文件不经过任何对话框，所以前端在 drop 之后显式调一次
// （Workspace.vue 的 `void WorkspaceRememberDir(paths[0])`），
// 这样紧接着弹「另存为」时对话框就从用户刚拖进来的地方开始。
//
// 不返回 error：记不住只是少个便利，不该让前端的 drop 流程报错。
func (a *App) WorkspaceRememberDir(path string) {
	rememberDir(path)
}
