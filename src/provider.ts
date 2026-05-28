import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TextEncoder } from 'util';
import { createByModelName, TikTokenizer } from '@microsoft/tiktokenizer';
import { Logger } from './logger';

export class OmlxLanguageModelChatProvider implements vscode.LanguageModelChatProvider {
    private _onDidChangeEvent = new vscode.EventEmitter<void>();
    public readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this._onDidChangeEvent.event;

    private _tokenizer: TikTokenizer | undefined;
    private _tokenizerPromise: Promise<TikTokenizer> | undefined;

    private async getTokenizer(): Promise<TikTokenizer> {
        if (!this._tokenizer) {
            // Use gpt-4o which maps to o200k_base encoding
            // The tokenizer will download automatically on first use
            this._tokenizerPromise = createByModelName('gpt-4o');
            this._tokenizer = await this._tokenizerPromise;
        }
        return this._tokenizer;
    }

    private async countTokens(text: string): Promise<number> {
        const tokenizer = await this.getTokenizer();
        return tokenizer.encode(text).length;
    }

    public triggerChange() {
        this._onDidChangeEvent.fire();
    }

    async prepareLanguageModelChatInformation(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
        return this.provideLanguageModelChatInformation(options, token);
    }

    private getEndpoint() {
        const config = vscode.workspace.getConfiguration('omlx');
        return config.get<string>('endpoint') || 'http://127.0.0.1:8000/v1';
    }

    private getApiKey() {
        const config = vscode.workspace.getConfiguration('omlx');
        return config.get<string>('apiKey') || '';
    }

