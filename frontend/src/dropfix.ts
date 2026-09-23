/**
 * 修掉 Wails v2.16 文件拖放的一个 bug。
 *
 * 它的前端 onDrop 是这样取文件的：
 *
 *     files = [...e.dataTransfer.items].map((item) => {
 *         if (item.kind === 'file') return item.getAsFile();
 *         // 非 file 的条目没有返回值 -> undefined
 *     });
 *     window.runtime.ResolveFilePaths(e.x, e.y, files);
 *
 * 而从资源管理器拖文件时，items 里**通常同时存在** text/uri-list 之类的非文件条目，
 * 于是数组变成 [File, undefined, undefined]，再原样交给 WebView2，就会抛：
 *
 *     Failed to execute 'postMessageWithAdditionalObjects' ...
 *     additional File object is not a file on the disk.
 *
 * 结果是**路径根本没送到 Go**：拖放看起来毫无反应，控制台（生产环境看不到）里只有这条报错。
 *
 * 这里把 window.runtime.ResolveFilePaths 包一层，过滤掉非 File 项再交给原实现。
 * 选择在应用侧修，而不是改 node_modules / Go module cache：那两处都不是我们的代码，
 * 升级或重装就会被覆盖，问题会悄悄回来。
 */

type Stats = {
    /** 补丁是否已装上（装上之前拖放是坏的，所以要能看见） */
    installed: boolean;
    /** 被调用次数 */
    calls: number;
    /** 过滤掉的非文件条目数（正常情况下每次真实拖放都会 > 0） */
    filteredNonFile: number;
    /** 真正转发给 WebView2 的次数与条目数 */
    forwarded: number;
    forwardedItems: number;
    /** 交给 WebView2 之后仍然失败时的信息 */
    lastError: string;
};

const stats: Stats = {
    installed: false,
    calls: 0,
    filteredNonFile: 0,
    forwarded: 0,
    forwardedItems: 0,
    lastError: "",
};
let original: ((x: number, y: number, files: unknown[]) => unknown) | null = null;

export function dropFixStats(): Stats {
    return { ...stats };
}

/** 未经修补的原实现，供验证时做对照 */
export function dropFixOriginal() {
    return original;
}

export function installDropFix(): boolean {
    const rt = (window as any).runtime;
    // window.runtime 由 Wails 的运行时脚本注入。若本模块在它之前执行，
    // 这里会拿不到——所以返回值要能被调用方看到并在挂载时再试一次，
    // 否则补丁静默失效，拖放又会坏掉。
    if (!rt || typeof rt.ResolveFilePaths !== "function") {
        stats.installed = false;
        return false;
    }
    if (rt.__pdfguruDropFixed) {
        stats.installed = true;
        return true;
    }

    original = rt.ResolveFilePaths.bind(rt);
    rt.ResolveFilePaths = (x: number, y: number, files: unknown[]) => {
        const all = Array.isArray(files) ? files : [];
        // 只保留真正的 File；Wails 会把非文件条目映射成 undefined
        const clean = all.filter((f) => f instanceof File);
        stats.calls += 1;
        stats.filteredNonFile += all.length - clean.length;

        // 一个真实文件都没有（比如拖进来的是纯文本）就不要往 WebView2 发了，
        // 否则必然又是那条 "not a file on the disk"
        if (!clean.length) return undefined;

        stats.forwarded += 1;
        stats.forwardedItems += clean.length;
        try {
            return original!(x, y, clean);
        } catch (e: any) {
            stats.lastError = String(e?.message ?? e);
            // 交给界面提示，而不是让它变成一条没人看得见的未捕获异常
            window.dispatchEvent(
                new CustomEvent("pdfguru:drop-error", { detail: stats.lastError })
            );
            return undefined;
        }
    };
    rt.__pdfguruDropFixed = true;
    stats.installed = true;
    return true;
}
