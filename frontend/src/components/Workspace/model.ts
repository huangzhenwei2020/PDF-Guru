/**
 * 工作区的页面模型：纯函数，不依赖 Vue / DOM / 后端 / 文件系统。
 *
 * 这是整个 PPT 式编辑器的核心。用户的每一次拖拽、删除、旋转都只改这份内存里的
 * 页面清单，不碰任何文件；只有"导出/保存"才会把清单落成真正的 PDF。
 *
 * 正因为如此，这里必须完全可测、可推理：所有函数都是 (seq, ...args) => newSeq，
 * 不修改入参，不做 IO。撤销/重做也因此变得简单——存快照即可。
 */

export type Rotation = 0 | 90 | 180 | 270;

/**
 * 归一化矩形：x/y/w/h 都是 0..1 的比例。
 *
 * **坐标空间是页面"未旋转"的那一面，原点在左上角。**
 * 不用显示空间坐标，是因为 PDF 里的 CropBox 就定义在未旋转空间；
 * 而页面固有旋转（扫描件常见 /Rotate 90）又是另一层，两者必须分开处理，
 * 否则旋转过的页面上裁剪框会跑到对角去。
 */
export type NormRect = { x: number; y: number; w: number; h: number };

/** 挂在单个页面上的非破坏式操作。导出时才落到 PDF，因此撤销天然可用。 */
export type PageOps = {
    /** 裁剪：导出后页面即为该区域 */
    crop?: NormRect;
    /** 遮盖：每项一个矩形与样式 */
    masks?: { rect: NormRect; color: string; opacity: number }[];
    /** 导出时删除该页的全部批注 */
    removeAnnots?: boolean;
};

/** 引用源文档中的某一页。 */
export type PageItem = {
    kind: "page";
    id: string;
    docId: string;
    /** 源文档内的页序（0-based）。注意：与它在工作区里的位置无关。 */
    pageIndex: number;
    rotation: Rotation;
    /** 裁剪 / 遮盖等非破坏式编辑 */
    ops?: PageOps;
};

/** 插入的空白页。 */
export type BlankItem = {
    kind: "blank";
    id: string;
    paper: string;
    orientation: "portrait" | "landscape";
};

export type WSItem = PageItem | BlankItem;

/**
 * 缩略图轨道里的一行 —— 由清单 + 缩略图拼出来的展示数据。
 * 放在这里而不是 ThumbRail.vue 里，是因为 *.vue 的模块声明只有 default 导出，
 * 从 SFC 里具名导出类型会导致类型检查失败。
 */
export type RailRow = {
    id: string;
    kind: "page" | "blank";
    /** 在清单中的位置（1-based），也就是用户看到的页码 */
    label: number;
    /** 源文档页码（1-based）；空白页为 0 */
    srcLabel: number;
    /**
     * 来源标记。工作区可以合并多个文档，此时光看"源 p3"分不清是哪个文件的，
     * 因此多来源时显示 S1/S2，并用颜色区分。只有一个来源时留空避免噪音。
     */
    srcTag: string;
    srcColor: string;
    /** 来源文件路径，用于悬停提示 */
    srcPath: string;
    rotation: number;
    url: string;
    /** 缩略图原始像素 */
    w: number;
    h: number;
    paper?: string;
};

// ---------------------------------------------------------------------------
// id 生成
// ---------------------------------------------------------------------------

let idSeq = 0;

export function nextId(prefix = "i"): string {
    idSeq += 1;
    return `${prefix}${idSeq}`;
}

/** 仅测试用：重置计数器，让断言结果可预测。 */
export function __resetIdSeq(): void {
    idSeq = 0;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export function createPageItem(docId: string, pageIndex: number, rotation: Rotation = 0): PageItem {
    return { kind: "page", id: nextId("p"), docId, pageIndex, rotation };
}

export function createBlankItem(paper = "A4", orientation: "portrait" | "landscape" = "portrait"): BlankItem {
    return { kind: "blank", id: nextId("b"), paper, orientation };
}

/** 为整个源文档建立初始清单（1:1，顺序与源文档一致）。 */
export function buildInitialSeq(docId: string, pageCount: number): PageItem[] {
    const seq: PageItem[] = [];
    for (let i = 0; i < pageCount; i++) {
        seq.push(createPageItem(docId, i));
    }
    return seq;
}

/** 为源文档中指定的若干页建立清单项（用于"插入另一个 PDF 的某几页"）。 */
export function buildPageItems(docId: string, pageIndices: number[]): PageItem[] {
    return pageIndices.map((i) => createPageItem(docId, i));
}

/** 只保留给定 id 的项（"仅保留选中页"）。 */
export function keepItems(seq: WSItem[], ids: string[]): WSItem[] {
    const idSet = new Set(ids);
    return seq.filter((it) => idSet.has(it.id));
}

/**
 * 解析页码范围，返回 0-based 下标（去重升序）。
 * 支持 "all"、"1-3,5,8-N"，与后端 utils.parse_range 的常用子集保持一致；
 * 格式错误时抛异常，由界面提示而不是静默插入错页。
 */
export function parseRange(spec: string, pageCount: number): number[] {
    const s = (spec || "").trim();
    if (s === "" || s.toLowerCase() === "all") {
        return Array.from({ length: pageCount }, (_, i) => i);
    }
    const out = new Set<number>();
    for (const raw of s.split(",")) {
        const part = raw.trim();
        if (!part) continue;
        const m = /^(\d+|N)(?:-(\d+|N))?$/.exec(part);
        if (!m) throw new Error(`页码范围格式错误：${part}`);
        const toIdx = (t: string) => (t === "N" ? pageCount - 1 : parseInt(t, 10) - 1);
        const a = toIdx(m[1]);
        const b = m[2] !== undefined ? toIdx(m[2]) : a;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) {
            if (i >= 0 && i < pageCount) out.add(i);
        }
    }
    return Array.from(out).sort((x, y) => x - y);
}

