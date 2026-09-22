<template>
    <div class="ws">
        <!-- 工具栏 -->
        <div class="ws-toolbar">
            <a-button type="primary" :loading="store.loading" @click="pickFile">
                <template #icon>
                    <folder-open-outlined />
                </template>
                打开 PDF
            </a-button>

            <a-divider type="vertical" />

            <a-tooltip title="撤销 (Ctrl+Z)">
                <a-button :disabled="!store.canUndo" @click="store.undo()">
                    <template #icon>
                        <undo-outlined />
                    </template>
                </a-button>
            </a-tooltip>
            <a-tooltip title="重做 (Ctrl+Y)">
                <a-button :disabled="!store.canRedo" @click="store.redo()">
                    <template #icon>
                        <redo-outlined />
                    </template>
                </a-button>
            </a-tooltip>

            <a-divider type="vertical" />

            <a-tooltip title="逆时针旋转 90° ([)">
                <a-button :disabled="!canEdit" @click="store.doRotate(-90)">
                    <template #icon>
                        <rotate-left-outlined />
                    </template>
                </a-button>
            </a-tooltip>
            <a-tooltip title="顺时针旋转 90° (])">
                <a-button :disabled="!canEdit" @click="store.doRotate(90)">
                    <template #icon>
                        <rotate-right-outlined />
                    </template>
                </a-button>
            </a-tooltip>
            <a-tooltip title="复制所选页面 (Ctrl+D)">
                <a-button :disabled="!canEdit" @click="store.doDuplicate()">
                    <template #icon>
                        <copy-outlined />
                    </template>
                </a-button>
            </a-tooltip>
            <a-tooltip title="删除所选页面 (Delete)">
                <a-button danger :disabled="!canEdit" @click="store.doDelete()">
                    <template #icon>
                        <delete-outlined />
                    </template>
                </a-button>
            </a-tooltip>

            <a-divider type="vertical" />

            <a-button size="small" :disabled="!store.seq.length" @click="store.selectAll()">全选</a-button>
            <a-button size="small" :disabled="!store.selected.length" @click="store.clearSelection()">取消选择</a-button>

            <span class="ws-spacer"></span>
            <a-tag v-if="urlMode === 'origin'" color="orange">图源: origin</a-tag>
            <a-tag v-if="imgFailed" color="red">图片加载失败</a-tag>
            <span class="ws-meta" v-if="store.pageCount">
                {{ store.seq.length }} 页
                <template v-if="store.selected.length"> · 已选 {{ store.selected.length }}</template>
            </span>
        </div>

        <a-alert v-if="store.error" type="error" show-icon closable :message="store.error" class="ws-alert"
            @close="store.error = ''" />

        <!-- 主体：左轨道 + 右画布 -->
        <div class="ws-body">
            <ThumbRail :rows="rows" :selected="store.selected" :current="store.current" @select="onSelect"
                @move="onMove" />

            <div ref="canvasRef" class="ws-canvas">
                <div v-if="store.previewLoading" class="ws-hint">渲染中…</div>

                <!-- 空白页 -->
                <div v-else-if="view && view.blank" class="ws-blank">
                    <file-outlined />
                    <div>空白页</div>
                    <small>导出时按所选纸张插入</small>
                </div>

                <!-- 页面预览：旋转与缩放分层处理，每层只做一件事，
                     避免多个 transform 揉在一起后难以推理 -->
                <div v-else-if="view" class="pv-fit" :style="{ width: view.fitW + 'px', height: view.fitH + 'px' }">
                    <div class="pv-box" :style="{
                        width: view.dispW + 'px',
                        height: view.dispH + 'px',
                        transform: `scale(${view.scale})`,
                    }">
                        <img :src="url(store.preview!.url)" :style="{
                            width: view.imgW + 'px',
                            height: view.imgH + 'px',
                            transform: `translate(-50%, -50%) rotate(${view.rot}deg)`,
                        }" alt="" @error="onImgError" />
                    </div>
                </div>

                <div v-else class="ws-hint">
                    {{ store.seq.length ? "选择左侧任意一页查看大图" : "打开一个 PDF 开始" }}
                </div>
            </div>
        </div>

        <!-- 诊断条：供图是本方案的地基，把关键状态摊在界面上，出问题截图即可定位 -->
        <div class="ws-diag">
            docId={{ store.docId || "-" }} · origin={{ origin }} · urlMode={{ urlMode }} ·
            清单={{ store.seq.length }} · 已选={{ store.selected.length }} · 撤销栈={{ store.past.length }} ·
            重做栈={{ store.future.length }} · 当前={{ currentPos }} {{ autoLog }}
        </div>
    </div>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, onUnmounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
    CopyOutlined,
    DeleteOutlined,
    FileOutlined,
    FolderOpenOutlined,
    RedoOutlined,
    RotateLeftOutlined,
    RotateRightOutlined,
    UndoOutlined,
} from '@ant-design/icons-vue';
import { SelectFile } from '../../../wailsjs/go/main/App';
import { useWorkspaceState } from '../../store/workspace';
import { indexOfId, type RailRow } from './model';
import { runOps } from './devops';
import ThumbRail from './ThumbRail.vue';

