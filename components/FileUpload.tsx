
import React, { useState, useCallback } from 'react';

interface FileUploadProps {
  onUpload: (files: File[]) => void;
  isLoading: boolean;
}

export const FileUpload: React.FC<FileUploadProps> = ({ onUpload, isLoading }) => {
  const [isDragging, setIsDragging] = useState(false);

  // FIX: The event handler is for a <label> element, so the event type should be React.DragEvent<HTMLLabelElement>.
  const handleDragEnter = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  // FIX: The event handler is for a <label> element, so the event type should be React.DragEvent<HTMLLabelElement>.
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  // FIX: The event handler is for a <label> element, so the event type should be React.DragEvent<HTMLLabelElement>.
  const handleDragOver = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // FIX: The event handler is for a <label> element, so the event type should be React.DragEvent<HTMLLabelElement>.
  const handleDrop = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUpload(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  }, [onUpload]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUpload(Array.from(e.target.files));
    }
  };

  return (
    <div className="flex items-center justify-center w-full max-w-4xl mx-auto p-4">
      <label
        htmlFor="dropzone-file"
        className={`flex flex-col items-center justify-center w-full h-64 border-2 border-gray-600 border-dashed rounded-lg cursor-pointer bg-gray-800 hover:bg-gray-700 transition-colors ${isDragging ? 'border-blue-500 bg-gray-700' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center justify-center pt-5 pb-6">
          <svg className="w-8 h-8 mb-4 text-gray-400" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
            <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"/>
          </svg>
          {isLoading ? (
            <p className="text-lg text-gray-400">Parsing files, please wait...</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-gray-400"><span className="font-semibold">Click to upload</span> or drag and drop</p>
              <p className="text-xs text-gray-500">Upload log files, GZIP files, or a ZIP archive</p>
            </>
          )}
        </div>
        <input id="dropzone-file" type="file" className="hidden" multiple onChange={handleFileChange} disabled={isLoading} accept=".txt,.log,.zip,.gz" />
      </label>
    </div>
  );
};
