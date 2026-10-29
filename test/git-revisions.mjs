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
    const decorations = { clearAllDecorations() { options.onClear?.(); }, updateDecorations() {}, renderLineChanges: (_editor, changes) => {
        renders.push(changes); options.onRender?.();
    } };
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync('src/gitRevision.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, require: name => {
        if (name === 'vscode') { return vscode; }
        if (name === 'path') { return path; }
        if (name === 'diff') {
            const diff = require('diff');
            return { ...diff, diffLines: (...args) => { options.onDiff?.(); return diff.diffLines(...args); } };
        }
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
    await h.events.toggle();
    assert.deepEqual(calls, [['', 'a.txt']]);
    assert.equal(h.renders[0][0].oldText, 'committed');
    assert.equal(h.renders[0][0].newText, 'edited');
    assert.equal(h.decorations.gitRevisionMode, true);
    await h.events.toggle();
    assert.equal(h.decorations.gitRevisionMode, false);
    h.instance.dispose();
});

test('keeps decorations visible while refreshing and clears them when disabled', async () => {
    let resolveRead;
    let pending = false;
    let clears = 0;
    const h = setup(() => pending ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve('committed'),
        { onClear: () => clears++ });
    await h.events.toggle();
    assert.equal(h.renders.length, 1);
    clears = 0;
    pending = true;
    h.events.git();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(clears, 0);
    assert.equal(h.renders.length, 1);
    resolveRead('committed');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.renders.length, 2);
    assert.equal(clears, 0);
    await h.events.toggle();
    assert.equal(clears, 1);
    h.instance.dispose();
});

test('typing reuses cached Git content and Git state changes reload it', async () => {
    let reads = 0;
    const h = setup(async () => { reads++; return 'committed'; });
    await h.events.toggle();
    assert.equal(reads, 1);
    h.document.version++;
    h.events.document({ document: h.document });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(reads, 1);
    assert.equal(h.renders.length, 2);
    h.events.git();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(reads, 2);
    h.instance.dispose();
});

test('navigation distinguishes an edited document awaiting refresh from no revisions', async () => {
    const h = setup(async () => 'committed');
    await h.events.toggle();
    assert.ok(h.instance.getNavigationChanges(h.document).length);
    const ref = h.instance.getAllRevisions(h.document);
    h.document.version++;
    h.events.document({ document: h.document });
    assert.equal(h.instance.getNavigationChanges(h.document), undefined);
    assert.equal(h.instance.getChanges(h.document).length, 0);
    assert.equal(h.instance.getAllRevisions(h.document), undefined);
    await assert.rejects(h.instance.applyAllRevisions(ref, 'reject'), /修订已变化/);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.ok(h.instance.getNavigationChanges(h.document).length);
    await h.events.toggle();
    assert.equal(h.instance.getNavigationChanges(h.document).length, 0);
    h.instance.dispose();
});

test('restores revision mode from folder settings on activation and editor changes', async () => {
    const h = setup(async () => 'committed', { enabled: true });
    assert.equal(h.decorations.gitRevisionMode, true);
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
    const original = 'old line\nkeep\nremove\n';
    const current = 'new line\nkeep\nadded\n';
    await withGitIndex(original, original, current, false, async (h, git, root) => {
        h.document.isDirty = true;
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'accept');
        assert.equal(git('show', ':a.txt'), current);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
    });
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

const selectLine = line => ({ start: { line, character: 0 }, end: { line, character: 1 } });

test('selection reject does not include adjacent modified lines or overlapping selections twice', async () => {
    const h = setup(async () => 'a\nb\nc\n', { current: 'A\nB\nC\n' });
    try {
        await h.events.toggle();
        const first = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'reject', [first, first, selectLine(2)]);
        assert.deepEqual(h.edits.map(edit => [edit.range.start.character, edit.range.end.character, edit.text]),
            [[0, 2, 'a\n'], [4, 6, 'c\n']]);
    } finally { h.instance.dispose(); }
});

