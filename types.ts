
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  NOTICE = 'NOTICE',
  VERBOSE = 'VERBOSE',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
  UNKNOWN = 'UNKNOWN',
}

export interface LogEntry {
  id: number;
  timestamp: Date;
  hostname: string;
  daemon: string;
  pid: number;
  level: LogLevel;
  module: string;
  message: string;
  functionName: string;
}

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  logs: LogEntry[];
}

export interface FilterState {
  selectedLevels: LogLevel[];
  selectedDaemons: string[];
  selectedModules: string[];
  selectedFunctionNames: string[];
  dateRange: [Date | null, Date | null];
  keywordQueries: string[];
  keywordMatchMode: 'AND' | 'OR';
  enableKeywordHighlight: boolean;
  deviceId: string;
}

export interface LogTab {
  id: number;
  name: string;
  filters: FilterState;
  fixedFilters?: FilterState;
  currentPage?: number;
  scrollTop?: number;
  // View State Persistence
  viewMode: 'data' | 'summary';
  logsPerPage: number;
  searchQuery: string;
  searchMatchCase: boolean;
  searchMatchWholeWord: boolean;
  searchUseRegex: boolean;
}


declare global {
  interface Window {
    Chart: any;
  }
}
