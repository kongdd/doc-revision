import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class EventEmitter { event = () => {}; fire() {} dispose() {} }
class TreeItem { constructor(label) { this.label = label; } }
class ThemeIcon { constructor(id) { this.id = id; } }
const vscode = { EventEmitter, TreeItem, ThemeIcon, TreeItemCollapsibleState: { None: 0 },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/diffTreeView.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: () => vscode });

test('sidebar shows only revision controls and defaults to no modified-line background', () => {
    const items = new module.exports.DiffTreeDataProvider(() => true).getChildren();
    assert.deepEqual(Array.from(items, item => item.label), ['显示修订', '上一处', '下一处', '修改行背景色']);
    assert.equal(items[0].description, '已开启');
    assert.equal(items[3].description, '已关闭');
    assert.equal(items[3].command.command, 'diffTracker.toggleHighlight');
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(manifest.contributes.configuration.properties['diffTracker.highlightModifiedLines'].default, false);
    assert.ok(!JSON.stringify(manifest.contributes).includes('Recording'));
});
