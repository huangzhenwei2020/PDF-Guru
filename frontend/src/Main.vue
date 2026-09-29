<template>
    <!-- 工作区是整屏编辑器：它自带顶栏 / 左栏 / 状态栏，这里不再套任何外层框架 -->
    <Workspace v-if="isWorkspace" @open-toolbox="go('index')" @open-settings="go('settings')" />

    <!-- 工具箱：独立页面。顶栏 + 左侧功能列表 + 内容区，三段各自滚动 -->
    <div v-else class="tool-shell">
        <header class="tool-top">
            <a-button size="small" @click="go('workspace')">
                <template #icon>
                    <arrow-left-outlined />
                </template>
                返回工作区
            </a-button>
            <span class="tool-title">{{ title }}</span>
            <span class="tool-desc">{{ desc }}</span>
        </header>
        <div class="tool-body">
            <nav class="tool-nav">
                <a-menu v-model:selectedKeys="store.selectedKeys" :open-keys="store.openKeys"
                    @openChange="store.onOpenChange" mode="inline">
                    <a-menu-item key="workspace">
                        <template #icon>
                            <profile-outlined />
                        </template>
                        {{ menuRecord['workspace'] }}
                    </a-menu-item>
                    <a-menu-item key="index">
                        <template #icon>
                            <home-outlined />
                        </template>
                        {{ menuRecord['index'] }}
                    </a-menu-item>
                    <a-sub-menu key="page_edit">
                        <template #title>页面编辑</template>
                        <template #icon>
                            <form-outlined />
                        </template>
                        <a-menu-item key="insert">
                            <template #icon>
                                <login-outlined />
                            </template>
                            {{ menuRecord['insert'] }}
                        </a-menu-item>
                        <a-menu-item key="merge">
                            <template #icon>
                                <merge-cells-outlined />
                            </template>
                            {{ menuRecord['merge'] }}
                        </a-menu-item>
                        <a-menu-item key="split">
                            <template #icon>
                                <split-cells-outlined />
                            </template>
                            {{ menuRecord['split'] }}
                        </a-menu-item>
                        <a-menu-item key="rotate">
                            <template #icon>
                                <rotate-right-outlined />
                            </template>
                            {{ menuRecord['rotate'] }}
                        </a-menu-item>
                        <a-menu-item key="delete">
                            <template #icon>
                                <delete-outlined />
                            </template>
                            {{ menuRecord['delete'] }}
                        </a-menu-item>
                        <a-menu-item key="reorder">
                            <template #icon>
                                <ordered-list-outlined />
                            </template>
                            {{ menuRecord['reorder'] }}
                        </a-menu-item>
                        <a-menu-item key="crop">
                            <template #icon>
                                <scissor-outlined />
                            </template>
                            {{ menuRecord['crop'] }}
                        </a-menu-item>
                        <a-menu-item key="scale">
                            <template #icon>
                                <fullscreen-outlined />
                            </template>
                            {{ menuRecord['scale'] }}
                        </a-menu-item>
                        <a-menu-item key="cut">
                            <template #icon>
                                <borderless-table-outlined />
                            </template>
                            {{ menuRecord['cut'] }}
                        </a-menu-item>
                        <a-menu-item key="header">
                            <template #icon>
                                <credit-card-outlined />
                            </template>
                            {{ menuRecord['header'] }}
                        </a-menu-item>
                        <a-menu-item key="page_number">
                            <template #icon>
                                <field-binary-outlined />
                            </template>
                            {{ menuRecord['page_number'] }}
                        </a-menu-item>
                        <a-menu-item key="background">
                            <template #icon>
                                <bg-colors-outlined />
                            </template>
                            {{ menuRecord['background'] }}
                        </a-menu-item>
                        <a-menu-item key="annot">
                            <template #icon>
                                <message-outlined />
                            </template>
                            {{ menuRecord['annot'] }}
                        </a-menu-item>
                    </a-sub-menu>
                    <a-sub-menu key="protect">
                        <template #title>保护</template>
                        <template #icon>
                            <safety-certificate-outlined />
                        </template>
                        <a-menu-item key="watermark">
                            <template #icon>
                                <highlight-outlined />
                            </template>
                            {{ menuRecord['watermark'] }}
                        </a-menu-item>
                        <a-menu-item key="encrypt">
                            <template #icon>
                                <lock-outlined />
                            </template>
                            {{ menuRecord['encrypt'] }}
                        </a-menu-item>
                        <a-menu-item key="sign">
                            <template #icon>
                                <edit-outlined />
                            </template>
                            {{ menuRecord['sign'] }}
                        </a-menu-item>
                    </a-sub-menu>
                    <a-sub-menu key="other">
                        <template #title>其他</template>
                        <template #icon>
                            <appstore-outlined />
                        </template>
                        <a-menu-item key="bookmark">
                            <template #icon>
                                <book-outlined />
                            </template>
                            {{ menuRecord['bookmark'] }}
                        </a-menu-item>
                        <a-menu-item key="extract">
                            <template #icon>
                                <aim-outlined />
                            </template>
                            {{ menuRecord['extract'] }}
                        </a-menu-item>
                        <a-menu-item key="compress">
                            <template #icon>
                                <file-zip-outlined />
                            </template>
                            {{ menuRecord['compress'] }}
                        </a-menu-item>
                        <a-menu-item key="convert">
                            <template #icon>
                                <sync-outlined />
                            </template>
                            {{ menuRecord['convert'] }}
                        </a-menu-item>
                        <a-menu-item key="dual">
                            <template #icon>
                                <file-search-outlined />
                            </template>
                            {{ menuRecord['dual'] }}
                        </a-menu-item>
                    </a-sub-menu>
                    <a-menu-item key="settings">
                        <template #icon>
                            <SettingOutlined />
                        </template>
                        {{ menuRecord['settings'] }}
                    </a-menu-item>
                </a-menu>
            </nav>
            <main class="tool-main">
                <Index v-if="key === 'index'" />
                <MergeForm v-if="key === 'merge'" />
                <SplitForm v-if="key === 'split'" />
                <DeleteForm v-if="key === 'delete'" />
                <ReorderForm v-if="key === 'reorder'" />
                <InsertForm v-if="key === 'insert'" />
                <BookmarkForm v-if="key === 'bookmark'" />
                <ScaleForm v-if="key === 'scale'" />
                <WatermarkForm v-if="key === 'watermark'" />
                <RotateForm v-if="key === 'rotate'" />
                <CropForm v-if="key === 'crop'" />
                <CutForm v-if="key === 'cut'" />
                <ExtractForm v-if="key === 'extract'" />
                <CompressForm v-if="key === 'compress'" />
                <ConvertForm v-if="key === 'convert'" />
                <EncryptForm v-if="key === 'encrypt'" />
                <OcrForm v-if="key === 'ocr'" />
                <PreferencesForm v-if="key === 'settings'" />
                <HeaderAndFooterForm v-if="key === 'header'" />
                <PageNumberForm v-if="key === 'page_number'" />
                <BackgroundForm v-if="key === 'background'" />
                <MetaForm v-if="key === 'meta'" />
                <DualLayerForm v-if="key === 'dual'" />
                <PasswordCrackForm v-if="key === 'crack'" />
                <SignForm v-if="key === 'sign'" />
                <AnnotForm v-if="key === 'annot'" />
                <Debug v-if="key === 'debug'" />
            </main>
        </div>
    </div>
