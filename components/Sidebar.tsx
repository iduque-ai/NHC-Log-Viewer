import React, { useMemo } from 'react';
import { FilterState, LogLevel, FileInfo } from '../types.ts';
import { CustomMultiSelect } from './CustomMultiSelect.tsx';
import { formatFileSize } from '../utils/helpers.ts';

interface SidebarProps {
  filterState: FilterState;
  fixedFilters?: FilterState;
  onFilterChange: (filters: Partial<FilterState>) => void;
  allDaemons: string[];
  allModules: string[];
  allFunctionNames: string[];
  onNewTab: (withFilters: boolean) => void;
  isLoading: boolean;
  fileInfos: FileInfo[];
  onAppendFiles: (files: File[]) => void;
  onRemoveFile: (fileId: string) => void;
  selectedTimezone: string;
  setSelectedTimezone: (value: string) => void;
  filtersDisabled?: boolean;
  currentKeywordInput: string;
  onCurrentKeywordInputChange: (value: string) => void;
  globalDateRange: [Date | null, Date | null];
  onResetDateRange: () => void;
  onExportFilters: () => void;
  onImportFilters: (file: File) => void;
  isAllLogs: boolean;
  onCloseMobile?: () => void;
  onCollapse: () => void;
}

const logLevels = Object.values(LogLevel);

const parseDateInTimezone = (dateString: string, timezone: string): Date | null => {
    if (!dateString) return null;

    if (timezone === 'local') {
        return new Date(dateString);
    }
    if (timezone === 'UTC') {
        return new Date(`${dateString}Z`);
    }

    try {
        const [datePart, timePart] = dateString.split('T');
        if (!datePart || !timePart) return new Date(dateString); 
        
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split(':').map(Number);
        
        const sampleDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            timeZoneName: 'longOffset',
        });
        const parts = formatter.formatToParts(sampleDate);
        const offsetPart = parts.find(p => p.type === 'timeZoneName');
        
        if (offsetPart) {
            const offsetString = offsetPart.value.replace('GMT', '');
            const sign = offsetString.startsWith('-') ? '-' : '+';
            const numParts = offsetString.substring(1).split(':');
            const hours = numParts[0].padStart(2, '0');
            const minutes = (numParts[1] || '00').padEnd(2, '0');
            const finalOffset = `${sign}${hours}:${minutes}`;
            
            return new Date(`${dateString}${finalOffset}`);
        }
    } catch (e) {
        console.error(`Error parsing date in timezone "${timezone}":`, e);
    }
    
    return new Date(dateString);
};

const formatDateForDateTimeLocalInTimezone = (date: Date | null, timezone: string): string => {
    if (!date) return '';

    let options: Intl.DateTimeFormatOptions = {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    };

    if (timezone !== 'local') {
        try {
            new Intl.DateTimeFormat(undefined, { timeZone: timezone });
            options.timeZone = timezone;
        } catch (e) {
            console.warn(`Invalid timezone "${timezone}", falling back to local.`);
        }
    }

    const formatted = new Intl.DateTimeFormat('sv-SE', options).format(date);
    return formatted.replace(' ', 'T');
};


interface KeywordFilterProps {
  queries: string[];
  matchMode: 'AND' | 'OR';
  fixedQueries?: string[];
  onChange: (queries: string[]) => void;
  onMatchModeChange: (mode: 'AND' | 'OR') => void;
  disabled: boolean;
  highlightEnabled: boolean;
  onHighlightChange: (enabled: boolean) => void;
  inputValue: string;
  onInputValueChange: (value: string) => void;
}

