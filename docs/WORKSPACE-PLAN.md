# PDF Guru 工作区（PPT 式 PDF 页面编辑器）开发计划

> 版本：v1 草案
> 基线：fork 自 `kevin2li/PDF-Guru` @ `f67a40f`，本地已可编译运行

---

## 0. 目标 / 非目标

### 目标

把页面级操作从 **「选功能 → 填表单 → 生成一个新文件」** 改成
**「打开文档 → 在画布上直接摆弄页面 → 保存」**。

- **左侧**：页面大纲（缩略图），可拖动重排、框选多选、删除、复制
- **中间**：当前页大图预览
- **右侧**：属性 / 插入面板
- **操作手感对齐 PPT**：所有编辑先作用在内存模型上，随时撤销重做，最后统一保存

### 非目标（至少前几个阶段不做）

- **不做 PDF 正文内容编辑**（改字、换图、重排版面）。那是另一类产品（Acrobat 编辑模式），成本量级完全不同，且需要字体子集化、重排引擎。
- **不启用 OCR**。`ocr.py` 依赖 `cv2` / `paddleocr` / `matplotlib` / `tqdm`，而 `thirdparty/requirements.txt` 一个都没列（官方 CI 也只拷文件不装依赖），源码构建版跑不起来。要么补依赖，要么先从功能表摘掉。
- **不删现有 28 个表单**。工作区与它们并存，老功能键位不变，降低回归风险。

---

## 1. 现状（已实测核实，非推测）

### 技术栈

| 层 | 技术 | 位置 |
|---|---|---|
| 桌面壳 | Wails v2（`go.mod` 声明 v2.5.1，实际用 CLI v2.16.0 构建） | 仓库根 |
| 后端 | Go 1.20+，70 个绑定方法 | `*.go` |
| PDF 引擎 | Python + PyMuPDF，冻结成单文件 `pdf.exe` | `thirdparty/*.py` |
| 前端 | Vue 3 + Ant Design Vue 3 + Pinia + Vite 3 | `frontend/src` |

### 前端结构（关键约束）

- `Main.vue` = 左侧 `a-menu` + 右侧用 `v-if` 硬切 28 个表单组件，**没有 vue-router**
- 每个功能 = `components/Forms/XxxForm.vue` + `store/xxx.ts` 一一对应
- 调用后端：`import { XxxPDF } from '../../../wailsjs/go/main/App'`，错误经 `handleOps` 统一处理
- `Index.vue`（73KB）是"功能列表"首页，即一整块点选磁贴

### 后端调用链

```
Vue 组件 → wailsjs 绑定 → App.方法 → cmdRunner(args, "pdf")
        → 执行 pdf.exe <子命令> → Python 写 ~/.pdf_guru/cmd_output.json
        → Go 读该文件判断 success/error → 返回 error 给前端
```

**注意**：`cmd_output.json` 是**全局单文件**。并发执行两条 pdf 命令会互相覆盖，工作区必须串行化调用。

### 三个必须知道的缺口

1. **前端没有任何显示本地图片的能力。** 全仓库 70 个 Go 接口里没有读文件/读图片的，前端也没有任何 `base64` / `data:image` / `convertFileSrc` 用法。→ 缩略图这块要从零铺。
2. **`assetserver.Options.Handler http.Handler` 在 v2.5.1 就存在**（已读 `pkg/options/assetserver/options.go` 源码确认）。`Assets` 命中失败（`os.ErrNotExist`）后回落到 `Handler`。→ **可以用自定义 HTTP 路由供图，与 SPA 静态资源不冲突**。这是整个方案的关键解锁点。
3. **`requirements.txt` 完全没钉版本**，当前装到 `pymupdf 1.28.2` / `numpy 2.5.3` / `reportlab 5.0.1`，而代码是 2023 年针对 `pymupdf 1.22/1.23` 写的。目前实测 15+ 命令可用，但属于定时炸弹。

### 上游已有的缺陷（Phase 0 要修，因为工作区会复用这些能力）