/** 把 0-based 下标压成 "1-3,5,8-10" 形式的页码范围，用于只请求真正需要的缩略图。 */
export function indicesToRangeSpec(indices: number[]): string {
    const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (!sorted.length) return "";
    const parts: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    const flush = () => {
        parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    };
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === prev + 1) {
            prev = sorted[i];
            continue;
        }
        flush();
        start = sorted[i];
        prev = sorted[i];
    }
    flush();
    return parts.join(",");
}

/** 深拷贝一项并换上新 id（用于"复制页面"）。 */
export function cloneItem(item: WSItem): WSItem {
    if (item.kind === "page") {
        const copy: PageItem = { ...item, id: nextId("p") };
        if (item.ops) copy.ops = cloneOps(item.ops);
        return copy;
    }
    return { ...item, id: nextId("b") };
}

/**
 * 深拷贝页面操作。
 * 撤销栈存的是清单快照，若 ops 只做浅拷贝，之后改动会连带改到历史快照，
 * 撤销就会"撤不回去"。
 */
export function cloneOps(ops?: PageOps): PageOps | undefined {
    if (!ops) return undefined;
    const out: PageOps = {};
    if (ops.crop) out.crop = { ...ops.crop };
    if (ops.masks) out.masks = ops.masks.map((m) => ({ rect: { ...m.rect }, color: m.color, opacity: m.opacity }));
    if (ops.removeAnnots) out.removeAnnots = true;
    return out;
}

// ---------------------------------------------------------------------------
// 坐标换算：显示空间 <-> 页面未旋转空间
// ---------------------------------------------------------------------------

function normRot(totalRotation: number): number {
    return ((totalRotation % 360) + 360) % 360;
}

/**
 * 把显示空间（旋转后）的归一化矩形换算到页面未旋转空间。
 *
 * 显示的旋转量 = 页面固有旋转 + 工作区附加旋转。画布上拖框拿到的是显示坐标，
 * 必须换算之后才能存，否则旋转过的页面上裁剪会错位。
 */
