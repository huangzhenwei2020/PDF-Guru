<template>
  <a-modal :visible="visible" :width="'calc(100vw - 32px)'" :footer="null" :closable="false" :mask-closable="false" class="text-editor-modal" @cancel="close">
    <header class="te-header">
      <img :src="appIcon" alt="" class="te-logo" /><h2>编辑本页文字</h2>
      <div class="te-toolbar">
        <a-button :type="source === 'native' ? 'primary' : 'default'" :disabled="!!busy" @click="loadRuns('native')"><FileTextOutlined />读取 PDF 文字</a-button>
        <a-button :type="source === 'ocr' ? 'primary' : 'default'" :loading="busy === 'ocr'" :disabled="!!busy && busy !== 'ocr'" @click="loadRuns('ocr')"><ScanOutlined />OCR 识别本页</a-button>
        <a-button :disabled="!!busy" @click="addText"><PlusOutlined />新增文字框</a-button>
      </div>
          <!-- Windows 自带 OCR 不提供置信度（给 0），这时不显示百分比：
         显示 "0%" 会让人以为识别得很差，其实是这个引擎不报这个数 -->
    <span class="te-status" v-if="draft?.source === 'ocr' && (draft.confidence || 0) > 0">OCR 置信度 {{ Math.round((draft.confidence || 0) * 100) }}%</span>
      <span class="te-status">区域自动适配</span>
      <a-button type="text" aria-label="关闭文字编辑" :disabled="!!busy" @click="close"><CloseOutlined /></a-button>
    </header>
    <!--
      OCR 组件缺失时，除了把话说清楚，还要**在这里就能修**：
      用户是在这一步撞上"未安装"的，让他再跑去别处找设置不合理。
      选中的路径会被记住（ui_state.json 的 ocr_python）。
    -->
    <a-alert v-if="error" type="error" show-icon closable @close="error = ''">
      <template #message>
        <span style="white-space: pre-line">{{ error }}</span>
        <!-- 按钮放在 message 里而不是 action 插槽：antd-vue 3 的 alert 没有 action 插槽，
             写了也不渲染（试过，界面上什么都不出现） -->
        <a-button v-if="showOcrPicker" size="small" style="margin-top: 8px;" @click="pickOcrRuntime">
          选择 OCR 运行时…
        </a-button>
      </template>
    </a-alert>
    <div ref="viewport" class="te-viewport" :class="{ panning }" :aria-busy="!!busy" @wheel.prevent="onWheel" @pointerdown="startPan" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
      <div class="te-stage" :style="stageStyle">
        <div v-if="image" ref="pageEl" class="te-page" :style="pageStyle">
          <img :src="image" :style="imageStyle" alt="本页文字编辑预览" draggable="false" />
          <button v-for="run in shownRuns" :key="run.id" class="te-hit" :class="{ changed: edits.some(e => e.id === run.id), selected: draft?.id === run.id }" :style="hitStyle(run)" :title="run.text || '已删除文字'" :aria-label="'编辑：' + (run.text || '已删除文字')" :disabled="!!busy" @click="selectRun(run)" @dblclick="focusInput"></button>
          <div v-for="(rect,index) in coverRects" :key="index" class="te-edit-cover" :style="{ ...hitStyle({rect}), background:draft?.background || '#ffffff' }"></div>
          <div v-if="draft" class="te-inline-wrap" :style="hitStyle(liveDraft)">
            <textarea ref="inputEl" v-model="draft.text" class="te-inline" :style="inlineStyle" :readonly="!!busy" aria-label="页面文字内容" placeholder="输入文字" spellcheck="false" @keydown="onInputKey" @compositionstart="composing = true" @compositionend="composing = false"></textarea>
          </div>
        </div>
      </div>
      <div v-if="busy" class="te-loading"><a-spin /><span>{{ busy === 'ocr' ? '正在识别，首次使用需加载模型…' : '正在生成预览…' }}</span></div>
      <div v-else-if="!shownRuns.length && !draft" class="te-empty">本页没有可读取的文字，可识别扫描件或新增文字框。</div>
    </div>
    <div v-if="draft" ref="toolsEl" class="te-floating" :style="floatingStyle" aria-label="文字格式工具">
      <a-select v-model:value="draft.font" :disabled="!!busy" aria-label="字体" class="te-font"><a-select-option value="auto">中英文通用字体</a-select-option><a-select-option value="helv">Helvetica（西文）</a-select-option></a-select>
      <a-input-number v-model:value="draft.fontSize" :min="4" :max="144" :step="0.5" :precision="1" :disabled="!!busy" aria-label="字号" class="te-size" />
      <label class="te-color"><input type="color" v-model="draft.color" :disabled="!!busy" aria-label="文字颜色" /><span>文字颜色</span></label>
      <label v-if="draft.source === 'ocr'" class="te-color"><input type="color" v-model="draft.background" :disabled="!!busy" aria-label="覆盖颜色" /><span>覆盖颜色</span></label>
      <a-button :disabled="!!busy || !edits.some(e => e.id === draft?.id)" @click="restore"><UndoOutlined />恢复原文字</a-button>
    </div>
    <footer class="te-footer">
      <div class="te-zoom"><a-button aria-label="缩小页面" @click="zoomBy(1/1.2)"><MinusOutlined /></a-button>
        <a-select :value="Math.round(zoom * 100)" aria-label="页面缩放" @change="setZoom(Number($event) / 100)"><a-select-option v-for="z in zoomOptions" :key="z" :value="z">{{ z }}%</a-select-option><a-select-option v-if="!zoomOptions.includes(Math.round(zoom*100))" :value="Math.round(zoom*100)">{{ Math.round(zoom*100) }}%</a-select-option></a-select>
        <a-button aria-label="放大页面" @click="zoomBy(1.2)"><PlusOutlined /></a-button><a-button @click="fitPage">适合页面</a-button>
      </div>
      <span class="te-hint">双击文字直接编辑 · 滚轮缩放 · 中键拖动</span>
      <div class="te-footer-actions"><span class="te-save-hint">{{ edits.length }} 处修改 · 应用后可撤销，保存后写入 PDF</span><a-button type="primary" :loading="busy === 'apply'" :disabled="!draft || (!!busy && busy !== 'apply')" @click="apply">应用修改</a-button><a-button :disabled="!!busy" @click="close">完成</a-button></div>
    </footer>
  </a-modal>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { FileTextOutlined, ScanOutlined, PlusOutlined, MinusOutlined, CloseOutlined, UndoOutlined } from '@ant-design/icons-vue';
