
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { GoogleGenAI, Type, FunctionDeclaration, Content, Part } from "@google/genai";
import { CreateMLCEngine } from "@mlc-ai/web-llm";
import { LogEntry, FilterState, LogLevel } from '../types.ts';

// Define FunctionCall locally since it is not exported by the SDK
interface FunctionCall {
  name: string;
  args: Record<string, any>;
  id?: string;
}

// Local definition to match SDK response structure or augment it
interface GenerateContentResponse {
  text?: string | undefined;
  functionCalls?: FunctionCall[];
  candidates?: { content?: Content }[];
}

interface FilterAction {
  type: 'apply_filter';
  payload: Partial<FilterState>;
  label: string;
}

interface AIAssistantProps {
  onClose: () => void;
  visibleLogs: LogEntry[];
  allLogs: LogEntry[];
  allDaemons: string[];
  onUpdateFilters: (filters: Partial<FilterState>, reset?: boolean) => void;
  onScrollToLog: (logId: number) => void;
  savedFindings: string[];
  onSaveFinding: (finding: string) => void;
}

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  isError?: boolean;
  isWarning?: boolean;
  action?: FilterAction;
}

interface DownloadStatus {
  text: string;
  progress: number; // 0 to 1
}

// Extend Window interface for Chrome's Built-in AI
declare global {
  interface Window {
    LanguageModel?: any;
    ai?: {
      languageModel?: {
        capabilities?: () => Promise<{ available: 'readily' | 'after-download' | 'no' }>;
        availability?: (options?: any) => Promise<string>;
        create?: (options?: any) => Promise<any>;
      };
    };
  }
}

// --- Helpers for Efficient Search ---

// Find the first index where value >= target (Lower Bound)
const lowerBound = (arr: number[], value: number): number => {
    let l = 0, r = arr.length;
    while (l < r) {
        const m = (l + r) >>> 1;
        if (arr[m] < value) l = m + 1;
        else r = m;
    }
    return l;
};

// Find the first index in logs where timestamp >= targetTime
const findLogStartIndex = (logs: LogEntry[], time: number): number => {
    let l = 0, r = logs.length;
    while (l < r) {
        const m = (l + r) >>> 1;
        if (logs[m].timestamp.getTime() < time) l = m + 1;
        else r = m;
    }
    return l;
};

// Normalize log message into a repeating structural pattern
const extractLogPattern = (msg: string): string => {
  return msg
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>')
    .replace(/0x[0-9a-fA-F]+/g, '<HEX>')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>')
    .replace(/\b\d+\b/g, '<NUM>')
    .trim();
};

// --- Tool Definitions ---

const updateFiltersTool: FunctionDeclaration = {
  name: 'update_filters',
  description: 'Updates the log filters. Use this when the user explicitly asks to filter logs (e.g., "show me error logs", "filter by daemon X"). If the user is just asking for analysis and you think filtering would help, set apply_immediately to false to show a suggestion button.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      log_levels: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of log levels to include (e.g., "ERROR", "WARNING").',
      },
      daemons: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of daemon names to filter by.',
      },
      search_keywords: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of keywords to set as a filter on the view.',
      },
      keyword_match_mode: {
        type: Type.STRING,
        enum: ['AND', 'OR'],
        description: 'Set to "OR" if the search_keywords are synonyms (any match). Set to "AND" if all keywords must be present. Default is "OR".',
      },
      reset_before_applying: {
        type: Type.BOOLEAN,
        description: 'If true, assumes a fresh slate (default true for new tabs).',
      },
      apply_immediately: {
        type: Type.BOOLEAN,
        description: 'Set to true if the user explicitly commanded to change filters (e.g. "filter by...", "show only..."). Set to false if this is a proactive suggestion based on analysis.',
      }
    },
  },
};

const scrollToLogTool: FunctionDeclaration = {
  name: 'scroll_to_log',
  description: 'Scroll the viewer to a specific log entry. Use this when the user clicks a log ID link or when you want to show a specific log.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      log_id: {
        type: Type.NUMBER,
        description: 'The numeric ID of the log entry.',
      },
    },
    required: ['log_id'],
  },
};

const searchLogsTool: FunctionDeclaration = {
  name: 'search_logs',
  description: 'Search all logs for specific keywords or regular expressions.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      keywords: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of terms to search for. E.g., ["charger", "battery", "error"].',
      },
      regex: {
        type: Type.STRING,
        description: 'Optional regular expression to match against log messages.'
      },
      match_mode: {
        type: Type.STRING,
        enum: ['AND', 'OR'],
        description: 'If "OR", log matches if ANY keyword is present. If "AND", matches if ALL are present.',
      },
      limit: {
        type: Type.NUMBER,
        description: 'Maximum number of logs to return (default 500).',
      },
    },
  },
};

const findLogPatternsTool: FunctionDeclaration = {
  name: 'find_log_patterns',
  description: 'Analyzes logs to find repeating error patterns, statistical anomalies, or regular expression matches over a specific time window. Returns aggregated patterns, match counts, and example log IDs.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      pattern_type: {
        type: Type.STRING,
        enum: ['repeating_error', 'frequency_spike', 'regex'],
        description: 'The type of pattern to search for: "repeating_error" (default) finds common error patterns, "frequency_spike" finds activity spikes, "regex" searches with a regular expression.'
      },
      regex: {
        type: Type.STRING,
        description: 'Optional regular expression pattern to search for (e.g. "error|fail|timeout|exception" or "(?i)connection refused").'
      },
      time_window_minutes: {
        type: Type.NUMBER,
        description: 'Optional. The number of minutes from the end of the log file to analyze. Defaults to the entire log file if not provided.'
      }
    }
  }
};

const traceErrorOriginTool: FunctionDeclaration = {
  name: 'trace_error_origin',
  description: 'Traces events leading up to a specific log entry and returns surrounding context (±5 log lines) plus pre-incident timeline to pinpoint the root cause.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      error_log_id: {
        type: Type.NUMBER,
        description: 'The numeric ID of the log entry to start the trace from.'
      },
      trace_window_seconds: {
        type: Type.NUMBER,
        description: 'How many seconds to look backward in time from the error log\'s timestamp. Defaults to 60 seconds.'
      },
      include_surrounding_context: {
        type: Type.BOOLEAN,
        description: 'Whether to include ±5 surrounding log entries immediately adjacent to error_log_id. Defaults to true.'
      }
    },
    required: ['error_log_id']
  }
};

const correlateTimelineTool: FunctionDeclaration = {
  name: 'correlate_timeline',
  description: 'Correlates multi-daemon activity across processes, PIDs, request/transaction IDs, and hosts around a target event or time window. Groups activity by daemon and process.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      target_log_id: {
        type: Type.NUMBER,
        description: 'Optional. The log ID around which to correlate multi-daemon timeline.'
      },
      time_window_seconds: {
        type: Type.NUMBER,
        description: 'Window in seconds around the target event (±seconds). Defaults to 30 seconds.'
      },
      filter_daemons: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional list of daemons to restrict correlation to.'
      },
      pid: {
        type: Type.NUMBER,
        description: 'Optional PID to trace across daemons and processes.'
      }
    }
  }
};

const suggestSolutionTool: FunctionDeclaration = {
  name: 'suggest_solution',
  description: 'Provides potential solutions or debugging steps for a given error message. This tool is for getting advice, not for searching logs. Only use this when the user explicitly asks for a solution.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      error_message: {
        type: Type.STRING,
        description: 'The text of the error message to get a solution for.'
      }
    },
    required: ['error_message']
  }
};

const allTools = { updateFiltersTool, scrollToLogTool, searchLogsTool, findLogPatternsTool, traceErrorOriginTool, correlateTimelineTool, suggestSolutionTool };
type ConversationState = 'IDLE' | 'ANALYZING';

const getAvailableTools = (state: ConversationState): FunctionDeclaration[] => {
    return [
        allTools.searchLogsTool, 
        allTools.findLogPatternsTool, 
        allTools.traceErrorOriginTool, 
        allTools.correlateTimelineTool, 
        allTools.updateFiltersTool, 
        allTools.scrollToLogTool, 
        allTools.suggestSolutionTool
    ];
};

const MODEL_CONFIG = {
    'gemini-pro-latest': { name: 'Reasoning (Latest)', rpm: 2 },
    'gemini-flash-latest': { name: 'Balanced (Latest)', rpm: 10 },
    'gemini-flash-lite-latest': { name: 'Fast (Latest)', rpm: 15 },
    'chrome-built-in': { name: 'Local (Chrome)', rpm: Infinity },
    'web-llm': { name: 'Local (WebLLM)', rpm: Infinity },
};

// --- Gemini Error Parser Utility ---
const parseGeminiError = (err: any): { isRateLimit: boolean; retrySeconds: number; cleanMessage: string } => {
  const errStr = typeof err === 'string' ? err : (err?.message || String(err));

  let errorObj: any = null;
  const jsonMatch = errStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      errorObj = JSON.parse(jsonMatch[0]);
    } catch {}
  }

  let retrySeconds = 20;
  if (errorObj?.error?.details) {
    const retryInfo = errorObj.error.details.find(
      (d: any) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
    );
    if (retryInfo?.retryDelay) {
      retrySeconds = Math.ceil(parseFloat(retryInfo.retryDelay));
    }
  }

  const regexRetry = errStr.match(/retry in\s+([\d.]+)\s*s/i) || errStr.match(/retryDelay[:=]\s*"?(\d+)s?"?/i);
  if (regexRetry) {
    retrySeconds = Math.ceil(parseFloat(regexRetry[1]));
  }

  const is429 = errStr.includes('429') || 
                errStr.includes('RESOURCE_EXHAUSTED') || 
                errStr.toLowerCase().includes('quota exceeded') || 
                errStr.includes('rate-limit') ||
                errorObj?.error?.code === 429;

  if (is429) {
    const modelName = errorObj?.error?.message?.match(/model:\s*(\S+)/)?.[1] || '';
    const modelText = modelName ? ` (\`${modelName}\`)` : '';
    return {
      isRateLimit: true,
      retrySeconds: retrySeconds > 0 ? retrySeconds : 20,
      cleanMessage: `⚠️ **API Quota Exceeded (429 Rate Limit)**\n\nThe request limit for Gemini API${modelText} was reached.\n\n• **Recommended Wait Time**: ~${retrySeconds} seconds\n• **Suggested Actions**:\n  1. Wait a few moments and click **Retry Prompt** below.\n  2. Switch to **Fast Mode** (\`gemini-flash-lite-latest\`) or a **Local Model** (Chrome Built-in AI or WebLLM) in the header dropdown.\n  3. Enter your personal Google AI Studio key in **Settings** (⚙️) for higher quotas.`
    };
  }

  if (errStr.includes('API_KEY_INVALID') || errStr.includes('API key not valid')) {
    return {
      isRateLimit: false,
      retrySeconds: 0,
      cleanMessage: `⚠️ **Invalid API Key**\n\nThe provided Google AI API Key appears to be invalid or expired. Please check your key in **Settings** (⚙️).`
    };
  }

  return {
    isRateLimit: false,
    retrySeconds: 0,
    cleanMessage: `An error occurred while connecting to the AI model: ${errStr}`
  };
};

// --- Chrome Built-in AI (Prompt API) Utilities ---
const getChromePromptApi = (): any => {
  if (typeof window !== 'undefined') {
    if ((window as any).LanguageModel) return (window as any).LanguageModel;
    if ((window as any).ai?.languageModel) return (window as any).ai.languageModel;
  }
  if (typeof globalThis !== 'undefined') {
    if ((globalThis as any).LanguageModel) return (globalThis as any).LanguageModel;
    if ((globalThis as any).ai?.languageModel) return (globalThis as any).ai.languageModel;
  }
  if (typeof self !== 'undefined') {
    if ((self as any).LanguageModel) return (self as any).LanguageModel;
    if ((self as any).ai?.languageModel) return (self as any).ai.languageModel;
  }
  return null;
};

