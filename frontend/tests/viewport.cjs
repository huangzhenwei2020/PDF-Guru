const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/components/Workspace/viewport.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleResult = { exports: {} };
vm.runInNewContext(code, { exports: moduleResult.exports, module: moduleResult });
const { zoomAnchorScroll } = moduleResult.exports;
for (const factor of [0.5, 1.15, 2]) {
    const before = { left: 200, top: 120, width: 600, height: 800 };
    const after = { left: 100, top: 50, width: before.width * factor, height: before.height * factor };
    const scroll = { left: 180, top: 240 };
    const pointer = { x: 550, y: 460 };
    const result = zoomAnchorScroll(scroll, pointer, before, after);
    const x = (pointer.x - before.left) / before.width;
    const y = (pointer.y - before.top) / before.height;
    assert.ok(Math.abs(after.left - (result.left - scroll.left) + x * after.width - pointer.x) < 1e-9);
    assert.ok(Math.abs(after.top - (result.top - scroll.top) + y * after.height - pointer.y) < 1e-9);
}
const unchanged = zoomAnchorScroll({ left: 10, top: 20 }, { x: 0, y: 0 },
    { left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 100, height: 100 });
assert.equal(unchanged.left, 10);
assert.equal(unchanged.top, 20);
console.log('Pointer-centred zoom checks passed.');