export function displayRectToPageRect(r: NormRect, totalRotation: number): NormRect {
    switch (normRot(totalRotation)) {
        case 90:
            return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
        case 180:
            return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
        case 270:
            return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
        default:
            return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
}

/** 反向换算：把页面空间的矩形换回显示空间，用于在画布上画出已有的裁剪框。 */
export function pageRectToDisplayRect(r: NormRect, totalRotation: number): NormRect {
    switch (normRot(totalRotation)) {
        case 90:
            return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
        case 180:
            return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
        case 270:
            return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
        default:
            return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
}

/** 由拖拽的两个角点构造归一化矩形，保证 x/y 是左上角。 */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): NormRect {
    return {
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        w: Math.abs(bx - ax),
        h: Math.abs(by - ay),
    };
}

/** 把矩形裁到 [0,1] 范围内，并丢掉退化到没有面积的框。 */
export function clampRect(r: NormRect, minSize = 0.01): NormRect | null {
    const x0 = Math.max(0, Math.min(1, r.x));
    const y0 = Math.max(0, Math.min(1, r.y));
    const x1 = Math.max(0, Math.min(1, r.x + r.w));
    const y1 = Math.max(0, Math.min(1, r.y + r.h));
    const out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (out.w < minSize || out.h < minSize) return null;
    return out;
}

/** 清空某一项的裁剪/遮罩。 */
export function clearOps(seq: WSItem[], ids: string[]): WSItem[] {
    const idSet = new Set(ids);
    return seq.map((it) => {
        if (!idSet.has(it.id) || it.kind !== "page" || !it.ops) return it;
        const { ops, ...rest } = it;
        return rest as PageItem;
    });
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function indexOfId(seq: WSItem[], id: string): number {
    for (let i = 0; i < seq.length; i++) {
        if (seq[i].id === id) return i;
    }
    return -1;
}

export function allIds(seq: WSItem[]): string[] {
    return seq.map((it) => it.id);
}

/**
 * 计算 anchor..focus 之间（含两端）的所有 id。
 * 用于 Shift 范围选择；anchor 或 focus 找不到时退化为只选 focus。
 */
export function rangeIds(seq: WSItem[], anchorId: string, focusId: string): string[] {
    const a = indexOfId(seq, anchorId);
    const b = indexOfId(seq, focusId);
    if (b < 0) return [];
    if (a < 0) return [focusId];
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) out.push(seq[i].id);
    return out;
}

// ---------------------------------------------------------------------------
// 结构性操作
// ---------------------------------------------------------------------------

/**
 * 把选中的若干项移动到 insertBefore 处。
 *
 * insertBefore 用的是**原数组**坐标：表示"插到原先第 insertBefore 项之前"，
 * 传 seq.length 表示插到末尾。之所以用原数组坐标而不是"移除后"的坐标，
 * 是因为拖拽时 UI 只知道鼠标悬停在哪一项上，这样定义可以彻底避开差一错误。
 */
export function moveItems(seq: WSItem[], ids: string[], insertBefore: number): WSItem[] {
    const idSet = new Set(ids);
    const moving = seq.filter((it) => idSet.has(it.id));
    if (moving.length === 0) return seq;

    const rest = seq.filter((it) => !idSet.has(it.id));

    // 原坐标 -> 移除后的插入位置：数一数 insertBefore 之前有多少项没被移走
    let target = 0;
    const limit = Math.min(insertBefore, seq.length);
    for (let i = 0; i < limit; i++) {
        if (!idSet.has(seq[i].id)) target++;
    }

    return [...rest.slice(0, target), ...moving, ...rest.slice(target)];
}

export function removeItems(seq: WSItem[], ids: string[]): WSItem[] {
    const idSet = new Set(ids);
    return seq.filter((it) => !idSet.has(it.id));
}

/** 复制选中项，副本紧跟在各自原件之后（与 PPT 的习惯一致）。 */
export function duplicateItems(seq: WSItem[], ids: string[]): { seq: WSItem[]; newIds: string[] } {
    const idSet = new Set(ids);
    const out: WSItem[] = [];
    const newIds: string[] = [];
    for (const it of seq) {
        out.push(it);
        if (idSet.has(it.id)) {
            const copy = cloneItem(it);
            out.push(copy);
            newIds.push(copy.id);
        }
    }
    return { seq: out, newIds };
}

/** 在 insertBefore 处插入若干项（原数组坐标语义同 moveItems）。 */
export function insertItems(seq: WSItem[], items: WSItem[], insertBefore: number): WSItem[] {
    const at = Math.max(0, Math.min(insertBefore, seq.length));
    return [...seq.slice(0, at), ...items, ...seq.slice(at)];
}

// ---------------------------------------------------------------------------
// 旋转
// ---------------------------------------------------------------------------

function normalizeRotation(value: number): Rotation {
    const v = ((value % 360) + 360) % 360;
    if (v === 90 || v === 180 || v === 270) return v;
    return 0;
}

/** 对选中页累加旋转。空白页没有内容，忽略。 */
export function rotateItems(seq: WSItem[], ids: string[], delta: number): WSItem[] {
    const idSet = new Set(ids);
    return seq.map((it) => {
        if (!idSet.has(it.id) || it.kind !== "page") return it;
        return { ...it, rotation: normalizeRotation(it.rotation + delta) };
    });
}

// ---------------------------------------------------------------------------
// 比较（供撤销栈判断"这次操作到底改没改东西"）
// ---------------------------------------------------------------------------

/** 结构等价判断。任何字段变化都算变化，包括旋转角。 */
export function sameSeq(a: WSItem[], b: WSItem[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x.id !== y.id || x.kind !== y.kind) return false;
        if (x.kind === "page" && y.kind === "page") {
            if (x.docId !== y.docId || x.pageIndex !== y.pageIndex || x.rotation !== y.rotation) return false;
            // 裁剪/遮罩也要参与比较，否则"只改了裁剪"会被当成没变化而不进撤销栈
            if (JSON.stringify(x.ops ?? null) !== JSON.stringify(y.ops ?? null)) return false;
        } else if (x.kind === "blank" && y.kind === "blank") {
            if (x.paper !== y.paper || x.orientation !== y.orientation) return false;
        }
    }
    return true;
}

/** 供撤销栈保存/恢复的纯数据快照。ops 必须深拷贝，否则历史快照会被后续编辑带改。 */
export function snapshot(seq: WSItem[]): WSItem[] {
    return seq.map((it) => {
        if (it.kind === "page" && it.ops) {
            const copy: PageItem = { ...it };
            copy.ops = cloneOps(it.ops);
            return copy;
        }
        return { ...it };
    });
}
