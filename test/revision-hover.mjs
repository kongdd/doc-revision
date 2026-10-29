import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
class Range { constructor(line, start, endLine, end) { Object.assign(this, { line, start, endLine, end }); } }
class MarkdownString {
    constructor(value = '') { this.value = value; }
    appendText(text) { this.value += text; }
    appendMarkdown(text) { this.value += text; }
}
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
const vscode = { Range, MarkdownString, Hover };
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/revisionHover.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'vscode') { return vscode; }
    if (name === './changeNavigation') { return { getChangeLocations: () => [
        { line: 0, start: 10, end: 13 }, { line: 0, start: 22, end: 28 }
    ] }; }
    return require('../out/utils/liveDeletedText');
} });
const { GitRevisionHoverProvider, RevisionHoverProvider } = module.exports;

function fixture() {
    const token = { filePath: '/a', epoch: 1, baselineRevision: 'a', currentRevision: 'b' };
    const change = { type: 'modified', lineNumber: 1, originalLineNumber: 1, oldText: 'The quick brown fox and lazy dog', newText: 'The quick red fox and sleepy dog' };
    const block = { blockId: 'block', type: 'modified', changes: [change] };
    const tracker = { getIsRecording: () => true, getReviewToken: () => token, getChangeBlocks: () => [block], getLineChanges: () => [change] };
    const document = { uri: { scheme: 'file', fsPath: '/a' }, lineCount: 1, lineAt: () => ({ text: change.newText }) };
    return { tracker, document };
}

test('hover targets one inline revision with version-bound commands', () => {
    const { tracker, document } = fixture();
    const hover = new RevisionHoverProvider(tracker, () => false).provideHover(document, { line: 0, character: 11 });
    assert.ok(hover);
    assert.match(hover.contents.value, /Accept/);
    assert.match(hover.contents.value, /Reject/);
    assert.match(hover.contents.value, /\[↑\]/);
    assert.match(hover.contents.value, /1 \/ 2/);
    const encoded = hover.contents.value.match(/acceptRevision\?([^)]*)/)[1];
    const args = JSON.parse(decodeURIComponent(encoded));
    assert.equal(args[2].currentRevision, 'b');
    assert.deepEqual(args[3], { lineNumber: 1, originalLineNumber: 1, index: 0 });
    assert.equal(hover.contents.isTrusted.enabledCommands.length, 4);
});

test('Git revision hover provides stage, discard and arrow navigation', () => {
    const { document } = fixture();
    const provider = new GitRevisionHoverProvider({ getChanges: () => [{}], getInlineRevision: () => ({ request: 1 }) });
    const hover = provider.provideHover(document, { line: 0, character: 11 });
    assert.match(hover.contents.value, /\[↑\]/);
    assert.match(hover.contents.value, /\[↓\]/);
    assert.match(hover.contents.value, /Accept/);
    assert.match(hover.contents.value, /Reject/);
    assert.match(hover.contents.value, /1 \/ 2/);
    assert.match(provider.provideHover(document, { line: 0, character: 24 }).contents.value, /2 \/ 2/);
    assert.equal(provider.find(document, { line: 0, character: 5 }), undefined);
});

test('Git mode and stale editor text suppress recording actions', () => {
    const { tracker, document } = fixture();
    assert.equal(new RevisionHoverProvider(tracker, () => true).find(document, { line: 0, character: 11 }), undefined);
    document.lineAt = () => ({ text: 'changed again' });
    assert.equal(new RevisionHoverProvider(tracker, () => false).find(document, { line: 0, character: 11 }), undefined);
});
