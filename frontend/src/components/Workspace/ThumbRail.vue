<template>
    <div ref="railEl" class="rail" :class="{ dragging }" @scroll="onScroll"
        :style="{ width: railWidth + 'px', flexBasis: railWidth + 'px' }">
        <div v-for="(row, i) in rows" :key="row.id" class="row" :data-index="i" :data-id="row.id" :class="{
            sel: selectedSet.has(row.id),
            cur: row.id === current,
            moved: dragging && dragSet.has(row.id),
            'drop-before': dropIndex === i && !dropAfter,
            'drop-after': dropIndex === i && dropAfter,
            blank: row.kind === 'blank',
        }" @pointerdown="onPointerDown(row, $event)" @click="onClick(row, $event)"
            @contextmenu.prevent="onContextMenu(row, $event)">
            <div class="box" :style="boxStyle(row)">
                <img v-if="row.url" :src="row.url" :style="imgStyle(row)" draggable="false" alt="" />
                <div v-else-if="row.kind === 'blank'" class="blankface">{{ row.paper || "空白页" }}</div>
                <!-- 尚未渲染：用同尺寸的浅灰占位，图片到达时不会引起布局跳动 -->
                <div v-else class="loadingface"></div>
            </div>
            <span class="no">{{ row.label }}</span>
            <span v-if="row.srcLabel" class="src" :style="{ color: row.srcColor }" :title="row.srcPath">
                <template v-if="row.srcTag">{{ row.srcTag }}·</template>p{{ row.srcLabel }}
            </span>
            <span v-if="row.rotation" class="rot">{{ row.rotation }}°</span>
            <!-- 编辑标记：一眼看出哪些页被改动过，否则要逐页点开才知道 -->
            <span v-if="row.ops.crop || row.ops.masks || row.ops.noAnnots" class="edits" :title="opsTitle(row)">
                <i v-if="row.ops.crop" class="dot dot-crop"></i>
                <i v-if="row.ops.masks" class="dot dot-mask"></i>
                <i v-if="row.ops.noAnnots" class="dot dot-annots"></i>
            </span>
        </div>
        <div v-if="!rows.length" class="hint">打开一个 PDF 后，这里会列出每一页</div>

        <!-- 拖拽时跟随光标的提示，让"正在搬几页"一目了然 -->
        <div v-if="dragging" class="ghost" :style="{ left: ghostX + 'px', top: ghostY + 'px' }">
            移动 {{ dragIds.length }} 页
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted, watch, nextTick, type PropType } from 'vue';
import type { RailRow } from './model';

/**
 * 缩略图轨道。
 *
 * 拖拽没有用 HTML5 原生 DnD，而是基于 pointer 事件自己实现，原因有两个：
 * 1. 原生 dragstart 依赖系统拖拽循环，合成鼠标输入触发不了，导致这条核心交互
 *    完全无法自动化验证；
 * 2. 自己实现才能顺手加上边缘自动滚动与拖拽提示。
 * 顺带的好处是鼠标与触摸走同一条代码路径。
 */