| # | 功能 | 根因 | 位置 |
|---|---|---|---|
| 1 | PDF删除 | `output_dir` 只在 `output_path is None` 时赋值，但 GUI 总会传 `-o` → `UnboundLocalError`；且文件名硬编码 `-切片.pdf`，无视 `-o` | `thirdparty/slice.py:15,22` + `delete.go:9` |
| 2 | 遮罩 | 调了 `os.remove` 但**没有 `import os`** → `NameError`。文件其实生成了，却返回 error 且残留临时文件 | `thirdparty/mask.py:57,89` |
| 3 | 页眉页脚 / 页码设置 | Go 端只在字体非空时才传 `--font-family`，argparse 填成 `None`，**覆盖了 Python 函数签名的默认值 `msyh.ttc`** | `header_and_footer.go:50`、`page_number.go:42` → `header_and_footer.py:31` |
| 4 | 设置密码 / 添加水印 | 同类"空参数覆盖默认值"：`encrypt.py:23` 直接 `for v in perm` 而 perm 可为 `None`；水印同理 | `encrypt.go:12`、`watermark.go:19` |

---

## 2. 架构

### 2.1 核心：编辑的是「页面模型」，不是「文件」

这是与上游最本质的区别。上游每个命令都是**破坏式**的：选范围 → 立刻写出一个新 PDF。
PPT 式编辑器要反过来：**内存里维护一份页面清单，所有操作只改清单，最后统一落盘。**

```ts
// 工作区的唯一真相
type PageRef = {
  id: string          // 稳定唯一 id，用于 DnD 追踪与 key
  docId: string       // 来自哪个源文档
  pageIndex: number   // 源文档内的页序号（0-based）
  rotation: 0|90|180|270
}
type BlankPage = { id: string; blank: { paper: string; orientation: string } }
type Item = PageRef | BlankPage

type WorkspaceState = {
  seq: Item[]                                   // 页面顺序 = 数组顺序
  sources: Record<string, { path: string; pageCount: number }>
  selection: Set<string>                        // 多选
  past: Item[][]; future: Item[][]              // 撤销栈
}
```

**由此得到的好处：**

| 操作 | 上游做法 | 工作区做法 |
|---|---|---|
| 重排 | 启动 python 进程写新文件 | 数组 `splice` —— 零延迟 |
| 删除 | 同上 | 数组过滤 |
| 旋转 | 同上 | 改一个字段 |
| 复制页 | 不支持 | 数组插入同一 `PageRef` |
| 撤销 | **不可能** | 快照栈，天然支持 |

一个 1000 页文档的 `seq` 序列化约 60KB，**每次操作存一份全量快照**即可 —— 撤消/重做实现简单到不会出错，100 步也才 6MB。不要上增量 diff，不值得。

### 2.2 三层改动清单

#### 后端 Go（新增 `workspace.go`）

```go
type PageInfo struct { Index int; Width, Height float64; Rotation int }
type DocInfo  struct { ID, Path string; PageCount int; Pages []PageInfo }
type Thumb    struct { Index int; URL string; Width, Height int }

func (a *App) WorkspaceOpen(path string) (DocInfo, error)          // 登记文档，读取页尺寸
func (a *App) WorkspaceThumbs(docID string, pages []int, w int) ([]Thumb, error)
func (a *App) WorkspaceApply(planJSON string, outFile string) error // 落盘
func (a *App) WorkspaceClose(docID string) error
```

- 内存注册表 `docID -> path`，`docID` 由 Go 生成，**前端只拿 id，不碰真实路径**（避免路径穿越与前端拼接错误）
- 缓存目录 `~/.pdf_guru/ws/<sessionID>/`
- 所有 pdf 命令走一把 `sync.Mutex`，规避 `cmd_output.json` 竞争
- 启动时清理超过 N 天的历史缓存目录

#### 资源服务（改 `main.go`）

```go
AssetServer: &assetserver.Options{
    Assets:  assets,
    Handler: http.HandlerFunc(wsHandler),  // 服务 /ws/thumb/<docID>/<page>@<rot>.png
}
```

- **必须做路径校验**：只允许访问缓存根目录下的文件，拒绝 `..`
- 加 `Cache-Control: max-age=31536000, immutable`，文件名里带内容指纹，浏览器缓存直接生效，切页几乎零等待
- 这条路也顺带解决了"大 PDF 不经过 JSON 桥"的问题 —— Go↔JS 之间**只传路径和元数据，永不传文件字节**

#### PDF 引擎 Python（新增 `thirdparty/workspace.py`，并注册 2 个子命令）

```
ws-render <doc> --pages 1,2,3 --width 160 --outdir DIR   # 批量出缩略图，一次进程搞定
ws-build  <plan.json> -o out.pdf                          # 按清单合成 PDF
```

