const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/Workspace/previewSwap.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const result = {exports:{}};
vm.runInNewContext(code,{exports:result.exports,module:result});
const deferred = () => {let resolve,reject;const promise = new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function main() {
    const loads = new Map(), shown = [];
    const swap = result.exports.createPreviewSwap(url=>{
        const task=deferred();loads.set(url,task);return task.promise;
    },url=>shown.push(url));
    const old=swap.replace('old-response');
    const newer=swap.replace('new-response');
    assert.equal(shown.length,0,'the existing image must remain while decoding');
    loads.get('new-response').resolve();
    assert.equal(await newer,true);
    loads.get('old-response').resolve();
    assert.equal(await old,false,'late older work must not replace the current image');
    assert.deepEqual(shown,['new-response']);
    const invalid=swap.replace('closed-page');swap.invalidate();loads.get('closed-page').resolve();
    assert.equal(await invalid,false);
    const failed=swap.replace('broken-image');loads.get('broken-image').reject(new Error('decode failed'));
    await assert.rejects(failed,/decode failed/);
    assert.deepEqual(shown,['new-response'],'decode failure must not blank the displayed page');
    console.log('Decoded preview handoff and stale-response checks passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