    private doRequest(url: string, options: http.RequestOptions | https.RequestOptions, body?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.request(url, options, (res) => {
                let chunk = '';
                res.on('data', (d) => { chunk += d; });
                res.on('end', () => resolve(chunk));
            });
            req.on('error', reject);
            if (body) {
                req.write(body);
            }
            req.end();
        });
    }


    private async getModelCapabilities(modelId: string, endpoint: string): Promise<{ maxInputTokens: number, imageInput: boolean, toolCalling: boolean }> {
        const defaultCapabilities = { maxInputTokens: 32000, imageInput: false, toolCalling: false };

        try {
            const config = vscode.workspace.getConfiguration('omlx');
            let configPath = config.get<string>('configPath') || '~/.omlx/settings.json';
            if (configPath.startsWith('~')) {
                configPath = path.join(os.homedir(), configPath.slice(1));
            }

            let modelDir = path.join(os.homedir(), '.omlx', 'models');
            if (fs.existsSync(configPath)) {
                const settingsData = fs.readFileSync(configPath, 'utf8');
                const settings = JSON.parse(settingsData);
                if (settings?.model?.model_dirs && settings.model.model_dirs.length > 0) {
                    modelDir = settings.model.model_dirs[0];
                } else if (settings?.model?.model_dir) {
                    modelDir = settings.model.model_dir;
                }
            }

            let modelConfigPath = path.join(modelDir, modelId, 'config.json');
            if (!fs.existsSync(modelConfigPath)) {
                // search in all model dirs if config not found in default location
                if (fs.existsSync(modelDir)) {
                    const subdirs = fs.readdirSync(modelDir).filter(subdir => fs.statSync(path.join(modelDir, subdir)).isDirectory());
                    for (const subdir of subdirs) {
                        const potentialPath = path.join(modelDir, subdir, modelId, 'config.json');
                        if (fs.existsSync(potentialPath)) {
                            modelConfigPath = potentialPath;
                            break;
                        }
                    }
                }
            }
            if (!fs.existsSync(modelConfigPath)) {
                return { maxInputTokens: 32000, imageInput: true, toolCalling: true }; // fallback
            }

            const modelConfigData = fs.readFileSync(modelConfigPath, 'utf8');
            const modelConfig = JSON.parse(modelConfigData);

            // TODO: Check oMLX model config in the config file

            let maxInputTokens = defaultCapabilities.maxInputTokens;
            if (modelConfig.max_position_embeddings) {
                maxInputTokens = modelConfig.max_position_embeddings;
            } else if (modelConfig.max_seq_len) {
                maxInputTokens = modelConfig.max_seq_len;
            } else if (modelConfig.max_window_layers) {
                maxInputTokens = modelConfig.max_window_layers;
            }

            if (modelConfig.text_config?.max_position_embeddings) {
                maxInputTokens = modelConfig.text_config.max_position_embeddings;
            } else if (modelConfig.text_config?.max_seq_len) {
                maxInputTokens = modelConfig.text_config.max_seq_len;
            } else if (modelConfig.text_config?.max_window_layers) {
                maxInputTokens = modelConfig.text_config.max_window_layers;
            }

            let imageInput = false;
            if (modelConfig.vision_config || modelConfig.vision_tower || modelConfig.model_type?.includes('llava') || modelConfig.model_type?.includes('qwen2_vl')) {
                imageInput = true;
            }

            let toolCalling = false;
            const tokenizerConfigPath = path.join(modelDir, modelId, 'tokenizer_config.json');
            const chatTemplatePath = path.join(modelDir, modelId, 'chat_template.jinja');

            if (fs.existsSync(chatTemplatePath)) {
                const chatTemplate = fs.readFileSync(chatTemplatePath, 'utf8');
                if (chatTemplate.includes('tools') || chatTemplate.includes('<tool_call>')) {
                    toolCalling = true;
                }
            } else if (fs.existsSync(tokenizerConfigPath)) {
                const tokenizerConfigData = fs.readFileSync(tokenizerConfigPath, 'utf8');
                if (tokenizerConfigData.includes('tools') || tokenizerConfigData.includes('<tool_call>')) {
                    toolCalling = true;
                }
            } else {
                toolCalling = true; // fallback if can't firmly decide
            }

            return { maxInputTokens, imageInput, toolCalling };
        } catch (err) {
            Logger.error(`Error fetching model capabilities for ${modelId}: ${err}`);
            return { maxInputTokens: 32000, imageInput: true, toolCalling: true };
        }
    }

    async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
        const endpoint = this.getEndpoint();
        const apiKey = this.getApiKey();

        // First check static configuration
        const config = vscode.workspace.getConfiguration('omlx');
        const configuredModels = config.get<string[]>('models') || [];
        Logger.log(`Providing language models. configuredModels: ${JSON.stringify(configuredModels)}`);

        try {
            if (configuredModels.length > 0) {
                return Promise.all(configuredModels.map(async (modelId) => {
                    const caps = await this.getModelCapabilities(modelId, endpoint);
                    return {
                        id: modelId,
                        name: modelId,
                        family: 'omlx',
                        version: '1.0',
                        maxInputTokens: caps.maxInputTokens,
                        maxOutputTokens: 4096,
                        capabilities: {
                            imageInput: caps.imageInput,
                            toolCalling: caps.toolCalling
                        }
                    };
                }));
            }

            // Fallback to fetch from server
            const urlInfo = new URL(`${endpoint}/models`);
            const resData = await this.doRequest(urlInfo.toString(), {
                method: 'GET',
                headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
            });

            const data = JSON.parse(resData);
            const models = data.data || [];

            const modelInfos = await Promise.all(models.map(async (model: any) => {
                const caps = await this.getModelCapabilities(model.id, endpoint);
                return {
                    id: model.id,
                    name: model.id,
                    family: 'omlx',
                    version: '1.0',
                    maxInputTokens: caps.maxInputTokens,
                    maxOutputTokens: 4096,
                    capabilities: {
                        imageInput: caps.imageInput,
                        toolCalling: caps.toolCalling
                    }
                };
            }));
            return modelInfos;
        } catch (err) {
            Logger.error(`Failed to fetch oMLX models: ${err}`);
            // Return a fallback model if server is unreachable when info is requested
            return [
                {
                    id: 'omlx-default',
                    name: 'Fallback Model (oMLX offline?)',
                    family: 'omlx',
                    version: '1.0',
                    maxInputTokens: 32000,
                    maxOutputTokens: 4096,
                    capabilities: { imageInput: true, toolCalling: true }
                }
            ];
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const endpoint = this.getEndpoint();
        const apiKey = this.getApiKey();

        // --- Context management: proper tokenizer-based token counting ---
        // Copilot uses @microsoft/tiktokenizer with o200k_base to count tokens accurately.
        // We apply the same approach to prevent unbounded context growth after tool calls.
        const MAX_CONTEXT_TOKENS = model.maxInputTokens || 32000;
        const MAX_OUTPUT_TOKENS = model.maxOutputTokens || 4096;
        const TOOL_RESULT_CHAR_LIMIT = 4096; // Cap tool results to prevent bloat

        const tokenizer = await this.getTokenizer();

        function countTokensForPart(part: any): number {
            if (part instanceof vscode.LanguageModelTextPart) {
                return tokenizer.encode(part.value).length;
            }
            if (part instanceof vscode.LanguageModelToolCallPart) {
                const inputStr = typeof part.input === 'string' ? part.input : JSON.stringify(part.input);
                return tokenizer.encode(part.name).length + tokenizer.encode(inputStr).length;
            }
            if (part instanceof vscode.LanguageModelToolResultPart) {
                let resultStr = '';
                for (const pc of part.content) {
                    if (pc instanceof vscode.LanguageModelTextPart) {
                        resultStr += pc.value;
                    } else if (typeof pc === 'string') {
                        resultStr += pc;
                    } else {
                        resultStr += JSON.stringify(pc);
                    }
                }
                // Cap tool result to prevent unbounded context growth
                if (resultStr.length > TOOL_RESULT_CHAR_LIMIT) {
                    resultStr = resultStr.substring(0, TOOL_RESULT_CHAR_LIMIT) + `\n\n[truncated, was ${resultStr.length} chars]`;
                }
                return tokenizer.encode(resultStr).length;
            }
            // Images, thinking parts, data parts — rough estimate
            return 1000;
        }

        function countTokensForMessage(msg: vscode.LanguageModelChatRequestMessage): number {
            // Base tokens per message (Copilot convention: 3 tokens per message for special chars)
            let total = 3;
            if (typeof msg.content === 'string') {
                total += tokenizer.encode(msg.content).length;
            } else {
                for (const c of msg.content) {
                    total += countTokensForPart(c);
                }
            }
            return total;
        }

        // Calculate total tokens and truncate old messages if over limit
        let totalTokens = 0;
        let effectiveMessages = messages;

        for (const m of messages) {
            totalTokens += countTokensForMessage(m);
        }

        // If over limit, drop oldest messages from the front (keep last N)
        if (totalTokens > MAX_CONTEXT_TOKENS && messages.length > 2) {
            Logger.log(`Context ${totalTokens} tokens exceeds limit ${MAX_CONTEXT_TOKENS}, truncating...`);
            let accumulated = 0;
            let keepFrom = messages.length - 1; // always keep the last message (current turn)

            // Walk backwards, keeping messages until we're under 85% of the limit
            for (let i = messages.length - 2; i >= 0; i--) {
                accumulated += countTokensForMessage(messages[i]);
                if (accumulated + countTokensForMessage(messages[messages.length - 1]) < MAX_CONTEXT_TOKENS * 0.85) {
                    keepFrom = i;
                } else {
                    break;
                }
            }
            effectiveMessages = messages.slice(keepFrom);
            Logger.log(`Kept ${effectiveMessages.length} of ${messages.length} messages`);
        }

        let emittedText = '';

        const oaiMessages: any[] = [];

        for (const m of effectiveMessages) {
            let role = m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';

            if (typeof m.content === 'string') {
                oaiMessages.push({ role, content: m.content });
                continue;
            }

            let contentParts: any[] = [];
            let tool_calls: any[] = [];
            let toolResultParts: vscode.LanguageModelToolResultPart[] = [];
            let reasoningParts: string[] = [];
            let hasComplexContent = false;

            for (const c of m.content) {
                if (c instanceof vscode.LanguageModelTextPart) {
                    contentParts.push({ type: 'text', text: c.value });
                } else if (c && typeof c === 'object' && 'mimeType' in c && 'data' in c) {
                    const dataPart = c as unknown as any;
                    if (dataPart.mimeType.startsWith('image/')) {
                        const base64 = Buffer.from(dataPart.data).toString('base64');
                        contentParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${dataPart.mimeType};base64,${base64}` }
                        });
                        hasComplexContent = true;
                    }
                } else if (c instanceof vscode.LanguageModelToolCallPart) {
                    tool_calls.push({
                        id: c.callId,
                        type: 'function',
                        function: {
                            name: c.name,
                            arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input)
                        }
                    });
                } else if (c instanceof vscode.LanguageModelToolResultPart) {
                    toolResultParts.push(c);
                } else if (c && c.constructor.name === 'LanguageModelThinkingPart') {
                    const val = (c as any).value;
                    const text = Array.isArray(val) ? val.join('') : val;
                    if (text) reasoningParts.push(text);
                }
            }

            let content: string | any[] | null = null;
            const joinedThinking = reasoningParts.join('').trim();
            if (joinedThinking) {
                contentParts.unshift({ type: 'text', text: `<think>\n${joinedThinking}\n</think>\n` });
            }

            if (hasComplexContent) {
                content = contentParts;
            } else if (contentParts.length > 0) {
                content = contentParts.map(p => p.text).join('');
            }

            if (role === 'assistant') {
                const msg: any = { role, content };
                if (tool_calls.length > 0) {
                    msg.tool_calls = tool_calls;
                }
                if (content !== null || tool_calls.length > 0) {
                    oaiMessages.push(msg);
                }
            } else {
                if (toolResultParts.length > 0) {
                    for (const tr of toolResultParts) {
                        let resultStr = '';
                        for (const pc of tr.content) {
                            if (pc instanceof vscode.LanguageModelTextPart) {
                                resultStr += pc.value;
                            } else if (typeof pc === 'string') {
                                resultStr += pc;
                            } else {
                                resultStr += JSON.stringify(pc);
                            }
                        }
                        oaiMessages.push({
                            role: 'tool',
                            tool_call_id: tr.callId,
                            content: resultStr
                        });
                    }
                    if (content !== null) {
                        oaiMessages.push({ role: 'user', content });
                    }
                } else {
                    oaiMessages.push({ role: 'user', content: content || '' });
                }
            }
        }

        const bodyObj: any = {
            model: model.id === 'omlx-default' ? 'default' : model.id,
            messages: oaiMessages,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: MAX_OUTPUT_TOKENS
        };

        Logger.log('Sending oaiMessages: ' + JSON.stringify(oaiMessages, null, 2));

        if (options.tools && options.tools.length > 0) {
            bodyObj.tools = options.tools.map((t: vscode.LanguageModelChatTool) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema
                }
            }));
        }

        const body = JSON.stringify(bodyObj);

        const urlInfo = new URL(`${endpoint}/chat/completions`);
        const client = urlInfo.protocol === 'https:' ? https : http;

        return new Promise((resolve, reject) => {
            const headers: any = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const req = client.request(urlInfo, {
                method: 'POST',
                headers
            }, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Server responded with status ${res.statusCode}`));
                    return;
                }

                const toolCallsMap = new Map<number, { id: string, name: string, arguments: string }>();
                let hasStartedThinking = false;
                let isCurrentlyThinking = false;

                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    if (token.isCancellationRequested) {
                        req.destroy();
                        resolve();
                        return;
                    }

                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ') && trimmedLine !== 'data: [DONE]') {
                            try {
                                const data = JSON.parse(trimmedLine.substring(6));


                                if (data.usage) {
                                    try {
                                        const usageBytes = new TextEncoder().encode(JSON.stringify(data.usage));
                                        progress.report(new vscode.LanguageModelDataPart(usageBytes, 'usage'));
                                    } catch (e) { }
                                }

                                if (data.choices && data.choices[0]) {
                                    const choice = data.choices[0];
                                    const delta = choice.delta || choice.message;

                                    if (!delta) continue;

                                    // Handle reasoning/thinking process
                                    const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking || delta.thought;
                                    if (reasoning) {
                                        const anyVsCode = vscode as any;
                                        if (anyVsCode.LanguageModelThinkingPart) {
                                            progress.report(new anyVsCode.LanguageModelThinkingPart(reasoning));
                                        } else {
                                            if (!hasStartedThinking) {
                                                hasStartedThinking = true;
                                                isCurrentlyThinking = true;
                                                progress.report(new vscode.LanguageModelTextPart('<think>\n'));
                                            }
                                            progress.report(new vscode.LanguageModelTextPart(reasoning));
                                        }
                                    }

                                    if (delta.content) {
                                        if (isCurrentlyThinking) {
                                            isCurrentlyThinking = false;
                                            progress.report(new vscode.LanguageModelTextPart('\n</think>\n'));
                                        }
                                        const text = String(delta.content);
                                        let textToEmit = text;
                                        if (emittedText && text.startsWith(emittedText)) {
                                            textToEmit = text.slice(emittedText.length);
                                        }
                                        if (textToEmit) {
                                            emittedText += textToEmit;
                                            progress.report(new vscode.LanguageModelTextPart(textToEmit));
                                        }
                                    }
                                    if (delta.tool_calls) {
                                        if (isCurrentlyThinking) {
                                            isCurrentlyThinking = false;
                                            progress.report(new vscode.LanguageModelTextPart('\n</think>\n'));
                                        }
                                        for (const tc of delta.tool_calls) {
                                            const tcIndex = tc.index !== undefined ? tc.index : 0;
                                            let tcState = toolCallsMap.get(tcIndex);
                                            if (!tcState) {
                                                tcState = { id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`, name: tc.function?.name || '', arguments: '' };
                                                toolCallsMap.set(tcIndex, tcState);
                                            }
                                            if (tc.function?.arguments) {
                                                tcState.arguments += tc.function.arguments;
                                            }
                                            if (tc.id && !tcState.id.startsWith('call_')) {
                                                tcState.id = tc.id;
                                            }
                                            if (tc.function?.name) {
                                                tcState.name = tc.function.name;
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                // Ignore parsing errors for partial chunks
                                Logger.error(`Failed to parse chunk: ${e}`);
                            }
                        }
                    }
                });

                res.on('end', () => {
                    if (isCurrentlyThinking) {
                        isCurrentlyThinking = false;
                        progress.report(new vscode.LanguageModelTextPart('\n</think>\n'));
                    }

                    for (const tc of toolCallsMap.values()) {
                        if (tc.name) {
                            let inputObj = {};
                            let argsStr = (tc.arguments || '{}').trim();
                            // Sanitize markdown blocks if model wrapped the JSON
                            if (argsStr.startsWith('```json')) argsStr = argsStr.substring(7);
                            else if (argsStr.startsWith('```')) argsStr = argsStr.substring(3);
                            if (argsStr.endsWith('```')) argsStr = argsStr.substring(0, argsStr.length - 3);
                            argsStr = argsStr.trim();

                            try {
                                inputObj = JSON.parse(argsStr);
                            } catch (e) {
                                // Try to fix unescaped newlines in JSON string values
                                try {
                                    const fixedArgs = argsStr.replace(/(?<=:\s*")([^"]+)(?=")/g, (match) => {
                                        return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                                    });
                                    inputObj = JSON.parse(fixedArgs);
                                } catch (e2) {
                                    Logger.error(`Failed to parse tool call arguments: ${tc.arguments}`);
                                }
                            }
                            progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, inputObj));
                        }
                    }
                    resolve();
                });
            });

            req.on('error', reject);
            token.onCancellationRequested(() => {
                req.destroy();
                resolve();
            });

            req.write(body);
            req.end();
        });
    }

    provideTokenCount(
        model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Thenable<number> {
        let rawText = '';

        try {
            if (typeof text === 'string') {
                rawText = text;
            } else if (text && typeof text === 'object') {
                if ('content' in text) {
                    const content = (text as any).content;
                    if (typeof content === 'string') {
                        rawText = content;
                    } else if (Array.isArray(content)) {
                        rawText = content.map(c => {
                            if (typeof c === 'string') return c;
                            if (c && typeof c === 'object' && 'value' in c && typeof (c as any).value === 'string') return (c as any).value;
                            if (c && typeof c === 'object' && 'text' in c && typeof (c as any).text === 'string') return (c as any).text;
                            return JSON.stringify(c);
                        }).join(' ');
                    }
                } else if ('value' in text && typeof (text as any).value === 'string') {
                    rawText = (text as any).value;
                } else {
                    rawText = JSON.stringify(text);
                }
            } else {
                rawText = String(text);
            }
        } catch (e) {
            rawText = String(text);
        }

        const tokens = Math.max(1, Math.ceil(rawText.length / 3.5));

        return Promise.resolve(tokens);
    }
}
