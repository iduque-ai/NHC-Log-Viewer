import React, { useEffect, useReducer, useMemo, useRef } from 'react';
import { LogEntry, LogLevel } from '../types.ts';
import { formatDuration } from '../utils/helpers.ts';

interface SummaryDashboardProps {
  data: LogEntry[];
  savedFindings?: string[];
  onRemoveFinding?: (index: number) => void;
}

const StatCard: React.FC<{ title: string; value: string | number }> = ({ title, value }) => (
    <div className="bg-gray-800 p-2 rounded-lg border border-gray-700 text-center">
        <p className="text-xl font-bold text-white">{value}</p>
        <p className="text-xs text-gray-400">{title}</p>
    </div>
);

const ChartCard: React.FC<React.PropsWithChildren<{ title: string; className?: string }>> = ({ title, children, className = '' }) => (
    <div className={`bg-gray-800 p-2 rounded-lg border border-gray-700 ${className}`}>
        <h3 className="text-sm font-semibold text-gray-200 mb-2">{title}</h3>
        <div className="h-56 relative">
            {children}
        </div>
    </div>
);

const LoadingCharts: React.FC = () => (
    <div className="p-2 grid grid-cols-1 lg:grid-cols-2 gap-2">
        <ChartCard title="Logs by Level"><div className="flex items-center justify-center h-full text-gray-400 text-xs">Loading Chart...</div></ChartCard>
        <ChartCard title="Top 10 Daemons"><div className="flex items-center justify-center h-full text-gray-400 text-xs">Loading Chart...</div></ChartCard>
        <ChartCard title="Top 10 Functions" className="lg:col-span-2"><div className="flex items-center justify-center h-full text-gray-400 text-xs">Loading Chart...</div></ChartCard>
    </div>
);

const levelColorMap: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '#475569',
  [LogLevel.INFO]: '#3b82f6',
  [LogLevel.NOTICE]: '#0ea5e9',
  [LogLevel.VERBOSE]: '#14b8a6',
  [LogLevel.WARNING]: '#f59e0b',
  [LogLevel.ERROR]: '#ef4444',
  [LogLevel.CRITICAL]: '#a855f7',
  [LogLevel.UNKNOWN]: '#9ca3af',
};

