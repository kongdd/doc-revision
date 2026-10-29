import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class Range { constructor(line, start, endLine, end) { Object.assign(this, { line, start, endLine, end }); } }
class MarkdownString { constructor(value = '') { this.value = value; } }
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/revisionHover.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'vscode') { return { Range, MarkdownString, Hover }; }
    if (name === './changeNavigation') { return { getChangeLocations: () => [
        { line: 0, start: 10, end: 13 }, { line: 0, start: 22, end: 28 }
    ] }; }
    throw new Error(name);
} });

test('Git hover provides revision actions, navigation and current position', () => {
    const document = { uri: { scheme: 'file' }, lineCount: 1, lineAt: () => ({ text: 'The quick red fox and sleepy dog' }) };
    const provider = new module.exports.GitRevisionHoverProvider({ getChanges: () => [{}], getInlineRevision: () => ({ request: 1 }) });
    const hover = provider.provideHover(document, { line: 0, character: 11 });
    assert.match(hover.contents.value, /Accept/);
    assert.match(hover.contents.value, /Reject/);
    assert.match(hover.contents.value, /\[↑\]/);
    assert.match(hover.contents.value, /\[↓\]/);
    assert.match(hover.contents.value, /1 \/ 2/);
    assert.match(provider.provideHover(document, { line: 0, character: 24 }).contents.value, /2 \/ 2/);
    assert.equal(provider.find(document, { line: 0, character: 5 }), undefined);
});
