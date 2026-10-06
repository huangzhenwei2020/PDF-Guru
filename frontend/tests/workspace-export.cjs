// Exercise the real store with only the Wails bridge mocked.
// Run with: node tests/workspace-export.cjs (from frontend/).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const pinia = require('pinia');

let captured;
let failExport = false;
let docSeq = 0;
const textPreviewRequests = [];
const bridge = {
    WorkspaceExport: async (payload) => {
        captured = JSON.parse(payload);
        if (failExport) throw new Error('export failed');
        return 'ok';
    },
    WorkspaceSetDirty: async () => {},
    WorkspaceOpen: async (file) => ({ docId: `d${++docSeq}`, path: file, pageCount: 3, pages: [] }),
    WorkspaceThumbs: async () => [],
    WorkspaceTextPreview: async (docId, pageIndex, edits, width) => {
        textPreviewRequests.push(JSON.parse(edits));
        return { pageIndex, url: `preview-${textPreviewRequests.length}`, width, height: width };
    },
};

function load(relative) {
    const file = path.join(__dirname, '..', relative);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        exports: module.exports, module,
        require: (name) => name.includes('wailsjs') ? bridge
            : name.endsWith('/model') ? model : require(name),
        console,
    }, { filename: file });
    return module.exports;
}

const model = load('src/components/Workspace/model.ts');
const { useWorkspaceState } = load('src/store/workspace.ts');

async function main() {
    pinia.setActivePinia(pinia.createPinia());
    const store = useWorkspaceState();
    await store.open('E:/original.pdf');
    assert.equal(store.dirty, false);
    store.doDelete([store.seq[0].id]);
    assert.equal(store.dirty, true);
    const savedSig = store.savedSig;
    await store.exportTo('E:/copy.pdf');
    assert.equal(store.dirty, true, 'exporting a copy must retain unsaved changes');
    assert.equal(store.savedSig, savedSig);
    assert.equal(store.mainPath, 'E:/original.pdf');

    failExport = true;
    await assert.rejects(store.exportTo('E:/failed.pdf'), /export failed/);
    assert.equal(store.dirty, true);
    assert.equal(store.saving, false);
    failExport = false;

    await store.saveAsTo('E:/adopted.pdf');
    assert.equal(store.mainPath, 'E:/adopted.pdf');
    assert.equal(store.dirty, false, 'save as must mark the adopted file saved');
    store.doDelete([store.seq[0].id]);
    await store.exportTo(store.mainPath);
    assert.equal(store.dirty, false, 'saving to the source must still mark it saved');

    await store.open('E:/original.pdf');
    store.selected = [store.seq[2].id];
    for (const name of ['watermark', 'pageNumber', 'headerFooter']) {
        store.decor[name].enabled = true;
        store.decor[name].scopeSelected = true;
    }
    store.decor.watermark.text = 'TEST';
    for (const [ids, expected] of [
        [[store.seq[2].id], [0]],
        [[store.seq[0].id, store.seq[2].id], [1]],
        [[store.seq[0].id], []],
        [null, [2]],
    ]) {
        await store.exportTo('E:/subset.pdf', { ids });
        for (const name of ['watermark', 'pageNumber', 'headerFooter']) {
            assert.deepEqual(captured.options[name].scope, expected, `${name}: scope must use export indices`);
        }
    }
    store.decor.pageNumber.scopeSelected = false;
    await store.exportTo('E:/all-decor.pdf', { ids: [store.seq[2].id] });
    assert.equal('scope' in captured.options.pageNumber, false);
    await store.open('E:/text.pdf');
    const id = store.seq[0].id;
    const edit = { id: 'native-0', source: 'native', text: 'Edited', fontSize: 12, font: 'auto', color: '#000000', angle: 0,
        rect: { x: .1, y: .2, w: .5, h: .1 }, originalRect: { x: .1, y: .2, w: .3, h: .1 } };
    store.applyTextEdit(id, edit);
    assert.equal(store.dirty, true, 'text changes must mark the document dirty');
    edit.rect.x = .9;
    assert.equal(store.seq[0].ops.textEdits[0].rect.x, .1, 'draft mutation must not alter stored edits');
    store.undo();
    assert.equal(store.seq[0].ops, undefined);
    assert.equal(store.dirty, false);
    store.redo();
    store.doDuplicate([id]);
    const duplicate = store.seq[1];
    store.applyTextEdit(duplicate.id, { ...store.seq[0].ops.textEdits[0], text: 'Different' });
    await store.fetchPreview(store.seq[0]);
    await store.fetchPreview(store.seq[1]);
    assert.equal(textPreviewRequests.length, 2, 'copies of the same source page need independent edited previews');
    assert.equal(textPreviewRequests[0][0].text, 'Edited');
    assert.equal(textPreviewRequests[1][0].text, 'Different');
    assert.equal(store.thumbOf(store.seq[0]).url, 'preview-1', 'thumbnail should reuse the edited preview');
    assert.equal(store.thumbOf(store.seq[0]).width, 150);
    store.applyCrop([id], { x: .1, y: .1, w: .8, h: .8 });
    store.clearOpsOn([id]);
    assert.equal(store.seq[0].ops.crop, undefined);
    assert.equal(store.seq[0].ops.textEdits[0].text, 'Edited', 'clear crop/masks must retain text changes');
    await store.exportTo('E:/edited.pdf');
    assert.equal(captured.items[0].ops.textEdits[0].text, 'Edited');
    store.resetTextEdit(id, 'native-0');
    assert.equal(store.seq[0].ops?.textEdits, undefined);
    assert.equal(store.seq[1].ops.textEdits[0].text, 'Different');
    await store.open('E:/restore-text.pdf');
    const restoreID = store.seq[0].id;
    store.applyTextEdit(restoreID, { ...edit, rect: { x:.1,y:.2,w:.5,h:.1 } });
    store.resetTextEdit(restoreID, edit.id);
    assert.equal(store.dirty, false, 'restoring the only text change must return to saved state');
    console.log('Workspace export and text-edit regression checks passed.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
