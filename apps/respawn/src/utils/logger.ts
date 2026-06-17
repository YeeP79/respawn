import chalk from 'chalk';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: chalk.gray('[DEBUG]'),
  info: chalk.blue('[INFO]'),
  warn: chalk.yellow('[WARN]'),
  error: chalk.red('[ERROR]'),
};

let currentLevel: LogLevel = 'info';

export function setVerbose(verbose: boolean): void {
  currentLevel = verbose ? 'debug' : 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function timestamp(): string {
  return chalk.gray(new Date().toISOString());
}

export function debug(...args: unknown[]): void {
  if (shouldLog('debug')) {
    console.log(timestamp(), LEVEL_PREFIX.debug, ...args);
  }
}

export function info(...args: unknown[]): void {
  if (shouldLog('info')) {
    console.log(timestamp(), LEVEL_PREFIX.info, ...args);
  }
}

export function warn(...args: unknown[]): void {
  if (shouldLog('warn')) {
    console.warn(timestamp(), LEVEL_PREFIX.warn, ...args);
  }
}

export function error(...args: unknown[]): void {
  if (shouldLog('error')) {
    console.error(timestamp(), LEVEL_PREFIX.error, ...args);
  }
}

export const logger = { debug, info, warn, error, setVerbose };
