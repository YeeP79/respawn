import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from './logger.js';

describe('logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    logger.setVerbose(false);
  });

  it('should log info messages', () => {
    logger.info('test message');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('should log warn messages', () => {
    logger.warn('warning message');
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('should log error messages', () => {
    logger.error('error message');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('should not log debug by default', () => {
    logger.debug('debug message');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('should log debug when verbose is enabled', () => {
    logger.setVerbose(true);
    logger.debug('debug message');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('should filter debug when verbose is disabled', () => {
    logger.setVerbose(true);
    logger.setVerbose(false);
    logger.debug('debug message');
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
