import { describe, it, expect } from 'vitest';
import { sanitizeFolderName } from '../validator.js';

describe('Validator Middleware', () => {
  describe('sanitizeFolderName', () => {
    it('should sanitize folder name with valid characters', () => {
      const input = 'SAV_123-ABC_2024';
      const result = sanitizeFolderName(input);
      expect(result).toBe('SAV_123-ABC_2024');
    });

    it('should replace invalid characters with underscores', () => {
      const input = 'SAV/../../../etc/passwd';
      const result = sanitizeFolderName(input);
      expect(result).toBe('SAV__________etc_passwd');
    });

    it('should handle special characters', () => {
      const input = 'SAV@#$%^&*()test';
      const result = sanitizeFolderName(input);
      expect(result).toBe('SAV_________test');
    });

    it('should limit length to 100 characters', () => {
      const input = 'A'.repeat(150);
      const result = sanitizeFolderName(input);
      expect(result.length).toBe(100);
    });

    it('should return null for empty string', () => {
      const result = sanitizeFolderName('');
      expect(result).toBeNull();
    });

    it('should return null for null input', () => {
      const result = sanitizeFolderName(null);
      expect(result).toBeNull();
    });

    it('should return null for undefined input', () => {
      const result = sanitizeFolderName(undefined);
      expect(result).toBeNull();
    });

    it('should return null for non-string input', () => {
      const result = sanitizeFolderName(123);
      expect(result).toBeNull();
    });

    it('should sanitize strings with only dots', () => {
      const result = sanitizeFolderName('...');
      // Les points sont remplacés par des underscores
      expect(result).toBe('___');
    });

    it('should handle path traversal attempts', () => {
      const input = '../../../sensitive';
      const result = sanitizeFolderName(input);
      expect(result).toBe('_________sensitive');
      expect(result).not.toContain('..');
      expect(result).not.toContain('/');
    });

    it('should handle spaces', () => {
      const input = 'SAV Test 123';
      const result = sanitizeFolderName(input);
      expect(result).toBe('SAV_Test_123');
    });

    it('should handle accented characters', () => {
      const input = 'SAV_été_2024';
      const result = sanitizeFolderName(input);
      expect(result).toBe('SAV__t__2024');
    });

    it('should preserve valid alphanumeric with underscores and dashes', () => {
      const input = 'SAV_585_25S30_94_1_2024-10-01';
      const result = sanitizeFolderName(input);
      expect(result).toBe('SAV_585_25S30_94_1_2024-10-01');
    });
  });
});
