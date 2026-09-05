
import { LogEntry, LogLevel } from '../types.ts';

// FIX: Corrected TypeScript errors on lines 13 and 20 related to 'fractionalSecondDigits'.
// This property is not available in all versions of the TypeScript DOM library for Intl.DateTimeFormatOptions.
// Casting the options object to 'any' allows for its use while maintaining a fallback for older environments.
export const formatTimestamp = (date: Date, timezone: string): string => {
  const optionsWithMS: any = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false,
  };

  if (timezone === 'UTC') {
      return date.toISOString().replace('T', ' ').substring(0, 23);
  }
  
  if (timezone !== 'local') {
      try {
          // Validate the timezone before using it
          new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
          optionsWithMS.timeZone = timezone;
      } catch (e) {
          // Invalid timezone provided, will fall back to browser's local time
      }
  }

  // 'local' or an invalid timezone will use the browser's default timezone
  try {
      // Using 'sv-SE' (Swedish) locale gives a clean, space-separated YYYY-MM-DD HH:MM:SS format
      return new Intl.DateTimeFormat('sv-SE', optionsWithMS).format(date);
  } catch (e) {
      // Provide a fallback for older browsers that may not support fractionalSecondDigits
      delete optionsWithMS.fractionalSecondDigits;
      const baseFormat = new Intl.DateTimeFormat('sv-SE', optionsWithMS).format(date);
      const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
      return `${baseFormat}.${milliseconds}`;
  }
};

export const formatDuration = (ms: number): string => {
  if (ms < 0) return '0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ${Math.round(seconds % 60)}s`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ${Math.round(minutes % 60)}m`;
  const days = hours / 24;
  return `${Math.floor(days)}d ${Math.round(hours % 24)}h`;
};

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const convertToCsv = (data: LogEntry[], timezone: string): string => {
  const headers = ['timestamp', 'level', 'hostname', 'daemon', 'pid', 'module', 'functionName', 'message'];
  const rows = data.map(log => {
    const row = [
      formatTimestamp(log.timestamp, timezone),
      log.level,
      log.hostname,
      log.daemon,
      log.pid,
      log.module,
      log.functionName,
      `"${log.message.replace(/"/g, '""')}"`, // Escape double quotes
    ];
    return row.join(',');
  });
  return [headers.join(','), ...rows].join('\n');
};

