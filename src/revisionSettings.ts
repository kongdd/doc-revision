import * as vscode from 'vscode';

export function revisionEditor(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === 'file');
}

export function currentFolder(): vscode.WorkspaceFolder | undefined {
    const editor = revisionEditor();
    if (editor) { return vscode.workspace.getWorkspaceFolder(editor.document.uri); }
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 ? folders[0] : undefined;
}

export function revisionConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('DocRevision', currentFolder()?.uri);
}

export async function setRevisionSetting(key: 'showRevisions' | 'showAllChanges' | 'highlightModifiedLines', value?: boolean): Promise<boolean> {
    const folder = currentFolder();
    if (!folder) {
        void vscode.window.showWarningMessage('请先打开当前文件所在的工作区文件夹。');
        return false;
    }
    const config = vscode.workspace.getConfiguration('DocRevision', folder.uri);
    await config.update(key, value ?? !config.get<boolean>(key, false), vscode.ConfigurationTarget.WorkspaceFolder);
    return true;
}
