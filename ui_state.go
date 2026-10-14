package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// ui_state.go —— 记住一些跨会话的界面状态。
//
// 目前只记"上次用过的目录"。文件对话框每次都从系统默认位置开始很烦人；
// Windows 自己确实会记"最近位置"，但它是按 exe 路径记的，而这个项目换过
// exe 的打包方式（onefile -> onedir），那种记忆并不可靠，索性自己记一份。
//
// 单独放一个文件而不是塞进 config.json：config.json 是给用户看和改的路径配置，
// 界面状态混进去只会让两边都更难懂，而且它的 SaveConfig 是按位置传参的。
type uiState struct {
	LastDir string `json:"last_dir"`
	// OcrPython 是用户指定的 OCR 运行时解释器（ocr-runtime\python.exe）。
	//
	// 为什么不放进 config.json：那个文件是"给用户看和改的路径配置"，而它的
	// SaveConfig 是 5 个位置参数的固定签名，加字段会牵动 Wails 接口与整个偏好表单；
	// 这项更像"用户把组件装在哪了"的界面状态。
	// 默认位置（exe 同级的 ocr-runtime）始终有效，这里只是覆盖它。
	OcrPython string `json:"ocr_python"`
}

var uiStateMu sync.Mutex

// uiStateFilePath 必须**惰性**计算路径。
//
// logdir 是在 main() 里赋值的，而包级变量的初始化发生在 main() 之前——
// 写成 `var uiStatePath = filepath.Join(logdir, ...)` 会拿到空 logdir，
// 结果变成一个相对路径文件（实际落在进程工作目录），而读的时候又找不到。
// 这个坑很安静：没有报错，只是"记住上次目录"永远不生效。
func uiStateFilePath() string {
	return filepath.Join(logdir, "ui_state.json")
}

func loadUIState() uiState {
	uiStateMu.Lock()
	defer uiStateMu.Unlock()

	var s uiState
	data, err := os.ReadFile(uiStateFilePath())
	if err != nil {
		return s
	}
	// 有些编辑器会写 UTF-8 BOM，Go 的 json 解析器不认，去掉再解
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	_ = json.Unmarshal(data, &s)
	return s
}

func saveUIState(s uiState) {
	uiStateMu.Lock()
	defer uiStateMu.Unlock()

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(uiStateFilePath(), data, 0644)
}

// rememberDir 记住某个文件（或目录）所在的位置。
// 写失败也无所谓：这只是个便利功能，不该影响正常流程。
func rememberDir(p string) {
	if p == "" {
		return
	}
	d := p
	if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
		d = filepath.Dir(p)
	}
	if d == "" || d == "." {
		return
	}
	s := loadUIState()
	if s.LastDir == d {
		return
	}
	s.LastDir = d
	saveUIState(s)
}

// rememberOcrPython 记住用户指定的 OCR 运行时解释器。
// 传空串表示"忘掉这个设置，回到默认位置"。
func rememberOcrPython(p string) {
	s := loadUIState()
	if s.OcrPython == p {
		return
	}
	s.OcrPython = p
	saveUIState(s)
}

// savedOcrPython 返回用户设置过的 OCR 解释器路径；没设置或文件已经不在时返回空串
// （把一个失效路径拿去启动只会得到一句莫名其妙的报错，不如当作没设置）。
func savedOcrPython() string {
	p := loadUIState().OcrPython
	if p == "" {
		return ""
	}
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return ""
	}
	return p
}

// lastDir 返回上次用过的目录；目录已经不存在时返回空串，
// 而不是把一个失效路径丢给对话框。
func lastDir() string {
	s := loadUIState()
	if s.LastDir == "" {
		return ""
	}
	if fi, err := os.Stat(s.LastDir); err != nil || !fi.IsDir() {
		return ""
	}
	return s.LastDir
}
