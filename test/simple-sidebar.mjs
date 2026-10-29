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
vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'vscode' ? vscode :
    { revisionConfig: () => vscode.workspace.getConfiguration() } });

test('sidebar shows only revision controls and defaults to no modified-line background', () => {
    const items = new module.exports.DiffTreeDataProvider(() => true, () => ({ index: 2, total: 5 })).getChildren();
    assert.deepEqual(Array.from(items, item => item.label), ['显示修订', '行背景色', 'Show Unstaged', 'Show All Changes']);
    assert.equal(items[0].description, '已开启');
    assert.equal(items[1].description, '已关闭');
    assert.equal(items[1].iconPath.id, 'eye-closed');
    assert.equal(items[1].command.command, 'diffTracker.toggleHighlight');
    assert.equal(items[2].iconPath.id, 'check');
    assert.equal(items[3].command.command, 'diffTracker.showAllChanges');
    const navigation = new module.exports.DiffTreeDataProvider(() => true, () => ({ index: 2, total: 5 }), true).getChildren();
    assert.deepEqual(Array.from(navigation, item => item.label), ['修订 2 / 5', '上一处', '下一处']);
    vscode.workspace.getConfiguration = () => ({ get: () => true });
    assert.equal(new module.exports.DiffTreeDataProvider(() => true, () => ({ index: 0, total: 5 })).getChildren()[1].iconPath.id, 'eye');
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(manifest.contributes.configuration.properties['diffTracker.highlightModifiedLines'].default, false);
    assert.ok(!JSON.stringify(manifest.contributes).includes('Recording'));
});