export default defineComponent({
    name: 'ThumbRail',
    props: {
        rows: { type: Array as PropType<RailRow[]>, required: true },
        selected: { type: Array as PropType<string[]>, default: () => [] },
        current: { type: String, default: '' },
        /** 当前缩略图宽度。换尺寸后需要重置重试计数，否则换两次就不再补图了 */
        width: { type: Number, default: 150 },
    },
    emits: ['select', 'move', 'need', 'ctx'],
    setup(props, { emit }) {
        const railEl = ref<HTMLElement | null>(null);

        const dragIds = ref<string[]>([]);
        const dragging = ref(false);
        const dropIndex = ref<number>(-1);
        const dropAfter = ref<boolean>(false);
        const ghostX = ref(0);
        const ghostY = ref(0);

        /** 按下但还没越过阈值：此时仍可能是一次点击 */
        let pending: { id: string; x: number; y: number } | null = null;
        /** 拖拽期间缓存各行位置，避免每次移动都去读 1000 个元素的几何信息 */
        let rects: { top: number; bottom: number }[] = [];
        /** 拖拽结束后浏览器可能补发一次 click（落点与起点同一行时），需要忽略，
         *  否则整组拖动原地放下会把选区塌缩成一项。 */
        let justDragged = false;

        const selectedSet = computed(() => new Set(props.selected));
        const dragSet = computed(() => new Set(dragIds.value));

        const cacheRects = () => {
            const els = railEl.value?.querySelectorAll('.row');
            rects = els
                ? Array.from(els).map((el) => {
                    const r = el.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom };
                })
                : [];
        };

        const onScroll = () => {
            if (dragging.value) cacheRects();
        };

        /** 拖到轨道上下边缘时自动滚动，否则长文档里根本拖不到远处 */
        const autoScroll = (clientY: number) => {
            const el = railEl.value;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const margin = 40;
            if (clientY < r.top + margin) {
                el.scrollTop -= 14;
                cacheRects();
            } else if (clientY > r.bottom - margin) {
                el.scrollTop += 14;
                cacheRects();
            }
        };

        const updateDropTarget = (clientY: number) => {
            if (!rects.length) cacheRects();
            let idx = -1;
            let after = false;
            for (let i = 0; i < rects.length; i++) {
                if (clientY >= rects[i].top && clientY <= rects[i].bottom) {
                    idx = i;
                    after = clientY > rects[i].top + (rects[i].bottom - rects[i].top) / 2;
                    break;
                }
            }
            if (idx < 0 && rects.length) {
                // 落在行之外：按在整列表的上方/下方决定插到最前或最后
                if (clientY < rects[0].top) {
                    idx = 0;
                    after = false;
                } else if (clientY > rects[rects.length - 1].bottom) {
                    idx = rects.length - 1;
                    after = true;
                }
            }
            dropIndex.value = idx;
            dropAfter.value = after;
        };

        const resetDrag = () => {
            dragging.value = false;
            dragIds.value = [];
            dropIndex.value = -1;
            dropAfter.value = false;
            rects = [];
        };

        const onPointerDown = (row: RailRow, e: PointerEvent) => {
            if (e.button !== 0) return;
            pending = { id: row.id, x: e.clientX, y: e.clientY };
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        };

        const onPointerMove = (e: PointerEvent) => {
            ghostX.value = e.clientX;
            ghostY.value = e.clientY;

            if (!dragging.value) {
                if (!pending) return;
                // 超过阈值才算拖拽，否则保留为点击，避免手抖误触发排序
                if (Math.abs(e.clientY - pending.y) + Math.abs(e.clientX - pending.x) < 5) return;

                dragging.value = true;
                if (props.selected.includes(pending.id)) {
                    // 拖动选区中的任意一项 = 拖动整组
                    dragIds.value = [...props.selected];
                } else {
                    dragIds.value = [pending.id];
                    emit('select', pending.id, 'replace');
                }
                cacheRects();
            }
            autoScroll(e.clientY);
            updateDropTarget(e.clientY);
        };

        const onPointerUp = () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);

            if (dragging.value) {
                const ids = dragIds.value;
                // insertBefore 用原数组坐标：插到第 idx 行之前；落在下半区则插到它之后
                const insertBefore = dropIndex.value + (dropAfter.value ? 1 : 0);
                const valid = dropIndex.value >= 0 && ids.length > 0;
                resetDrag();
                pending = null;
                justDragged = true;
                window.setTimeout(() => {
                    justDragged = false;
                }, 0);
                if (valid) emit('move', ids, insertBefore);
                return;
            }
            pending = null;
        };

        const onClick = (row: RailRow, e: MouseEvent) => {
            if (justDragged) return;
            const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace';
            emit('select', row.id, mode);
        };

        /** 右键菜单：先保证该行被选中，再把坐标交给上层去弹菜单 */
        const onContextMenu = (row: RailRow, e: MouseEvent) => {
            if (!props.selected.includes(row.id)) emit('select', row.id, 'replace');
            emit('ctx', row.id, e.clientX, e.clientY);
        };

        // --- 按需渲染：只请求"看得见"的页 -----------------------------------
        //
        // 大文档性能的关键。若一次性渲染整份文档的缩略图，1000 页就是一次 python
        // 进程画 1000 张图；这里只报告进入视口（含预取边距）的行，滚动时再补齐。
        let observer: IntersectionObserver | null = null;
        let pendingIds: string[] = [];
        let flushTimer: number | null = null;
        /** 当前在视口内的行，用于在渲染失败后重试 */
        const visible = new Set<string>();
        /** 每行的请求次数，避免失败后无限重试 */
        const attempts: Record<string, number> = {};

        const queueNeed = (id: string) => {
            const n = (attempts[id] ?? 0) + 1;
            if (n > 2) return;
            attempts[id] = n;
            if (!pendingIds.includes(id)) pendingIds.push(id);
            if (flushTimer !== null) return;
            // 一屏内十几行会几乎同时进入视口，合并成一次请求
            flushTimer = window.setTimeout(() => {
                flushTimer = null;
                const ids = pendingIds;
                pendingIds = [];
                if (ids.length) emit('need', ids);
            }, 40);
        };

        const idsSignature = computed(() => props.rows.map((r) => r.id).join(','));
        const loadedSignature = computed(() => props.rows.map((r) => (r.loaded ? '1' : '0')).join(''));

        const observeAll = () => {
            if (!observer) return;
            observer.disconnect();
            visible.clear();
            railEl.value?.querySelectorAll('.row').forEach((el) => observer!.observe(el));
        };

        onMounted(() => {
            if (typeof IntersectionObserver === 'undefined') {
                // 环境不支持时退化为"全部请求"，正确性优先
                emit('need', props.rows.filter((r) => !r.loaded).map((r) => r.id));
                return;
            }
            observer = new IntersectionObserver(
                (entries) => {
                    for (const e of entries) {
                        const el = e.target as HTMLElement;
                        const row = props.rows[Number(el.dataset.index)];
                        if (!row) continue;
                        if (e.isIntersecting) {
                            visible.add(row.id);
                            if (!row.loaded) queueNeed(row.id);
                        } else {
                            visible.delete(row.id);
                        }
                    }
                },
                // 预取边距：提前一屏多就开始渲染，滚动时基本看不到空位
                { root: railEl.value, rootMargin: '700px 0px' }
            );
            observeAll();
        });

        onUnmounted(() => {
            if (flushTimer !== null) window.clearTimeout(flushTimer);
            observer?.disconnect();
        });

        // 清单增删/重排后元素被复用或替换，需要重新观察
        watch(idsSignature, () => {
            nextTick(observeAll);
        });

        // 缩略图尺寸变化：整套图都要按新宽度重渲染，重试计数必须重置
        watch(
            () => props.width,
            () => {
                for (const k of Object.keys(attempts)) delete attempts[k];
                nextTick(() => {
                    const ids = props.rows.filter((r) => visible.has(r.id) && !r.loaded).map((r) => r.id);
                    ids.forEach(queueNeed);
                });
            }
        );

        // 若某次渲染没成功，行仍会停在"未加载"；这里对仍在视口内的行再试一次
        // （attempts 上限保证不会无限重试）
        watch(loadedSignature, () => {
            const retry = props.rows.filter((r) => visible.has(r.id) && !r.loaded).map((r) => r.id);
            retry.forEach(queueNeed);
        });

        const isRot90 = (r: number) => r === 90 || r === 270;

        /** 编辑标记的悬停说明 */
        const opsTitle = (row: RailRow) => {
            const parts: string[] = [];
            if (row.ops.crop) parts.push('已裁剪');
            if (row.ops.masks) parts.push(`遮盖 ${row.ops.masks} 处`);
            if (row.ops.noAnnots) parts.push('导出时删除批注');
            return parts.join(' · ');
        };

        // 轨道宽度跟着缩略图尺寸走：写死宽度会让"大图"被裁掉右边。
        // 34 = 轨道内边距 20 + 行内边距 8 + 行边框 4 + 留一点给滚动条
        const railWidth = computed(() => props.width + 34);

        /** 容器尺寸 = 旋转之后的显示尺寸 */
        const boxStyle = (row: RailRow) => {
            const w = isRot90(row.rotation) ? row.h : row.w;
            const h = isRot90(row.rotation) ? row.w : row.h;
            return { width: `${w}px`, height: `${h}px` };
        };

        /** 图片按原始尺寸摆放，再整体旋转，因此旋转前后都能正好填满容器 */
        const imgStyle = (row: RailRow) => ({
            width: `${row.w}px`,
            height: `${row.h}px`,
            transform: `translate(-50%, -50%) rotate(${row.rotation}deg)`,
        });

        // 当前页变化时把它滚进视野。键盘翻页时尤其需要，
        // 否则翻到第 80 页而轨道还停在原处，看不出自己到了哪。
        watch(
            () => props.current,
            async (id) => {
                await nextTick();
                const el = railEl.value?.querySelector(`.row[data-id="${id}"]`) as HTMLElement | null;
                el?.scrollIntoView({ block: 'nearest' });
            }
        );

        return {
            railEl,
            railWidth,
            selectedSet,
            dragSet,
            dragging,
            dragIds,
            dropIndex,
            dropAfter,
            ghostX,
            ghostY,
            onPointerDown,
            onClick,
            onContextMenu,
            onScroll,
            opsTitle,
            boxStyle,
            imgStyle,
        };
    },
});
</script>