import { WorkspaceTextRuns, WorkspaceOCR, WorkspaceTextPreview, WorkspaceThumbs, WorkspacePickFile, WorkspaceSetOcrRuntime } from '../../../wailsjs/go/main/App';
import { useWorkspaceState } from '../../store/workspace';
import { pageRectToDisplayRect, type TextRun, type TextEdit, type TextRuns, type PageItem, type NormRect } from './model';
import { fitText } from './textLayout';
import { zoomAnchorScroll } from './viewport';
import { createPreviewSwap } from './previewSwap';
import appIcon from '../../assets/appicon.png';

export default defineComponent({
  components: { FileTextOutlined, ScanOutlined, PlusOutlined, MinusOutlined, CloseOutlined, UndoOutlined },
  props: { visible: Boolean, initialSource: { type: String, default: 'native' } }, emits: ['update:visible'],
  setup(props, { emit }) {
    const store = useWorkspaceState(), itemID = ref('');
    const item = computed(() => store.seq.find(it => it.id === itemID.value) as PageItem | undefined);
    const edits = computed(() => item.value?.ops?.textEdits ?? []);
    const data = ref<TextRuns | null>(null), draft = ref<TextEdit | null>(null);
    const image = ref(''), busy = ref(''), source = ref('native'), error = ref('');
// 只有当错误确实与"缺 OCR 组件"有关时才给"选择运行时"按钮，
// 免得改个字号失败也冒出一个风马牛不相及的按钮
const showOcrPicker = computed(() => /OCR|ocr-runtime|运行时/.test(error.value));

/** 让用户指定 OCR 运行时里的 python.exe；选完立刻记住并重试当前的识别。 */
const pickOcrRuntime = async () => {
  try {
    const p: string = await WorkspacePickFile('选择 OCR 运行时里的 python.exe', 'exe');
    if (!p) return;
    const effective: string = await WorkspaceSetOcrRuntime(p);
    error.value = '';
    if (effective) {
      message.success('已记住 OCR 运行时位置，正在重试…');
      await loadRuns(source.value as 'native' | 'ocr');
    } else {
      error.value = '这个路径不能用作 OCR 运行时，请确认选的是 ocr-runtime 目录里的 python.exe';
    }
  } catch (e: any) {
    error.value = String(e?.message ?? e);
  }
};
    const viewport = ref<HTMLElement | null>(null), pageEl = ref<HTMLElement | null>(null), inputEl = ref<HTMLTextAreaElement | null>(null), toolsEl = ref<HTMLElement | null>(null);
    const zoom = ref(1), viewportWidth = ref(1000), viewportHeight = ref(650), scrollRevision = ref(0), panning = ref(false), composing = ref(false), fontReady = ref(false);
    const zoomOptions = [25,50,75,100,125,150,200,300,400];
    let generation = 0, signature = '', observer: ResizeObserver | null = null;
    let sharpTimer: ReturnType<typeof setTimeout> | undefined, imageWidth = 0, sharpGeneration = 0, autoFit = true;
    let committedURL = '', selectionGeneration = 0;
    const cleanSelection = ref('');
    const decodeImage = async (url:string) => {
      const bitmap = new Image(); bitmap.src = url; await bitmap.decode();
    };
    const imageSwap = createPreviewSwap(decodeImage,url => {image.value=url;});
    const backgroundEdits = () => {
      const active=draft.value;
      if(!active) return edits.value;
      const other=edits.value.filter(e=>e.id!==active.id);
      return active.source === 'new' ? other : [...other,{...clone(active),text:''}];
    };
    const coverRects = computed(() => {
      const active=draft.value;
      if(!active) return [];
      const old=edits.value.find(e=>e.id===active.id);
      // A smaller input must not reveal either the original or last applied text.
      // Once the clean native raster is ready it already preserves the vectors.
      if(cleanSelection.value===active.id) return active.source === 'ocr' && active.originalRect ? [active.originalRect] : [];
      return [active.originalRect,old?.rect].filter((r):r is NormRect=>!!r);
    });
    const dimensions = computed(() => {
      const p = item.value ? store.pageInfoOf(item.value) : null, w = p?.width ?? 595, h = p?.height ?? 842;
      return item.value?.rotation && item.value.rotation % 180 ? {w:h,h:w} : {w,h};
    });
    const pageWidth = computed(() => dimensions.value.w * zoom.value), pageHeight = computed(() => dimensions.value.h * zoom.value);
    const pageStyle = computed(() => ({width:`${pageWidth.value}px`,height:`${pageHeight.value}px`}));
    const stageStyle = computed(() => ({width:`${Math.max(viewportWidth.value,pageWidth.value+48)}px`,height:`${Math.max(viewportHeight.value,pageHeight.value+140)}px`}));
    const imageStyle = computed(() => {
      const p = item.value ? store.pageInfoOf(item.value) : null, angle = item.value?.rotation ?? 0;
      return {width:`${angle%180 ? (p?.width ?? 595)/(p?.height ?? 842)*100 : 100}%`,transform:`translate(-50%, -50%) rotate(${angle}deg)`};
    });
    const shownRuns = computed(() => {
      const overlaps = (a:NormRect,b:NormRect) => {
        const area = Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
        return area/Math.max(.000001,a.w*a.h+b.w*b.h-area) > .45;
      };
      const all = (data.value?.runs ?? []).map(r => edits.value.find(e => e.id === r.id || (e.source !== 'new' && overlaps(e.originalRect ?? e.rect,r.rect))) ?? r).filter((r,i,arr) => arr.findIndex(x => x.id === r.id) === i);
      for (const e of edits.value) if (!all.some(r => r.id === e.id)) all.push(e);
      return all;
    });
    const clone = (run:TextRun):TextEdit => JSON.parse(JSON.stringify(run));
    const layout = computed(() => {
      if (!draft.value || !data.value) return null;
      fontReady.value;
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${Number(draft.value.fontSize)||12}px ${draft.value.font === 'helv' ? 'Arial' : 'PdfText'}`;
      const measuring = draft.value.source === 'new' && !draft.value.text ? {...draft.value,text:'输入文字'} : draft.value;
      return fitText(measuring,data.value.width,data.value.height,text => context.measureText(text).width);
    });
    const liveDraft = computed(() => draft.value ? {...draft.value,rect:layout.value?.rect ?? draft.value.rect} : null);
    const rotation = computed(() => item.value ? (store.pageInfoOf(item.value)?.rotation ?? 0)+item.value.rotation : 0);
    const hitStyle = (run:{rect:NormRect} | null) => {
      const r = pageRectToDisplayRect(run?.rect ?? {x:0,y:0,w:0,h:0},rotation.value);
      return {left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.w*100}%`,height:`${r.h*100}%`};
    };
    const inlineStyle = computed(() => {
      if (!liveDraft.value || !data.value) return {};
      const d = liveDraft.value, vertical = d.angle%180 !== 0;
      const w = (vertical ? d.rect.h*data.value.height : d.rect.w*data.value.width)*zoom.value;
      const h = (vertical ? d.rect.w*data.value.width : d.rect.h*data.value.height)*zoom.value;
      return {width:`${w}px`,height:`${h}px`,fontSize:`${(Number(d.fontSize)||12)*zoom.value}px`,color:d.color,fontFamily:d.font === 'helv' ? 'Arial, sans-serif' : 'PdfText, sans-serif',background:d.source === 'ocr' ? d.background : '#ffffff',transform:`translate(-50%, -50%) rotate(${rotation.value-d.angle}deg)`};
    });
    const floatingStyle = computed(() => {
      scrollRevision.value;
      const view = viewport.value, page = pageEl.value, tools = toolsEl.value;
      if (!view || !page || !liveDraft.value) return {left:'24px',top:'100px'};
      const bounds = view.getBoundingClientRect(), p = page.getBoundingClientRect(), r = pageRectToDisplayRect(liveDraft.value.rect,rotation.value);
      const width = tools?.offsetWidth ?? 660, height = tools?.offsetHeight ?? 54;
      const left = Math.max(8,Math.min(viewportWidth.value-width-8,p.left-bounds.left+(r.x+r.w/2)*p.width-width/2));
      const top = p.top-bounds.top+r.y*p.height-height-12;
      const y = top<8 ? p.top-bounds.top+(r.y+r.h)*p.height+12 : top;
      const body = view.closest('.ant-modal-body')!.getBoundingClientRect();
      return {left:`${left+bounds.left-body.left}px`,top:`${Math.max(8,Math.min(viewportHeight.value-height-8,y))+bounds.top-body.top}px`};
    });
    const pending = () => !!draft.value && JSON.stringify(draft.value)!==signature && (!!draft.value.text || draft.value.source !== 'new');
    const focusInput = async () => {await nextTick();inputEl.value?.focus();};
    const loadEditingBackground = async () => {
      const it=item.value, active=draft.value;
      if(!it || !active) return;
      const ticket=imageSwap.invalidate(), selection=++selectionGeneration, gen=generation;
      const plan=JSON.stringify(backgroundEdits());
      try {
        const width=Math.min(4096,Math.max(store.previewWidth,imageWidth));
        const preview=await WorkspaceTextPreview(it.docId,it.pageIndex,plan,width);
        if(selection!==selectionGeneration || gen!==generation || draft.value?.id!==active.id) return;
        if(await imageSwap.replace(preview.url,ticket)) {imageWidth=preview.width;cleanSelection.value=active.id;}
      } catch(e:any) {if(gen===generation && selection===selectionGeneration)error.value=String(e?.message ?? e);}
    };
    const apply = async ():Promise<boolean> => {
      const it = item.value;
      if (!it || !draft.value || busy.value || composing.value) return false;
      if (layout.value?.overflow) {error.value='文字超出页面可用区域，请减少内容或减小字号';return false;}
      const value = clone(draft.value);
      if (!value.text && value.source === 'new') {error.value='请输入新增的文字';return false;}
      busy.value='apply';error.value='';
      sharpGeneration++;
      try {
        const proposed = [...edits.value.filter(e => e.id !== value.id),value];
        const preview = await WorkspaceTextPreview(it.docId,it.pageIndex,JSON.stringify(proposed),Math.min(4096,Math.max(store.previewWidth,Math.round(pageWidth.value))));
        const corrected:TextEdit[] = JSON.parse(preview.editsJSON);
        const fitted = corrected.find(e => e.id === value.id)!;
        await decodeImage(preview.url);
        store.applyTextEdit(it.id,fitted);draft.value=clone(fitted);signature=JSON.stringify(draft.value);
        store.previewCache[store.itemPreviewKey(item.value!)]=preview;committedURL=preview.url;
        // Keep the text-free raster under the live input; do not draw the same
        // replacement once in the raster and again in the input.
        await store.focusItem(it.id);return true;
      } catch (e:any) {error.value=String(e?.message ?? e);return false;}
      finally {busy.value='';}
    };
    const selectRun = async (run:TextRun) => {
      if (busy.value || composing.value) return;
      if (draft.value?.id === run.id) {await focusInput();return;}
      if (pending() && !await apply()) return;
      const value = clone(run);
      if (!value.originalRect && run.source !== 'new') value.originalRect={...run.rect};
      value.font=value.font === 'helv' ? 'helv' : 'auto';value.background ??= '#ffffff';value.fontSize=Math.round(value.fontSize*10)/10;
      imageSwap.invalidate();selectionGeneration++;sharpGeneration++;
      if(committedURL) image.value=committedURL;
      cleanSelection.value='';draft.value=value;signature=JSON.stringify(value);error.value='';await focusInput();scrollRevision.value++;
      void loadEditingBackground();
    };
    const setupViewport = () => {
      observer?.disconnect();const view=viewport.value;if (!view) return;
      view.removeEventListener('scroll',onScroll);view.addEventListener('scroll',onScroll,{passive:true});
      const measure = () => {
        // clientHeight rounds fractional CSS pixels up on Windows display scaling.
        // Fitting to that rounded size can repeatedly add/remove a scrollbar.
        // Use layout dimensions, not the modal's animated/transformed bounds.
        viewportWidth.value=Math.max(0,view.clientWidth-1);
        viewportHeight.value=Math.max(0,view.clientHeight-1);
      };
      observer=new ResizeObserver(() => {measure();if(autoFit)fitPage();scrollRevision.value++;});observer.observe(view);
      measure();
    };
    const loadRuns = async (kind:string) => {
      const it=item.value;if (!it || it.kind !== 'page' || busy.value) return;
      if (pending() && !await apply()) return;
      const gen=++generation;busy.value=kind;source.value=kind;error.value='';draft.value=null;
      const ticket=imageSwap.invalidate();selectionGeneration++;cleanSelection.value='';
      try {
        const result=kind === 'ocr' ? await WorkspaceOCR(it.docId,it.pageIndex,it.rotation) : await WorkspaceTextRuns(it.docId,it.pageIndex);
        if (gen !== generation) return;data.value=JSON.parse(result);
        const preview=await store.fetchPreview(it);if (gen !== generation) return;
        if(preview) {await imageSwap.replace(preview.url,ticket);committedURL=preview.url;imageWidth=preview.width;}
        await nextTick();setupViewport();fitPage();
      } catch (e:any) {if (gen === generation) error.value=String(e?.message ?? e);}
      finally {if (gen === generation) busy.value='';}
    };
    const addText = async () => {
      if (busy.value || composing.value || (pending() && !await apply())) return;
      const view=viewport.value?.getBoundingClientRect(), page=pageEl.value?.getBoundingClientRect();
      const center=view && page ? {x:Math.max(0,Math.min(.9,(view.left+view.width/2-page.left)/page.width)),y:Math.max(0,Math.min(.9,(view.top+view.height/2-page.top)/page.height)),w:.001,h:.001} : {x:.25,y:.3,w:.001,h:.001};
      const location=pageRectToDisplayRect(center,(360-rotation.value%360)%360);
      imageSwap.invalidate();selectionGeneration++;sharpGeneration++;
      if(committedURL)image.value=committedURL;
      cleanSelection.value='';
      draft.value={id:`new-${Date.now()}-${Math.random().toString(36).slice(2)}`,source:'new',text:'',rect:location,fontSize:12,font:'auto',color:'#000000',angle:0};
      signature=JSON.stringify(draft.value);error.value='';await focusInput();scrollRevision.value++;
      void loadEditingBackground();
    };
    const restore = async () => {
      if (!item.value || !draft.value || busy.value) return;
      const id=item.value.id,runID=draft.value.id;busy.value='preview';
      const ticket=imageSwap.invalidate();selectionGeneration++;sharpGeneration++;
      try {
        const ops={...item.value.ops,textEdits:edits.value.filter(e=>e.id!==runID)};
        const preview=await store.fetchPreview({...item.value,ops});
        if(preview) {await decodeImage(preview.url);store.resetTextEdit(id,runID);draft.value=null;cleanSelection.value='';await imageSwap.replace(preview.url,ticket);committedURL=preview.url;imageWidth=preview.width;}
        await store.focusItem(id);
      }
      catch (e:any) {error.value=String(e?.message ?? e);}finally {busy.value='';}
    };
    const close = async () => {if (busy.value || composing.value) return;if (pending() && !await apply()) return;emit('update:visible',false);};
    const onInputKey = (e:KeyboardEvent) => {
      if (e.isComposing || composing.value) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {e.preventDefault();apply();}
      if (e.key === 'Escape') {e.preventDefault();e.stopPropagation();inputEl.value?.blur();}
    };
    const setZoom = async (value:number,pointer?:{x:number,y:number}) => {
      const view=viewport.value,page=pageEl.value;if (!view || !page) return;
      const before=page.getBoundingClientRect(),v=view.getBoundingClientRect(),point=pointer ?? {x:v.left+v.width/2,y:v.top+v.height/2};
      const scroll={left:view.scrollLeft,top:view.scrollTop};autoFit=false;zoom.value=Math.max(.1,Math.min(6,value));await nextTick();
      const result=zoomAnchorScroll(scroll,point,before,page.getBoundingClientRect());view.scrollLeft=result.left;view.scrollTop=result.top;scrollRevision.value++;scheduleSharpPreview();
    };
    const zoomBy = (factor:number) => setZoom(zoom.value*factor);
    const onWheel = (e:WheelEvent) => setZoom(zoom.value*Math.exp(-e.deltaY*.0015),{x:e.clientX,y:e.clientY});
    const fitPage = () => {
      autoFit=true;
      zoom.value=Math.max(.1,Math.min((viewportWidth.value-48)/dimensions.value.w,(viewportHeight.value-140)/dimensions.value.h));
      if (viewport.value) {viewport.value.scrollLeft=0;viewport.value.scrollTop=0;}scrollRevision.value++;scheduleSharpPreview();
    };
    const scheduleSharpPreview = () => {
      clearTimeout(sharpTimer);
      sharpTimer=setTimeout(async()=>{
        const it=item.value;if(!it || busy.value || !props.visible) return;
        const width=Math.min(4096,Math.ceil((it.rotation%180 ? pageHeight.value : pageWidth.value)*(window.devicePixelRatio || 1)));
        if(width <= imageWidth*1.15) return;
        const revision=++sharpGeneration, gen=generation, key=JSON.stringify(backgroundEdits()), selected=draft.value?.id;
        const ticket=imageSwap.invalidate();
        try {
          const preview=JSON.parse(key).length ? await WorkspaceTextPreview(it.docId,it.pageIndex,key,width) : (await WorkspaceThumbs(it.docId,String(it.pageIndex+1),width))[0];
          if(preview && revision===sharpGeneration && gen===generation && selected===draft.value?.id) {
            if(await imageSwap.replace(preview.url,ticket)) {imageWidth=preview.width;if(selected)cleanSelection.value=selected;else committedURL=preview.url;}
          }
        } catch(e:any) { if(gen===generation)error.value=String(e?.message ?? e); }
      },250);
    };
    let panStart={x:0,y:0,left:0,top:0};
    const startPan = (e:PointerEvent) => {
      if (e.button !== 1 || !viewport.value) return;e.preventDefault();panning.value=true;
      panStart={x:e.clientX,y:e.clientY,left:viewport.value.scrollLeft,top:viewport.value.scrollTop};viewport.value.setPointerCapture(e.pointerId);
    };
    const movePan = (e:PointerEvent) => {if (panning.value && viewport.value) {viewport.value.scrollLeft=panStart.left+panStart.x-e.clientX;viewport.value.scrollTop=panStart.top+panStart.y-e.clientY;scrollRevision.value++;}};
    const endPan = () => {panning.value=false;};
    const onScroll = () => {scrollRevision.value++;};
    watch(() => props.visible,async visible => {
      if (!visible) {generation++;imageSwap.invalidate();selectionGeneration++;clearTimeout(sharpTimer);observer?.disconnect();return;}
      itemID.value=store.current;image.value='';committedURL='';cleanSelection.value='';imageWidth=0;data.value=null;draft.value=null;busy.value='';error.value='';signature='';
      await document.fonts.load('12px PdfText');fontReady.value=true;await loadRuns(props.initialSource);
    },{immediate:true});
    onBeforeUnmount(() => {generation++;imageSwap.invalidate();clearTimeout(sharpTimer);observer?.disconnect();viewport.value?.removeEventListener('scroll',onScroll);});
    return {appIcon,edits,draft,image,busy,source,error,showOcrPicker,pickOcrRuntime,shownRuns,coverRects,pageStyle,stageStyle,imageStyle,liveDraft,inlineStyle,floatingStyle,viewport,pageEl,inputEl,toolsEl,panning,composing,zoom,zoomOptions,close,loadRuns,selectRun,addText,hitStyle,apply,restore,focusInput,onInputKey,setZoom,zoomBy,onWheel,fitPage,startPan,movePan,endPan};
  },
});
</script>
<style>
@font-face {font-family:PdfText;src:url('../../assets/pdf-text.ttf') format('truetype');font-display:block;}
.ant-modal.text-editor-modal {top:16px;padding-bottom:0;max-width:1800px;}
.text-editor-modal .ant-modal-body {padding:0;position:relative;display:flex;flex-direction:column;height:calc(100vh - 32px);overflow:hidden;}
.text-editor-modal .ant-modal-content {background:var(--ws-bg);border:1px solid var(--ws-border);}
</style>
<style scoped>
.te-header {display:flex;align-items:center;gap:16px;padding:16px 20px;border-bottom:1px solid var(--ws-border);flex-shrink:0;}
.te-logo {width:30px;height:30px;}.te-header h2 {margin:0 12px 0 0;color:var(--ws-text);font-size:20px;font-weight:600;white-space:nowrap;}
.te-toolbar {display:flex;align-items:center;gap:10px;flex:1;}.te-status {color:var(--ws-text-sub);font-size:12px;white-space:nowrap;}
.te-viewport {flex:1;min-height:0;position:relative;overflow:auto;background:var(--ws-bg-canvas);overscroll-behavior:contain;}
.te-stage {display:flex;align-items:center;justify-content:center;padding:80px 24px 60px;box-sizing:border-box;}
.te-page {position:relative;flex:none;background:white;box-shadow:var(--ws-shadow-lg);}.te-page > img {position:absolute;left:50%;top:50%;height:auto;user-select:none;pointer-events:none;}
.te-hit {position:absolute;border:1px solid #1677ff50;background:transparent;padding:0;cursor:text;min-width:3px;min-height:3px;}.te-hit:hover {border-color:var(--ws-accent);background:#1677ff12;}.te-hit.changed {border-color:#52c41a;}
.te-hit.selected {visibility:hidden;}
.te-inline-wrap {position:absolute;outline:2px solid var(--ws-accent);z-index:2;}.te-inline {position:absolute;left:50%;top:50%;display:block;margin:0;border:0;padding:0;border-radius:0;outline:none;line-height:1.31;resize:none;overflow:hidden;overflow-wrap:anywhere;word-break:break-all;letter-spacing:0;}
.te-edit-cover {position:absolute;z-index:1;pointer-events:none;}
.te-floating {position:absolute;z-index:5;display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:10px 12px;width:max-content;max-width:calc(100% - 48px);background:var(--ws-bg);color:var(--ws-text);border:1px solid var(--ws-border);border-radius:6px;box-shadow:var(--ws-shadow-lg);}
.te-font {width:190px;}.te-size {width:78px;}.te-color {display:flex;align-items:center;gap:8px;margin:0;font-size:13px;white-space:nowrap;}.te-color input {width:30px;height:30px;border:1px solid var(--ws-border-strong);background:transparent;padding:2px;cursor:pointer;}
.te-footer {display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-top:1px solid var(--ws-border);flex-shrink:0;color:var(--ws-text-sub);font-size:12px;}.te-zoom,.te-footer-actions {display:flex;align-items:center;gap:8px;}.te-zoom .ant-select {width:86px;}.te-hint {text-align:center;}.te-save-hint {max-width:240px;}.te-footer-actions {margin-left:auto;}
.te-loading {position:absolute;left:12px;top:12px;padding:12px;display:flex;align-items:center;gap:12px;background:var(--ws-bg);color:var(--ws-text-sub);z-index:6;pointer-events:none;}.te-empty {position:absolute;left:24px;top:20px;color:var(--ws-text-sub);font-size:13px;}.panning,.panning * {cursor:grabbing !important;user-select:none;}
@media(max-width:1100px) {.te-header {gap:10px;padding:12px;}.te-status {display:none;}.te-header h2 {font-size:18px;margin-right:0;}.te-hint {display:none;}.te-footer {gap:8px;padding:12px;}}
@media(max-width:760px) {.te-header {flex-wrap:wrap;}.te-logo {display:none;}.te-toolbar {order:2;flex-basis:100%;}.te-header > .ant-btn {margin-left:auto;}.te-footer {flex-wrap:wrap;}.te-save-hint {display:none;}.te-floating {gap:8px;}.te-font {width:160px;}}
</style>
