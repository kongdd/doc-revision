import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);

function setup(show, options = {}) {
    const events = {};
    const listen = name => callback => { events[name] = callback; return { dispose() {} }; };
    const root = options.root ?? '/repo';
    const file = path.join(root, 'a.txt');
    const document = { uri: { scheme: 'file', fsPath: file, toString: () => `file://${file}` }, version: 1, isDirty: options.dirty ?? false,
        getText: () => options.current ?? 'edited', lineAt: () => ({ text: options.current?.trimEnd() ?? 'edited' }),
        offsetAt: position => position.character, positionAt: offset => ({ line: 0, character: offset }) };
    const editor = { document };
    const status = { show() {}, hide() {}, dispose() {} };
    const repository = { rootUri: { fsPath: root }, state: { HEAD: { commit: options.commit ?? 'abc' }, onDidChange: listen('git') }, show };
    const edits = [];
    let ready = !options.notReady;
    const api = { git: { path: 'git' }, onDidOpenRepository: listen('repositoryOpen'), onDidChangeState: listen('gitState'),
        getRepository: () => ready ? repository : null };
    const vscode = {
        StatusBarAlignment: { Right: 1 },
        Position: class { constructor(line, character) { this.line = line; this.character = character; } },
        Range: class { constructor(start, end) { this.start = start; this.end = end; } },
        WorkspaceEdit: class { replace(uri, range, text) { edits.push({ uri, range, text }); } },
        commands: { executeCommand() {}, registerCommand: (_name, callback) => { events.toggle = callback; return { dispose() {} }; } },
        window: { createOutputChannel: () => ({ info() {}, warn() {}, dispose() {} }),
            activeTextEditor: options.noActive ? undefined : editor, visibleTextEditors: options.noVisible ? [] : [editor],
            createStatusBarItem: () => status, onDidChangeActiveTextEditor: listen('editor'),
            onDidChangeVisibleTextEditors: listen('visible'), showWarningMessage() {} },
        workspace: { onDidChangeTextDocument: listen('document'), onDidChangeConfiguration: listen('configuration'), applyEdit: async () => true,
            fs: { readFile: uri => fs.promises.readFile(uri.fsPath) } },
        extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => api } }) }
    };
    const settings = { showRevisions: options.enabled ?? false, showAllChanges: options.staged ?? false };
    const renders = [];
    const decorations = { clearAllDecorations() {}, updateDecorations() {}, renderLineChanges: (_editor, changes) => {
        renders.push(changes); options.onRender?.();
    } };
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync('src/gitRevision.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, require: name => {
        if (name === 'vscode') { return vscode; }
        if (name === 'path') { return path; }
        if (name === './utils/liveDeletedText') { return require('../out/utils/liveDeletedText'); }
        if (name === './lineChanges') { return { getLineChanges: options.changes ? () => options.changes : require('../out/lineChanges').getLineChanges }; }
        if (name === './revisionSettings') { return {
            revisionConfig: () => ({ get: key => settings[key] }),
            revisionEditor: () => vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0],
            setRevisionSetting: async key => { settings[key] = !settings[key]; return true; }
        }; }
        return require(name);
    }, setTimeout: (fn, delay) => { options.onTimer?.(delay); return setTimeout(fn, delay); }, clearTimeout, Buffer });
    const instance = new module.exports.GitRevision(decorations);
    return { events, document, editor, window: vscode.window, renders, decorations, status, instance, repository, edits, settings, setReady: value => { ready = value; } };
}

test('Git revisions compare against the index and can be toggled', async () => {
    const calls = [];
    const h = setup(async (...args) => { calls.push(args); return 'committed'; });
    assert.match(h.status.text, /Off/);
    await h.events.toggle();
    assert.match(h.status.text, /On/);
    assert.deepEqual(calls, [['', 'a.txt']]);
    assert.equal(h.renders[0][0].oldText, 'committed');
    assert.equal(h.renders[0][0].newText, 'edited');
    assert.equal(h.decorations.gitRevisionMode, true);
    await h.events.toggle();
    assert.equal(h.decorations.gitRevisionMode, false);
    assert.match(h.status.text, /Off/);
    h.instance.dispose();
});

