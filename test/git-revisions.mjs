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
        getText: () => options.current ?? 'edited',
        lineAt(line) {
            const lines = this.getText().split('\n');
            const start = lines.slice(0, line).reduce((sum, item) => sum + item.length + 1, 0);
            return { text: lines[line], rangeIncludingLineBreak: { end: { offset: start + lines[line].length + (line < lines.length - 1 ? 1 : 0) } } };
        },
        offsetAt(position) {
            if (position.offset !== undefined) { return position.offset; }
            return this.getText().split('\n').slice(0, position.line).reduce((sum, item) => sum + item.length + 1, 0) + position.character;
        },
        positionAt(offset) { return { line: 0, character: offset }; } };
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

test('all accept stages the entire editor buffer without saving', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-all-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
        git('init', '-q');
        const original = 'old line\nkeep\nremove\n';
        const current = 'new line\nkeep\nadded\n';
        fs.writeFileSync(path.join(root, 'a.txt'), original);
        git('add', 'a.txt');
        const h = setup(async () => git('show', ':a.txt'), { root, current, dirty: true });
        await h.events.toggle();
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'accept');
        assert.equal(git('show', ':a.txt'), current);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
        h.instance.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all reject restores every revision in one workspace edit', async () => {
    const original = 'old line\nkeep\nremove\n';
    const current = 'new line\nkeep\nadded\n';
    const h = setup(async () => original, { current });
    await h.events.toggle();
    const ref = h.instance.getAllRevisions(h.document);
    await h.instance.applyAllRevisions(ref, 'reject');
    assert.deepEqual(h.edits.map(edit => edit.text), ['old line\n', 'remove\n']);
    h.instance.dispose();
});

test('selection reject restores only the selected lines', async () => {
    const original = 'a\nb\nc\nd\n';
    const current = 'A\nb\nc\nD\n';
    const h = setup(async () => original, { current });
    await h.events.toggle();
    const ref = h.instance.getAllRevisions(h.document);
    const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } };
    await h.instance.applyAllRevisions(ref, 'reject', [range]);
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].range.start.character, 6);
    assert.equal(h.edits[0].text, 'd\n');
    await assert.rejects(h.instance.applyAllRevisions(ref, 'reject', [{ start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }]), /选区内没有修订/);
    h.instance.dispose();
});

test('all actions reject stale changes', async () => {
    const h = setup(async ref => ref ? 'HEAD' : 'index', { current: 'buffer', staged: true });
    await h.events.toggle();
    const ref = h.instance.getAllRevisions(h.document);
    h.document.version++;
    await assert.rejects(h.instance.applyAllRevisions(ref, 'reject'), /修订已变化/);
    h.instance.dispose();
    const unchanged = setup(async () => 'edited');
    await unchanged.events.toggle();
    assert.equal(unchanged.instance.getAllRevisions(unchanged.document), undefined);
    unchanged.instance.dispose();
});

test('all reject staged changes checks disk and restores index and disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-all-staged-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        git('config', 'core.autocrlf', 'false');
        const original = 'old\nremove\n';
        const current = 'new\nadd\n';
        fs.writeFileSync(path.join(root, 'a.txt'), original);
        git('add', 'a.txt');
        git('commit', '-qm', 'baseline');
        const commit = git('rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(root, 'a.txt'), current);
        git('add', 'a.txt');
        const h = setup(async ref => git('show', `${ref || ''}:a.txt`), { root, commit, current, staged: true });
        await h.events.toggle();
        const ref = h.instance.getAllRevisions(h.document);
        await assert.rejects(h.instance.applyAllRevisions(ref, 'accept'), /无法再次接受/);
        h.document.isDirty = true;
        await assert.rejects(h.instance.applyAllRevisions(ref, 'reject'), /保存/);
        h.document.isDirty = false;
        fs.writeFileSync(path.join(root, 'a.txt'), current + 'external');
        await assert.rejects(h.instance.applyAllRevisions(ref, 'reject'), /工作区文件已变更/);
        fs.writeFileSync(path.join(root, 'a.txt'), current);
        const past = new Date(Date.now() - 5000);
        fs.utimesSync(path.join(root, 'a.txt'), past, past); // stale stat data must not block git apply --index
        await h.instance.applyAllRevisions(ref, 'reject');
        assert.equal(git('show', ':a.txt'), original);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
        h.instance.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deleted text is exposed in full for modified and deleted blocks', async () => {
    const original = 'The quick brown fox\n';
    const current = 'The quick red fox\n';
    const h = setup(async () => original, { current });
    await h.events.toggle();
    const position = { line: 0, character: 11 };
    const ref = h.instance.getInlineRevision(h.document, position);
    assert.equal(h.instance.getDeletedText(h.document, position, ref), 'brown');
    h.instance.dispose();
    const block = setup(async () => 'first\nsecond\n', { current: '' });
    await block.events.toggle();
    const start = { line: 0, character: 0 };
    assert.equal(block.instance.getDeletedText(block.document, start, block.instance.getInlineRevision(block.document, start)), 'first\nsecond\n');
    block.instance.dispose();
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

test('all changes mode acts on one revision when staged and unstaged changes coexist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-mixed-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        const head = 'a\nb\nc\nd\ne\nf\n';
        const index = 'A\nb\nc\nd\ne\nf\n';
        const current = 'A\nb\nc\nd\ne\nF\n';
        fs.writeFileSync(path.join(root, 'a.txt'), head);
        git('add', 'a.txt');
        git('commit', '-qm', 'baseline');
        const commit = git('rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(root, 'a.txt'), index);
        git('add', 'a.txt');
        const h = setup(async ref => git('show', `${ref || ''}:a.txt`), { root, commit, current, staged: true });
        await h.events.toggle();
        const select = line => [{ start: { line, character: 0 }, end: { line, character: 1 } }];
        const ref = h.instance.getAllRevisions(h.document);
        await h.instance.applyAllRevisions(ref, 'accept', select(5));
        assert.equal(git('show', ':a.txt'), 'A\nb\nc\nd\ne\nF\n');
        h.instance.dispose();

        git('reset', '-q', '--hard');
        fs.writeFileSync(path.join(root, 'a.txt'), index);
        git('add', 'a.txt');
        const reject = setup(async ref => git('show', `${ref || ''}:a.txt`), { root, commit, current, staged: true });
        await reject.events.toggle();
        await reject.instance.applyAllRevisions(reject.instance.getAllRevisions(reject.document), 'reject', select(0));
        assert.equal(git('show', ':a.txt'), head);
        assert.equal(reject.edits.length, 1);
        assert.equal(reject.edits[0].text, 'a\n');
        reject.instance.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
