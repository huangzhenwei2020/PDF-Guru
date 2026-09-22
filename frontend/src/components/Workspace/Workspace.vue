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

            <a-dropdown :trigger="['click']">
                <a-button :disabled="!store.seq.length">
                    <template #icon>
                        <plus-outlined />
                    </template>
                    插入
                    <down-outlined />
                </a-button>
                <template #overlay>
                    <a-menu @click="onInsertMenu">
                        <a-menu-item key="blank">插入空白页…</a-menu-item>
                        <a-menu-item key="pdf">从 PDF 插入页面…</a-menu-item>
                        <a-menu-item key="append">追加整个 PDF…</a-menu-item>
                        <a-menu-item key="images">插入图片…</a-menu-item>
                        <a-menu-divider />
                        <a-menu-item key="keep">仅保留选中页</a-menu-item>
                        <a-menu-item key="invert">反选</a-menu-item>
                    </a-menu>
                </template>
            </a-dropdown>

            <a-divider type="vertical" />

            <a-tooltip :title="store.dirty ? '保存到 ' + store.mainPath : '没有未保存的更改'">
                <a-button :type="store.dirty ? 'primary' : 'default'" :disabled="!store.seq.length || !store.mainPath"
                    :loading="store.saving" @click="doSave">
                    <template #icon>
                        <save-outlined />
                    </template>
                    保存
                </a-button>
            </a-tooltip>
            <a-tooltip title="导出为新的 PDF（Ctrl+Shift+S）">
                <a-button :disabled="!store.seq.length" :loading="store.saving" @click="openExport">
                    <template #icon>
                        <export-outlined />
                    </template>
                    导出
                </a-button>
            </a-tooltip>
            <a-tooltip title="水印 / 页码 / 页眉页脚（导出时应用，不改源文件）">
                <a-button :disabled="!store.seq.length" @click="decorVisible = true">
                    <template #icon>
                        <font-size-outlined />
                    </template>
                    页面装饰
                </a-button>
            </a-tooltip>

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
            <a-tag v-if="store.dirty" color="orange">未保存</a-tag>
            <a-tag v-if="urlMode === 'origin'" color="orange">图源: origin</a-tag>
            <a-tag v-if="imgFailed" color="red">图片加载失败</a-tag>
            <span class="ws-meta" v-if="store.seq.length">
                {{ store.seq.length }} 页
                <template v-if="store.selected.length"> · 已选 {{ store.selected.length }}</template>
                <template v-if="store.sourceList.length > 1"> · {{ store.sourceList.length }} 个来源</template>
            </span>
        </div>

        <a-alert v-if="store.error" type="error" show-icon closable :message="store.error" class="ws-alert"
            @close="store.error = ''" />

        <!-- 主体：左轨道 + 右画布 -->
        <div class="ws-body">
            <ThumbRail :rows="rows" :selected="store.selected" :current="store.current" :width="store.thumbWidth"
                @select="onSelect" @move="onMove" @need="onNeedThumbs" />

            <div ref="canvasRef" class="ws-canvas">
                <!-- 页面内容工具：裁剪/遮盖靠在这块区域上拖框完成 -->
                <div class="ws-modes">
                    <a-radio-group v-model:value="mode" size="small" button-style="solid">
                        <a-radio-button value="view">浏览</a-radio-button>
                        <a-radio-button value="crop">裁剪</a-radio-button>
                        <a-radio-button value="mask">遮盖</a-radio-button>
                    </a-radio-group>
                    <a-radio-group :value="store.viewMode" size="small" button-style="solid"
                        @update:value="onViewModeChange">
                        <a-radio-button value="single">单页</a-radio-button>
                        <a-radio-button value="dual">双页</a-radio-button>
                    </a-radio-group>
                    <a-select :value="store.thumbWidth" size="small" style="width: 96px" :options="thumbSizeOptions"
                        @update:value="onThumbWidthChange" />
                    <a-button size="small" @click="shortcutVisible = true">快捷键</a-button>
                    <template v-if="mode === 'mask'">
                        <a-input v-model:value="maskColor" size="small" style="width: 84px" title="遮盖颜色" />
                        <a-input-number v-model:value="maskOpacity" size="small" :min="0.1" :max="1" :step="0.1"
                            style="width: 74px" title="不透明度" />
                    </template>
                    <a-button size="small" :disabled="!canEdit" @click="store.clearOpsOn()">清除操作</a-button>
                    <a-button size="small" :disabled="!canEdit" @click="store.toggleRemoveAnnots()">
                        {{ removeAnnotsMarked ? "取消删除批注" : "删除批注" }}
                    </a-button>
                    <span v-if="mode !== 'view'" class="ws-modehint">
                        {{ mode === 'crop' ? '在页面上拖拽框出要保留的区域' : '在页面上拖拽框出要遮盖的区域' }}
                        <template v-if="store.targetIds.length > 1">（将应用到选中的 {{ store.targetIds.length }} 页）</template>
                    </span>
                </div>

                <div v-if="store.previewLoading && !views.length" class="ws-hint">渲染中…</div>

                <!-- 页面预览。单页视图一列，双页视图并排两列；
                     两列共用同一个缩放比例，看起来才整齐。
                     旋转与缩放分层处理，每层只做一件事，避免多个 transform 揉在一起。 -->
                <div v-else-if="views.length" class="pv-row" :class="{ 'pv-draw': mode !== 'view' }">
                    <div v-for="(v, vi) in views" :key="v.item.id" :ref="(el) => setBoxRef(el, vi)" class="pv-fit"
                        :style="{ width: v.fitW + 'px', height: v.fitH + 'px' }"
                        @pointerdown="vi === 0 ? onCanvasDown($event) : undefined">

                        <div v-if="v.blank" class="ws-blank">
                            <file-outlined />
                            <div>空白页</div>
                            <small>{{ v.item.paper }} · {{ v.item.orientation === 'landscape' ? '横向' : '纵向' }}</small>
                        </div>

                        <div v-else-if="v.pending" class="ws-hint">渲染中…</div>

                        <template v-else>
                            <div class="pv-box" :style="{
                                width: v.dispW + 'px',
                                height: v.dispH + 'px',
                                transform: `scale(${v.scale})`,
                            }">
                                <img :src="v.url" :style="{
                                    width: v.imgW + 'px',
                                    height: v.imgH + 'px',
                                    transform: `translate(-50%, -50%) rotate(${v.rot}deg)`,
                                }" alt="" @error="onImgError" />
                            </div>

                            <!-- 操作回显与框选只画在当前页（第一格）上 -->
                            <template v-if="vi === 0">
                                <!-- 坐标已从页面空间换算到显示空间，页面旋转后框仍落在正确位置 -->
                                <div v-if="overlay.crop" class="ov-crop" :style="pctStyle(overlay.crop)"></div>
                                <div v-for="(m, i) in overlay.masks" :key="i" class="ov-mask"
                                    :style="Object.assign(pctStyle(m.rect), { background: m.color, opacity: m.opacity })"></div>
                                <div v-if="dragRect" class="ov-drag" :style="pctStyle(dragRect)"></div>
                            </template>
                        </template>
                    </div>
                </div>

                <div v-else class="ws-hint">
                    {{ store.seq.length ? "选择左侧任意一页查看大图" : "打开一个 PDF 开始" }}
                </div>
            </div>
        </div>

        <!-- 诊断条：供图是本方案的地基，把关键状态摊在界面上，出问题截图即可定位 -->
        <div class="ws-diag">
            来源={{ store.sourceList.length }} · 清单={{ store.seq.length }} · 已选={{ store.selected.length }} ·
            撤销栈={{ store.past.length }} · 重做栈={{ store.future.length }} ·
            当前={{ store.currentPos + 1 }}/{{ store.seq.length }} · 预览 p{{ previewPage }} · urlMode={{ urlMode }}
            {{ autoLog }}
        </div>

        <!-- 插入空白页 -->
        <a-modal v-model:visible="blankVisible" title="插入空白页" ok-text="插入" cancel-text="取消"
            @ok="doInsertBlank">
            <a-form layout="vertical">
                <a-form-item label="纸张">
                    <a-select v-model:value="blankPaper" style="width: 140px"
                        :options="[{ value: 'A4' }, { value: 'A3' }, { value: 'A5' }, { value: 'Letter' }]" />
                </a-form-item>
                <a-form-item label="方向">
                    <a-radio-group v-model:value="blankOrientation">
                        <a-radio-button value="portrait">纵向</a-radio-button>
                        <a-radio-button value="landscape">横向</a-radio-button>
                    </a-radio-group>
                </a-form-item>
                <a-form-item label="数量">
                    <a-input-number v-model:value="blankCount" :min="1" :max="200" />
                </a-form-item>
            </a-form>
            <div class="ws-note">将插入到第 {{ store.insertAt + 1 }} 位（当前选区之后）</div>
        </a-modal>

        <!-- 从 PDF 插入指定页 -->
        <a-modal v-model:visible="insVisible" title="从 PDF 插入页面" ok-text="插入" cancel-text="取消"
            @ok="doInsertFromPdf">
            <div class="ws-note ws-ellipsis">{{ insPath }}</div>
            <div class="ws-note">该文档共 {{ insPageCount }} 页</div>
            <a-form layout="vertical" style="margin-top: 10px;">
                <a-form-item label="页码范围">
                    <a-input v-model:value="insRange" placeholder="all，或 1-3,5,8-N" />
                </a-form-item>
            </a-form>
            <div class="ws-note">
                将插入 {{ insCount === null ? "?" : insCount }} 页到第 {{ store.insertAt + 1 }} 位
                <span v-if="insError" class="ws-err"> · {{ insError }}</span>
            </div>
        </a-modal>
        <!-- 导出 -->
        <a-modal v-model:visible="exportVisible" title="导出 PDF" ok-text="导出" cancel-text="取消"
            :confirm-loading="store.saving" @ok="doExport">
            <a-form layout="vertical">
                <a-form-item label="输出文件">
                    <a-row :gutter="8">
                        <a-col :span="19">
                            <a-input v-model:value="exportPath" placeholder="输出 PDF 的完整路径" />
                        </a-col>
                        <a-col :span="5">
                            <a-button @click="pickExportPath">选择…</a-button>
                        </a-col>
                    </a-row>
                </a-form-item>
                <a-form-item label="范围">
                    <a-radio-group v-model:value="exportScope">
                        <a-radio-button value="all">全部 {{ store.seq.length }} 页</a-radio-button>
                        <a-radio-button value="selected" :disabled="!store.selected.length">
                            仅选中 {{ store.selected.length }} 页
                        </a-radio-button>
                    </a-radio-group>
                </a-form-item>
                <a-form-item style="margin-bottom: 0;">
                    <a-checkbox v-model:checked="exportCompress">更强的压缩（稍慢）</a-checkbox>
                </a-form-item>
                <a-form-item style="margin-bottom: 0;">
                    <a-checkbox v-model:checked="exportBackup">
                        目标已存在时先备份为 .bak（只保留最早的一份）
                    </a-checkbox>
                </a-form-item>
            </a-form>
            <div class="ws-note" style="margin-top: 10px;">
                将导出 {{ exportCount }} 页
                <span v-if="exportScope === 'selected'">（只导出选中的页面，工作区其余内容不受影响）</span>
            </div>
        </a-modal>
        <!-- 页面装饰：导出期设置 -->
        <a-modal v-model:visible="decorVisible" title="页面装饰" :width="660" ok-text="完成" cancel-text="关闭">
            <a-alert type="info" show-icon
                message="这些都是导出期设置，不会改动源文件。页码里的「共 N 页」按导出后的实际页数计算，所以必须是导出时才能确定。" />

            <!-- 水印 -->
            <div class="decor-sec">
                <a-checkbox v-model:checked="store.decor.watermark.enabled">水印</a-checkbox>
                <div v-if="store.decor.watermark.enabled" class="decor-body">
                    <a-form layout="inline">
                        <a-form-item label="文字">
                            <a-input v-model:value="store.decor.watermark.text" style="width: 130px" />
                        </a-form-item>
                        <a-form-item label="颜色">
                            <a-input v-model:value="store.decor.watermark.color" style="width: 84px" />
                        </a-form-item>
                        <a-form-item label="字号">
                            <a-input-number v-model:value="store.decor.watermark.fontSize" :min="8" :max="200"
                                style="width: 76px" />
                        </a-form-item>
                        <a-form-item label="角度">
                            <a-input-number v-model:value="store.decor.watermark.angle" :min="-90" :max="90"
                                style="width: 76px" />
                        </a-form-item>
                        <a-form-item label="不透明度">
                            <a-input-number v-model:value="store.decor.watermark.opacity" :min="0.05" :max="1"
                                :step="0.05" style="width: 76px" />
                        </a-form-item>
                    </a-form>
                    <div class="decor-row">
                        <a-checkbox v-model:checked="store.decor.watermark.multiple">平铺整页</a-checkbox>
                        <a-checkbox v-model:checked="store.decor.watermark.scopeSelected">
                            只加在选中页{{ scopeHint }}
                        </a-checkbox>
                    </div>
                </div>
            </div>

            <a-divider style="margin: 10px 0" />

            <!-- 页码 -->
            <div class="decor-sec">
                <a-checkbox v-model:checked="store.decor.pageNumber.enabled">页码</a-checkbox>
                <div v-if="store.decor.pageNumber.enabled" class="decor-body">
                    <a-form layout="inline">
                        <a-form-item label="格式">
                            <a-input v-model:value="store.decor.pageNumber.format" style="width: 190px"
                                placeholder="第%p页/共%P页（%p=页码，%P=总页数）" />
                        </a-form-item>
                        <a-form-item label="位置">
                            <a-radio-group v-model:value="store.decor.pageNumber.pos" button-style="solid">
                                <a-radio-button value="header">页眉</a-radio-button>
                                <a-radio-button value="footer">页脚</a-radio-button>
                            </a-radio-group>
                        </a-form-item>
                        <a-form-item label="对齐">
                            <a-radio-group v-model:value="store.decor.pageNumber.align" button-style="solid">
                                <a-radio-button value="left">左</a-radio-button>
                                <a-radio-button value="center">中</a-radio-button>
                                <a-radio-button value="right">右</a-radio-button>
                            </a-radio-group>
                        </a-form-item>
                    </a-form>
                    <div class="decor-row">
                        <a-checkbox v-model:checked="store.decor.pageNumber.scopeSelected">
                            只加在选中页{{ scopeHint }}
                        </a-checkbox>
                    </div>
                </div>
            </div>

            <a-divider style="margin: 10px 0" />

            <!-- 页眉页脚 -->
            <div class="decor-sec">
                <a-checkbox v-model:checked="store.decor.headerFooter.enabled">页眉 / 页脚（固定文字）</a-checkbox>
                <div v-if="store.decor.headerFooter.enabled" class="decor-body">
                    <a-row :gutter="6" style="margin-bottom: 6px;">
                        <a-col :span="8"><a-input v-model:value="store.decor.headerFooter.headerLeft"
                                placeholder="页眉左" /></a-col>
                        <a-col :span="8"><a-input v-model:value="store.decor.headerFooter.headerCenter"
                                placeholder="页眉中" /></a-col>
                        <a-col :span="8"><a-input v-model:value="store.decor.headerFooter.headerRight"
                                placeholder="页眉右" /></a-col>
                    </a-row>
                    <a-row :gutter="6">
                        <a-col :span="8"><a-input v-model:value="store.decor.headerFooter.footerLeft"
                                placeholder="页脚左" /></a-col>
                        <a-col :span="8"><a-input v-model:value="store.decor.headerFooter.footerCenter"
                                placeholder="页脚中" /></a-col>
                        <a-col :span="8"><a-input v-model:value="store.decor.headerFooter.footerRight"
                                placeholder="页脚右" /></a-col>
                    </a-row>
                    <div class="decor-row">
                        <a-checkbox v-model:checked="store.decor.headerFooter.scopeSelected">
                            只加在选中页{{ scopeHint }}
                        </a-checkbox>
                    </div>
                </div>
            </div>
        </a-modal>
        <!-- 快捷键面板 -->
        <a-modal v-model:visible="shortcutVisible" title="快捷键与操作" :footer="null" :width="520">
            <div v-for="(s, i) in shortcuts" :key="i" class="sc-row">
                <span class="sc-key">{{ s[0] }}</span>
                <span class="sc-desc">{{ s[1] }}</span>
            </div>
        </a-modal>
    </div>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
    CopyOutlined,
    DeleteOutlined,
    DownOutlined,
    ExportOutlined,
    FileOutlined,
    FolderOpenOutlined,
    FontSizeOutlined,
    PlusOutlined,
    RedoOutlined,
    RotateLeftOutlined,
    RotateRightOutlined,
    SaveOutlined,
    UndoOutlined,
} from '@ant-design/icons-vue';
import { SelectFile, SelectMultipleFiles, SaveFile } from '../../../wailsjs/go/main/App';
import { useWorkspaceState, WS_THUMB_WIDTH } from '../../store/workspace';
import {
    clampRect,
    displayRectToPageRect,
    indexOfId,
    pageRectToDisplayRect,
    parseRange,
    rectFromPoints,
    type NormRect,
    type RailRow,
} from './model';
import { runOps } from './devops';
import ThumbRail from './ThumbRail.vue';

