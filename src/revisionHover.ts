import * as vscode from 'vscode';
import { LineChange } from './lineChanges';
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
        const staged = this.gitRevision.isStaged(document);
        const actions = revision
            ? `${staged ? '`✓ Accept`' : `[✓ Accept](command:diffTracker.acceptGitRevision?${args})`}　[↩ Reject](command:diffTracker.rejectGitRevision?${args})　`
            : '';
        const markdown = new vscode.MarkdownString(`**${staged ? 'Staged revision' : 'Git revision'} · ${location.index} / ${location.total}**\n\n${actions}[↑](command:diffTracker.previousChange)　[↓](command:diffTracker.nextChange)`);
        markdown.isTrusted = { enabledCommands: ['diffTracker.acceptGitRevision', 'diffTracker.rejectGitRevision', 'diffTracker.previousChange', 'diffTracker.nextChange'] };
        const deleted = this.gitRevision.getDeletedText(document, position, revision);
        if (!deleted) { return new vscode.Hover(markdown, location.range); }
        const fenceLength = (deleted.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length + 1), 3);
        const fence = '`'.repeat(fenceLength);
        const original = new vscode.MarkdownString(`${fence}\n${deleted}\n${fence}`);
        return new vscode.Hover([markdown, original], location.range);
    }
}

