import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
class EventEmitter { event = () => {}; fire() {} dispose() {} }
class TreeItem { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } }
class ThemeIcon { constructor(id) { this.id = id; } }
const vscode = { EventEmitter, TreeItem, ThemeIcon, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    workspace: { getConfiguration: () => ({ get: () => true }) } };
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/diffTreeView.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'vscode' ? vscode :
    name === 'path' ? require('node:path') : require('../out/utils/displayPath') });
const { DiffTreeDataProvider } = module.exports;

function tracker(gaps = []) {
    return { getTrackedChanges: () => [], getReviewTokens: () => [], getOpaqueReviewTokens: () => [],
        getUnknownReviewTokens: () => [], getSubtreeCoverageGaps: () => gaps, getIsRecording: () => false,
        getBaselineState: () => 'idle' };
}

test('simple sidebar keeps recording controls under advanced', async () => {
    const provider = new DiffTreeDataProvider(tracker(), () => true, true);
    const items = await provider.getChildren();
    assert.deepEqual(Array.from(items, item => item.label), ['显示修订', '上一处', '下一处', '修改行背景色', '高级：录制审阅']);
    assert.equal(items[3].description, '已开启');
    assert.equal(items[3].command.arguments[0], 'highlightModifiedLines');
    assert.equal(items[0].description, '已开启');
    assert.equal(items[1].command.command, 'diffTracker.gitPreviousChange');
    const advanced = await provider.getChildren(items[4]);
    assert.equal(advanced[0].label, 'Start Recording');
    assert.equal(advanced[1].label, 'No changes tracked');
});

test('modified-line background is disabled by default', async () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(manifest.contributes.configuration.properties['diffTracker.highlightModifiedLines'].default, false);
    vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => fallback });
    try {
        const items = await new DiffTreeDataProvider(tracker(), () => true, true).getChildren();
        assert.equal(items[3].description, '已关闭');
    } finally {
        vscode.workspace.getConfiguration = () => ({ get: () => true });
    }
});

test('modified-line background toggle reflects the setting', async () => {
    vscode.workspace.getConfiguration = () => ({ get: () => false });
    try {
        const items = await new DiffTreeDataProvider(tracker(), () => true, true).getChildren();
        assert.equal(items[3].description, '已关闭');
    } finally {
        vscode.workspace.getConfiguration = () => ({ get: () => true });
    }
});

test('coverage warnings remain visible in the advanced summary', async () => {
    const provider = new DiffTreeDataProvider(tracker([{}]), () => false, true);
    const items = await provider.getChildren();
    assert.equal(items[0].description, '已关闭');
    assert.match(items[4].description, /监听需检查/);
    assert.equal(items[4].iconPath.id, 'warning');
});