export default defineComponent({
    components: {
        CopyOutlined,
        DeleteOutlined,
        DownOutlined,
        ExportOutlined,
        FileOutlined,
        FolderOpenOutlined,
        FontSizeOutlined,
        PlusOutlined,
        RedoOutlined,
        RotateLeftOutlined,
        RotateRightOutlined,
        SaveOutlined,
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

        /** 缩略图尚未渲染时，用源页尺寸先占好位置，避免图片到达时布局跳动 */
        const placeholderSize = (item: any) => {
            const w = store.thumbWidth;
            const info = item.kind === 'page' ? store.pageInfoOf(item) : null;
            if (!info || !info.width) return { w, h: Math.round(w * 1.414) };
            return { w, h: Math.max(24, Math.round((w * info.height) / info.width)) };
        };

        const rows = computed<RailRow[]>(() =>
            store.seq.map((item, i) => {
                const t = store.thumbOf(item);
                const tag = store.sourceTag(item.kind === 'page' ? item.docId : '');
                const ph = t ? null : placeholderSize(item);
                return {
                    id: item.id,
                    kind: item.kind,
                    label: i + 1,
                    // 源页码：让用户知道这一页原本是文档的第几页（拖动后会不一致）
                    srcLabel: item.kind === 'page' ? item.pageIndex + 1 : 0,
                    srcTag: tag.tag,
                    srcColor: tag.color,
                    srcPath: tag.path,
                    rotation: item.kind === 'page' ? item.rotation : 0,
                    url: t ? url(t.url) : '',
                    loaded: !!t,
                    w: t ? t.width : (ph as any).w,
                    h: t ? t.height : (ph as any).h,
                    paper: item.kind === 'blank' ? item.paper : undefined,
                };
            })
        );

        const canEdit = computed(() => store.targetIds.length > 0);

        /** 诊断用：当前显示的大图实际是哪一页，与期望不一致时直接标出来 */
        const previewPage = computed(() => {
            const p = store.preview;
            if (!p) return '-';
            const it = store.currentItem;
            const want = it && it.kind === 'page' ? it.pageIndex + 1 : null;
            const got = p.pageIndex + 1;
            return want === null || want === got ? String(got) : `${got}(期望${want})`;
        });

        const blankLabel = computed(() => {
            const it = store.currentItem;
            if (!it || it.kind !== 'blank') return '导出时按所选纸张插入';
            return `${it.paper} · ${it.orientation === 'landscape' ? '横向' : '纵向'}`;
        });

        // --- 画布内的预览自适应 -------------------------------------------

        const canvasRef = ref<HTMLElement | null>(null);
        const canvasW = ref(800);
        const canvasH = ref(500);
        let ro: ResizeObserver | null = null;

        /**
         * 画布上要显示的页。单页视图一列，双页视图两列。
         * 两列共用同一个缩放比例，否则两页大小不一，看起来像出错。
         */
        const views = computed(() => {
            const start = store.currentPos;
            if (start < 0) return [];
            const idxs = store.viewMode === 'dual' ? [start, start + 1] : [start];
            const raw: any[] = [];

            for (let k = 0; k < idxs.length; k++) {
                const item = store.seq[idxs[k]];
                if (!item) continue;
                const rot = item.kind === 'page' ? item.rotation || 0 : 0;
                const rot90 = rot === 90 || rot === 270;

                if (item.kind === 'blank') {
                    // 空白页没有可渲染的内容，按 A4 竖版的名义尺寸占位
                    raw.push({ item, blank: true, dispW: 595, dispH: 842 });
                    continue;
                }

                const p = k === 0 ? store.preview : store.previewB;
                if (!p) {
                    raw.push({ item, blank: false, pending: true, dispW: rot90 ? 842 : 595, dispH: rot90 ? 595 : 842 });
                    continue;
                }
                raw.push({
                    item,
                    blank: false,
                    pending: false,
                    url: url(p.url),
                    imgW: p.width,
                    imgH: p.height,
                    rot,
                    // 旋转 90/270 后显示尺寸要交换
                    dispW: rot90 ? p.height : p.width,
                    dispH: rot90 ? p.width : p.height,
                });
            }
            if (!raw.length) return [];

            const n = raw.length;
            const gap = n > 1 ? 16 : 0;
            const availW = Math.max(120, canvasW.value - 30 - gap);
            const availH = Math.max(120, canvasH.value - 30);
            const perPageW = availW / n;
            let scale = 1;
            for (const v of raw) {
                scale = Math.min(scale, perPageW / v.dispW, availH / v.dispH);
            }
            return raw.map((v) => ({
                ...v,
                scale,
                fitW: Math.round(v.dispW * scale),
                fitH: Math.round(v.dispH * scale),
            }));
        });

        /** 只有第一格（当前页）参与裁剪/遮盖的框选 */
        const setBoxRef = (el: any, vi: number) => {
            if (vi === 0) canvasBoxRef.value = (el as HTMLElement) ?? null;
        };

        // --- 视图偏好与快捷键面板 -----------------------------------------

        const thumbSizeOptions = [
            { value: 110, label: '小图' },
            { value: 150, label: '中图' },
            { value: 210, label: '大图' },
        ];
        // 模板里不能写带类型标注的箭头函数（模板编译器用的是 JS 解析器），
        // 因此这类回调统一在 setup 里定义
        const onViewModeChange = (v: any) => store.setViewMode(v);
        const onThumbWidthChange = (v: any) => store.setThumbWidth(v);

        const shortcutVisible = ref(false);
        const shortcuts: [string, string][] = [
            ['拖动缩略图', '调整页面顺序（拖动选区中任意一项即拖动整组）'],
            ['单击 / Ctrl 单击 / Shift 单击', '单选 / 多选 / 范围选择'],
            ['Ctrl + A', '全选'],
            ['Ctrl + D', '复制所选页面'],
            ['Delete', '删除所选页面'],
            ['[ / ]', '逆时针 / 顺时针旋转 90°'],
            ['Ctrl + Z / Ctrl + Shift + Z', '撤销 / 重做'],
            ['Ctrl + S', '保存（覆盖主来源文件，先自动备份 .bak）'],
            ['Ctrl + Shift + S', '导出为新的 PDF'],
        ];

        // --- 裁剪 / 遮盖的框选交互 ----------------------------------------

        const mode = ref<'view' | 'crop' | 'mask'>('view');
        const maskColor = ref('#FFFF00');
        const maskOpacity = ref(1);
        const canvasBoxRef = ref<HTMLElement | null>(null);
        const dragRect = ref<NormRect | null>(null);
        let dragFrom: { x: number; y: number } | null = null;

        const pctStyle = (r: NormRect) => ({
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.w * 100}%`,
            height: `${r.h * 100}%`,
        });

        /** 当前页已有操作的回显。换算回显示空间，因此页面旋转后框仍落在正确位置。 */
        const overlay = computed(() => {
            const it = store.currentItem;
            if (!it || it.kind !== 'page') {
                return { crop: null as NormRect | null, masks: [] as { rect: NormRect; color: string; opacity: number }[] };
            }
            const total = (store.pageInfoOf(it)?.rotation ?? 0) + (it.rotation || 0);
            return {
                crop: it.ops?.crop ? pageRectToDisplayRect(it.ops.crop, total) : null,
                masks: (it.ops?.masks ?? []).map((m) => ({
                    rect: pageRectToDisplayRect(m.rect, total),
                    color: m.color,
                    opacity: m.opacity,
                })),
            };
        });

        const relPos = (e: PointerEvent, el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
        };

        const applyOp = (display: NormRect) => {
            const it = store.currentItem;
            if (!it) return;
            if (it.kind !== 'page') {
                message.info('空白页没有内容，无法裁剪或遮盖');
                return;
            }
            // 画布上框出的是显示坐标；存进清单前必须换算到页面未旋转空间，
            // 且要算上"页面固有旋转 + 工作区附加旋转"的总和。
            const total = (store.pageInfoOf(it)?.rotation ?? 0) + (it.rotation || 0);
            const pageRect = displayRectToPageRect(display, total);
            const ids = store.targetIds.length ? store.targetIds : [it.id];
            if (mode.value === 'crop') {
                store.applyCrop(ids, pageRect);
            } else {
                store.applyMask(ids, pageRect, maskColor.value, maskOpacity.value);
            }
        };

        const onCanvasMove = (e: PointerEvent) => {
            const el = canvasBoxRef.value;
            if (!dragFrom || !el) return;
            const p = relPos(e, el);
            dragRect.value = rectFromPoints(dragFrom.x, dragFrom.y, p.x, p.y);
        };

        const onCanvasUp = () => {
            window.removeEventListener('pointermove', onCanvasMove);
            window.removeEventListener('pointerup', onCanvasUp);
            const r = dragRect.value;
            dragFrom = null;
            dragRect.value = null;
            if (!r) return;
            const clamped = clampRect(r);
            if (!clamped) {
                message.info('框选范围太小，已忽略');
                return;
            }
            applyOp(clamped);
        };

        const onCanvasDown = (e: PointerEvent) => {
            if (mode.value === 'view' || e.button !== 0) return;
            const el = canvasBoxRef.value;
            if (!el) return;
            e.preventDefault();
            const p = relPos(e, el);
            dragFrom = p;
            dragRect.value = { x: p.x, y: p.y, w: 0, h: 0 };
            window.addEventListener('pointermove', onCanvasMove);
            window.addEventListener('pointerup', onCanvasUp);
        };

        // --- 插入 ---------------------------------------------------------

        const blankVisible = ref(false);
        const blankPaper = ref('A4');
        const blankOrientation = ref<'portrait' | 'landscape'>('portrait');
        const blankCount = ref(1);

        const insVisible = ref(false);
        const insDocId = ref('');
        const insPath = ref('');
        const insRange = ref('all');

        const insPageCount = computed(() => store.sources[insDocId.value]?.pageCount ?? 0);

        const insCount = computed<number | null>(() => {
            try {
                return parseRange(insRange.value, insPageCount.value).length;
            } catch (e) {
                return null;
            }
        });
        const insError = computed(() => {
            try {
                parseRange(insRange.value, insPageCount.value);
                return '';
            } catch (e: any) {
                return String(e?.message ?? e);
            }
        });

        const fail = (e: any) => message.error(String(e?.message ?? e));

        const doInsertBlank = () => {
            store.insertBlank(blankCount.value, blankPaper.value, blankOrientation.value);
            blankVisible.value = false;
        };

        const doInsertFromPdf = () => {
            try {
                const idx = parseRange(insRange.value, insPageCount.value);
                if (!idx.length) {
                    message.warning('页码范围没有选中任何页');
                    return;
                }
                store.insertPagesFrom(insDocId.value, idx);
                insVisible.value = false;
            } catch (e: any) {
                fail(e);
            }
        };

        const onInsertMenu = async ({ key }: { key: string }) => {
            if (key === 'blank') {
                blankVisible.value = true;
                return;
            }
            if (key === 'keep') {
                store.keepOnlySelected();
                return;
            }
            if (key === 'invert') {
                store.invertSelection();
                return;
            }
            if (key === 'pdf') {
                try {
                    const p: string = await SelectFile();
                    if (!p) return;
                    const docId = await store.registerSource(p);
                    insDocId.value = docId;
                    insPath.value = p;
                    insRange.value = 'all';
                    insVisible.value = true;
                } catch (e: any) {
                    fail(e);
                }
                return;
            }
            if (key === 'append') {
                try {
                    const p: string = await SelectFile();
                    if (!p) return;
                    const docId = await store.registerSource(p);
                    store.appendSource(docId);
                } catch (e: any) {
                    fail(e);
                }
                return;
            }
            if (key === 'images') {
                try {
                    const ps: string[] = await SelectMultipleFiles();
                    if (!ps || !ps.length) return;
                    const docId = await store.registerImageSource(ps);
                    store.appendSource(docId);
                } catch (e: any) {
                    fail(e);
                }
                return;
            }
        };

        // --- 保存与导出 ---------------------------------------------------

        const exportVisible = ref(false);
        const exportPath = ref('');
        const exportScope = ref<'all' | 'selected'>('all');
        const exportCompress = ref(false);
        const exportBackup = ref(true);

        const exportCount = computed(() =>
            exportScope.value === 'selected' ? store.selected.length : store.seq.length
        );

        /** 把合并结果整体写回主来源文件。多来源时会先确认，因为它会改动原文件。 */
        const runSave = async (target: string) => {
            try {
                const msg = await store.exportTo(target, 'all', false, true);
                message.success(msg);
            } catch (e: any) {
                fail(e);
            }
        };

        const doSave = async () => {
            const target = store.mainPath;
            if (!target) {
                message.error('没有可保存的目标文件，请用「导出」指定输出路径');
                return;
            }
            if (store.sourceList.length > 1) {
                Modal.confirm({
                    title: '保存会覆盖原文件',
                    content:
                        `工作区合并了 ${store.sourceList.length} 个来源，保存会把合并后的结果整体写入：${target}` +
                        `。原文件会自动备份为 .bak。`,
                    okText: '保存',
                    cancelText: '取消',
                    onOk: () => runSave(target),
                });
                return;
            }
            await runSave(target);
        };

        const openExport = () => {
            if (!exportPath.value) {
                const p = store.mainPath;
                exportPath.value = p ? p.replace(/\.pdf$/i, '') + '-导出.pdf' : '';
            }
            // 只选了一部分页时，默认导出选中的部分，符合"我选它就是要它"的直觉
            exportScope.value =
                store.selected.length > 0 && store.selected.length < store.seq.length ? 'selected' : 'all';
            exportVisible.value = true;
        };

        const pickExportPath = async () => {
            try {
                const p: string = await SaveFile();
                if (p) exportPath.value = p;
            } catch (e: any) {
                fail(e);
            }
        };

        const doExport = async () => {
            if (!exportPath.value.trim()) {
                message.error('请先指定输出文件');
                return;
            }
            try {
                const msg = await store.exportTo(
                    exportPath.value.trim(),
                    exportScope.value,
                    exportCompress.value,
                    exportBackup.value
                );
                message.success(msg);
                exportVisible.value = false;
            } catch (e: any) {
                fail(e);
            }
        };

        // --- 页面装饰（导出期设置）----------------------------------------

        const decorVisible = ref(false);

        // 装饰改动也要算"未保存"，否则改了水印却看不到提示、关窗口也不拦。
        // 直接改 store.decor 不会触发 syncDirty，所以这里监听。
        watch(
            () => store.decor,
            () => store.syncDirty(),
            { deep: true }
        );

        const removeAnnotsMarked = computed(() => store.removeAnnotsCount() > 0);

        const scopeHint = computed(() =>
            store.selected.length ? `（已选 ${store.selected.length} 页）` : '（当前没有选中页，将不生效）'
        );

        // --- 其它交互 -----------------------------------------------------

        const onNeedThumbs = (ids: string[]) => {
            // 轨道只报告"看得见但还没图"的项，商店负责合并、去重、按来源批量渲染
            store.ensureThumbsFor(ids);
        };

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
                fail(e);
            }
        };

        const onKey = (e: KeyboardEvent) => {
            if (!store.seq.length) return;
            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (e.shiftKey) openExport();
                else doSave();
                return;
            }
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
                        const log = await runOps(store, script, {
                            openExport,
                            openDecor: () => {
                                decorVisible.value = true;
                            },
                            openShortcuts: () => {
                                shortcutVisible.value = true;
                            },
                        });
                        autoLog.value = `· autoops=[${log.join(' ')}]`;
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
            canEdit,
            blankLabel,
            previewPage,
            views,
            setBoxRef,
            thumbSizeOptions,
            onViewModeChange,
            onThumbWidthChange,
            shortcutVisible,
            shortcuts,
            canvasRef,
            // 裁剪 / 遮盖
            mode,
            maskColor,
            maskOpacity,
            canvasBoxRef,
            dragRect,
            overlay,
            pctStyle,
            onCanvasDown,
            onSelect,
            onMove,
            onNeedThumbs,
            pickFile,
            onInsertMenu,
            autoLog,
            // 插入相关
            blankVisible,
            blankPaper,
            blankOrientation,
            blankCount,
            doInsertBlank,
            insVisible,
            insPath,
            insRange,
            insPageCount,
            insCount,
            insError,
            doInsertFromPdf,
            // 保存与导出
            doSave,
            openExport,
            pickExportPath,
            doExport,
            exportVisible,
            exportPath,
            exportScope,
            exportCompress,
            exportBackup,
            exportCount,
            // 页面装饰
            decorVisible,
            removeAnnotsMarked,
            scopeHint,
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
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #f0f2f5;
    padding: 12px;
}

/* 页面内容工具条：浮在画布左上角 */
.ws-modes {
    position: absolute;
    left: 10px;
    top: 8px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid #e8e8e8;
    border-radius: 6px;
}

.ws-modehint {
    font-size: 12px;
    color: #888;
    margin-left: 4px;
}

/* 外层只负责占位（已缩放的尺寸），内层负责缩放，图片负责旋转 */
.pv-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
}

.pv-fit {
    position: relative;
    overflow: hidden;
}

/* 快捷键面板 */
.sc-row {
    display: flex;
    gap: 12px;
    padding: 5px 0;
    border-bottom: 1px solid #f5f5f5;
}

.sc-key {
    flex: 0 0 200px;
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    color: #1677ff;
}

.sc-desc {
    font-size: 13px;
    color: #555;
}

.pv-draw {
    cursor: crosshair;
    touch-action: none;
}

/* 裁剪框：用超大的 box-shadow 把框外压暗，比铺四块遮罩简单得多 */
.ov-crop {
    position: absolute;
    border: 2px dashed #1677ff;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.38);
    pointer-events: none;
}

.ov-mask {
    position: absolute;
    pointer-events: none;
}

.ov-drag {
    position: absolute;
    border: 2px dashed #fa8c16;
    background: rgba(250, 140, 22, 0.16);
    pointer-events: none;
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

.ws-note {
    color: #999;
    font-size: 12px;
    line-height: 1.9;
}

.ws-ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ws-err {
    color: #cf1322;
}

/* 页面装饰弹窗 */
.decor-sec {
    margin-top: 12px;
}

.decor-body {
    margin: 8px 0 0 24px;
    padding-left: 12px;
    border-left: 3px solid #f0f0f0;
}

.decor-row {
    display: flex;
    gap: 18px;
    margin-top: 6px;
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
