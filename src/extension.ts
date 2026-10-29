import * as vscode from 'vscode';
import { DecorationManager } from './decorationManager';
import { DiffTreeDataProvider } from './diffTreeView';
import { GitInlineRevision, GitRevision } from './gitRevision';
import { ChangePositionTracker, navigateAndShowChange } from './changeNavigation';
import { GitRevisionHoverProvider } from './revisionHover';
import { revisionEditor, setRevisionSetting } from './revisionSettings';

export function activate(context: vscode.ExtensionContext): void {
    const decorations = new DecorationManager();
    const positions = new ChangePositionTracker();
    const getPosition = () => {
        const editor = revisionEditor();
        return positions.getPosition(editor, editor ? revisions.getNavigationChanges(editor.document) : undefined);
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
    for (const [action, scope] of [['accept', 'AllRevisions'], ['reject', 'AllRevisions'], ['accept', 'Selection'], ['reject', 'Selection']] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`diffTracker.${action}${scope}`, async () => {
            const editor = revisionEditor();
            const ref = editor && revisions.getAllRevisions(editor.document);
            if (!ref) { void vscode.window.showInformationMessage('当前文件没有可处理的修订。'); return; }
            if (ref.staged && action === 'accept') { void vscode.window.showInformationMessage('修订已暂存，无法再次接受。'); return; }
            const selected = scope === 'Selection';
            if (selected && editor.selections.every(selection => selection.isEmpty)) { void vscode.window.showInformationMessage('请先选中要处理的行。'); return; }
            if (!selected || ref.staged && action === 'reject') {
                const title = action === 'accept' ? '接受' : '拒绝';
                const detail = action === 'accept' ? '将当前编辑器内容暂存到 Git，不会保存文件。' : ref.staged
                    ? '将同时丢弃暂存区和磁盘中的修订，此操作无法撤销。'
                    : '将恢复到暂存区内容；修改仅作用于编辑器，需保存文件。';
                const confirmed = await vscode.window.showWarningMessage(`${title}${selected ? '选区内' : '当前文件'}的所有修订？`, { modal: true, detail: `${ref.file}\n${detail}` }, title);
                if (confirmed !== title) { return; }
            }
            try {
                await revisions.applyAllRevisions(ref, action, selected ? editor.selections : undefined);
            } catch (error) {
                void vscode.window.showWarningMessage(`无法处理修订：${error instanceof Error ? error.message : String(error)}`);
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