export const SummaryDashboard: React.FC<SummaryDashboardProps> = ({ data, savedFindings = [], onRemoveFinding }) => {
  const [, forceUpdate] = useReducer(x => x + 1, 0);

  useEffect(() => {
    if (window.Chart) return;
    const timer = setInterval(() => {
      if (window.Chart) {
        clearInterval(timer);
        forceUpdate();
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const {
    levelCounts,
    topDaemons,
    topFunctions,
    totalLogs,
    errorRate,
    timeSpan,
    uniqueDaemonCount
  } = useMemo(() => {
    if (data.length === 0) {
      return { levelCounts: [], topDaemons: [], topFunctions: [], totalLogs: 0, errorRate: '0.00%', timeSpan: 'N/A', uniqueDaemonCount: 0 };
    }

    const levels: Record<string, number> = {};
    const daemons: Record<string, number> = {};
    const functions: Record<string, number> = {};

    let errorCount = 0;
    for (const log of data) {
      levels[log.level] = (levels[log.level] || 0) + 1;
      
      if (log.daemon && log.daemon.toLowerCase() !== 'unknown') {
        daemons[log.daemon] = (daemons[log.daemon] || 0) + 1;
      }
      
      if (log.functionName && log.functionName.toLowerCase() !== 'unknown') {
        functions[log.functionName] = (functions[log.functionName] || 0) + 1;
      }

      if (log.level === LogLevel.ERROR || log.level === LogLevel.CRITICAL) {
        errorCount++;
      }
    }

    const levelOrder = [LogLevel.CRITICAL, LogLevel.ERROR, LogLevel.WARNING, LogLevel.NOTICE, LogLevel.INFO, LogLevel.VERBOSE, LogLevel.DEBUG, LogLevel.UNKNOWN];
    const levelData = Object.entries(levels)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => levelOrder.indexOf(a.name as LogLevel) - levelOrder.indexOf(b.name as LogLevel));

    const daemonData = Object.entries(daemons)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    const functionData = Object.entries(functions)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    const firstLogTime = data[0].timestamp.getTime();
    const lastLogTime = data[data.length - 1].timestamp.getTime();
    const duration = lastLogTime - firstLogTime;
    
    return { 
      levelCounts: levelData, 
      topDaemons: daemonData, 
      topFunctions: functionData,
      totalLogs: data.length,
      errorRate: data.length > 0 ? ((errorCount / data.length) * 100).toFixed(2) + '%' : '0.00%',
      timeSpan: formatDuration(duration),
      uniqueDaemonCount: Object.keys(daemons).length,
    };
  }, [data]);

  const levelChartRef = useRef<HTMLCanvasElement>(null);
  const daemonChartRef = useRef<HTMLCanvasElement>(null);
  const functionChartRef = useRef<HTMLCanvasElement>(null);
  const chartInstances = useRef<any>({});

  useEffect(() => {
    if (!window.Chart || !levelChartRef.current || !daemonChartRef.current || !functionChartRef.current) {
        return;
    }
    
    const { Chart } = window;
    
    const commonTooltipOptions = {
        backgroundColor: '#1f2937',
        titleColor: '#e5e7eb',
        bodyColor: '#d1d5db',
        borderColor: '#374151',
        borderWidth: 1,
        titleFont: { size: 10 },
        bodyFont: { size: 10 },
        padding: 6
    };
    
    const commonScaleOptions = {
        x: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { color: '#374151' } },
        y: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { display: false } }
    };

    const createOrUpdateChart = (key: string, ref: React.RefObject<HTMLCanvasElement | null>, type: any, data: any, options: any) => {
        if (chartInstances.current[key]) chartInstances.current[key].destroy();
        const ctx = ref.current?.getContext('2d');
        if (ctx) chartInstances.current[key] = new Chart(ctx, { type, data, options });
    };

    createOrUpdateChart('levelChart', levelChartRef, 'doughnut', {
        labels: levelCounts.map(d => d.name),
        datasets: [{
            label: 'Count',
            data: levelCounts.map(d => d.count),
            backgroundColor: levelCounts.map(d => levelColorMap[d.name as LogLevel]),
            borderColor: '#1e293b',
            borderWidth: 2,
        }]
    }, {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'right', labels: { color: '#9ca3af', font: { size: 10 }, boxWidth: 10 } },
            tooltip: commonTooltipOptions,
        }
    });

    createOrUpdateChart('daemonChart', daemonChartRef, 'bar', {
        labels: topDaemons.map(d => d.name),
        datasets: [{ label: 'Count', data: topDaemons.map(d => d.count), backgroundColor: '#10b981' }]
    }, {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        scales: commonScaleOptions,
        plugins: { legend: { display: false }, tooltip: commonTooltipOptions }
    });

    createOrUpdateChart('functionChart', functionChartRef, 'bar', {
        labels: topFunctions.map(d => d.name),
        datasets: [{ label: 'Count', data: topFunctions.map(d => d.count), backgroundColor: '#f97316' }]
    }, {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        scales: commonScaleOptions,
        plugins: { legend: { display: false }, tooltip: commonTooltipOptions }
    });

    return () => {
        Object.values(chartInstances.current).forEach((chart: any) => chart.destroy());
    };
  }, [levelCounts, topDaemons, topFunctions]);

  if (!window.Chart) {
    return <LoadingCharts />;
  }
  
  const NoDataMessage = () => <div className="flex items-center justify-center h-full text-gray-400 text-xs">No data to display for the current filters.</div>;

  return (
    <div className="p-2 space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard title="Total Logs" value={totalLogs.toLocaleString()} />
          <StatCard title="Error Rate" value={errorRate} />
          <StatCard title="Time Span" value={timeSpan} />
          <StatCard title="Unique Daemons" value={uniqueDaemonCount.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <ChartCard title="Logs by Level">
              {levelCounts.length > 0 ? <canvas ref={levelChartRef}></canvas> : <NoDataMessage />}
          </ChartCard>
          
          <ChartCard title="Top 10 Daemons">
              {topDaemons.length > 0 ? <canvas ref={daemonChartRef}></canvas> : <NoDataMessage />}
          </ChartCard>

          <ChartCard title="Top 10 Functions" className="lg:col-span-2">
              {topFunctions.length > 0 ? <canvas ref={functionChartRef}></canvas> : <NoDataMessage />}
          </ChartCard>
      </div>

      {savedFindings.length > 0 && (
          <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 space-y-2">
              <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-200 flex items-center space-x-1.5">
                      <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"></path></svg>
                      <span>Pinned AI Findings ({savedFindings.length})</span>
                  </h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {savedFindings.map((finding, idx) => (
                      <div key={idx} className="relative bg-gray-900/70 p-2.5 rounded border border-gray-700 text-xs text-gray-200 space-y-1">
                          {onRemoveFinding && (
                              <button 
                                  onClick={() => onRemoveFinding(idx)}
                                  className="absolute top-1.5 right-1.5 text-gray-500 hover:text-red-400 p-0.5"
                                  title="Remove pinned finding"
                              >
                                  &times;
                              </button>
                          )}
                          <div className="whitespace-pre-wrap font-sans text-xs line-clamp-6 hover:line-clamp-none pr-4">{finding}</div>
                      </div>
                  ))}
              </div>
          </div>
      )}
    </div>
  );
};
