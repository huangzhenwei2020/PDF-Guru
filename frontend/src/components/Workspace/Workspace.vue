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
            <span class="ws-path" :title="store.path">{{ store.path || "尚未打开文档" }}</span>
            <span class="ws-meta" v-if="store.pageCount">{{ store.pageCount }} 页</span>
            <a-tag v-if="urlMode === 'origin'" color="orange">图源: origin</a-tag>
            <a-tag v-if="imgFailed" color="red">图片加载失败</a-tag>
        </div>

        <a-alert v-if="store.error" type="error" show-icon :message="store.error" class="ws-alert" />

        <!-- 主体：左缩略图轨道 + 右大图 -->
        <div class="ws-body">
            <div class="ws-rail">
                <div v-if="store.loading" class="ws-hint">正在解析文档…</div>
                <div v-else-if="!store.thumbs.length" class="ws-hint">打开一个 PDF 后<br />这里会列出每一页</div>
                <div v-for="t in store.thumbs" :key="t.pageIndex" class="ws-thumb"
                    :class="{ 'ws-thumb-active': t.pageIndex === store.current }" @click="store.selectPage(t.pageIndex)">
                    <img :src="url(t.url)" :width="t.width" :height="t.height" alt="" @error="onImgError" />
                    <span class="ws-thumb-no">{{ t.pageIndex + 1 }}</span>
                </div>
            </div>

            <div class="ws-canvas">
                <div v-if="store.previewLoading" class="ws-hint">渲染中…</div>
                <img v-else-if="store.preview" class="ws-preview" :src="url(store.preview.url)" alt=""
                    @error="onImgError" />
                <div v-else class="ws-hint">选择左侧任意一页查看大图</div>
            </div>
        </div>

        <!-- 诊断条：供图机制是本阶段最大的技术风险，把关键状态直接摊在界面上，
             出问题时截图即可定位，不必去翻日志。 -->
        <div class="ws-diag">
            docId={{ store.docId || "-" }} · protocol={{ protocol }} · origin={{ origin }} ·
            urlMode={{ urlMode }} · 缩略图={{ store.thumbs.length }} · 缓存={{ store.cacheRoot || "-" }}
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue';
import { message } from 'ant-design-vue';
import { FolderOpenOutlined } from '@ant-design/icons-vue';
import { SelectFile, WorkspaceAutoOpenPath } from '../../../wailsjs/go/main/App';
import { useWorkspaceState } from '../../store/workspace';

export default defineComponent({
    components: {
        FolderOpenOutlined,
    },
    setup() {
        const store = useWorkspaceState();
        const origin = window.location.origin;
        const protocol = window.location.protocol;

        // Wails 生产环境用的是 wails:// 自定义协议。相对路径在标准协议下没问题，
        // 但自定义协议下解析结果可能不同，所以准备两种形式并在失败时自动切换。
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
                if (store.error) {
                    message.error(store.error);
                }
            } catch (e: any) {
                message.error(String(e?.message ?? e));
            }
        };

        onMounted(async () => {
            store.loadCacheRoot();
            // 测试钩子：设置了 PDFGURU_WS_AUTOOPEN 就自动打开，便于无人值守截图验证
            try {
                const auto = await WorkspaceAutoOpenPath();
                if (auto) {
                    await store.open(auto);
                }
            } catch (e) {
                // 未设置该变量时忽略
            }
        });

        return { store, pickFile, url, onImgError, urlMode, imgFailed, origin, protocol };
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
    gap: 12px;
    padding: 6px 0 10px;
}

.ws-path {
    flex: 1;
    color: #888;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

.ws-rail {
    width: 190px;
    flex: 0 0 190px;
    overflow-y: auto;
    background: #fafafa;
    border-right: 1px solid #e8e8e8;
    padding: 10px;
}

.ws-thumb {
    position: relative;
    margin-bottom: 10px;
    padding: 4px;
    border: 2px solid transparent;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.ws-thumb img {
    display: block;
    margin: 0 auto;
    max-width: 100%;
    height: auto;
}

.ws-thumb-active {
    border-color: #1677ff;
}

.ws-thumb-no {
    position: absolute;
    right: 6px;
    bottom: 6px;
    font-size: 11px;
    color: #666;
    background: rgba(255, 255, 255, 0.85);
    border-radius: 3px;
    padding: 0 4px;
}

.ws-canvas {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    background: #f0f2f5;
    padding: 12px;
}

.ws-preview {
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
    background: #fff;
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
