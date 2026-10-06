# Workspace redesign QA

final result: passed

Reference: `docs/design/ui-concept.png`, the user-approved complete/compact design.
Captures: `docs/design/workspace-full.png` (1280×700 CSS pixels),
`docs/design/workspace-compact.png` (640×420 CSS pixels); browser screenshots at 1×.
The reference is a multi-state concept board, so the app client regions were compared separately.

## Findings and fixes

- No remaining P0/P1/P2 frontend findings.
- Fixed a P1 initialization error discovered when re-entering a populated workspace:
  the synchronous render-width watcher now starts after all dependent geometry and overlay declarations.
  Verified returning from the toolbox in both single-page and continuous modes.
- Full mode retains the thumbnail rail, command bar and bottom view toolbar;
  compact mode retains file actions, zoom, pagination, pin and an exit control.
  Controls remain accessible at 1000×600 full and 640×420 compact window client sizes.

## Required fidelity surfaces

- Typography: Segoe UI / Microsoft YaHei UI; consistent 13px command text and restrained title weight.
  Chinese labels remain readable and long document titles truncate without pushing out window controls.
- Layout: compact app bar, grouped commands, canvas-dominant body, centered bottom toolbar;
  spacing and separation follow the reference. No viewport overflow hides persistent controls.
- Colors: pale blue-gray app/canvas surfaces, navy text, cobalt primary actions, shared theme tokens.
  Existing dark theme is retained.
- Images: actual PDF raster fixture for QA, generated transparent folded-document P icon,
  vector icons from the existing Ant Design library. No drawn substitute image assets.
- Copy: real file actions and mode/pin labels; help text states middle-button pan, wheel zoom and Shift-wheel scroll.

## Interaction evidence

- Actual browser wheel input changed zoom without Ctrl.
- DOM event regression checked middle-button panning in crop mode, expected scroll distance,
  pointer cancellation, unchanged document signature and dirty flag.
- DOM event regression checked the point under the mouse remains within 2px after zoom,
  and Shift-wheel preserves native scrolling.
- Browser buttons and test bridge checked complete/compact round trip, pin on/off,
  minimum size calls and restoration of the original window size.
- Native window runtime calls are implemented with Wails APIs. OS-level always-on-top ordering,
  maximized-window behavior and physical middle-button capture still require a native desktop smoke check;
  browser bridge checks do not establish those OS effects.

## Accepted differences / follow-up polish

- Windows retains its native title bar and window controls.
- Standard icons use the existing Ant Design outline library; its crop and pan glyphs differ from the concept.
- Compact mode adds small previous/next controls so page navigation remains available without a thumbnail rail.
- The QA fixture differs from the illustrative architectural plan in the concept; user documents are rendered as-is.

## Text editing / OCR update (2026-10-06)

- Native text runs can be selected in the page preview or list, replaced/deleted, or supplemented by a new text box.
  Font size, text color, font choice and rectangle are editable; export and preview share the same Python implementation.
- Scanned text uses local PaddleOCR 3.3.3 + PaddlePaddle 3.2.2, PP-OCRv5 mobile detection/recognition,
  CPU oneDNN, up to four threads, resident worker and per-page/rotation cache.
  Source rasters are capped to a 2200px long edge and detection to 1280px.
- Actual bilingual A4 fixture (3 lines, 1190×1684px): warm inference 0.638–0.804s;
  cold process with already-downloaded models 4.57–5.84s. This is a sparse fixture, not a dense-document benchmark.
  Tested a sideways image corrected with a 90° page rotation (0.770s warm).
- Real Go bridge integration with the packaged pdf.exe passed extraction, edit preview, PDF export,
  bilingual OCR and cached repeat. Python tests cover native removal, Chinese insertion/deletion,
  adjacent text/vectors, existing rotation/crop, scanned image preservation, overflow rejecting export atomically,
  and unsupported Chinese with Helvetica rejecting rather than silently dropping characters.
- Frontend store checks cover dirty state, undo/redo, independent previews for duplicate pages, preserving text when clearing crop/masks,
  restoring the only text edit to saved state, and export payload inclusion.
- Browser QA exercised selection, editing, apply/restore, OCR mode and confidence display with a mocked bridge;
  preview raster in the capture was produced by the real Python edit implementation.
  Screenshot: `docs/design/workspace-text.png` (1000×700). No console errors.
  Toolbar bounds fit within 1000px after tightening spacing; native Windows UI input remains untested.
- Scan edits cover the original image region and add selectable replacement text; the underlying image remains.
  Fallback fonts can differ from the original and paragraphs are not automatically reflowed.

## Inline text editor redesign (2026-10-06)

final result: passed

- Selected visual truth: `docs/design/text-editor-selected.png`, the second image in the latest three-image set (floating formatting tools, direct page editing).
- Implementation: `docs/design/text-editor-inline.png`; additional responsive evidence: `docs/design/text-editor-inline-small.png`.
- Desktop CSS viewport: 1440×1024; reference raster: 1487×1058; captured implementation raster: 1423×1024 (browser screenshot usable width excludes its scrollbar). Reference was proportionally contained into the capture size with a narrow letterbox; no image stretching. Captures are at 1× density.
- State: dark theme, OCR text selected, A1立面图 edited directly on the PDF at 150%, formatting toolbar visible. The illustrative generated drawing was replaced with the actual drawing from the user's second screenshot; its source image and title strip are preserved.
- Full comparison: `docs/design/text-editor-comparison.png`. Focused toolbar/caret comparison: `docs/design/text-editor-tools-comparison.png`. Both reference and implementation were inspected together.

