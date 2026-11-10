export const LOG_LEVEL = Object.freeze({ DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' });

let enabled = true;
let sinkFaults = 0;
const sinks = new Set();

function defaultSink(entry) {
  if (entry.level === LOG_LEVEL.DEBUG || entry.level === LOG_LEVEL.INFO) return;
  const write = entry.level === LOG_LEVEL.ERROR ? console.error : console.warn;
  write(`[${entry.level}] ${entry.message}`, entry.meta === null ? '' : entry.meta);
}

sinks.add(defaultSink);

export function addLogSink(sink) {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function getLogSinkFaults() {
  return sinkFaults;
}

export function disableLogging() {
  enabled = false;
}

export function enableLogging() {
  enabled = true;
}

export function log(level, message, meta = null) {
  if (!enabled) return;
  const entry = { level, message: String(message), meta, at: new Date().toISOString() };
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch (sinkError) {
      // A failing sink is counted (never swallowed silently) and must not break the flow.
      sinkFaults += 1;
      if (sinkFaults === 1) {
        try {
          console.error('log sink failure #1', sinkError);
        } catch (writeError) {
          sinkFaults += 1;
        }
      }
    }
  }
}

export const logger = {
  debug: (message, meta) => log(LOG_LEVEL.DEBUG, message, meta),
  info: (message, meta) => log(LOG_LEVEL.INFO, message, meta),
  warn: (message, meta) => log(LOG_LEVEL.WARN, message, meta),
  error: (message, meta) => log(LOG_LEVEL.ERROR, message, meta)
};
