import { defineStore } from "pinia";
import {
    WorkspaceOpen,
    WorkspaceThumbs,
    WorkspaceCacheRoot,
    WorkspaceAddImageSource,
    WorkspaceBuild,
    WorkspaceSetDirty,
    WorkspaceAutoOpenPath,
    WorkspaceAutoOps,
} from "../../wailsjs/go/main/App";
import {
    allIds,
    buildInitialSeq,
    buildPageItems,
    clearOps,
    cloneOps,
    createBlankItem,
    duplicateItems,
    indexOfId,
    indicesToRangeSpec,
    insertItems,
    keepItems,
    moveItems,
    rangeIds,
    removeItems,
    rotateItems,
    sameSeq,
    snapshot,
    type NormRect,
    type WSItem,
} from "../components/Workspace/model";

export type WSPage = {
    index: number;
    width: number;
    height: number;
    rotation: number;
};

export type WSThumb = {
    pageIndex: number;
    url: string;
    width: number;
    height: number;
};

/** 工作区里的一个来源文档。清单里的每一项都指向某个来源的某一页。 */
export type WSSource = {
    docId: string;
    path: string;
    pageCount: number;
    pages: WSPage[];
};

// 缩略图轨道用 150px，大图预览用 900px。
// Go 侧的清单文件按宽度分开存放，因此两者可以各自渲染互不干扰。
const THUMB_WIDTH = 150;
const PREVIEW_WIDTH = 900;

/** 撤销栈上限。一份 1000 页清单的快照约 60KB，100 步也只有 6MB。 */
const UNDO_LIMIT = 100;

/** 多来源时用来区分不同文档的颜色 */
const SRC_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1", "#13c2c2"];

/**
 * 正在渲染中的缩略图 / 预览。
 *
 * 必须做去重：同一页在同一时刻被请求两次时，后端会用同一个文件名写两次，
 * 而 Windows 上 webview 正读着这个 png 会持有句柄，PyMuPDF 保存前删旧文件
 * 就会失败（实测报 "cannot remove file ... Permission denied"）。
 * 放在模块级而不是 state 里，是因为 Promise 不该进响应式状态。
 */
const inflightThumbs = new Set<string>();
const inflightPreviews = new Map<string, Promise<WSThumb | null>>();

export const WS_THUMB_WIDTH = THUMB_WIDTH;
export const WS_PREVIEW_WIDTH = PREVIEW_WIDTH;

export type SelectMode = "replace" | "toggle" | "range";

/**
 * 导出期装饰：水印、页码、页眉页脚。
 *
 * 它们与裁剪/遮盖不同，**不能**挂在单个页面项上——页码要写"第 X 页 / 共 N 页"，
 * 而 N 只有把清单全部拼完之后才存在，所以只能在导出时应用。
 * 作用域因此用"全部 / 选中"表示，并在导出那一刻把选中页解析成输出文档里的下标。
 */
export type DecorState = {
    watermark: {
        enabled: boolean;
        text: string;
        color: string;
        fontSize: number;
        angle: number;
        opacity: number;
        multiple: boolean;
        scopeSelected: boolean;
    };
    pageNumber: {
        enabled: boolean;
        format: string;
        pos: "header" | "footer";
        align: "left" | "center" | "right";
        fontSize: number;
        start: number;
        scopeSelected: boolean;
    };
    headerFooter: {
        enabled: boolean;
        headerLeft: string;
        headerCenter: string;
        headerRight: string;
        footerLeft: string;
        footerCenter: string;
        footerRight: string;
        fontSize: number;
        scopeSelected: boolean;
    };
};

function defaultDecor(): DecorState {
    return {
        watermark: {
            enabled: false,
            text: "机密",
            color: "#FF0000",
            fontSize: 40,
            angle: 30,
            opacity: 0.3,
            multiple: true,
            scopeSelected: false,
        },
        pageNumber: {
            enabled: false,
            format: "第%p页/共%P页",
            pos: "footer",
            align: "right",
            fontSize: 10,
            start: 0,
            scopeSelected: false,
        },
        headerFooter: {
            enabled: false,
            headerLeft: "",
            headerCenter: "",
            headerRight: "",
            footerLeft: "",
            footerCenter: "",
            footerRight: "",
            fontSize: 10,
            scopeSelected: false,
        },
    };
}

