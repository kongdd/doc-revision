import * as vscode from 'vscode';
import { LineChange } from './lineChanges';
import { collectDeletedLineGhosts, diffModifiedLine, shortenDeletedText } from './utils/liveDeletedText';

export class DecorationManager {
    public gitRevisionMode = false;
    private addedDecorationType: vscode.TextEditorDecorationType;
    private deletedDecorationType: vscode.TextEditorDecorationType;
    private modifiedDecorationType: vscode.TextEditorDecorationType;
    private deletedBadgeDecorationType: vscode.TextEditorDecorationType;
    private wordAddedDecorationType: vscode.TextEditorDecorationType;
    private wordRemovedDecorationType: vscode.TextEditorDecorationType;
    private deletedTextInlineDecorationType: vscode.TextEditorDecorationType;

    constructor() {
        // Green background for added lines (lighter shade)
        this.addedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(63, 185, 80, 0.12)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(63, 185, 80, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            gutterIconPath: this.createGutterIcon('+', '#3fb950'),
            gutterIconSize: 'contain'
        });

        // Red background for deleted lines (lighter shade)
        this.deletedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(248, 81, 73, 0.12)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(248, 81, 73, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            gutterIconPath: this.createGutterIcon('-', '#f85149'),
            gutterIconSize: 'contain'
        });

        // Yellow background for modified lines
        this.modifiedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(187, 128, 9, 0.25)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(187, 128, 9, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            gutterIconPath: this.createGutterIcon('~', '#bb8009'),
            gutterIconSize: 'contain'
        });

        this.deletedBadgeDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                color: '#f85149',
                backgroundColor: 'rgba(248, 81, 73, 0.18)',
                fontStyle: 'italic',
                textDecoration: 'none; margin-left: 12px; padding: 0 6px; border-radius: 3px;'
            }
        });

        // Render red strike-through virtual text without changing the real file.
        this.deletedTextInlineDecorationType = vscode.window.createTextEditorDecorationType({
            before: {
                color: '#f85149',
                fontStyle: 'italic',
                textDecoration: 'line-through; margin-right: 4px;'
            },
            after: {
                color: '#f85149',
                fontStyle: 'italic',
                textDecoration: 'line-through; margin-left: 4px;'
            }
        });

        // Word-level highlighting for inline diff view
        this.wordAddedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(63, 185, 80, 0.4)',
            borderRadius: '2px'
        });

        this.wordRemovedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(248, 81, 73, 0.4)',
            borderRadius: '2px'
        });
    }

    private createGutterIcon(symbol: string, color: string): vscode.Uri {
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
                <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" 
                      font-family="monospace" font-size="14" font-weight="bold" fill="${color}">
                    ${symbol}
                </text>
            </svg>
        `;
        return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    }

    public renderLineChanges(editor: vscode.TextEditor, lineChanges: readonly LineChange[]) {
        // Read settings
        const config = vscode.workspace.getConfiguration('diffTracker');
        const showDeletedBadge = config.get<boolean>('showDeletedLinesBadge', true);
        const showDeletedTextInline = config.get<boolean>('showDeletedTextInline', true);
        const highlightAdded = config.get<boolean>('highlightAddedLines', true);
        const highlightModified = config.get<boolean>('highlightModifiedLines', false);
        const highlightWordChanges = config.get<boolean>('highlightWordChanges', true);

        const addedRanges: vscode.Range[] = [];
        const modifiedRanges: vscode.Range[] = [];
        const deletedBadgeRanges: vscode.DecorationOptions[] = [];

        const deletedTextRanges: vscode.DecorationOptions[] = [];
        for (const group of collectDeletedLineGhosts(lineChanges)) {
            if (editor.document.lineCount === 0) { continue; }
            const atStart = group.anchorLine === 0;
            const lineIndex = atStart ? 0 : Math.min(group.anchorLine - 1, editor.document.lineCount - 1);
            const anchorLine = editor.document.lineAt(lineIndex);
            const position = atStart ? anchorLine.range.start : anchorLine.range.end;
            const range = new vscode.Range(position, position);
            if (showDeletedTextInline) {
                const contentText = atStart ? `${group.text} ` : ` ${group.text}`;
                deletedTextRanges.push({
                    range,
                    renderOptions: atStart
                        ? { before: { contentText } }
                        : { after: { contentText } }
                });
            } else if (showDeletedBadge) {
                const label = group.lineCount === 1 ? '- 1 line deleted' : `- ${group.lineCount} lines deleted`;
                deletedBadgeRanges.push({ range, renderOptions: { after: { contentText: label } } });
            }
        }

        const wordAddedRanges: vscode.Range[] = [];

        lineChanges.forEach(change => {
            const line = change.lineNumber - 1;
            if (line < 0 || line >= editor.document.lineCount) {
                return;
            }

            const lineText = editor.document.lineAt(line).text;
            const range = new vscode.Range(line, 0, line, lineText.length);

            switch (change.type) {
                case 'added':
                    if (highlightAdded) {
                        addedRanges.push(range);
                    }
                    break;
                case 'modified':
                    if (highlightModified) {
                        modifiedRanges.push(range);
                    }
                    if ((highlightWordChanges || showDeletedTextInline) &&
                        change.oldText !== undefined && change.newText !== undefined) {
                        const wordDiff = diffModifiedLine(change.oldText, change.newText);
                        if (highlightWordChanges) {
                            for (const part of wordDiff.added) {
                                wordAddedRanges.push(new vscode.Range(line, part.start, line, part.end));
                            }
                        }
                        if (showDeletedTextInline) {
                            for (const part of wordDiff.removed) {
                                // Zero-length range inserts visual-only ghost text at the
                                // correct current-document character offset.
                                const position = new vscode.Position(line, part.column);
                                deletedTextRanges.push({
                                    range: new vscode.Range(position, position),
                                    renderOptions: {
                                        after: { contentText: shortenDeletedText(part.text, 160) }
                                    }
                                });
                            }
                        }
                    }
                    break;
            }
        });

        editor.setDecorations(this.addedDecorationType, addedRanges);
        editor.setDecorations(this.modifiedDecorationType, modifiedRanges);
        editor.setDecorations(this.deletedDecorationType, []);
        editor.setDecorations(this.deletedBadgeDecorationType, showDeletedBadge ? deletedBadgeRanges : []);
        editor.setDecorations(this.wordAddedDecorationType, wordAddedRanges);
        editor.setDecorations(this.deletedTextInlineDecorationType, deletedTextRanges);

    }

    public clearDecorations(editor: vscode.TextEditor) {
        editor.setDecorations(this.addedDecorationType, []);
        editor.setDecorations(this.deletedDecorationType, []);
        editor.setDecorations(this.modifiedDecorationType, []);
        editor.setDecorations(this.deletedBadgeDecorationType, []);
        editor.setDecorations(this.wordAddedDecorationType, []);
        editor.setDecorations(this.wordRemovedDecorationType, []);
        editor.setDecorations(this.deletedTextInlineDecorationType, []);
    }

    public clearAllDecorations() {
        vscode.window.visibleTextEditors.forEach(editor => {
            this.clearDecorations(editor);
        });
    }

    public dispose() {
        this.addedDecorationType.dispose();
        this.deletedDecorationType.dispose();
        this.modifiedDecorationType.dispose();
        this.deletedBadgeDecorationType.dispose();
        this.wordAddedDecorationType.dispose();
        this.wordRemovedDecorationType.dispose();
        this.deletedTextInlineDecorationType.dispose();
    }

}
