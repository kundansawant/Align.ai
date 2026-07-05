import * as vscode from 'vscode';
import * as path from 'path';

const BACKEND_URL = 'http://127.0.0.1:8000';

// Global variable to hold the active webview panel reference
let activeProvider: AlignAiSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Align.ai is now active!');

    // Initialize & Register Sidebar Webview Provider
    const provider = new AlignAiSidebarProvider(context.extensionUri);
    activeProvider = provider;
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'align-ai.sidebar',
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('align-ai.syncCurrentFile', async () => {
            await syncCurrentFileToMemory();
        }),
        vscode.commands.registerCommand('align-ai.syncWorkspace', async () => {
            await syncEntireWorkspace();
        }),
        vscode.commands.registerCommand('align-ai.recallGuardrails', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Enter component or style keyword to query design memory',
                placeHolder: 'e.g., PrimaryButton spacing'
            });
            if (query) {
                await recallDesignGuardrails(query);
            }
        }),
        vscode.commands.registerCommand('align-ai.pruneNodes', async () => {
            const confirmation = await vscode.window.showWarningMessage(
                'Are you sure you want to prune/forget the current Cognee memory dataset?',
                'Yes, Prune',
                'Cancel'
            );
            if (confirmation === 'Yes, Prune') {
                await pruneDatasetMemory();
            }
        })
    );

    // Watch File Saves to Trigger Auto-remember Ingestion
    vscode.workspace.onDidSaveTextDocument(async (document) => {
        const filePath = document.fileName;
        const fileExt = path.extname(filePath).toLowerCase();
        
        // Target only frontend files
        const supportedExtensions = ['.tsx', '.jsx', '.css', '.ts', '.js', '.json'];
        if (supportedExtensions.includes(fileExt)) {
            vscode.window.setStatusBarMessage(`Align.ai: Syncing ${path.basename(filePath)} to Cognee Graph...`, 3000);
            await syncFileToMemory(document.getText(), filePath);
        }
    });

    // Watch Active File Changes to Update Sidebar Context
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            const document = editor.document;
            const fileName = path.basename(document.fileName);
            if (provider && provider.view) {
                provider.updateActiveFile(fileName, document.fileName);
            }
        }
    });

    // Auto-recall on startup to push rules forcefully into .cursorrules
    setTimeout(async () => {
        try {
            console.log('Align.ai: Running startup auto-recall...');
            const response = await fetch(`${BACKEND_URL}/recall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query_prompt: 'general codebase layout and architectural rules',
                    dataset_name: 'main_dataset'
                })
            });
            if (response.ok) {
                const data = await response.json();
                await updateCursorRules(data.prompt_payload);
            }
        } catch (err) {
            console.error('Align.ai startup auto-recall failed:', err);
        }
    }, 2000);
}

export function deactivate() {}

// Core Backend Call Wrappers
async function syncFileToMemory(content: string, filePath: string) {
    const fileName = path.basename(filePath);
    if (activeProvider && activeProvider.view) {
        activeProvider.sendStateUpdate('Syncing...', 'syncing');
    }

    try {
        const response = await fetch(`${BACKEND_URL}/remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text_or_file_content: content,
                file_path: filePath,
                dataset_name: 'main_dataset'
            })
        });

        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }

        const data = await response.json();
        
        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Synced with Cognee Graph', 'synced');
            activeProvider.postMessage({
                command: 'syncResult',
                message: `Successfully stored ${fileName} in Cognee.`
            });
        }
        vscode.window.showInformationMessage(`Align.ai: Saved context for ${fileName} to Cognee.`);
    } catch (err: any) {
        console.error('Align.ai error during remember:', err);
        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Sync Failed', 'failed');
            activeProvider.postMessage({
                command: 'syncResult',
                error: `Failed to sync file: ${err.message}`
            });
        }
        vscode.window.showErrorMessage(`Align.ai: Failed to sync ${fileName} to Cognee. Ensure backend is running.`);
    }
}

async function syncCurrentFileToMemory() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Align.ai: No active editor tab found.');
        return;
    }
    const document = editor.document;
    await syncFileToMemory(document.getText(), document.fileName);
}

