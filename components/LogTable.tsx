
import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { LogEntry, LogLevel } from '../types.ts';
import { exportToCsv, exportToTxt, formatTimestamp, extractKeywordsFromQuery } from '../utils/helpers.ts';

interface LogTableProps {
  data: LogEntry[];
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
}

const levelColorMap: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'bg-gray-600 text-gray-100',
  [LogLevel.INFO]: 'bg-blue-600 text-blue-100',
  [LogLevel.NOTICE]: 'bg-sky-600 text-sky-100',
  [LogLevel.VERBOSE]: 'bg-teal-600 text-teal-100',
  [LogLevel.WARNING]: 'bg-yellow-600 text-yellow-100',
  [LogLevel.ERROR]: 'bg-red-600 text-red-100',
  [LogLevel.CRITICAL]: 'bg-purple-600 text-purple-100',
  [LogLevel.UNKNOWN]: 'bg-gray-400 text-gray-900',
};

const levelBorderMap: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'border-gray-600',
  [LogLevel.INFO]: 'border-blue-600',
  [LogLevel.NOTICE]: 'border-sky-600',
  [LogLevel.VERBOSE]: 'border-teal-600',
  [LogLevel.WARNING]: 'border-yellow-600',
  [LogLevel.ERROR]: 'border-red-600',
  [LogLevel.CRITICAL]: 'border-purple-600',
  [LogLevel.UNKNOWN]: 'border-gray-500',
};

const ALL_COLUMNS: (keyof Omit<LogEntry, 'id' | 'timestamp'>)[] = ['level', 'daemon', 'hostname', 'pid', 'module', 'message', 'functionName'];
const COLUMN_NAMES: Record<typeof ALL_COLUMNS[number], string> = {
    level: 'Level',
    daemon: 'Daemon',
    hostname: 'Hostname',
    pid: 'PID',
    module: 'Module',
    message: 'Message',
    functionName: 'Function Name',
};

// Map column keys to specific width classes to ensure alignment.
// Using max-w-[X] combined with w-[X] enforces fixed width and triggers truncation for overflow.
const COLUMN_WIDTHS: Record<string, string> = {
    timestamp: 'w-40 min-w-[10rem]',
    level: 'w-24',
    daemon: 'w-32 max-w-[8rem]',
    hostname: 'w-28 max-w-[7rem]',
    pid: 'w-16',
    module: 'w-32 max-w-[8rem]',
    functionName: 'w-32 max-w-[8rem]',
    message: 'w-auto'
};

