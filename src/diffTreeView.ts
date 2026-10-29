import * as vscode from 'vscode';
import { revisionConfig } from './revisionSettings';

export class DiffTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly isEnabled: () => boolean, private readonly getPosition: () => { index: number; total: number },
        private readonly navigation = false) {}

    refresh(): void { this.changed.fire(); }
    getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

    getChildren(): vscode.TreeItem[] {
        if (this.navigation) {
            const { index, total } = this.getPosition();
            const position = new vscode.TreeItem(`修订 ${index || (total ? '—' : 0)} / ${total}`, vscode.TreeItemCollapsibleState.None);
            position.iconPath = new vscode.ThemeIcon('list-ordered');
            return [position, this.item('上一处', '', 'arrow-up', 'diffTracker.previousChange'),
                this.item('下一处', '', 'arrow-down', 'diffTracker.nextChange'),
                this.item('全部接受', '', 'check-all', 'diffTracker.acceptAllRevisions'),
                this.item('全部拒绝', '', 'discard', 'diffTracker.rejectAllRevisions')];
        }
        const enabled = this.isEnabled();
        const highlight = revisionConfig().get<boolean>('highlightModifiedLines', false);
        const showAll = revisionConfig().get<boolean>('showAllChanges', false);
        return [
            this.item('显示修订', enabled ? '已开启' : '已关闭', enabled ? 'eye' : 'eye-closed', 'diffTracker.toggleGitRevisions'),
            this.item('行背景色', highlight ? '已开启' : '已关闭', highlight ? 'eye' : 'eye-closed', 'diffTracker.toggleHighlight'),
            this.item('Show Unstaged', '', showAll ? 'circle-large-outline' : 'check', 'diffTracker.showUnstaged'),
            this.item('Show All Changes', '', showAll ? 'check' : 'circle-large-outline', 'diffTracker.showAllChanges')
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
