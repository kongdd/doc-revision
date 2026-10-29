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
    const document = { uri: { scheme: 'file', fsPath: file, toString: () => `file://${file}` }, version: 1,
        getText: () => options.current ?? 'edited', lineAt: () => ({ text: options.current?.trimEnd() ?? 'edited' }),
        offsetAt: position => position.character, positionAt: offset => ({ line: 0, character: offset }) };
    const editor = { document };
    const status = { show() {}, hide() {}, dispose() {} };
    const repository = { rootUri: { fsPath: root }, state: { HEAD: { commit: 'abc' }, onDidChange: listen('git') }, show };
    const edits = [];
    const vscode = {
        StatusBarAlignment: { Right: 1 },
        Position: class { constructor(line, character) { this.line = line; this.character = character; } },
        Range: class { constructor(start, end) { this.start = start; this.end = end; } },
        WorkspaceEdit: class { replace(uri, range, text) { edits.push({ uri, range, text }); } },
        commands: { executeCommand() {}, registerCommand: (_name, callback) => { events.toggle = callback; return { dispose() {} }; } },
        window: { activeTextEditor: editor, visibleTextEditors: [editor], createStatusBarItem: () => status, onDidChangeActiveTextEditor: listen('editor'), showWarningMessage() {} },
        workspace: { onDidChangeTextDocument: listen('document'), onDidChangeConfiguration: listen('configuration'), applyEdit: async () => true },
        extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ git: { path: 'git' }, getRepository: () => repository }) } }) }
    };
    const renders = [];
    const decorations = { clearAllDecorations() {}, updateDecorations() {}, renderLineChanges: (_editor, changes) => renders.push(changes) };
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync('src/gitRevision.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, require: name => {
        if (name === 'vscode') { return vscode; }
        if (name === 'path') { return path; }
        if (name === './utils/liveDeletedText') { return require('../out/utils/liveDeletedText'); }
        if (name === './lineChanges') { return { getLineChanges: options.changes ? () => options.changes : require('../out/lineChanges').getLineChanges }; }
        return require(name);
    }, setTimeout, clearTimeout });
    const instance = new module.exports.GitRevision(decorations);
    return { events, document, renders, decorations, status, instance, repository, edits };
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
    let resolve;
    const h = setup(() => new Promise(done => { resolve = done; }));
    const opening = h.events.toggle();
    await h.events.toggle();
    resolve('old');
    await opening;
    assert.equal(h.renders.length, 0);
    h.instance.dispose();
});
