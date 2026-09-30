//go:build !windows

package main

import (
	"path/filepath"
	"strings"

	"github.com/pkg/errors"
)

// 非 Windows 平台上没有 COM 可用，Office 文档只能先自己另存为 PDF。
// 保留同名方法是为了让前端绑定在各平台一致；功能本身只在 Windows 上有意义。

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

// WorkspaceAddOfficeSource 在非 Windows 上不可用。
func (a *App) WorkspaceAddOfficeSource(path string) (WSDocInfo, error) {
	return WSDocInfo{}, errors.New("Office 文档转换目前只支持 Windows")
}
