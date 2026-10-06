//go:build !windows

package main

import "os/exec"

func hideOCRWindow(cmd *exec.Cmd) {}
