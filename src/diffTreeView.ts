import * as vscode from 'vscode';

export class DiffTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly isEnabled: () => boolean) {}

    refresh(): void { this.changed.fire(); }
    getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

    getChildren(): vscode.TreeItem[] {
        const enabled = this.isEnabled();
        const highlight = vscode.workspace.getConfiguration('diffTracker').get<boolean>('highlightModifiedLines', false);
        return [
            this.item('显示修订', enabled ? '已开启' : '已关闭', enabled ? 'eye' : 'eye-closed', 'diffTracker.toggleGitRevisions'),
            this.item('上一处', '', 'arrow-up', 'diffTracker.previousChange'),
            this.item('下一处', '', 'arrow-down', 'diffTracker.nextChange'),
            this.item('修改行背景色', highlight ? '已开启' : '已关闭', highlight ? 'check' : 'circle-large-outline', 'diffTracker.toggleHighlight')
        ];
    }

    private item(label: string, description: string, icon: string, command: string): vscode.TreeItem {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = description;
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = { command, title: label };
        return item;
    }

    dispose(): void { this.changed.dispose(); }
}
