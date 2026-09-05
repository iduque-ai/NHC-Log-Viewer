
import React from 'react';
import { LogEntry } from '../types.ts';
import { SummaryDashboard } from './SummaryDashboard.tsx';
import { LogTable } from './LogTable.tsx';

interface LogViewerProps {
    logs: LogEntry[];
    totalCount: number;
    selectedTimezone: string;
    totalDaemonCount: number;
    keywordQueries: string[];
    enableKeywordHighlight: boolean;
    onRowDoubleClick?: (log: LogEntry) => void;
    onKeywordClick?: (keyword: string) => void;
    scrollToLogId?: number | null;
    onScrollComplete?: () => void;
    currentPage: number;
    onPageChange: (page: number) => void;
    scrollTop?: number;
    onScrollChange?: (scrollTop: number) => void;
    // View State Props
    viewMode: 'data' | 'summary';
    onViewModeChange: (mode: 'data' | 'summary') => void;
    tabId: number;
    logsPerPage: number;
    onLogsPerPageChange: (n: number) => void;
    searchQuery: string;
    onSearchQueryChange: (s: string) => void;
    searchMatchCase: boolean;
    onSearchMatchCaseChange: (b: boolean) => void;
    searchMatchWholeWord: boolean;
    onSearchMatchWholeWordChange: (b: boolean) => void;
    searchUseRegex: boolean;
    onSearchUseRegexChange: (b: boolean) => void;
    savedFindings?: string[];
    onRemoveFinding?: (index: number) => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ 
    logs, 
    totalCount, 
    selectedTimezone, 
    totalDaemonCount, 
    keywordQueries, 
    enableKeywordHighlight, 
    onRowDoubleClick, 
    onKeywordClick,
    scrollToLogId,
    onScrollComplete,
    currentPage,
    onPageChange,
    scrollTop,
    onScrollChange,
    viewMode,
    onViewModeChange,
    tabId,
    logsPerPage,
    onLogsPerPageChange,
    searchQuery,
    onSearchQueryChange,
    searchMatchCase,
    onSearchMatchCaseChange,
    searchMatchWholeWord,
    onSearchMatchWholeWordChange,
    searchUseRegex,
    onSearchUseRegexChange,
    savedFindings,
    onRemoveFinding
}) => {
    
    return (
        <div className="flex flex-col h-full bg-gray-900">
            <div className="flex-shrink-0 border-b border-gray-700 bg-gray-800">
                <nav className="flex space-x-1 p-1" aria-label="Log Views">
                    <button
                        onClick={() => onViewModeChange('summary')}
                        className={`py-1 px-3 rounded-md text-xs font-medium transition-colors ${viewMode === 'summary' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-600'}`}
                        aria-current={viewMode === 'summary' ? 'page' : undefined}
                    >
                        Summary Statistics
                    </button>
                    <button
                        onClick={() => onViewModeChange('data')}
                        className={`py-1 px-3 rounded-md text-xs font-medium transition-colors ${viewMode === 'data' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-600'}`}
                        aria-current={viewMode === 'data' ? 'page' : undefined}
                    >
                        Log Data
                    </button>
                </nav>
            </div>
            {/* 
                LogTable handles its own scrolling internally to support sticky headers/footers and correct scrollIntoView behavior.
                SummaryDashboard needs the container to scroll.
            */}
            <div className={`flex-grow ${viewMode === 'summary' ? 'overflow-auto' : 'overflow-hidden'}`}>
               {viewMode === 'summary' 
                    ? <SummaryDashboard data={logs} savedFindings={savedFindings} onRemoveFinding={onRemoveFinding} />
                    : <LogTable 
                        data={logs} 
                        totalCount={totalCount} 
                        selectedTimezone={selectedTimezone} 
                        totalDaemonCount={totalDaemonCount}
                        keywordQueries={keywordQueries}
                        enableKeywordHighlight={enableKeywordHighlight}
                        onRowDoubleClick={onRowDoubleClick}
                        onKeywordClick={onKeywordClick}
                        scrollToLogId={scrollToLogId}
                        onScrollComplete={onScrollComplete}
                        currentPage={currentPage}
                        onPageChange={onPageChange}
                        scrollTop={scrollTop}
                        onScrollChange={onScrollChange}
                        tabId={tabId}
                        logsPerPage={logsPerPage}
                        onLogsPerPageChange={onLogsPerPageChange}
                        searchQuery={searchQuery}
                        onSearchQueryChange={onSearchQueryChange}
                        searchMatchCase={searchMatchCase}
                        onSearchMatchCaseChange={onSearchMatchCaseChange}
                        searchMatchWholeWord={searchMatchWholeWord}
                        onSearchMatchWholeWordChange={onSearchMatchWholeWordChange}
                        searchUseRegex={searchUseRegex}
                        onSearchUseRegexChange={onSearchUseRegexChange}
                      />
               }
            </div>
        </div>
    );
};
