import { defineStore } from "pinia";
import {
    WorkspaceOpen,
    WorkspaceThumbs,
    WorkspaceCacheRoot,
    WorkspaceAutoOpenPath,
    WorkspaceAutoOps,
} from "../../wailsjs/go/main/App";
import {
    allIds,
    buildInitialSeq,
    duplicateItems,
    indexOfId,
    moveItems,
    rangeIds,
    removeItems,
    rotateItems,
    sameSeq,
    snapshot,
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

// 缩略图轨道用 150px，大图预览用 900px。
// Go 侧的清单文件按宽度分开存放，因此两者可以各自渲染互不干扰。
const THUMB_WIDTH = 150;
const PREVIEW_WIDTH = 900;

/** 撤销栈上限。一份 1000 页清单的快照约 60KB，100 步也只有 6MB。 */
const UNDO_LIMIT = 100;

export const WS_THUMB_WIDTH = THUMB_WIDTH;
export const WS_PREVIEW_WIDTH = PREVIEW_WIDTH;

export type SelectMode = "replace" | "toggle" | "range";

export const useWorkspaceState = defineStore("WorkspaceState", {
    state: () => ({
        docId: "",
        path: "",
        pageCount: 0,
        /** 源文档结构，只读，用于显示尺寸/旋转等信息 */
        pages: [] as WSPage[],
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
        preview: null as WSThumb | null,
        /** 撤销 / 重做栈，存的是清单快照 */
        past: [] as WSItem[][],
        future: [] as WSItem[][],
        cacheRoot: "",
        loading: false,
        previewLoading: false,
        error: "",
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

        reset() {
            this.$patch({
                docId: "",
                path: "",
                pageCount: 0,
                pages: [],
                seq: [],
                selected: [],
                anchor: "",
                current: "",
                thumbs: {},
                preview: null,
                past: [],
                future: [],
                error: "",
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

        async open(path: string) {
            this.loading = true;
            this.error = "";
            try {
                const info: any = await WorkspaceOpen(path);
                const docId: string = info?.docId ?? "";
                this.docId = docId;
                this.path = info?.path ?? path;
                this.pageCount = info?.pageCount ?? 0;
                this.pages = info?.pages ?? [];

                // 建立初始清单：顺序与源文档一致
                this.seq = buildInitialSeq(docId, this.pageCount);
                this.selected = [];
                this.anchor = "";
                this.current = this.seq.length ? this.seq[0].id : "";
                this.past = [];
                this.future = [];
                this.preview = null;
                this.thumbs = {};

                await this.loadThumbs();
                if (this.current) {
                    await this.focusItem(this.current);
                }
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            } finally {
                this.loading = false;
            }
        },

        async loadThumbs() {
            if (!this.docId) return;
            try {
                const list: any = await WorkspaceThumbs(this.docId, "all", THUMB_WIDTH);
                const map: Record<string, WSThumb> = {};
                for (const t of list ?? []) {
                    map[this.thumbKey(this.docId, t.pageIndex)] = t;
                }
                this.thumbs = map;
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            }
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

            this.previewLoading = true;
            try {
                const list: any = await WorkspaceThumbs(this.docId, String(item.pageIndex + 1), PREVIEW_WIDTH);
                this.preview = list && list.length ? list[0] : null;
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            } finally {
                this.previewLoading = false;
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

        undo() {
            if (!this.past.length) return;
            const prev = this.past.pop() as WSItem[];
            this.future.push(snapshot(this.seq));
            this.seq = prev;
            this.reconcileSelection();
        },

        redo() {
            if (!this.future.length) return;
            const next = this.future.pop() as WSItem[];
            this.past.push(snapshot(this.seq));
            this.seq = next;
            this.reconcileSelection();
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
