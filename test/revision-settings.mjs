import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const folderA = { uri: { path: '/a' } };
const folderB = { uri: { path: '/b' } };
const values = new Map([['/a', {}], ['/b', {}]]);
const writes = [];
const vscode = {
    ConfigurationTarget: { WorkspaceFolder: 3 },
    window: { activeTextEditor: { document: { uri: { path: '/a/file', scheme: 'file' } } }, visibleTextEditors: [], showWarningMessage() {} },
    workspace: {
        workspaceFolders: [folderA, folderB],
        getWorkspaceFolder: uri => uri.path.startsWith('/a/') ? folderA : uri.path.startsWith('/b/') ? folderB : undefined,
        getConfiguration: (_section, uri) => ({
            get: (key, fallback) => values.get(uri?.path)?.[key] ?? fallback,
            update: async (key, value, target) => { values.get(uri.path)[key] = value; writes.push({ path: uri.path, key, value, target }); }
        })
    }
};
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/revisionSettings.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: () => vscode });
const { revisionConfig, revisionEditor, setRevisionSetting } = module.exports;

test('settings are written to the active workspace folder and restored independently', async () => {
    await setRevisionSetting('showRevisions');
    await setRevisionSetting('highlightModifiedLines');
    assert.deepEqual(writes.map(w => [w.path, w.key, w.value, w.target]), [
        ['/a', 'showRevisions', true, 3], ['/a', 'highlightModifiedLines', true, 3]
    ]);
    vscode.window.activeTextEditor.document.uri.path = '/b/file';
    assert.equal(revisionConfig().get('showRevisions', false), false);
    await setRevisionSetting('showRevisions');
    vscode.window.activeTextEditor.document.uri.path = '/a/file';
    assert.equal(revisionConfig().get('showRevisions', false), true);
    assert.equal(revisionConfig().get('highlightModifiedLines', false), true);
});

test('uses the visible file and its folder settings when reload restores panel focus', () => {
    const active = vscode.window.activeTextEditor;
    try {
        const visible = { document: { uri: { scheme: 'file', path: '/b/file' } } };
        vscode.window.visibleTextEditors = [visible];
        assert.equal(revisionEditor(), active);
        vscode.window.activeTextEditor = undefined;
        assert.equal(revisionEditor(), visible);
        assert.equal(revisionConfig().get('showRevisions', false), true);
        vscode.window.visibleTextEditors = [];
        assert.equal(revisionEditor(), undefined);
    } finally {
        vscode.window.activeTextEditor = active;
        vscode.window.visibleTextEditors = [];
    }
});

test('does not write settings for a file outside the workspace', async () => {
    vscode.window.activeTextEditor.document.uri.path = '/outside/file';
    assert.equal(await setRevisionSetting('showRevisions'), false);
    assert.equal(writes.length, 3);
});
