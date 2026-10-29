import * as vscode from 'vscode';
import { LineChange } from './lineChanges';
import { getInlineRevisions } from './utils/liveDeletedText';

export interface ChangeLocation {
    line: number;
    start: number;
    end: number;
}

export function getInlineLocations(changes: readonly LineChange[], document: vscode.TextDocument): ChangeLocation[] {
    return changes.flatMap(change => {
        const line = change.lineNumber - 1;
        if (change.type !== 'modified' || change.oldText === undefined || change.newText === undefined ||
            line < 0 || line >= document.lineCount || document.lineAt(line).text !== change.newText) { return []; }
        return getInlineRevisions(change.oldText, change.newText)
            .map(item => ({ line, start: item.newStart, end: item.newEnd }));
    }).sort((a, b) => a.line - b.line || a.start - b.start);
}

export function getChangeLocations(changes: readonly LineChange[], lines: readonly string[]): ChangeLocation[] {
    if (lines.length === 0) { return []; }
    const locations: ChangeLocation[] = [];
    for (const change of changes) {
        if (change.type === 'unchanged') { continue; }
        if (change.type === 'deleted') {
            const anchor = Math.max(0, change.anchorLineNumber ?? change.lineNumber - 1);
            const line = Math.min(Math.max(0, anchor - 1), lines.length - 1);
            const column = anchor === 0 ? 0 : lines[line].length;
            locations.push({ line, start: column, end: column });
            continue;
        }
        const line = change.lineNumber - 1;
        if (line < 0 || line >= lines.length) { continue; }
        if (change.type === 'modified' && change.oldText !== undefined && change.newText === lines[line]) {
            const revisions = getInlineRevisions(change.oldText, change.newText);
            if (revisions.length) {
                locations.push(...revisions.map(item => ({ line, start: item.newStart, end: item.newEnd })));
                continue;
            }
        }
        locations.push({ line, start: 0, end: lines[line].length });
    }
    locations.sort((a, b) => a.line - b.line || a.start - b.start || a.end - b.end);
    return locations.filter((item, index) => index === 0 || item.line !== locations[index - 1].line || item.start !== locations[index - 1].start);
}

export function getChangePosition(editor: vscode.TextEditor, changes: readonly LineChange[]): { index: number; total: number } {
    const lines = Array.from({ length: editor.document.lineCount }, (_, index) => editor.document.lineAt(index).text);
    const locations = getChangeLocations(changes, lines);
    const cursor = editor.selection.active;
    const index = locations.findIndex(item => item.line === cursor.line && cursor.character >= item.start && cursor.character <= item.end);
    return { index: index + 1, total: locations.length };
}

export class ChangePositionTracker {
    private document?: vscode.TextDocument;
    private position = { index: 0, total: 0 };

    getPosition(editor: vscode.TextEditor | undefined, changes: readonly LineChange[] | undefined): { index: number; total: number } {
        if (this.document !== editor?.document) {
            this.document = editor?.document;
            this.position = { index: 0, total: 0 };
        }
        // Keep only the displayed count while the latest document version is being computed.
        if (editor && changes) { this.position = getChangePosition(editor, changes); }
        return this.position;
    }
}

export function navigateChanges(editor: vscode.TextEditor, changes: readonly LineChange[], direction: 1 | -1): boolean {
    const lines = Array.from({ length: editor.document.lineCount }, (_, index) => editor.document.lineAt(index).text);
    const locations = getChangeLocations(changes, lines);
    if (!locations.length) { return false; }
    const cursor = editor.selection.start;
    const compare = (item: ChangeLocation) => item.line - cursor.line || item.start - cursor.character;
    const target = direction === 1
        ? locations.find(item => compare(item) > 0) ?? locations[0]
        : [...locations].reverse().find(item => compare(item) < 0) ?? locations[locations.length - 1];
    const start = new vscode.Position(target.line, target.start);
    const end = new vscode.Position(target.line, target.end);
    // Keep the active cursor at the revision start for hover and navigation.
    editor.selection = new vscode.Selection(end, start);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
    return true;
}

export async function navigateAndShowChange(editor: vscode.TextEditor, getChanges: () => readonly LineChange[], direction: 1 | -1): Promise<boolean> {
    await vscode.commands.executeCommand('editor.action.hideHover');
    if (vscode.window.activeTextEditor !== editor || !navigateChanges(editor, getChanges(), direction)) { return false; }
    await vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
    return true;
}
