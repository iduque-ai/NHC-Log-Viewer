import React, { useState, useRef, useEffect } from 'react';

interface CustomMultiSelectProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  disabled?: boolean;
  fixedSelected?: string[];
}

export const CustomMultiSelect: React.FC<CustomMultiSelectProps> = ({ label, options, selected, onChange, disabled = false, fixedSelected = [] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSearchTerm('');
    }
  }, [isOpen]);

  const handleSelect = (option: string) => {
    if (fixedSelected.includes(option)) {
      return; // Do not allow toggling fixed options
    }
    if (selected.includes(option)) {
      onChange(selected.filter((item) => item !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  const filteredOptions = options.filter(option =>
    option.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="relative" ref={wrapperRef}>
      <label className="block text-[10px] font-medium text-gray-400 mb-0.5">{label}</label>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className="relative w-full bg-gray-700 border border-gray-600 text-white rounded-md shadow-sm pl-2 pr-8 py-1 text-left focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-800 disabled:cursor-not-allowed text-xs"
        disabled={disabled}
      >
        <span className="block truncate">
          {selected.length === 0
            ? `Select ${label}...`
            : selected.length === 1
            ? selected[0]
            : `${selected.length} selected`}
        </span>
        <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
          <svg className="h-4 w-4 text-gray-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 3a1 1 0 01.707.293l3 3a1 1 0 01-1.414 1.414L10 5.414 7.707 7.707a1 1 0 01-1.414-1.414l3-3A1 1 0 0110 3zm-3.707 9.293a1 1 0 011.414 0L10 14.586l2.293-2.293a1 1 0 011.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </span>
      </button>

      {isOpen && !disabled && (
        <div className="absolute z-10 mt-1 w-full bg-gray-800 border border-gray-600 shadow-lg rounded-md max-h-60 overflow-auto flex flex-col">
          <div className="p-1 border-b border-gray-700">
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 text-white rounded-md p-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <ul className="py-1 overflow-y-auto">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const isFixed = fixedSelected.includes(option);
                return (
                    <li
                    key={option}
                    onClick={() => handleSelect(option)}
                    className={`select-none relative py-1 pl-2 pr-6 ${isFixed ? 'text-gray-500 cursor-not-allowed' : 'text-gray-300 cursor-pointer hover:bg-gray-700'}`}
                    >
                    <div className="flex items-center">
                        <input
                        type="checkbox"
                        checked={selected.includes(option)}
                        readOnly
                        disabled={isFixed}
                        className="h-3 w-3 text-blue-600 bg-gray-700 border-gray-500 rounded focus:ring-blue-500 disabled:opacity-75"
                        />
                        <span className={`ml-2 block font-normal truncate text-xs ${isFixed ? 'text-gray-500' : ''}`}>{option}</span>
                    </div>
                    </li>
                );
            })
            ) : (
              <li className="text-gray-500 text-center py-1 px-2 text-xs">No options found.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};