test('selection reject splits additions and unequal replacements by line', async () => {
    for (const [original, current, line, expected] of [
        ['a\nz\n', 'a\nx\ny\nz\n', 2, [4, 6, '']],
        ['a\nb\nc\n', 'A\nB\n', 0, [0, 2, 'a\n']],
        ['a\nb\n', 'A\nB\nC\n', 1, [2, 4, 'b\n']],
        ['a\r\nb\r\n', 'A\r\nB\r\n', 1, [3, 6, 'b\r\n']]
    ]) {
        const h = setup(async () => original, { current });
        try {
            await h.events.toggle();
            await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'reject', [selectLine(line)]);
            assert.deepEqual(h.edits.map(edit => [edit.range.start.character, edit.range.end.character, edit.text]), [expected]);
        } finally { h.instance.dispose(); }
    }
});

test('selection owns deletions at the preceding line, not the following line', async () => {
    const h = setup(async () => 'a\ndeleted\nb\n', { current: 'a\nb\n' });
    try {
        await h.events.toggle();
        const ref = h.instance.getAllRevisions(h.document);
        await assert.rejects(h.instance.applyAllRevisions(ref, 'reject', [selectLine(1)]), /选区内没有修订/);
        assert.equal(h.edits.length, 0);
        await h.instance.applyAllRevisions(ref, 'reject', [selectLine(0)]);
        assert.equal(h.edits[0].text, 'deleted\n');
    } finally { h.instance.dispose(); }
});

test('block diff is reused by hover and actions, and refreshed after document or Git changes', async () => {
    let diffs = 0;
    const options = { current: 'a\n', onDiff: () => diffs++ };
    const h = setup(async () => 'a\ndeleted\n', options);
    try {
        await h.events.toggle();
        const position = { line: 1, character: 0 };
        for (let i = 0; i < 3; i++) {
            const ref = h.instance.getInlineRevision(h.document, position);
            assert.equal(h.instance.getDeletedText(h.document, position, ref), 'deleted\n');
        }
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'reject');
        assert.equal(diffs, 1);
        options.current = 'a\nnew\n';
        h.document.version++;
        assert.equal(h.instance.getInlineRevision(h.document, position), undefined);
        await h.instance.refresh();
        h.instance.getInlineRevision(h.document, { line: 0, character: 0 });
        assert.equal(diffs, 2);
        h.events.git();
        await h.instance.refresh();
        h.instance.getInlineRevision(h.document, { line: 0, character: 0 });
        assert.equal(diffs, 3);
    } finally { h.instance.dispose(); }
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
    const original = 'old\nremove\n';
    const current = 'new\nadd\n';
    await withGitIndex(original, current, current, true, async (h, git, root) => {
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
    });
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
    const original = 'The quick brown fox and lazy dog\n';
    const current = 'The quick red fox and sleepy dog\n';
    await withGitIndex(original, original, current, false, async (h, git, root) => {
        const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 11 });
        assert.ok(ref);
        await h.instance.applyInlineRevision(ref, 'accept');
        assert.equal(git('show', ':a.txt'), 'The quick red fox and lazy dog\n');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
        await assert.rejects(h.instance.applyInlineRevision(ref, 'accept'), /stale/);
    });
});

test('repeated-character deletion is one revision for hover, reject and accept', async () => {
    const deleted = '难以充分考虑水利工程调节等影响的问题，';
    const original = `针对模型，${deleted}以步骤S4计算，数值旧。\n`;
    const current = '针对模型，以步骤S4计算，数值新。\n';
    const column = current.indexOf('以步骤');
    await withGitIndex(original, original, current, false, async (h, git, root) => {
        const position = { line: 0, character: column };
        const ref = h.instance.getInlineRevision(h.document, position);
        assert.ok(ref);
        assert.equal(h.instance.getDeletedText(h.document, position, ref), deleted);
        await h.instance.applyInlineRevision(ref, 'reject');
        assert.equal(h.edits.length, 1);
        assert.equal(h.edits[0].range.start.character, column);
        assert.equal(h.edits[0].range.end.character, column);
        assert.equal(h.edits[0].text, deleted);
        await h.instance.applyInlineRevision(ref, 'accept');
        assert.equal(git('show', ':a.txt'), '针对模型，以步骤S4计算，数值旧。\n');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
    });
});

