/**
 * 无人值守验证用的操作脚本。
 *
 * 背景：拖拽重排、删除、旋转这些交互没法用截图脚本触发（总不能真的去模拟鼠标拖动），
 * 但它们最终都落到 store 的几个动作上。所以这里提供一个小解释器，
 * 把一段脚本翻译成同样的 store 动作，跑完之后界面状态就能被截图核对。
 *
 * 只在设置了环境变量 PDFGURU_WS_AUTOPS 时由 Workspace.vue 调用，正常运行不会走到。
 *
 * 语法（多个操作用 ; 分隔，位置一律 1-based，相对"当前清单"）：
 *   sel:1-3        选中第 1..3 项
 *   sel:1,3        选中第 1、3 项
 *   all / none     全选 / 取消选择
 *   focus:2        聚焦第 2 项
 *   move:1>4       把第 1 项移到第 4 项之前（4 传"长度+1"即移到末尾）
 *   del:2-3        删除第 2..3 项
 *   dup:1          复制第 1 项
 *   rot:1,90       第 1 项顺时针旋转 90 度
 *   undo / redo    撤销 / 重做
 *
 * 注意：每个操作都会改变清单，后续位置随之变化，脚本要按顺序推算。
 */

import { parseRange, type WSItem } from "./model";

/** 把 "1,3-5" 这样的位置表达式翻译成当前清单里的 id。 */
function positionsToIds(seq: WSItem[], spec: string): string[] {
    const ids: string[] = [];
    for (const raw of spec.split(",")) {
        const part = raw.trim();
        if (!part) continue;
        const range = /^(\d+)-(\d+)$/.exec(part);
        if (range) {
            const lo = parseInt(range[1], 10);
            const hi = parseInt(range[2], 10);
            for (let i = lo; i <= hi; i++) {
                const item = seq[i - 1];
                if (item) ids.push(item.id);
            }
        } else {
            const n = parseInt(part, 10);
            const item = seq[n - 1];
            if (item) ids.push(item.id);
        }
    }
    return ids;
}

export async function runOps(store: any, script: string): Promise<string[]> {
    const log: string[] = [];
    const tokens = script
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

    for (const token of tokens) {
        const sep = token.indexOf(":");
        const cmd = (sep >= 0 ? token.slice(0, sep) : token).trim();
        const arg = sep >= 0 ? token.slice(sep + 1).trim() : "";

        switch (cmd) {
            case "all":
                store.selectAll();
                log.push("all");
                break;
            case "none":
                store.clearSelection();
                log.push("none");
                break;
            case "invert":
                store.invertSelection();
                log.push("invert");
                break;
            case "keep":
                store.keepOnlySelected();
                log.push("keep");
                break;
            case "insblank": {
                const n = parseInt(arg, 10) || 1;
                store.insertBlank(n, "A4", "portrait");
                log.push(`insblank:${n}`);
                break;
            }
            // src2:<路径> —— 登记第二个文档并整体追加（验证跨文档合并）
            case "src2": {
                try {
                    const docId = await store.registerSource(arg);
                    store.appendSource(docId);
                    log.push(`src2:${arg} -> ${docId}`);
                } catch (e: any) {
                    log.push(`src2 失败: ${e?.message ?? e}`);
                }
                break;
            }
            // inspdf:<路径>|<页码范围> —— 只插入另一个文档的指定页
            case "inspdf": {
                const bar = arg.indexOf("|");
                const path = bar >= 0 ? arg.slice(0, bar) : arg;
                const spec = bar >= 0 ? arg.slice(bar + 1) : "all";
                try {
                    const docId = await store.registerSource(path);
                    const info = store.sources[docId];
                    const idx = parseRange(spec, info.pageCount);
                    store.insertPagesFrom(docId, idx);
                    log.push(`inspdf:${spec} -> ${idx.length} 页`);
                } catch (e: any) {
                    log.push(`inspdf 失败: ${e?.message ?? e}`);
                }
                break;
            }
            case "undo":
                store.undo();
                log.push("undo");
                break;
            case "redo":
                store.redo();
                log.push("redo");
                break;
            case "focus": {
                const ids = positionsToIds(store.seq, arg);
                if (ids.length) store.focusItem(ids[0]);
                log.push(`focus:${arg}`);
                break;
            }
            case "sel": {
                const ids = positionsToIds(store.seq, arg);
                if (ids.length) {
                    store.selected = ids;
                    store.anchor = ids[0];
                    store.focusItem(ids[0]);
                }
                log.push(`sel:${arg} -> ${ids.length} 项`);
                break;
            }
            case "move": {
                const m = /^(\S+?)>(\d+)$/.exec(arg);
                if (!m) {
                    log.push(`move 语法错误: ${arg}`);
                    break;
                }
                const ids = positionsToIds(store.seq, m[1]);
                // 1-based 位置 -> 原数组坐标
                const insertBefore = parseInt(m[2], 10) - 1;
                if (ids.length) store.doMove(ids, insertBefore);
                log.push(`move:${m[1]}>${m[2]}`);
                break;
            }
            case "del": {
                const ids = positionsToIds(store.seq, arg);
                if (ids.length) store.doDelete(ids);
                log.push(`del:${arg}`);
                break;
            }
            case "dup": {
                const ids = positionsToIds(store.seq, arg);
                if (ids.length) store.doDuplicate(ids);
                log.push(`dup:${arg}`);
                break;
            }
            case "rot": {
                const m = /^(\S+?),(-?\d+)$/.exec(arg);
                if (!m) {
                    log.push(`rot 语法错误: ${arg}`);
                    break;
                }
                const ids = positionsToIds(store.seq, m[1]);
                if (ids.length) store.doRotate(parseInt(m[2], 10), ids);
                log.push(`rot:${m[1]},${m[2]}`);
                break;
            }
            default:
                log.push(`未知操作: ${token}`);
        }
    }
    return log;
}