const checkChromePromptApiAvailability = async (lm: any): Promise<{ available: boolean; status: string; reason?: string }> => {
  if (!lm) {
    return { available: false, status: 'unavailable', reason: 'Prompt API not detected' };
  }

  // 1. Modern W3C / Chrome 131+ Prompt API: LanguageModel.availability({ languages: ... })
  if (typeof lm.availability === 'function') {
    try {
      let res: any;
      try {
        res = await lm.availability({ languages: ['en', 'es'] });
      } catch {
        try {
          res = await lm.availability({ languages: ['en'] });
        } catch {
          res = await lm.availability();
        }
      }

      if (typeof res === 'string') {
        const lower = res.toLowerCase();
        if (lower === 'available' || lower === 'readily') {
          return { available: true, status: lower };
        }
        if (lower === 'downloadable' || lower === 'after-download') {
          return { available: true, status: lower, reason: 'Model download required' };
        }
        return { available: false, status: lower, reason: `Status is ${res}` };
      }
    } catch (e: any) {
      console.warn('[Chrome AI] lm.availability() check error:', e);
    }
  }

  // 2. Older experimental Chrome Canary: ai.languageModel.capabilities()
  if (typeof lm.capabilities === 'function') {
    try {
      const caps = await lm.capabilities();
      const avail = caps?.available;
      if (avail === 'readily') {
        return { available: true, status: 'readily' };
      }
      if (avail === 'after-download') {
        return { available: true, status: 'after-download', reason: 'Model download required' };
      }
      if (avail && avail !== 'no') {
        return { available: true, status: String(avail) };
      }
      return { available: false, status: 'no', reason: 'Capabilities reported no' };
    } catch (e: any) {
      console.warn('[Chrome AI] lm.capabilities() check error:', e);
    }
  }

  // Fallback: If create function exists, treat as available
  if (typeof lm.create === 'function') {
    return { available: true, status: 'available' };
  }

  return { available: false, status: 'unavailable' };
};

