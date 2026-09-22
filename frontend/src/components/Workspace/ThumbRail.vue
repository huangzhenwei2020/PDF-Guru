<template>
    <div class="rail">
        <div v-for="(row, i) in rows" :key="row.id" class="row" :class="{
            sel: selectedSet.has(row.id),
            cur: row.id === current,
            'drop-before': dropIndex === i && !dropAfter,
            'drop-after': dropIndex === i && dropAfter,
            blank: row.kind === 'blank',
        }" draggable="true" @dragstart="onDragStart(row, $event)" @dragover="onDragOver(i, $event)"
            @drop="onDrop(i, $event)" @dragend="onDragEnd" @click="onClick(row, $event)">
            <div class="box" :style="boxStyle(row)">
                <img v-if="row.url" :src="row.url" :style="imgStyle(row)" draggable="false" alt="" />
                <div v-else class="blankface">{{ row.paper || "空白页" }}</div>
            </div>
            <span class="no">{{ row.label }}</span>
            <span v-if="row.srcLabel" class="src">源 p{{ row.srcLabel }}</span>
            <span v-if="row.rotation" class="rot">{{ row.rotation }}°</span>
        </div>
        <div v-if="!rows.length" class="hint">打开一个 PDF 后，这里会列出每一页</div>
    </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, type PropType } from 'vue';
import type { RailRow } from './model';

export default defineComponent({
    name: 'ThumbRail',
    props: {
        rows: { type: Array as PropType<RailRow[]>, required: true },
        selected: { type: Array as PropType<string[]>, default: () => [] },
        current: { type: String, default: '' },
    },
    emits: ['select', 'move', 'focus'],
    setup(props, { emit }) {
        // 拖拽期间的状态。dragIds 在 dragstart 时确定，因此"拖一个即拖一组"
        // 是天然成立的：拖动已选中的任意一项，整组都会跟着走。
        const dragIds = ref<string[]>([]);
        const dropIndex = ref<number>(-1);
        const dropAfter = ref<boolean>(false);

        const selectedSet = computed(() => new Set(props.selected));

        const onDragStart = (row: RailRow, e: DragEvent) => {
            const inSelection = props.selected.includes(row.id);
            if (!inSelection) {
                emit('select', row.id, 'replace');
                dragIds.value = [row.id];
            } else {
                dragIds.value = [...props.selected];
            }
            // 某些 WebView 只有设置了数据才会真正开始拖拽
            e.dataTransfer?.setData('text/plain', row.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        };

        const onDragOver = (i: number, e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            const el = e.currentTarget as HTMLElement;
            const rect = el.getBoundingClientRect();
            dropIndex.value = i;
            dropAfter.value = e.clientY > rect.top + rect.height / 2;
        };

        const onDrop = (i: number, e: DragEvent) => {
            e.preventDefault();
            const ids = dragIds.value;
            // insertBefore 用原数组坐标：插到第 i 项之前，落在下半区则插到它之后
            const insertBefore = i + (dropAfter.value ? 1 : 0);
            onDragEnd();
            if (ids.length) emit('move', ids, insertBefore);
        };

        const onDragEnd = () => {
            dragIds.value = [];
            dropIndex.value = -1;
            dropAfter.value = false;
        };

        const onClick = (row: RailRow, e: MouseEvent) => {
            const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace';
            emit('select', row.id, mode);
        };

        const isRot90 = (r: number) => r === 90 || r === 270;

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

        return {
            selectedSet,
            dropIndex,
            dropAfter,
            onDragStart,
            onDragOver,
            onDrop,
            onDragEnd,
            onClick,
            boxStyle,
            imgStyle,
        };
    },
});
</script>

<style scoped>
.rail {
    width: 200px;
    flex: 0 0 200px;
    overflow-y: auto;
    background: #fafafa;
    border-right: 1px solid #e8e8e8;
    padding: 10px;
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
}

.row:active {
    cursor: grabbing;
}

.row.sel {
    border-color: #91caff;
    background: #e6f4ff;
}

.row.cur {
    border-color: #1677ff;
    box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.15);
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
    color: #aaa;
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

.hint {
    color: #999;
    font-size: 13px;
    text-align: center;
    padding: 20px 8px;
    line-height: 1.8;
}
</style>