</template>
<script lang="ts">
import { computed, defineComponent } from 'vue';
import {
    MinusCircleOutlined,
    PlusOutlined,
    AppstoreOutlined,
    SettingOutlined,
    BarsOutlined,
    BorderlessTableOutlined,
    ScissorOutlined,
    CopyOutlined,
    BlockOutlined,
    FileZipOutlined,
    RotateRightOutlined,
    LockOutlined,
    OrderedListOutlined,
    HighlightOutlined,
    AimOutlined,
    ExportOutlined,
    UploadOutlined,
    FullscreenOutlined,
    CloseOutlined,
    FontColorsOutlined,
    FontSizeOutlined,
    EyeOutlined,
    SplitCellsOutlined,
    LoginOutlined,
    FormOutlined,
    DeleteOutlined,
    MergeCellsOutlined,
    InfoCircleOutlined,
    BookOutlined,
    CreditCardOutlined,
    BgColorsOutlined,
    SafetyCertificateOutlined,
    TabletOutlined,
    FieldBinaryOutlined,
    SyncOutlined,
    FileSearchOutlined,
    ToolOutlined,
    HomeOutlined,
    EditOutlined,
    StarOutlined,
    MessageOutlined,
    ProfileOutlined,
    ArrowLeftOutlined,
    createFromIconfontCN,
} from '@ant-design/icons-vue';

import { menuDesc, menuRecord } from "./components/data";
import MergeForm from "./components/Forms/MergeForm.vue";
import SplitForm from "./components/Forms/SplitForm.vue";
import DeleteForm from "./components/Forms/DeleteForm.vue";
import ReorderForm from "./components/Forms/ReorderForm.vue";
import InsertForm from "./components/Forms/InsertForm.vue";
import BookmarkForm from "./components/Forms/BookmarkForm.vue";
import ScaleForm from "./components/Forms/ScaleForm.vue";
import WatermarkForm from './components/Forms/WatermarkForm.vue';
import RotateForm from "./components/Forms/RotateForm.vue";
import CropForm from "./components/Forms/CropForm.vue";
import CutForm from "./components/Forms/CutForm.vue";
import ExtractForm from "./components/Forms/ExtractForm.vue";
import CompressForm from "./components/Forms/CompressForm.vue";
import ConvertForm from "./components/Forms/ConvertForm.vue";
import EncryptForm from "./components/Forms/EncryptForm.vue";
import OcrForm from "./components/Forms/OcrForm.vue";
import PreferencesForm from "./components/Forms/PreferencesForm.vue";
import HeaderAndFooterForm from "./components/Forms/HeaderAndFooterForm.vue";
import BackgroundForm from "./components/Forms/BackgroundForm.vue";
import PageNumberForm from "./components/Forms/PageNumberForm.vue";
import MetaForm from "./components/Forms/MetaForm.vue";
import DualLayerForm from "./components/Forms/DualLayerForm.vue";
import PasswordCrackForm from "./components/Forms/PasswordCrackForm.vue";
import Index from "./components/Forms/Index.vue";
import SignForm from "./components/Forms/SignForm.vue";
import AnnotForm from "./components/Forms/AnnotForm.vue";
import Debug from "./components/Forms/Debug.vue";
import Workspace from "./components/Workspace/Workspace.vue";
import { useMenuState } from './store/menu';