// --- Pattern Abstraction Utility ---
const getLogPattern = (message: string): string => {
  return message
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TIMESTAMP>')
    // Syslog timestamp pattern (e.g., "Sep 11 12:34:56")
    .replace(/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/g, '<TIMESTAMP>')
    .replace(/0x[0-9a-fA-F]+/g, '<HEX>')
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>')
    .replace(/((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g, '<IP>')
    .replace(/\d+/g, '<NUM>')
    .trim();
};

// --- Formatted Message Component ---

const renderInlineMarkdown = (text: string, onScrollToLog: (id: number) => void): React.ReactNode => {
    // Regex matches:
    // 1. [Log ID: 123] -> Clickable
    // 2. :::scroll_to_log(123)::: -> Clickable (Safety net for local hallucinations)
    // 3. [text](url) -> Link
    // 4. http(s)://... -> Link
    const parts = text.split(/(\[Log ID: \d+\]|:::scroll_to_log\(\d+\):::|\[.*?\]\(.*?\)|https?:\/\/[^\s\)]+)/g);

    return parts.map((part, i) => {
        const logIdMatch = part.match(/^\[Log ID: (\d+)\]$/);
        if (logIdMatch) {
            const id = parseInt(logIdMatch[1], 10);
            return (
                <button
                    key={i}
                    onClick={() => onScrollToLog(id)}
                    className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-200 underline decoration-blue-500/50 hover:decoration-blue-400 font-mono cursor-pointer bg-blue-900/20 hover:bg-blue-900/40 px-1.5 rounded mx-0.5 transition-colors align-baseline text-[11px]"
                    title={`Click to scroll to log #${id}`}
                >
                    <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    <span>#{id}</span>
                </button>
            );
        }

        const shorthandMatch = part.match(/^:::scroll_to_log\((\d+)\):::$/);
        if (shorthandMatch) {
             const id = parseInt(shorthandMatch[1], 10);
             return (
                 <button
                    key={i}
                    onClick={() => onScrollToLog(id)}
                    className="inline-flex items-center gap-1 text-green-400 hover:text-green-200 underline decoration-green-500/50 hover:decoration-green-400 font-mono cursor-pointer bg-green-900/20 hover:bg-green-900/40 px-1.5 rounded mx-0.5 transition-colors align-baseline text-[11px]"
                    title={`Click to scroll to log #${id}`}
                >
                    <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
                    <span>Go to #{id}</span>
                </button>
             );
        }

        const linkMatch = part.match(/^\[(.*?)\]\((.*?)\)$/);
        if (linkMatch) {
            const [, text, url] = linkMatch;
            return (
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-200 underline" key={i}>
                    {text}
                </a>
            );
        }

        if (part.startsWith('http')) {
            return (
                <a href={part} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-200 underline" key={i}>
                    {part}
                </a>
            );
        }

        const boldParts = part.split(/\*\*(.*?)\*\*/g);
        return (
            <span key={i}>
                {boldParts.map((boldPart, j) => {
                    if (j % 2 === 1) return <strong key={j} className="font-bold text-white">{boldPart}</strong>;
                    const codeParts = boldPart.split(/`(.*?)`/g);
                    return (
                        <span key={j}>
                            {codeParts.map((codePart, k) => {
                                if (k % 2 === 1) return <code key={k} className="bg-gray-800 text-blue-200 px-1 py-0.5 rounded font-mono text-[11px] border border-gray-700/50 break-all">{codePart}</code>;
                                return codePart;
                            })}
                        </span>
                    );
                })}
            </span>
        );
    });
};

const FormattedMessage: React.FC<{ text: string; onScrollToLog: (id: number) => void }> = ({ text, onScrollToLog }) => {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return (
        <div className="text-xs space-y-2">
            {parts.map((part, index) => {
                if (part.startsWith('```')) {
                    const content = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
                    return (
                        <div key={index} className="bg-gray-950 rounded p-2 overflow-x-auto border border-gray-700 max-w-full">
                             <pre className="font-mono text-[10px] text-gray-300 whitespace-pre-wrap break-all">{content}</pre>
                        </div>
                    );
                }
                const lines = part.split('\n');
                return (
                    <div key={index}>
                        {lines.map((line, lineIdx) => {
                             const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
                             if (listMatch) {
                                 const [, indent, marker, content] = listMatch;
                                 const indentStr = indent || '';
                                 const paddingLeft = indentStr.length > 0 ? `${(indentStr.length / 2) + 0.25}rem` : '0';
                                 return (
                                     <div key={lineIdx} className="flex items-start ml-1 mt-1" style={{ paddingLeft }}>
                                         <span className="mr-2 text-gray-500 flex-shrink-0 select-none min-w-[1rem] text-right font-mono opacity-80">
                                             {marker && marker.match(/\d/) ? marker : '•'}
                                         </span>
                                         <span className="flex-1 break-words">
                                             {renderInlineMarkdown(content || '', onScrollToLog)}
                                         </span>
                                     </div>
                                 );
                             }
                             if (line.trim() === '') return <div key={lineIdx} className="h-2" />;
                             return (
                                 <div key={lineIdx} className="break-words min-h-[1.2em]">
                                     {renderInlineMarkdown(line, onScrollToLog)}
                                 </div>
                             );
                        })}
                    </div>
                );
            })}
        </div>
    );
};

export interface LocalModelOption {
  id: string;
  name: string;
  size: string;
  desc: string;
}

export const AVAILABLE_LOCAL_MODELS: LocalModelOption[] = [
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", name: "Llama 3.2 3B Instruct (Default, ~2.2GB)", size: "~2.2 GB", desc: "Recommended balance of reasoning, instruction following, and speed." },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", name: "Llama 3.2 1B Instruct (Ultra-Fast, ~880MB)", size: "~880 MB", desc: "Lowest memory footprint and fastest generation on lighter devices." },
  { id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 Coder 1.5B (Code & Logs, ~1.0GB)", size: "~1.0 GB", desc: "Trained specifically for code, structured logs, and JSON." },
  { id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 Coder 7B (High Precision, ~4.5GB)", size: "~4.5 GB", desc: "Strongest local coding and diagnostic model (requires 6GB+ VRAM)." },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", name: "Phi-3.5 Mini Instruct (Reasoning, ~2.3GB)", size: "~2.3 GB", desc: "Microsoft 3.8B model with strong multi-step logic." },
  { id: "gemma-2-2b-it-q4f16_1-MLC", name: "Gemma 2 2B Instruct (Google On-Device, ~1.6GB)", size: "~1.6 GB", desc: "Google lightweight open-weights instruction model." },
];

const WEBLMM_CONSENT_KEY = 'nhc_log_viewer_webllm_consent';
const LOCAL_MODEL_STORAGE_KEY = 'nhc_log_viewer_local_model_id';

export const AIAssistant: React.FC<AIAssistantProps> = ({ onClose, visibleLogs, allLogs, allDaemons, onUpdateFilters, onScrollToLog, savedFindings, onSaveFinding }) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'model',
      text: "Hello! I'm your AI log assistant. How can I help you analyze these logs?"
    }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus | null>(null);
  const [modelTier, setModelTier] = useState<string>('gemini-flash-latest');
  const [selectedLocalModelId, setSelectedLocalModelId] = useState<string>('Llama-3.2-3B-Instruct-q4f16_1-MLC');
  const [tempLocalModelId, setTempLocalModelId] = useState<string>('Llama-3.2-3B-Instruct-q4f16_1-MLC');
  const [showWebLlmConsent, setShowWebLlmConsent] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const [isChromeModelAvailable, setIsChromeModelAvailable] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const cloudPrivacyWarningShown = useRef(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [tempApiKey, setTempApiKey] = useState('');
  const conversationStateRef = useRef<ConversationState>('IDLE');
  const lastPromptRef = useRef<string | null>(null);
  const apiRequestTimestampsRef = useRef<Record<string, number[]>>({});
  const chromeAiSession = useRef<any>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [disableLocalSearch, setDisableLocalSearch] = useState(false);
  const [tempDisableLocalSearch, setTempDisableLocalSearch] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const handleCopyMessage = (text: string, id: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (e) {
      console.error("Failed to copy message:", e);
    }
  };

  // Cancellation and abort management
  const isCancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mlcEngine = useRef<any>(null);
  const currentLoadedModelId = useRef<string | null>(null);

  // --- 1. Efficient Indexing using useMemo ---
  const logIndex = useMemo(() => {
    const levels: Record<string, number[]> = {};
    const daemons: Record<string, number[]> = {};
    const len = allLogs.length;
    for (let i = 0; i < len; i++) {
        const log = allLogs[i];
        if (!levels[log.level]) levels[log.level] = [];
        levels[log.level].push(i);
        const d = (log.daemon || '').toLowerCase();
        if (d) {
            if (!daemons[d]) daemons[d] = [];
            daemons[d].push(i);
        }
    }
    return { levels, daemons };
  }, [allLogs]);

  useEffect(() => {
    const checkChromeAI = async () => {
        const lm = getChromePromptApi();
        if (lm) {
            try {
                const check = await checkChromePromptApiAvailability(lm);
                if (check.available) {
                    setIsChromeModelAvailable(true);
                }
            } catch (e) {
                console.warn("Could not check for Chrome's built-in AI:", e);
            }
        }
    };
    checkChromeAI();
  }, []);

  useEffect(() => {
      const storedKey = localStorage.getItem('nhc_log_viewer_api_key');
      if (storedKey) {
          setUserApiKey(storedKey);
          setTempApiKey(storedKey);
      }
      
      const storedDisableSearch = localStorage.getItem('nhc_log_viewer_disable_local_search');
      if (storedDisableSearch === 'true') {
          setDisableLocalSearch(true);
          setTempDisableLocalSearch(true);
      }

      const storedLocalModel = localStorage.getItem(LOCAL_MODEL_STORAGE_KEY);
      if (storedLocalModel && AVAILABLE_LOCAL_MODELS.some(m => m.id === storedLocalModel)) {
          setSelectedLocalModelId(storedLocalModel);
          setTempLocalModelId(storedLocalModel);
      }
  }, []);

  useEffect(() => {
    return () => {
        if (chromeAiSession.current) {
            console.log('[AI] Destroying Chrome AI session on component unmount.');
            chromeAiSession.current.destroy?.();
            chromeAiSession.current = null;
        }
    };
  }, []);

  const handleCancelRequest = useCallback(() => {
    isCancelledRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (mlcEngine.current) {
      try {
        mlcEngine.current.interruptGenerate?.();
      } catch (e) {
        console.warn("Could not interrupt WebLLM:", e);
      }
    }
    if (chromeAiSession.current) {
      try {
        chromeAiSession.current.destroy?.();
      } catch {}
      chromeAiSession.current = null;
    }
    setIsLoading(false);
    setDownloadStatus(null);
    setPendingPrompt(null);
    conversationStateRef.current = 'IDLE';
    addMessage('model', '⏹️ **Request cancelled.** You can send another prompt anytime.', false, true);
  }, []);

  const handleSaveSettings = () => {
      const newKey = tempApiKey.trim();
      localStorage.setItem('nhc_log_viewer_api_key', newKey);
      setUserApiKey(newKey);
      
      localStorage.setItem('nhc_log_viewer_disable_local_search', String(tempDisableLocalSearch));
      setDisableLocalSearch(tempDisableLocalSearch);

      localStorage.setItem(LOCAL_MODEL_STORAGE_KEY, tempLocalModelId);
      if (tempLocalModelId !== selectedLocalModelId) {
          setSelectedLocalModelId(tempLocalModelId);
          // If model changed, reset engine so new model loads on next local request
          if (mlcEngine.current && currentLoadedModelId.current !== tempLocalModelId) {
              mlcEngine.current = null;
              currentLoadedModelId.current = null;
          }
      }

      setIsSettingsOpen(false);
      if (newKey && lastPromptRef.current) {
          addMessage('model', "Settings saved. Retrying your last request...", false);
          handleSubmit(undefined, lastPromptRef.current);
          lastPromptRef.current = null;
      }
  };
  
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, downloadStatus]);

  const addMessage = useCallback((role: 'user' | 'model', text: string, isError = false, isWarning = false, action?: FilterAction) => {
    setMessages(prev => [...prev, { id: Date.now().toString() + Math.random(), role, text, isError, isWarning, action }]);
  }, []);
  
  const handleToolCall = useCallback(async (toolName: string, args: any, aiInstance?: GoogleGenAI): Promise<any> => {
    try {
      const normalizedName = (toolName || '').toLowerCase().trim();

      // Tool Alias Mapping
      if (normalizedName === 'update_filters' || normalizedName === 'filter_logs' || normalizedName === 'set_filters') {
        let levels = args.log_levels || args.levels || [];
        if (typeof levels === 'string') levels = [levels];
        let daemons = args.daemons || args.daemon || [];
        if (typeof daemons === 'string') daemons = [daemons];
        let keywords = args.search_keywords || args.keywords || [];
        if (typeof keywords === 'string') keywords = [keywords];

        if (args.apply_immediately) {
             const filters = {
                 selectedLevels: levels,
                 selectedDaemons: daemons,
                 keywordQueries: keywords,
                 keywordMatchMode: args.keyword_match_mode || 'OR',
             };
             onUpdateFilters(filters, args.reset_before_applying ?? true);
             return { success: true, summary: `Filters applied immediately as requested.` };
        }
        return { success: true, summary: `Filter suggestion created. User can apply it via the UI.` };
      }

      if (normalizedName === 'scroll_to_log' || normalizedName === 'scroll_to' || normalizedName === 'view_log') {
        const rawId = args.log_id ?? args.id;
        const id = Number(String(rawId || '').replace(/\D/g, ''));
        if (!isNaN(id)) {
            onScrollToLog(id);
            return { success: true, summary: `Scrolled to log ID #${id}.` };
        }
        return { error: `Invalid log ID: ${rawId}` };
      }

      if (normalizedName === 'search_logs' || normalizedName === 'search' || normalizedName === 'find_logs' || normalizedName === 'query_logs') {
        let rawKeywords = args.keywords ?? args.query ?? args.search_keywords ?? args.keyword ?? [];
        let keywords: string[] = [];
        if (Array.isArray(rawKeywords)) {
            keywords = rawKeywords.map(k => String(k).trim()).filter(Boolean);
        } else if (typeof rawKeywords === 'string') {
            keywords = rawKeywords.split(/[\s,]+/).map(k => k.trim()).filter(Boolean);
        }

        const match_mode = (args.match_mode || 'OR').toUpperCase() === 'AND' ? 'AND' : 'OR';
        const limit = typeof args.limit === 'number' ? args.limit : 500;
        const regexStr = args.regex || args.pattern;

        let regex: RegExp | null = null;
        if (regexStr) {
            try {
                let clean = regexStr;
                let flags = 'i';
                if (clean.startsWith('/') && clean.lastIndexOf('/') > 0) {
                    const lastSlash = clean.lastIndexOf('/');
                    flags = clean.slice(lastSlash + 1) || 'i';
                    clean = clean.slice(1, lastSlash);
                }
                regex = new RegExp(clean, flags);
            } catch (err: any) {
                return { error: `Invalid regex pattern: ${err.message}` };
            }
        }

        if (keywords.length === 0 && !regex) {
            return { summary: 'No keywords or regular expression provided.' };
        }

        const lowerCaseKeywords = keywords.map(k => k.toLowerCase());
        const results = allLogs.filter(log => {
            if (regex) {
                return regex.test(log.message) || regex.test(log.daemon);
            }
            const textToSearch = `${log.message} ${log.daemon} ${log.level}`.toLowerCase();
            if (match_mode === 'AND') return lowerCaseKeywords.every(kw => textToSearch.includes(kw));
            return lowerCaseKeywords.some(kw => textToSearch.includes(kw));
        }).slice(0, limit);

        if (results.length === 0) {
            return { summary: `Found 0 logs matching criteria.` };
        }

        const levelCounts = results.reduce((acc, log) => {
            acc[log.level] = (acc[log.level] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        return {
            summary: `Found ${results.length} logs matching criteria. Levels breakdown: ${JSON.stringify(levelCounts)}.`,
            example_log_ids: results.slice(0, 5).map(l => l.id),
            sample_messages: results.slice(0, 3).map(l => `[Log #${l.id}] ${l.daemon}: ${l.message.slice(0, 120)}`)
        };
      }

      if (
        normalizedName === 'find_log_patterns' || 
        normalizedName === 'find_repeating_errors' || 
        normalizedName === 'find_errors' || 
        normalizedName === 'regex_search' || 
        normalizedName === 'pattern_search' ||
        normalizedName === 'search_patterns'
      ) {
        const pattern_type = String(args.pattern_type || args.type || 'repeating_error').toLowerCase();
        const time_window_minutes = args.time_window_minutes ? Number(args.time_window_minutes) : undefined;
        const regexStr = args.regex || args.regex_pattern || args.pattern;

        // Safely determine target logs within time window (if specified)
        let targetLogs = allLogs;
        if (allLogs.length > 0 && time_window_minutes && !isNaN(time_window_minutes) && time_window_minutes > 0) {
            const lastLog = allLogs[allLogs.length - 1];
            if (lastLog?.timestamp) {
                const endTime = lastLog.timestamp.getTime();
                const startTime = endTime - time_window_minutes * 60 * 1000;
                const filtered = allLogs.filter(log => {
                    const logTime = log.timestamp ? log.timestamp.getTime() : 0;
                    return logTime >= startTime && logTime <= endTime;
                });
                if (filtered.length > 0) {
                    targetLogs = filtered;
                }
            }
        }

        // Branch 1: Regex Pattern Search
        if (regexStr || pattern_type.includes('regex')) {
            try {
                let clean = regexStr || 'error';
                let flags = 'i';
                if (clean.startsWith('/') && clean.lastIndexOf('/') > 0) {
                    const lastSlash = clean.lastIndexOf('/');
                    flags = clean.slice(lastSlash + 1) || 'i';
                    clean = clean.slice(1, lastSlash);
                }
                const re = new RegExp(clean, flags);
                let matches = targetLogs.filter(l => re.test(l.message) || re.test(l.daemon));
                if (matches.length === 0 && targetLogs !== allLogs) {
                    matches = allLogs.filter(l => re.test(l.message) || re.test(l.daemon));
                }

                type PatternStats = { count: number; id: number; sample: string; daemon: string };
                const patternCounts: Record<string, PatternStats> = {};

                matches.forEach(log => {
                    const generic = extractLogPattern(log.message);
                    const key = `${log.daemon}: ${generic}`;
                    if (!patternCounts[key]) {
                        patternCounts[key] = { count: 0, id: log.id, sample: log.message, daemon: log.daemon };
                    }
                    patternCounts[key].count++;
                });

                const topPatterns = Object.entries(patternCounts)
                    .sort((a, b) => b[1].count - a[1].count)
                    .slice(0, 5);

                return {
                    summary: `Regex /${clean}/ matched ${matches.length} logs across ${topPatterns.length} distinct recurring patterns.`,
                    total_matches: matches.length,
                    top_patterns: topPatterns.map(([key, data]) => ({
                        daemon: data.daemon,
                        message_pattern: key,
                        count: data.count,
                        example_log_id: data.id,
                        sample_message: data.sample.slice(0, 140)
                    })),
                    example_log_ids: topPatterns.map(([, d]) => d.id)
                };
            } catch (regErr: any) {
                return { error: `Invalid regular expression "${regexStr}": ${regErr.message}` };
            }
        }

        // Branch 2: Frequency Spike Detection
        if (pattern_type.includes('spike') || pattern_type.includes('frequency')) {
            const bucketSize = 60 * 1000; // 1 minute
            const buckets: Record<number, number> = {};
            targetLogs.forEach(log => {
                if (!log.timestamp) return;
                const bucket = Math.floor(log.timestamp.getTime() / bucketSize);
                buckets[bucket] = (buckets[bucket] || 0) + 1;
            });
            const counts = Object.values(buckets);
            if (counts.length < 2) return { summary: 'Not enough distinct timestamp intervals to detect spikes.' };
            const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
            const stdDev = Math.sqrt(counts.map(x => Math.pow(x - avg, 2)).reduce((a, b) => a + b, 0) / counts.length);
            const spikes = Object.entries(buckets).filter(([, count]) => count > avg + 2 * stdDev);
            if (spikes.length === 0) return { summary: 'No significant spikes in log frequency detected.' };
            return {
                summary: `Detected ${spikes.length} spike(s) in log activity. The largest spike reached ${Math.max(...spikes.map(s => s[1]))} logs/min.`,
                spikes: spikes.map(([bucket, count]) => ({ timestamp: new Date(Number(bucket) * bucketSize).toISOString(), count }))
            };
        }

        // Branch 3: Repeating Error Search (Default)
        const isErrorLog = (l: LogEntry) => {
            const lvl = String(l.level || '').toUpperCase();
            return lvl === 'ERROR' || lvl === 'CRITICAL' || lvl === 'WARNING';
        };

        let pool = targetLogs.filter(isErrorLog);
        if (pool.length === 0 && targetLogs !== allLogs) {
            pool = allLogs.filter(isErrorLog);
        }
        if (pool.length === 0) {
            // Check for message text error keywords if level flags weren't used
            const errorKw = /error|fail|exception|fatal|panic|refused/i;
            pool = allLogs.filter(l => errorKw.test(l.message));
        }

        if (pool.length === 0) {
            return { summary: 'No repeating error or warning patterns detected in the examined logs.' };
        }

        type PatternStats = { count: number; id: number; sample: string; daemon: string };
        const counts: Record<string, PatternStats> = {};

        pool.forEach(log => {
            const generic = extractLogPattern(log.message);
            const key = `${log.daemon}: ${generic}`;
            if (!counts[key]) {
                counts[key] = { count: 0, id: log.id, sample: log.message, daemon: log.daemon };
            }
            counts[key].count++;
        });

        const top = Object.entries(counts).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
        return {
            summary: `Found ${top.length} repeating error pattern(s) across ${pool.length} error/warning logs. The most frequent occurred ${top[0][1].count} times.`,
            top_patterns: top.map(([key, data]) => ({
                daemon: data.daemon,
                message_pattern: key,
                count: data.count,
                example_log_id: data.id,
                sample_message: data.sample.slice(0, 140)
            })),
            example_log_ids: top.map(([, d]) => d.id)
        };
      }
        
      if (normalizedName === 'trace_error_origin' || normalizedName === 'trace_error' || normalizedName === 'trace') {
          const rawId = args.error_log_id ?? args.log_id ?? args.id;
          const targetId = Number(String(rawId || '').replace(/\D/g, ''));
          const trace_window_seconds = Number(args.trace_window_seconds) || 60;
          const include_surrounding_context = args.include_surrounding_context !== false;

          const targetIndex = allLogs.findIndex(l => l.id === targetId);
          if (targetIndex === -1) return { summary: `Log ID #${rawId} not found.` };
          
          const errorLog = allLogs[targetIndex];
          const endTime = errorLog.timestamp ? errorLog.timestamp.getTime() : Date.now();
          const startTime = endTime - trace_window_seconds * 1000;
          const traceLogs = allLogs.filter(l => {
              const t = l.timestamp ? l.timestamp.getTime() : 0;
              return t >= startTime && t <= endTime;
          });
          const levelCounts = traceLogs.reduce((acc, log) => {
              acc[log.level] = (acc[log.level] || 0) + 1;
              return acc;
          }, {} as Record<string, number>);

          // Context Windowing (±5 surrounding log entries immediately adjacent to error_log_id)
          let surroundingContext: any[] = [];
          if (include_surrounding_context) {
              const startIdx = Math.max(0, targetIndex - 5);
              const endIdx = Math.min(allLogs.length, targetIndex + 6);
              surroundingContext = allLogs.slice(startIdx, endIdx).map(l => ({
                  id: l.id,
                  is_target: l.id === targetId,
                  timestamp: l.timestamp ? l.timestamp.toISOString() : '',
                  level: l.level,
                  daemon: l.daemon,
                  pid: l.pid,
                  function: l.functionName,
                  message: l.message
              }));
          }

          return {
              summary: `Found ${traceLogs.length} logs in the ${trace_window_seconds}s before log #${targetId}. Levels: ${JSON.stringify(levelCounts)}.`,
              surrounding_window_5_lines: surroundingContext,
              recent_pre_error_logs: traceLogs.slice(-8).map(l => ({
                  id: l.id,
                  timestamp: l.timestamp ? l.timestamp.toISOString() : '',
                  daemon: l.daemon,
                  level: l.level,
                  message: l.message
              })),
              example_log_ids: traceLogs.slice(-5).map(l => l.id)
          };
      }

      if (normalizedName === 'correlate_timeline' || normalizedName === 'correlate') {
          const rawId = args.target_log_id ?? args.log_id ?? args.id;
          const target_log_id = rawId !== undefined ? Number(String(rawId).replace(/\D/g, '')) : undefined;
          const time_window_seconds = Number(args.time_window_seconds) || 30;
          const filter_daemons = args.filter_daemons;
          const pid = args.pid !== undefined ? Number(args.pid) : undefined;

          let centerTime = 0;
          let refLog: LogEntry | undefined;

          if (target_log_id !== undefined && !isNaN(target_log_id)) {
              refLog = allLogs.find(l => l.id === target_log_id);
              if (refLog?.timestamp) {
                  centerTime = refLog.timestamp.getTime();
              }
          }

          if (!centerTime && allLogs.length > 0) {
              const last = allLogs[allLogs.length - 1];
              if (last?.timestamp) centerTime = last.timestamp.getTime();
          }

          if (!centerTime) return { summary: 'No logs available to correlate timeline.' };

          const startWindow = centerTime - (time_window_seconds * 1000);
          const endWindow = centerTime + (time_window_seconds * 1000);

          let windowLogs = allLogs.filter(l => {
              if (!l.timestamp) return false;
              const t = l.timestamp.getTime();
              if (t < startWindow || t > endWindow) return false;
              if (filter_daemons && filter_daemons.length > 0 && !filter_daemons.includes(l.daemon)) return false;
              if (pid !== undefined && l.pid !== pid) return false;
              return true;
          });

          const daemonGroups: Record<string, { count: number; pids: Set<number>; errorCount: number; sampleLogs: any[] }> = {};
          
          windowLogs.forEach(l => {
              if (!daemonGroups[l.daemon]) {
                  daemonGroups[l.daemon] = { count: 0, pids: new Set<number>(), errorCount: 0, sampleLogs: [] };
              }
              const g = daemonGroups[l.daemon];
              g.count += 1;
              if (l.pid) g.pids.add(l.pid);
              if (l.level === LogLevel.ERROR || l.level === LogLevel.CRITICAL) g.errorCount += 1;
              if (g.sampleLogs.length < 3 || l.level === LogLevel.ERROR || l.level === LogLevel.CRITICAL) {
                  if (g.sampleLogs.length < 5) {
                      g.sampleLogs.push({ id: l.id, time: l.timestamp.toISOString(), level: l.level, pid: l.pid, msg: l.message });
                  }
              }
          });

          const summaryGroups = Object.entries(daemonGroups).map(([daemon, g]) => ({
              daemon,
              total_logs: g.count,
              errors: g.errorCount,
              pids: Array.from(g.pids),
              sample_entries: g.sampleLogs
          }));

          return {
              summary: `Correlated ${windowLogs.length} logs across ${summaryGroups.length} daemons in ±${time_window_seconds}s window around ${refLog ? `Log ID #${target_log_id}` : 'recent timeline'}.`,
              time_range: { start: new Date(startWindow).toISOString(), end: new Date(endWindow).toISOString() },
              daemon_breakdown: summaryGroups,
              significant_event_log_ids: windowLogs.filter(l => l.level === LogLevel.ERROR || l.level === LogLevel.CRITICAL || l.id === target_log_id).map(l => l.id).slice(0, 10)
          };
      }
        
      if (normalizedName === 'suggest_solution') {
          if (!aiInstance) return { summary: 'Local AI cannot suggest solution using Cloud Tools. Please answer based on your knowledge.' };
          const solutionPrompt = `Based on the following error message, act as a senior software engineer and provide a concise, actionable list of potential causes and solutions. Error: "${args.error_message}"`;
          try {
              const result = await aiInstance.models.generateContent({ model: 'gemini-flash-latest', contents: [{ role: 'user', parts: [{ text: solutionPrompt }] }] });
              const text = result.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || "Could not generate a solution.";
              return { solution: text };
          } catch (e: any) {
              return { solution: `An error occurred while generating a solution: ${e.message}` };
          }
      }

      return { error: `Tool "${toolName}" not found.` };
    } catch (toolErr: any) {
      console.error(`Error executing tool "${toolName}":`, toolErr);
      return { error: `Tool execution error: ${toolErr.message || 'Internal error'}` };
    }
  }, [allLogs, onScrollToLog, onUpdateFilters]);

  const runCloudAI = useCallback(async (prompt: string, effectiveModel: string) => {
    lastPromptRef.current = prompt;
    const apiKey = userApiKey || import.meta.env.VITE_API_KEY;
    if (!apiKey) {
      addMessage('model', "API key is not configured. Please set one in the settings (⚙️) or get one from [Google AI Studio](https://aistudio.google.com/api-keys).", true);
      setIsLoading(false);
      return;
    }
    
    if (!cloudPrivacyWarningShown.current) {
        addMessage('model', "You are using a cloud-based AI model. A summary of your log data will be sent to Google for analysis. For fully private, on-device analysis, you can switch to a local model.", false, true);
        cloudPrivacyWarningShown.current = true;
    }
    
    const ai = new GoogleGenAI({ apiKey });

    let systemPrompt = `You are a Principal Reliability & Systems Engineer embedded in the NHC Log Viewer. Your goal is to analyze logs, trace multi-daemon failure cascades, and deliver high-precision root cause investigations.

# STRUCTURED INCIDENT ANALYSIS FORMAT
When the user asks for root cause analysis, error investigation, or troubleshooting, structure your response clearly using these sections:
1. **Executive Summary**: 1-2 sentence high-level summary of what failed, impact, and severity.
2. **Chronological Incident Timeline**: Key sequential events with clickable [Log #ID] references, timestamp, daemon/PID, and what happened.
3. **Root Cause Analysis**: The primary trigger vs cascading symptoms, why it happened, and why dependent subsystems failed.
4. **Actionable Fixes & Mitigation**: Immediate remediation steps and preventative long-term code/config changes.
5. **Recommended Filter**: Suggested filter or search query to isolate this incident in the viewer.

# GUIDELINES & TOOLS
- Always cite specific log IDs in brackets like \`[Log #1234]\` so the user can click to inspect them directly.
- Use \`trace_error_origin\` to inspect surrounding lines (±5) and pre-error timeline before concluding root cause.
- Use \`correlate_timeline\` when multiple daemons or processes are involved.
- Total logs across all files: ${allLogs.length.toLocaleString()}
- Available Daemons: ${allDaemons.join(', ') || 'N/A'}`;

    if (effectiveModel === 'gemini-pro-latest') {
        systemPrompt += `\n\nIMPORTANT: You are running on a model with strict rate limits. Try to answer the user's question directly or with minimal tool calls.`;
    }

    const history: Content[] = messages.slice(1).reduce((acc: Content[], m) => {
        if (m.isError || m.isWarning) return acc;
        if (m.role === 'model' && (m.text.startsWith('Tool Call:') || m.text.startsWith('Tool Response:'))) {
          // Skip these messages as they are for UI display only
        } else {
            acc.push({ role: m.role, parts: [{ text: m.text }] });
        }
        return acc;
    }, []);
    
    history.push({ role: 'user', parts: [{ text: prompt }] });
    
    const historyChars = JSON.stringify(history).length;
    const payloadConfig = { 
        systemInstruction: systemPrompt, 
        tools: [{ functionDeclarations: getAvailableTools(conversationStateRef.current) }] 
    };

    console.groupCollapsed(`[AI] Calling Gemini with ~${(historyChars / 4).toFixed(0)} tokens`);
    console.log(`[AI] Model: ${effectiveModel}`);
    console.log('[AI] Full Payload:', { contents: history, config: payloadConfig });
    console.groupEnd();
    
    let pendingFilterAction: FilterAction | null = null;
    const MAX_TURNS = 10;
    
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        if (isCancelledRef.current) {
            console.log('[AI] Execution cancelled by user.');
            setIsLoading(false);
            return;
        }
        console.groupCollapsed(`[AI] Turn ${turn}/${MAX_TURNS}`);
        console.log(`[AI] State: ${conversationStateRef.current}`);

        let response: GenerateContentResponse;
        try {
            const result = await ai.models.generateContent({ 
                model: effectiveModel, 
                contents: history, 
                config: payloadConfig
            });
            
            if (isCancelledRef.current) {
                console.log('[AI] Execution cancelled by user during response.');
                setIsLoading(false);
                console.groupEnd();
                return;
            }
            
            const responseTextCandidate = result.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || undefined;
            
            response = { text: responseTextCandidate, functionCalls: result.functionCalls as FunctionCall[], candidates: result.candidates };
            
            const responseText = response.text || "";
            const responseChars = responseText.length + JSON.stringify(response.functionCalls || {}).length;
            console.log(`[AI] Received response from Gemini (~${(responseChars / 4).toFixed(0)} tokens)`);
            console.log('[AI] Full Response:', result);

        } catch (e: any) {
            if (isCancelledRef.current || e.name === 'AbortError') {
                setIsLoading(false);
                console.groupEnd();
                return;
            }
            console.error("AI Error:", e);
            const parsedError = parseGeminiError(e);

            if (parsedError.isRateLimit && effectiveModel !== 'gemini-flash-lite-latest') {
                console.log(`[AI Fallback] Rate limit encountered on ${effectiveModel}. Retrying automatically with Fast Mode (gemini-flash-lite-latest)...`);
                addMessage('model', `⚡ **Quota limit reached on ${MODEL_CONFIG[effectiveModel as keyof typeof MODEL_CONFIG]?.name || effectiveModel}.** Retrying automatically with Fast Mode (\`gemini-flash-lite-latest\`)...`, false, true);
                setModelTier('gemini-flash-lite-latest');
                return runCloudAI(prompt, 'gemini-flash-lite-latest');
            }

            addMessage('model', parsedError.cleanMessage, true);
            setIsLoading(false);
            console.groupEnd(); // End turn group on error
            return;
        }

        const functionCalls = response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
            // Push the model's original candidate content to preserve thought signatures and function call IDs
            if (response.candidates?.[0]?.content) {
                history.push(response.candidates[0].content);
            } else {
                history.push({ 
                    role: 'model', 
                    parts: functionCalls.map(fc => ({ functionCall: fc } as any)) 
                });
            }

            const functionResponseParts: any[] = [];

            for (const toolCall of functionCalls) {
                if (!toolCall.name) {
                     console.error("AI returned a tool call without a name.");
                     continue;
                }

                // Capture potential actions to show to the user
                if (toolCall.name === 'search_logs') {
                    pendingFilterAction = {
                        type: 'apply_filter',
                        label: 'Apply Search Filters',
                        payload: {
                            keywordQueries: toolCall.args.keywords || [],
                            keywordMatchMode: toolCall.args.match_mode || 'OR'
                        }
                    };
                } else if (toolCall.name === 'update_filters') {
                    if (!toolCall.args.apply_immediately) {
                        const labels = [];
                        if (toolCall.args.log_levels?.length) labels.push(toolCall.args.log_levels.join('|'));
                        if (toolCall.args.daemons?.length) labels.push(toolCall.args.daemons.join('|'));
                        if (toolCall.args.search_keywords?.length) labels.push(`"${toolCall.args.search_keywords.join(' ')}"`);
                        
                        pendingFilterAction = {
                            type: 'apply_filter',
                            label: labels.length > 0 ? `Filter: ${labels.join(', ')}` : 'Apply Suggested Filters',
                            payload: {
                                selectedLevels: toolCall.args.log_levels || [],
                                selectedDaemons: toolCall.args.daemons || [],
                                keywordQueries: toolCall.args.search_keywords || [],
                                keywordMatchMode: toolCall.args.keyword_match_mode || 'OR',
                            }
                        };
                    }
                } else if (toolCall.name === 'trace_error_origin') {
                     const logId = toolCall.args.error_log_id;
                     const log = allLogs.find(l => l.id === logId);
                     if (log) {
                         const end = log.timestamp;
                         const start = new Date(end.getTime() - (toolCall.args.trace_window_seconds || 60) * 1000);
                         pendingFilterAction = {
                            type: 'apply_filter',
                            label: `Isolate Trace (${toolCall.args.trace_window_seconds || 60}s)`,
                            payload: {
                                dateRange: [start, end]
                            }
                        };
                     }
                } else if (toolCall.name === 'correlate_timeline') {
                     const targetId = toolCall.args.target_log_id;
                     const log = targetId ? allLogs.find(l => l.id === targetId) : undefined;
                     const center = log ? log.timestamp.getTime() : (allLogs.length > 0 ? allLogs[allLogs.length - 1].timestamp.getTime() : Date.now());
                     const span = (toolCall.args.time_window_seconds || 30) * 1000;
                     pendingFilterAction = {
                         type: 'apply_filter',
                         label: `Isolate Correlated Window (±${toolCall.args.time_window_seconds || 30}s)`,
                         payload: {
                             dateRange: [new Date(center - span), new Date(center + span)],
                             selectedDaemons: toolCall.args.filter_daemons || []
                         }
                     };
                }

                console.groupCollapsed(`[AI] Executing tool: ${toolCall.name}`);
                console.log('[AI] Arguments:', toolCall.args);
                const toolResult = await handleToolCall(toolCall.name, toolCall.args || {}, ai);
                const toolResultChars = JSON.stringify(toolResult).length;
                console.log(`[AI] Tool responded with ~${(toolResultChars / 4).toFixed(0)} tokens.`);
                console.log('[AI] Tool Result:', toolResult);
                console.groupEnd();

                if (isCancelledRef.current) {
                    setIsLoading(false);
                    console.groupEnd();
                    return;
                }

                if ((toolCall.name === 'search_logs' || toolCall.name === 'trace_error_origin' || toolCall.name === 'correlate_timeline' || toolCall.name === 'find_log_patterns') && (toolResult?.example_log_ids?.length > 0 || toolResult?.top_patterns?.length > 0)) {
                    conversationStateRef.current = 'ANALYZING';
                    console.log('[AI State] Transitioning to ANALYZING.');
                }

                functionResponseParts.push({ 
                    functionResponse: { 
                        name: toolCall.name, 
                        response: { result: toolResult },
                        ...(toolCall.id ? { id: toolCall.id } : {})
                    } 
                });
            }

            if (functionResponseParts.length === 0) {
                addMessage('model', "Error: AI returned a tool call without a name.", true);
                break;
            }

            history.push({ 
                role: 'user', 
                parts: functionResponseParts 
            } as unknown as Content);
        } else {
            const text = response.text || "I have analyzed the logs and summarized the findings above.";
            console.log('[AI] Model returned final answer.');
            addMessage('model', text, false, false, pendingFilterAction || undefined);
            conversationStateRef.current = 'IDLE';
            console.groupEnd(); // End turn group
            break;
        }
        console.groupEnd(); // End turn group
    }
    if (!isCancelledRef.current) {
        setIsLoading(false);
    }
  }, [userApiKey, allLogs, allDaemons, messages, addMessage, handleToolCall, savedFindings]);

  const executeLocalAI = useCallback(async (initialPrompt: string) => {
    if (!mlcEngine.current) return;
    setIsLoading(true);
    setDownloadStatus(null);

    // Limit daemons context to top 50 to improve prefill speed
    const limitedDaemons = allDaemons.slice(0, 50);
    const daemonContextStr = limitedDaemons.length < allDaemons.length 
        ? `${limitedDaemons.join(', ')}... (+${allDaemons.length - 50} more)` 
        : limitedDaemons.join(', ');

    const localToolsSchema = [
        {
            name: "scroll_to_log",
            description: "Scroll the viewer to a specific log entry.",
            parameters: {
                type: "object",
                properties: { log_id: { type: "number", description: "The ID of the log" } },
                required: ["log_id"]
            }
        },
        {
            name: "update_filters",
            description: "Updates log filters. Set apply_immediately=true for user commands (e.g., 'show error logs'). Set apply_immediately=false if suggesting a filter.",
            parameters: {
                type: "object",
                properties: {
                    daemons: { type: "array", items: { type: "string" } },
                    log_levels: { type: "array", items: { type: "string" } },
                    search_keywords: { type: "array", items: { type: "string" } },
                    apply_immediately: { type: "boolean" }
                }
            }
        },
        {
            name: "search_logs",
            description: "Search all logs for keywords or regular expression.",
            parameters: {
                type: "object",
                properties: {
                    keywords: { type: "array", items: { type: "string" } },
                    regex: { type: "string", description: "Regular expression pattern to match" },
                    match_mode: { type: "string", enum: ["AND", "OR"] }
                }
            }
        },
        {
            name: "find_log_patterns",
            description: "Analyze patterns in the logs, repeating error patterns, or regex matches over a time window.",
            parameters: {
                type: "object",
                properties: {
                    pattern_type: { type: "string", enum: ["repeating_error", "frequency_spike", "regex"] },
                    regex: { type: "string", description: "Regular expression pattern to search for" },
                    time_window_minutes: { type: "number", description: "Time window in minutes from end of logs" }
                }
            }
        },
        {
            name: "trace_error_origin",
            description: "Trace pre-incident context and logs leading up to an error.",
            parameters: {
                type: "object",
                properties: {
                    error_log_id: { type: "number", description: "Log ID to trace" },
                    trace_window_seconds: { type: "number", description: "Seconds prior to examine" }
                },
                required: ["error_log_id"]
            }
        },
        {
            name: "correlate_timeline",
            description: "Correlate logs across daemons in a time window around a target event.",
            parameters: {
                type: "object",
                properties: {
                    target_log_id: { type: "number" },
                    time_window_seconds: { type: "number" },
                    filter_daemons: { type: "array", items: { type: "string" } }
                }
            }
        }
    ];

    const toolInstructions = `
# TOOLS
You can control the UI. You must answer the user's question, but if you need to perform an action, you can call a tool.
To call a tool, you MUST use the following format exactly:

<<<TOOL>>>
{
  "name": "tool_name",
  "args": { ... }
}
<<<END>>>

Available Tools (JSON Schema):
${JSON.stringify(localToolsSchema, null, 2)}
`;

    const systemPrompt = `You are a helpful AI assistant embedded in a log analysis tool. Analyze the provided information and answer the user's questions concisely.
# CONTEXT
- Total logs: ${allLogs.length.toLocaleString()}
- Available Daemons: ${daemonContextStr || 'N/A'}
${toolInstructions}`;

    let history = messages.slice(-6).reduce((acc: any[], m) => {
        if (!m.isError && !m.isWarning && (m.role !== 'model' || !m.text.startsWith('Tool'))) {
            const role = m.role === 'model' ? 'assistant' : m.role;
            let cleanContent = m.text.replace(/<<<TOOL>>>[\s\S]*?<<<END>>>/g, '').trim();
            // Handle various tag formats in cleanup
            cleanContent = cleanContent.replace(/<<<[\w_]+>>>[\s\S]*?<<<END>>>?/g, '').trim();
            if (cleanContent && !cleanContent.startsWith('Initializing local model') && !cleanContent.startsWith('Local model') && m.id !== 'welcome') {
                acc.push({ role, content: cleanContent });
            }
        }
        return acc;
    }, []);

    history.push({ role: 'user', content: initialPrompt });
    
    let turn = 0;
    const MAX_TURNS = 10; 
    let pendingFilterAction: FilterAction | null = null;

    try {
        while (turn < MAX_TURNS) {
            if (isCancelledRef.current) break;
            turn++;
            const messagesPayload = [{ role: 'system', content: systemPrompt }, ...history];

            const chunks = await mlcEngine.current.chat.completions.create({
                messages: messagesPayload,
                stream: true,
                temperature: 0.7
            });

            let fullText = "";
            let hasAddedMessage = false;
            const messageId = Date.now().toString() + Math.random();
            
            for await (const chunk of chunks) {
                if (isCancelledRef.current) {
                    break;
                }
                const delta = chunk.choices[0]?.delta?.content || "";
                if (delta) {
                    fullText += delta;
                    
                    const displayStreamText = fullText
                        .replace(/<<<[\w_]*>>>[\s\S]*?(<<<END>>>|$)/g, '')
                        .replace(/<<<TOOL>>>[\s\S]*?(<<<END>>>|$)/g, '')
                        .trimStart();

                    if (!hasAddedMessage) {
                        setMessages(prev => [...prev, { 
                            id: messageId, 
                            role: 'model', 
                            text: displayStreamText, 
                            action: pendingFilterAction || undefined 
                        }]);
                        hasAddedMessage = true;
                        if (pendingFilterAction) pendingFilterAction = null; 
                    } else {
                        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, text: displayStreamText } : m));
                    }
                }
            }

            if (isCancelledRef.current) break;

            // --- Post-Generation Parsing ---
            
            let jsonStr = "";
            let toolNameFromTag = "";

            // 1. Try standard tag match
            const standardMatch = fullText.match(/<<<TOOL>>>([\s\S]*?)<<<END>>>?/);
            if (standardMatch) {
                jsonStr = standardMatch[1];
            } else {
                // 2. Try tag-as-name match (e.g. <<<update_filters>>> { ... } <<<END>>>)
                const namedTagMatch = fullText.match(/<<<(\w+)>>>([\s\S]*?)<<<END>>>?/);
                if (namedTagMatch) {
                    toolNameFromTag = namedTagMatch[1];
                    jsonStr = namedTagMatch[2];
                } else {
                    // 3. Try raw JSON fallback
                    const jsonMatch = fullText.match(/({[\s\S]*"name"[\s\S]*})/);
                    if (jsonMatch) {
                        jsonStr = jsonMatch[1];
                    }
                }
            }
            
            // Shorthand fallback
            const shorthandMatch = fullText.match(/:::scroll_to_log\((\d+)\):::/);

            if (jsonStr) {
                try {
                    jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
                    let toolCall;
                    
                    if (toolNameFromTag) {
                        // If we got name from tag, the JSON is likely just the args
                        const parsed = JSON.parse(jsonStr);
                        // Sometimes model puts name in JSON too despite the tag, check for that
                        if (parsed.name && !parsed.args && parsed.name === toolNameFromTag) {
                             toolCall = parsed; // It was full tool object
                        } else if (parsed.name && parsed.args) {
                             toolCall = parsed; // It was full tool object, ignore tag mismatch if any
                        } else {
                             // It was just args
                             toolCall = { name: toolNameFromTag, args: parsed };
                        }
                    } else {
                        toolCall = JSON.parse(jsonStr);
                    }

                    // Defaults for specific tools
                    if (toolCall.name === 'update_filters') {
                        toolCall.args.log_levels = toolCall.args.log_levels || [];
                        toolCall.args.daemons = toolCall.args.daemons || [];
                        toolCall.args.search_keywords = toolCall.args.search_keywords || [];
                        
                        // Check if this is a suggestion vs command
                        if (!toolCall.args.apply_immediately) {
                            const labels = [];
                            if (toolCall.args.log_levels?.length) labels.push(toolCall.args.log_levels.join('|'));
                            if (toolCall.args.daemons?.length) labels.push(toolCall.args.daemons.join('|'));
                            if (toolCall.args.search_keywords?.length) labels.push(`"${toolCall.args.search_keywords.join(' ')}"`);

                            pendingFilterAction = {
                                type: 'apply_filter',
                                label: labels.length > 0 ? `Filter: ${labels.join(', ')}` : 'Apply Suggested Filters',
                                payload: {
                                    selectedLevels: toolCall.args.log_levels,
                                    selectedDaemons: toolCall.args.daemons,
                                    keywordQueries: toolCall.args.search_keywords,
                                    keywordMatchMode: toolCall.args.keyword_match_mode || 'OR',
                                }
                            };
                        }
                    }
                    if (toolCall.name === 'search_logs') {
                        toolCall.args.keywords = toolCall.args.keywords || [];
                        pendingFilterAction = {
                            type: 'apply_filter',
                            label: 'Apply Search Filters',
                            payload: {
                                keywordQueries: toolCall.args.keywords,
                                keywordMatchMode: toolCall.args.match_mode || 'OR'
                            }
                        };
                    }

                    // Update the message with the action AND clean up any leaked tool text
                    const cleanOutput = fullText.replace(/<<<.*?>>>[\s\S]*?<<<END>>>?/g, '').trim();
                    setMessages(prev => prev.map(m => m.id === messageId ? { 
                        ...m, 
                        text: cleanOutput,
                        action: pendingFilterAction || undefined 
                    } : m));

                    history.push({ role: 'assistant', content: fullText }); 

                    if (isCancelledRef.current) break;

                    const result = await handleToolCall(toolCall.name, toolCall.args);
                    const resultStr = JSON.stringify(result);
                    
                    if (isCancelledRef.current) break;

                    history.push({ role: 'user', content: `Tool Output: ${resultStr}` });
                    continue; // Loop for next turn

                } catch (e) {
                    console.error("Local Tool Parse Error", e);
                    break;
                }
            } else if (shorthandMatch) {
                const logId = parseInt(shorthandMatch[1], 10);
                history.push({ role: 'assistant', content: fullText });
                if (isCancelledRef.current) break;
                const result = await handleToolCall('scroll_to_log', { log_id: logId });
                if (isCancelledRef.current) break;
                history.push({ role: 'user', content: `Tool Output: ${JSON.stringify(result)}` });
                continue;
            } else {
                // Final answer turn
                const cleanOutput = fullText
                    .replace(/<<<[\w_]*>>>[\s\S]*?(<<<END>>>|$)/g, '')
                    .replace(/<<<TOOL>>>[\s\S]*?(<<<END>>>|$)/g, '')
                    .trim();
                const finalText = cleanOutput || "I have analyzed the logs and summarized the findings above.";
                
                if (!hasAddedMessage) {
                    setMessages(prev => [...prev, { 
                        id: messageId, 
                        role: 'model', 
                        text: finalText, 
                        action: pendingFilterAction || undefined 
                    }]);
                } else {
                    setMessages(prev => prev.map(m => m.id === messageId ? { 
                        ...m, 
                        text: finalText, 
                        action: pendingFilterAction || undefined 
                    } : m));
                }
                break;
            }
        }
    } catch (e: any) {
        if (!isCancelledRef.current) {
            console.error("Local AI Execution Error:", e);
            addMessage('model', `Local AI Error: ${e.message}`, true);
        }
    } finally {
        if (!isCancelledRef.current) {
            setIsLoading(false);
        }
    }
  }, [messages, allLogs, allDaemons, addMessage, handleToolCall]);

  const loadWebLlm = useCallback(async (modelIdToLoad?: string, promptToRun?: string) => {
    const targetModelId = modelIdToLoad || selectedLocalModelId;
    const targetPrompt = promptToRun || pendingPromptRef.current;
    const modelMeta = AVAILABLE_LOCAL_MODELS.find(m => m.id === targetModelId) || AVAILABLE_LOCAL_MODELS[0];
    setIsLoading(true);
    setShowWebLlmConsent(false);
    try {
        addMessage('model', `Initializing local model (${modelMeta.name}). Downloading weights (${modelMeta.size}) to browser cache (stored locally for instant future loads)...`, false, true);
        
        const engine = await CreateMLCEngine(targetModelId, {
            initProgressCallback: (report) => {
                if (!isCancelledRef.current) {
                    setDownloadStatus({ text: report.text, progress: report.progress });
                }
            }
        });

        if (isCancelledRef.current) {
            return;
        }
        
        mlcEngine.current = engine;
        currentLoadedModelId.current = targetModelId;
        localStorage.setItem(WEBLMM_CONSENT_KEY, 'true');
        addMessage('model', `Local model (${modelMeta.name}) ready! Processing your query...`);
        setDownloadStatus(null);
        
        if (targetPrompt && !isCancelledRef.current) {
            pendingPromptRef.current = null;
            setPendingPrompt(null);
            executeLocalAI(targetPrompt);
        } else {
            setIsLoading(false);
        }
    } catch (e: any) {
        if (isCancelledRef.current) return;
        console.error("WebLLM Load Error:", e);
        addMessage('model', `Failed to load local model: ${e.message}`, true);
        setIsLoading(false);
        setDownloadStatus(null);
        pendingPromptRef.current = null;
        setPendingPrompt(null);
    }
  }, [selectedLocalModelId, addMessage, executeLocalAI]);

  const runLocalAI = useCallback(async (prompt: string) => {
    if (mlcEngine.current && currentLoadedModelId.current === selectedLocalModelId) {
        executeLocalAI(prompt);
        return;
    }

    const hasConsented = localStorage.getItem(WEBLMM_CONSENT_KEY);
    pendingPromptRef.current = prompt;
    setPendingPrompt(prompt);
    
    if (hasConsented === 'true') {
        loadWebLlm(selectedLocalModelId, prompt);
    } else {
        setShowWebLlmConsent(true);
    }
  }, [selectedLocalModelId, executeLocalAI, loadWebLlm]);

  const handleConsent = (consented: boolean) => {
      setShowWebLlmConsent(false);
      if (consented) {
          loadWebLlm(selectedLocalModelId, pendingPromptRef.current || undefined);
      } else {
          pendingPromptRef.current = null;
          setPendingPrompt(null);
          setIsLoading(false);
          setModelTier('gemini-flash-latest'); // Fallback to default
          addMessage('model', 'Switched back to Balanced mode (Gemini Flash).');
      }
  };
  
  const runChromeBuiltInAI = useCallback(async (prompt: string) => {
    const lmObj = getChromePromptApi();
    if (!lmObj) {
        addMessage('model', 
            `**Chrome Built-in AI (Gemini Nano) was not detected in this browser session.**
            
### Status & How to Enable Gemini Nano:
- **Availability:** Integrated Gemini Nano is shipping across Chrome via the **Prompt API** (\`LanguageModel\` or \`ai.languageModel\`).
- **Steps to enable on desktop Chrome:**
  1. Open a new tab to \`chrome://flags\`
  2. Set **Prompt API for Gemini Nano** to \`Enabled\`
  3. Set **Optimization Guide On Device Model** to \`Enabled BypassPerfRequirement\`
  4. Relaunch Chrome.
  5. Go to \`chrome://components\` and click **Check for update** next to *Optimization Guide On Device Model* to ensure the ~1.5 GB model weights are downloaded.
- **Tip:** In the meantime, you can use the **Local (WebLLM)** option directly in this app, which runs locally in any WebGPU-capable browser without special Chrome flags!`, 
            true
        );
        setIsLoading(false);
        return;
    }

    try {
        const check = await checkChromePromptApiAvailability(lmObj);
        if (!check.available) {
             addMessage('model', `**Chrome AI reported status:** \`${check.status}\` (${check.reason || 'Not ready'}). Please check \`chrome://components\` for *Optimization Guide On Device Model* to verify download status.`, true);
             setIsLoading(false);
             return;
        }

        setIsChromeModelAvailable(true);
        if (isCancelledRef.current) return;

        if (!chromeAiSession.current) {
            console.log('[AI] Creating new Chrome AI session via Prompt API.');
            const systemPrompt = `You are a helpful AI assistant embedded in a log analysis tool. Analyze the provided information and answer the user's questions concisely. You do not have tools to search or filter logs.
# CONTEXT
- Total logs across all files: ${allLogs.length.toLocaleString()}
- Available Daemons: ${allDaemons.join(', ') || 'N/A'}`;
            
            const signal = abortControllerRef.current?.signal;
            let session: any = null;

            // Try Prompt API session creation options (compatible with both W3C LanguageModel standard and experimental ai.languageModel)
            try {
                session = await lmObj.create({
                    initialPrompts: [{ role: 'system', content: systemPrompt }],
                    systemPrompt,
                    signal
                });
            } catch (e1) {
                try {
                    session = await lmObj.create({
                        systemPrompt,
                        signal
                    });
                } catch (e2) {
                    try {
                        session = await lmObj.create({
                            initialPrompts: [{ role: 'system', content: systemPrompt }],
                            signal
                        });
                    } catch (e3) {
                        session = await lmObj.create({ signal });
                    }
                }
            }

            chromeAiSession.current = session;
        }
        
        if (isCancelledRef.current) return;

        const payloadSize = prompt.length;
        console.groupCollapsed(`[AI] Calling Chrome Built-in AI with ~${(payloadSize / 4).toFixed(0)} tokens`);
        console.log('[AI] Prompt:', prompt);
        console.groupEnd();

        const response = await chromeAiSession.current.prompt(prompt, {
            signal: abortControllerRef.current?.signal
        });
        
        if (isCancelledRef.current) return;

        const responseText = typeof response === 'string' ? response : (response ? String(response) : 'No response returned from model.');
        const responseSize = responseText.length;
        console.groupCollapsed(`[AI] Received response from Chrome AI with ~${(responseSize / 4).toFixed(0)} tokens`);
        console.log('[AI] Response:', responseText);
        console.groupEnd();
        
        addMessage('model', responseText);
    } catch (e: any) {
        if (isCancelledRef.current || e.name === 'AbortError') return;
        console.error("Chrome AI Error:", e);
        addMessage('model', `An error occurred with Chrome Built-in AI: ${e.message}`, true);
        if (chromeAiSession.current) {
            try { chromeAiSession.current.destroy?.(); } catch {}
            chromeAiSession.current = null;
        }
    } finally {
        if (!isCancelledRef.current) {
            setIsLoading(false);
        }
    }
  }, [addMessage, allLogs, allDaemons]);

  const getEffectiveModelTierAndRun = useCallback((prompt: string) => {
    if (modelTier === 'chrome-built-in') {
        runChromeBuiltInAI(prompt);
        return;
    }
    if (modelTier === 'web-llm') {
        runLocalAI(prompt);
        return;
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Clean up old timestamps
    Object.keys(apiRequestTimestampsRef.current).forEach(model => {
        apiRequestTimestampsRef.current[model] = apiRequestTimestampsRef.current[model].filter(ts => ts > oneMinuteAgo);
    });

    const getRequestCount = (model: string) => apiRequestTimestampsRef.current[model]?.length || 0;
    
    let effectiveModel = modelTier;
    let fallbackMessage = '';

    const tiers: (keyof typeof MODEL_CONFIG)[] = ['gemini-pro-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
    const currentTierIndex = tiers.indexOf(modelTier as any);

    if (currentTierIndex !== -1) {
        for (let i = currentTierIndex; i < tiers.length; i++) {
            const tier = tiers[i];
            const limit = MODEL_CONFIG[tier].rpm;
            const count = getRequestCount(tier);
            
            console.log(`[Rate Governor] Checking ${tier}: ${count} requests / ${limit} RPM limit.`);

            if (count < limit) {
                effectiveModel = tier;
                if (tier !== modelTier) {
                    fallbackMessage = `**Notice:** The '${MODEL_CONFIG[modelTier as keyof typeof MODEL_CONFIG].name}' model is busy. Using '${MODEL_CONFIG[effectiveModel as keyof typeof MODEL_CONFIG].name}' for this request.`;
                }
                break;
            }
            if (i === tiers.length - 1) { // Last tier is also busy
                addMessage('model', "All AI models are currently busy due to rate limits. Please wait a moment before trying again.", true);
                setIsLoading(false);
                return;
            }
        }
    }

    if (fallbackMessage) {
        addMessage('model', fallbackMessage, false, true);
    }
    
    // Log the request
    if (!apiRequestTimestampsRef.current[effectiveModel]) {
        apiRequestTimestampsRef.current[effectiveModel] = [];
    }
    apiRequestTimestampsRef.current[effectiveModel].push(now);

    runCloudAI(prompt, effectiveModel);
  }, [modelTier, addMessage, runChromeBuiltInAI, runLocalAI, runCloudAI]);

  // SMART LOCAL SEARCH WITH PATTERN GROUPING AND OPTIMIZATION
  const enhancePromptWithLocalContext = useCallback(async (prompt: string): Promise<string> => {
      const stopWords = new Set([
        'a', 'an', 'the', 'is', 'are', 'what', 'show', 'me', 'find', 'list', 'of', 'in', 'for', 'all', 'with', 'and', 'or', 'about', 
        'when', 'did', 'started', 'start', 'to', 'do', 'does', 'why', 'how', 'where', 'can', 'you', 'i', 'my', 'please', 'logs', 'log'
      ]);
      const extractedKeywords = prompt.toLowerCase()
          // Retain word chars, whitespace, dots, hyphens (e.g. 192.168.1.1, my-daemon)
          .replace(/[^\w\s\.-]/g, '') 
          .split(/\s+/)
          .filter(word => !stopWords.has(word) && word.length > 2);
      
      // If we have no significant keywords or no logs, skip optimization
      if (extractedKeywords.length === 0 || allLogs.length === 0) {
          return prompt;
      }

      // --- Filter by Index (Structural Search) ---
      let candidateIndices: number[] | null = null;
      const structuralKeywords = new Set<string>();
      const levelKeys = Object.keys(logIndex.levels);

      // Helper to find intersection of sorted arrays (indices are naturally sorted in logIndex)
      const intersectSorted = (a: number[], b: number[]) => {
          const res = [];
          let i = 0, j = 0;
          while (i < a.length && j < b.length) {
              if (a[i] < b[j]) i++;
              else if (a[i] > b[j]) j++;
              else {
                  res.push(a[i]);
                  i++; j++;
              }
          }
          return res;
      };

      for (const kw of extractedKeywords) {
          // Check for Level match (e.g. "error", "warnings")
          const levelMatch = levelKeys.find(k => k.toLowerCase() === kw || k.toLowerCase() + 's' === kw);
          if (levelMatch) {
              structuralKeywords.add(kw);
              const indices = logIndex.levels[levelMatch];
              candidateIndices = candidateIndices ? intersectSorted(candidateIndices, indices) : indices;
              continue;
          }
          // Check for Daemon match
          if (logIndex.daemons[kw]) {
              structuralKeywords.add(kw);
              const indices = logIndex.daemons[kw];
              candidateIndices = candidateIndices ? intersectSorted(candidateIndices, indices) : indices;
              continue;
          }
      }

      // If we found structural matches but they intersected to zero, no logs match.
      if (candidateIndices !== null && candidateIndices.length === 0) {
          return prompt;
      }

      const contentKeywords = extractedKeywords.filter(k => !structuralKeywords.has(k));
      const hasLevelKeyword = extractedKeywords.some(kw => Object.keys(logIndex.levels).some(l => l.toLowerCase() === kw));
      
      // --- Timestamp Optimization (Binary Search) ---
      let startLogIdx = 0;
      let endLogIdx = allLogs.length;

      const dateMatch = prompt.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (dateMatch) {
          const d = new Date(dateMatch[1]);
          if (!isNaN(d.getTime())) {
             startLogIdx = findLogStartIndex(allLogs, d.getTime());
             const nextDay = new Date(d);
             nextDay.setDate(nextDay.getDate() + 1);
             endLogIdx = findLogStartIndex(allLogs, nextDay.getTime());
          }
      }

      // Determine scan boundaries
      // If we have structural indices, we intersect them with the time range.
      // If not, we just scan the time range.
      let loopStart = 0;
      let loopEnd = 0;
      let useCandidates = false;

      if (candidateIndices) {
           useCandidates = true;
           // Filter sorted candidate indices to be within [startLogIdx, endLogIdx)
           // We use binary search on the indices array itself to find the subset quickly.
           loopStart = lowerBound(candidateIndices, startLogIdx);
           loopEnd = lowerBound(candidateIndices, endLogIdx);
      } else {
           loopStart = startLogIdx;
           loopEnd = endLogIdx;
      }
      
      const scanCount = loopEnd - loopStart;
      const shouldScan = (scanCount > 0) && (contentKeywords.length > 0 || useCandidates || startLogIdx > 0 || endLogIdx < allLogs.length);
      
      if (!shouldScan) {
           return prompt;
      }

      // Combined Scanning and Grouping Loop
      const groupedLogs = new Map<string, { 
          pattern: string; 
          level: LogLevel; 
          daemon: string; 
          count: number; 
          score: number; 
          examples: number[] 
      }>();
      
      let matchCount = 0;
      const CHUNK_SIZE = 5000; 

      // Pre-calculate keyword types for weighting inside the hot loop
      const keywordWeights = contentKeywords.map(kw => {
          let weight = 1; // Base score
          // If keyword matches a known daemon name (but wasn't used as a hard filter), boost it
          if (logIndex.daemons[kw]) weight = 3; 
          return { kw, weight };
      });

      for (let i = loopStart; i < loopEnd; i += CHUNK_SIZE) {
          const chunkEnd = Math.min(i + CHUNK_SIZE, loopEnd);
          
          for (let j = i; j < chunkEnd; j++) {
              const idx = useCandidates && candidateIndices ? candidateIndices[j] : j;
              const log = allLogs[idx];
              let score = 0;
              
              if (contentKeywords.length > 0) {
                  const msgLower = log.message.toLowerCase();
                  const daemonLower = log.daemon.toLowerCase();
                  
                  for (const { kw, weight } of keywordWeights) {
                      if (msgLower.includes(kw) || daemonLower.includes(kw) || log.level.toLowerCase().includes(kw)) {
                          score += weight;
                      }
                  }
              } else {
                  // No content keywords, but matched structural filter (e.g. "show errors")
                  score = 1; 
              }

              // Severity Boost: If user didn't explicitly ask for a specific level, boost errors/criticals
              // This ensures "what's wrong?" bubbles up errors even if query is neutral.
              if (score > 0 && !hasLevelKeyword) {
                  if (log.level === LogLevel.ERROR || log.level === LogLevel.CRITICAL) score += 0.5;
                  else if (log.level === LogLevel.WARNING) score += 0.1;
              }
              
              if (score > 0) {
                  matchCount++;
                  const pattern = getLogPattern(log.message);
                  // Key by Pattern + Daemon + Level to differentiate similar messages from different sources
                  const key = `${log.level}|${log.daemon}|${pattern}`;
                  
                  if (!groupedLogs.has(key)) {
                      groupedLogs.set(key, {
                          pattern,
                          level: log.level,
                          daemon: log.daemon,
                          count: 0,
                          score: 0,
                          examples: []
                      });
                  }
                  
                  const group = groupedLogs.get(key)!;
                  group.count++;
                  group.score = Math.max(group.score, score);
                  
                  if (group.examples.length < 3) {
                      group.examples.push(log.id);
                  }
              }
          }
          // Yield to event loop if processing a large set
          if (scanCount > CHUNK_SIZE) await new Promise(r => setTimeout(r, 0));
      }

      if (matchCount === 0) {
           return prompt;
      }

      // Sort groups by Relevance first, then heavily bias towards RARITY.
      // High frequency logs are usually noise. Low frequency logs are usually interesting.
      const groupsArray = Array.from(groupedLogs.values());
      
      // Apply Rarity Boost
      groupsArray.forEach(g => {
          if (g.count === 1) g.score += 3.0;
          else if (g.count < 5) g.score += 2.0;
          else if (g.count < 20) g.score += 1.0;
          else if (g.count > 1000) g.score -= 1.0; // Penalty for spam
      });

      const sortedGroups = groupsArray.sort((a, b) => {
          // Strict score sorting (which now includes rarity bias)
          return b.score - a.score;
      });

      // Select top groups to fit in context (increased from 20 to 30 to include more variety)
      const topGroups = sortedGroups.slice(0, 30);
      
      const contextData = topGroups.map(g => 
          `[Count: ${g.count}] [${g.level}] [${g.daemon}] Pattern: "${g.pattern}" (Example IDs: ${g.examples.map(id => `[Log ID: ${id}]`).join(', ')})`
      ).join('\n');

      const systemNote = `
[SYSTEM CONTEXT - LOCAL SEARCH RESULTS]
The user's query matched ${matchCount} local logs. Here are the most relevant log groups found, prioritized by relevance and uniqueness (rarity):

${contextData}

[INSTRUCTION]
Use the data above to answer the user's question directly. 
- Do NOT explicitly mention "I found log patterns" or "local search results" unless the user asks how you know.
- Use the "Example IDs" to provide citations (e.g. [Log ID: 123]).
- If this data is sufficient, answer the question. If not, use tools like 'search_logs' for a broader search.
`;
      
      return `${systemNote}\n\nUser Question: "${prompt}"`;
  }, [allLogs, addMessage, logIndex]);

  const handleSubmit = useCallback(async (e?: React.FormEvent, overridePrompt?: string) => {
    e?.preventDefault();
    const trimmedInput = overridePrompt || input.trim();
    if (!trimmedInput) return;

    if (isLoading) {
      handleCancelRequest();
    }

    // Check for quick memorization / pin commands
    const isPinCommand = /^\/(pin|save|learn|memorize)(\s|$)/i.test(trimmedInput) || 
      /^(pin|save|memorize|remember)\s+(this|finding|it|latest)/i.test(trimmedInput) ||
      /^(save this|pin this|remember this|memorize this)$/i.test(trimmedInput);

    if (isPinCommand) {
      const lastModelMessage = [...messages].reverse().find(m => 
        m.role === 'model' && 
        !m.isError && 
        !m.isWarning && 
        m.id !== 'welcome' && 
        m.text.trim().length > 30 &&
        !m.text.startsWith('Initializing local model') &&
        !m.text.startsWith('Local model') &&
        !m.text.startsWith('📌')
      );
      addMessage('user', trimmedInput);
      if (lastModelMessage) {
        onSaveFinding(lastModelMessage.text);
        addMessage('model', '📌 Pinned the latest finding to your Summary Dashboard.');
      } else {
        addMessage('model', 'No previous analytical finding found to pin. Run an analysis first, then click the bookmark icon or type /pin.');
      }
      setInput('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.overflowY = 'hidden';
      }
      return;
    }

    isCancelledRef.current = false;
    abortControllerRef.current = new AbortController();

    addMessage('user', trimmedInput);
    setIsLoading(true);
    conversationStateRef.current = 'IDLE'; // Reset state for new prompt

    // Perform smart local context enhancement unless disabled
    let enhancedPrompt = trimmedInput;
    if (!disableLocalSearch) {
        enhancedPrompt = await enhancePromptWithLocalContext(trimmedInput);
    } else {
        console.log('[AI] Local search optimization disabled by user. Sending raw prompt.');
    }
    
    if (isCancelledRef.current) return;

    getEffectiveModelTierAndRun(enhancedPrompt);

    setInput('');
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.overflowY = 'hidden';
    }
  }, [input, isLoading, addMessage, getEffectiveModelTierAndRun, enhancePromptWithLocalContext, disableLocalSearch, handleCancelRequest]);

  const handleQuickAction = (prompt: string) => {
    setInput(prompt);
    // Use a timeout to ensure the state updates before submitting
    setTimeout(() => {
        handleSubmit(undefined, prompt);
    }, 50);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const textarea = e.currentTarget;
      textarea.style.height = 'auto'; // Reset height to recalculate based on content
      const scrollHeight = textarea.scrollHeight;
      const maxHeight = 200; // Approx 8-9 lines

      if (scrollHeight > maxHeight) {
          textarea.style.height = `${maxHeight}px`;
          textarea.style.overflowY = 'auto';
      } else {
          textarea.style.height = `${scrollHeight}px`;
          textarea.style.overflowY = 'hidden';
      }
  };
  
  return (
    <div className="h-full flex flex-col bg-gray-800 relative">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between p-2 border-b border-gray-700 space-x-2">
          <div className="flex items-center space-x-1.5 flex-grow min-w-0">
            <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
            <select 
              value={modelTier} 
              onChange={e => {
                const newTier = e.target.value;
                setModelTier(newTier);
                if (newTier === 'chrome-built-in') {
                  const lm = getChromePromptApi();
                  if (lm) {
                    checkChromePromptApiAvailability(lm).then(check => {
                      if (check.available) setIsChromeModelAvailable(true);
                    }).catch(() => {});
                  }
                }
              }} 
              className="bg-gray-700 text-white text-xs rounded py-1 px-2 border border-gray-600 focus:ring-1 focus:ring-blue-500 focus:outline-none flex-grow min-w-0"
              title="Select AI Model"
            >
                <option value="gemini-flash-lite-latest">Fast</option>
                <option value="gemini-flash-latest">Balanced</option>
                <option value="gemini-pro-latest">Reasoning</option>
                <option value="chrome-built-in">Local (Chrome){isChromeModelAvailable ? ' (Ready)' : ''}</option>
                <option value="web-llm">Local (WebLLM)</option>
            </select>
          </div>
          <div className="flex items-center space-x-1 shrink-0">
            <button onClick={() => setIsSettingsOpen(!isSettingsOpen)} className="p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-700 cursor-pointer" title="Settings"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></button>
            <button onClick={() => setMessages([messages[0]])} className="p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-700 cursor-pointer" title="Reset Chat"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-700 cursor-pointer" aria-label="Close AI Assistant" title="Close AI Assistant"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg></button>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex-shrink-0 p-2 border-b border-gray-700 grid grid-cols-2 gap-2">
            <button onClick={() => handleQuickAction("Summarize the key events by searching the entire log file.")} disabled={isLoading} className="p-2 bg-gray-700/50 hover:bg-gray-700 rounded-md text-xs text-gray-300 transition-colors disabled:opacity-50">Summarize View</button>
            <button onClick={() => handleQuickAction("Find all errors in the logs and summarize them.")} disabled={isLoading} className="p-2 bg-gray-700/50 hover:bg-gray-700 rounded-md text-xs text-gray-300 transition-colors disabled:opacity-50">Analyze Errors</button>
            <button onClick={() => handleQuickAction("Find the most critical error and suggest a solution.")} disabled={isLoading} className="p-2 bg-gray-700/50 hover:bg-gray-700 rounded-md text-xs text-gray-300 transition-colors disabled:opacity-50">Suggest Solution</button>
            <button onClick={() => handleQuickAction("Explain your capabilities and provide examples of what I can ask.")} disabled={isLoading} className="p-2 bg-gray-700/50 hover:bg-gray-700 rounded-md text-xs text-gray-300 transition-colors disabled:opacity-50">Capabilities</button>
        </div>

        <div className="flex-grow p-3 overflow-y-auto space-y-4">
          {messages.map((message) => {
            return (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`relative max-w-[85%] p-2 rounded-lg text-white ${message.role === 'user' ? 'bg-blue-600' : (message.isError ? 'bg-red-800' : (message.isWarning ? 'bg-yellow-800/80' : 'bg-gray-700'))}`}>
                   <FormattedMessage text={message.text} onScrollToLog={onScrollToLog} />
                   

                   {message.action && (
                      <div className="mt-2 pt-2 border-t border-gray-600/50">
                          <button 
                              onClick={() => onUpdateFilters(message.action!.payload, true)}
                              className="flex items-center space-x-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded transition-colors w-full justify-center cursor-pointer"
                          >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"></path></svg>
                              <span>{message.action.label}</span>
                          </button>
                      </div>
                   )}

                   {message.isError && (
                      <div className="mt-2.5 pt-2 border-t border-red-700/60 flex flex-wrap gap-1.5">
                          <button
                              onClick={() => {
                                  if (lastPromptRef.current) {
                                      handleSubmit(undefined, lastPromptRef.current);
                                  }
                              }}
                              disabled={isLoading}
                              className="inline-flex items-center space-x-1 text-xs bg-red-900/90 hover:bg-red-700 text-white px-2 py-1 rounded transition-colors border border-red-500/50 cursor-pointer disabled:opacity-50"
                          >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                              <span>Retry Prompt</span>
                          </button>
                          <button
                              onClick={() => {
                                  setModelTier('gemini-flash-lite-latest');
                                  if (lastPromptRef.current) {
                                      setTimeout(() => handleSubmit(undefined, lastPromptRef.current!), 50);
                                  }
                              }}
                              disabled={isLoading}
                              className="inline-flex items-center space-x-1 text-xs bg-gray-800 hover:bg-gray-700 text-white px-2 py-1 rounded transition-colors border border-gray-600 cursor-pointer disabled:opacity-50"
                          >
                              <svg className="w-3 h-3 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                              <span>Switch to Fast Mode</span>
                          </button>
                          <button
                              onClick={() => setIsSettingsOpen(true)}
                              className="inline-flex items-center space-x-1 text-xs bg-gray-800 hover:bg-gray-700 text-white px-2 py-1 rounded transition-colors border border-gray-600 cursor-pointer"
                          >
                              <svg className="w-3 h-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
                              <span>Settings</span>
                          </button>
                      </div>
                   )}
                </div>
              </div>
            );
          })}
          {isLoading && (
            <div className="flex justify-start">
                <div className="max-w-[85%] p-2 rounded-lg bg-gray-700 text-white min-w-[100px] space-y-1.5 border border-gray-600/60 shadow-sm">
                    <div className="flex items-center space-x-1.5 text-xs">
                        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" style={{ animationDelay: '0s' }}></div>
                        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></div>
                        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></div>
                        <span className="text-[11px] text-gray-300 pl-1 font-medium">Analyzing...</span>
                    </div>
                    {downloadStatus && (
                         <div className="w-full">
                             <div className="text-[10px] text-gray-300 mb-1 truncate">{downloadStatus.text}</div>
                             <div className="w-full bg-gray-600 rounded-full h-1.5">
                                <div 
                                    className="bg-blue-500 h-1.5 rounded-full transition-all duration-300 ease-out" 
                                    style={{ width: `${Math.round(downloadStatus.progress * 100)}%` }}
                                ></div>
                             </div>
                         </div>
                    )}
                </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        <div className="flex-shrink-0 p-2 border-t border-gray-700 bg-gray-800">
            <form onSubmit={handleSubmit} className="flex items-center space-x-2">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={e => { 
                  if (e.key === 'Escape' && isLoading) {
                    e.preventDefault();
                    handleCancelRequest();
                  } else if (e.key === 'Enter' && !e.shiftKey) { 
                    e.preventDefault(); 
                    handleSubmit(e); 
                  }
                }}
                placeholder={isLoading ? "Analyzing... Type your next prompt or click Cancel" : "Ask about your logs..."}
                rows={1}
                className="flex-grow bg-gray-700 border border-gray-600 text-white text-xs rounded-md shadow-sm p-2 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none overflow-hidden placeholder-gray-400"
              />
              {isLoading ? (
                <button
                  type="button"
                  onClick={handleCancelRequest}
                  className="bg-red-600 text-white p-2 rounded-md hover:bg-red-700 transition-colors flex items-center justify-center shrink-0"
                  aria-label="Cancel current request"
                  title="Cancel request (Esc)"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="bg-blue-600 text-white p-2 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed shrink-0"
                  aria-label="Send message"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>
                </button>
              )}
            </form>
        </div>

        {isSettingsOpen && (
            <div className="absolute inset-0 bg-black/60 z-10 flex items-center justify-center p-4">
                <div className="bg-gray-900 rounded-lg shadow-xl p-4 border border-gray-700 w-full max-w-sm space-y-4">
                    <div>
                        <h3 className="font-semibold text-gray-200 mb-2">API Key Settings</h3>
                        <label htmlFor="api-key-input" className="text-xs text-gray-400 block mb-1">Google AI API Key (Optional)</label>
                        <input id="api-key-input" type="password" value={tempApiKey} onChange={(e) => setTempApiKey(e.target.value)} placeholder="Enter key to override system default" className="w-full bg-gray-700 text-white rounded py-1 px-2 border border-gray-600 focus:ring-1 focus:ring-blue-500 focus:outline-none text-xs"/>
                        <p className="text-[10px] text-gray-500 mt-1">Get a key from <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">Google AI Studio</a>. Your key is stored in your browser's local storage.</p>
                    </div>

                    <div className="pt-2 border-t border-gray-700">
                        <h3 className="font-semibold text-gray-200 mb-1">Local WebLLM Model</h3>
                        <p className="text-[10px] text-gray-400 mb-2">Choose which model to run on your local device with WebGPU:</p>
                        <select 
                            value={tempLocalModelId} 
                            onChange={(e) => setTempLocalModelId(e.target.value)}
                            className="w-full bg-gray-700 text-white text-xs rounded py-1.5 px-2 border border-gray-600 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        >
                            {AVAILABLE_LOCAL_MODELS.map(m => (
                                <option key={m.id} value={m.id}>
                                    {m.name}
                                </option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-400 mt-1.5 leading-tight">
                            {AVAILABLE_LOCAL_MODELS.find(m => m.id === tempLocalModelId)?.desc}
                        </p>
                    </div>

                    <div className="pt-2 border-t border-gray-700">
                        <h3 className="font-semibold text-gray-200 mb-2">Performance Settings</h3>
                        <label className="flex items-start space-x-2 cursor-pointer">
                            <input 
                                type="checkbox" 
                                checked={tempDisableLocalSearch} 
                                onChange={(e) => setTempDisableLocalSearch(e.target.checked)} 
                                className="mt-0.5 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500"
                            />
                            <div>
                                <span className="text-xs text-gray-300 font-medium">Disable Local Search Pre-processing</span>
                                <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">
                                    Skip the pre-processing step that scans logs locally. The AI will receive your raw prompt and use tools to search if needed. Useful for benchmarking or reducing local CPU usage.
                                </p>
                            </div>
                        </label>
                    </div>

                    <div className="flex justify-end space-x-2">
                        <button onClick={() => setIsSettingsOpen(false)} className="bg-gray-600 text-white px-3 py-1 rounded text-xs hover:bg-gray-700">Cancel</button>
                        <button onClick={handleSaveSettings} className="bg-blue-600 text-white px-3 py-1 rounded text-xs hover:bg-blue-700">Save</button>
                    </div>
                </div>
            </div>
        )}

        {showWebLlmConsent && (
            <div className="absolute inset-0 bg-black/80 z-20 flex items-center justify-center p-4">
                <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full border border-gray-700 text-center">
                    <h3 className="text-xl font-bold text-white mb-2">Download Local AI Model?</h3>
                    <p className="text-sm text-gray-300 mb-4">
                        To run the AI locally on your device with complete privacy, we will download the <strong>{AVAILABLE_LOCAL_MODELS.find(m => m.id === selectedLocalModelId)?.name || 'selected model'}</strong> weights ({AVAILABLE_LOCAL_MODELS.find(m => m.id === selectedLocalModelId)?.size || '~2.2 GB'}). 
                        This happens once and is cached in your browser for fast on-device inference.
                    </p>
                    <div className="flex justify-center space-x-4">
                        <button 
                            onClick={() => handleConsent(false)}
                            className="px-4 py-2 rounded bg-gray-600 hover:bg-gray-500 text-white text-sm cursor-pointer"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={() => handleConsent(true)}
                            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium cursor-pointer"
                        >
                            Download & Run
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};