<style scoped>
.rail {
    position: relative;
    /* 宽度由内联样式按缩略图尺寸给出 */
    min-width: 140px;
    overflow-y: auto;
    overflow-x: hidden;
    background: #fafafa;
    border-right: 1px solid #e8e8e8;
    padding: 10px;
}

.rail.dragging {
    cursor: grabbing;
}

.row {
    position: relative;
    margin-bottom: 10px;
    padding: 4px;
    border: 2px solid transparent;
    border-radius: 4px;
    background: #fff;
    cursor: grab;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    user-select: none;
    touch-action: none;
}

.row.sel {
    border-color: #91caff;
    background: #e6f4ff;
}

.row.cur {
    border-color: #1677ff;
    box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.15);
}

.row.moved {
    opacity: 0.45;
}

/* 插入位置指示线 */
.row.drop-before::before,
.row.drop-after::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    background: #1677ff;
    border-radius: 2px;
}

.row.drop-before::before {
    top: -6px;
}

.row.drop-after::after {
    bottom: -6px;
}

.box {
    position: relative;
    overflow: hidden;
    margin: 0 auto;
    background: #fff;
}

.box img {
    position: absolute;
    left: 50%;
    top: 50%;
    display: block;
}

.blankface {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 150px;
    height: 212px;
    color: #bbb;
    font-size: 12px;
    border: 1px dashed #ddd;
}

