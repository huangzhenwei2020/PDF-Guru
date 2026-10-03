# Workspace redesign QA

final result: passed (frontend visual and interaction scope)

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
