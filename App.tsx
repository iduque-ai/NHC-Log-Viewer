




import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ungzip } from 'pako';
import { FileUpload } from './components/FileUpload.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { LogViewer } from './components/LogViewer.tsx';
import { AIAssistant } from './components/AIAssistant.tsx';
import { LogEntry, FilterState, LogTab, LogLevel, FileInfo } from './types.ts';
import { evaluateKeywordQuery } from './utils/helpers.ts';

const ASTERISK_LOG_REGEX = /^(?<timestamp>\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<hostname>\S+)\s+(?<daemon>[^\[:]+)(?:\[(?<pid>\d+)\])?:\s+(?<level>\w+)(?:\[\d+\])?:\s+(?<module>[^:]+:\d+)\s+in\s+(?<functionName>[^:]+):\s+(?<message>.*)$/;

const NIKO_LOG_REGEX = /^(?<timestamp>\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<hostname>\S+)\s+(?<daemon>[^\[:]+)(?:\[(?<pid>\d+)\])?:\s+(?<level>[A-Z]+)\s+(?<module>\S+)\s+-\s+(?<message>.*)$/;

const LOG_LINE_REGEX = /^(?<timestamp>\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<hostname>\S+)\s+(?<daemon>\S+?)(?:\[(?<pid>\d+)\])?:\s+(?:\[(?<level>\w+)\])?\s*(?:\[(?<module>[^\]]+)\])?(?::)?\s*(?<message>.*)$/;

// Updated to support both "Sep 11..." and ISO "2025-09-11..." timestamps
const SYSLOG_FILE_REGEX = /^(?<timestamp>\S+(?:\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)?)\s+(?<hostname>\S+)\s+(?<message>.*)$/;

const determineLevelFromMessage = (message: string): LogLevel => {
    const upperMsg = message.toUpperCase();
    if (upperMsg.includes('CRITICAL')) return LogLevel.CRITICAL;
    if (upperMsg.includes('ERROR') || upperMsg.includes('ERR')) return LogLevel.ERROR;
    if (upperMsg.includes('WARNING') || upperMsg.includes('WARN')) return LogLevel.WARNING;
    if (upperMsg.includes('NOTICE')) return LogLevel.NOTICE;
    if (upperMsg.includes('INFO')) return LogLevel.INFO;
    if (upperMsg.includes('DEBUG')) return LogLevel.DEBUG;
    if (upperMsg.includes('VERBOSE')) return LogLevel.VERBOSE;
    return LogLevel.UNKNOWN;
};

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const parseTimestamp = (timestampStr: string): Date | null => {
    // Handle timestamps without a year by assuming the current year.
    // Per user request, log times are in UTC.
    
    // Check if it's a syslog style (Sep 11 HH:mm:ss or Sep  1 HH:mm:ss)
    // WebKit (Safari/iOS) is strict and rejects "Sep 11 12:00:00 2024 UTC" or manual strings depending on locale.
    // We manually parse the components and construct via Date.UTC to be safe across all browsers/locales.
    const syslogMatch = timestampStr.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
    
    if (syslogMatch) {
         const [, monthStr, dayStr, timeStr] = syslogMatch;
         const monthIndex = MONTH_MAP[monthStr.toLowerCase()];
         
         if (monthIndex !== undefined) {
             const year = new Date().getFullYear();
             const day = parseInt(dayStr, 10);
             
             // Parse time components
             const [hoursStr, minutesStr, secondsFullStr] = timeStr.split(':');
             const hours = parseInt(hoursStr, 10);
             const minutes = parseInt(minutesStr, 10);
             
             // Handle seconds and optional milliseconds (e.g., "00" or "00.123")
             const [secondsStr, msStr] = secondsFullStr.split('.');
             const seconds = parseInt(secondsStr, 10);
             const milliseconds = msStr ? parseInt(msStr.padEnd(3, '0').substring(0, 3), 10) : 0;

             // Construct UTC date manually to avoid browser parsing inconsistencies
             const parsed = new Date(Date.UTC(year, monthIndex, day, hours, minutes, seconds, milliseconds));
             if (!isNaN(parsed.getTime())) return parsed;
         }
    }

    let parsedTimestamp;
    
    if (/^\d+$/.test(timestampStr)) {
        // Numeric timestamp is likely epoch milliseconds, which is already UTC.
        parsedTimestamp = new Date(parseInt(timestampStr, 10));
    } else {
        // For string timestamps, attempt to parse as UTC if no timezone is specified.
        if (!/Z|[+-]\d{2}(:?\d{2})?$/.test(timestampStr)) {
            // For ISO-like strings (containing 'T'), appending 'Z' is the standard for UTC.
            
            // If it looks like YYYY-MM-DD... attempt to make it strict ISO 8601 for WebKit
            if (/^\d{4}-\d{2}-\d{2}/.test(timestampStr)) {
                 // Replace space with T if needed and ensure Z suffix
                 const isoStr = timestampStr.replace(' ', 'T').replace(/Z| UTC$/, '') + 'Z';
                 parsedTimestamp = new Date(isoStr);
            } else {
                 // Fallback for other formats
                 const utcTimestampString = timestampStr.includes('T')
                    ? `${timestampStr}Z`
                    : `${timestampStr} UTC`;
                 parsedTimestamp = new Date(utcTimestampString);
            }

            // If parsing as UTC fails, fall back to default browser parsing
            if (isNaN(parsedTimestamp.getTime())) {
                parsedTimestamp = new Date(timestampStr);
            }
        } else {
            // Timestamp already has timezone info.
            parsedTimestamp = new Date(timestampStr);
        }
    }

    if (isNaN(parsedTimestamp.getTime())) return null;
    return parsedTimestamp;
}

const extractDaemonFromFileName = (fileName: string): string => {
    const parts = fileName.split('.');
    // Look for a segment that matches YYYYMMDD (6-8 digits) OR YYYY-MM-DD
    const dateIndex = parts.findIndex(part => /^\d{6,8}$|^\d{4}-\d{2}-\d{2}$/.test(part));
    
    if (dateIndex !== -1 && dateIndex + 1 < parts.length) {
        return parts[dateIndex + 1];
    }
    return '';
};

const parseLogLine = (line: string, id: number, fileName: string): LogEntry | null => {
  if (!line || line.trim() === '') return null;

  // 1. Special Handling for .syslog files
  if (fileName.includes('.syslog')) {
      const syslogMatch = line.match(SYSLOG_FILE_REGEX);
      if (syslogMatch?.groups) {
          const { timestamp, hostname, message } = syslogMatch.groups;
          const parsedTimestamp = parseTimestamp(timestamp);
          if (!parsedTimestamp) return null;

          return {
              id,
              timestamp: parsedTimestamp,
              hostname,
              daemon: extractDaemonFromFileName(fileName),
              pid: 0,
              level: determineLevelFromMessage(message),
              module: 'unknown',
              functionName: 'unknown',
              message: message.trim(),
          };
      }
      // If regex fails, fall through or return null? Fall through in case other regexes catch it.
  }

  // 2. Asterisk Format
  const asteriskMatch = line.match(ASTERISK_LOG_REGEX);
  if (asteriskMatch?.groups) {
    const { timestamp, hostname, daemon, pid, level, module, functionName, message } = asteriskMatch.groups;
    const logLevel = Object.values(LogLevel).includes(level?.toUpperCase() as LogLevel)
      ? level.toUpperCase() as LogLevel
      : LogLevel.UNKNOWN;

    const parsedTimestamp = parseTimestamp(timestamp);
    if (!parsedTimestamp) return null;

    return {
      id,
      timestamp: parsedTimestamp,
      hostname,
      daemon: daemon.trim(),
      pid: pid ? parseInt(pid, 10) : 0,
      level: logLevel,
      module: module || 'unknown',
      functionName: functionName || 'unknown',
      message: message.trim(),
    };
  }

  // 3. Niko/Coco Format (Daemon[PID]: LEVEL Module - Message)
  const nikoMatch = line.match(NIKO_LOG_REGEX);
  if (nikoMatch?.groups) {
      const { timestamp, hostname, daemon, pid, level, module, message } = nikoMatch.groups;
      const logLevel = Object.values(LogLevel).includes(level?.toUpperCase() as LogLevel)
      ? level.toUpperCase() as LogLevel
      : LogLevel.UNKNOWN;
      
      const parsedTimestamp = parseTimestamp(timestamp);
      if (!parsedTimestamp) return null;

      return {
          id,
          timestamp: parsedTimestamp,
          hostname,
          daemon: daemon.trim(),
          pid: pid ? parseInt(pid, 10) : 0,
          level: logLevel,
          module: module || 'unknown',
          functionName: 'unknown',
          message: message.trim(),
      };
  }

  // 4. Standard Generic Log Line
  const match = line.match(LOG_LINE_REGEX);
  if (match?.groups) {
    const { timestamp, hostname, daemon, pid, level, module, message } = match.groups;
    const logLevel = Object.values(LogLevel).includes(level?.toUpperCase() as LogLevel)
      ? level.toUpperCase() as LogLevel
      : LogLevel.UNKNOWN;

    const parsedTimestamp = parseTimestamp(timestamp);
    if (!parsedTimestamp) return null;

    let cleanedMessage = message.trim();
    let parsedFunctionName = 'unknown';

    // Regex to find function name at the end of the message, e.g., (my_func) or [in file.c (my_func)]
    const functionRegex = /(?:\((?<funcName1>[a-zA-Z0-9_]+)\)|\[in\s+.*:\d+\s+\((?<funcName2>[a-zA-Z0-9_]+)\)\])\s*$/;
    const functionNameMatch = cleanedMessage.match(functionRegex);
    
    if (functionNameMatch?.groups) {
        parsedFunctionName = functionNameMatch.groups.funcName1 || functionNameMatch.groups.funcName2 || 'unknown';
        cleanedMessage = cleanedMessage.replace(functionRegex, '').trim();
    }

    let extractedDaemon = daemon.trim();
    if (!extractedDaemon || extractedDaemon.toLowerCase() === 'unknown') {
        const fromFile = extractDaemonFromFileName(fileName);
        if (fromFile) extractedDaemon = fromFile;
    }

    return {
      id,
      timestamp: parsedTimestamp,
      hostname,
      daemon: extractedDaemon,
      pid: pid ? parseInt(pid, 10) : 0,
      level: logLevel,
      module: module || 'unknown',
      functionName: parsedFunctionName,
      message: cleanedMessage,
    };
  }
  
  // 5. Simple/Fallback Match (Handles standard syslog without explicit Level column)
  const simpleMatch = line.match(/^(?<timestamp>\S+(?:\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)?)\s+(?<hostname>\S+)\s+(?<daemon>[^:\s]+)(?:\[(?<pid>\d+)\])?:\s+(?<message>.*)$/);
  
  if (simpleMatch?.groups) {
    const { timestamp, hostname, daemon, pid, message } = simpleMatch.groups;
    
    const parsedTimestamp = parseTimestamp(timestamp);
    if (!parsedTimestamp) return null;
    
    let extractedDaemon = daemon.trim();
    // Fallback if daemon is 'unknown' or empty
    if (!extractedDaemon || extractedDaemon.toLowerCase() === 'unknown') {
        const fromFile = extractDaemonFromFileName(fileName);
        if (fromFile) extractedDaemon = fromFile;
    }

    return {
      id,
      timestamp: parsedTimestamp,
      hostname,
      daemon: extractedDaemon,
      pid: pid ? parseInt(pid, 10) : 0,
      level: LogLevel.UNKNOWN,
      module: 'unknown',
      functionName: 'unknown',
      message: message.trim(),
    };
  }
  
  return null;
};

const INITIAL_FILTER_STATE: FilterState = {
  selectedLevels: [],
  selectedDaemons: [],
  selectedModules: [],
  selectedFunctionNames: [],
  dateRange: [null, null],
  keywordQueries: [],
  keywordMatchMode: 'AND',
  enableKeywordHighlight: false,
  deviceId: '',
};

const INITIAL_VIEW_STATE = {
  viewMode: 'data' as const,
  logsPerPage: 500,
  searchQuery: '',
  searchMatchCase: false,
  searchMatchWholeWord: false,
  searchUseRegex: false,
};

const App: React.FC = () => {
  const [fileInfos, setFileInfos] = useState<FileInfo[]>([]);
  const [tabs, setTabs] = useState<LogTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTimezone, setSelectedTimezone] = useState<string>('UTC');
  const [editingTabId, setEditingTabId] = useState<number | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [scrollToLogId, setScrollToLogId] = useState<number | null>(null);
  const [currentKeywordInput, setCurrentKeywordInput] = useState('');
  // Initialize sidebar based on screen width
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [draggedTabIndex, setDraggedTabIndex] = useState<number | null>(null);
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);

  // Persistent Memory State
  const [savedFindings, setSavedFindings] = useState<string[]>([]);
  const [currentSourceHash, setCurrentSourceHash] = useState<string | null>(null);

  const fileIdCounter = useRef(0);
  const logIdCounter = useRef(1);

  const processFiles = async (files: File[]): Promise<FileInfo[]> => {
    const newFileInfos: FileInfo[] = [];

    for (const file of files) {
      if (file.name.endsWith('.zip')) {
        const zip = new JSZip();
        const content = await zip.loadAsync(file);
        const zipEntries: JSZip.JSZipObject[] = [];
        content.forEach((_, zipEntry) => {
          if (!zipEntry.dir && !zipEntry.name.startsWith('__MACOSX/')) {
            zipEntries.push(zipEntry);
          }
        });
        
        for (const zipEntry of zipEntries) {
            const textContent = await zipEntry.async('string');
            const parsedLogs = textContent
                .split('\n')
                .map((line) => parseLogLine(line, logIdCounter.current++, zipEntry.name))
                .filter((log): log is LogEntry => log !== null);
            
            newFileInfos.push({
                id: `file-${fileIdCounter.current++}`,
                name: zipEntry.name,
                size: new Blob([textContent]).size,
                logs: parsedLogs
            });
        }
      } else if (file.name.endsWith('.gz')) {
        try {
            const buffer = await file.arrayBuffer();
            const textContent = new TextDecoder().decode(ungzip(new Uint8Array(buffer)));
            const parsedLogs = textContent
                .split('\n')
                .map((line: string) => parseLogLine(line, logIdCounter.current++, file.name))
                .filter((log): log is LogEntry => log !== null);
            
            newFileInfos.push({
                id: `file-${fileIdCounter.current++}`,
                name: file.name,
                size: new Blob([textContent]).size,
                logs: parsedLogs
            });
        } catch (e) {
            console.error(`Error processing .gz file ${file.name}:`, e);
            alert(`Failed to decompress ${file.name}. It might be corrupted or not a valid gzip file.`);
        }
      } else {
        const textContent = await file.text();
        const parsedLogs = textContent
          .split('\n')
          .map((line) => parseLogLine(line, logIdCounter.current++, file.name))
          .filter((log): log is LogEntry => log !== null);
        
        newFileInfos.push({
            id: `file-${fileIdCounter.current++}`,
            name: file.name,
            size: file.size,
            logs: parsedLogs
        });
      }
    }
    return newFileInfos;
  };

  const handleInitialUpload = async (files: File[]) => {
    setIsLoading(true);
    logIdCounter.current = 1; // Reset for new uploads
    const newFileInfos = await processFiles(files);
    
    const allLogs = newFileInfos.flatMap(f => f.logs);
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    if (allLogs.length > 0) {
      const sortedForDateRange = [...allLogs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      minDate = sortedForDateRange[0].timestamp;
      maxDate = sortedForDateRange[sortedForDateRange.length - 1].timestamp;
    }

    setFileInfos(newFileInfos);

    const allLogsTabId = Date.now();
    const initialFiltersForTabs: FilterState = { 
      ...INITIAL_FILTER_STATE,
      dateRange: [minDate, maxDate],
    };

    const allLogsTab: LogTab = {
      id: allLogsTabId,
      name: 'All Logs',
      filters: { ...initialFiltersForTabs },
      currentPage: 1,
      scrollTop: 0,
      ...INITIAL_VIEW_STATE,
    };

    const tab1Id = allLogsTabId + 1; 
    const clonedFilters = JSON.parse(JSON.stringify(initialFiltersForTabs));

    if (clonedFilters.dateRange) {
      clonedFilters.dateRange = [
        clonedFilters.dateRange[0] ? new Date(clonedFilters.dateRange[0]) : null,
        clonedFilters.dateRange[1] ? new Date(clonedFilters.dateRange[1]) : null
      ];
    }

    const tab1: LogTab = {
        id: tab1Id,
        name: 'Tab 1',
        filters: clonedFilters,
        fixedFilters: clonedFilters,
        currentPage: 1,
        scrollTop: 0,
        ...INITIAL_VIEW_STATE,
    };
    
    setTabs([allLogsTab, tab1]);
    setActiveTabId(tab1Id); 
    setIsLoading(false);
  };
  
  const handleAppendFiles = async (files: File[]) => {
    setIsLoading(true);
    const newFileInfos = await processFiles(files);
    
    setFileInfos(prev => {
        const combinedFileInfos = [...prev, ...newFileInfos];
        
        // Calculate new global date range
        const allLogs = combinedFileInfos.flatMap(f => f.logs);
        let minDate: Date | null = null;
        let maxDate: Date | null = null;

        if (allLogs.length > 0) {
          const sortedForDateRange = [...allLogs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          minDate = sortedForDateRange[0].timestamp;
          maxDate = sortedForDateRange[sortedForDateRange.length - 1].timestamp;
        }

        // Update the "All Logs" tab (assumed to be index 0) to expand its date range
        setTabs(currentTabs => {
            if (currentTabs.length === 0) return currentTabs;
            
            const updatedTabs = [...currentTabs];
            const allLogsTab = updatedTabs[0];
            
            if (allLogsTab) {
                updatedTabs[0] = {
                    ...allLogsTab,
                    filters: {
                        ...allLogsTab.filters,
                        dateRange: [minDate, maxDate]
                    }
                };
            }
            return updatedTabs;
        });

        return combinedFileInfos;
    });
    setIsLoading(false);
  };

  const handleRemoveFile = (fileIdToRemove: string) => {
    const newFileInfos = fileInfos.filter(f => f.id !== fileIdToRemove);
    if (newFileInfos.length === 0) {
      setFileInfos([]);
      setTabs([]);
      setActiveTabId(null);
    } else {
      setFileInfos(newFileInfos);
    }
  };

  const baseLogs = useMemo(() => {
    const allLogs = fileInfos.flatMap(f => f.logs);
    allLogs.sort((a, b) => {
        const timeDiff = a.timestamp.getTime() - b.timestamp.getTime();
        if (timeDiff !== 0) return timeDiff;
        // Use original parse ID for stable sort before re-indexing
        return a.id - b.id; 
    });
    // Re-assign IDs to match the sorted order (1-indexed). This makes the log ID
    // correspond to its visual line number in the unfiltered view, fixing scroll bugs.
    return allLogs.map((log, index) => ({ ...log, id: index + 1 }));
  }, [fileInfos]);

  const globalDateRange = useMemo<[Date | null, Date | null]>(() => {
      if (baseLogs.length === 0) return [null, null];
      return [baseLogs[0].timestamp, baseLogs[baseLogs.length - 1].timestamp];
  }, [baseLogs]);

  const activeTab = useMemo(() => tabs.find(tab => tab.id === activeTabId), [tabs, activeTabId]);

  const handleFilterChange = useCallback((filters: Partial<FilterState>) => {
    if (activeTabId === null) return;
    setTabs(currentTabs => currentTabs.map(tab =>
      tab.id === activeTabId ? { ...tab, filters: { ...tab.filters, ...filters }, currentPage: 1, scrollTop: 0 } : tab
    ));
  }, [activeTabId]);
  
  const handleAICreateTab = useCallback((filters: Partial<FilterState>, reset?: boolean) => {
      // Logic: Create a new tab specifically for AI results.
      // If a tab named "AI Filter Result" exists, we could reuse it, or just create new ones.
      // Let's create a new one to be safe and allow comparison.
      
      const newTabId = Date.now();
      // Ensure we have a valid date range from global if not provided
      const baseDateRange = globalDateRange; 
      
      let baseFilters: FilterState = { 
          ...INITIAL_FILTER_STATE, 
          dateRange: baseDateRange
      };

      // Apply the AI's requested filters
      const newFilters = {
          ...baseFilters,
          ...filters
      };
      
      // Calculate next tab number for AI tabs to avoid collisions
      setTabs(currentTabs => {
          const aiTabsCount = currentTabs.filter(t => t.name.startsWith('AI Result')).length;
          const newTabName = `AI Result ${aiTabsCount + 1}`;

          const newTab: LogTab = {
              id: newTabId,
              name: newTabName,
              filters: newFilters,
              fixedFilters: undefined,
              currentPage: 1,
              scrollTop: 0,
              ...INITIAL_VIEW_STATE
          };

          // Append new tab and switch to it
          setTimeout(() => setActiveTabId(newTabId), 50);
          return [...currentTabs, newTab];
      });
  }, [globalDateRange]);

  const handleTabViewStateChange = useCallback((changes: Partial<LogTab>) => {
    if (activeTabId === null) return;
    setTabs(currentTabs =>
        currentTabs.map(tab =>
            tab.id === activeTabId ? { ...tab, ...changes } : tab
        )
    );
  }, [activeTabId]);

  const handleAIScrollToLog = useCallback((logId: number) => {
      // Logic: Switch to "All Logs" tab (index 0) to ensure the log is visible,
      // then trigger the scroll.
      
      setTabs(currentTabs => {
          if (currentTabs.length === 0) return currentTabs;
          
          const allLogsTabId = currentTabs[0].id;

          // Schedule the side-effect to switch tabs and set scroll target
          // This ensures we don't try to scroll before the view state is consistent
          setTimeout(() => {
              setActiveTabId(allLogsTabId);
              setScrollToLogId(logId);
          }, 0);

          // Force the target tab to 'data' view mode
          return currentTabs.map((t, i) => i === 0 ? { ...t, viewMode: 'data' } : t);
      });
  }, []);

  const handlePageChange = useCallback((page: number) => {
    if (activeTabId === null) return;
    setTabs(currentTabs => currentTabs.map(tab =>
      tab.id === activeTabId ? { ...tab, currentPage: page, scrollTop: 0 } : tab
    ));
  }, [activeTabId]);

  const handleScrollChange = useCallback((scrollTop: number) => {
    if (activeTabId === null) return;
    setTabs(currentTabs =>
        currentTabs.map(tab =>
            tab.id === activeTabId ? { ...tab, scrollTop } : tab
        )
    );
  }, [activeTabId]);

  const handleLogsPerPageChange = useCallback((newLogsPerPage: number) => {
    if (activeTabId === null) return;
    setTabs(currentTabs =>
      currentTabs.map(tab => {
        if (tab.id === activeTabId) {
            const currentLogsPerPage = tab.logsPerPage || 500;
            const currentPage = tab.currentPage || 1;
            const firstLogIndex = (currentPage - 1) * currentLogsPerPage;
            const newPage = Math.floor(firstLogIndex / newLogsPerPage) + 1;
            
            return { 
                ...tab, 
                logsPerPage: newLogsPerPage, 
                currentPage: newPage,
                scrollTop: 0 
            };
        }
        return tab;
      })
    );
  }, [activeTabId]);

  const handleNewTab = (withFilters: boolean) => {
    let newFilters: FilterState;

    if (withFilters) {
        const activeTab = tabs.find(tab => tab.id === activeTabId);
        // The new filters are a deep copy of the active tab's current filters.
        newFilters = activeTab ? JSON.parse(JSON.stringify(activeTab.filters)) : { ...INITIAL_FILTER_STATE, dateRange: globalDateRange };
    } else {
        newFilters = { ...INITIAL_FILTER_STATE, dateRange: globalDateRange };
    }
    
    // Rehydrate date strings to Date objects after cloning via JSON.
    if (newFilters.dateRange) {
      newFilters.dateRange = [
        newFilters.dateRange[0] ? new Date(newFilters.dateRange[0]) : null,
        newFilters.dateRange[1] ? new Date(newFilters.dateRange[1]) : null
      ];
    }

    const newTabId = Date.now();
    const tabNumbers = tabs
      .map(t => {
        const match = t.name.match(/^Tab (\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      });
    const nextTabNumber = Math.max(0, ...tabNumbers) + 1;

    const newTab: LogTab = {
      id: newTabId,
      name: `Tab ${nextTabNumber}`,
      filters: newFilters,
      fixedFilters: undefined, // New tabs are always editable
      currentPage: 1,
      scrollTop: 0,
      ...INITIAL_VIEW_STATE,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(newTabId);
  };
  
  const handleCloseTab = (tabIdToClose: number) => {
    if (tabIdToClose === tabs[0]?.id) return;
    
    const tabIndex = tabs.findIndex(tab => tab.id === tabIdToClose);
    if (tabIndex === -1) return;
    const newTabs = tabs.filter(tab => tab.id !== tabIdToClose);
    if (activeTabId === tabIdToClose) {
      const newActiveIndex = Math.max(0, tabIndex - 1);
      setActiveTabId(newTabs[newActiveIndex].id);
    }
    setTabs(newTabs);
  };
  
  const handleRenameTab = (tabId: number, newName: string) => {
    if (!newName.trim()) {
      setEditingTabId(null);
      return;
    }
    setTabs(currentTabs =>
      currentTabs.map(tab => (tab.id === tabId ? { ...tab, name: newName.trim() } : tab))
    );
    setEditingTabId(null);
  };

  const handleRowDoubleClick = useCallback((log: LogEntry) => {
    const allLogsTab = tabs[0];
    if (allLogsTab) {
        setActiveTabId(allLogsTab.id);
        setScrollToLogId(log.id);
        // Force view to data
        setTabs(currentTabs =>
            currentTabs.map(tab =>
                tab.id === allLogsTab.id ? { ...tab, viewMode: 'data' } : tab
            )
        );
    }
  }, [tabs]);

  const handleScrollComplete = useCallback(() => {
    setScrollToLogId(null);
  }, []);

  const handleKeywordClick = useCallback((keyword: string) => {
    setCurrentKeywordInput(prev => (prev ? prev.trim() + ' ' : '') + keyword);
  }, []);

  const handleResetDateRange = useCallback(() => {
      if (activeTabId === null) return;
      handleFilterChange({ dateRange: globalDateRange });
  }, [activeTabId, globalDateRange, handleFilterChange]);

  const handleExportFilters = useCallback(() => {
      if (!activeTab) return;
      const filtersToExport = { ...activeTab.filters };
      // Exclude dateRange from export
      filtersToExport.dateRange = [null, null];
      
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filtersToExport, null, 2));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", `nhc_filters_${activeTab.name.replace(/\s+/g, '_')}.json`);
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
  }, [activeTab]);

  const handleImportFilters = useCallback((file: File) => {
      if (activeTabId === null) return;
      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const json = JSON.parse(event.target?.result as string);
              // Sanitize and validate logic could go here, for now we merge safely
              const importedFilters: Partial<FilterState> = {};
              
              if (Array.isArray(json.selectedLevels)) importedFilters.selectedLevels = json.selectedLevels;
              if (Array.isArray(json.selectedDaemons)) importedFilters.selectedDaemons = json.selectedDaemons;
              if (Array.isArray(json.selectedModules)) importedFilters.selectedModules = json.selectedModules;
              if (Array.isArray(json.selectedFunctionNames)) importedFilters.selectedFunctionNames = json.selectedFunctionNames;
              if (Array.isArray(json.keywordQueries)) importedFilters.keywordQueries = json.keywordQueries;
              if (json.keywordMatchMode === 'AND' || json.keywordMatchMode === 'OR') importedFilters.keywordMatchMode = json.keywordMatchMode;
              if (typeof json.enableKeywordHighlight === 'boolean') importedFilters.enableKeywordHighlight = json.enableKeywordHighlight;

              handleFilterChange(importedFilters);
          } catch (e) {
              console.error("Failed to parse filter JSON", e);
              alert("Invalid JSON file.");
          }
      };
      reader.readAsText(file);
  }, [activeTabId, handleFilterChange]);

  // Drag and Drop Logic
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    if (index === 0) {
        e.preventDefault(); // Cannot drag All Logs
        return;
    }
    setDraggedTabIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
    // Adding a transparent class to the drag source can be done via state if needed, but simple D&D is okay
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, dropIndex: number) => {
    e.preventDefault();
    if (draggedTabIndex === null || dropIndex === 0) return; // Cannot drop on All Logs
    
    if (draggedTabIndex === dropIndex) return;

    const newTabs = [...tabs];
    const [movedTab] = newTabs.splice(draggedTabIndex, 1);
    newTabs.splice(dropIndex, 0, movedTab);
    
    setTabs(newTabs);
    setDraggedTabIndex(null);
  };

  const { allDaemons, allModules, allFunctionNames, allHostnames } = useMemo(() => {
    const daemons = new Set<string>();
    const modules = new Set<string>();
    const functionNames = new Set<string>();
    const hostnames = new Set<string>();
    baseLogs.forEach(log => {
      if (log.daemon) daemons.add(log.daemon);
      if (log.module) modules.add(log.module);
      if (log.functionName) functionNames.add(log.functionName);
      if (log.hostname) hostnames.add(log.hostname);
    });
    return {
      allDaemons: Array.from(daemons).sort(),
      allModules: Array.from(modules).sort(),
      allFunctionNames: Array.from(functionNames).sort(),
      allHostnames: Array.from(hostnames).sort(),
    };
  }, [baseLogs]);

  const activeTabFilters = activeTab?.filters;
  const filteredLogs = useMemo(() => {
    if (!activeTabFilters) return [];
    
    return baseLogs.filter(log => {
      const { selectedLevels, selectedDaemons, selectedModules, selectedFunctionNames, dateRange, keywordQueries, keywordMatchMode } = activeTabFilters;
      if (selectedLevels.length > 0 && !selectedLevels.includes(log.level)) return false;
      if (selectedDaemons.length > 0 && !selectedDaemons.includes(log.daemon)) return false;
      if (selectedModules.length > 0 && !selectedModules.includes(log.module)) return false;
      if (selectedFunctionNames.length > 0 && !selectedFunctionNames.includes(log.functionName)) return false;
      
      if (keywordQueries.length > 0) {
          const check = (q: string) => evaluateKeywordQuery(q, log.message);
          if (keywordMatchMode === 'OR') {
              // ANY must match (if queries exist)
              if (!keywordQueries.some(check)) return false;
          } else {
              // ALL (AND) must match
              if (!keywordQueries.every(check)) return false;
          }
      }

      const logTime = log.timestamp.getTime();
      if (dateRange[0] && logTime < dateRange[0].getTime()) return false;
      if (dateRange[1] && logTime > dateRange[1].getTime()) return false;
      return true;
    });
  }, [
      baseLogs, 
      activeTabFilters?.selectedLevels, 
      activeTabFilters?.selectedDaemons, 
      activeTabFilters?.selectedModules,
      activeTabFilters?.selectedFunctionNames,
      activeTabFilters?.dateRange?.[0],
      activeTabFilters?.dateRange?.[1],
      activeTabFilters?.keywordQueries,
      activeTabFilters?.keywordMatchMode
  ]);

  useEffect(() => {
    setTabs(currentTabs => {
      if (currentTabs.length === 0) return currentTabs;
  
      let tabsNeedUpdate = false;
      const updatedTabs = currentTabs.map(tab => {
        const { filters } = tab;
  
        const newSelectedDaemons = allDaemons.length === 1 ? [...allDaemons] : (filters.selectedDaemons || []).filter(d => allDaemons.includes(d));
        const newSelectedModules = allModules.length === 1 ? [...allModules] : (filters.selectedModules || []).filter(m => allModules.includes(m));
        const newSelectedFunctionNames = allFunctionNames.length === 1 ? [...allFunctionNames] : (filters.selectedFunctionNames || []).filter(f => allFunctionNames.includes(f));
        
        if (
          JSON.stringify(newSelectedDaemons) !== JSON.stringify(filters.selectedDaemons || []) ||
          JSON.stringify(newSelectedModules) !== JSON.stringify(filters.selectedModules || []) ||
          JSON.stringify(newSelectedFunctionNames) !== JSON.stringify(filters.selectedFunctionNames || [])
        ) {
          tabsNeedUpdate = true;
          return {
            ...tab,
            filters: {
              ...filters,
              selectedDaemons: newSelectedDaemons,
              selectedModules: newSelectedModules,
              selectedFunctionNames: newSelectedFunctionNames,
            },
          };
        }
  
        return tab;
      });
  
      return tabsNeedUpdate ? updatedTabs : currentTabs;
    });
  }, [allDaemons, allModules, allFunctionNames]);

  // Persistent Memory Logic
  useEffect(() => {
    if (baseLogs.length === 0) {
        setCurrentSourceHash(null);
        setSavedFindings([]);
        return;
    }

    const key = [...allDaemons.sort(), ...allHostnames.sort()].join('|');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        const char = key.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    const newHash = `nhc-log-source-${hash}`;
    setCurrentSourceHash(newHash);

    const findingsRaw = localStorage.getItem(newHash);
    const findings = findingsRaw ? JSON.parse(findingsRaw) : [];
    setSavedFindings(findings);
  }, [allDaemons, allHostnames, baseLogs.length]);

  const handleSaveFinding = useCallback((findingText: string) => {
    if (!currentSourceHash) return;
    try {
        const existingFindingsRaw = localStorage.getItem(currentSourceHash);
        const existingFindings = existingFindingsRaw ? JSON.parse(existingFindingsRaw) : [];
        if (!existingFindings.includes(findingText)) {
            const newFindings = [...existingFindings, findingText];
            localStorage.setItem(currentSourceHash, JSON.stringify(newFindings));
            setSavedFindings(newFindings);
        }
    } catch (e) {
        console.error("Failed to save finding to localStorage:", e);
    }
  }, [currentSourceHash]);

  const handleRemoveFinding = useCallback((indexToRemove: number) => {
    if (!currentSourceHash) return;
    try {
        const newFindings = savedFindings.filter((_, idx) => idx !== indexToRemove);
        localStorage.setItem(currentSourceHash, JSON.stringify(newFindings));
        setSavedFindings(newFindings);
    } catch (e) {
        console.error("Failed to remove finding from localStorage:", e);
    }
  }, [currentSourceHash, savedFindings]);

  return (
    <div className="flex h-[100dvh] bg-gray-800 text-white font-sans overflow-hidden relative">
      {fileInfos.length > 0 && activeTab ? (
        <>
          {/* Mobile Backdrop */}
          {isSidebarOpen && (
            <div 
              className="fixed inset-0 bg-black/50 z-20 md:hidden"
              onClick={() => setIsSidebarOpen(false)}
            />
          )}

          {isSidebarOpen && (
             <div className="fixed inset-y-0 left-0 z-30 h-full shadow-2xl md:static md:shadow-none md:z-auto bg-gray-800 transition-transform duration-300">
                  <Sidebar
                    filterState={activeTab.filters}
                    fixedFilters={activeTab.fixedFilters}
                    onFilterChange={handleFilterChange}
                    allDaemons={allDaemons}
                    allModules={allModules}
                    allFunctionNames={allFunctionNames}
                    onNewTab={handleNewTab}
                    isLoading={isLoading}
                    fileInfos={fileInfos}
                    onAppendFiles={handleAppendFiles}
                    onRemoveFile={handleRemoveFile}
                    selectedTimezone={selectedTimezone}
                    setSelectedTimezone={setSelectedTimezone}
                    filtersDisabled={activeTab.id === tabs[0]?.id}
                    currentKeywordInput={currentKeywordInput}
                    onCurrentKeywordInputChange={setCurrentKeywordInput}
                    globalDateRange={globalDateRange}
                    onResetDateRange={handleResetDateRange}
                    onExportFilters={handleExportFilters}
                    onImportFilters={handleImportFilters}
                    isAllLogs={activeTab.id === tabs[0]?.id}
                    onCloseMobile={() => setIsSidebarOpen(false)}
                    onCollapse={() => setIsSidebarOpen(false)}
                  />
             </div>
          )}

          <main className="flex-1 flex flex-col min-w-0 w-full relative">
            {/* Header */}
            <div className="flex-shrink-0 bg-gray-900 border-b border-gray-700 flex items-center justify-between pr-2">
              <div className="flex items-center">
                  {!isSidebarOpen && (
                    <button 
                      onClick={() => setIsSidebarOpen(true)}
                      className="p-2 text-gray-400 hover:text-white border-r border-gray-700 h-full"
                      title="Expand Sidebar"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                    </button>
                  )}
                  <div className="flex overflow-x-auto">
                    {tabs.map((tab, index) => {
                      const isAllLogsTab = index === 0;
                      const isActive = activeTabId === tab.id;

                      let tabClasses = 'flex items-center px-3 py-1.5 border-r border-gray-700 flex-shrink-0 whitespace-nowrap transition-colors text-xs ';
                      if (isActive) {
                        tabClasses += 'bg-gray-800 text-white';
                      } else {
                        if (isAllLogsTab) {
                          tabClasses += 'bg-gray-950 text-gray-400 hover:bg-gray-700 hover:text-white';
                        } else {
                          tabClasses += 'bg-gray-900 text-white hover:bg-gray-700';
                        }
                      }
                      tabClasses += isAllLogsTab ? ' cursor-default' : ' cursor-pointer';

                      return (
                        <div
                          key={tab.id}
                          draggable={!isAllLogsTab}
                          onDragStart={(e) => handleDragStart(e, index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDrop={(e) => handleDrop(e, index)}
                          onClick={() => editingTabId !== tab.id && setActiveTabId(tab.id)}
                          onDoubleClick={() => {
                            if (isAllLogsTab) return;
                            setEditingTabId(tab.id);
                            setEditingTabName(tab.name);
                          }}
                          className={tabClasses}
                        >
                          {isAllLogsTab && (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                            </svg>
                          )}
                          {editingTabId === tab.id ? (
                            <input
                              type="text"
                              value={editingTabName}
                              onChange={e => setEditingTabName(e.target.value)}
                              onBlur={() => handleRenameTab(tab.id, editingTabName)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleRenameTab(tab.id, editingTabName);
                                if (e.key === 'Escape') setEditingTabId(null);
                              }}
                              autoFocus
                              onFocus={e => e.target.select()}
                              className="bg-gray-700 text-white text-xs border border-gray-600 focus:ring-1 focus:ring-blue-500 rounded-sm px-1 mr-1 max-w-[8rem]"
                            />
                          ) : (
                            <span className="mr-1 truncate max-w-[8rem]" title={tab.name}>{tab.name}</span>
                          )}
                          {!isAllLogsTab && <button onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id); }} className="text-gray-500 hover:text-white flex-shrink-0">&times;</button>}
                        </div>
                      );
                    })}
                  </div>
              </div>
              
              {/* AI Assistant Toggle */}
              <button
                onClick={() => setIsAIPanelOpen(!isAIPanelOpen)}
                className={`p-1.5 rounded-md flex items-center space-x-1 text-xs font-medium transition-colors ${isAIPanelOpen ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                title="Toggle AI Assistant"
              >
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                 <span className="hidden sm:inline">AI Assistant</span>
              </button>
            </div>

            <div className="flex flex-grow min-h-0">
               <div className="flex-grow min-w-0">
                  <LogViewer
                    logs={filteredLogs}
                    totalCount={baseLogs.length}
                    selectedTimezone={selectedTimezone}
                    totalDaemonCount={allDaemons.length}
                    keywordQueries={activeTab.filters.keywordQueries}
                    enableKeywordHighlight={activeTab.filters.enableKeywordHighlight}
                    onRowDoubleClick={activeTab.id !== tabs[0]?.id ? handleRowDoubleClick : undefined}
                    onKeywordClick={handleKeywordClick}
                    scrollToLogId={activeTab.id === tabs[0]?.id ? scrollToLogId : null}
                    onScrollComplete={handleScrollComplete}
                    currentPage={activeTab.currentPage || 1}
                    onPageChange={handlePageChange}
                    scrollTop={activeTab.scrollTop}
                    onScrollChange={handleScrollChange}
                    // View State Persistence
                    viewMode={activeTab.viewMode}
                    onViewModeChange={(mode) => handleTabViewStateChange({ viewMode: mode })}
                    tabId={activeTab.id}
                    logsPerPage={activeTab.logsPerPage || 500}
                    onLogsPerPageChange={handleLogsPerPageChange}
                    searchQuery={activeTab.searchQuery || ''}
                    onSearchQueryChange={(s) => handleTabViewStateChange({ searchQuery: s })}
                    searchMatchCase={activeTab.searchMatchCase || false}
                    onSearchMatchCaseChange={(b) => handleTabViewStateChange({ searchMatchCase: b })}
                    searchMatchWholeWord={activeTab.searchMatchWholeWord || false}
                    onSearchMatchWholeWordChange={(b) => handleTabViewStateChange({ searchMatchWholeWord: b })}
                    searchUseRegex={activeTab.searchUseRegex || false}
                    onSearchUseRegexChange={(b) => handleTabViewStateChange({ searchUseRegex: b })}
                    savedFindings={savedFindings}
                    onRemoveFinding={handleRemoveFinding}
                  />
               </div>
              <div className={`flex-shrink-0 w-96 border-l border-gray-700 ${isAIPanelOpen ? 'flex flex-col' : 'hidden'}`}>
                  <AIAssistant 
                    onClose={() => setIsAIPanelOpen(false)} 
                    visibleLogs={filteredLogs}
                    allLogs={baseLogs}
                    allDaemons={allDaemons}
                    onUpdateFilters={handleAICreateTab}
                    onScrollToLog={handleAIScrollToLog}
                    savedFindings={savedFindings}
                    onSaveFinding={handleSaveFinding}
                  />
              </div>
            </div>
          </main>
        </>
      ) : (
        <main className="flex-1 flex flex-col min-w-0 bg-gray-900 relative overflow-hidden">
          {/* Decorative background blobs */}
          <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
            <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-blue-600/10 blur-[100px]"></div>
            <div className="absolute top-[20%] right-[0%] w-[30%] h-[30%] rounded-full bg-purple-600/10 blur-[100px]"></div>
          </div>

          <div className="flex-grow flex flex-col items-center justify-center p-2 sm:p-4 md:p-6 relative z-10">
            <div className="text-center mb-8">
                <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-white mb-3">
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-500">NHC</span> Log Viewer
                </h1>
                <p className="text-gray-400 text-sm max-w-lg mx-auto">
                    Advanced analysis for your application logs. Parse, filter, and visualize in seconds.
                </p>
            </div>
            
            <div className="w-full max-w-2xl bg-gray-800/40 backdrop-blur-md border border-gray-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
                <FileUpload onUpload={handleInitialUpload} isLoading={isLoading} />
                
                <div className="mt-6 grid grid-cols-2 gap-4">
                    <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                        <div className="flex justify-center mb-2 text-blue-400">
                             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                        </div>
                        <h3 className="text-xs font-semibold text-gray-200">Privacy Focused</h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">Processing happens locally</p>
                    </div>
                    <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                        <div className="flex justify-center mb-2 text-purple-400">
                             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"></path></svg>
                        </div>
                        <h3 className="text-xs font-semibold text-gray-200">Advanced Filtering</h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">Boolean logic & deep inspection</p>
                    </div>
                    <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                        <div className="flex justify-center mb-2 text-green-400">
                             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
                        </div>
                        <h3 className="text-xs font-semibold text-gray-200">Visual Stats</h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">Interactive charts & summaries</p>
                    </div>
                    <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                        <div className="flex justify-center mb-2 text-yellow-400">
                           <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                        </div>
                        <h3 className="text-xs font-semibold text-gray-200">AI-Powered Analysis</h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">Chat with your logs via cloud or local AI</p>
                    </div>
                </div>
            </div>

            <div className="mt-8 flex items-center justify-center text-[10px] text-gray-600">
                <span>Supports .log, .txt, .zip, .gz</span>
            </div>
          </div>
        </main>
      )}
    </div>
  );
};

export default App;