- **`ws-render` 必须批量**。若每页起一个 python 进程，1000 页就是 1000 次 PyInstaller 冷启动（每次数百 ms），体验直接崩。一次调用渲染一批，是硬性要求。
- `ws-build` 用 PyMuPDF 直接写，不复用 `merge.py`/`insert.py`：
  ```python
  for it in plan["pages"]:
      if it.get("blank"): writer.new_page(...)
      else:
          writer.insert_pdf(src_docs[it["src"]], from_page=it["i"], to_page=it["i"])
          writer[-1].set_rotation(it["rot"])
  ```
  源文档按 `docId` 缓存句柄，避免重复打开。
- 现有 `pdf.py` 的所有子命令**一行不改**，老表单行为完全不变。

#### 前端（新增目录 `components/Workspace/`）

```
Workspace.vue          三栏布局
├─ ThumbRail.vue       左：缩略图轨道（DnD / 多选 / 虚拟滚动）
├─ PageCanvas.vue      中：当前页大图
├─ Inspector.vue       右：属性与插入面板
└─ Toolbar.vue         顶部：撤销/重做/旋转/删除/导出
store/workspace.ts     页面模型 + 撤销栈 + 与后端通信
Workspace/model.ts     纯函数：movePages/deletePages/rotatePages/...（可单测）
```

- `Main.vue` 加一个顶级菜单项**「工作区」**并设为默认落地页；现有功能列表保留为「工具箱」
- 拖拽：优先 `vuedraggable@4`（SortableJS，Vue 3 兼容）。自带多选拖动、插入指示线，手写 HTML5 DnD 在这些细节上很费时间，不值得。代价约 40KB。
- 撤销/重做：`Ctrl+Z` / `Ctrl+Shift+Z`；操作粒度 = 一次用户动作（如"拖动 3 页"算一步）

---

## 3. 阶段划分

每个阶段结束时都产出**可运行、可截图验证**的版本，不做"三个月后一起交付"。

### Phase 0 —— 基线加固（小，但必须先做）

- [x] 修掉上表 4 个上游缺陷（老 UI 与新 UI 同时受益）
- [x] `requirements.txt` 钉死版本（`pymupdf==1.28.2` 等当前实测可用组合）
- [x] 决定并处理 OCR 依赖：暂不引入约 1GB 的 paddle 系依赖，**先从界面隐藏入口**

**验收结果（已完成）**：`_smoke/smoke.ps1` 从 12 项失败转为 **33/33 通过**。
实际修了 5 处，比预估多一处——排查中发现 `encrypt.py` 用的
`Document.isEncrypted` 在 PyMuPDF 1.28 已被移除（改名 `is_encrypted`），
这正是"依赖未钉版本"埋下的雷，也印证了本节第 2 条的必要性。

### Phase 1 —— 打通"供图"这条命脉（技术风险最高，先做）

- [ ] `main.go` 挂 `assetserver.Handler`，提供一个能列出/返回缓存目录文件的端点
- [ ] `WorkspaceOpen` + `ws-render` 出图
- [ ] 前端最简页面：打开一个 PDF，左侧列出全部页面缩略图（能滚动、能看到图）

**验收**：截图里能看到真实页面缩略图。**这一步不通，后面全是空谈，所以放在最前。**

### Phase 2 —— PPT 核心交互（本阶段结束就已经"好用"了）

- [ ] 拖动重排（含多选一起拖、跨位置插入）
- [ ] 点击选中 / Ctrl 多选 / Shift 范围选 / Ctrl+A
- [ ] 删除选中页、复制选中页、顺时针/逆时针旋转
- [ ] 撤销 / 重做（快照栈）
- [ ] 工具栏按钮状态随选中态联动
- [ ] 中央大图跟随当前选中页

**验收**：一条 30 页文档，能靠拖拽重排、删掉 3 页、旋转 2 页，全程 `<100ms` 无卡顿，`Ctrl+Z` 能逐步回退。

### Phase 3 —— 插入与文档级合并

- [ ] 插入空白页（可选纸张/方向/数量）
- [ ] 从另一个 PDF 插入指定页
- [ ] 从图片（PNG/JPG）插入为新页
- [ ] 整个 PDF 追加到末尾
- [ ] 「提取选中页为新文档」/「拆分到多个文档」

**验收**：能把 A.pdf 的第 2 页和 B.pdf 的第 5-7 页混进同一份文档并导出，页序与旋转正确。

### Phase 4 —— 保存与导出

- [ ] `ws-build` 落盘；「另存为」与「覆盖原文件」两条路径
- [ ] 覆盖前自动备份原文件为 `.bak`（**破坏性操作必须有后悔药**）
- [ ] 导出选中页 / 导出全部
- [ ] 导出时可挂压缩选项（复用 `compress_pdf`）
- [ ] 未保存状态提示、关闭窗口前拦截

