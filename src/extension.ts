import * as vscode from 'vscode';
import { DecorationManager } from './decorationManager';
import { DiffTreeDataProvider } from './diffTreeView';
import { GitInlineRevision, GitRevision } from './gitRevision';
import { navigateAndShowChange } from './changeNavigation';
import { GitRevisionHoverProvider } from './revisionHover';

export function activate(context: vscode.ExtensionContext): void {
    const decorations = new DecorationManager();
    const tree = new DiffTreeDataProvider(() => decorations.gitRevisionMode);
    const revisions = new GitRevision(decorations, () => tree.refresh());
    const hover = new GitRevisionHoverProvider(revisions);
    context.subscriptions.push(decorations, tree, revisions,
        vscode.window.createTreeView('diffTracker.changesView', { treeDataProvider: tree }),
        vscode.languages.registerHoverProvider({ scheme: 'file' }, hover),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('diffTracker.highlightModifiedLines')) { tree.refresh(); }
        }),
        vscode.commands.registerCommand('diffTracker.toggleHighlight', async () => {
            const config = vscode.workspace.getConfiguration('diffTracker');
            const target = config.inspect('highlightModifiedLines')?.workspaceValue === undefined
                ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
            await config.update('highlightModifiedLines', !config.get<boolean>('highlightModifiedLines', false), target);
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse || event.textEditor !== vscode.window.activeTextEditor ||
                !event.textEditor.selection.isEmpty) { return; }
            if (hover.find(event.textEditor.document, event.textEditor.selection.active)) {
                void vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
            }
        })
    );
    for (const action of ['accept', 'reject'] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`diffTracker.${action}GitRevision`, async (revision: GitInlineRevision) => {
            if (!revision) { return; }
            try {
                await revisions.applyInlineRevision(revision, action);
            } catch (error) {
                void vscode.window.showWarningMessage(`Git revision: ${error instanceof Error ? error.message : String(error)}`);
            }
        }));
    }
    for (const [command, direction] of [['previous', -1], ['next', 1]] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`diffTracker.${command}Change`, async () => {
            if (!decorations.gitRevisionMode) {
                void vscode.window.showInformationMessage('请先开启修订模式。');
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') { return; }
            if (!await navigateAndShowChange(editor, () => revisions.getChanges(editor.document), direction) &&
                vscode.window.activeTextEditor === editor) {
                void vscode.window.showInformationMessage('当前文件没有修订。');
            }
        }));
    }
}