/** 文件名（去掉目录），用于界面上的简短标题 */
function baseName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

export const useWorkspaceState = defineStore("WorkspaceState", {
    state: () => ({
        /** 所有来源文档，docId -> 来源。清单里的项通过 docId 指向这里 */
        sources: {} as Record<string, WSSource>,
        /** 工作区页面清单 —— 整个编辑器的唯一真相 */
        seq: [] as WSItem[],
        /** 选中的项 id */
        selected: [] as string[],
        /** Shift 范围选择的锚点 */
        anchor: "",
        /** 当前聚焦项（决定右侧大图显示哪一页） */
        current: "",
        /** 缩略图缓存，key = `${docId}:${pageIndex}` */
        thumbs: {} as Record<string, WSThumb>,
        /** 已经请求过缩略图的 key，避免每次插入都重渲染整个来源 */
        thumbAsked: {} as Record<string, true>,
        /** 大图缓存，key 同 thumbs。聚焦同一页时不再重复渲染 */
        previewCache: {} as Record<string, WSThumb>,
        preview: null as WSThumb | null,
        /** 撤销 / 重做栈，存的是清单快照 */
        past: [] as WSItem[][],
        future: [] as WSItem[][],
        cacheRoot: "",
        loading: false,
        previewLoading: false,
        error: "",
        /** 导出期装饰（水印/页码/页眉页脚）。改动同样算"编辑"，要进未保存判定 */
        decor: defaultDecor(),
        /** 是否有未保存的更改。判定方式见 syncDirty：与上次保存时的指纹比对 */
        dirty: false,
        /** 上次保存/打开时的状态指纹（清单 + 装饰），用于精确判断"未保存" */
        savedSig: "",
        saving: false,
    }),

    getters: {
        selectedSet(state): Set<string> {
            return new Set(state.selected);
        },
        canUndo(state): boolean {
            return state.past.length > 0;
        },
        canRedo(state): boolean {
            return state.future.length > 0;
        },
        /** 实际会参与操作的项：有选中就用选中，否则用当前聚焦项。 */
        targetIds(state): string[] {
            if (state.selected.length > 0) return state.selected;
            return state.current ? [state.current] : [];
        },
        currentItem(state): WSItem | null {
            const i = indexOfId(state.seq, state.current);
            return i >= 0 ? state.seq[i] : null;
        },
        currentPos(state): number {
            return indexOfId(state.seq, state.current);
        },
        /** 新内容插到哪里：最后一个选中项之后；没有选中就放到末尾。 */
        insertAt(state): number {
            const ids = state.selected.length ? state.selected : state.current ? [state.current] : [];
            let last = -1;
            for (const id of ids) {
                const i = indexOfId(state.seq, id);
                if (i > last) last = i;
            }
            return last >= 0 ? last + 1 : state.seq.length;
        },
        sourceList(state): WSSource[] {
            return Object.values(state.sources);
        },
        /** 「保存」的目标：第一个来源文件。 */
        mainPath(state): string {
            return Object.values(state.sources)[0]?.path ?? "";
        },
        /** 界面标题：用第一个来源的文件名 */
        title(state): string {
            const first = Object.values(state.sources)[0];
            if (!first) return "";
            const n = Object.keys(state.sources).length;
            return n > 1 ? `${baseName(first.path)} 等 ${n} 个文档` : baseName(first.path);
        },
        /**
         * 来源标记与配色。合并多个文档后，光看"源 p3"分不清是哪个文件的，
         * 所以多来源时显示 S1/S2 并用颜色区分；只有一个来源时留空避免噪音。
         * （Pinia 的 getter 可以返回函数，用起来和普通带参方法一样。）
         */
        sourceTag(state) {
            return (docId: string): { tag: string; color: string; path: string } => {
                const ids = Object.keys(state.sources);
                const i = ids.indexOf(docId);
                if (i < 0) return { tag: "", color: "#aaa", path: "" };
                const multi = ids.length > 1;
                return {
                    tag: multi ? `S${i + 1}` : "",
                    color: multi ? SRC_COLORS[i % SRC_COLORS.length] : "#aaa",
                    path: state.sources[docId]?.path ?? "",
                };
            };
        },
    },

    actions: {
        thumbKey(docId: string, pageIndex: number): string {
            return `${docId}:${pageIndex}`;
        },

        /** 取某一项的缩略图（空白页没有缩略图，返回 null）。 */
        thumbOf(item: WSItem): WSThumb | null {
            if (item.kind !== "page") return null;
            return this.thumbs[this.thumbKey(item.docId, item.pageIndex)] ?? null;
        },

        pageInfoOf(item: WSItem): WSPage | null {
            if (item.kind !== "page") return null;
            return this.sources[item.docId]?.pages?.[item.pageIndex] ?? null;
        },

        reset() {
            this.$patch({
                sources: {},
                seq: [],
                selected: [],
                anchor: "",
                current: "",
                thumbs: {},
                thumbAsked: {},
                previewCache: {},
                preview: null,
                past: [],
                future: [],
                error: "",
                dirty: false,
                savedSig: "",
                decor: defaultDecor(),
            });
        },

        // --- 与后端交互 ---------------------------------------------------

        async loadCacheRoot() {
            try {
                this.cacheRoot = await WorkspaceCacheRoot();
            } catch (e) {
                this.cacheRoot = "(获取失败)";
            }
        },

        /** 登记一个来源文档（不改变清单）。返回其 docId。 */
        async registerSource(path: string): Promise<string> {
            // 同一个文件只登记一次，避免重复渲染整份缩略图
            const existing = Object.values(this.sources).find((s) => s.path === path);
            if (existing) return existing.docId;

            const info: any = await WorkspaceOpen(path);
            const docId: string = info?.docId ?? "";
            if (!docId) throw new Error("登记文档失败");
            this.sources[docId] = {
                docId,
                path: info?.path ?? path,
                pageCount: info?.pageCount ?? 0,
                pages: info?.pages ?? [],
            };
            return docId;
        },

        /** 把图片合成 PDF 并登记为来源。返回其 docId。 */
        async registerImageSource(images: string[]): Promise<string> {
            const info: any = await WorkspaceAddImageSource(images);
            const docId: string = info?.docId ?? "";
            if (!docId) throw new Error("图片转换失败");
            this.sources[docId] = {
                docId,
                path: info?.path ?? "",
                pageCount: info?.pageCount ?? 0,
                pages: info?.pages ?? [],
            };
            return docId;
        },

        /** 打开一个文档作为工作区的内容（会清空当前清单）。 */
        async open(path: string) {
            this.loading = true;
            this.error = "";
            try {
                this.reset();
                const docId = await this.registerSource(path);
                const src = this.sources[docId];
                this.seq = buildInitialSeq(docId, src.pageCount);
                this.selected = [];
                this.anchor = "";
                this.current = this.seq.length ? this.seq[0].id : "";

                // 缩略图不在这里全量渲染：轨道的可见性观察会按需补齐，
                // 否则打开 1000 页文档就要先画 1000 张图
                if (this.current) {
                    await this.focusItem(this.current);
                }
                this.markSaved();
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            } finally {
                this.loading = false;
            }
        },

        /**
         * 按需渲染缩略图 —— 大文档性能的关键。
         *
         * 只在轨道里"看得见"的那部分页被请求，滚动时再依次补齐。
         * 若一次性渲染整份文档，1000 页就是一次 python 进程画 1000 张图，
         * 既有几十秒的等待，也会白白占用磁盘与内存。
         */
        async ensureThumbsFor(ids: string[]) {
            const need: Record<string, number[]> = {};
            const seen = new Set<string>();
            for (const id of ids) {
                const i = indexOfId(this.seq, id);
                if (i < 0) continue;
                const it = this.seq[i];
                if (it.kind !== "page") continue;
                const key = this.thumbKey(it.docId, it.pageIndex);
                // 已渲染过、或正在渲染中的都跳过（后者是并发的来源）
                if (this.thumbAsked[key] || inflightThumbs.has(key) || seen.has(key)) continue;
                seen.add(key);
                (need[it.docId] ||= []).push(it.pageIndex);
            }

            for (const docId of Object.keys(need)) {
                const indices = need[docId].sort((a, b) => a - b);
                const spec = indicesToRangeSpec(indices);
                if (!spec) continue;
                for (const i of indices) inflightThumbs.add(this.thumbKey(docId, i));
                try {
                    const list: any = await WorkspaceThumbs(docId, spec, THUMB_WIDTH);
                    const got: Record<string, true> = {};
                    for (const t of list ?? []) {
                        const key = this.thumbKey(docId, t.pageIndex);
                        this.thumbs[key] = t;
                        got[key] = true;
                    }
                    // 只有真的拿到了才算已渲染，失败的下次还会重试
                    for (const i of indices) {
                        const key = this.thumbKey(docId, i);
                        if (got[key]) this.thumbAsked[key] = true;
                    }
                } catch (e: any) {
                    this.error = String(e?.message ?? e);
                } finally {
                    for (const i of indices) inflightThumbs.delete(this.thumbKey(docId, i));
                }
            }
        },

        /** 为整份清单按需渲染缩略图（一般不用直接调，轨道的可见性观察会驱动它）。 */
        async loadThumbs() {
            await this.ensureThumbsFor(allIds(this.seq));
        },

        /** 聚焦到某一项并加载大图。 */
        async focusItem(id: string) {
            const i = indexOfId(this.seq, id);
            if (i < 0) return;
            this.current = id;
            const item = this.seq[i];

            if (item.kind === "blank") {
                // 空白页没有内容可渲染，界面显示占位
                this.preview = null;
                this.previewLoading = false;
                return;
            }

            const key = this.thumbKey(item.docId, item.pageIndex);
            const cached = this.previewCache[key];
            if (cached) {
                this.preview = cached;
                this.previewLoading = false;
                return;
            }

            this.previewLoading = true;
            try {
                let task = inflightPreviews.get(key);
                if (!task) {
                    const docId = item.docId;
                    const pageNo = item.pageIndex + 1;
                    task = (async () => {
                        const list: any = await WorkspaceThumbs(docId, String(pageNo), PREVIEW_WIDTH);
                        return list && list.length ? (list[0] as WSThumb) : null;
                    })();
                    inflightPreviews.set(key, task);
                    // 用完即清（两个分支都处理，避免产生未处理的 rejection）
                    task.then(
                        () => inflightPreviews.delete(key),
                        () => inflightPreviews.delete(key)
                    );
                }
                const got = await task;
                if (got) {
                    this.previewCache[key] = got;
                    // 聚焦已经切走时不要用迟到的结果覆盖当前画面
                    if (this.current === id) this.preview = got;
                }
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            } finally {
                if (this.current === id) this.previewLoading = false;
            }
        },

        // --- 选择 ---------------------------------------------------------

        select(id: string, mode: SelectMode = "replace") {
            if (mode === "toggle") {
                const set = new Set(this.selected);
                if (set.has(id)) set.delete(id);
                else set.add(id);
                this.selected = Array.from(set);
                this.anchor = id;
            } else if (mode === "range" && this.anchor) {
                this.selected = rangeIds(this.seq, this.anchor, id);
            } else {
                this.selected = [id];
                this.anchor = id;
            }
            this.focusItem(id);
        },

        selectAll() {
            this.selected = allIds(this.seq);
            this.anchor = this.selected[0] ?? "";
        },

        clearSelection() {
            this.selected = [];
            this.anchor = "";
        },

        /** 选中项被删掉后清理失效 id，避免残留。 */
        reconcileSelection() {
            const alive = new Set(allIds(this.seq));
            this.selected = this.selected.filter((id) => alive.has(id));
            if (!alive.has(this.current)) {
                this.current = this.seq.length ? this.seq[0].id : "";
                this.anchor = this.current;
                this.preview = null;
                if (this.current) this.focusItem(this.current);
            }
            if (!alive.has(this.anchor)) this.anchor = this.current;
        },

        // --- 编辑操作（统一走撤销栈）---------------------------------------

        /** 应用一份新清单；内容没变就不产生撤销步骤。 */
        apply(next: WSItem[], nextSelection?: string[]) {
            if (sameSeq(this.seq, next)) return;
            this.past.push(snapshot(this.seq));
            if (this.past.length > UNDO_LIMIT) this.past.shift();
            this.future = [];
            this.seq = next;
            if (nextSelection) this.selected = nextSelection.filter((id) => indexOfId(next, id) >= 0);
            this.reconcileSelection();
            this.syncDirty();
        },

        doMove(ids: string[], insertBefore: number) {
            this.apply(moveItems(this.seq, ids, insertBefore), ids);
        },

        // 注意：ids 不要在默认参数里写 this.targetIds —— TS 无法为默认参数
        // 推断 this 类型，必须在函数体内解析。
        doDelete(ids?: string[]) {
            const target = ids ?? this.targetIds;
            if (!target.length) return;
            this.apply(removeItems(this.seq, target), []);
        },

        doDuplicate(ids?: string[]) {
            const target = ids ?? this.targetIds;
            if (!target.length) return;
            const res = duplicateItems(this.seq, target);
            this.apply(res.seq, res.newIds);
        },

        doRotate(delta: number, ids?: string[]) {
            const target = ids ?? this.targetIds;
            if (!target.length) return;
            // 不传 nextSelection：旋转不改变"选中的是哪些页"，只是改了角度。
            // 若在这里重设选区，多选旋转后会莫名其妙塌缩成一项。
            this.apply(rotateItems(this.seq, target, delta));
            // 旋转不改变顺序，但大图要跟着重画
            if (this.current) this.focusItem(this.current);
        },

        // --- 插入（Phase 3）-----------------------------------------------

        /** 在当前位置插入若干项，并把它们设为新的选区。 */
        insertSome(items: WSItem[], at?: number) {
            if (!items.length) return;
            const pos = at ?? this.insertAt;
            const next = insertItems(this.seq, items, pos);
            this.apply(
                next,
                items.map((it) => it.id)
            );
            if (items.length) this.focusItem(items[0].id);
        },

        /** 插入空白页。 */
        insertBlank(count = 1, paper = "A4", orientation: "portrait" | "landscape" = "portrait") {
            const n = Math.max(1, Math.min(200, Math.floor(count)));
            const items: WSItem[] = [];
            for (let i = 0; i < n; i++) items.push(createBlankItem(paper, orientation));
            this.insertSome(items);
        },

        /** 插入某个来源文档的指定页（0-based 下标）。 */
        insertPagesFrom(docId: string, pageIndices: number[]) {
            if (!this.sources[docId]) return;
            this.insertSome(buildPageItems(docId, pageIndices));
        },

        /** 把某个来源文档整体追加到清单末尾。 */
        appendSource(docId: string) {
            const src = this.sources[docId];
            if (!src) return;
            const indices = Array.from({ length: src.pageCount }, (_, i) => i);
            const items = buildPageItems(docId, indices);
            const next = insertItems(this.seq, items, this.seq.length);
            this.apply(
                next,
                items.map((it) => it.id)
            );
            if (items.length) this.focusItem(items[0].id);
        },

        /** 仅保留选中页（导出单个文档前的常用整理动作）。 */
        keepOnlySelected() {
            const target = this.targetIds;
            if (!target.length || target.length === this.seq.length) return;
            this.apply(keepItems(this.seq, target), target);
        },

        /** 反选：选中当前未选中的项。 */
        invertSelection() {
            const set = new Set(this.selected);
            this.selected = allIds(this.seq).filter((id) => !set.has(id));
            this.anchor = this.selected[0] ?? "";
        },

        /** 删除没有内容可言的项之外的空来源（目前仅用于诊断显示）。 */
        sourcePageCount(docId: string): number {
            return this.sources[docId]?.pageCount ?? 0;
        },

        undo() {
            if (!this.past.length) return;
            const prev = this.past.pop() as WSItem[];
            this.future.push(snapshot(this.seq));
            this.seq = prev;
            this.reconcileSelection();
            this.syncDirty();
        },

        redo() {
            if (!this.future.length) return;
            const next = this.future.pop() as WSItem[];
            this.past.push(snapshot(this.seq));
            this.seq = next;
            this.reconcileSelection();
            this.syncDirty();
        },

        // --- 裁剪 / 遮盖（Phase 5，非破坏式）-------------------------------
        //
        // 这些操作只写进清单里的 ops 字段，不碰任何文件；导出时才在 ws-build 里落到 PDF。
        // 好处：撤销天然可用、可以随时改主意、同一份源文件能派生出多个不同结果。

        /** 给若干页设置裁剪区（矩形已换算到页面未旋转空间）。 */
        applyCrop(ids: string[], rect: NormRect) {
            const idSet = new Set(ids);
            const next = this.seq.map((it) => {
                if (!idSet.has(it.id) || it.kind !== "page") return it;
                const ops = cloneOps(it.ops) ?? {};
                ops.crop = { ...rect };
                return { ...it, ops };
            });
            this.apply(next, ids);
        },

        /** 给若干页追加一块遮盖。 */
        applyMask(ids: string[], rect: NormRect, color: string, opacity: number) {
            const idSet = new Set(ids);
            const next = this.seq.map((it) => {
                if (!idSet.has(it.id) || it.kind !== "page") return it;
                const ops = cloneOps(it.ops) ?? {};
                ops.masks = [...(ops.masks ?? []), { rect: { ...rect }, color, opacity }];
                return { ...it, ops };
            });
            this.apply(next, ids);
        },

        /** 撤销若干页上的裁剪与遮盖。 */
        clearOpsOn(ids?: string[]) {
            const target = ids ?? this.targetIds;
            if (!target.length) return;
            this.apply(clearOps(this.seq, target));
        },

        /**
         * 标记若干页在导出时删掉全部批注。
         * 同样是"只改清单、导出才落盘"，因此可以撤销。
         * （按批注类型精细删除仍留在「工具箱」里。）
         */
        toggleRemoveAnnots(ids?: string[]) {
            const target = ids ?? this.targetIds;
            if (!target.length) return;
            const idSet = new Set(target);
            // 若全都已标记，则整体取消；否则整体标记 —— 一个按钮两种状态，符合直觉
            const allMarked = this.seq
                .filter((it) => idSet.has(it.id) && it.kind === "page")
                .every((it) => it.kind === "page" && it.ops?.removeAnnots);
            const next = this.seq.map((it) => {
                if (!idSet.has(it.id) || it.kind !== "page") return it;
                const ops = cloneOps(it.ops) ?? {};
                if (allMarked) delete ops.removeAnnots;
                else ops.removeAnnots = true;
                if (!ops.crop && !ops.masks && !ops.removeAnnots) {
                    const { ops: _drop, ...rest } = it;
                    return rest as typeof it;
                }
                return { ...it, ops };
            });
            this.apply(next, target);
        },

        /** 目标页里有多少已标记"删除批注"。 */
        removeAnnotsCount(ids?: string[]): number {
            const target = new Set(ids ?? this.targetIds);
            return this.seq.filter(
                (it) => target.has(it.id) && it.kind === "page" && it.ops?.removeAnnots
            ).length;
        },

        // --- 保存与导出（Phase 4）-----------------------------------------

        /** 状态指纹：清单 + 装饰。装饰改了也算未保存，否则水印会悄悄丢掉。 */
        signature(): string {
            return JSON.stringify({ seq: this.seq, decor: this.decor });
        },

        /**
         * 用"与上次保存时的指纹比对"来判断是否有未保存的更改。
         * 这样撤销回到已保存的状态时，标记会自动消失，而不是一直亮着。
         */
        syncDirty() {
            const dirty = this.signature() !== this.savedSig;
            if (dirty !== this.dirty) {
                this.dirty = dirty;
                // 同步给 Go，供关闭窗口前拦截使用；失败不影响正常编辑
                WorkspaceSetDirty(dirty).catch(() => undefined);
            }
        },

        markSaved() {
            this.savedSig = this.signature();
            this.dirty = false;
            WorkspaceSetDirty(false).catch(() => undefined);
        },

        /**
         * 组装导出请求的 options。
         * scopeSelected 为真时，把选中页解析成**输出文档里的下标**；
         * 为空数组表示"哪一页都不加"（与缺省的"全部"是不同的语义）。
         */
        decorOptions(): Record<string, unknown> {
            const opts: Record<string, unknown> = {};
            const scopeOf = (useSelected: boolean): number[] | null => {
                if (!useSelected) return null;
                const idx: number[] = [];
                this.seq.forEach((it, i) => {
                    if (this.selected.includes(it.id)) idx.push(i);
                });
                return idx;
            };
            const d = this.decor;

            if (d.watermark.enabled && d.watermark.text.trim()) {
                const w: Record<string, unknown> = {
                    text: d.watermark.text,
                    color: d.watermark.color,
                    fontSize: d.watermark.fontSize,
                    angle: d.watermark.angle,
                    opacity: d.watermark.opacity,
                    multiple: d.watermark.multiple,
                };
                const sc = scopeOf(d.watermark.scopeSelected);
                if (sc) w.scope = sc;
                opts.watermark = w;
            }
            if (d.pageNumber.enabled) {
                const p: Record<string, unknown> = {
                    format: d.pageNumber.format,
                    pos: d.pageNumber.pos,
                    align: d.pageNumber.align,
                    fontSize: d.pageNumber.fontSize,
                    start: d.pageNumber.start,
                };
                const sc = scopeOf(d.pageNumber.scopeSelected);
                if (sc) p.scope = sc;
                opts.pageNumber = p;
            }
            if (d.headerFooter.enabled) {
                const h: Record<string, unknown> = {
                    headerLeft: d.headerFooter.headerLeft,
                    headerCenter: d.headerFooter.headerCenter,
                    headerRight: d.headerFooter.headerRight,
                    footerLeft: d.headerFooter.footerLeft,
                    footerCenter: d.headerFooter.footerCenter,
                    footerRight: d.headerFooter.footerRight,
                    fontSize: d.headerFooter.fontSize,
                };
                const sc = scopeOf(d.headerFooter.scopeSelected);
                if (sc) h.scope = sc;
                opts.headerFooter = h;
            }
            return opts;
        },

        /**
         * 序列化清单供导出。前端只给 docId，真实文件路径由 Go 侧解析——
         * 这样前端始终拿不到本地路径，也不用担心拼接错误。
         */
        itemsPayload(scope: "all" | "selected"): string {
            const picked = scope === "selected" ? new Set(this.selected) : null;
            const items = this.seq
                .filter((it) => !picked || picked.has(it.id))
                .map((it) =>
                    it.kind === "blank"
                        ? { kind: "blank", paper: it.paper, orientation: it.orientation }
                        : {
                              kind: "page",
                              docId: it.docId,
                              pageIndex: it.pageIndex,
                              rotation: it.rotation,
                              // 裁剪/遮盖随页面一起交给后端，Go 只做透传
                              ...(it.ops ? { ops: it.ops } : {}),
                          }
                );
            return JSON.stringify(items);
        },

        async exportTo(
            outFile: string,
            scope: "all" | "selected",
            compress: boolean,
            backup: boolean
        ): Promise<string> {
            this.saving = true;
            this.error = "";
            try {
                const payload = JSON.stringify({
                    items: JSON.parse(this.itemsPayload(scope)),
                    options: this.decorOptions(),
                });
                const msg: string = await WorkspaceBuild(payload, outFile, compress, backup);
                // 输出文件若正好是某个来源，那份来源的内容已经被改写，
                // 清单里指向它的页下标就失效了，必须重新加载，否则后续导出会串页。
                const hitSource = Object.values(this.sources).some((s) => s.path === outFile);
                if (hitSource) {
                    await this.open(outFile);
                } else if (scope === "all") {
                    // 全部内容已落盘，视为没有未保存的更改
                    this.markSaved();
                }
                return msg;
            } finally {
                this.saving = false;
            }
        },

        // --- 无人值守验证用的钩子 ------------------------------------------

        async autoOpenPath(): Promise<string> {
            try {
                return await WorkspaceAutoOpenPath();
            } catch (e) {
                return "";
            }
        },

        async autoOps(): Promise<string> {
            try {
                return await WorkspaceAutoOps();
            } catch (e) {
                return "";
            }
        },
    },
});

export { THUMB_WIDTH, PREVIEW_WIDTH };
