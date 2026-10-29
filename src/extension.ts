import * as vscode from 'vscode';
import { DecorationManager } from './decorationManager';
import { DiffTreeDataProvider } from './diffTreeView';
import { GitInlineRevision, GitRevision } from './gitRevision';
import { getChangePosition, navigateAndShowChange } from './changeNavigation';
import { GitRevisionHoverProvider } from './revisionHover';
import { revisionEditor, setRevisionSetting } from './revisionSettings';

export function activate(context: vscode.ExtensionContext): void {
    const decorations = new DecorationManager();
    const getPosition = () => {
        const editor = revisionEditor();
        return editor ? getChangePosition(editor, revisions.getChanges(editor.document)) : { index: 0, total: 0 };
    };
    const tree = new DiffTreeDataProvider(() => decorations.gitRevisionMode, getPosition);
    const navigation = new DiffTreeDataProvider(() => decorations.gitRevisionMode, getPosition, true);
    const revisions = new GitRevision(decorations, () => { tree.refresh(); navigation.refresh(); });
    const hover = new GitRevisionHoverProvider(revisions);
    context.subscriptions.push(decorations, tree, navigation, revisions,
        vscode.window.createTreeView('diffTracker.changesView', { treeDataProvider: tree }),
        vscode.window.createTreeView('diffTracker.navigationView', { treeDataProvider: navigation }),
        vscode.languages.registerHoverProvider({ scheme: 'file' }, hover),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('diffTracker.highlightModifiedLines') || event.affectsConfiguration('diffTracker.showAllChanges')) { tree.refresh(); }
        }),
        vscode.commands.registerCommand('diffTracker.toggleHighlight', () => setRevisionSetting('highlightModifiedLines')),
        vscode.commands.registerCommand('diffTracker.showUnstaged', () => setRevisionSetting('showAllChanges', false)),
        vscode.commands.registerCommand('diffTracker.showAllChanges', () => setRevisionSetting('showAllChanges', true)),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor === vscode.window.activeTextEditor) { navigation.refresh(); }
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