test('restores revision mode from folder settings on activation and editor changes', async () => {
    const h = setup(async () => 'committed', { enabled: true });
    assert.equal(h.decorations.gitRevisionMode, true);
    assert.match(h.status.text, /On/);
    h.settings.showRevisions = false;
    await h.events.editor();
    assert.equal(h.decorations.gitRevisionMode, false);
    h.instance.dispose();
});

test('restores revisions without editor focus after reload', async () => {
    let rendered;
    const done = new Promise(resolve => { rendered = resolve; });
    const h = setup(async () => 'committed', { enabled: true, noActive: true, onRender: rendered });
    await done;
    assert.equal(h.renders.length, 1);
    h.instance.dispose();
});

test('restores revisions when the editor becomes visible without receiving focus', async () => {
    let rendered;
    const done = new Promise(resolve => { rendered = resolve; });
    const h = setup(async () => 'committed', { enabled: true, noActive: true, noVisible: true, onRender: rendered });
    assert.equal(h.renders.length, 0);
    h.window.visibleTextEditors = [h.editor];
    h.events.visible();
    await done;
    assert.equal(h.renders.length, 1);
    h.instance.dispose();
});

test('restores revisions when Git discovers the repository after startup', async () => {
    let rendered;
    const done = new Promise(resolve => { rendered = resolve; });
    const delays = [];
    const h = setup(async () => 'committed', { enabled: true, notReady: true, onRender: rendered, onTimer: delay => delays.push(delay) });
    assert.equal(h.renders.length, 0);
    h.setReady(true);
    h.events.repositoryOpen();
    assert.equal(delays.at(-1), 0);
    await done;
    assert.equal(h.renders.length, 1);
    h.instance.dispose();
});

test('restores revisions when repository HEAD becomes available', async () => {
    let rendered;
    const done = new Promise(resolve => { rendered = resolve; });
    const h = setup(async () => 'committed', { onRender: rendered });
    h.repository.state.HEAD = undefined;
    await h.events.toggle();
    assert.equal(h.renders.length, 0);
    h.repository.state.HEAD = { commit: 'abc' };
    h.events.git();
    await done;
    assert.equal(h.renders.length, 1);
    h.instance.dispose();
});

test('all-changes mode reads HEAD and index concurrently', async () => {
    let resolveIndex, headStarted;
    const started = new Promise(resolve => { headStarted = resolve; });
    const h = setup(ref => ref ? (headStarted(), Promise.resolve('committed')) : new Promise(resolve => { resolveIndex = resolve; }), { staged: true });
    const opening = h.events.toggle();
    await started;
    resolveIndex('committed');
    await opening;
    assert.equal(h.renders.length, 1);
    h.instance.dispose();
});