const ColumnSelector: React.FC<{
    visibleColumns: Record<string, boolean>;
    setVisibleColumns: (cols: Record<string, boolean>) => void;
    totalDaemonCount: number;
}> = ({ visibleColumns, setVisibleColumns, totalDaemonCount }) => {
    const [isOpen, setIsOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const toggleColumn = (col: string) => {
        setVisibleColumns({ ...visibleColumns, [col]: !visibleColumns[col] });
    };

    return (
        <div className="relative" ref={wrapperRef}>
            <button onClick={() => setIsOpen(!isOpen)} className="bg-gray-700 text-white px-3 py-1 rounded-md hover:bg-gray-600 transition-colors text-xs">
                Columns
            </button>
            {isOpen && (
                <div className="absolute right-0 mt-1 w-48 bg-gray-800 border border-gray-600 rounded-md shadow-lg z-20">
                    <ul className="py-1">
                        {ALL_COLUMNS.map(col => {
                            // User request: Always allow selecting daemon column
                            return (
                                <li key={col} className="px-3 py-1 hover:bg-gray-700 cursor-pointer text-gray-300 text-xs">
                                    <label className="flex items-center space-x-2">
                                        <input
                                            type="checkbox"
                                            checked={!!visibleColumns[col]}
                                            onChange={() => toggleColumn(col)}
                                            className="h-3 w-3 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500"
                                        />
                                        <span>{COLUMN_NAMES[col]}</span>
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </div>
    );
};

export const LogTable: React.FC<LogTableProps> = ({ 
  data, 
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
  scrollTop = 0,
  onScrollChange,
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
  onSearchUseRegexChange
}) => {
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() => {
    const initialCols = ALL_COLUMNS.reduce((acc, col) => ({ ...acc, [col]: !['hostname', 'pid', 'functionName'].includes(col) }), {} as Record<string, boolean>);
    if (totalDaemonCount <= 1) {
        initialCols.daemon = false;
    }
    return initialCols;
  });

  // Track previous count to intelligently toggle daemon column visibility
  const prevTotalDaemonCount = useRef(totalDaemonCount);

  useEffect(() => {
    // If we went from single/zero daemons to multiple, automatically show the column
    if (totalDaemonCount > 1 && prevTotalDaemonCount.current <= 1) {
        setVisibleColumns(prev => ({ ...prev, daemon: true }));
    } 
    // If we went from multiple to single/zero, automatically hide it to save space
    else if (totalDaemonCount <= 1 && prevTotalDaemonCount.current > 1) {
        setVisibleColumns(prev => ({ ...prev, daemon: false }));
    }
    prevTotalDaemonCount.current = totalDaemonCount;
  }, [totalDaemonCount]);

  const [highlightedRowId, setHighlightedRowId] = useState<number | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const scrollRequestRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  // Track previous page to determine scrolling direction
  const prevPageRef = useRef(currentPage);
  const prevTabIdRef = useRef(tabId);

  // Pagination input state
  const [pageInput, setPageInput] = useState(currentPage.toString());
  
  // Search history state - persisted in localStorage
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempSearchInput, setTempSearchInput] = useState<string>('');

  const [currentMatchPos, setCurrentMatchPos] = useState(0); // Index in matchingIndices
  const [internalScrollId, setInternalScrollId] = useState<number | null>(null);
  const searchCommitted = useRef(false);
  const isNavigatingToMatch = useRef(false); // Used to prevent auto-reset of match position on page load during navigation

  // Load search history from localStorage on mount
  useEffect(() => {
    try {
        const savedHistory = localStorage.getItem('nhc_log_viewer_search_history');
        if (savedHistory) {
            setSearchHistory(JSON.parse(savedHistory));
        }
    } catch (e) {
        console.error("Failed to load search history:", e);
    }
  }, []);

  const saveSearchHistory = (newHistory: string[]) => {
      setSearchHistory(newHistory);
      try {
          localStorage.setItem('nhc_log_viewer_search_history', JSON.stringify(newHistory));
      } catch (e) {
          console.error("Failed to save search history:", e);
      }
  };

  // Memoize matching indices to support "X of Y" and disable Prev/Next at boundaries
  const matchingIndices = useMemo(() => {
    if (!searchQuery) return [];

    let regex: RegExp;
    try {
        let pattern = searchQuery;
        
        if (!searchUseRegex) {
            // Escape special regex characters
            pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        if (searchMatchWholeWord) {
            pattern = `\\b${pattern}\\b`;
        }
        
        const flags = searchMatchCase ? '' : 'i';
        regex = new RegExp(pattern, flags);
    } catch (e) {
        return [];
    }
    
    // We iterate the full data array once to find all matches
    return data.reduce((acc, log, index) => {
        // Restrict search to message only
        const text = log.message;
        if (regex.test(text)) {
            acc.push(index);
        }
        return acc;
    }, [] as number[]);
  }, [data, searchQuery, searchMatchCase, searchMatchWholeWord, searchUseRegex]);

  const jumpToMatch = (index: number) => {
      if (index >= 0 && index < matchingIndices.length) {
          isNavigatingToMatch.current = true;
          searchCommitted.current = true;
          setCurrentMatchPos(index);
          setInternalScrollId(data[matchingIndices[index]].id);
      }
  };

  const handleNextMatch = () => {
      if (matchingIndices.length === 0) return;
      const nextPos = currentMatchPos + 1;
      if (nextPos < matchingIndices.length) {
          jumpToMatch(nextPos);
      }
  };

  const handlePrevMatch = () => {
      if (matchingIndices.length === 0) return;
      const prevPos = currentMatchPos - 1;
      if (prevPos >= 0) {
          jumpToMatch(prevPos);
      }
  };

  // When search matches update (due to new term or data change), 
  // try to maintain relative position or find match nearest to current view.
  useEffect(() => {
    if (isNavigatingToMatch.current) {
        isNavigatingToMatch.current = false;
        return;
    }

    searchCommitted.current = false;
    if (matchingIndices.length > 0) {
        // Find the first match that is on or after the current page start
        const startIndex = (currentPage - 1) * logsPerPage;
        let newPos = matchingIndices.findIndex(idx => idx >= startIndex);
        
        // If no match found ahead, reset to 0
        if (newPos === -1) newPos = 0;
        
        setCurrentMatchPos(newPos);
    } else {
        setCurrentMatchPos(0);
    }
  }, [matchingIndices, tabId, currentPage, logsPerPage]);

  const keywordsToHighlight = useMemo(() => {
    const keys = new Set<string>();
    if (enableKeywordHighlight) {
        (keywordQueries || []).flatMap(q => extractKeywordsFromQuery(q)).forEach(k => keys.add(k));
    }
    return Array.from(keys);
  }, [keywordQueries, enableKeywordHighlight]);

  const totalPages = Math.ceil(data.length / logsPerPage);

  // Sync pageInput with currentPage prop changes
  useEffect(() => {
    setPageInput(currentPage.toString());
  }, [currentPage]);

  // Clean up scroll request animation frame
  useEffect(() => {
    return () => {
      if (scrollRequestRef.current) {
        window.cancelAnimationFrame(scrollRequestRef.current);
      }
    };
  }, []);

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * logsPerPage;
    return data.slice(startIndex, startIndex + logsPerPage);
  }, [data, currentPage, logsPerPage]);

  // Combined ID to scroll to (either from props or internal search)
  const targetScrollId = scrollToLogId ?? internalScrollId;

  // Use useEffect to handle scrolling after render and layout paint.
  useEffect(() => {
    if (targetScrollId === null) return;

    // Retry logic to handle cases where layout/render is slightly delayed (e.g., view mode switching)
    let attempts = 0;
    const maxAttempts = 20; // Increased to cover ~2 seconds of loading time

    const attemptScroll = () => {
        // Since we have duplicate rows (one for desktop, one for mobile), we need to find the one that is visible.
        const desktopRow = document.getElementById(`log-row-desktop-${targetScrollId}`);
        const mobileRow = document.getElementById(`log-row-mobile-${targetScrollId}`);
        
        // Check visibility by offsetParent (it is null if display: none)
        const rowElement = (desktopRow && desktopRow.offsetParent) ? desktopRow : 
                           (mobileRow && mobileRow.offsetParent) ? mobileRow : null;
        
        if (rowElement) {
            rowElement.scrollIntoView({ behavior: 'auto', block: 'center' });
            setHighlightedRowId(targetScrollId);
            
            // Allow layout to update before capturing scrollTop and clearing the target
            setTimeout(() => {
                if (tableContainerRef.current && onScrollChange) {
                    onScrollChange(tableContainerRef.current.scrollTop);
                }
                
                // Clear external scroll request
                if (targetScrollId === scrollToLogId && onScrollComplete) {
                    onScrollComplete();
                }
                // Clear internal scroll request
                if (targetScrollId === internalScrollId) {
                    setInternalScrollId(null);
                }
            }, 100);
        } else {
            // Row not found in DOM yet.
            if (attempts < maxAttempts) {
                attempts++;
                // If row is not found in DOM, check if we need to switch page first
                const logIndex = data.findIndex(log => log.id === targetScrollId);
                if (logIndex !== -1) {
                    const targetPage = Math.floor(logIndex / logsPerPage) + 1;
                    if (targetPage !== currentPage) {
                        onPageChange(targetPage);
                        // Wait for next render cycle
                        return;
                    }
                }
                
                // Retry in next frame
                requestAnimationFrame(() => setTimeout(attemptScroll, 100));
            } else {
                // Gave up, clear the request
                if (targetScrollId === scrollToLogId && onScrollComplete) onScrollComplete();
                if (targetScrollId === internalScrollId) setInternalScrollId(null);
            }
        }
    };

    requestAnimationFrame(() => {
        setTimeout(attemptScroll, 50);
    });

  }, [targetScrollId, currentPage, data, onScrollComplete, logsPerPage, onPageChange, onScrollChange, scrollToLogId, internalScrollId]);

  // Restore scroll position when switching tabs/pages
  useLayoutEffect(() => {
    const previousPage = prevPageRef.current;
    const previousTabId = prevTabIdRef.current;

    prevPageRef.current = currentPage;
    prevTabIdRef.current = tabId;

    if (targetScrollId !== null) return;

    if (tableContainerRef.current) {
        if (previousTabId !== tabId) {
             // Tab switch: restore saved position
             tableContainerRef.current.scrollTop = scrollTop;
        } else {
            // Same tab, check for page change
            const isPageChange = previousPage !== currentPage;
            const isGoingBack = currentPage < previousPage;

            if (isPageChange) {
                if (isGoingBack) {
                    // Set to bottom immediately before paint
                    tableContainerRef.current.scrollTop = tableContainerRef.current.scrollHeight;
                } else {
                    tableContainerRef.current.scrollTop = 0;
                }
            }
        }
    }
  }, [paginatedData, targetScrollId, currentPage, tabId]);


  const handleNextPage = () => onPageChange(Math.min(currentPage + 1, totalPages));
  const handlePrevPage = () => onPageChange(Math.max(currentPage - 1, 1));
  
  // Handle global shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
        const isSearchFocused = document.activeElement === searchInputRef.current;

        // Focus Search: Ctrl + F or /
        if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && !isInput)) {
            e.preventDefault();
            searchInputRef.current?.focus();
            return;
        }

        // Clear Search: Ctrl + L
        if (e.ctrlKey && e.key === 'l') {
             e.preventDefault();
             onSearchQueryChange('');
             return;
        }

        // Global Esc: Blur + Clear logic
        if (e.key === 'Escape' && !isSearchFocused && searchQuery) {
            e.preventDefault();
            onSearchQueryChange('');
            return;
        }

        // Find Next/Prev on Global Enter
        if (e.key === 'Enter' && !isInput && matchingIndices.length > 0) {
             e.preventDefault();
             if (e.shiftKey) {
                 handlePrevMatch();
             } else {
                 handleNextMatch();
             }
             return;
        }

        if (isInput) {
            return;
        }

        // Search Navigation via Up/Down arrows
        if (matchingIndices.length > 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
             if (e.key === 'ArrowUp') {
                 e.preventDefault();
                 handlePrevMatch();
                 return;
             }
             if (e.key === 'ArrowDown') {
                 e.preventDefault();
                 handleNextMatch();
                 return;
             }
        }

        // Page Navigation
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (e.ctrlKey) {
                 onPageChange(Math.min(currentPage + 5, totalPages));
            } else {
                 onPageChange(Math.min(currentPage + 1, totalPages));
            }
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (e.ctrlKey) {
                 onPageChange(Math.max(currentPage - 5, 1));
            } else {
                 onPageChange(Math.max(currentPage - 1, 1));
            }
        } else if (e.key === 'Home') {
            e.preventDefault();
            onPageChange(1);
        } else if (e.key === 'End') {
            e.preventDefault();
            onPageChange(totalPages);
        }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [currentPage, totalPages, onPageChange, searchQuery, onSearchQueryChange, matchingIndices, currentMatchPos]);

  const handlePageInputSubmit = () => {
    let p = parseInt(pageInput, 10);
    if (isNaN(p)) {
        setPageInput(currentPage.toString());
        return;
    }
    if (p < 1) p = 1;
    if (p > totalPages) p = totalPages;
    onPageChange(p);
    setPageInput(p.toString());
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
        handlePageInputSubmit();
    } else if (e.key === 'Home') {
        e.preventDefault();
        onPageChange(1);
    } else if (e.key === 'End') {
        e.preventDefault();
        onPageChange(totalPages);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearchQueryChange(e.target.value);
    // Reset history index if user types manually
    if (historyIndex !== -1) {
        setHistoryIndex(-1);
    }
  };

  const moveCursorToEnd = () => {
    setTimeout(() => {
      if (searchInputRef.current) {
        const len = searchInputRef.current.value.length;
        searchInputRef.current.setSelectionRange(len, len);
      }
    }, 0);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      const isAtEnd = el.selectionStart === el.value.length;
      const isEmpty = el.value.length === 0;

      // Esc: Blur
      if (e.key === 'Escape') {
          e.preventDefault();
          el.blur();
          return;
      }
      
      // Clear: Ctrl + L
      if (e.ctrlKey && e.key === 'l') {
          e.preventDefault();
          onSearchQueryChange('');
          return;
      }

      if (e.key === 'Enter') {
          // Hide keyboard on mobile
          el.blur();

          // Add to history
          if (searchQuery.trim()) {
            const term = searchQuery.trim();
            const newHistory = searchHistory.filter(item => item !== term); // Remove duplicate if exists
            newHistory.push(term); // Add to end
            if (newHistory.length > 20) newHistory.shift(); // Keep last 20
            saveSearchHistory(newHistory);
            setHistoryIndex(-1);
          }

          if (matchingIndices.length > 0) {
              if (e.shiftKey) {
                  handlePrevMatch();
              } else {
                  // If we haven't "committed" this search yet (meaning we haven't jumped to the first result after typing),
                  // jump to the current "nearest" match instead of skipping to the next one.
                  if (!searchCommitted.current) {
                      searchCommitted.current = true;
                      // Jump to the current calculated position
                      jumpToMatch(currentMatchPos);
                  } else {
                      handleNextMatch();
                  }
              }
          }
      } 
      
      // Search Results Navigation: Alt + Down / Alt + Up
      else if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          handleNextMatch();
      } else if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault();
          handlePrevMatch();
      }

      // History Navigation
      else if (e.key === 'ArrowUp') {
          if (!isAtEnd && !isEmpty) return;
          
          e.preventDefault();
          if (searchHistory.length === 0) return;

          if (historyIndex === -1) {
              // Start browsing history, save current input
              setTempSearchInput(searchQuery);
              const newIndex = searchHistory.length - 1;
              setHistoryIndex(newIndex);
              onSearchQueryChange(searchHistory[newIndex]);
          } else {
              const newIndex = Math.max(0, historyIndex - 1);
              setHistoryIndex(newIndex);
              onSearchQueryChange(searchHistory[newIndex]);
          }
          moveCursorToEnd();
      } else if (e.key === 'ArrowDown') {
          if (!isAtEnd && !isEmpty) return;

          e.preventDefault();
          if (historyIndex === -1) return;

          const newIndex = historyIndex + 1;
          if (newIndex >= searchHistory.length) {
              // Back to current input
              setHistoryIndex(-1);
              onSearchQueryChange(tempSearchInput);
          } else {
              setHistoryIndex(newIndex);
              onSearchQueryChange(searchHistory[newIndex]);
          }
          moveCursorToEnd();
      } 
  };

  const displayedColumns = ALL_COLUMNS.filter(col => visibleColumns[col]);

  const highlightKeywords = (text: string, keywords: string[], onKeywordClick?: (keyword: string) => void): React.ReactNode => {
    if (!keywords || keywords.length === 0 || !text) {
      return text;
    }
    const escapedKeywords = keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escapedKeywords.join('|')})`, 'gi');
    const parts = text.split(regex);

    return (
      <>
        {parts.map((part, index) => {
          const isKeyword = keywords.some(kw => kw.toLowerCase() === part.toLowerCase());
          return isKeyword ? (
            <button
              key={index}
              className="bg-yellow-500 text-black px-0.5 rounded-sm hover:bg-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-300"
              onClick={(e) => {
                e.stopPropagation();
                if (onKeywordClick) onKeywordClick(part);
              }}
            >
              {part}
            </button>
          ) : (
            part
          );
        })}
      </>
    );
  };
  
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (scrollRequestRef.current) {
      window.cancelAnimationFrame(scrollRequestRef.current);
    }
    scrollRequestRef.current = window.requestAnimationFrame(() => {
      if (onScrollChange && target) {
        onScrollChange(target.scrollTop);
      }
    });
  };

  const tableRows = useMemo(() => {
    if (paginatedData.length === 0) {
        return (
            <tr>
                <td colSpan={displayedColumns.length + 2} className="text-center py-6 text-gray-400 text-xs">
                    No logs match the current filters.
                </td>
            </tr>
        );
    }
    return paginatedData.map((log) => (
        <tr 
          key={log.id}
          id={`log-row-desktop-${log.id}`} 
          onClick={() => {
              if (highlightedRowId === log.id) {
                  setHighlightedRowId(null);
              }
          }}
          onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(log) : undefined}
          className={`
            ${onRowDoubleClick ? 'cursor-pointer' : ''}
            ${highlightedRowId === log.id 
                ? 'bg-blue-800/60 hover:bg-blue-800/50' 
                : 'hover:bg-gray-700/50'
            }
            transition-colors duration-200
          `}
        >
          <td className={`px-2 py-1 whitespace-nowrap text-xs text-gray-400 font-mono ${COLUMN_WIDTHS.timestamp}`}>{formatTimestamp(log.timestamp, selectedTimezone)}</td>
          {visibleColumns.level && <td className={`px-2 py-1 whitespace-nowrap ${COLUMN_WIDTHS.level}`}><span className={`px-1.5 py-0.5 inline-flex text-[10px] leading-tight font-semibold rounded-sm ${levelColorMap[log.level]}`}>{log.level}</span></td>}
          {visibleColumns.daemon && <td className={`px-2 py-1 whitespace-nowrap text-xs text-gray-300 ${COLUMN_WIDTHS.daemon}`}><div className="truncate" title={log.daemon}>{log.daemon}</div></td>}
          {visibleColumns.hostname && <td className={`px-2 py-1 whitespace-nowrap text-xs text-gray-300 ${COLUMN_WIDTHS.hostname}`}><div className="truncate" title={log.hostname}>{log.hostname}</div></td>}
          {visibleColumns.pid && <td className={`px-2 py-1 whitespace-nowrap text-xs text-gray-300 ${COLUMN_WIDTHS.pid}`}>{log.pid}</td>}
          {visibleColumns.module && <td className={`px-2 py-1 whitespace-nowrap text-xs text-gray-300 ${COLUMN_WIDTHS.module}`}><div className="truncate" title={log.module}>{log.module}</div></td>}
          {visibleColumns.message && <td className={`px-2 py-1 text-xs text-gray-300 font-mono break-all ${COLUMN_WIDTHS.message}`}>{keywordsToHighlight.length > 0 ? highlightKeywords(log.message, keywordsToHighlight, onKeywordClick) : log.message}</td>}
          {visibleColumns.functionName && <td className={`px-2 py-1 whitespace-nowrap text-xs text-gray-300 ${COLUMN_WIDTHS.functionName}`}><div className="truncate" title={log.functionName}>{log.functionName}</div></td>}
        </tr>
    ));
  }, [paginatedData, visibleColumns, highlightedRowId, selectedTimezone, keywordsToHighlight, onRowDoubleClick, onKeywordClick]);

  const mobileRows = useMemo(() => {
    if (paginatedData.length === 0) {
        return (
            <div className="text-center py-6 text-gray-400 text-xs">
                No logs match the current filters.
            </div>
        );
    }
    return paginatedData.map((log) => (
       <div 
          key={log.id}
          id={`log-row-mobile-${log.id}`}
          onClick={() => {
              if (highlightedRowId === log.id) {
                  setHighlightedRowId(null);
              }
          }}
          onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(log) : undefined}
          className={`
            bg-gray-800 rounded-md p-3 mb-2 border-l-4 ${levelBorderMap[log.level]}
            shadow-sm transition-colors
            ${highlightedRowId === log.id 
                ? 'ring-2 ring-blue-500 bg-gray-700' 
                : 'hover:bg-gray-700'
            }
          `}
       >
          <div className="flex justify-between items-start mb-2">
              <span className="text-[10px] text-gray-400 font-mono">
                  {formatTimestamp(log.timestamp, selectedTimezone)}
              </span>
              <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm ${levelColorMap[log.level]}`}>
                  {log.level}
              </span>
          </div>
          
          <div className="text-xs text-gray-200 font-mono break-all leading-relaxed mb-2">
              {keywordsToHighlight.length > 0 ? highlightKeywords(log.message, keywordsToHighlight, onKeywordClick) : log.message}
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500 border-t border-gray-700/50 pt-2">
              {visibleColumns.daemon && (
                  <div className="flex items-center space-x-1">
                      <span className="font-semibold text-gray-500">Daemon:</span>
                      <span className="text-gray-400">{log.daemon}</span>
                  </div>
              )}
               {visibleColumns.hostname && (
                  <div className="flex items-center space-x-1">
                      <span className="font-semibold text-gray-500">Host:</span>
                      <span className="text-gray-400">{log.hostname}</span>
                  </div>
              )}
               {visibleColumns.pid && (
                  <div className="flex items-center space-x-1">
                      <span className="font-semibold text-gray-500">PID:</span>
                      <span className="text-gray-400">{log.pid}</span>
                  </div>
              )}
               {visibleColumns.module && log.module && log.module !== 'unknown' && (
                  <div className="flex items-center space-x-1">
                      <span className="font-semibold text-gray-500">Mod:</span>
                      <span className="text-gray-400">{log.module}</span>
                  </div>
              )}
               {visibleColumns.functionName && log.functionName && log.functionName !== 'unknown' && (
                  <div className="flex items-center space-x-1">
                      <span className="font-semibold text-gray-500">Func:</span>
                      <span className="text-gray-400">{log.functionName}</span>
                  </div>
              )}
          </div>
       </div>
    ));
  }, [paginatedData, visibleColumns, highlightedRowId, selectedTimezone, keywordsToHighlight, onRowDoubleClick, onKeywordClick]);

  // Search Index Editor
  const [isEditingMatchIndex, setIsEditingMatchIndex] = useState(false);
  const [matchIndexInputValue, setMatchIndexInputValue] = useState('');
  const matchIndexInputRef = useRef<HTMLInputElement>(null);

  const handleMatchIndexDoubleClick = () => {
      if (matchingIndices.length === 0) return;
      setMatchIndexInputValue((currentMatchPos + 1).toString());
      setIsEditingMatchIndex(true);
      setTimeout(() => matchIndexInputRef.current?.select(), 0);
  };

  const submitMatchIndex = () => {
      setIsEditingMatchIndex(false);
      let val = parseInt(matchIndexInputValue, 10);
      if (isNaN(val)) return;
      
      if (val < 1) val = 1;
      if (val > matchingIndices.length) val = matchingIndices.length;
      
      jumpToMatch(val - 1);
  };

  const handleMatchIndexKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
          submitMatchIndex();
      } else if (e.key === 'Escape') {
          setIsEditingMatchIndex(false);
      }
  };

  return (
    <div className="p-2 flex flex-col h-full">
      <div className="flex justify-between items-center mb-2">
        <p className="text-gray-400 text-xs">Showing <span className="font-bold text-white">{data.length.toLocaleString()}</span> of <span className="font-bold text-white">{totalCount.toLocaleString()}</span> logs</p>
        <div className="flex items-center space-x-2">
            <div className="hidden md:block landscape:block">
                <ColumnSelector visibleColumns={visibleColumns} setVisibleColumns={setVisibleColumns} totalDaemonCount={totalDaemonCount} />
            </div>
            
            <div className="pl-2 border-l border-gray-700 flex items-center space-x-1">
                <button
                  onClick={() => exportToTxt(data, selectedTimezone, visibleColumns)}
                  className="bg-green-600 text-white px-2 py-1 rounded-md hover:bg-green-700 transition-colors text-xs"
                >
                  TXT
                </button>
                <button
                  onClick={() => exportToCsv(data, selectedTimezone)}
                  className="bg-blue-600 text-white px-2 py-1 rounded-md hover:bg-blue-700 transition-colors text-xs"
                >
                  CSV
                </button>
            </div>
        </div>
      </div>

      {/* Main Scroll Container shared between Desktop Table and Mobile List */}
      <div ref={tableContainerRef} onScroll={handleScroll} className="flex-grow overflow-auto bg-gray-900 rounded-lg border border-gray-800 md:border-none landscape:border-none">
        
        {/* Desktop View */}
        <table className="hidden md:table landscape:table min-w-full divide-y divide-gray-700">
          <thead className="bg-gray-800 sticky top-0 z-10">
            <tr>
              <th scope="col" className={`px-2 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider ${COLUMN_WIDTHS.timestamp}`}>Timestamp</th>
              {displayedColumns.map(col => (
                  <th key={col} scope="col" className={`px-2 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider ${COLUMN_WIDTHS[col]}`}>{COLUMN_NAMES[col]}</th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-gray-800 divide-y divide-gray-700">
            {tableRows}
          </tbody>
        </table>

        {/* Mobile View */}
        <div className="md:hidden landscape:hidden p-2">
            {mobileRows}
        </div>
      </div>

      {data.length > 0 && (
        <div className="relative flex flex-col sm:flex-row justify-between items-center mt-2 gap-2 sm:gap-0 pb-1 sm:pb-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          
          {/* Search (Mobile: Top, Desktop: Center Absolute) */}
          <div className="z-0 w-full sm:w-auto flex justify-center order-1 sm:order-2 sm:absolute sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2">
              <div className="flex items-center bg-gray-800 rounded-md border border-gray-600 p-0.5 shadow-sm w-full sm:w-auto">
                  <div className="pl-1 pr-0.5 text-gray-400 flex-shrink-0">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                  </div>
                  <input 
                      ref={searchInputRef}
                      type="text" 
                      placeholder="Search" 
                      className="bg-transparent border-none text-white text-xs focus:ring-0 w-full sm:w-48 placeholder-gray-500 py-0.5 min-w-0"
                      value={searchQuery}
                      onChange={handleSearchChange}
                      onKeyDown={handleSearchKeyDown}
                  />

                  {/* Search Options */}
                  <div className="flex items-center space-x-0.5 border-r border-gray-700 pr-1 mr-1 flex-shrink-0">
                      <button
                          onClick={() => onSearchMatchCaseChange(!searchMatchCase)}
                          className={`p-0.5 rounded text-[10px] font-medium w-5 h-5 flex items-center justify-center transition-colors ${searchMatchCase ? 'bg-gray-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-300'}`}
                          title="Match Case"
                      >
                          Aa
                      </button>
                      <button
                          onClick={() => onSearchMatchWholeWordChange(!searchMatchWholeWord)}
                          className={`p-0.5 rounded text-[10px] font-medium w-5 h-5 flex items-center justify-center transition-colors ${searchMatchWholeWord ? 'bg-gray-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-300'}`}
                          title="Match Whole Word"
                      >
                          <span className="underline decoration-1 underline-offset-2">ab</span>
                      </button>
                      <button
                          onClick={() => onSearchUseRegexChange(!searchUseRegex)}
                          className={`p-0.5 rounded text-[10px] font-medium w-5 h-5 flex items-center justify-center transition-colors ${searchUseRegex ? 'bg-gray-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-300'}`}
                          title="Use Regular Expression"
                      >
                          .*
                      </button>
                  </div>

                  {isEditingMatchIndex ? (
                        <input
                            ref={matchIndexInputRef}
                            type="number"
                            className="w-12 text-[10px] bg-gray-900 border border-blue-500 text-center text-white rounded mx-1 focus:outline-none"
                            value={matchIndexInputValue}
                            onChange={(e) => setMatchIndexInputValue(e.target.value)}
                            onKeyDown={handleMatchIndexKeyDown}
                            onBlur={submitMatchIndex}
                        />
                  ) : (
                    <span 
                        className={`text-[10px] text-gray-500 px-1 min-w-[2.5rem] text-center select-none tabular-nums flex-shrink-0 ${matchingIndices.length > 0 ? 'cursor-pointer hover:text-gray-300' : ''}`}
                        onDoubleClick={handleMatchIndexDoubleClick}
                        title="Double click to jump to match"
                    >
                        {matchingIndices.length > 0 ? `${currentMatchPos + 1}/${matchingIndices.length}` : (searchQuery ? '0/0' : '')}
                    </span>
                  )}
                  <div className="flex space-x-0.5 flex-shrink-0">
                    <button 
                        onClick={handlePrevMatch}
                        disabled={currentMatchPos === 0 || matchingIndices.length === 0}
                        className={`p-0.5 rounded ${currentMatchPos === 0 || matchingIndices.length === 0 ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                        title="Find Previous (Shift+Enter / Alt+Up)"
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 15l7-7 7 7"></path></svg>
                    </button>
                    <button 
                        onClick={handleNextMatch}
                        disabled={currentMatchPos === matchingIndices.length - 1 || matchingIndices.length === 0}
                        className={`p-0.5 rounded ${currentMatchPos === matchingIndices.length - 1 || matchingIndices.length === 0 ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                        title="Find Next (Enter / Alt+Down)"
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                    </button>
                  </div>
              </div>
          </div>

          {/* Wrapper for Bottom Controls (Rows + Pagination) to be on the same row on mobile, separated on desktop */}
          <div className="flex w-full sm:w-auto justify-between items-center sm:contents order-2 sm:order-1">
              {/* Rows Per Page */}
              <div className="flex items-center space-x-1 z-10 sm:order-1">
                  <label htmlFor="logs-per-page" className="text-xs text-gray-400">Rows:</label>
                  <select
                      id="logs-per-page"
                      value={logsPerPage}
                      onChange={(e) => {
                        onLogsPerPageChange(Number(e.target.value));
                      }}
                      className="bg-gray-700 text-white rounded-md py-0.5 px-1.5 text-xs border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                      {[50, 100, 500, 1000, 5000].map(size => (
                          <option key={size} value={size}>{size}</option>
                      ))}
                  </select>
              </div>

              {/* Pagination */}
              <div className="flex items-center space-x-1 z-10 sm:order-3">
                <button onClick={handlePrevPage} disabled={currentPage === 1} className="p-1 text-gray-400 bg-gray-700 rounded-md hover:bg-gray-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" title="Previous Page (Left Arrow)">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                </button>
                
                <div className="flex items-center space-x-1 text-xs text-gray-400">
                    <span>Page</span>
                    <input 
                        type="number"
                        min="1"
                        max={totalPages}
                        value={pageInput}
                        onChange={(e) => setPageInput(e.target.value)}
                        onBlur={handlePageInputSubmit}
                        onKeyDown={handlePageInputKeyDown}
                        className="w-10 text-center bg-gray-700 border border-gray-600 rounded text-white py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [appearance:textfield]"
                    />
                    <span>of {totalPages}</span>
                </div>

                <button onClick={handleNextPage} disabled={currentPage === totalPages} className="p-1 text-gray-400 bg-gray-700 rounded-md hover:bg-gray-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" title="Next Page (Right Arrow)">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                </button>
              </div>
          </div>
        </div>
      )}
    </div>
  );
};
