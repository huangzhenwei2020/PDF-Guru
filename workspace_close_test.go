package main

import "testing"

// TestShouldBlockClose 盯住"关闭确认框的选择 -> 是否阻止关闭"这个映射。
//
// 这里出过一次很坑的 bug：只认了自定义按钮文案，而 Windows 上 Wails 固定用
// MB_YESNO、返回 "Yes"/"No"，于是**两个按钮都返回 true，窗口永远关不掉**。
// 关闭窗口这个动作无法用脚本自动点，所以只能靠人肉才发现——正因如此更该有测试。
func TestShouldBlockClose(t *testing.T) {
	cases := []struct {
		name   string
		choice string
		block  bool
	}{
		// Windows：Wails 忽略自定义标签，返回系统按钮映射出来的字符串
		{"Windows 点“是”应放行", "Yes", false},
		{"Windows 点“否”应阻止", "No", true},
		// macOS / Linux：返回我们传入的文案
		{"macOS 点“放弃更改并关闭”应放行", "放弃更改并关闭", false},
		{"macOS 点“取消”应阻止", "取消", true},
		// 容错
		{"大小写不敏感", "YES", false},
		{"带空白", "  Yes  ", false},
		{"对话框被直接关掉（空串）应阻止", "", true},
		{"未知返回应阻止", "Error", true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shouldBlockClose(c.choice); got != c.block {
				t.Errorf("shouldBlockClose(%q) = %v，期望 %v", c.choice, got, c.block)
			}
		})
	}
}