const IconFont = createFromIconfontCN({ scriptUrl: '//at.alicdn.com/t/font_8d5l8fzk5b87iudi.js' });

export default defineComponent({
    components: {
        // icon
        MinusCircleOutlined,
        PlusOutlined,
        AppstoreOutlined,
        SettingOutlined,
        BarsOutlined,
        BorderlessTableOutlined,
        ScissorOutlined,
        CopyOutlined,
        BlockOutlined,
        FileZipOutlined,
        RotateRightOutlined,
        LockOutlined,
        OrderedListOutlined,
        HighlightOutlined,
        AimOutlined,
        ExportOutlined,
        UploadOutlined,
        FullscreenOutlined,
        CloseOutlined,
        FontColorsOutlined,
        FontSizeOutlined,
        EyeOutlined,
        SplitCellsOutlined,
        LoginOutlined,
        FormOutlined,
        DeleteOutlined,
        MergeCellsOutlined,
        InfoCircleOutlined,
        BookOutlined,
        CreditCardOutlined,
        BgColorsOutlined,
        SafetyCertificateOutlined,
        TabletOutlined,
        FieldBinaryOutlined,
        SyncOutlined,
        FileSearchOutlined,
        ToolOutlined,
        HomeOutlined,
        EditOutlined,
        StarOutlined,
        MessageOutlined,
        ProfileOutlined,
        ArrowLeftOutlined,
        IconFont,
        // form
        // 合并
        MergeForm,
        // 拆分
        SplitForm,
        // 删除
        DeleteForm,
        // 重排
        ReorderForm,
        // 插入/替换
        InsertForm,
        // 书签
        BookmarkForm,
        // 缩放
        ScaleForm,
        // 水印
        WatermarkForm,
        // 旋转
        RotateForm,
        // 裁剪
        CropForm,
        // 分割/组合
        CutForm,
        // 提取
        ExtractForm,
        // 压缩
        CompressForm,
        // 转换
        ConvertForm,
        // 加密
        EncryptForm,
        // OCR
        OcrForm,
        // 首选项
        PreferencesForm,
        // 页眉页脚
        HeaderAndFooterForm,
        // 文档背景
        BackgroundForm,
        // 页码设置
        PageNumberForm,
        // 文档属性
        MetaForm,
        // 双层PDF
        DualLayerForm,
        // 密码破解
        PasswordCrackForm,
        // 首页
        Index,
        // 电子签名
        SignForm,
        // 注释
        AnnotForm,
        // 调试
        Debug,
        // 工作区（PPT 式页面编辑器）
        Workspace,
    },
    setup() {
        const store = useMenuState();
        const key = computed(() => String(store.selectedKeys.at(0) ?? 'workspace'));
        const isWorkspace = computed(() => key.value === 'workspace');
        const title = computed(() => menuRecord[key.value] || '工具箱');
        const desc = computed(() => (key.value === 'index' ? '' : menuDesc[key.value] || ''));
        /** 切换视图（工作区 <-> 工具箱） */
        const go = (k: string) => {
            store.selectedKeys = [k];
        };
        return {
            menuRecord,
            menuDesc,
            store,
            key,
            isWorkspace,
            title,
            desc,
            go,
        };
    },
});
</script>

<style scoped>
/* 工具箱：整屏三段式，各段自己滚动，整页不滚 */
.tool-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--ws-bg);
}

.tool-top {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 46px;
    padding: 0 14px;
    border-bottom: 1px solid var(--ws-border);
}

.tool-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--ws-text);
}

.tool-desc {
    font-size: 12px;
    color: var(--ws-text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tool-body {
    flex: 1;
    min-height: 0;
    display: flex;
}

.tool-nav {
    flex: 0 0 auto;
    width: 186px;
    overflow: auto;
    padding-top: 6px;
    border-right: 1px solid var(--ws-border);
    background: var(--ws-bg-subtle);
}

.tool-main {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 14px 10px 24px 16px;
}
</style>
