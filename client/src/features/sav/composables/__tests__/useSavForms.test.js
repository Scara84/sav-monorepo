import { describe, it, expect, beforeEach } from 'vitest';
import { useSavForms } from '../useSavForms.js';

describe('useSavForms', () => {
  let forms;

  beforeEach(() => {
    forms = useSavForms();
  });

  describe('getSavForm', () => {
    it('should create a new form for a given index', () => {
      const form = forms.getSavForm(0);
      expect(form).toBeDefined();
      expect(form.showForm).toBe(false);
      expect(form.filled).toBe(false);
      expect(form.quantity).toBe('');
    });

    it('should return the same form instance for the same index', () => {
      const form1 = forms.getSavForm(0);
      const form2 = forms.getSavForm(0);
      expect(form1).toBe(form2);
    });

    it('should create different forms for different indices', () => {
      const form1 = forms.getSavForm(0);
      const form2 = forms.getSavForm(1);
      expect(form1).not.toBe(form2);
    });
  });

  describe('validateForm', () => {
    it('should validate a complete form', () => {
      const form = forms.getSavForm(0);
      form.quantity = 10;
      form.unit = 'kg';
      form.reason = 'manquant';
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(true);
      expect(form.errors.quantity).toBe('');
    });

    it('should fail validation when quantity is missing', () => {
      const form = forms.getSavForm(0);
      form.unit = 'kg';
      form.reason = 'manquant';
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(false);
      expect(form.errors.quantity).toBe('La quantité est requise');
    });

    it('should fail validation when quantity is zero or negative', () => {
      const form = forms.getSavForm(0);
      form.quantity = 0;
      form.unit = 'kg';
      form.reason = 'manquant';
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(false);
      expect(form.errors.quantity).toBe('La quantité doit être supérieure à 0');
    });

    it('should fail validation when unit is missing', () => {
      const form = forms.getSavForm(0);
      form.quantity = 10;
      form.reason = 'manquant';
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(false);
      expect(form.errors.unit).toBe('Veuillez sélectionner une unité');
    });

    it('should fail validation when reason is missing', () => {
      const form = forms.getSavForm(0);
      form.quantity = 10;
      form.unit = 'kg';
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(false);
      expect(form.errors.reason).toBe('Veuillez sélectionner un motif');
    });

    it('should fail validation when reason is "abime" and no images', () => {
      const form = forms.getSavForm(0);
      form.quantity = 10;
      form.unit = 'kg';
      form.reason = 'abime';
      form.images = [];
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(false);
      expect(form.errors.images).toBe('Veuillez ajouter au moins une photo du produit abimé');
    });

    it('should pass validation when reason is "abime" and images are provided', () => {
      const form = forms.getSavForm(0);
      form.quantity = 10;
      form.unit = 'kg';
      form.reason = 'abime';
      form.images = [{ file: {}, preview: 'data:image/png' }];
      
      const isValid = forms.validateForm(form);
      expect(isValid).toBe(true);
    });
  });

  describe('deleteItemForm', () => {
    it('should reset form to initial state', () => {
      const form = forms.getSavForm(0);
      form.showForm = true;
      form.filled = true;
      form.quantity = 10;
      form.unit = 'kg';
      form.reason = 'manquant';
      form.comment = 'Test comment';
      
      forms.deleteItemForm(0);
      
      expect(form.showForm).toBe(false);
      expect(form.filled).toBe(false);
      expect(form.quantity).toBe('');
      expect(form.unit).toBe('');
      expect(form.reason).toBe('');
      expect(form.comment).toBe('');
      expect(form.images).toEqual([]);
    });
  });

  describe('getFilledForms', () => {
    it('should return empty array when no forms are filled', () => {
      const filled = forms.getFilledForms();
      expect(filled).toEqual([]);
    });

    it('should return filled forms only', () => {
      const form1 = forms.getSavForm(0);
      form1.filled = true;
      form1.showForm = true;
      
      const form2 = forms.getSavForm(1);
      form2.showForm = true;
      form2.filled = false;
      
      const filled = forms.getFilledForms();
      expect(filled.length).toBe(1);
      expect(filled[0].index).toBe(0);
    });
  });

  describe('hasFilledForms', () => {
    it('should return false when no forms are filled', () => {
      expect(forms.hasFilledForms.value).toBe(false);
    });

    it('should return true when at least one form is filled', () => {
      const form = forms.getSavForm(0);
      form.filled = true;
      form.showForm = true;
      
      expect(forms.hasFilledForms.value).toBe(true);
    });
  });

  describe('hasUnfinishedForms', () => {
    it('should return false when no forms are shown', () => {
      expect(forms.hasUnfinishedForms.value).toBe(false);
    });

    it('should return true when a form is shown but not filled', () => {
      const form = forms.getSavForm(0);
      form.showForm = true;
      form.filled = false;
      
      expect(forms.hasUnfinishedForms.value).toBe(true);
    });

    it('should return false when shown forms are all filled', () => {
      const form = forms.getSavForm(0);
      form.showForm = true;
      form.filled = true;
      
      expect(forms.hasUnfinishedForms.value).toBe(false);
    });
  });
});