test('accept stages only one inline revision in a real Git index', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
        git('init', '-q');
        const original = 'The quick brown fox and lazy dog\n';
        const current = 'The quick red fox and sleepy dog\n';
        fs.writeFileSync(path.join(root, 'a.txt'), original);
        git('add', 'a.txt');
        const h = setup(async () => git('show', ':a.txt'), { root, current, changes: [{
            type: 'modified', lineNumber: 1, originalLineNumber: 1, oldText: original.trimEnd(), newText: current.trimEnd()
        }] });
        await h.events.toggle();
        const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 11 });
        assert.ok(ref);
        await h.instance.applyInlineRevision(ref, 'accept');
        assert.equal(git('show', ':a.txt'), 'The quick red fox and lazy dog\n');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
        await assert.rejects(h.instance.applyInlineRevision(ref, 'accept'), /stale/);
        h.instance.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('accept stages whole added and deleted blocks in a real Git index', async () => {
    for (const [original, current] of [['', 'added\n'], ['deleted\n', '']]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-block-'));
        const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
        try {
            git('init', '-q');
            fs.writeFileSync(path.join(root, 'a.txt'), original);
            git('add', 'a.txt');
            const h = setup(async () => git('show', ':a.txt'), { root, current });
            await h.events.toggle();
            const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 0 });
            assert.ok(ref);
            await h.instance.applyInlineRevision(ref, 'accept');
            assert.equal(git('show', ':a.txt'), current);
            assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
            h.instance.dispose();
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test('reject staged revision discards only that revision from index and disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-staged-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        git('config', 'core.autocrlf', 'false');
        const original = 'The quick brown fox and lazy dog\n';
        const current = 'The quick red fox and sleepy dog\n';
        fs.writeFileSync(path.join(root, 'a.txt'), original);
        git('add', 'a.txt');
        git('commit', '-qm', 'baseline');
        const commit = git('rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(root, 'a.txt'), current);
        git('add', 'a.txt');
        const show = async ref => git('show', `${ref || ''}:a.txt`);
        const h = setup(show, { root, commit, current, staged: true });
        await h.events.toggle();
        assert.equal(h.instance.isStaged(h.document), true);
        const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 11 });
        await assert.rejects(h.instance.applyInlineRevision(ref, 'accept'), /cannot be accepted/);
        h.document.isDirty = true;
        await assert.rejects(h.instance.applyInlineRevision(ref, 'reject'), /保存/);
        h.document.isDirty = false;
        fs.writeFileSync(path.join(root, 'a.txt'), current + 'unstaged');
        await assert.rejects(h.instance.applyInlineRevision(ref, 'reject'), /工作区文件已变更/);
        assert.equal(git('show', ':a.txt'), current);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), current + 'unstaged');
        fs.writeFileSync(path.join(root, 'a.txt'), current);
        await h.instance.applyInlineRevision(ref, 'reject');
        const expected = 'The quick brown fox and sleepy dog\n';
        assert.equal(git('show', ':a.txt'), expected);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), expected);
        h.instance.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all changes mode shows mixed changes but prevents unsafe actions', async () => {
    const head = 'The quick brown fox and lazy dog\n';
    const index = 'The quick red fox and lazy dog\n';
    const current = 'The quick red fox and sleepy dog\n';
    const h = setup(async ref => ref ? head : index, { current, staged: true });
    await h.events.toggle();
    assert.equal(h.instance.isMixed(h.document), true);
    assert.equal(h.renders[0][0].oldText, head.trimEnd());
    assert.equal(h.renders[0][0].newText, current.trimEnd());
    const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 11 });
    await assert.rejects(h.instance.applyInlineRevision(ref, 'reject'), /同时存在/);
    h.instance.dispose();
});

test('reject restores only the selected text in the editor buffer', async () => {
    const original = 'The quick brown fox and lazy dog\n';
    const current = 'The quick red fox and sleepy dog\n';
    const h = setup(async () => original, { current, changes: [{
        type: 'modified', lineNumber: 1, originalLineNumber: 1, oldText: original.trimEnd(), newText: current.trimEnd()
    }] });
    await h.events.toggle();
    const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 11 });
    await h.instance.applyInlineRevision(ref, 'reject');
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].text, 'brown');
    assert.equal(h.edits[0].range.start.character, 10);
    assert.equal(h.edits[0].range.end.character, 13);
    h.instance.dispose();
});

test('late Git results cannot repaint after revisions are hidden', async () => {
    let resolve, started;
    const pending = new Promise(done => { started = done; });
    const h = setup(() => new Promise(done => { resolve = done; started(); }));
    const opening = h.events.toggle();
    await pending;
    await h.events.toggle();
    resolve('old');
    await opening;
    assert.equal(h.renders.length, 0);
    h.instance.dispose();
});