### Findings and iteration history

- [P2, fixed] At 1000×700, the floating toolbar shrank to the remaining width on its right and wrapped into three lines. Set its width to max-content, constrain its maximum width, and clamp its coordinates to the visible viewport. Post-fix screenshot and measured bounds show the single-row toolbar from x=229.9 to 874.6, inside the canvas x=16.7 to 983.3. Footer remains visible (y=628 to 684.7).
- [P2, fixed] Fit-to-page did not recalculate when the window changed size. ResizeObserver now recalculates only while fit mode is active, preserving custom zoom otherwise. Verified the fit control at 1000×700.
- No remaining actionable P0/P1/P2 findings.

### Required fidelity surfaces

- Typography: existing Chinese UI font and 14px controls; selected PDF text uses an embedded Droid Sans Fallback font also used by export, preventing the earlier fixed-width Latin spacing. Font size control displays one decimal. Source mock's document lettering is illustrative; actual user document typography is retained in the raster.
- Spacing/layout: full-width canvas, slim header and fixed footer, floating formatting tools above the selected text. No right-side input form or manual width/height fields. Toolbar remains inside the viewport during zoom and pan.
- Colors/tokens: existing charcoal surfaces, blue accent, light text, white paper; uses shared theme variables. Original approved application icon and Ant Design outline icons are retained instead of the invented icon in the mock.
- Image quality: user drawing is a screenshot-derived test fixture and its raster sharpness cannot improve beyond that source. Production zoom requests a higher-resolution backend render after a brief debounce, up to 4096px. Drawing content is never recreated as UI elements.
- Copy/content: read PDF, OCR, add text, restore, apply and done are accurate existing actions; auto-fit, confidence and zoom are concise. Applied edits remain undoable and require main-window Save to write the source PDF.

### Interaction and backend evidence

- Direct Chinese input on the page; text rectangle expanded from 40px to approximately 198px for longer content, then shrank back. Long content wrapped across multiple lines with textarea scrollHeight equal to clientHeight (no concealed final lines).
- Changing selection applied the current text before focusing another run. Ctrl+Enter applied the selected edit. Add text inserted an editable box in the visible page region.
- Zoom dropdown and buttons work; wheel-handler regression changed 104% to 164%; middle-button handler regression moved scroll from [16.7,0] to [136.7,100]. The floating toolbar stayed within the canvas. Event-handler pan regression uses the browser harness; physical native Windows mouse capture remains a platform smoke-test gap.
- Browser console checked after the final interactions: no errors. An early harness-only JSON error caused by the Python deprecation banner was fixed by reading its final protocol line; production reads the layout JSON file and was unaffected.
- Browser harness uses the actual TextEditor and Pinia store, screenshot-derived OCR geometry and a local server invoking the real shared Python implementation for preview and export. OCR toolbar results in the harness are fixed fixture data; production OCR is verified separately with the packaged Go bridge.
- Python regression suite: 9 tests, including rotation/crop, neighbor preservation, grow/shrink/wrap, image preservation and oversized export rejection without replacing the existing output.
- Go live integration: packaged pdf.exe extraction, auto-fit layout response, preview, export, real bilingual OCR and cache passed. Frontend build, store/undo/duplicate regression, pointer zoom checks and Go vet passed.
- Full rebuild completed and assembled the main EXE, pdf.exe, OCR runtime and font notice.

### Follow-up polish

- P3: Generated mock depicts larger illustrative document letters; real PDF text size and content take precedence. Raster-only input retains its source resolution.
- P3: Native Windows IME and physical middle-button capture have not been driven in the native window; browser interactions and composition guards cover the implemented paths.

## Text preview flicker and ghosting fix (2026-10-06)

- Editing now uses a text-free raster under the active textarea. Before that raster loads, the original and last-applied regions are covered, including when replacement text becomes shorter. The selected hit outline is hidden so it does not retain the previous rectangle.
- Preview replacement waits for bitmap decoding, keeps the last complete image on failure, and ignores obsolete responses after selection changes or closing. Applying keeps the cleaned background under the input rather than drawing the replacement twice. Restore renders the remaining edits before switching back.
- Loading feedback is an absolute overlay and does not change layout. Fit measurements reserve one CSS pixel against Windows fractional-pixel rounding; measurements use layout sizes rather than animated modal bounds. Modal positioning overrides Ant Design's defaults even when theme styles load later.
- Actual packaged Windows EXE exercised with the screenshot-derived dense drawing: real OCR, direct page editing, growing text, applying, shortening to one character, and physical wheel zoom from 52% to 96%. No remaining original/replacement text overlap was visible. Header/footer stay inside the window; the cleaned high-resolution raster retains one selected text layer.
- Native capture: `docs/design/text-editor-ghost-fix-native.png`. The source fixture contains the original screenshot's baked blue outlines; those are fixture pixels rather than extra text layers.
- A second native idle capture after the high-resolution update was pixel-identical to the first (Pillow ImageChops difference bounds: None).
- Actual component browser tests covered long text application then shortening, restore, new 220-character multiline input with scrollHeight equal to clientHeight, wheel zoom, and middle-button handler pan. Fifteen idle samples had identical page geometry and scrollbar dimensions; all preview images were complete. Physical native middle-button dragging and IME remain untested.
- Frontend decoded-image handoff, pointer zoom, and store/export regression checks passed. Production Wails build completed; `build/bin/PDF Guru.exe` is updated.