export const exportToCsv = (data: LogEntry[], timezone: string) => {
  const csvContent = convertToCsv(data, timezone);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `logs_${new Date().toISOString()}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const exportToTxt = (data: LogEntry[], timezone: string, visibleColumns: Record<string, boolean>) => {
    try {
        if (!data || data.length === 0) {
            alert("There are no logs to export in the current view.");
            return;
        }

        const lines = data.map(log => {
            const lineParts: string[] = [];

            // This should not fail if the parser guarantees a valid Date object
            lineParts.push(formatTimestamp(log.timestamp, timezone));

            if (visibleColumns.hostname && log.hostname) {
                lineParts.push(log.hostname);
            }

            let daemonAndPid = '';
            if (visibleColumns.daemon && log.daemon) {
                daemonAndPid += log.daemon;
            }
            if (visibleColumns.pid && typeof log.pid === 'number') {
                daemonAndPid += `[${log.pid}]`;
            }
            if (daemonAndPid) {
                lineParts.push(`${daemonAndPid}:`);
            }

            const metadata = [
                visibleColumns.level ? `[${log.level}]` : undefined,
                (visibleColumns.module && log.module && log.module !== 'unknown') ? `[${log.module}]` : undefined,
                (visibleColumns.functionName && log.functionName && log.functionName !== 'unknown') ? `(${log.functionName})` : undefined,
            ].filter(Boolean).join(' ');

            if (metadata) {
                lineParts.push(metadata);
            }

            if (visibleColumns.message && log.message) {
                lineParts.push(log.message);
            }
            
            return lineParts.join(' ');
        });

        const txtContent = lines.join('\n');

        const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `logs_${new Date().toISOString()}.txt`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url); // Clean up the object URL

    } catch (error) {
        console.error("Failed to export to TXT:", error);
        alert("An error occurred while exporting to TXT. Please check the console for details.");
    }
};

// Extracts searchable keywords from a boolean query string for highlighting.
export const extractKeywordsFromQuery = (query: string): string[] => {
    if (!query) return [];
    // Regex to capture quoted strings or words, ignoring operators
    const regex = /"(?:[^"\\]|\\.)*"|[^\s()&|!]+/g;
    const matches = query.match(regex) || [];
    
    return matches.map(m => {
        // Strip quotes if present
        if (m.startsWith('"') && m.endsWith('"')) {
            return m.slice(1, -1).replace(/\\"/g, '"');
        }
        return m;
    });
};

const precedence: { [key: string]: number } = { '||': 1, '&&': 2, '!': 3 };
const operators = ['&&', '||', '!'];

// Converts an infix boolean expression (from tokens) to postfix (RPN) using Shunting-yard algorithm.
const infixToPostfix = (tokens: string[]): string[] => {
    const outputQueue: string[] = [];
    const operatorStack: string[] = [];

    for (const token of tokens) {
        if (![...operators, '(', ')'].includes(token)) { // is operand
            outputQueue.push(token);
        } else if (operators.includes(token)) { // is operator
            const isLeftAssociative = token !== '!';
            const p1 = precedence[token];
            
            while (
                operatorStack.length > 0 &&
                operatorStack[operatorStack.length - 1] !== '('
            ) {
                const op2 = operatorStack[operatorStack.length - 1];
                const p2 = precedence[op2];

                if ((isLeftAssociative && p1 <= p2) || (!isLeftAssociative && p1 < p2)) {
                    outputQueue.push(operatorStack.pop()!);
                } else {
                    break;
                }
            }
            operatorStack.push(token);
        } else if (token === '(') {
            operatorStack.push(token);
        } else if (token === ')') {
            while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1] !== '(') {
                outputQueue.push(operatorStack.pop()!);
            }
            if (operatorStack[operatorStack.length - 1] === '(') {
                operatorStack.pop(); // Pop the '('
            }
        }
    }

    while (operatorStack.length > 0) {
        outputQueue.push(operatorStack.pop()!);
    }

    return outputQueue;
};

// Evaluates a postfix (RPN) expression against a log message.
const evaluatePostfix = (postfix: string[], message: string): boolean => {
    const stack: boolean[] = [];
    const lowerCaseMessage = message.toLowerCase();

    for (const token of postfix) {
        if (token === '&&') {
            if (stack.length < 2) return false;
            const b = stack.pop()!;
            const a = stack.pop()!;
            stack.push(a && b);
        } else if (token === '||') {
            if (stack.length < 2) return false;
            const b = stack.pop()!;
            const a = stack.pop()!;
            stack.push(a || b);
        } else if (token === '!') {
            if (stack.length < 1) return false;
            const a = stack.pop()!;
            stack.push(!a);
        } else { // is operand
            let searchTerm = token;
            // Handle quoted literals: strip quotes for comparison
            if (searchTerm.startsWith('"') && searchTerm.endsWith('"')) {
                searchTerm = searchTerm.slice(1, -1).replace(/\\"/g, '"');
            }
            stack.push(lowerCaseMessage.includes(searchTerm.toLowerCase()));
        }
    }

    return stack.length === 1 ? stack[0] : false;
};

// Main function to parse and evaluate a boolean keyword query against a message.
export const evaluateKeywordQuery = (query: string, message: string): boolean => {
    if (!query || query.trim() === '') {
        return true; // Empty query matches everything
    }

    try {
        // Advanced Tokenizer:
        // 1. Match double-quoted strings: "(?:[^"\\]|\\.)*"
        // 2. Match operators: &&, ||, !, (, )
        // 3. Match unquoted words/symbols: [^\s()&|!]+
        const regex = /"(?:[^"\\]|\\.)*"|&&|\|\||!|\(|\)|[^\s()&|!]+/g;
        const tokens = query.match(regex) || [];

        const hasOperands = tokens.some(t => ![...operators, '(', ')'].includes(t));
        if (!hasOperands) {
            return true;
        }
        
        const tokensWithImplicitAnd: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            tokensWithImplicitAnd.push(token);

            if (i < tokens.length - 1) {
                const nextToken = tokens[i + 1];

                const canPrecedeAnd = !['&&', '||', '(', '!'].includes(token);
                const canFollowAnd = !['&&', '||', ')'].includes(nextToken);
                
                if (canPrecedeAnd && canFollowAnd) {
                    tokensWithImplicitAnd.push('&&');
                }
            }
        }
        
        const postfix = infixToPostfix(tokensWithImplicitAnd);
        return evaluatePostfix(postfix, message);
    } catch (e) {
        console.error("Error evaluating keyword query:", e);
        return false; // On error, filter out the log to be safe.
    }
};