async function recallDesignGuardrails(query: string) {
    if (activeProvider && activeProvider.view) {
        activeProvider.sendStateUpdate('Recalling...', 'recalling');
    }

    try {
        const response = await fetch(`${BACKEND_URL}/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query_prompt: query,
                dataset_name: 'main_dataset'
            })
        });

        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }

        const data = await response.json();
        
        // Dynamically update workspace .cursorrules
        await updateCursorRules(data.prompt_payload);

        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Synced with Cognee Graph', 'synced');
            activeProvider.postMessage({
                command: 'recallResult',
                payload: data.prompt_payload,
                recalledTexts: data.recalled_texts,
                query: query
            });
        }
    } catch (err: any) {
        console.error('Align.ai error during recall:', err);
        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Recall Failed', 'failed');
            activeProvider.postMessage({
                command: 'recallResult',
                error: `Failed to recall design context: ${err.message}`
            });
        }
        vscode.window.showErrorMessage('Align.ai: Failed to recall memory. Ensure backend is running.');
    }
}

async function updateCursorRules(payload: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;
    const cursorRulesPath = path.join(rootPath, '.cursorrules');
    const cursorRulesUri = vscode.Uri.file(cursorRulesPath);
    
    let currentContent = '';
    try {
        const fileBytes = await vscode.workspace.fs.readFile(cursorRulesUri);
        currentContent = Buffer.from(fileBytes).toString('utf8');
    } catch (err) {
        // File doesn't exist yet, which is fine
    }

    const startMarker = '### ALIGN.AI DESIGN GUARDRAILS (AUTO-GENERATED) ###';
    const endMarker = '### END ALIGN.AI DESIGN GUARDRAILS ###';

    // Directive explicitly informing any AI Coding Agent about Align.ai context
    const directive = `\n# ==========================================\n# ALIGN.AI SYSTEM INSTRUCTIONS\n# You are an AI pair-programmer working on this codebase.\n# This project is guarded by Align.ai using Cognee Memory Graph.\n# You MUST strictly adhere to the following design system rules,\n# formatting styles, and naming conventions.\n# ==========================================\n\n`;

    const newSection = `${startMarker}${directive}${payload}\n${endMarker}`;

    let newContent = '';
    if (currentContent.includes(startMarker) && currentContent.includes(endMarker)) {
        const startIndex = currentContent.indexOf(startMarker);
        const endIndex = currentContent.indexOf(endMarker) + endMarker.length;
        newContent = currentContent.slice(0, startIndex) + newSection + currentContent.slice(endIndex);
    } else {
        newContent = currentContent ? `${currentContent.trim()}\n\n${newSection}\n` : `${newSection}\n`;
    }

    try {
        await vscode.workspace.fs.writeFile(cursorRulesUri, Buffer.from(newContent, 'utf8'));
        vscode.window.showInformationMessage('Align.ai: Updated workspace .cursorrules file.');
    } catch (err: any) {
        console.error('Align.ai failed to write .cursorrules:', err);
    }
}

async function syncEntireWorkspace() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('Align.ai: No open workspace folder found to sync.');
        return;
    }

    if (activeProvider && activeProvider.view) {
        activeProvider.sendStateUpdate('Syncing Workspace...', 'syncing');
    }

    // Scan for all code/style/config files in the workspace (excluding node_modules, git, out, dist, venv, pycache)
    const files = await vscode.workspace.findFiles(
        '**/*.{tsx,jsx,css,ts,js,json,py}',
        '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/venv/**,**/__pycache__/**}'
    );

    if (files.length === 0) {
        vscode.window.showInformationMessage('Align.ai: No supported files found in the workspace.');
        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Synced with Cognee Graph', 'synced');
        }
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Align.ai: Syncing Entire Workspace to Cognee Cloud",
        cancellable: true
    }, async (progress, token) => {
        let currentCount = 0;
        const totalCount = files.length;
        
        for (const fileUri of files) {
            if (token.isCancellationRequested) {
                vscode.window.showWarningMessage('Align.ai: Workspace sync cancelled.');
                break;
            }
            
            try {
                const fileName = path.basename(fileUri.fsPath);
                progress.report({
                    increment: (1 / totalCount) * 100,
                    message: `Syncing ${fileName} (${currentCount + 1}/${totalCount})`
                });

                const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                const fileContent = Buffer.from(fileBytes).toString('utf8');

                // Call backend remember API
                await fetch(`${BACKEND_URL}/remember`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text_or_file_content: fileContent,
                        file_path: fileUri.fsPath,
                        dataset_name: 'main_dataset'
                    })
                });
            } catch (err) {
                console.error(`Align.ai: Error syncing file ${fileUri.fsPath}:`, err);
            }
            
            currentCount++;
        }

        // Finalize by recalling guardrails and updating .cursorrules automatically
        progress.report({ message: 'Finalizing context and updating .cursorrules...' });
        try {
            const response = await fetch(`${BACKEND_URL}/recall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query_prompt: 'general design, layout, spacing rules and code conventions',
                    dataset_name: 'main_dataset'
                })
            });
            if (response.ok) {
                const data = await response.json();
                await updateCursorRules(data.prompt_payload);
            }
        } catch (err) {
            console.error('Align.ai: Final recall failed:', err);
        }

        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Synced with Cognee Graph', 'synced');
            activeProvider.postMessage({
                command: 'syncResult',
                message: `Successfully synced entire workspace (${currentCount} files) and updated .cursorrules.`
            });
        }
        vscode.window.showInformationMessage(`Align.ai: Successfully synced entire workspace (${currentCount} files).`);
    });
}

async function pruneDatasetMemory() {
    if (activeProvider && activeProvider.view) {
        activeProvider.sendStateUpdate('Pruning...', 'pruning');
    }

    try {
        const response = await fetch(`${BACKEND_URL}/forget`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dataset_name: 'main_dataset'
            })
        });

        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }

        const data = await response.json();
        
        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Memory Cleared', 'pruned');
            activeProvider.postMessage({
                command: 'pruneResult',
                message: 'All dataset styling rule nodes have been pruned from Cognee.'
            });
        }
        vscode.window.showInformationMessage('Align.ai: All Cognee memory nodes have been successfully pruned.');
    } catch (err: any) {
        console.error('Align.ai error during forget:', err);
        if (activeProvider && activeProvider.view) {
            activeProvider.sendStateUpdate('Pruning Failed', 'failed');
        }
        vscode.window.showErrorMessage('Align.ai: Failed to clear Cognee memory dataset.');
    }
}

// Webview View Provider Implementation
class AlignAiSidebarProvider implements vscode.WebviewViewProvider {
    public view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen for messages from Webview frontend
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'syncActive':
                    await syncCurrentFileToMemory();
                    break;
                case 'recall':
                    const finalQuery = data.type ? `[Type: ${data.type}] ${data.query || 'general constraints'}` : (data.query || 'general constraints');
                    await recallDesignGuardrails(finalQuery);
                    break;
                case 'forget':
                    await pruneDatasetMemory();
                    break;
                case 'checkStatus':
                    await this.checkBackendStatus();
                    break;
                case 'syncWorkspace':
                    await syncEntireWorkspace();
                    break;
            }
        });

        // Initialize display with active file name if one is open
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            this.updateActiveFile(path.basename(activeEditor.document.fileName), activeEditor.document.fileName);
        }

        // Check backend connection status right away
        this.checkBackendStatus();
    }

    public updateActiveFile(fileName: string, filePath: string) {
        let fileType = 'Unknown File Type';
        const fileExt = path.extname(filePath).toLowerCase();
        const lowerPath = filePath.toLowerCase();
        
        if (lowerPath.includes('backend') || lowerPath.includes('server') || lowerPath.includes('controller') || lowerPath.includes('service') || lowerPath.includes('router') || lowerPath.includes('api')) {
            if (fileExt === '.py') {
                if (lowerPath.includes('router')) {
                    fileType = 'Backend API Router (Python)';
                } else if (lowerPath.includes('controller')) {
                    fileType = 'Backend Controller (Python)';
                } else if (lowerPath.includes('service') || lowerPath.includes('engine')) {
                    fileType = 'Backend Service / Engine (Python)';
                } else {
                    fileType = 'Backend Logic (Python)';
                }
            } else if (['.ts', '.js'].includes(fileExt)) {
                if (lowerPath.includes('router')) {
                    fileType = 'Backend API Router (Node.js)';
                } else if (lowerPath.includes('controller')) {
                    fileType = 'Backend Controller (Node.js)';
                } else {
                    fileType = 'Backend Logic (Node.js)';
                }
            }
        }
        
        if (fileType === 'Unknown File Type') {
            if (['.tsx', '.jsx'].includes(fileExt)) {
                fileType = 'Frontend Component (React)';
            } else if (fileExt === '.css') {
                fileType = 'UI Stylesheet (CSS)';
            } else if (fileExt === '.html') {
                fileType = 'HTML View / Template';
            } else if (['.ts', '.js'].includes(fileExt)) {
                fileType = 'Logic Script / Module';
            } else if (['.json', '.env', '.yaml', '.yml'].includes(fileExt)) {
                fileType = 'Configuration Schema';
            } else {
                fileType = 'General Document';
            }
        }

        this.postMessage({
            command: 'activeFileUpdate',
            fileName: fileName,
            fileType: fileType
        });
    }

    public sendStateUpdate(text: string, stateClass: string) {
        this.postMessage({
            command: 'statusUpdate',
            text: text,
            stateClass: stateClass
        });
    }

    public postMessage(message: any) {
        if (this.view) {
            this.view.webview.postMessage(message);
        }
    }

    private async checkBackendStatus() {
        try {
            const response = await fetch(`${BACKEND_URL}/status`);
            if (response.ok) {
                const data = await response.json();
                const modeStr = data.cognee_mode || 'Local';
                const available = data.cognee_available ? 'Connected' : 'Mock Mode';
                
                this.postMessage({
                    command: 'backendStatus',
                    status: 'online',
                    mode: modeStr,
                    available: available
                });
                
                this.sendStateUpdate(`Synced (${modeStr} Memory)`, 'synced');
            } else {
                throw new Error();
            }
        } catch {
            this.postMessage({
                command: 'backendStatus',
                status: 'offline'
            });
            this.sendStateUpdate('Backend Offline', 'failed');
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Load the HTML file from workspace Webview dir
        const htmlPath = vscode.Uri.file(
            path.join(this._extensionUri.fsPath, 'src', 'webview', 'sidebar.html')
        );
        
        // Since we are reading the file directly and returning, we can use fs or standard read.
        // Wait, to keep code simple and self-contained, we can load the html template directly or read it.
        // Let's read it using Node's fs module so it's fully externalized in `src/webview/sidebar.html`.
        try {
            const fs = require('fs');
            let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
            return htmlContent;
        } catch (err) {
            console.error('Error loading sidebar.html:', err);
            return `<html><body><h3>Error loading panel UI</h3><p>${err}</p></body></html>`;
        }
    }
}