export default defineComponent({
    components: {
        CopyOutlined,
        DeleteOutlined,
        FileOutlined,
        FolderOpenOutlined,
        RedoOutlined,
        RotateLeftOutlined,
        RotateRightOutlined,
        UndoOutlined,
        ThumbRail,
    },
    setup() {
        const store = useWorkspaceState();
        const origin = window.location.origin;
        const autoLog = ref('');

        // Wails 生产环境是 http://wails.localhost，相对路径可直接用；
        // 这里仍保留 origin 形式的降级，作为其它平台/协议的保险。
        const urlMode = ref<'relative' | 'origin'>('relative');
        const imgFailed = ref(false);

        const url = (u: string) => {
            if (!u) return '';
            if (urlMode.value === 'origin' && origin && origin !== 'null') {
                return origin.replace(/\/$/, '') + u;
            }
            return u;
        };
        const onImgError = () => {
            if (urlMode.value === 'relative' && origin && origin !== 'null') {
                urlMode.value = 'origin';
            } else {
                imgFailed.value = true;
            }
        };

        // --- 缩略图轨道的数据 ---------------------------------------------

        const rows = computed<RailRow[]>(() =>
            store.seq.map((item, i) => {
                const t = store.thumbOf(item);
                return {
                    id: item.id,
                    kind: item.kind,
                    label: i + 1,
                    // 源页码：让用户知道这一页原本是文档的第几页（拖动后会不一致）
                    srcLabel: item.kind === 'page' ? item.pageIndex + 1 : 0,
                    rotation: item.kind === 'page' ? item.rotation : 0,
                    url: t ? url(t.url) : '',
                    w: t ? t.width : 150,
                    h: t ? t.height : 212,
                    paper: item.kind === 'blank' ? item.paper : undefined,
                };
            })
        );

        const currentPos = computed(() => {
            const i = indexOfId(store.seq, store.current);
            return i >= 0 ? `${i + 1}/${store.seq.length}` : "-";
        });

        const canEdit = computed(() => store.targetIds.length > 0);

        // --- 画布内的预览自适应 -------------------------------------------

        const canvasRef = ref<HTMLElement | null>(null);
        const canvasW = ref(800);
        const canvasH = ref(500);
        let ro: ResizeObserver | null = null;

        const view = computed(() => {
            const item = store.currentItem;
            if (!item) return null;
            if (item.kind === 'blank') {
                return { blank: true } as any;
            }
            const p = store.preview;
            if (!p) return null;
            const rot = item.rotation || 0;
            const rot90 = rot === 90 || rot === 270;
            // 旋转 90/270 后，显示尺寸要交换
            const dispW = rot90 ? p.height : p.width;
            const dispH = rot90 ? p.width : p.height;
            const availW = Math.max(120, canvasW.value - 26);
            const availH = Math.max(120, canvasH.value - 26);
            const scale = Math.min(1, availW / dispW, availH / dispH);
            return {
                blank: false,
                imgW: p.width,
                imgH: p.height,
                rot,
                dispW,
                dispH,
                scale,
                fitW: Math.round(dispW * scale),
                fitH: Math.round(dispH * scale),
            };
        });

        // --- 交互 ---------------------------------------------------------

        const onSelect = (id: string, mode: string) => {
            store.select(id, mode as any);
        };

        const onMove = (ids: string[], insertBefore: number) => {
            store.doMove(ids, insertBefore);
        };

        const pickFile = async () => {
            try {
                const p: string = await SelectFile();
                if (!p) return;
                if (!p.toLowerCase().endsWith('.pdf')) {
                    message.error('请选择 PDF 文件');
                    return;
                }
                imgFailed.value = false;
                urlMode.value = 'relative';
                await store.open(p);
                if (store.error) message.error(store.error);
            } catch (e: any) {
                message.error(String(e?.message ?? e));
            }
        };

        const onKey = (e: KeyboardEvent) => {
            if (!store.docId) return;
            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) store.redo();
                else store.undo();
            } else if (ctrl && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                store.redo();
            } else if (ctrl && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                store.selectAll();
            } else if (ctrl && e.key.toLowerCase() === 'd') {
                e.preventDefault();
                store.doDuplicate();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                store.doDelete();
            } else if (e.key === '[') {
                e.preventDefault();
                store.doRotate(-90);
            } else if (e.key === ']') {
                e.preventDefault();
                store.doRotate(90);
            }
        };

        onMounted(async () => {
            store.loadCacheRoot();
            window.addEventListener('keydown', onKey);
            if (canvasRef.value && typeof ResizeObserver !== 'undefined') {
                ro = new ResizeObserver(() => {
                    const el = canvasRef.value;
                    if (!el) return;
                    canvasW.value = el.clientWidth;
                    canvasH.value = el.clientHeight;
                });
                ro.observe(canvasRef.value);
            }

            // 无人值守验证钩子：自动打开文档并执行一段操作脚本
            try {
                const auto = await store.autoOpenPath();
                if (auto) {
                    await store.open(auto);
                    const script = await store.autoOps();
                    if (script) {
                        const log = runOps(store, script);
                        autoLog.value = `· autoops=[${log.join(" ")}]`;
                        // 脚本可能把当前页删掉了，把大图重新对齐一次
                        if (store.current) await store.focusItem(store.current);
                    }
                }
            } catch (e) {
                // 未设置这些变量时忽略
            }
        });

        onUnmounted(() => {
            window.removeEventListener('keydown', onKey);
            if (ro) ro.disconnect();
        });

        return {
            store,
            rows,
            url,
            onImgError,
            urlMode,
            imgFailed,
            origin,
            currentPos,
            canEdit,
            view,
            canvasRef,
            onSelect,
            onMove,
            pickFile,
            autoLog,
        };
    },
});
</script>

<style scoped>
.ws {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    margin-right: 2vw;
}

.ws-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0 10px;
}

.ws-spacer {
    flex: 1;
}

.ws-meta {
    color: #555;
    font-size: 13px;
}

.ws-alert {
    margin-bottom: 8px;
}

.ws-body {
    flex: 1;
    display: flex;
    min-height: 0;
    border: 1px solid #e8e8e8;
    border-radius: 8px;
    overflow: hidden;
}

.ws-canvas {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #f0f2f5;
    padding: 12px;
}

/* 外层只负责占位（已缩放的尺寸），内层负责缩放，图片负责旋转 */
.pv-fit {
    position: relative;
}

.pv-box {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: top left;
}

.pv-box img {
    position: absolute;
    left: 50%;
    top: 50%;
    display: block;
    background: #fff;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
}

.ws-blank {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    color: #aaa;
    font-size: 14px;
}

.ws-blank small {
    font-size: 11px;
    color: #bbb;
}

.ws-hint {
    color: #999;
    font-size: 13px;
    text-align: center;
    padding: 20px 8px;
    line-height: 1.8;
}

.ws-diag {
    margin-top: 6px;
    font-size: 11px;
    color: #aaa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
