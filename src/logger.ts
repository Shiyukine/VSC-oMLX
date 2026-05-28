import * as vscode from 'vscode';

//Create output channel
let logger = vscode.window.createOutputChannel("VSC-oMLX");

export function log(message: string) {
    const timestamp = new Date().toISOString();
    logger.appendLine(`[${timestamp}] ${message}`);
}

export function warn(message: string) {
    const timestamp = new Date().toISOString();
    logger.appendLine(`[${timestamp}] WARNING: ${message}`);
}

export function error(message: string) {
    const timestamp = new Date().toISOString();
    logger.appendLine(`[${timestamp}] ERROR: ${message}`);
}

export const Logger = {
    log,
    warn,
    error,
    l: (message: string) => log(message),
    w: (message: string) => warn(message),
    e: (message: string) => error(message)
};