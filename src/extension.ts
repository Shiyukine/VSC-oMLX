import * as vscode from 'vscode';
import { OmlxLanguageModelChatProvider } from './provider';
import { Logger } from './logger';

export function activate(context: vscode.ExtensionContext) {
    Logger.log('oMLX extension is now active!');

    const provider = new OmlxLanguageModelChatProvider();

    // Register the language model chat provider
    const providerDisposable = vscode.lm.registerLanguageModelChatProvider('omlx', provider);
    context.subscriptions.push(providerDisposable);

    // Initial trigger to ensure models are fetched correctly at startup
    setTimeout(() => {
        provider.triggerChange();
    }, 100);

    // Watch for configuration changes to update models
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (
            e.affectsConfiguration('omlx.models') ||
            e.affectsConfiguration('omlx.endpoint') ||
            e.affectsConfiguration('omlx.configPath')
        ) {
            provider.triggerChange();
        }
    }));
}

export function deactivate() { }