.loadingface {
    width: 100%;
    height: 100%;
    background: repeating-linear-gradient(45deg, #f5f5f5, #f5f5f5 6px, #ececec 6px, #ececec 12px);
}

.no {
    position: absolute;
    right: 6px;
    bottom: 4px;
    font-size: 11px;
    color: #555;
    background: rgba(255, 255, 255, 0.9);
    border-radius: 3px;
    padding: 0 4px;
}

.src {
    position: absolute;
    left: 6px;
    bottom: 4px;
    font-size: 10px;
    font-weight: 600;
    background: rgba(255, 255, 255, 0.9);
    border-radius: 3px;
    padding: 0 3px;
}

.rot {
    position: absolute;
    right: 6px;
    top: 4px;
    font-size: 10px;
    color: #d46b08;
    background: #fff7e6;
    border-radius: 3px;
    padding: 0 3px;
}

/* 编辑标记：一排小圆点，鼠标悬停给出文字说明 */
.edits {
    position: absolute;
    left: 6px;
    top: 5px;
    display: flex;
    gap: 3px;
    padding: 2px 3px;
    background: rgba(255, 255, 255, 0.9);
    border-radius: 3px;
}

.dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: block;
}

.dot-crop {
    background: #1677ff;
}

.dot-mask {
    background: #cf1322;
}

.dot-annots {
    background: #d46b08;
}

.ghost {
    position: fixed;
    z-index: 9999;
    pointer-events: none;
    transform: translate(14px, 14px);
    background: #1677ff;
    color: #fff;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 10px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.hint {
    color: #999;
    font-size: 13px;
    text-align: center;
    padding: 20px 8px;
    line-height: 1.8;
}
</style>
