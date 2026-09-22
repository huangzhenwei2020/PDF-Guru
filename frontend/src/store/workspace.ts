import { defineStore } from "pinia";
import { WorkspaceOpen, WorkspaceThumbs, WorkspaceCacheRoot } from "../../wailsjs/go/main/App";

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
// 两者宽度不同，Go 侧的清单文件按宽度分开存放，因此可以各自渲染互不干扰。
const THUMB_WIDTH = 150;
const PREVIEW_WIDTH = 900;

export const WS_THUMB_WIDTH = THUMB_WIDTH;
export const WS_PREVIEW_WIDTH = PREVIEW_WIDTH;

export const useWorkspaceState = defineStore("WorkspaceState", {
    state: () => ({
        docId: "",
        path: "",
        pageCount: 0,
        pages: [] as WSPage[],
        thumbs: [] as WSThumb[],
        preview: null as WSThumb | null,
        current: 0, // 当前页（0-based）
        cacheRoot: "",
        loading: false,
        previewLoading: false,
        error: "",
    }),
    getters: {
        currentPage(): WSPage | null {
            return this.pages[this.current] ?? null;
        },
    },
    actions: {
        reset() {
            this.$patch({
                docId: "",
                path: "",
                pageCount: 0,
                pages: [],
                thumbs: [],
                preview: null,
                current: 0,
                error: "",
            });
        },
        // 仅用于诊断：把缓存目录显示在界面上，方便排查供图问题
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
                this.docId = info?.docId ?? "";
                this.path = info?.path ?? path;
                this.pageCount = info?.pageCount ?? 0;
                this.pages = info?.pages ?? [];
                this.thumbs = [];
                this.preview = null;
                this.current = 0;

                await this.loadThumbs();
                if (this.pageCount > 0) {
                    await this.selectPage(0);
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
                this.thumbs = list ?? [];
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            }
        },
        async selectPage(index: number) {
            this.current = index;
            if (!this.docId) return;
            this.previewLoading = true;
            try {
                // 单页渲染成大图，走的是同一套供图机制
                const list: any = await WorkspaceThumbs(this.docId, String(index + 1), PREVIEW_WIDTH);
                this.preview = list && list.length ? list[0] : null;
            } catch (e: any) {
                this.error = String(e?.message ?? e);
            } finally {
                this.previewLoading = false;
            }
        },
    },
});