test('accept stages whole added and deleted blocks in a real Git index', async () => {
    for (const [original, current] of [['', 'added\n'], ['deleted\n', '']]) {
        await withGitIndex(original, original, current, false, async (h, git, root) => {
            const ref = h.instance.getInlineRevision(h.document, { line: 0, character: 0 });
            assert.ok(ref);
            await h.instance.applyInlineRevision(ref, 'accept');
            assert.equal(git('show', ':a.txt'), current);
            assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), original);
        });
    }
});

test('reject staged revision discards only that revision from index and disk', async () => {
    const original = 'The quick brown fox and lazy dog\n';
    const current = 'The quick red fox and sleepy dog\n';
    await withGitIndex(original, current, current, true, async (h, git, root) => {
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
    });
});

test('all changes mode acts on one revision when staged and unstaged changes coexist', async () => {
    const head = 'a\nb\nc\nd\ne\nf\n';
    const index = 'A\nb\nc\nd\ne\nf\n';
    const current = 'A\nb\nc\nd\ne\nF\n';
    await withGitIndex(head, index, current, true, async (h, git) => {
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'accept', [selectLine(5)]);
        assert.equal(git('show', ':a.txt'), current);
    });
    await withGitIndex(head, index, current, true, async (h, git) => {
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'reject', [selectLine(0)]);
        assert.equal(git('show', ':a.txt'), head);
        assert.equal(h.edits.length, 1);
        assert.equal(h.edits[0].text, 'a\n');
    });
});

async function withGitIndex(original, index, current, staged, run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-regression-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    let h;
    try {
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        git('config', 'core.autocrlf', 'false');
        fs.writeFileSync(path.join(root, 'a.txt'), original);
        git('add', 'a.txt');
        git('commit', '-qm', 'baseline');
        const commit = git('rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(root, 'a.txt'), index);
        git('add', 'a.txt');
        h = setup(async ref => git('show', `${ref || ''}:a.txt`), { root, commit, current, staged });
        await h.events.toggle();
        await run(h, git, root);
    } finally {
        h?.instance.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('selection accept stages only one of several adjacent modified lines', async () => {
    await withGitIndex('a\nb\nc\n', 'a\nb\nc\n', 'A\nB\nC\n', false, async (h, git, root) => {
        await h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'accept', [selectLine(1)]);
        assert.equal(git('show', ':a.txt'), 'a\nB\nc\n');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a\nb\nc\n');
    });
});

test('mixed rejection reports overlapping staged changes without editing the index or buffer', async () => {
    await withGitIndex('a\nb\n', 'A\nb\n', 'B\nb\n', true, async (h, git) => {
        const all = h.instance.getAllRevisions(h.document);
        const inline = h.instance.getInlineRevision(h.document, { line: 0, character: 0 });
        await assert.rejects(h.instance.applyAllRevisions(all, 'reject'), /冲突/);
        await assert.rejects(h.instance.applyInlineRevision(inline, 'reject'), /冲突/);
        assert.equal(git('show', ':a.txt'), 'A\nb\n');
        assert.equal(h.edits.length, 0);
    });
});

test('mixed rejection handles unstaged-only and disjoint changes', async () => {
    const original = 'a\nb\nc\nd\ne\nf\n';
    const index = 'A\nb\nc\nd\ne\nf\n';
    await withGitIndex(original, index, 'A\nb\nc\nd\ne\nF\n', true, async (h, git) => {
        const ref = h.instance.getAllRevisions(h.document);
        await h.instance.applyAllRevisions(ref, 'reject', [selectLine(5)]);
        assert.equal(git('show', ':a.txt'), index);
        assert.deepEqual(h.edits.map(edit => edit.text), ['f\n']);
        h.edits.length = 0;
        await h.instance.applyAllRevisions(ref, 'reject');
        assert.equal(git('show', ':a.txt'), original);
        assert.deepEqual(h.edits.map(edit => edit.text), ['a\n', 'f\n']);
    });
});

test('mixed rejection validates every block before changing the index', async () => {
    const index = 'A\nb\nc\nd\ne\nF\n';
    await withGitIndex('a\nb\nc\nd\ne\nf\n', index, 'B\nb\nc\nd\ne\nF\n', true, async (h, git) => {
        await assert.rejects(h.instance.applyAllRevisions(h.instance.getAllRevisions(h.document), 'reject'), /冲突/);
        assert.equal(git('show', ':a.txt'), index);
        assert.equal(h.edits.length, 0);
    });
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
