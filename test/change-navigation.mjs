import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Selection {
    constructor(anchor, active) {
        this.anchor = anchor; this.active = active;
        const forward = anchor.line < active.line || (anchor.line === active.line && anchor.character <= active.character);
        this.start = forward ? anchor : active; this.end = forward ? active : anchor;
    }
}
class Range { constructor(start, end) { this.start = start; this.end = end; } }
const vscode = { Position, Selection, Range, TextEditorRevealType: { InCenter: 0 }, window: {}, commands: {} };
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/changeNavigation.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require('../out/utils/liveDeletedText') });
const { getChangeLocations, navigateChanges, navigateAndShowChange } = module.exports;

test('navigate individual edits on one line and wrap in both directions', () => {
    const text = 'The quick red fox jumps over the sleepy dog.';
    const changes = [{ type: 'modified', lineNumber: 1, oldText: 'The quick brown fox jumps over the lazy dog.', newText: text }];
    const locations = getChangeLocations(changes, [text]);
    assert.equal(locations.length, 2);
    const editor = { document: { lineCount: 1, lineAt: () => ({ text }) }, selection: new Selection(new Position(0, 0), new Position(0, 0)), revealRange() {} };
    assert.equal(navigateChanges(editor, changes, 1), true);
    assert.equal(editor.selection.start.character, locations[0].start);
    assert.equal(editor.selection.active.character, locations[0].start);
    navigateChanges(editor, changes, 1);
    assert.equal(editor.selection.start.character, locations[1].start);
    navigateChanges(editor, changes, 1);
    assert.equal(editor.selection.start.character, locations[0].start);
    navigateChanges(editor, changes, -1);
    assert.equal(editor.selection.start.character, locations[1].start);
});

test('navigation closes the old hover before showing the new cursor position', async () => {
    const text = 'The quick red fox and sleepy dog';
    const changes = [{ type: 'modified', lineNumber: 1, oldText: 'The quick brown fox and lazy dog', newText: text }];
    const editor = { document: { lineCount: 1, lineAt: () => ({ text }) }, selection: new Selection(new Position(0, 10), new Position(0, 10)), revealRange() {} };
    const calls = [];
    vscode.window.activeTextEditor = editor;
    vscode.commands.executeCommand = async (name, options) => calls.push({ name, cursor: editor.selection.active.character, options });
    assert.equal(await navigateAndShowChange(editor, () => changes, 1), true);
    assert.equal(calls[0].name, 'editor.action.hideHover');
    assert.equal(calls[0].cursor, 10);
    assert.equal(calls[1].name, 'editor.action.showHover');
    assert.equal(calls[1].cursor, 22);
    assert.equal(calls[1].options.focus, 'noAutoFocus');
});

test('consecutive deleted lines at the same anchor are one navigation stop', () => {
    const changes = [1, 2].map(originalLineNumber => ({ type: 'deleted', lineNumber: 2, anchorLineNumber: 1, originalLineNumber }));
    const locations = getChangeLocations(changes, ['first', 'second']);
    assert.equal(locations.length, 1);
    assert.equal(locations[0].line, 0);
    assert.equal(locations[0].start, 5);
});
