import * as vscode from 'vscode';
import { ChangeBlock, DiffTracker, InlineRevisionRef, LineChange, ReviewToken } from './diffTracker';
import { getInlineRevisions, shortenDeletedText } from './utils/liveDeletedText';
import { getChangeLocations } from './changeNavigation';
import { GitRevision } from './gitRevision';

function revisionLocation(document: vscode.TextDocument, position: vscode.Position, changes: readonly LineChange[]) {
    if (!changes.length) { return; }
    const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
    const locations = getChangeLocations(changes, lines);
    const index = locations.findIndex(item =>
        item.line === position.line && position.character >= item.start && position.character <= item.end);
    if (index < 0) { return; }
    const item = locations[index];
    return { range: new vscode.Range(item.line, item.start, item.line, item.end), index: index + 1, total: locations.length };
}

interface RevisionTarget {
    block: ChangeBlock;
    token: ReviewToken;
    inline?: InlineRevisionRef;
    oldText: string;
    newText: string;
    range: vscode.Range;
}

export class GitRevisionHoverProvider implements vscode.HoverProvider {
    constructor(private gitRevision: GitRevision) {}

    public find(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
        if (document.uri.scheme !== 'file') { return; }
        return revisionLocation(document, position, this.gitRevision.getChanges(document))?.range;
    }

    public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (document.uri.scheme !== 'file') { return; }
        const location = revisionLocation(document, position, this.gitRevision.getChanges(document));
        if (!location) { return; }
        const revision = this.gitRevision.getInlineRevision(document, position);
        const args = encodeURIComponent(JSON.stringify([revision]));
        const actions = revision
            ? `[✓ Accept](command:diffTracker.acceptGitRevision?${args})　[↩ Reject](command:diffTracker.rejectGitRevision?${args})　`
            : '';
        const markdown = new vscode.MarkdownString(`**Git revision · ${location.index} / ${location.total}**\n\n${actions}[↑](command:diffTracker.previousChange)　[↓](command:diffTracker.nextChange)`);
        markdown.isTrusted = { enabledCommands: ['diffTracker.acceptGitRevision', 'diffTracker.rejectGitRevision', 'diffTracker.previousChange', 'diffTracker.nextChange'] };
        return new vscode.Hover(markdown, location.range);
    }
}

export class RevisionHoverProvider implements vscode.HoverProvider {
    constructor(private tracker: DiffTracker, private isGitRevisionMode: () => boolean) {}

    public find(document: vscode.TextDocument, position: vscode.Position): RevisionTarget | undefined {
        if (document.uri.scheme !== 'file' || !this.tracker.getIsRecording() || this.isGitRevisionMode()) { return; }
        const filePath = document.uri.fsPath;
        const token = this.tracker.getReviewToken(filePath);
        if (!token) { return; }
        for (const block of this.tracker.getChangeBlocks(filePath)) {
            for (const change of block.changes) {
                if (change.type !== 'modified' || change.lineNumber !== position.line + 1 ||
                    change.originalLineNumber === undefined || change.oldText === undefined ||
                    change.newText === undefined || document.lineAt(position.line).text !== change.newText) { continue; }
                const revisions = getInlineRevisions(change.oldText, change.newText);
                for (const [index, revision] of revisions.entries()) {
                    if (position.character < revision.newStart || position.character > revision.newEnd) { continue; }
                    return {
                        block, token,
                        inline: { lineNumber: change.lineNumber, originalLineNumber: change.originalLineNumber, index },
                        oldText: revision.oldText, newText: revision.newText,
                        range: new vscode.Range(position.line, revision.newStart, position.line, revision.newEnd)
                    };
                }
            }
            if (block.type === 'added' && position.line + 1 >= block.startLine && position.line + 1 <= block.endLine) {
                const line = document.lineAt(position.line);
                return { block, token, oldText: '', newText: line.text, range: line.range };
            }
            if (block.type === 'deleted') {
                const change = block.changes.find(item => item.type === 'deleted');
                if (!change) { continue; }
                const anchor = Math.max(0, change.anchorLineNumber ?? change.lineNumber - 1);
                const line = Math.min(Math.max(0, anchor - 1), document.lineCount - 1);
                const column = anchor === 0 ? 0 : document.lineAt(line).text.length;
                if (position.line === line && position.character === column) {
                    return { block, token, oldText: block.changes.map(item => item.oldText ?? '').join('\n'), newText: '',
                        range: new vscode.Range(line, column, line, column) };
                }
            }
        }
        return;
    }

    public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const target = this.find(document, position);
        if (!target) { return; }
        const args = encodeURIComponent(JSON.stringify([document.uri.fsPath, target.block.blockId, target.token, target.inline ?? null]));
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = { enabledCommands: ['diffTracker.acceptRevision', 'diffTracker.rejectRevision', 'diffTracker.previousChange', 'diffTracker.nextChange'] };
        const location = revisionLocation(document, position, this.tracker.getLineChanges(document.uri.fsPath) ?? []);
        const count = location ? ` · ${location.index} / ${location.total}` : '';
        markdown.appendMarkdown(`**${target.inline ? 'Inline revision' : 'Change block'}${count}**\n\n`);
        markdown.appendText(`− ${shortenDeletedText(target.oldText || '∅', 160)}\n+ ${shortenDeletedText(target.newText || '∅', 160)}`);
        markdown.appendMarkdown(`\n\n[✓ Accept](command:diffTracker.acceptRevision?${args})　[↩ Reject](command:diffTracker.rejectRevision?${args})　[↑](command:diffTracker.previousChange)　[↓](command:diffTracker.nextChange)`);
        return new vscode.Hover(markdown, target.range);
    }
}
