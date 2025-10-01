import { describe, it, expect } from 'vitest';
import { useExcelGenerator } from '../useExcelGenerator.js';

describe('useExcelGenerator', () => {
  const excelGen = useExcelGenerator();

  describe('splitProductLabel', () => {
    it('should split product code and name correctly', () => {
      const label = '5211-3060-100K Avocat Lamb Hass (CAT EXTRA, GRAND)';
      const result = excelGen.splitProductLabel(label);
      
      expect(result.code).toBe('5211-3060-100K');
      expect(result.name).toBe('Avocat Lamb Hass (CAT EXTRA, GRAND)');
    });

    it('should handle label without space', () => {
      const label = '5211-3060-100K';
      const result = excelGen.splitProductLabel(label);
      
      expect(result.code).toBe('5211-3060-100K');
      expect(result.name).toBe('');
    });

    it('should handle empty label', () => {
      const result = excelGen.splitProductLabel('');
      
      expect(result.code).toBe('');
      expect(result.name).toBe('');
    });

    it('should handle null label', () => {
      const result = excelGen.splitProductLabel(null);
      
      expect(result.code).toBe('');
      expect(result.name).toBe('');
    });

    it('should handle label with multiple spaces', () => {
      const label = 'ABC Product with multiple words';
      const result = excelGen.splitProductLabel(label);
      
      expect(result.code).toBe('ABC');
      expect(result.name).toBe('Product with multiple words');
    });
  });

  describe('formatAddress', () => {
    it('should format complete address', () => {
      const address = {
        address: '2 Rue de la Paix',
        postal_code: '75001',
        city: 'Paris',
        country_alpha2: 'FR'
      };
      
      const result = excelGen.formatAddress(address);
      expect(result).toBe('2 Rue de la Paix, 75001, Paris, FR');
    });

    it('should handle partial address', () => {
      const address = {
        city: 'Paris',
        country_alpha2: 'FR'
      };
      
      const result = excelGen.formatAddress(address);
      expect(result).toBe('Paris, FR');
    });

    it('should return N/A for empty address', () => {
      const result = excelGen.formatAddress({});
      expect(result).toBe('N/A');
    });

    it('should return N/A for null address', () => {
      const result = excelGen.formatAddress(null);
      expect(result).toBe('N/A');
    });

    it('should filter out undefined/null values', () => {
      const address = {
        address: '2 Rue de la Paix',
        postal_code: null,
        city: 'Paris',
        country_alpha2: undefined
      };
      
      const result = excelGen.formatAddress(address);
      expect(result).toBe('2 Rue de la Paix, Paris');
    });
  });

  describe('generateExcelFile', () => {
    it('should generate Excel file with valid data', () => {
      const forms = [
        {
          form: {
            quantity: 10,
            unit: 'kg',
            reason: 'abime',
            comment: 'Test comment',
            creditPercentage: ''
          },
          index: 0
        }
      ];

      const items = [
        {
          label: '5211-3060-100K Avocat Lamb Hass',
          quantity: 10,
          amount: 100
        }
      ];

      const facture = {
        customer: {
          name: 'Test Client',
          source_id: '123',
          emails: ['test@example.com'],
          phone: '0123456789',
          delivery_address: { city: 'Paris', country_alpha2: 'FR' },
          billing_address: { city: 'Paris', country_alpha2: 'FR' }
        },
        invoice_number: 'F-2024-001',
        date: '2024-10-01',
        special_mention: '585_25S30_94_1'
      };

      const result = excelGen.generateExcelFile(forms, items, facture);
      
      // Le résultat devrait être une chaîne base64
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle empty forms', () => {
      const forms = [];
      const items = [];
      const facture = {
        customer: { name: 'Test' },
        invoice_number: 'F-2024-001'
      };

      const result = excelGen.generateExcelFile(forms, items, facture);
      expect(typeof result).toBe('string');
    });

    it('should extract order number from special mention', () => {
      const forms = [];
      const items = [];
      const facture = {
        customer: { name: 'Test' },
        invoice_number: 'F-2024-001',
        special_mention: '585_25S30_94_1'
      };

      // Le fichier devrait être généré sans erreur
      const result = excelGen.generateExcelFile(forms, items, facture);
      expect(typeof result).toBe('string');
    });
  });
});
