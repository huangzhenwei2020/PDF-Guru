<template>
    <div class="ws">
        <!-- 工具栏 -->
        <div class="ws-toolbar">
            <a-tooltip title="新建一份只有空白页的文档，再用「插入」把 PDF 的页面取进来">
                <a-button :disabled="store.loading" @click="askNew">
                    <template #icon>
                        <file-add-outlined />
                    </template>
                    新建
                </a-button>
            </a-tooltip>
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
            <span v-if="store.title" class="ws-title" :title="store.mainPath || '尚未保存到文件'">
                {{ store.title }}
            </span>
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
                @select="onSelect" @move="onMove" @need="onNeedThumbs" @ctx="onCtx" />

            <!-- 画布外层：工具条固定在画布上方，画布自身可滚动（放大后要能看别处） -->
            <div class="ws-canvas-wrap">
                <div class="ws-modes" ref="modesRef">
                    <a-radio-group v-model:value="mode" size="small" button-style="solid">
                        <a-radio-button value="view">浏览</a-radio-button>
                        <a-radio-button value="crop">裁剪</a-radio-button>
                        <a-radio-button value="mask">遮盖</a-radio-button>
                    </a-radio-group>
                    <a-radio-group :value="store.viewMode" size="small" button-style="solid"
                        @update:value="onViewModeChange">
                        <a-radio-button value="single">单页</a-radio-button>
                        <a-radio-button value="dual">双页</a-radio-button>
                        <a-radio-button value="continuous">连续</a-radio-button>
                    </a-radio-group>

                    <!-- 缩放：Ctrl+滚轮 或 Ctrl + / Ctrl - -->
                    <a-button-group size="small">
                        <a-button @click="zoomBy(1 / 1.25)" title="缩小 (Ctrl -)">−</a-button>
                        <a-button class="zoom-pct" @click="zoomFit" title="点一下回到适应窗口">
                            {{ zoomPct }}%
                        </a-button>
                        <a-button @click="zoomBy(1.25)" title="放大 (Ctrl +)">＋</a-button>
                    </a-button-group>
                    <a-button size="small" :type="store.zoomMode === 'fit' ? 'primary' : 'default'"
                        @click="zoomFit">适应</a-button>
                    <a-button size="small" @click="zoomActual" title="1 个图像像素对 1 个屏幕像素">
                        1:1
                    </a-button>

                    <a-select :value="store.thumbWidth" size="small" style="width: 92px" :options="thumbSizeOptions"
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
                    <a-button size="small" :disabled="!canEdit" @click="doExtractText">提取文本</a-button>
                    <a-button size="small" :disabled="!canEdit" @click="doExtractImages">提取图片</a-button>
                    <span v-if="mode !== 'view'" class="ws-modehint">
                        {{ mode === 'crop' ? '在页面上拖拽框出要保留的区域' : '在页面上拖拽框出要遮盖的区域' }}
                        <template v-if="store.targetIds.length > 1">（将应用到选中的 {{ store.targetIds.length }} 页）</template>
                    </span>
                </div>

                <!-- 可滚动画布：放大后靠滚动查看其余部分。
                     工具条在上面、不参与滚动，所以放大后缩放按钮仍然够得着。 -->
                <div ref="canvasRef" class="ws-canvas" :style="{ paddingTop: modesH + 10 + 'px' }"
                    @wheel="onCanvasWheel" @scroll="onCanvasScroll">
                    <div v-if="store.previewLoading && !views.length" class="ws-hint">渲染中…</div>

                    <!-- 页面预览。单页一列，双页并排两列，连续模式纵向铺满全部页；
                         同一视图内共用同一个缩放比例，看起来才整齐。
                         旋转与缩放分层处理，每层只做一件事，避免多个 transform 揉在一起。 -->
                    <div v-else-if="views.length" class="pv-row"
                        :class="{ 'pv-draw': mode !== 'view', 'pv-col': isCont }">
                        <div v-for="(v, vi) in views" :key="v.item.id" :ref="(el) => setBoxRef(el, vi)"
                            class="pv-fit" :data-id="v.item.id" :data-doc="v.item.docId" :data-page="v.item.pageIndex"
                            :style="{ width: v.fitW + 'px', height: v.fitH + 'px' }"
                            @pointerdown="(isCont || vi === 0) ? onCanvasDown($event, v.item.id) : undefined">

                            <div v-if="v.blank" class="ws-blank">
                                <file-outlined />
                                <div>空白页</div>
                                <small>{{ v.item.paper }} · {{ v.item.orientation === 'landscape' ? '横向' : '纵向' }}</small>
                            </div>

                            <!-- 连续模式：大图按可见性补，没到位就显示占位 -->
                            <template v-else-if="isCont">
                                <template v-if="store.previewOf(v.item.docId, v.item.pageIndex)">
                                    <div class="pv-box" :style="{
                                        width: v.dispW + 'px',
                                        height: v.dispH + 'px',
                                        transform: `scale(${v.scale})`,
                                    }">
                                        <img :src="url(store.previewOf(v.item.docId, v.item.pageIndex)!.url)" :style="{
                                            width: v.imgW + 'px',
                                            height: v.imgH + 'px',
                                            transform: `translate(-50%, -50%) rotate(${v.rot}deg)`,
                                        }" alt="" @error="onImgError" />
                                    </div>
                                    <div v-if="v.ov.crop" class="ov-crop" :style="pctStyle(v.ov.crop!)"></div>
                                    <div v-for="(m, i) in v.ov.masks" :key="i" class="ov-mask"
                                        :style="Object.assign(pctStyle(m.rect), { background: m.color, opacity: m.opacity })"></div>
                                    <div v-if="dragRect && drawTargetId === v.item.id" class="ov-drag"
                                        :style="pctStyle(dragRect)"></div>
                                </template>
                                <div v-else class="loadingface"></div>
                            </template>

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
                        <template v-if="store.seq.length">选择左侧任意一页查看大图</template>
                        <template v-else>
                            把 PDF 拖进窗口即可打开<br />
                            <small class="ws-hint-sub">也可以点左上角「打开 PDF」；拖入多个会合并成一份</small>
                        </template>
                    </div>
                </div>
            </div>
        </div>

        <!-- 诊断条：供图是本方案的地基，把关键状态摊在界面上，出问题截图即可定位 -->
        <div class="ws-diag">
            <!-- autoops 放在最前面：它在末尾时会被窗口右边裁掉，验证时看不到输出 -->
            {{ autoLog }}
            <span v-if="jsErr" class="ws-err">JS错误: {{ jsErr }} · </span>
            画布={{ canvasSize }} 视图={{ store.viewMode }} 页数={{ views.length }} ·
            来源={{ store.sourceList.length }} · 清单={{ store.seq.length }} · 已选={{ store.selected.length }} ·
            撤销栈={{ store.past.length }} · 重做栈={{ store.future.length }} ·
            当前={{ store.currentPos + 1 }}/{{ store.seq.length }} · 预览 p{{ previewPage }} ·
            缩略图={{ Object.keys(store.thumbs).length }} · 载入中={{ store.previewLoading }} ·
            theme={{ themeAttr }} · urlMode={{ urlMode }}
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
        <!-- 本页文本 -->
        <a-modal v-model:visible="textVisible" title="本页文本" :width="660" :footer="null">
            <div v-if="textLoading" class="ws-hint">提取中…</div>
            <template v-else>
                <div class="ws-note">
                    共 {{ pageText.length }} 个字符
                    <span v-if="!pageText">（该页没有可提取的文本，可能是扫描件，需要 OCR）</span>
                </div>
                <textarea class="ws-textbox" readonly :value="pageText"></textarea>
                <div style="margin-top: 10px; text-align: right;">
                    <a-button @click="copyText" :disabled="!pageText">复制到剪贴板</a-button>
                </div>
            </template>
        </a-modal>
        <!-- 新建文档 -->
        <a-modal v-model:visible="newVisible" title="新建文档" ok-text="创建" cancel-text="取消" @ok="doNew">
            <a-form layout="vertical">
                <a-form-item label="纸张">
                    <a-select v-model:value="newPaper" style="width: 140px" :options="paperOptions" />
                </a-form-item>
                <a-form-item label="方向">
                    <a-radio-group v-model:value="newOrientation">
                        <a-radio-button value="portrait">纵向</a-radio-button>
                        <a-radio-button value="landscape">横向</a-radio-button>
                    </a-radio-group>
                </a-form-item>
                <a-form-item label="页数">
                    <a-input-number v-model:value="newCount" :min="1" :max="200" />
                </a-form-item>
            </a-form>
            <div class="ws-note">
                新建后可以用「插入」把别的 PDF 页面取进来，或继续添加空白页。
                这份文档还没有对应的文件，「保存」要先用「导出」指定一个路径。
            </div>
        </a-modal>

        <!-- 缩略图右键菜单：固定定位跟随鼠标，点别处即关闭 -->
        <div v-if="ctxVisible" class="ctx-mask" @click="ctxVisible = false" @contextmenu.prevent="ctxVisible = false">
            <a-menu class="ctx-menu" :style="{ left: ctxX + 'px', top: ctxY + 'px' }" @click="onCtxAction">
                <a-menu-item key="dup">复制所选页面</a-menu-item>
                <a-menu-item key="del">删除所选页面</a-menu-item>
                <a-menu-divider />
                <a-menu-item key="rot-">逆时针旋转 90°</a-menu-item>
                <a-menu-item key="rot+">顺时针旋转 90°</a-menu-item>
                <a-menu-divider />
                <a-menu-item key="keep">仅保留所选页面</a-menu-item>
                <a-menu-item key="clearops">清除裁剪 / 遮盖</a-menu-item>
                <a-menu-item key="text">提取本页文本</a-menu-item>
            </a-menu>
        </div>
    </div>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
    CopyOutlined,
    DeleteOutlined,
    DownOutlined,
    ExportOutlined,
    FileAddOutlined,
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
import { SelectFile, SelectMultipleFiles, SelectDir, SaveFile, SetClipboard, WorkspacePageText, WorkspacePageImages } from '../../../wailsjs/go/main/App';
import { OnFileDrop, OnFileDropOff } from '../../../wailsjs/runtime/runtime';
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
        FileAddOutlined,
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

        /**
         * 缩放参考宽度：显示尺寸以它为准，与"当前用哪一档分辨率渲染"解耦。
         * 取 900 是因为那正是默认档的渲染宽度，于是 100% 的含义
         * 就是"默认档渲染图 1 像素对 1 CSS 像素"。
         */
        const ZOOM_REF_WIDTH = 900;
        const autoLog = ref('');
        /** 诊断用：把未捕获的 JS 异常也显示出来，否则生产构建里看不到控制台 */
        const jsErr = ref('');

        window.addEventListener('error', (ev: ErrorEvent) => {
            const msg = String(ev.message || ev.error || '');
            // "ResizeObserver loop completed with undelivered notifications" 是浏览器层面的
            // 已知良性告警（回调里改了布局），画布出现滚动条时会触发；不当成应用错误展示，
            // 否则会把真正的问题淹掉。其余异常照常显示。
            if (msg.includes('ResizeObserver loop')) return;
            jsErr.value = msg;
        });
        window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
            const r: any = ev.reason;
            jsErr.value = String(r?.message ?? r ?? '');
        });

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
                    ops: {
                        crop: !!(item.kind === 'page' && item.ops?.crop),
                        masks: item.kind === 'page' ? (item.ops?.masks?.length ?? 0) : 0,
                        noAnnots: !!(item.kind === 'page' && item.ops?.removeAnnots),
                    },
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
         * 单页 / 双页视图：只显示当前页（双页再带一页）。
         * 两列共用同一个缩放比例，否则两页大小不一，看起来像出错。
         */
        const pagedViews = computed(() => {
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
                    // 空白页没有可渲染的内容，按 A4 的名义尺寸占位；
                    // 宽度用参考宽度，这样它与真实页面的"同一倍数"看起来一样大
                    raw.push({ item, blank: true, imgW: ZOOM_REF_WIDTH, dispW: ZOOM_REF_WIDTH, dispH: Math.round(ZOOM_REF_WIDTH * 1.414) });
                    continue;
                }

                const p = k === 0 ? store.preview : store.previewB;
                if (!p) {
                    raw.push({
                        item, blank: false, pending: true, imgW: ZOOM_REF_WIDTH,
                        dispW: rot90 ? Math.round(ZOOM_REF_WIDTH * 1.414) : ZOOM_REF_WIDTH,
                        dispH: rot90 ? ZOOM_REF_WIDTH : Math.round(ZOOM_REF_WIDTH * 1.414),
                    });
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
            const availH = Math.max(120, canvasH.value - modesH.value - 30);
            const perPageW = availW / n;
            let fitScale = 1;
            for (const v of raw) {
                fitScale = Math.min(fitScale, perPageW / v.dispW, availH / v.dispH);
            }

            return raw.map((v) => {
                // 自定义倍数时把显示尺寸**锚定到参考宽度**，而不是乘图像自身的像素宽度：
                // 放大时渲染分辨率会换档（900 -> 2000），若直接乘倍数，
                // 跨过阈值那一刻页面尺寸会突然跳一倍。适应窗口没这个问题——
                // 图像变宽时 fitScale 同步变小，两者正好抵消。
                const scale =
                    store.zoomMode === 'fit' ? fitScale : (store.zoom * ZOOM_REF_WIDTH) / v.imgW;
                return {
                    ...v,
                    scale,
                    fitW: Math.round(v.dispW * scale),
                    fitH: Math.round(v.dispH * scale),
                    ov: overlayOf(v.item),
                };
            });
        });

        /**
         * 连续滚动模式：**全部页面**，一次性给出尺寸。
         *
         * 尺寸不依赖渲染结果：高度由来源页的点尺寸推出（每页都按同一宽度渲染，
         * 所以宽度是固定的、只有高度随页面比例变）。这样 500 页也能立刻排出稳定的
         * 滚动布局，而真正的大图按可见性再补，没到的页先显示占位。
         *
         * 这里**不读** previewCache：否则任意一页渲染完成都会让整个列表重算一遍。
         * 大图由模板按页读取（见 previewOf），Vue 只会重绘那一页。
         */
        const contViews = computed(() => {
            const tierW = store.previewWidth;
            const raw: any[] = [];
            let fitScale = 1;

            for (const item of store.seq) {
                const rot = item.kind === 'page' ? item.rotation || 0 : 0;
                const rot90 = rot === 90 || rot === 270;
                let imgH: number;
                if (item.kind === 'blank') {
                    imgH = Math.round(tierW * 1.414);
                } else {
                    // 用来源页的点尺寸推高度——不用渲染就能知道比例
                    const pg = store.sources[item.docId]?.pages?.[item.pageIndex];
                    imgH = pg && pg.width > 0
                        ? Math.round(tierW * (pg.height / pg.width))
                        : Math.round(tierW * 1.414);
                }
                const dispW = rot90 ? imgH : tierW;
                const dispH = rot90 ? tierW : imgH;
                raw.push({ item, imgW: tierW, imgH, dispW, dispH, rot, rot90 });
            }
            if (!raw.length) return [];

            // 统一比例：让最宽的一页也能放下
            const availW = Math.max(120, canvasW.value - 40);
            for (const v of raw) fitScale = Math.min(fitScale, availW / v.dispW);

            const scale =
                store.zoomMode === 'fit' ? fitScale : (store.zoom * ZOOM_REF_WIDTH) / tierW;
            return raw.map((v) => ({
                ...v,
                scale,
                fitW: Math.round(v.dispW * scale),
                fitH: Math.round(v.dispH * scale),
                ov: overlayOf(v.item),
            }));
        });

        /** 画布上要显示的页：连续模式给全部，其它模式只给当前页（+右页） */
        const views = computed(() =>
            store.viewMode === 'continuous' ? contViews.value : pagedViews.value
        );
        const isCont = computed(() => store.viewMode === 'continuous');

        /**
         * 页元素登记。单页/双页只需要第一格（框选固定在那）；
         * 连续模式每页都要记——框选目标是"指针底下的那一页"。
         *
         * 连续模式的登记不从这里做：模板里的 ref 是内联箭头函数，每次重渲染
         * Vue 都会先用 null 调旧回调、再用新回调，若在这里 observe/unobserve，
         * 观察往往还没送达就被取消，表现为"一页都不出图"。
         * 那条路改由 watch + querySelectorAll 统一处理（见 registerContPages）。
         */
        const setBoxRef = (el: any, vi: number) => {
            if (vi === 0) canvasBoxRef.value = (el as HTMLElement) ?? null;
        };

        /** 诊断用：画布以 CSS 像素计的可用尺寸（和截图里的物理像素对比可看出 DPI 缩放） */
        const canvasSize = computed(() => `${Math.round(canvasW.value)}x${Math.round(canvasH.value)}`);

        // --- 连续滚动模式 --------------------------------------------------

        /** 当前真正可见的页（供滚动时挑"最中间的那页"，避免每帧遍历 500 个节点） */
        const visibleIds = new Set<string>();
        /** 连续模式：页 id -> 该页的 DOM 节点（框选与滚动定位都要用） */
        const pageBoxes = new Map<string, HTMLElement>();
        /** 诊断用：登记了几页 / 观察器回调看到了几页 */
        const contDbg = ref('');
        let contObserver: IntersectionObserver | null = null;

        /**
         * 只给"快要看见"的页渲染大图。
         * 一次性渲染 500 页会把后端和内存都打满，所以按可见性补；
         * rootMargin 提前约一屏，正常滚动时基本看不到空白。
         */
        const observePage = (el: HTMLElement) => {
            if (!contObserver) {
                contObserver = new IntersectionObserver(
                    (entries) => {
                        const need: { docId: string; pageIndex: number }[] = [];
                        for (const en of entries) {
                            const node = en.target as HTMLElement;
                            const id = node.dataset.id || '';
                            if (!id) continue;
                            if (en.isIntersecting) {
                                visibleIds.add(id);
                                const docId = node.dataset.doc || '';
                                const pageIndex = Number(node.dataset.page);
                                if (docId && pageIndex >= 0) need.push({ docId, pageIndex });
                            } else {
                                visibleIds.delete(id);
                            }
                        }
                        if (need.length) void store.ensurePreviewsFor(need);
                        contDbg.value = `cb=${entries.length} vis=${visibleIds.size} need=${need.length}`;
                    },
                    { root: canvasRef.value, rootMargin: '800px 0px' }
                );
            }
            contObserver.observe(el);
        };

        /**
         * 连续模式：每页相对滚动内容的纵向区间，供滚动时二分定位当前页。
         *
         * 为什么不从"观察器报告的可见集合"里挑：那个集合有滞后——用户快速滚动时
         * 它还没更新，实测滚到 5000 会算成第 3 页（实际是第 5 页）。
         * 注册时算好区间就没有这个问题，而且二分是 O(log n)。
         */
        const pageSpans: { id: string; top: number; bottom: number }[] = [];

        /**
         * 连续模式：把渲染出来的每一页登记到 pageBoxes 并交给可见性观察。
         *
         * 用 querySelectorAll 而不是模板 ref 回调，理由见 setBoxRef 的注释：
         * 内联 ref 回调会在每次重渲染时 observe/unobserve 抖动，观察送不达。
         */
        const registerContPages = async () => {
            await nextTick();
            if (!isCont.value) {
                visibleIds.clear();
                pageBoxes.clear();
                pageSpans.length = 0;
                return;
            }
            const cv = canvasRef.value;
            const nodes = cv?.querySelectorAll('.pv-fit') ?? [];
            const alive = new Set<string>();
            pageSpans.length = 0;
            const cvTop = cv ? cv.getBoundingClientRect().top : 0;
            const st = cv ? cv.scrollTop : 0;
            nodes.forEach((n) => {
                const el = n as HTMLElement;
                const id = el.dataset.id || '';
                if (!id) return;
                alive.add(id);
                pageBoxes.set(id, el);
                observePage(el);
                const r = el.getBoundingClientRect();
                // 换算成"相对滚动内容"的坐标：与当前滚动位置无关，滚动时不用重算
                pageSpans.push({ id, top: r.top - cvTop + st, bottom: r.bottom - cvTop + st });
            });
            pageSpans.sort((a, b) => a.top - b.top);
            // 已经不存在的页（删页/换文档）要从观察里摘掉，否则会一直占着
            for (const id of Array.from(pageBoxes.keys())) {
                if (alive.has(id)) continue;
                const el = pageBoxes.get(id);
                if (el) contObserver?.unobserve(el);
                visibleIds.delete(id);
                pageBoxes.delete(id);
            }
            contDbg.value = `reg=${nodes.length} obs=${alive.size} root=${contObserver ? 'ok' : '-'}`;
        };

        watch(
            () => [isCont.value, store.seq.length, store.previewWidth] as const,
            () => {
                void registerContPages();
            }
        );

        /**
         * 滚动时把"离视口中心最近且可见"的那一页设为当前页。
         *
         * 只改 store.current，不调 focusItem：大图已经由可见性观察按需加载，
         * 再走 focusItem 会多渲染一次，而且会把 preview/previewB 这两个
         * "单页视图专用槽位"搅乱。
         */
        let scrollRaf = 0;
        const onCanvasScroll = () => {
            if (!isCont.value || scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => {
                scrollRaf = 0;
                const el = canvasRef.value;
                if (!el || !pageSpans.length) return;
                // 视口中线落在哪一页：二分找最后一个 top <= mid 的页
                const mid = el.scrollTop + el.clientHeight / 2;
                let lo = 0;
                let hi = pageSpans.length - 1;
                let best = pageSpans[0].id;
                while (lo <= hi) {
                    const m = (lo + hi) >> 1;
                    if (pageSpans[m].top <= mid) {
                        best = pageSpans[m].id;
                        lo = m + 1;
                    } else {
                        hi = m - 1;
                    }
                }
                if (best && best !== store.current) store.current = best;
            });
        };

        /** 把当前页滚到视野里（切换视图模式/键盘翻页后用） */
        const scrollCurrentIntoView = () => {
            const node = pageBoxes.get(store.current);
            node?.scrollIntoView({ block: 'start' });
        };

        /** 工具条高度：画布要给它让出位置，否则页面上沿被压住 */
        const modesRef = ref<HTMLElement | null>(null);
        const modesH = ref(52);
        let modesRo: ResizeObserver | null = null;

        // --- 缩放 ---------------------------------------------------------

        /**
         * 以**参考宽度**为基准的显示倍数：100% = 默认档渲染图 1 像素对 1 CSS 像素。
         *
         * 不能用"图像像素比"（scale 本身）来当读数：渲染档位会在放大时从 900 换到 2000，
         * 于是同一块屏幕大小会读出 119% 又突然变成 54%，控件与读数就对不上了。
         */
        const refScale = computed(() => {
            const v = views.value[0];
            if (!v) return 1;
            return (v.scale * v.imgW) / ZOOM_REF_WIDTH;
        });
        const zoomPct = computed(() => Math.round(refScale.value * 100));

        const zoomBy = (factor: number) => store.setZoom(refScale.value * factor);
        const zoomActual = () => store.setZoom(1);
        const zoomFit = () => store.zoomFit();

        /**
         * Ctrl + 滚轮缩放。
         *
         * 缩放后把滚动位置按比例调回去，让光标底下的那个点大致留在原处——
         * 否则放大后视野会跳到别处，还得重新找刚才在看的位置。
         */
        const onCanvasWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return; // 普通滚轮留给滚动
            e.preventDefault();
            const el = canvasRef.value;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const next = Math.max(0.15, Math.min(6, refScale.value * factor));
            if (!el) {
                store.setZoom(next);
                return;
            }
            const r = el.getBoundingClientRect();
            const fx = el.scrollWidth ? (e.clientX - r.left + el.scrollLeft) / el.scrollWidth : 0.5;
            const fy = el.scrollHeight ? (e.clientY - r.top + el.scrollTop) / el.scrollHeight : 0.5;
            store.setZoom(next);
            // 等 DOM 按新尺寸布局完再调整滚动位置
            requestAnimationFrame(() => {
                el.scrollLeft = fx * el.scrollWidth - (e.clientX - r.left);
                el.scrollTop = fy * el.scrollHeight - (e.clientY - r.top);
            });
        };

        // --- 视图偏好与快捷键面板 -----------------------------------------

        const thumbSizeOptions = [
            { value: 110, label: '小图' },
            { value: 150, label: '中图' },
            { value: 210, label: '大图' },
        ];
        // 模板里不能写带类型标注的箭头函数（模板编译器用的是 JS 解析器），
        // 因此这类回调统一在 setup 里定义
        const onViewModeChange = (v: any) => {
            const wasCont = store.viewMode === 'continuous';
            store.setViewMode(v);
            if (v === 'continuous') {
                // 从单页切过来：把当前页滚进视野（切换前大图只加载了当前页）
                nextTick(() => scrollCurrentIntoView());
            } else if (wasCont && store.current) {
                // 从连续切回去：大图槽位还停在别的页，重新聚焦一次
                void store.focusItem(store.current);
            }
        };
        const onThumbWidthChange = (v: any) => store.setThumbWidth(v);
        /** 诊断用：模板里不能直接引用 document，这里包一层 */
        const themeAttr = computed(() => document.documentElement.dataset.theme || 'light');

        const shortcutVisible = ref(false);
        const shortcuts: [string, string][] = [
            ['拖动缩略图', '调整页面顺序（拖动选区中任意一项即拖动整组）'],
            ['单击 / Ctrl 单击 / Shift 单击', '单选 / 多选 / 范围选择'],
            ['Ctrl + A', '全选'],
            ['Ctrl + D', '复制所选页面'],
            ['Delete', '删除所选页面'],
            ['[ / ]', '逆时针 / 顺时针旋转 90°'],
            ['方向键 / PageUp / PageDown', '上一页 / 下一页'],
            ['Home / End', '第一页 / 最后一页'],
            ['Ctrl + 滚轮 / Ctrl + / Ctrl -', '缩放'],
            ['Ctrl + 0', '缩放回「适应窗口」'],
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
        /** 正在框选的是哪一页（连续模式下要把回显画在正确的那一页上） */
        const drawTargetId = ref<string>('');
        let dragFrom: { x: number; y: number } | null = null;

        const pctStyle = (r: NormRect) => ({
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.w * 100}%`,
            height: `${r.h * 100}%`,
        });

        /**
         * 某一页已有操作的回显。换算回显示空间，因此页面旋转后框仍落在正确位置。
         *
         * 连续模式要每页各画各的，所以做成按页取值的函数而不是"只算当前页"的计算属性。
         */
        const overlayOf = (it: any) => {
            if (!it || it.kind !== 'page') {
                return { crop: null as NormRect | null, masks: [] as { rect: NormRect; color: string; opacity: number }[] };
            }
            const total = (store.pageInfoOf(it)?.rotation ?? 0) + (it.rotation || 0);
            return {
                crop: it.ops?.crop ? pageRectToDisplayRect(it.ops.crop, total) : null,
                masks: (it.ops?.masks ?? []).map((m: any) => ({
                    rect: pageRectToDisplayRect(m.rect, total),
                    color: m.color,
                    opacity: m.opacity,
                })),
            };
        };

        /** 当前页的操作回显（单页/双页视图用） */
        const overlay = computed(() => overlayOf(store.currentItem));

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
            drawTargetId.value = '';
            if (!r) return;
            const clamped = clampRect(r);
            if (!clamped) {
                message.info('框选范围太小，已忽略');
                return;
            }
            applyOp(clamped);
        };

        const onCanvasDown = (e: PointerEvent, id?: string) => {
            if (mode.value === 'view' || e.button !== 0) return;
            // 连续模式：框选目标是"指针底下的那一页"，而不是永远第一格。
            // 同时把它设为当前页——这样"没选中任何页时作用于当前页"的既有语义
            // 在连续模式下也成立，不必另开一套规则。
            if (id && isCont.value) {
                const el = pageBoxes.get(id);
                if (!el) return;
                canvasBoxRef.value = el;
                drawTargetId.value = id;
                store.current = id;
            }
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

        // --- 提取当前页文本 / 图片 -----------------------------------------

        const textVisible = ref(false);
        const textLoading = ref(false);
        const pageText = ref('');

        const doExtractText = async () => {
            const it = store.currentItem;
            if (!it || it.kind !== 'page') {
                message.info('请先选中一页内容页');
                return;
            }
            textVisible.value = true;
            textLoading.value = true;
            pageText.value = '';
            try {
                pageText.value = await WorkspacePageText(it.docId, it.pageIndex);
            } catch (e: any) {
                fail(e);
            } finally {
                textLoading.value = false;
            }
        };

        const copyText = async () => {
            try {
                await SetClipboard(pageText.value);
                message.success('已复制到剪贴板');
            } catch (e: any) {
                fail(e);
            }
        };

        const doExtractImages = async () => {
            const it = store.currentItem;
            if (!it || it.kind !== 'page') {
                message.info('请先选中一页内容页');
                return;
            }
            try {
                const dir: string = await SelectDir();
                if (!dir) return;
                const out = await WorkspacePageImages(it.docId, it.pageIndex, dir);
                message.success(`图片已导出到 ${out}`);
            } catch (e: any) {
                fail(e);
            }
        };

        // --- 缩略图右键菜单 -----------------------------------------------

        const ctxVisible = ref(false);
        const ctxX = ref(0);
        const ctxY = ref(0);

        const onCtx = (_id: string, x: number, y: number) => {
            ctxX.value = x;
            ctxY.value = y;
            ctxVisible.value = true;
        };

        const onCtxAction = ({ key }: { key: string }) => {
            ctxVisible.value = false;
            switch (key) {
                case 'dup':
                    store.doDuplicate();
                    break;
                case 'del':
                    store.doDelete();
                    break;
                case 'rot-':
                    store.doRotate(-90);
                    break;
                case 'rot+':
                    store.doRotate(90);
                    break;
                case 'keep':
                    store.keepOnlySelected();
                    break;
                case 'clearops':
                    store.clearOpsOn();
                    break;
                case 'text':
                    doExtractText();
                    break;
            }
        };

        /**
         * 处理从资源管理器拖进来的文件。
         *
         * Wails 给的 x/y 是**客户端坐标**（它的前端实现里就是拿这两个值调
         * elementFromPoint 的），因此可以精确判断落在哪一行：
         * 落在大纲里就插到该行位置，落在别处就追加到末尾。
         *
         * 注册时传 useDropTarget=false，由我们自己按坐标区分，
         * 而不是要求元素先标上 `--wails-drop-target`——那样"拖到窗口空白处打开"就失效了。
         */
        const handleFileDrop = async (
            x: number,
            y: number,
            paths: string[]
        ): Promise<{ inserted: number; errors: string[] }> => {
            if (!paths || !paths.length) return { inserted: 0, errors: [] };
            let at = store.seq.length;
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            if (el?.closest('.rail')) {
                // 落在缩略图轨道里：按行与上下半区算出插入位置
                const row = el.closest('.row') as HTMLElement | null;
                if (row) {
                    const i = Number(row.dataset.index);
                    const r = row.getBoundingClientRect();
                    at = i + (y > r.top + r.height / 2 ? 1 : 0);
                }
            }
            imgFailed.value = false;
            urlMode.value = 'relative';
            try {
                const res = await store.insertDroppedFiles(paths, at);
                if (res.inserted) {
                    message.success(`已插入 ${res.inserted} 页`);
                }
                if (res.errors.length) {
                    message.error(res.errors.join('；'), 6);
                }
                return res;
            } catch (e: any) {
                fail(e);
                return { inserted: 0, errors: [String(e?.message ?? e)] };
            }
        };

        // --- 新建文档 -----------------------------------------------------

        const newVisible = ref(false);
        const newPaper = ref('A4');
        const newOrientation = ref<'portrait' | 'landscape'>('portrait');
        const newCount = ref(1);
        const paperOptions = [{ value: 'A4' }, { value: 'A3' }, { value: 'A5' }, { value: 'Letter' }];

        const askNew = () => {
            // 有未保存内容时先确认，否则新建会把它们直接冲掉
            if (store.dirty && store.seq.length) {
                Modal.confirm({
                    title: '新建会替换当前工作区',
                    content: '当前工作区有未保存的更改，新建之后这些改动会丢失。',
                    okText: '继续新建',
                    cancelText: '取消',
                    onOk: () => {
                        newVisible.value = true;
                    },
                });
                return;
            }
            newVisible.value = true;
        };

        const doNew = () => {
            store.newDocument(newCount.value, newPaper.value, newOrientation.value);
            newVisible.value = false;
        };

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

        const gotoIndex = (i: number) => {
            if (i < 0 || i >= store.seq.length) return;
            store.select(store.seq[i].id, 'replace');
        };

        const gotoRelative = (delta: number) => {
            const cur = store.currentPos;
            gotoIndex(cur < 0 ? 0 : cur + delta);
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
            // 缩放：Ctrl + / Ctrl - / Ctrl 0
            if (ctrl && (e.key === '=' || e.key === '+')) {
                e.preventDefault();
                zoomBy(1.25);
                return;
            }
            if (ctrl && (e.key === '-' || e.key === '_')) {
                e.preventDefault();
                zoomBy(1 / 1.25);
                return;
            }
            if (ctrl && e.key === '0') {
                e.preventDefault();
                zoomFit();
                return;
            }
            // 翻页：方向键 / PageUp / PageDown / Home / End
            // 任何文档阅读器都有，缺了会很别扭
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') {
                e.preventDefault();
                gotoRelative(1);
                return;
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
                e.preventDefault();
                gotoRelative(-1);
                return;
            }
            if (e.key === 'Home') {
                e.preventDefault();
                gotoIndex(0);
                return;
            }
            if (e.key === 'End') {
                e.preventDefault();
                gotoIndex(store.seq.length - 1);
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
            // 拖拽文件：注册 Wails 的拖放监听。
            // 必须由前端调用这个 API，监听器才会装上——之前只配了 Go 侧的
            // EnableFileDrop 却没在前端注册，真实的系统拖放其实是不工作的
            // （当时的"验证"直接调了 Go 处理函数，绕过了真实投递）。
            OnFileDrop((x: number, y: number, paths: string[]) => {
                void handleFileDrop(x, y, paths);
            }, false);
            if (canvasRef.value && typeof ResizeObserver !== 'undefined') {
                ro = new ResizeObserver(() => {
                    const el = canvasRef.value;
                    if (!el) return;
                    canvasW.value = el.clientWidth;
                    canvasH.value = el.clientHeight;
                });
                ro.observe(canvasRef.value);
            }
            // 工具条会换行，高度不固定，所以量一次、变了再更新
            if (modesRef.value && typeof ResizeObserver !== 'undefined') {
                modesRo = new ResizeObserver(() => {
                    const h = modesRef.value?.offsetHeight ?? 0;
                    if (h && Math.abs(h - modesH.value) > 2) modesH.value = h;
                });
                modesRo.observe(modesRef.value);
                modesH.value = modesRef.value.offsetHeight || modesH.value;
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
                            openText: () => doExtractText(),
                            openCtx: (x: number, y: number) => onCtx('', x, y),
                            handleDrop: (x: number, y: number, paths: string[]) =>
                                handleFileDrop(x, y, paths),
                            zoomPct: () => zoomPct.value,
                            contDbg: () => contDbg.value,
                            setMode: (m: 'view' | 'crop' | 'mask') => {
                                mode.value = m;
                            },
                            scrollCanvas: (y: number) => {
                                const el = canvasRef.value;
                                if (el) el.scrollTop = y;
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
            OnFileDropOff();
            if (ro) ro.disconnect();
            if (modesRo) modesRo.disconnect();
            if (contObserver) contObserver.disconnect();
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
            canvasSize,
            isCont,
            modesRef,
            modesH,
            onCanvasScroll,
            drawTargetId,
            contDbg,
            // 缩放
            zoomPct,
            zoomBy,
            zoomActual,
            zoomFit,
            onCanvasWheel,
            thumbSizeOptions,
            onViewModeChange,
            onThumbWidthChange,
            shortcutVisible,
            shortcuts,
            // 提取文本 / 图片
            doExtractText,
            doExtractImages,
            copyText,
            textVisible,
            textLoading,
            pageText,
            // 右键菜单
            ctxVisible,
            ctxX,
            ctxY,
            onCtx,
            onCtxAction,
            // 新建文档
            askNew,
            doNew,
            newVisible,
            newPaper,
            newOrientation,
            newCount,
            paperOptions,
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
            jsErr,
            themeAttr,
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
    color: var(--ws-text-sub);
    font-size: 13px;
}

.ws-title {
    color: var(--ws-text);
    font-size: 13px;
    /* 给个下限，否则会被 flex 压到只剩两个字符加省略号 */
    min-width: 80px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ws-alert {
    margin-bottom: 8px;
}

.ws-body {
    flex: 1;
    display: flex;
    min-height: 0;
    border: 1px solid var(--ws-border);
    border-radius: 8px;
    overflow: hidden;
}

/* 画布外层：工具条相对它定位；画布本身是滚动容器，放大后能看别处 */
.ws-canvas-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.ws-canvas {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: auto;
    /* 始终预留滚动条位置：否则放大时滚动条出现会改变可用宽度，
       触发"测量 -> 重排 -> 再测量"的来回抖动 */
    scrollbar-gutter: stable;
    /* 内容自身的尺寸说了算，别被容器拉伸（连续模式下列容器被拉伸会导致子项被压扁） */
    align-items: flex-start;
    background: var(--ws-bg-canvas);
    padding: 12px;
}

/* 画布里的内容用 margin:auto 居中，而不是给容器 justify-content:center ——
   后者在内容超出容器时会把左上角裁掉且滚不到，是 flex 居中 + 溢出的经典坑 */
.ws-canvas > .pv-row,
.ws-canvas > .ws-hint {
    margin: auto;
}

.zoom-pct {
    min-width: 58px;
    text-align: center;
}

/* 页面内容工具条：浮在画布左上角，不随画布滚动 */
.ws-modes {
    position: absolute;
    left: 10px;
    top: 8px;
    z-index: 5;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 8px;
    background: var(--ws-panel);
    border: 1px solid var(--ws-border);
    border-radius: 6px;
    max-width: calc(100% - 20px);
}

.ws-modehint {
    font-size: 12px;
    color: var(--ws-text-dim);
    margin-left: 4px;
}

/* 外层只负责占位（已缩放的尺寸），内层负责缩放，图片负责旋转 */
.pv-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
}

/* 连续滚动：纵向排列、页间留缝，整体从顶部开始（内容比容器高，不能用 auto 居中） */
.pv-row.pv-col {
    flex-direction: column;
    align-items: center;
    gap: 14px;
    margin: 0 auto;
    padding-bottom: 24px;
}

/*
 * 关键：列向 flex 容器里的页必须禁止收缩。
 * 否则容器会被拉伸成画布高度，而 60 个子项默认 flex-shrink:1 会一起被压扁——
 * 实测内联样式明明是 787x1114，getBoundingClientRect 却只有 787x0，
 * 表现为"画布一片空白、也滚不动"。
 */
.pv-row.pv-col > .pv-fit {
    flex: 0 0 auto;
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
    border-bottom: 1px solid var(--ws-border-subtle);
}

.sc-key {
    flex: 0 0 200px;
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    color: var(--ws-accent);
}

.sc-desc {
    font-size: 13px;
    color: var(--ws-text-sub);
}

/* 右键菜单 */
.ctx-mask {
    position: fixed;
    inset: 0;
    z-index: 1000;
}

.ctx-menu {
    position: fixed;
    min-width: 176px;
    border-radius: 6px;
    box-shadow: var(--ws-shadow-lg);
}

.ws-textbox {
    width: 100%;
    height: 260px;
    margin-top: 8px;
    padding: 8px;
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.6;
    border: 1px solid var(--ws-border);
    border-radius: 4px;
    resize: vertical;
    background: var(--ws-bg-subtle);
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
    color: var(--ws-text-faint);
    font-size: 14px;
}

.ws-blank small {
    font-size: 11px;
    color: var(--ws-text-faint);
}

.ws-hint {
    color: var(--ws-text-dim);
    font-size: 13px;
    text-align: center;
    padding: 20px 8px;
    line-height: 1.8;
}

.ws-hint-sub {
    color: var(--ws-text-faint);
    font-size: 12px;
}

.ws-note {
    color: var(--ws-text-dim);
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
    border-left: 3px solid var(--ws-border-subtle);
}

.decor-row {
    display: flex;
    gap: 18px;
    margin-top: 6px;
}

.ws-diag {
    /* 允许换行：单行会被窗口右边裁掉，验证时就看不到最后几条记录 */
    white-space: normal;
    word-break: break-all;    margin-top: 6px;
    font-size: 11px;
    color: var(--ws-text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