const KeywordFilter: React.FC<KeywordFilterProps> = ({ 
  queries, 
  matchMode,
  fixedQueries = [],
  onChange, 
  onMatchModeChange,
  disabled, 
  highlightEnabled, 
  onHighlightChange,
  inputValue,
  onInputValueChange
}) => {
  const handleAddQuery = () => {
    const trimmedQuery = inputValue.trim();
    if (trimmedQuery && !queries.includes(trimmedQuery)) {
      onChange([...queries, trimmedQuery]);
      onInputValueChange('');
    }
  };

  const handleRemoveQuery = (queryToRemove: string) => {
    if (fixedQueries.includes(queryToRemove)) return;
    onChange(queries.filter(q => q !== queryToRemove));
  };

  const handleRemoveAll = () => {
    onChange(fixedQueries);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddQuery();
    }
  };
  
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
          <label htmlFor="keyword" className="block text-[10px] font-medium text-gray-400">Keyword Search</label>
          <div className="flex items-center space-x-2">
              <span className="text-[10px] text-gray-500" id="highlight-label">Highlight</span>
              <button
                type="button"
                role="switch"
                aria-checked={highlightEnabled}
                aria-labelledby="highlight-label"
                onClick={() => !disabled && onHighlightChange(!highlightEnabled)}
                className={`${
                  highlightEnabled ? 'bg-blue-600' : 'bg-gray-600'
                } relative inline-flex h-3 w-6 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-1 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-gray-900 disabled:opacity-50`}
                disabled={disabled}
              >
                <span
                  aria-hidden="true"
                  className={`${
                    highlightEnabled ? 'translate-x-3' : 'translate-x-0'
                  } pointer-events-none inline-block h-2 w-2 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                />
              </button>
          </div>
      </div>
      <div className="flex space-x-1 mb-0.5">
        <div className="relative flex-grow min-w-0">
          <input
            type="text"
            id="keyword"
            value={inputValue}
            onChange={(e) => onInputValueChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. (error || fail)"
            disabled={disabled}
            className="w-full bg-gray-700 border border-gray-600 text-white rounded-md shadow-sm p-1 pr-6 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-800"
          />
          {inputValue && (
            <button
              onClick={() => onInputValueChange('')}
              disabled={disabled}
              className="absolute right-1 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
              title="Clear input"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
        <button
          onClick={handleAddQuery}
          disabled={disabled || !inputValue.trim()}
          className="bg-indigo-600 text-white px-2 py-1 rounded-md hover:bg-indigo-700 transition-colors text-[10px] font-medium disabled:bg-gray-600 disabled:cursor-not-allowed flex-shrink-0"
        >
          Add
        </button>
      </div>
      <p className="text-[9px] text-gray-500 mb-2 leading-tight">
        Use &&, ||, !, () within a single filter term.
      </p>
      
      {queries.length > 0 && (
         <div className="flex justify-between items-center mb-1">
             <div className="flex items-center space-x-1">
                 <span className="text-[10px] text-gray-400">Match Mode:</span>
                 <div className="flex bg-gray-700 rounded p-0.5">
                     <button
                        onClick={() => onMatchModeChange('AND')}
                        disabled={disabled}
                        className={`px-1 py-0 text-[9px] rounded transition-colors ${matchMode === 'AND' ? 'bg-gray-500 text-white' : 'text-gray-400 hover:text-white'}`}
                     >
                        AND
                     </button>
                     <button
                        onClick={() => onMatchModeChange('OR')}
                        disabled={disabled}
                        className={`px-1 py-0 text-[9px] rounded transition-colors ${matchMode === 'OR' ? 'bg-gray-500 text-white' : 'text-gray-400 hover:text-white'}`}
                     >
                        OR
                     </button>
                 </div>
             </div>
             <button
                onClick={() => !disabled && handleRemoveAll()}
                disabled={disabled}
                className="text-[10px] text-red-400 hover:text-red-300 disabled:opacity-50 hover:underline"
                title="Remove all keywords"
             >
                Reset
             </button>
         </div>
      )}

      <div className="mt-1 flex flex-wrap gap-1">
        {queries.map((q) => {
          const isFixed = fixedQueries.includes(q);
          return (
            <div key={q} className={`flex items-center text-[10px] font-medium pl-1.5 pr-1 py-0 rounded-full max-w-full ${isFixed ? 'bg-gray-700 text-gray-400 cursor-default' : 'bg-gray-600 text-gray-200'}`}>
              <span className="truncate" title={q}>{q}</span>
              {!isFixed && (
                <button
                  onClick={() => !disabled && handleRemoveQuery(q)}
                  disabled={disabled}
                  className="ml-0.5 text-gray-400 hover:text-white rounded-full focus:outline-none focus:ring-1 focus:ring-white disabled:opacity-50 flex-shrink-0"
                  aria-label={`Remove filter: ${q}`}
                >
                  <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  );
};

const DataSources: React.FC<{
  fileInfos: FileInfo[];
  onAppendFiles: (files: File[]) => void;
  onRemoveFile: (fileId: string) => void;
  disabled: boolean;
}> = ({ fileInfos, onAppendFiles, onRemoveFile, disabled }) => {
  const [isOpen, setIsOpen] = React.useState(true);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleAddFilesClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAppendFiles(Array.from(e.target.files));
      e.target.value = ''; // Reset file input
    }
  };

  return (
    <div className="border-t border-b border-gray-700 py-2">
      <button onClick={() => setIsOpen(!isOpen)} className="w-full flex justify-between items-center text-sm font-bold text-white mb-1">
        <span>Data Sources</span>
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
      </button>
      {isOpen && (
        <div className="space-y-1">
          <div className="max-h-20 overflow-y-auto overflow-x-hidden space-y-0.5 pr-1">
              {fileInfos.map(file => (
                <div key={file.id} className="flex justify-between items-center bg-gray-800 p-1 rounded-md">
                  <div className="text-[10px] flex-1 min-w-0 pr-1">
                    <p className="font-medium text-gray-300 truncate" title={file.name}>{file.name}</p>
                    <p className="text-[9px] text-gray-500">{formatFileSize(file.size)}</p>
                  </div>
                  <button onClick={() => onRemoveFile(file.id)} disabled={disabled} className="text-gray-500 hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 text-[10px]">&times;</button>
                </div>
              ))}
          </div>
          <button
            onClick={handleAddFilesClick}
            disabled={disabled}
            className="w-full bg-green-600 text-white px-2 py-1 rounded-md hover:bg-green-700 transition-colors text-[10px] disabled:bg-gray-600 disabled:cursor-not-allowed"
          >
            {fileInfos.length > 0 ? 'Add More Files' : 'Add Files'}
          </button>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            multiple
            onChange={handleFileChange}
            disabled={disabled}
            accept=".txt,.log,.zip,.gz"
          />
        </div>
      )}
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  filterState,
  fixedFilters,
  onFilterChange,
  allDaemons,
  allModules,
  allFunctionNames,
  onNewTab,
  isLoading,
  fileInfos,
  onAppendFiles,
  onRemoveFile,
  selectedTimezone,
  setSelectedTimezone,
  currentKeywordInput,
  onCurrentKeywordInputChange,
  filtersDisabled = false,
  globalDateRange,
  onResetDateRange,
  onExportFilters,
  onImportFilters,
  isAllLogs,
  onCloseMobile,
  onCollapse,
}) => {
  const { selectedLevels, selectedDaemons, selectedModules, selectedFunctionNames, dateRange, keywordQueries, keywordMatchMode, enableKeywordHighlight } = filterState;
  const filtersDisabledEffective = filtersDisabled || isLoading;
  const importInputRef = React.useRef<HTMLInputElement>(null);

  const handleDateChange = (index: 0 | 1, value: string) => {
    const newDateRange = [...dateRange] as [Date | null, Date | null];
    newDateRange[index] = value ? parseDateInTimezone(value, selectedTimezone) : null;
    onFilterChange({ dateRange: newDateRange });
  };
  
  const uniqueModules = useMemo(() => {
    if (fixedFilters?.selectedModules && fixedFilters.selectedModules.length > 0) {
      return allModules.filter(m => fixedFilters.selectedModules?.includes(m));
    }
    return allModules;
  }, [allModules, fixedFilters]);
  
  const uniqueFunctionNames = useMemo(() => {
    if (fixedFilters?.selectedFunctionNames && fixedFilters.selectedFunctionNames.length > 0) {
      return allFunctionNames.filter(m => fixedFilters.selectedFunctionNames?.includes(m));
    }
    return allFunctionNames;
  }, [allFunctionNames, fixedFilters]);

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportFilters(e.target.files[0]);
      e.target.value = '';
    }
  };

  return (
    <aside className="w-60 bg-gray-800 flex flex-col p-2 border-r border-gray-700 h-full text-xs overflow-hidden">
      <div className="flex justify-between items-center mb-2">
        <h1 className="text-base font-bold text-white truncate">NHC Log Viewer</h1>
        <div className="flex items-center">
            <button 
               onClick={onCollapse}
               className="hidden md:block p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-700"
               title="Collapse sidebar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button 
               onClick={onCloseMobile}
               className="md:hidden p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-700"
               aria-label="Close sidebar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>
      </div>

      <DataSources
        fileInfos={fileInfos}
        onAppendFiles={onAppendFiles}
        onRemoveFile={onRemoveFile}
        disabled={isLoading}
      />

      <div className="flex-grow space-y-2 pt-2 overflow-y-auto overflow-x-hidden min-h-0">
        <div className="flex justify-between items-center">
             <h2 className="text-sm font-bold text-white">Filters</h2>
             <div className="flex space-x-0.5">
                 <button
                   onClick={onExportFilters}
                   disabled={filtersDisabledEffective}
                   className="p-0.5 text-gray-400 hover:text-white rounded disabled:opacity-50"
                   title="Export Filters (JSON)"
                 >
                   <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                 </button>
                 <button
                   onClick={handleImportClick}
                   disabled={filtersDisabledEffective}
                   className="p-0.5 text-gray-400 hover:text-white rounded disabled:opacity-50"
                   title="Import Filters (JSON)"
                 >
                   <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                 </button>
                 <input
                   type="file"
                   ref={importInputRef}
                   className="hidden"
                   accept=".json"
                   onChange={handleImportFileChange}
                 />
             </div>
        </div>
        
        <KeywordFilter
          queries={keywordQueries}
          matchMode={keywordMatchMode}
          fixedQueries={fixedFilters?.keywordQueries}
          onChange={(queries) => onFilterChange({ keywordQueries: queries })}
          onMatchModeChange={(mode) => onFilterChange({ keywordMatchMode: mode })}
          disabled={filtersDisabledEffective}
          highlightEnabled={enableKeywordHighlight}
          onHighlightChange={(enabled) => onFilterChange({ enableKeywordHighlight: enabled })}
          inputValue={currentKeywordInput}
          onInputValueChange={onCurrentKeywordInputChange}
        />

        <div className="space-y-2">
            <div>
            <CustomMultiSelect
                label="Log Levels"
                options={logLevels}
                selected={selectedLevels}
                onChange={(levels) => onFilterChange({ selectedLevels: levels as LogLevel[] })}
                disabled={filtersDisabledEffective}
                fixedSelected={fixedFilters?.selectedLevels}
            />
            </div>
            <div>
            <CustomMultiSelect
                label="Daemons"
                options={allDaemons}
                selected={selectedDaemons}
                onChange={(daemons) => onFilterChange({ selectedDaemons: daemons })}
                disabled={filtersDisabledEffective}
                fixedSelected={fixedFilters?.selectedDaemons}
            />
            </div>
            <div>
            <CustomMultiSelect
                label="Modules"
                options={uniqueModules}
                selected={selectedModules}
                onChange={(modules) => onFilterChange({ selectedModules: modules })}
                disabled={filtersDisabledEffective}
                fixedSelected={fixedFilters?.selectedModules}
            />
            </div>
            <div>
            <CustomMultiSelect
                label="Function Names"
                options={uniqueFunctionNames}
                selected={selectedFunctionNames}
                onChange={(funcs) => onFilterChange({ selectedFunctionNames: funcs })}
                disabled={filtersDisabledEffective}
                fixedSelected={fixedFilters?.selectedFunctionNames}
            />
            </div>
        </div>

        <div className="space-y-1">
            <div className="flex justify-between items-center mb-0.5">
                <div className="flex items-center space-x-1">
                    <label className="text-[10px] font-medium text-gray-400">Date Range</label>
                    <button
                        onClick={onResetDateRange}
                        disabled={isLoading || filtersDisabledEffective}
                        className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors focus:outline-none"
                    >
                        Reset
                    </button>
                </div>
                <div className="relative">
                    <select
                        id="timezone-select"
                        value={selectedTimezone}
                        onChange={(e) => setSelectedTimezone(e.target.value)}
                        disabled={isLoading}
                        className="bg-gray-800 border border-gray-600 text-white rounded px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none pr-4 cursor-pointer max-w-[100px] truncate"
                        title="Select Timezone"
                    >
                        <option value="local">Local</option>
                        <option value="UTC">UTC</option>
                        <option value="America/New_York">NY (ET)</option>
                        <option value="America/Chicago">CHI (CT)</option>
                        <option value="America/Denver">DEN (MT)</option>
                        <option value="America/Los_Angeles">LA (PT)</option>
                        <option value="Europe/London">LDN (GMT)</option>
                        <option value="Europe/Berlin">BER (CET)</option>
                        <option value="Asia/Tokyo">TYO (JST)</option>
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-1 text-gray-400">
                      <svg className="h-2 w-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                    </div>
                </div>
            </div>
            
            <div className="space-y-1">
                <div className="relative">
                    <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none text-gray-500">
                        <span className="text-[10px]">Start</span>
                    </div>
                    <input
                        type="datetime-local"
                        step="1"
                        value={formatDateForDateTimeLocalInTimezone(dateRange[0], selectedTimezone)}
                        onChange={(e) => handleDateChange(0, e.target.value)}
                        disabled={filtersDisabledEffective}
                        className="w-full bg-gray-700 border border-gray-600 text-white rounded-md pl-10 pr-1 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-800 [color-scheme:dark] max-w-full"
                    />
                     <div className="absolute inset-y-0 right-0 flex items-center pr-1 pointer-events-none text-gray-400">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                         </svg>
                    </div>
                </div>
                <div className="relative">
                     <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none text-gray-500">
                        <span className="text-[10px]">End</span>
                    </div>
                    <input
                        type="datetime-local"
                        step="1"
                        value={formatDateForDateTimeLocalInTimezone(dateRange[1], selectedTimezone)}
                        onChange={(e) => handleDateChange(1, e.target.value)}
                        disabled={filtersDisabledEffective}
                         className="w-full bg-gray-700 border border-gray-600 text-white rounded-md pl-10 pr-1 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-800 [color-scheme:dark] max-w-full"
                    />
                    <div className="absolute inset-y-0 right-0 flex items-center pr-1 pointer-events-none text-gray-400">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                         </svg>
                    </div>
                </div>
            </div>
        </div>

      </div>
      
      <div className="mt-2 space-y-1 border-t border-gray-700 pt-2">
        <button
          onClick={() => onNewTab(true)}
          disabled={isLoading}
          className="w-full bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 transition-colors text-xs font-medium disabled:bg-gray-600 disabled:cursor-not-allowed"
        >
          Create Tab from Filters
        </button>
        {!isAllLogs && (
            <button
            onClick={() => onNewTab(false)}
            disabled={isLoading}
            className="w-full bg-gray-700 text-white px-3 py-1.5 rounded-md hover:bg-gray-600 transition-colors text-xs font-medium disabled:bg-gray-800 disabled:cursor-not-allowed border border-gray-600"
            >
            Create Empty Tab
            </button>
        )}
      </div>
    </aside>
  );
};
