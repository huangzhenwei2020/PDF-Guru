//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/pkg/errors"
)

// office_win.go —— 把 Word / PowerPoint / Excel 文档转成 PDF（拖进工作区用）。
//
// 为什么必须借外部程序：PyMuPDF 只认 PDF/XPS/EPUB/MOBI/FB2/CBZ/SVG 和图片，
// 打不开 Office 的格式。可选的转换途径有三种：
//
//  1. LibreOffice 无头转换 —— 最省事，但这台机器上没装；
//  2. 用 Python 的 pywin32 调 COM —— 要先装 pywin32，而外部脚本跑的是
//     **用户自己的 Python**（不是随包分发的那份），依赖不可控；
//  3. PowerShell 直接调 COM —— Windows 自带 PowerShell，装没装 Office 都能判断，
//     不需要任何额外依赖。
//
// 所以选了第 3 条：调用同目录下的 office2pdf.ps1。
//
// 已知限制（都在界面上如实说明，不假装没有）：
//   - 只支持 Windows + 本机装了 Microsoft Office / WPS 这类能提供 COM 的办公软件；
//   - PowerPoint 的自动化**必须带窗口**（msoFalse 在 2016 上直接报错），
//     所以转 PPT 时会有窗口一闪而过；
//   - 转换要几秒到十几秒，比 PDF 慢得多。

// officeExts 支持的扩展名 -> 交给哪个 Office 组件。
// 键都是小写、不带点。
var officeExts = map[string]string{
	"doc": "word", "docx": "word", "docm": "word", "rtf": "word", "odt": "word", "txt": "word",
	"ppt": "ppt", "pptx": "ppt", "pptm": "ppt", "odp": "ppt",
	"xls": "excel", "xlsx": "excel", "xlsm": "excel", "xlsb": "excel", "ods": "excel", "csv": "excel",
}

// IsOfficePath 判断是不是需要借 Office 转换的文档。
func IsOfficePath(path string) bool {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	_, ok := officeExts[ext]
	return ok
}

// officeScriptPath 找 office2pdf.ps1：先看程序所在目录，再看工作目录。
//
// 与 ocr.py / convert_external.py 不同，这个脚本不需要用户的 Python，
// 但要和 exe 放在一起（打包脚本负责复制）。
func officeScriptPath() (string, error) {
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "office2pdf.ps1"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "office2pdf.ps1"))
	}
	// 开发时从仓库根目录跑，脚本就在那儿
	candidates = append(candidates, filepath.Join(filepath.Dir(os.Args[0]), "office2pdf.ps1"))
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, nil
		}
	}
	return "", errors.New("找不到 office2pdf.ps1（它应当与程序放在同一目录）")
}

// WorkspaceAddOfficeSource 把 Office 文档转成 PDF，再登记为页面来源。
//
// 两级策略：**先用本机 Office（COM）**，版式最接近原稿；
// 没有 Office（或 COM 失败）时退回**内置渲染器**（纯 Python 解析 OOXML 画 PDF），
// 保证一台没装任何办公软件的机器也能用。走的是哪条会写进 Note，界面据此提示。
func (a *App) WorkspaceAddOfficeSource(path string) (WSDocInfo, error) {
	var info WSDocInfo
	wsInit()

	if err := a.CheckFileExists(path); err != nil {
		return info, err
	}
	name := filepath.Base(path)
	if !IsOfficePath(path) {
		return info, fmt.Errorf("%s 不是受支持的 Office 文档", name)
	}

	outPDF, err := a.wsNewSourcePath("office")
	if err != nil {
		return info, err
	}
	note, err := a.convertOfficeFile(path, outPDF)
	if err != nil {
		// 半成品清掉，免得占着缓存目录还让人以为转成功了
		_ = os.Remove(outPDF)
		return info, err
	}
	info, err = a.registerDoc(outPDF)
	if err != nil {
		return info, err
	}
	info.Note = note
	return info, nil
}

