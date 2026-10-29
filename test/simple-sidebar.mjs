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
    assert.equal(items[1].command.command, 'DocRevision.toggleHighlight');
    assert.equal(items[2].iconPath.id, 'check');
    assert.equal(items[3].command.command, 'DocRevision.showAllChanges');
    const navigation = new module.exports.DiffTreeDataProvider(() => true, () => ({ index: 2, total: 5 }), true).getChildren();
    assert.deepEqual(Array.from(navigation, item => item.label), ['修订 2 / 5', '上一处', '下一处', '接受选中行', '拒绝选中行', '全部接受', '全部拒绝']);
    assert.equal(navigation[3].command.command, 'DocRevision.acceptSelection');
    assert.equal(navigation[4].command.command, 'DocRevision.rejectSelection');
    assert.equal(navigation[5].command.command, 'DocRevision.acceptAllRevisions');
    assert.equal(navigation[6].command.command, 'DocRevision.rejectAllRevisions');
    vscode.workspace.getConfiguration = () => ({ get: () => true });
    assert.equal(new module.exports.DiffTreeDataProvider(() => true, () => ({ index: 0, total: 5 })).getChildren()[1].iconPath.id, 'eye');
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(JSON.stringify(manifest.contributes.menus ?? {}).includes('editor/context'), false);
    assert.equal(manifest.contributes.configuration.properties['DocRevision.highlightModifiedLines'].default, false);
    assert.ok(!JSON.stringify(manifest.contributes).includes('Recording'));
});

test('Sublime Merge shortcut opens the active file workspace safely', () => {
    const commands = {};
    const launches = [];
    const warnings = [];
    const disposable = { dispose() {} };
    const editor = { document: { uri: { scheme: 'file' } } };
    const mock = {
        window: { activeTextEditor: editor, createTreeView: () => disposable, onDidChangeTextEditorSelection: () => disposable,
            showWarningMessage: message => warnings.push(message) },
        workspace: { getWorkspaceFolder: () => ({ uri: { scheme: 'file', fsPath: '/project with spaces' } }),
            onDidChangeConfiguration: () => disposable },
        languages: { registerHoverProvider: () => disposable },
        commands: { registerCommand: (id, callback) => { commands[id] = callback; return disposable; } }
    };
    class Stub { refresh() {} dispose() {} }
    const extension = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync('src/extension.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module: extension, exports: extension.exports, require: name => {
        if (name === 'vscode') { return mock; }
        if (name === 'child_process') { return { execFile: (file, args, callback) => launches.push({ file, args, callback }) }; }
        return { DecorationManager: Stub, DiffTreeDataProvider: Stub, GitRevision: Stub,
            ChangePositionTracker: Stub, GitRevisionHoverProvider: Stub };
    } });
    extension.exports.activate({ subscriptions: [] });
    const open = commands['DocRevision.openSublimeMerge'];
    open();
    assert.equal(launches[0].file, 'smerge');
    assert.deepEqual(Array.from(launches[0].args), ['/project with spaces']);
    launches[0].callback(new Error('not found'));
    assert.match(warnings[0], /not found/);
    mock.workspace.getWorkspaceFolder = () => undefined;
    open();
    assert.equal(launches.length, 1);
    assert.match(warnings[1], /工作区/);
    const binding = JSON.parse(fs.readFileSync('package.json', 'utf8')).contributes.keybindings
        .find(item => item.command === 'DocRevision.openSublimeMerge');
    assert.equal(binding.key, 'cmd+ctrl+g');
    assert.equal(binding.when, 'editorTextFocus');
});
