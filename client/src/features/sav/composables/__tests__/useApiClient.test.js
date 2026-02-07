import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useApiClient } from '../useApiClient.js';
import axios from 'axios';

// Mock axios
vi.mock('axios');

describe('useApiClient', () => {
  let apiClient;

  beforeEach(() => {
    apiClient = useApiClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (vi.unstubAllEnvs) {
      vi.unstubAllEnvs();
    }
  });

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const mockFn = vi.fn().mockResolvedValue('success');
      
      const result = await apiClient.withRetry(mockFn, 3, 100);
      
      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success');
      
      const result = await apiClient.withRetry(mockFn, 3, 100);
      
      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 4xx errors', async () => {
      const error = new Error('Bad Request');
      error.response = { status: 400 };
      const mockFn = vi.fn().mockRejectedValue(error);
      
      await expect(apiClient.withRetry(mockFn, 3, 100)).rejects.toThrow('Bad Request');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should throw error after max retries', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('Network error'));
      
      await expect(apiClient.withRetry(mockFn, 3, 100)).rejects.toThrow('Network error');
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should use exponential backoff', async () => {
      vi.useFakeTimers();
      
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce('success');

      const promise = apiClient.withRetry(mockFn, 3, 1000);
      
      // Premier appel immédiat
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFn).toHaveBeenCalledTimes(1);
      
      // Premier retry après 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFn).toHaveBeenCalledTimes(2);
      
      // Deuxième retry après 2000ms (backoff exponentiel)
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFn).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result).toBe('success');
      
      vi.useRealTimers();
    });
  });

  describe('uploadToBackend', () => {
    it('should upload file successfully', async () => {
      const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
      const mockResponse = {
        data: {
          success: true,
          file: { url: 'https://example.com/file.jpg' }
        }
      };
      
      axios.post.mockResolvedValue(mockResponse);
      
      const result = await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123');
      
      expect(result).toBe('https://example.com/file.jpg');
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('should upload with proper headers structure', async () => {
      const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
      const mockResponse = {
        data: {
          success: true,
          file: { url: 'https://example.com/file.jpg' }
        }
      };
      
      axios.post.mockResolvedValue(mockResponse);
      
      await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123');
      
      const callArgs = axios.post.mock.calls[0];
      // Vérifier que la structure des headers est correcte
      expect(callArgs[2]).toHaveProperty('headers');
      expect(callArgs[2].headers).toHaveProperty('Content-Type');
    });

    it('should handle base64 file upload', async () => {
      const mockFile = {
        content: btoa('test content'),
        filename: 'test.xlsx'
      };
      
      const mockResponse = {
        data: {
          success: true,
          file: { url: 'https://example.com/file.xlsx' }
        }
      };
      
      axios.post.mockResolvedValue(mockResponse);
      
      const result = await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123', {
        isBase64: true
      });
      
      expect(result).toBe('https://example.com/file.xlsx');
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('should call progress callback when provided', async () => {
      const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
      const mockResponse = {
        data: {
          success: true,
          file: { url: 'https://example.com/file.jpg' }
        }
      };
      const onProgress = vi.fn();

      axios.post.mockResolvedValue(mockResponse);

      await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123', { onProgress });

      const callArgs = axios.post.mock.calls[0];
      const config = callArgs[2];
      config.onUploadProgress({ loaded: 5, total: 10 });

      expect(onProgress).toHaveBeenCalledWith(50);
    });
  });

  describe('uploadFilesParallel', () => {
    it('should upload multiple files in parallel', async () => {
      const files = [
        { file: new File(['1'], 'test1.jpg'), isBase64: false },
        { file: new File(['2'], 'test2.jpg'), isBase64: false }
      ];
      
      const mockResponse = {
        data: {
          success: true,
          file: { url: 'https://example.com/file.jpg' }
        }
      };
      
      axios.post.mockResolvedValue(mockResponse);
      
      const results = await apiClient.uploadFilesParallel(files, 'SAV_TEST_123');
      
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures', async () => {
      const files = [
        { file: new File(['1'], 'test1.jpg'), isBase64: false },
        { file: new File(['2'], 'test2.jpg'), isBase64: false }
      ];
      
      axios.post
        .mockResolvedValueOnce({
          data: { success: true, file: { url: 'https://example.com/file1.jpg' } }
        })
        .mockRejectedValueOnce(new Error('Upload failed'));
      
      const results = await apiClient.uploadFilesParallel(files, 'SAV_TEST_123');
      
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });
  });

  describe('getFolderShareLink', () => {
    it('should get folder share link successfully', async () => {
      const mockResponse = {
        data: {
          success: true,
          shareLink: 'https://example.com/share/folder'
        }
      };
      
      axios.post.mockResolvedValue(mockResponse);
      
      const result = await apiClient.getFolderShareLink('SAV_TEST_123');
      
      expect(result).toBe('https://example.com/share/folder');
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('should throw error when API returns failure', async () => {
      const mockResponse = {
        data: {
          success: false,
          error: 'Folder not found'
        }
      };
      
      axios.post.mockResolvedValue(mockResponse);
      
      await expect(apiClient.getFolderShareLink('SAV_TEST_123')).rejects.toThrow();
    });
  });

  describe('submitSavWebhook', () => {
    it('should submit webhook payload', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL_DATA_SAV', 'https://example.com/webhook');
      const payload = { foo: 'bar' };
      axios.post.mockResolvedValue({ data: { ok: true } });

      const result = await apiClient.submitSavWebhook(payload);

      expect(axios.post).toHaveBeenCalledWith('https://example.com/webhook', payload);
      expect(result).toEqual({ ok: true });
    });

    it('should throw when webhook env is missing', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL_DATA_SAV', '');

      await expect(apiClient.submitSavWebhook({})).rejects.toThrow(
        'VITE_WEBHOOK_URL_DATA_SAV is not configured'
      );
    });
  });

  describe('submitInvoiceLookupWebhook', () => {
    it('should submit invoice lookup payload', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL', 'https://example.com/invoice-webhook');
      const payload = { transformedReference: '123', email: 'test@example.com' };
      axios.post.mockResolvedValue({ data: { invoice_number: 'F-2024-001' } });

      const result = await apiClient.submitInvoiceLookupWebhook(payload);

      expect(axios.post).toHaveBeenCalledWith('https://example.com/invoice-webhook', payload);
      expect(result).toEqual({ invoice_number: 'F-2024-001' });
    });

    it('should throw when invoice webhook env is missing', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL', '');

      await expect(
        apiClient.submitInvoiceLookupWebhook({ transformedReference: '123', email: 'a@b.c' })
      ).rejects.toThrow('VITE_WEBHOOK_URL is not configured');
    });
  });
});