// convertOfficeFile 依次尝试 COM 与内置渲染器，返回给界面看的补充说明。
func (a *App) convertOfficeFile(src, outPDF string) (string, error) {
	comErr := convertOfficeToPDF(src, outPDF)
	if comErr == nil {
		return "", nil
	}
	logger.Warnf("本机 Office 转换失败，改用内置渲染器: %v\n", comErr)
	_ = os.Remove(outPDF)

	builtinErr := a.convertOfficeBuiltin(src, outPDF)
	if builtinErr == nil {
		return "未检测到可用的本机 Office，已用内置渲染器转换（版式可能与原稿有差异）", nil
	}
	logger.Errorf("内置渲染器也失败: %v\n", builtinErr)
	// COM 的报错通常更有信息量（例如"没装 Office"），两个都带上
	return "", fmt.Errorf("转换 %s 失败。\n本机 Office：%v\n内置渲染器：%v",
		filepath.Base(src), comErr, builtinErr)
}

// convertOfficeBuiltin 调 pdf.exe 的 office-render（纯 Python 渲染，不需要 Office）。
func (a *App) convertOfficeBuiltin(src, outPDF string) error {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(src), "."))
	kind := officeExts[ext]
	args := []string{"office-render", src, "--output", outPDF}
	if kind != "" {
		args = append(args, "--kind", kind)
	}
	err := a.cmdRunner(args, "pdf")
	// DocumentWriter 写出的中间文件的句柄要到**进程退出**才释放（实测 6 秒都删不掉），
	// 所以清理只能放在这里——此刻子进程已经结束了。
	_ = os.Remove(outPDF + ".raw")
	if err != nil {
		return err
	}
	if fi, statErr := os.Stat(outPDF); statErr != nil || fi.Size() == 0 {
		return errors.New("内置渲染器没有产出文件")
	}
	return nil
}

// convertOfficeToPDF 调 office2pdf.ps1，并把退出码翻译成用户看得懂的话。
func convertOfficeToPDF(src, dst string) error {
	script, err := officeScriptPath()
	if err != nil {
		return err
	}

	args := []string{
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", script, "-Src", src, "-Dst", dst,
	}
	cmd := exec.Command("powershell.exe", args...)
	// 不让它弹控制台窗口——转换本身可能弹 Office 窗口，那是另一回事
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	out, runErr := cmd.CombinedOutput()
	msg := strings.TrimSpace(string(out))

	if runErr == nil {
		if fi, statErr := os.Stat(dst); statErr == nil && fi.Size() > 0 {
			return nil
		}
		return errors.New("转换没有产出文件（Office 可能未能打开该文档）")
	}

	code := -1
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		code = exitErr.ExitCode()
	}
	logger.Errorf("Office 转换失败: exit=%d src=%s msg=%s\n", code, src, msg)

	name := filepath.Base(src)
	switch {
	case code == 2:
		return fmt.Errorf("%s 的格式不受支持", name)
	case isOfficeMissing(msg):
		return fmt.Errorf(
			"转换 %s 需要本机安装 Microsoft Office（或兼容的办公软件），当前未检测到",
			name)
	case strings.Contains(msg, "not found"):
		return fmt.Errorf("转换 %s 失败：文件不存在或已被移动", name)
	default:
		if msg == "" {
			msg = fmt.Sprintf("退出码 %d", code)
		}
		return fmt.Errorf("转换 %s 失败：%s", name, firstLine(msg))
	}
}

// isOfficeMissing 判断错误是不是"没装 Office"。
// 典型的 COM 报错是 "80040154 Class not registered"，
// 也可能是 "Cannot create object" / "ActiveX component can't create object"。
func isOfficeMissing(msg string) bool {
	m := strings.ToLower(msg)
	for _, k := range []string{
		"80040154", "class not registered", "类未注册",
		"cannot create object", "activex component can't create object",
		"无法创建对象", "800401f3", "invalid class string",
	} {
		if strings.Contains(m, k) {
			return true
		}
	}
	return false
}

// firstLine 取多行错误的第一行——PowerShell 的堆栈又长又没用，
// 整段塞进提示框反而看不清真正的原因。
func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