**验收**：构建出的 PDF 用 PyMuPDF 脚本断言（页数、页序、旋转、内容哈希）全部通过。

### Phase 5 —— 页面内容编辑（复用现有 Python 能力）

把老功能挂到"选中页"上，而不是让用户手填页码范围：

- [ ] 裁剪（鼠标在画布上拉框）→ `crop_pdf_by_bbox`
- [ ] 遮罩（拉框 + 颜色/透明度）
- [ ] 水印 / 页码 / 页眉页脚（作用域 = 选中页或全部）
- [ ] 删除批注 / 提取该页文本与图片

**验收**：所有操作都支持"只对选中页生效"，且仍可撤销。

### Phase 6 —— 打磨

- [ ] 大文档性能：缩略图虚拟滚动（1000 页）、按可见区渐进渲染、磁盘缓存 LRU
- [ ] 缩略图尺寸调节、单页/双页/连续视图切换
- [ ] 快捷键面板、右键菜单、拖拽到窗口直接打开
- [ ] 深色主题、界面文案统一

---

## 4. 已拍板的决策

1. **工作区与老界面：并存。**
   工作区做默认落地页；老功能列表保留，退到「工具箱」。
   理由：老表单覆盖了工作区短期不会做的能力（转换、加密、OCR、双层 PDF），砍掉等于功能缩水。

2. **保存语义：默认「另存为」，另提供「保存」。**
   「保存」覆盖原文件前**自动备份 `.bak`**。
   理由：兼顾 PPT 用户「改完 Ctrl+S」的习惯，同时给 PDF 这种不可逆格式留后悔药。

3. **OCR：待定。**
   Phase 0 必须先给出结论——补 `opencv-python` / `paddleocr` / `matplotlib` / `tqdm`
   （paddle 系依赖体积约 1GB 量级），或先从功能表隐藏。默认倾向**先隐藏**，不在首个版本引入重依赖。

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 自定义 `Handler` 在真实构建里不生效 | **高**，方案地基 | Phase 1 第一件事就验证，先用最简端点打通再往下做 |
| 大文档缩略图渲染慢 | 高 | 单次批量调用 + 低 DPI（宽 160px）+ 懒加载 + 磁盘缓存 + 虚拟滚动 |
| `pymupdf` 版本漂移导致既有命令突然挂 | 中 | Phase 0 钉版本，并把 smoke 脚本固化成回归测试 |
| `cmd_output.json` 全局单文件竞争 | 中 | Go 侧一把互斥锁串行化所有 pdf 调用 |
| 前端 bundle 已 1.6MB，再加 DnD/虚拟滚动 | 低 | 工作区组件用 Vite 动态 `import()` 懒加载，不拖慢首屏 |
| 路径穿越 / 任意文件读取 | 中 | `docID` 间接引用 + Handler 内强制前缀校验 |
| 许可 AGPL-3.0 | 中 | 自用无影响；**一旦发 Release 给别人用，衍生版本必须同样开源并提供源码** |

---

## 6. 验证方式

沿用这次已经跑通的三种手段，每阶段都要过：

1. **纯逻辑单测**：`model.ts` 的页面操作是纯函数，用 vitest 直接测（重排/删除/多选/撤销），不依赖 GUI。
2. **后端脚本断言**：`ws-build` 输出的 PDF 用 PyMuPDF 读回来，断言页数/页序/旋转/内容。
3. **GUI 截图验证**：`_smoke/shot2.ps1` 已能"把窗口置顶 → 截图 → 我看图"，每次改完前端都跑一遍，确认真的渲染出来了（不是白屏、不是报错页）。

**性能预算**：1000 页文档，打开到首屏可见缩略图 ≤ 1.5s；单次重排/删除交互 ≤ 100ms。

---

## 附：为什么不做"每个功能一个表单"的延续

上游的分工是：每个 PDF 操作 = 一个表单 + 页码范围输入框。这在"一次性批处理"的场景是合理的，
但页面级编辑的本质是**反复微调**：拖一下、删一页、再拖回去。每步都要求用户手写 `5-N,4,1-3`
这种页码范围，是把内部数据结构直接暴露给用户，认知负担和出错率都高。

工作区把这层结构**可视化**掉：范围不再是文本，而是"我选中的那几张图"。
因此它不是一个新皮肤，而是把同一批后端能力换了一种交互范式 —— 这也是为什么必须先有页面模型，
而不能直接在老表单上套一层拖拽。
